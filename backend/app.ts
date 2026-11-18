import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import {
  buildOtpAuthUri,
  generateOpaqueToken,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPasswordArgon2id,
  maskIpAddress,
  sanitizeLogPayload,
  sha256Hex,
  SlidingWindowRateLimiter,
  validateEncryptedAttachmentMeta,
  validatePasswordStrength,
  validateUsername,
  verifyPasswordArgon2id,
  verifyTotpToken,
} from './security.ts';
import {
  ALL_26_FEATURE_IDS,
  CallLogEntry,
  ChatRoom,
  createDefaultFeatureSelection,
  DEFAULT_IDENTITY_3D,
  DEFAULT_STICKER_PACK,
  DeviceRecord,
  EncryptedMessage,
  LoginAlert,
  OAuthProviderId,
  RRChatStore,
  Sticker3DItem,
  UserAccount,
  WrappedRoomKey,
} from './store.ts';
import {
  deriveUniqueOAuthUsername,
  exchangeThirdPartyCodeForIdentity,
  getThirdPartyProviderMeta,
  type ThirdPartyOAuthProvider,
  type VerifiedOAuthIdentity,
  verifyFirebaseGoogleIdToken,
} from './oauth.ts';
import { AIAssistMode, runAIAssistant, transcribeAudioWithGemini } from './ai.ts';

export interface ServerOptions {
  storePath?: string | null;
  argon2Options?: { m?: number; t?: number; p?: number };
  loginMaxAttempts?: number;
  loginLockoutMs?: number;
  apiMaxRequestsPerMin?: number;
  repoRoot?: string;
}

interface AuthedRequest extends Request {
  auth?: {
    user: UserAccount;
    device: DeviceRecord;
    tokenHash: string;
  };
}

interface AuthedSocket extends WebSocket {
  userId?: string;
  deviceId?: string;
  tokenHash?: string;
  isAlive?: boolean;
}

const ALLOWED_REPO_ROOTS = ['flutter_app', 'infra', 'docs', 'tests', 'backend'];

function collectFiles(rootDir: string, relBase: string): Array<{ path: string; size: number }> {
  const results: Array<{ path: string; size: number }> = [];
  if (!fs.existsSync(rootDir)) return results;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(rootDir, entry.name);
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, rel));
    } else if (entry.isFile()) {
      const stat = fs.statSync(full);
      results.push({ path: rel, size: stat.size });
    }
  }
  return results;
}

export function createRRChatBackend(options: ServerOptions = {}) {
  const store = new RRChatStore(options.storePath === undefined ? path.resolve('data/rrchat_state.json') : options.storePath);
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const repoRoot = options.repoRoot ?? process.cwd();

  const loginLimiter = new SlidingWindowRateLimiter(
    options.loginMaxAttempts ?? 5,
    15 * 60 * 1000,
    options.loginLockoutMs ?? 15 * 60 * 1000
  );
  const apiLimiter = new SlidingWindowRateLimiter(options.apiMaxRequestsPerMin ?? 180, 60 * 1000, 0);

  // Track active sockets per userId
  const userSockets = new Map<string, Set<AuthedSocket>>();

  function registerSocket(ws: AuthedSocket, userId: string, deviceId: string, tokenHash: string) {
    ws.userId = userId;
    ws.deviceId = deviceId;
    ws.tokenHash = tokenHash;
    let set = userSockets.get(userId);
    if (!set) {
      set = new Set();
      userSockets.set(userId, set);
    }
    set.add(ws);
  }

  function unregisterSocket(ws: AuthedSocket) {
    if (!ws.userId) return;
    const set = userSockets.get(ws.userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) userSockets.delete(ws.userId);
    }
  }

  function sendToUser(userId: string, event: string, payload: unknown) {
    const set = userSockets.get(userId);
    if (!set) return;
    const frame = JSON.stringify({ event, payload });
    for (const sock of set) {
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(frame);
      }
    }
  }

  function sendToRoom(room: ChatRoom, event: string, payload: unknown) {
    for (const memberId of room.memberIds) {
      sendToUser(memberId, event, payload);
    }
  }

  function disconnectDeviceSockets(userId: string, deviceId: string, reason: string) {
    const set = userSockets.get(userId);
    if (!set) return;
    for (const sock of set) {
      if (sock.deviceId === deviceId && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ event: 'device:revoked', payload: { deviceId, reason } }));
        sock.close(4001, 'Device revoked');
      }
    }
  }

  // Upgrade HTTP -> WebSocket on /ws
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: AuthedSocket) => {
      const token = url.searchParams.get('token');
      if (token) {
        const auth = authenticateToken(token);
        if (!auth) {
          ws.close(4003, 'Unauthorized');
          return;
        }
        registerSocket(ws, auth.user.id, auth.device.deviceId, auth.tokenHash);
        ws.send(JSON.stringify({ event: 'session:connected', payload: { userId: auth.user.id, deviceId: auth.device.deviceId } }));
      }
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: AuthedSocket) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as {
          type?: string;
          token?: string;
          roomId?: string;
          targetUserId?: string;
          callMode?: 'audio' | 'video';
          sdp?: unknown;
          candidate?: unknown;
          reason?: string;
        };
        if (msg.type === 'auth' && msg.token && !ws.userId) {
          const auth = authenticateToken(msg.token);
          if (!auth) {
            ws.close(4003, 'Unauthorized');
            return;
          }
          registerSocket(ws, auth.user.id, auth.device.deviceId, auth.tokenHash);
          ws.send(JSON.stringify({ event: 'session:connected', payload: { userId: auth.user.id, deviceId: auth.device.deviceId } }));
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ event: 'pong', payload: { ts: Date.now() } }));
        } else if (
          ws.userId &&
          msg.roomId &&
          ['call:offer', 'call:answer', 'call:ice', 'call:end', 'call:reject'].includes(String(msg.type))
        ) {
          const room = store.state.rooms[msg.roomId];
          if (!room || !room.memberIds.includes(ws.userId)) return;
          const caller = store.state.users[ws.userId];
          if (!caller) return;
          const recipients = msg.targetUserId
            ? room.memberIds.filter((id) => id === msg.targetUserId && id !== ws.userId)
            : room.memberIds.filter((id) => id !== ws.userId);
          for (const recipientId of recipients) {
            if (!store.isBlocked(ws.userId, recipientId)) {
              sendToUser(recipientId, msg.type!, {
                roomId: room.id,
                fromUserId: ws.userId,
                fromDisplayName: caller.displayName,
                fromUsername: caller.username,
                callMode: msg.callMode ?? 'audio',
                sdp: msg.sdp,
                candidate: msg.candidate,
                reason: msg.reason,
              });
            }
          }
        }
      } catch {
        // Ignore malformed frames
      }
    });
    ws.on('close', () => unregisterSocket(ws));
  });

  function broadcastSocialUpdate(kind: string) {
    for (const set of userSockets.values()) {
      for (const sock of set) {
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ event: 'social:updated', payload: { kind, ts: Date.now() } }));
        }
      }
    }
  }

  const expiryInterval = setInterval(() => {
    const now = Date.now();
    const expired = store.purgeExpiredMessages(now);
    for (const item of expired) {
      const room = store.state.rooms[item.roomId];
      if (room) {
        sendToRoom(room, 'message:expired', item);
      }
    }

    // Deliver scheduled E2EE messages whose deliverAt timestamp has arrived
    if (store.state.scheduledMessages.length > 0) {
      const due: typeof store.state.scheduledMessages = [];
      const pending: typeof store.state.scheduledMessages = [];
      for (const s of store.state.scheduledMessages) {
        if (s.deliverAt <= now) due.push(s);
        else pending.push(s);
      }
      if (due.length > 0) {
        store.state.scheduledMessages = pending;
        for (const sched of due) {
          const room = store.state.rooms[sched.roomId];
          if (!room || !room.memberIds.includes(sched.senderId)) continue;
          const msg: EncryptedMessage = {
            id: crypto.randomUUID(),
            roomId: room.id,
            senderId: sched.senderId,
            senderDeviceId: sched.senderDeviceId,
            kind: sched.kind === 'sticker' ? 'sticker' : 'text',
            ciphertextB64: sched.ciphertextB64,
            ivB64: sched.ivB64,
            reactions: {},
            deliveredTo: room.memberIds.filter((id) => userSockets.has(id) || id === sched.senderId),
            readBy: [sched.senderId],
            createdAt: now,
            expiresAt: room.disappearingTtlSeconds ? now + room.disappearingTtlSeconds * 1000 : null,
          };
          if (!store.state.messages[room.id]) store.state.messages[room.id] = [];
          store.state.messages[room.id].push(msg);
          sendToRoom(room, 'message:new', msg);
          sendToRoom(room, 'scheduled:delivered', { roomId: room.id, scheduleId: sched.id, message: msg });
        }
        store.schedulePersist();
      }
    }
  }, 2000);
  expiryInterval.unref();

  function authenticateToken(rawToken: string) {
    const tokenHash = sha256Hex(rawToken);
    const session = store.state.sessions[tokenHash];
    if (!session || session.revoked || session.expiresAt <= Date.now()) {
      return null;
    }
    const user = store.state.users[session.userId];
    const device = store.state.devices[session.deviceId];
    if (!user || user.suspended || !device || device.revokedAt !== null) {
      return null;
    }
    device.lastSeenAt = Date.now();
    return { user, device, tokenHash };
  }

  function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const token = header.slice(7).trim();
    const auth = authenticateToken(token);
    if (!auth) {
      res.status(401).json({ error: 'Session is invalid, expired, or revoked.' });
      return;
    }
    req.auth = auth;
    next();
  }

  function rateLimitApi(req: Request, res: Response, next: NextFunction) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const check = apiLimiter.consume(ip);
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfterSeconds));
      res.status(429).json({ error: 'Too many requests. Please slow down.', retryAfterSeconds: check.retryAfterSeconds });
      return;
    }
    next();
  }

  // Hardened HTTP security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(self), microphone=(self), interest-cohort=()');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', rateLimitApi);
  app.use('/api/rooms/:roomId/messages', express.json({ limit: '24mb' }));
  app.use('/api/vault/items', express.json({ limit: '24mb' }));
  app.use('/api', express.json({ limit: '1mb' }));

  function serializeUser(u: UserAccount) {
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      bio: u.bio,
      authProvider: u.authProvider ?? 'local',
      linkedProviders: u.linkedProviders ?? [],
      contactNumberMasked: u.contactNumberMasked,
      gamingConnection: u.gamingConnection,
      walletBalanceCents: u.walletBalanceCents,
      identity3D: u.identity3D ?? DEFAULT_IDENTITY_3D,
      hasVaultPin: Boolean(u.vaultPinHash),
      hasDuressPin: Boolean(u.duressPinHash),
      duressBehavior: u.duressBehavior ?? 'decoy_screen',
      screenshotPrivacy: u.screenshotPrivacy ?? true,
      phishingProtection: u.phishingProtection ?? true,
      nearbyDiscoveryEnabled: Boolean(u.nearbyDiscoveryEnabled),
      nearbyZoneLabel: u.nearbyZoneLabel ?? '',
      featureSelection: u.featureSelection ?? createDefaultFeatureSelection(),
      stickerPack: u.stickerPack?.length ? u.stickerPack : DEFAULT_STICKER_PACK,
      totpEnabled: u.totpEnabled,
      suspended: u.suspended,
      remainingRecoveryCodes: u.recoveryCodeHashes.length,
      privacySettings: u.privacySettings,
      notificationSettings: {
        ...u.notificationSettings,
        customSound: u.notificationSettings?.customSound ?? 'crystal',
      },
      createdAt: u.createdAt,
    };
  }

  function publicUserSummary(u: UserAccount) {
    const devices = Object.values(store.state.devices).filter((d) => d.userId === u.id && d.revokedAt === null);
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      bio: u.bio,
      identity3D: u.identity3D ?? DEFAULT_IDENTITY_3D,
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        platform: d.platform,
        identityPubKeyJwk: d.identityPubKeyJwk,
        ecdhPubKeyJwk: d.ecdhPubKeyJwk,
        fingerprint: d.fingerprint,
        verifiedByUser: d.verifiedByUser,
      })),
    };
  }

  function recordLoginAlert(
    userId: string,
    eventType: LoginAlert['eventType'],
    deviceName: string,
    platform: string,
    ip: string | undefined
  ) {
    const alert: LoginAlert = {
      id: crypto.randomUUID(),
      userId,
      eventType,
      deviceName,
      platform,
      ipMasked: maskIpAddress(ip),
      timestamp: Date.now(),
      acknowledged: false,
    };
    store.state.loginAlerts.unshift(alert);
    if (store.state.loginAlerts.length > 500) {
      store.state.loginAlerts.length = 500;
    }
    sendToUser(userId, 'login:alert', alert);
  }

  // Health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'RRchat 1 Private Server',
      e2eeModel: 'WebCrypto ECDH-P256 + HKDF-SHA256 + AES-256-GCM (Matrix Olm/Megolm target in Flutter)',
      plaintextStorage: false,
    });
  });

  // Safe Read-Only Repository Browser for Architecture / Flutter / Infra / Tests
  app.get('/api/repo/tree', (_req, res) => {
    const files: Array<{ path: string; size: number; group: string }> = [];
    for (const root of ALLOWED_REPO_ROOTS) {
      const full = path.resolve(repoRoot, root);
      for (const f of collectFiles(full, root)) {
        files.push({ ...f, group: root });
      }
    }
    res.json({ files });
  });

  app.get('/api/repo/file', (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      res.status(400).json({ error: 'Invalid repository path.' });
      return;
    }
    const topDir = rel.split('/')[0];
    if (!ALLOWED_REPO_ROOTS.includes(topDir)) {
      res.status(403).json({ error: 'Access denied outside documented codebase roots.' });
      return;
    }
    const resolved = path.resolve(repoRoot, rel);
    const allowedBase = path.resolve(repoRoot, topDir);
    if (!resolved.startsWith(allowedBase + path.sep)) {
      res.status(403).json({ error: 'Path traversal blocked.' });
      return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      res.status(404).json({ error: 'File not found.' });
      return;
    }
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ path: rel, content });
  });

  // 1. Account Registration
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { username, password, displayName, deviceName, platform, identityPubKeyJwk, ecdhPubKeyJwk, fingerprint } =
        req.body ?? {};
      const uCheck = validateUsername(username);
      if (!uCheck.valid) {
        res.status(400).json({ error: uCheck.error });
        return;
      }
      if (store.state.usernameIndex[uCheck.normalized]) {
        res.status(409).json({ error: 'Username is already taken.' });
        return;
      }
      const pCheck = validatePasswordStrength(password, uCheck.normalized);
      if (!pCheck.valid) {
        res.status(400).json({ error: pCheck.error });
        return;
      }
      if (!identityPubKeyJwk || !ecdhPubKeyJwk || !fingerprint) {
        res.status(400).json({ error: 'Client device E2EE public keys and fingerprint are required.' });
        return;
      }

      const passwordHash = await hashPasswordArgon2id(password, options.argon2Options);
      const recoveryCodes = generateRecoveryCodes(8);
      const recoveryCodeHashes = recoveryCodes.map((c) => sha256Hex(c.replace(/-/g, '')));
      const userId = crypto.randomUUID();

      const rawPhone = typeof req.body?.contactNumber === 'string' ? req.body.contactNumber.trim() : '';
      const cleanPhone = rawPhone.replace(/[\s\-().]/g, '');
      const contactNumberHash = cleanPhone.length >= 7 ? sha256Hex(`rrchat1-phone:${cleanPhone}`) : null;
      const contactNumberMasked =
        cleanPhone.length >= 7
          ? `${cleanPhone.slice(0, 2)}${'*'.repeat(Math.max(2, cleanPhone.length - 4))}${cleanPhone.slice(-2)}`
          : null;

      const user: UserAccount = {
        id: userId,
        username: uCheck.normalized,
        displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 48) : `@${uCheck.normalized}`,
        bio: '',
        contactNumberHash,
        contactNumberMasked,
        gamingConnection: {
          platform: 'PC / Steam',
          gamertag: '',
          discordUsername: '',
          discordInviteCode: '',
          discordConnectedViaOAuth: false,
          visibility: 'private',
        },
        walletBalanceCents: 0,
        identity3D: { ...DEFAULT_IDENTITY_3D },
        vaultPinHash: null,
        duressPinHash: null,
        duressBehavior: 'decoy_screen',
        screenshotPrivacy: true,
        phishingProtection: true,
        nearbyDiscoveryEnabled: false,
        nearbyZoneLabel: '',
        featureSelection: createDefaultFeatureSelection(),
        stickerPack: DEFAULT_STICKER_PACK.map((s) => ({ ...s })),
        passwordHash,
        totpEnabled: false,
        totpSecret: null,
        recoveryCodeHashes,
        suspended: false,
        suspensionReason: null,
        privacySettings: {
          discoverableByUsername: true,
          sendReadReceipts: false,
          hideNotificationPreviews: true,
          allowGroupInvites: true,
          contactNumberVisibility: 'private',
          allowLookupByContactNumber: false,
          hideOnlinePresence: true,
        },
        notificationSettings: {
          enabled: true,
          soundEnabled: false,
          loginAlertsEnabled: true,
          previewMode: 'none',
          customSound: 'crystal',
        },
        createdAt: Date.now(),
      };

      const deviceId = crypto.randomUUID();
      const device: DeviceRecord = {
        deviceId,
        userId,
        deviceName: typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim().slice(0, 48) : 'Primary Browser Device',
        platform: ['Web', 'Android', 'iOS', 'Windows'].includes(platform) ? platform : 'Web',
        identityPubKeyJwk,
        ecdhPubKeyJwk,
        fingerprint: String(fingerprint).slice(0, 128),
        verifiedByUser: true,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        revokedAt: null,
      };

      const rawToken = generateOpaqueToken(32);
      const tokenHash = sha256Hex(rawToken);
      store.state.sessions[tokenHash] = {
        tokenHash,
        userId,
        deviceId,
        ipMasked: maskIpAddress(req.ip),
        userAgent: String(req.headers['user-agent'] ?? 'Unknown').slice(0, 120),
        createdAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        revoked: false,
      };

      store.state.users[userId] = user;
      store.state.usernameIndex[uCheck.normalized] = userId;
      store.state.devices[deviceId] = device;
      recordLoginAlert(userId, 'login_success', device.deviceName, device.platform, req.ip);
      store.schedulePersist();

      console.info('[auth:register]', JSON.stringify(sanitizeLogPayload({ userId, username: uCheck.normalized, deviceId })));

      res.status(201).json({
        token: rawToken,
        deviceId,
        recoveryCodes,
        user: serializeUser(user),
      });
    } catch (err) {
      res.status(500).json({ error: 'Registration failed.' });
    }
  });

  // 2. Login with Argon2id + Brute-force Lockout + TOTP 2FA
  app.post('/api/auth/login', async (req, res) => {
    const { username, password, totpCode, deviceName, platform, identityPubKeyJwk, ecdhPubKeyJwk, fingerprint, existingDeviceId } =
      req.body ?? {};
    const uCheck = validateUsername(String(username ?? ''));
    const rateKey = `${req.ip}:${uCheck.normalized || 'invalid'}`;
    const lock = loginLimiter.isLocked(rateKey);
    if (lock.locked) {
      res.setHeader('Retry-After', String(lock.retryAfterSeconds));
      res.status(429).json({
        error: `Too many failed login attempts. Try again in ${lock.retryAfterSeconds}s.`,
        retryAfterSeconds: lock.retryAfterSeconds,
      });
      return;
    }

    const userId = store.state.usernameIndex[uCheck.normalized];
    const user = userId ? store.state.users[userId] : undefined;
    if (!user || typeof password !== 'string' || user.passwordHash.startsWith('!oauth!')) {
      const attempt = loginLimiter.consume(rateKey);
      if (!attempt.allowed) {
        res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
        res.status(429).json({ error: 'Account temporarily locked due to brute-force protection.', retryAfterSeconds: attempt.retryAfterSeconds });
        return;
      }
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    if (user.suspended) {
      res.status(403).json({
        error: 'Account is suspended. Use your recovery codes to restore access or contact your server administrator.',
        suspended: true,
      });
      return;
    }

    const validPassword = await verifyPasswordArgon2id(password, user.passwordHash);
    if (!validPassword) {
      const attempt = loginLimiter.consume(rateKey);
      if (!attempt.allowed) {
        recordLoginAlert(user.id, 'login_blocked_bruteforce', String(deviceName ?? 'Unknown'), String(platform ?? 'Web'), req.ip);
        store.schedulePersist();
        res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
        res.status(429).json({
          error: 'Too many failed login attempts. Brute-force lockout active.',
          retryAfterSeconds: attempt.retryAfterSeconds,
        });
        return;
      }
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    if (user.totpEnabled && user.totpSecret) {
      if (!totpCode) {
        res.status(200).json({ requires2FA: true });
        return;
      }
      if (!verifyTotpToken(user.totpSecret, String(totpCode))) {
        const attempt = loginLimiter.consume(rateKey);
        if (!attempt.allowed) {
          recordLoginAlert(user.id, 'login_blocked_bruteforce', String(deviceName ?? 'Unknown'), String(platform ?? 'Web'), req.ip);
          store.schedulePersist();
          res.status(429).json({ error: 'Too many failed 2FA attempts. Lockout active.' });
          return;
        }
        res.status(401).json({ error: 'Invalid 2FA verification code.' });
        return;
      }
    }

    loginLimiter.reset(rateKey);

    let device: DeviceRecord | undefined;
    if (existingDeviceId && store.state.devices[existingDeviceId]?.userId === user.id && !store.state.devices[existingDeviceId]?.revokedAt) {
      device = store.state.devices[existingDeviceId];
      device.lastSeenAt = Date.now();
    } else {
      if (!identityPubKeyJwk || !ecdhPubKeyJwk || !fingerprint) {
        res.status(400).json({ error: 'Device E2EE public keys are required for new device login.' });
        return;
      }
      const deviceId = crypto.randomUUID();
      const hasExistingDevices = Object.values(store.state.devices).some((d) => d.userId === user.id && d.revokedAt === null);
      device = {
        deviceId,
        userId: user.id,
        deviceName: typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim().slice(0, 48) : 'New Device',
        platform: ['Web', 'Android', 'iOS', 'Windows'].includes(platform) ? platform : 'Web',
        identityPubKeyJwk,
        ecdhPubKeyJwk,
        fingerprint: String(fingerprint).slice(0, 128),
        verifiedByUser: !hasExistingDevices,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        revokedAt: null,
      };
      store.state.devices[deviceId] = device;
    }

    const rawToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawToken);
    store.state.sessions[tokenHash] = {
      tokenHash,
      userId: user.id,
      deviceId: device.deviceId,
      ipMasked: maskIpAddress(req.ip),
      userAgent: String(req.headers['user-agent'] ?? 'Unknown').slice(0, 120),
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      revoked: false,
    };

    recordLoginAlert(user.id, 'login_success', device.deviceName, device.platform, req.ip);
    store.schedulePersist();

    res.json({
      token: rawToken,
      deviceId: device.deviceId,
      verifiedByUser: device.verifiedByUser,
      user: serializeUser(user),
    });
  });

  // 3. Account Recovery via single-use recovery code
  app.post('/api/auth/recover', async (req, res) => {
    const { username, recoveryCode, newPassword } = req.body ?? {};
    const uCheck = validateUsername(String(username ?? ''));
    const userId = store.state.usernameIndex[uCheck.normalized];
    const user = userId ? store.state.users[userId] : undefined;
    if (!user || typeof recoveryCode !== 'string') {
      res.status(401).json({ error: 'Invalid recovery credentials.' });
      return;
    }
    const cleanCodeHash = sha256Hex(recoveryCode.trim().toUpperCase().replace(/-/g, ''));
    const idx = user.recoveryCodeHashes.indexOf(cleanCodeHash);
    if (idx === -1) {
      res.status(401).json({ error: 'Invalid or already used recovery code.' });
      return;
    }
    const pCheck = validatePasswordStrength(String(newPassword ?? ''), user.username);
    if (!pCheck.valid) {
      res.status(400).json({ error: pCheck.error });
      return;
    }
    user.recoveryCodeHashes.splice(idx, 1);
    user.passwordHash = await hashPasswordArgon2id(newPassword, options.argon2Options);
    user.suspended = false;
    user.suspensionReason = null;
    user.totpEnabled = false;
    user.totpSecret = null;
    recordLoginAlert(user.id, 'account_recovered', 'Account Recovery', 'Web', req.ip);
    store.schedulePersist();
    res.json({ recovered: true, remainingRecoveryCodes: user.recoveryCodeHashes.length });
  });

  // 3b. Federated / Social OAuth2 Sign-In (Google via Firebase Auth ID Token + Facebook, GitHub, Discord via OAuth2 Popup)
  const oauthPendingStates = new Map<string, { provider: ThirdPartyOAuthProvider; expiresAt: number }>();
  const oauthExchangeCodes = new Map<string, { identity: VerifiedOAuthIdentity; expiresAt: number }>();

  function completeFederatedSignIn(
    identity: VerifiedOAuthIdentity,
    devicePayload: {
      deviceName?: unknown;
      platform?: unknown;
      identityPubKeyJwk?: unknown;
      ecdhPubKeyJwk?: unknown;
      fingerprint?: unknown;
      existingDeviceId?: unknown;
    },
    req: Request
  ): {
    status: number;
    body: Record<string, unknown>;
  } {
    const { identityPubKeyJwk, ecdhPubKeyJwk, fingerprint, deviceName, platform, existingDeviceId } = devicePayload;
    if (!identityPubKeyJwk || !ecdhPubKeyJwk || !fingerprint) {
      return {
        status: 400,
        body: { error: 'Client device E2EE public keys and fingerprint are required.' },
      };
    }

    if (!store.state.oauthIndex) {
      store.state.oauthIndex = {};
    }
    const indexKey = `${identity.provider}:${identity.subject}`;
    let userId = store.state.oauthIndex[indexKey];
    let user = userId ? store.state.users[userId] : undefined;
    let isNewAccount = false;
    let recoveryCodes: string[] | undefined;

    if (!user) {
      isNewAccount = true;
      userId = crypto.randomUUID();
      const username = deriveUniqueOAuthUsername(
        identity.preferredUsername,
        identity.provider,
        store.state.usernameIndex
      );
      recoveryCodes = generateRecoveryCodes(8);
      const recoveryCodeHashes = recoveryCodes.map((c) => sha256Hex(c.replace(/-/g, '')));
      user = {
        id: userId,
        username,
        displayName: identity.displayName || `@${username}`,
        bio: '',
        authProvider: identity.provider,
        linkedProviders: [identity.provider],
        contactNumberHash: null,
        contactNumberMasked: null,
        gamingConnection: {
          platform: 'PC / Steam',
          gamertag: '',
          discordUsername: identity.provider === 'discord' ? identity.preferredUsername : '',
          discordInviteCode: '',
          discordConnectedViaOAuth: identity.provider === 'discord',
          visibility: 'private',
        },
        walletBalanceCents: 0,
        identity3D: { ...DEFAULT_IDENTITY_3D },
        vaultPinHash: null,
        duressPinHash: null,
        duressBehavior: 'decoy_screen',
        screenshotPrivacy: true,
        phishingProtection: true,
        nearbyDiscoveryEnabled: false,
        nearbyZoneLabel: '',
        featureSelection: createDefaultFeatureSelection(),
        stickerPack: DEFAULT_STICKER_PACK.map((s) => ({ ...s })),
        passwordHash: `!oauth!${crypto.randomBytes(16).toString('hex')}`,
        totpEnabled: false,
        totpSecret: null,
        recoveryCodeHashes,
        suspended: false,
        suspensionReason: null,
        privacySettings: {
          discoverableByUsername: true,
          sendReadReceipts: false,
          hideNotificationPreviews: true,
          allowGroupInvites: true,
          contactNumberVisibility: 'private',
          allowLookupByContactNumber: false,
          hideOnlinePresence: true,
        },
        notificationSettings: {
          enabled: true,
          soundEnabled: false,
          loginAlertsEnabled: true,
          previewMode: 'none',
          customSound: 'crystal',
        },
        createdAt: Date.now(),
      };
      store.state.users[userId] = user;
      store.state.usernameIndex[username] = userId;
      store.state.oauthIndex[indexKey] = userId;
    } else if (user.suspended) {
      return {
        status: 403,
        body: { error: `Account suspended: ${user.suspensionReason ?? 'Contact security administrator.'}` },
      };
    }

    let device: DeviceRecord | undefined;
    if (typeof existingDeviceId === 'string' && store.state.devices[existingDeviceId]) {
      const candidate = store.state.devices[existingDeviceId];
      if (candidate.userId === user.id && candidate.revokedAt === null) {
        device = candidate;
        device.lastSeenAt = Date.now();
      }
    }

    if (!device) {
      const deviceId = crypto.randomUUID();
      device = {
        deviceId,
        userId: user.id,
        deviceName:
          typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim().slice(0, 48) : 'Primary Browser Device',
        platform: ['Web', 'Android', 'iOS', 'Windows'].includes(String(platform))
          ? (platform as DeviceRecord['platform'])
          : 'Web',
        identityPubKeyJwk: identityPubKeyJwk as JsonWebKey,
        ecdhPubKeyJwk: ecdhPubKeyJwk as JsonWebKey,
        fingerprint: String(fingerprint).slice(0, 128),
        verifiedByUser: true,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        revokedAt: null,
      };
      store.state.devices[deviceId] = device;
    }

    const rawToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawToken);
    store.state.sessions[tokenHash] = {
      tokenHash,
      userId: user.id,
      deviceId: device.deviceId,
      ipMasked: maskIpAddress(req.ip),
      userAgent: String(req.headers['user-agent'] ?? 'Unknown').slice(0, 120),
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      revoked: false,
    };

    recordLoginAlert(user.id, 'login_success', device.deviceName, device.platform, req.ip);
    store.schedulePersist();

    console.info(
      '[auth:oauth]',
      JSON.stringify(sanitizeLogPayload({ provider: identity.provider, userId: user.id, username: user.username, isNewAccount }))
    );

    return {
      status: isNewAccount ? 201 : 200,
      body: {
        token: rawToken,
        deviceId: device.deviceId,
        user: serializeUser(user),
        isNewAccount,
        recoveryCodes,
      },
    };
  }

  function getRequestOrigin(req: Request): string {
    const rawProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const rawHost = String(req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000').split(',')[0].trim();
    return `${rawProto}://${rawHost}`;
  }

  app.get('/api/auth/oauth/providers', (req, res) => {
    const origin = getRequestOrigin(req);
    const fb = getThirdPartyProviderMeta('facebook', origin);
    const gh = getThirdPartyProviderMeta('github', origin);
    const dc = getThirdPartyProviderMeta('discord', origin);
    res.json({
      providers: [
        {
          provider: 'google' as OAuthProviderId,
          label: 'Google',
          configured: true,
          mode: 'firebase_popup',
        },
        {
          provider: 'facebook' as OAuthProviderId,
          label: fb.label,
          configured: fb.configured,
          mode: 'oauth_popup',
          redirectUri: fb.redirectUri,
          requiredEnv: fb.requiredEnv,
          dashboardUrl: fb.dashboardUrl,
        },
        {
          provider: 'github' as OAuthProviderId,
          label: gh.label,
          configured: gh.configured,
          mode: 'oauth_popup',
          redirectUri: gh.redirectUri,
          requiredEnv: gh.requiredEnv,
          dashboardUrl: gh.dashboardUrl,
        },
        {
          provider: 'discord' as OAuthProviderId,
          label: dc.label,
          configured: dc.configured,
          mode: 'oauth_popup',
          redirectUri: dc.redirectUri,
          requiredEnv: dc.requiredEnv,
          dashboardUrl: dc.dashboardUrl,
        },
      ],
    });
  });

  app.post('/api/auth/oauth/google', async (req, res) => {
    try {
      const { idToken } = req.body ?? {};
      if (!idToken || typeof idToken !== 'string') {
        res.status(400).json({ error: 'Firebase Google ID token is required.' });
        return;
      }
      const identity = await verifyFirebaseGoogleIdToken(idToken);
      const result = completeFederatedSignIn(identity, req.body ?? {}, req);
      res.status(result.status).json(result.body);
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Google authentication verification failed.',
      });
    }
  });

  app.get('/api/auth/oauth/:provider/url', (req, res) => {
    const rawProvider = String(req.params.provider || '').toLowerCase();
    if (!['facebook', 'github', 'discord'].includes(rawProvider)) {
      res.status(400).json({ error: 'Unsupported OAuth provider.' });
      return;
    }
    const provider = rawProvider as ThirdPartyOAuthProvider;
    const meta = getThirdPartyProviderMeta(provider, getRequestOrigin(req));
    if (!meta.configured || !meta.clientId) {
      res.json({
        configured: false,
        provider: meta.provider,
        label: meta.label,
        redirectUri: meta.redirectUri,
        requiredEnv: meta.requiredEnv,
        dashboardUrl: meta.dashboardUrl,
      });
      return;
    }

    // Purge expired states
    const now = Date.now();
    for (const [k, v] of oauthPendingStates.entries()) {
      if (v.expiresAt <= now) oauthPendingStates.delete(k);
    }

    const state = generateOpaqueToken(24);
    oauthPendingStates.set(state, { provider, expiresAt: now + 10 * 60 * 1000 });

    const params = new URLSearchParams({
      client_id: meta.clientId,
      redirect_uri: meta.redirectUri,
      response_type: 'code',
      scope: meta.scopes,
      state,
    });
    res.json({
      configured: true,
      provider: meta.provider,
      label: meta.label,
      url: `${meta.authBaseUrl}?${params.toString()}`,
      redirectUri: meta.redirectUri,
    });
  });

  app.get(['/auth/oauth/:provider/callback', '/auth/oauth/:provider/callback/'], async (req, res) => {
    const rawProvider = String(req.params.provider || '').toLowerCase();
    const renderPopupPage = (payload: Record<string, unknown>, message: string) => {
      const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!doctype html>
<html>
  <head><title>RRchat 1 Authentication</title></head>
  <body style="background:#06070B;color:#f4f4f5;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;">
    <div>
      <p style="font-size:14px;opacity:0.9;">${message.replace(/</g, '&lt;')}</p>
      <script>
        if (window.opener) {
          window.opener.postMessage(${safeJson}, '*');
          window.close();
        } else {
          window.location.href = '/';
        }
      </script>
    </div>
  </body>
</html>`);
    };

    if (!['facebook', 'github', 'discord'].includes(rawProvider)) {
      renderPopupPage({ type: 'RRCHAT_OAUTH_ERROR', error: 'Unsupported OAuth provider.' }, 'Unsupported OAuth provider.');
      return;
    }
    const provider = rawProvider as ThirdPartyOAuthProvider;
    const { code, state, error: oauthErr, error_description: oauthErrDesc } = req.query;

    if (oauthErr) {
      const reason = String(oauthErrDesc || oauthErr).slice(0, 140);
      renderPopupPage(
        { type: 'RRCHAT_OAUTH_ERROR', provider, error: reason },
        `Authentication canceled: ${reason}`
      );
      return;
    }

    const pending = typeof state === 'string' ? oauthPendingStates.get(state) : undefined;
    if (typeof state === 'string') oauthPendingStates.delete(state);
    if (!pending || pending.provider !== provider || pending.expiresAt <= Date.now() || typeof code !== 'string') {
      renderPopupPage(
        { type: 'RRCHAT_OAUTH_ERROR', provider, error: 'Invalid or expired OAuth state.' },
        'Invalid or expired authentication state. Please close this window and retry.'
      );
      return;
    }

    const meta = getThirdPartyProviderMeta(provider, getRequestOrigin(req));
    if (!meta.configured) {
      renderPopupPage(
        { type: 'RRCHAT_OAUTH_ERROR', provider, error: `${meta.label} OAuth credentials are not configured.` },
        `${meta.label} OAuth is not configured on this server.`
      );
      return;
    }

    try {
      const identity = await exchangeThirdPartyCodeForIdentity(provider, code, meta);
      const exchangeCode = generateOpaqueToken(24);
      const now = Date.now();
      for (const [k, v] of oauthExchangeCodes.entries()) {
        if (v.expiresAt <= now) oauthExchangeCodes.delete(k);
      }
      oauthExchangeCodes.set(exchangeCode, { identity, expiresAt: now + 2 * 60 * 1000 });
      renderPopupPage(
        { type: 'RRCHAT_OAUTH_SUCCESS', provider, exchangeCode },
        `${meta.label} authentication successful. Returning to RRchat 1...`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'OAuth token exchange failed.';
      renderPopupPage({ type: 'RRCHAT_OAUTH_ERROR', provider, error: msg }, msg);
    }
  });

  app.post('/api/auth/oauth/exchange', (req, res) => {
    const { provider, exchangeCode } = req.body ?? {};
    if (!exchangeCode || typeof exchangeCode !== 'string') {
      res.status(400).json({ error: 'OAuth exchange code is required.' });
      return;
    }
    const entry = oauthExchangeCodes.get(exchangeCode);
    oauthExchangeCodes.delete(exchangeCode);
    if (!entry || entry.expiresAt <= Date.now() || (provider && entry.identity.provider !== provider)) {
      res.status(401).json({ error: 'OAuth exchange code is invalid or expired.' });
      return;
    }
    const result = completeFederatedSignIn(entry.identity, req.body ?? {}, req);
    res.status(result.status).json(result.body);
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    const { tokenHash } = req.auth!;
    if (store.state.sessions[tokenHash]) {
      store.state.sessions[tokenHash].revoked = true;
      store.schedulePersist();
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    const { user, device } = req.auth!;
    res.json({
      user: serializeUser(user),
      currentDevice: device,
    });
  });

  app.patch('/api/auth/profile', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { displayName, bio } = req.body ?? {};
    if (typeof displayName === 'string' && displayName.trim()) {
      user.displayName = displayName.trim().slice(0, 48);
    }
    if (typeof bio === 'string') {
      user.bio = bio.trim().slice(0, 180);
    }
    store.schedulePersist();
    res.json({ displayName: user.displayName, bio: user.bio });
  });

  // 2FA TOTP Setup & Verification
  app.post('/api/auth/2fa/setup', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const secret = generateTotpSecret();
    user.totpSecret = secret;
    user.totpEnabled = false;
    store.schedulePersist();
    res.json({
      secret,
      otpauthUri: buildOtpAuthUri(user.username, secret),
    });
  });

  app.post('/api/auth/2fa/verify', requireAuth, (req: AuthedRequest, res) => {
    const { user, device } = req.auth!;
    const { code } = req.body ?? {};
    if (!user.totpSecret) {
      res.status(400).json({ error: 'Initialize 2FA setup first.' });
      return;
    }
    if (!verifyTotpToken(user.totpSecret, String(code ?? ''))) {
      res.status(400).json({ error: 'Invalid 6-digit authenticator code.' });
      return;
    }
    user.totpEnabled = true;
    recordLoginAlert(user.id, '2fa_enabled', device.deviceName, device.platform, req.ip);
    store.schedulePersist();
    res.json({ totpEnabled: true });
  });

  app.post('/api/auth/2fa/disable', requireAuth, async (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { password } = req.body ?? {};
    const secretInput = String(password ?? '').trim();
    const isOAuthOnly = user.passwordHash.startsWith('!oauth!');
    const oauthConfirmed =
      isOAuthOnly &&
      (secretInput === user.username ||
        secretInput.toUpperCase() === 'DISABLE' ||
        (Boolean(user.totpSecret) && verifyTotpToken(user.totpSecret!, secretInput)));

    if (!oauthConfirmed && (!secretInput || isOAuthOnly || !(await verifyPasswordArgon2id(secretInput, user.passwordHash)))) {
      res.status(401).json({
        error: isOAuthOnly
          ? 'Enter your username, DISABLE, or a valid 6-digit TOTP code to disable 2FA.'
          : 'Current password required to disable 2FA.',
      });
      return;
    }
    user.totpEnabled = false;
    user.totpSecret = null;
    store.schedulePersist();
    res.json({ totpEnabled: false });
  });

  // Account Suspension & Deletion Controls
  app.post('/api/auth/suspend', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    user.suspended = true;
    user.suspensionReason = String(req.body?.reason ?? 'Self-initiated security freeze').slice(0, 120);
    for (const session of Object.values(store.state.sessions)) {
      if (session.userId === user.id) session.revoked = true;
    }
    for (const dev of Object.values(store.state.devices)) {
      if (dev.userId === user.id) disconnectDeviceSockets(user.id, dev.deviceId, 'Account suspended');
    }
    store.schedulePersist();
    res.json({ suspended: true });
  });

  app.delete('/api/auth/account', requireAuth, async (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { password } = req.body ?? {};
    const isOAuthOnly = user.passwordHash.startsWith('!oauth!');
    const oauthConfirmed = isOAuthOnly && (password === user.username || password === 'DELETE');
    if (!oauthConfirmed && (!password || isOAuthOnly || !(await verifyPasswordArgon2id(String(password), user.passwordHash)))) {
      res.status(401).json({
        error: isOAuthOnly
          ? 'Enter your username or DELETE to permanently delete your federated account.'
          : 'Password confirmation required to permanently delete account.',
      });
      return;
    }
    delete store.state.usernameIndex[user.username];
    if (store.state.oauthIndex) {
      for (const [k, uid] of Object.entries(store.state.oauthIndex)) {
        if (uid === user.id) delete store.state.oauthIndex[k];
      }
    }
    delete store.state.users[user.id];
    delete store.state.keyBackups[user.id];
    for (const [k, s] of Object.entries(store.state.sessions)) {
      if (s.userId === user.id) delete store.state.sessions[k];
    }
    for (const [k, d] of Object.entries(store.state.devices)) {
      if (d.userId === user.id) {
        disconnectDeviceSockets(user.id, d.deviceId, 'Account deleted');
        delete store.state.devices[k];
      }
    }
    store.schedulePersist();
    res.json({ deleted: true });
  });

  // Device & Session Management
  app.get('/api/devices', requireAuth, (req: AuthedRequest, res) => {
    const { user, device } = req.auth!;
    const devices = Object.values(store.state.devices)
      .filter((d) => d.userId === user.id)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((d) => ({
        ...d,
        isCurrent: d.deviceId === device.deviceId,
      }));
    const sessions = Object.values(store.state.sessions)
      .filter((s) => s.userId === user.id && !s.revoked)
      .map((s) => ({
        deviceId: s.deviceId,
        ipMasked: s.ipMasked,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      }));
    res.json({ devices, sessions });
  });

  app.post('/api/devices/verify', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { targetDeviceId } = req.body ?? {};
    const target = store.state.devices[String(targetDeviceId ?? '')];
    if (!target || target.userId !== user.id || target.revokedAt !== null) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }
    target.verifiedByUser = true;
    store.schedulePersist();
    res.json({ verified: true, deviceId: target.deviceId });
  });

  app.post('/api/devices/:deviceId/revoke', requireAuth, (req: AuthedRequest, res) => {
    const { user, device } = req.auth!;
    const { deviceId } = req.params;
    const target = store.state.devices[deviceId];
    if (!target || target.userId !== user.id) {
      res.status(404).json({ error: 'Device not found.' });
      return;
    }
    target.revokedAt = Date.now();
    for (const s of Object.values(store.state.sessions)) {
      if (s.userId === user.id && s.deviceId === deviceId) {
        s.revoked = true;
      }
    }
    recordLoginAlert(user.id, 'device_revoked', target.deviceName, target.platform, req.ip);
    disconnectDeviceSockets(user.id, deviceId, `Revoked by ${device.deviceName}`);
    store.schedulePersist();
    res.json({ revoked: true, deviceId });
  });

  // Security Alerts
  app.get('/api/security/alerts', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const alerts = store.state.loginAlerts.filter((a) => a.userId === user.id).slice(0, 50);
    res.json({ alerts });
  });

  app.post('/api/security/alerts/ack', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    for (const a of store.state.loginAlerts) {
      if (a.userId === user.id) a.acknowledged = true;
    }
    store.schedulePersist();
    res.json({ ok: true });
  });

  // Privacy & Notification Settings (with Private Contact Number management)
  app.put('/api/privacy', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const body = req.body ?? {};
    if (typeof body.contactNumber === 'string') {
      const cleanPhone = body.contactNumber.trim().replace(/[\s\-().]/g, '');
      if (cleanPhone.length === 0) {
        user.contactNumberHash = null;
        user.contactNumberMasked = null;
      } else if (cleanPhone.length >= 7 && cleanPhone.length <= 20) {
        user.contactNumberHash = sha256Hex(`rrchat1-phone:${cleanPhone}`);
        user.contactNumberMasked = `${cleanPhone.slice(0, 2)}${'*'.repeat(Math.max(2, cleanPhone.length - 4))}${cleanPhone.slice(-2)}`;
      }
    }
    user.privacySettings = {
      discoverableByUsername: Boolean(body.discoverableByUsername ?? user.privacySettings.discoverableByUsername),
      sendReadReceipts: Boolean(body.sendReadReceipts ?? user.privacySettings.sendReadReceipts),
      hideNotificationPreviews: Boolean(body.hideNotificationPreviews ?? user.privacySettings.hideNotificationPreviews),
      allowGroupInvites: Boolean(body.allowGroupInvites ?? user.privacySettings.allowGroupInvites),
      contactNumberVisibility: 'private',
      allowLookupByContactNumber: Boolean(body.allowLookupByContactNumber ?? user.privacySettings.allowLookupByContactNumber),
      hideOnlinePresence: Boolean(body.hideOnlinePresence ?? user.privacySettings.hideOnlinePresence),
    };
    store.schedulePersist();
    res.json({ privacySettings: user.privacySettings, contactNumberMasked: user.contactNumberMasked });
  });

  app.put('/api/notifications', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const body = req.body ?? {};
    const customSound = ['crystal', 'pulse', 'chime', 'silent'].includes(String(body.customSound))
      ? (body.customSound as 'crystal' | 'pulse' | 'chime' | 'silent')
      : (user.notificationSettings.customSound ?? 'crystal');
    user.notificationSettings = {
      enabled: Boolean(body.enabled ?? user.notificationSettings.enabled),
      soundEnabled: Boolean(body.soundEnabled ?? user.notificationSettings.soundEnabled),
      loginAlertsEnabled: Boolean(body.loginAlertsEnabled ?? user.notificationSettings.loginAlertsEnabled),
      previewMode: body.previewMode === 'sender_only' ? 'sender_only' : 'none',
      customSound,
    };
    store.schedulePersist();
    res.json({ notificationSettings: user.notificationSettings });
  });

  // Encrypted Key Backup (Opaque PBKDF2+AES-GCM blob encrypted on client)
  app.put('/api/keys/backup', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { saltB64, ivB64, wrappedVaultB64, iterations } = req.body ?? {};
    if (!saltB64 || !ivB64 || !wrappedVaultB64) {
      res.status(400).json({ error: 'Encrypted key backup fields are required.' });
      return;
    }
    store.state.keyBackups[user.id] = {
      userId: user.id,
      saltB64: String(saltB64),
      ivB64: String(ivB64),
      wrappedVaultB64: String(wrappedVaultB64),
      iterations: Number(iterations) || 310000,
      updatedAt: Date.now(),
    };
    store.schedulePersist();
    res.json({ backedUp: true, updatedAt: store.state.keyBackups[user.id].updatedAt });
  });

  app.get('/api/keys/backup', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const backup = store.state.keyBackups[user.id];
    if (!backup) {
      res.status(404).json({ error: 'No encrypted key backup found.' });
      return;
    }
    res.json({ backup });
  });

  // Username Directory Search & QR Verification Lookup (Contact number never returned)
  app.get('/api/users/search', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const rawQ = String(req.query.q ?? '').trim();
    const q = rawQ.toLowerCase().replace(/^@/, '');
    const targetUserId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
    const cleanPhoneQuery = rawQ.replace(/[\s\-().]/g, '');
    const phoneQueryHash = cleanPhoneQuery.length >= 7 && /^\+?\d+$/.test(cleanPhoneQuery)
      ? sha256Hex(`rrchat1-phone:${cleanPhoneQuery}`)
      : null;

    const results = Object.values(store.state.users)
      .filter((u) => {
        if (u.id === user.id || u.suspended) return false;
        if (store.isBlocked(user.id, u.id)) return false;
        if (targetUserId) return u.id === targetUserId;
        if (phoneQueryHash) {
          return u.privacySettings.allowLookupByContactNumber && u.contactNumberHash === phoneQueryHash;
        }
        if (!u.privacySettings.discoverableByUsername && u.username !== q) return false;
        if (!q) return true;
        return u.username.includes(q) || u.displayName.toLowerCase().includes(q);
      })
      .slice(0, 25)
      .map(publicUserSummary);

    const blockedUsers = store.state.blocks
      .filter((b) => b.blockerId === user.id)
      .map((b) => store.state.users[b.targetId])
      .filter(Boolean)
      .map((u) => ({ id: u.id, username: u.username, displayName: u.displayName }));

    res.json({ users: results, blockedUsers });
  });

  app.post('/api/users/block', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { targetUserId } = req.body ?? {};
    if (!targetUserId || !store.state.users[targetUserId] || targetUserId === user.id) {
      res.status(400).json({ error: 'Invalid target user.' });
      return;
    }
    if (!store.hasBlocked(user.id, targetUserId)) {
      store.state.blocks.push({ blockerId: user.id, targetId: targetUserId, createdAt: Date.now() });
      store.schedulePersist();
    }
    res.json({ blocked: true });
  });

  app.delete('/api/users/block/:targetId', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    store.state.blocks = store.state.blocks.filter(
      (b) => !(b.blockerId === user.id && b.targetId === req.params.targetId)
    );
    store.schedulePersist();
    res.json({ unblocked: true });
  });

  app.post('/api/users/report', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { targetUserId, reason } = req.body ?? {};
    if (!targetUserId || !store.state.users[targetUserId] || typeof reason !== 'string' || !reason.trim()) {
      res.status(400).json({ error: 'Target user and abuse reason are required.' });
      return;
    }
    store.state.reports.push({
      id: crypto.randomUUID(),
      reporterId: user.id,
      targetId: targetUserId,
      reason: reason.trim().slice(0, 300),
      createdAt: Date.now(),
    });
    store.schedulePersist();
    res.status(201).json({ reported: true });
  });

  // Rooms & E2EE Key Distribution
  app.get('/api/rooms', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    store.purgeExpiredMessages();
    const rooms = Object.values(store.state.rooms)
      .filter((r) => r.memberIds.includes(user.id))
      .map((r) => {
        const members = r.memberIds.map((id) => store.state.users[id]).filter(Boolean).map(publicUserSummary);
        const msgs = store.state.messages[r.id] ?? [];
        const lastMessage = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        return {
          ...r,
          members,
          lastMessage,
          messageCount: msgs.length,
        };
      })
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt));

    res.json({ rooms });
  });

  app.post('/api/rooms', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { type, title, topic, inviteOnly, slowModeSeconds, memberIds, encryptedRoomKeys, disappearingTtlSeconds } =
      req.body ?? {};
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      res.status(400).json({ error: 'At least one recipient is required.' });
      return;
    }
    const uniqueMembers = Array.from(new Set([user.id, ...memberIds.map(String)]));
    for (const mId of uniqueMembers) {
      const m = store.state.users[mId];
      if (!m || m.suspended) {
        res.status(404).json({ error: 'One or more target users do not exist.' });
        return;
      }
      if (mId !== user.id && store.isBlocked(user.id, mId)) {
        res.status(403).json({ error: 'Cannot start conversation with a blocked user.' });
        return;
      }
      if (type === 'group' && mId !== user.id && !m.privacySettings.allowGroupInvites) {
        res.status(403).json({ error: `@${m.username} has disabled group invites.` });
        return;
      }
    }

    if (type === 'direct' && uniqueMembers.length === 2) {
      const existing = Object.values(store.state.rooms).find(
        (r) =>
          r.type === 'direct' &&
          r.memberIds.length === 2 &&
          uniqueMembers.every((id) => r.memberIds.includes(id))
      );
      if (existing) {
        res.json({
          room: {
            ...existing,
            members: existing.memberIds.map((id) => store.state.users[id]).filter(Boolean).map(publicUserSummary),
          },
          existing: true,
        });
        return;
      }
    }

    if (!encryptedRoomKeys || typeof encryptedRoomKeys !== 'object') {
      res.status(400).json({ error: 'Per-device E2EE wrapped room keys are required.' });
      return;
    }

    const room: ChatRoom = {
      id: crypto.randomUUID(),
      type: type === 'group' ? 'group' : 'direct',
      title: type === 'group' ? String(title ?? 'Smart Room').trim().slice(0, 60) : '',
      topic: type === 'group' && typeof topic === 'string' ? topic.trim().slice(0, 140) : '',
      inviteOnly: type === 'group' ? Boolean(inviteOnly ?? true) : true,
      slowModeSeconds:
        type === 'group' && typeof slowModeSeconds === 'number' && slowModeSeconds > 0
          ? Math.min(slowModeSeconds, 300)
          : null,
      inVaultByUser: {},
      memberIds: uniqueMembers,
      adminIds: [user.id],
      disappearingTtlSeconds: typeof disappearingTtlSeconds === 'number' && disappearingTtlSeconds > 0 ? disappearingTtlSeconds : null,
      createdAt: Date.now(),
      encryptedRoomKeys: encryptedRoomKeys as Record<string, WrappedRoomKey>,
    };

    store.state.rooms[room.id] = room;
    store.state.messages[room.id] = [];
    store.schedulePersist();

    const enriched = {
      ...room,
      members: room.memberIds.map((id) => store.state.users[id]).filter(Boolean).map(publicUserSummary),
      lastMessage: null,
      messageCount: 0,
    };
    sendToRoom(room, 'room:updated', enriched);
    res.status(201).json({ room: enriched });
  });

  app.post('/api/rooms/:roomId/keys', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    const { encryptedRoomKeys } = req.body ?? {};
    if (!encryptedRoomKeys || typeof encryptedRoomKeys !== 'object') {
      res.status(400).json({ error: 'encryptedRoomKeys object required.' });
      return;
    }
    Object.assign(room.encryptedRoomKeys, encryptedRoomKeys);
    store.schedulePersist();
    sendToRoom(room, 'room:updated', {
      ...room,
      members: room.memberIds.map((id) => store.state.users[id]).filter(Boolean).map(publicUserSummary),
    });
    res.json({ ok: true });
  });

  app.patch('/api/rooms/:roomId/disappearing', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    const ttl = req.body?.disappearingTtlSeconds;
    room.disappearingTtlSeconds = typeof ttl === 'number' && ttl > 0 ? Math.min(ttl, 30 * 24 * 3600) : null;
    store.schedulePersist();
    sendToRoom(room, 'room:updated', {
      ...room,
      members: room.memberIds.map((id) => store.state.users[id]).filter(Boolean).map(publicUserSummary),
    });
    res.json({ disappearingTtlSeconds: room.disappearingTtlSeconds });
  });

  // Encrypted Messages (Zero-Plaintext Guarantee)
  app.get('/api/rooms/:roomId/messages', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    store.purgeExpiredMessages();
    const messages = store.state.messages[room.id] ?? [];
    res.json({ messages });
  });

  app.post('/api/rooms/:roomId/messages', requireAuth, (req: AuthedRequest, res) => {
    const { user, device } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    for (const mId of room.memberIds) {
      if (mId !== user.id && store.isBlocked(user.id, mId)) {
        res.status(403).json({ error: 'Messaging disabled because a participant is blocked.' });
        return;
      }
    }

    const body = req.body ?? {};
    // Strictly reject any plaintext field so unencrypted content can never be accepted
    if ('plaintext' in body || 'body' in body || 'text' in body || 'message' in body) {
      res.status(400).json({
        error: 'Plaintext fields are strictly forbidden by RRchat 1 E2EE policy. Encrypt client-side before sending.',
      });
      return;
    }

    const { kind, ciphertextB64, ivB64, attachmentCiphertextB64, attachmentIvB64, attachmentMetaEncB64, attachmentMetaIvB64, attachmentMime, attachmentBytes, replyToId } =
      body;

    if (!ciphertextB64 || !ivB64 || typeof ciphertextB64 !== 'string' || typeof ivB64 !== 'string') {
      res.status(400).json({ error: 'Encrypted ciphertextB64 and ivB64 are required.' });
      return;
    }

    if (attachmentCiphertextB64) {
      const attCheck = validateEncryptedAttachmentMeta(String(attachmentMime ?? ''), Number(attachmentBytes ?? 0));
      if (!attCheck.valid) {
        res.status(400).json({ error: attCheck.error });
        return;
      }
    }

    const now = Date.now();
    const msg: EncryptedMessage = {
      id: crypto.randomUUID(),
      roomId: room.id,
      senderId: user.id,
      senderDeviceId: device.deviceId,
      kind: ['text', 'image', 'video', 'file', 'voice', 'payment', 'call', 'sticker'].includes(kind) ? kind : 'text',
      ciphertextB64,
      ivB64,
      ...(attachmentCiphertextB64
        ? {
            attachmentCiphertextB64,
            attachmentIvB64,
            attachmentMetaEncB64,
            attachmentMetaIvB64,
          }
        : {}),
      replyToId: typeof replyToId === 'string' ? replyToId : null,
      reactions: {},
      deliveredTo: room.memberIds.filter((id) => userSockets.has(id) || id === user.id),
      readBy: [user.id],
      createdAt: now,
      expiresAt: room.disappearingTtlSeconds ? now + room.disappearingTtlSeconds * 1000 : null,
    };

    if (!store.state.messages[room.id]) {
      store.state.messages[room.id] = [];
    }
    store.state.messages[room.id].push(msg);
    store.schedulePersist();

    sendToRoom(room, 'message:new', msg);
    res.status(201).json({ message: msg });
  });

  app.post('/api/messages/:messageId/react', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { roomId, emoji } = req.body ?? {};
    const room = store.state.rooms[String(roomId ?? '')];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    const msgs = store.state.messages[room.id] ?? [];
    const target = msgs.find((m) => m.id === req.params.messageId);
    if (!target || typeof emoji !== 'string' || !emoji.trim() || emoji.length > 8) {
      res.status(400).json({ error: 'Invalid message or reaction.' });
      return;
    }
    const cleanEmoji = emoji.trim();
    const list = target.reactions[cleanEmoji] ?? [];
    if (list.includes(user.id)) {
      target.reactions[cleanEmoji] = list.filter((id) => id !== user.id);
      if (target.reactions[cleanEmoji].length === 0) delete target.reactions[cleanEmoji];
    } else {
      target.reactions[cleanEmoji] = [...list, user.id];
    }
    store.schedulePersist();
    sendToRoom(room, 'message:reaction', { roomId: room.id, messageId: target.id, reactions: target.reactions });
    res.json({ reactions: target.reactions });
  });

  app.post('/api/rooms/:roomId/read', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    if (!user.privacySettings.sendReadReceipts) {
      res.json({ skipped: true });
      return;
    }
    const msgs = store.state.messages[room.id] ?? [];
    const updatedIds: string[] = [];
    for (const m of msgs) {
      if (!m.deliveredTo.includes(user.id)) m.deliveredTo.push(user.id);
      if (!m.readBy.includes(user.id)) {
        m.readBy.push(user.id);
        updatedIds.push(m.id);
      }
    }
    if (updatedIds.length > 0) {
      store.schedulePersist();
      sendToRoom(room, 'message:read', { roomId: room.id, userId: user.id, messageIds: updatedIds });
    }
    res.json({ readCount: updatedIds.length });
  });

  // Edit & Delete E2EE Messages
  app.patch('/api/rooms/:roomId/messages/:messageId', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    const body = req.body ?? {};
    if ('plaintext' in body || 'body' in body || 'text' in body) {
      res.status(400).json({ error: 'Plaintext edits are forbidden by E2EE policy.' });
      return;
    }
    const msgs = store.state.messages[room.id] ?? [];
    const target = msgs.find((m) => m.id === req.params.messageId);
    if (!target || target.senderId !== user.id || target.deleted) {
      res.status(403).json({ error: 'You can only edit your own active messages.' });
      return;
    }
    if (!body.ciphertextB64 || !body.ivB64) {
      res.status(400).json({ error: 'Encrypted ciphertextB64 and ivB64 required.' });
      return;
    }
    target.ciphertextB64 = String(body.ciphertextB64);
    target.ivB64 = String(body.ivB64);
    target.editedAt = Date.now();
    store.schedulePersist();
    sendToRoom(room, 'message:edited', {
      roomId: room.id,
      messageId: target.id,
      ciphertextB64: target.ciphertextB64,
      ivB64: target.ivB64,
      editedAt: target.editedAt,
    });
    res.json({ message: target });
  });

  app.delete('/api/rooms/:roomId/messages/:messageId', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    const msgs = store.state.messages[room.id] ?? [];
    const target = msgs.find((m) => m.id === req.params.messageId);
    if (!target || (target.senderId !== user.id && !room.adminIds.includes(user.id))) {
      res.status(403).json({ error: 'Not authorized to delete this message.' });
      return;
    }
    target.deleted = true;
    target.ciphertextB64 = '';
    target.ivB64 = '';
    delete target.attachmentCiphertextB64;
    delete target.attachmentIvB64;
    delete target.attachmentMetaEncB64;
    delete target.attachmentMetaIvB64;
    store.schedulePersist();
    sendToRoom(room, 'message:deleted', { roomId: room.id, messageId: target.id });
    res.json({ deleted: true, messageId: target.id });
  });

  // Private Vault toggle per room & Smart Room moderation/settings
  app.patch('/api/rooms/:roomId/vault', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    if (!room.inVaultByUser) room.inVaultByUser = {};
    room.inVaultByUser[user.id] = Boolean(req.body?.inVault);
    store.schedulePersist();
    res.json({ inVault: room.inVaultByUser[user.id] });
  });

  app.patch('/api/rooms/:roomId/settings', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id) || !room.adminIds.includes(user.id)) {
      res.status(403).json({ error: 'Only room moderators can update Smart Room settings.' });
      return;
    }
    if (typeof req.body?.topic === 'string') {
      room.topic = req.body.topic.trim().slice(0, 140);
    }
    if (typeof req.body?.inviteOnly === 'boolean') {
      room.inviteOnly = req.body.inviteOnly;
    }
    if (req.body?.slowModeSeconds !== undefined) {
      const s = Number(req.body.slowModeSeconds);
      room.slowModeSeconds = Number.isFinite(s) && s > 0 ? Math.min(s, 300) : null;
    }
    store.schedulePersist();
    sendToRoom(room, 'room:updated', {
      ...room,
      members: room.memberIds.map((id) => store.state.users[id]).filter(Boolean).map(publicUserSummary),
    });
    res.json({ room });
  });

  app.post('/api/rooms/:roomId/kick', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    const targetUserId = String(req.body?.targetUserId ?? '');
    if (!room || !room.adminIds.includes(user.id) || targetUserId === user.id) {
      res.status(403).json({ error: 'Moderator permissions required.' });
      return;
    }
    room.memberIds = room.memberIds.filter((id) => id !== targetUserId);
    room.adminIds = room.adminIds.filter((id) => id !== targetUserId);
    store.schedulePersist();
    sendToUser(targetUserId, 'room:updated', { removedRoomId: room.id });
    sendToRoom(room, 'room:updated', {
      ...room,
      members: room.memberIds.map((id) => store.state.users[id]).filter(Boolean).map(publicUserSummary),
    });
    res.json({ removed: true });
  });

  // Private Gaming & Discord Connection (kept strictly inside Private Settings; never public)
  app.put('/api/privacy/gaming', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const body = req.body ?? {};
    const rawInvite = String(body.discordInviteCode ?? '').trim();
    const inviteCode = rawInvite
      .replace(/^https?:\/\/(www\.)?(discord\.gg|discord\.com\/invite)\//i, '')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 32);

    user.gamingConnection = {
      platform: String(body.platform ?? user.gamingConnection?.platform ?? 'PC / Steam').slice(0, 32),
      gamertag: String(body.gamertag ?? '').trim().slice(0, 48),
      discordUsername: String(body.discordUsername ?? '').trim().slice(0, 48),
      discordInviteCode: inviteCode,
      discordConnectedViaOAuth: Boolean(user.gamingConnection?.discordConnectedViaOAuth),
      visibility: 'private',
    };
    store.schedulePersist();
    res.json({ gamingConnection: user.gamingConnection });
  });

  app.get('/api/discord/auth-url', requireAuth, (req: AuthedRequest, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const appBase = (process.env.APP_URL || '').replace(/\/$/, '');
    if (!clientId || !appBase) {
      res.json({
        configured: false,
        redirectUri: appBase ? `${appBase}/auth/discord/callback` : '/auth/discord/callback',
      });
      return;
    }
    const redirectUri = `${appBase}/auth/discord/callback`;
    const state = Buffer.from(JSON.stringify({ u: req.auth!.user.id })).toString('base64url');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify guilds.join',
      state,
    });
    res.json({
      configured: true,
      url: `https://discord.com/oauth2/authorize?${params.toString()}`,
      redirectUri,
    });
  });

  app.get(['/auth/discord/callback', '/auth/discord/callback/'], async (req, res) => {
    const { code, state } = req.query;
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const appBase = (process.env.APP_URL || '').replace(/\/$/, '');

    if (!code || !clientId || !clientSecret || !appBase) {
      res.status(400).send('Discord OAuth is not configured on this server.');
      return;
    }

    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: `${appBase}/auth/discord/callback`,
        }),
      });
      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) {
        res.status(400).send('Discord authorization failed.');
        return;
      }

      const meRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const discordUser = (await meRes.json()) as { username?: string };
      if (state && discordUser.username) {
        try {
          const decoded = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8')) as { u?: string };
          const account = decoded.u ? store.state.users[decoded.u] : undefined;
          if (account) {
            account.gamingConnection = {
              ...account.gamingConnection,
              discordUsername: discordUser.username,
              discordConnectedViaOAuth: true,
              visibility: 'private',
            };
            store.schedulePersist();
          }
        } catch {
          // Ignore malformed state
        }
      }

      res.send(`
        <html>
          <body style="background:#0B0F17;color:#F1F5F9;font-family:sans-serif;padding:32px;">
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'DISCORD_OAUTH_SUCCESS', username: ${JSON.stringify(discordUser.username ?? '')} }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Discord connected privately. You may close this window.</p>
          </body>
        </html>
      `);
    } catch {
      res.status(500).send('Discord OAuth exchange error.');
    }
  });

  // Private Wallet & Peer-to-Peer Payment Transfers (Balances & transfers strictly private)
  app.get('/api/wallet', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const history = (store.state.payments ?? [])
      .filter((p) => p.senderId === user.id || p.recipientId === user.id)
      .slice(-30)
      .reverse()
      .map((p) => {
        const peerId = p.senderId === user.id ? p.recipientId : p.senderId;
        const peer = store.state.users[peerId];
        return {
          id: p.id,
          direction: p.senderId === user.id ? 'sent' : 'received',
          peerUsername: peer?.username ?? 'unknown',
          amountCents: p.amountCents,
          currency: p.currency,
          createdAt: p.createdAt,
        };
      });
    res.json({ balanceCents: user.walletBalanceCents ?? 0, history });
  });

  app.post('/api/wallet/deposit', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const amountCents = Math.round(Number(req.body?.amountCents ?? 0));
    if (!Number.isFinite(amountCents) || amountCents < 100 || amountCents > 1_000_000) {
      res.status(400).json({ error: 'Deposit must be between $1.00 and $10,000.00.' });
      return;
    }
    user.walletBalanceCents = (user.walletBalanceCents ?? 0) + amountCents;
    store.schedulePersist();
    res.json({ balanceCents: user.walletBalanceCents });
  });

  app.post('/api/payments/transfer', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { roomId, recipientId, amountCents } = req.body ?? {};
    const room = store.state.rooms[String(roomId ?? '')];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const targetId = String(recipientId ?? '');
    if (!targetId || targetId === user.id || !room.memberIds.includes(targetId)) {
      res.status(400).json({ error: 'Select a valid recipient inside this chat.' });
      return;
    }
    if (store.isBlocked(user.id, targetId)) {
      res.status(403).json({ error: 'Payments blocked between these users.' });
      return;
    }
    const recipient = store.state.users[targetId];
    if (!recipient || recipient.suspended) {
      res.status(404).json({ error: 'Recipient account unavailable.' });
      return;
    }

    const cents = Math.round(Number(amountCents ?? 0));
    if (!Number.isFinite(cents) || cents <= 0 || cents > 1_000_000) {
      res.status(400).json({ error: 'Payment amount must be between $0.01 and $10,000.00.' });
      return;
    }
    if ((user.walletBalanceCents ?? 0) < cents) {
      res.status(400).json({ error: 'Insufficient private wallet balance. Add funds in Private Settings.' });
      return;
    }

    user.walletBalanceCents -= cents;
    recipient.walletBalanceCents = (recipient.walletBalanceCents ?? 0) + cents;

    const transfer = {
      id: crypto.randomUUID(),
      roomId: room.id,
      senderId: user.id,
      recipientId: recipient.id,
      amountCents: cents,
      currency: 'USD' as const,
      createdAt: Date.now(),
    };
    if (!store.state.payments) store.state.payments = [];
    store.state.payments.push(transfer);
    store.schedulePersist();

    sendToUser(user.id, 'wallet:updated', { balanceCents: user.walletBalanceCents });
    sendToUser(recipient.id, 'wallet:updated', { balanceCents: recipient.walletBalanceCents });

    res.status(201).json({ transfer, balanceCents: user.walletBalanceCents });
  });

  // 3D Identity Studio Profile Customization
  app.put('/api/profile/identity3d', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const b = req.body ?? {};
    user.identity3D = {
      form: ['sentinel', 'orbital', 'helm'].includes(b.form) ? b.form : 'sentinel',
      finish: ['obsidian', 'silver', 'titanium'].includes(b.finish) ? b.finish : 'obsidian',
      auraColor: ['purple', 'violet', 'silver', 'emerald'].includes(b.auraColor) ? b.auraColor : 'purple',
      effect: ['pulse', 'orbit', 'static'].includes(b.effect) ? b.effect : 'orbit',
      badge: ['none', 'zero_phone', 'vault_guard', 'verified_node'].includes(b.badge) ? b.badge : 'zero_phone',
      profileTheme: ['obsidian_purple', 'silver_frost', 'midnight_glass'].includes(b.profileTheme)
        ? b.profileTheme
        : 'obsidian_purple',
    };
    store.schedulePersist();
    res.json({ identity3D: user.identity3D });
  });

  // Private Vault PIN & Duress PIN Protection
  app.put('/api/vault/pin', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const pin = String(req.body?.pin ?? '').trim();
    if (!/^\d{4,8}$/.test(pin)) {
      res.status(400).json({ error: 'Vault PIN must be 4 to 8 digits.' });
      return;
    }
    user.vaultPinHash = sha256Hex(`rrchat1-vault:${user.id}:${pin}`);
    store.schedulePersist();
    res.json({ hasVaultPin: true });
  });

  app.put('/api/vault/duress-pin', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const pin = String(req.body?.pin ?? '').trim();
    const behavior = req.body?.behavior === 'wipe_and_decoy' ? 'wipe_and_decoy' : 'decoy_screen';
    if (!/^\d{4,8}$/.test(pin)) {
      res.status(400).json({ error: 'Duress PIN must be 4 to 8 digits.' });
      return;
    }
    const candidateHash = sha256Hex(`rrchat1-vault:${user.id}:${pin}`);
    if (user.vaultPinHash && candidateHash === user.vaultPinHash) {
      res.status(400).json({ error: 'Duress PIN must be different from your primary Vault PIN.' });
      return;
    }
    user.duressPinHash = sha256Hex(`rrchat1-duress:${user.id}:${pin}`);
    user.duressBehavior = behavior;
    store.schedulePersist();
    res.json({ hasDuressPin: true, duressBehavior: user.duressBehavior });
  });

  app.post('/api/vault/verify', requireAuth, (req: AuthedRequest, res) => {
    const { user, device, tokenHash } = req.auth!;
    const pin = String(req.body?.pin ?? '').trim();

    if (user.duressPinHash) {
      const candidateDuress = sha256Hex(`rrchat1-duress:${user.id}:${pin}`);
      if (candidateDuress === user.duressPinHash) {
        recordLoginAlert(user.id, 'duress_pin_triggered', device.deviceName, device.platform, req.ip);
        if (user.duressBehavior === 'wipe_and_decoy') {
          for (const s of Object.values(store.state.sessions)) {
            if (s.userId === user.id && s.tokenHash !== tokenHash && !s.revoked) {
              s.revoked = true;
              disconnectDeviceSockets(user.id, s.deviceId, 'Duress PIN wipe-and-decoy triggered');
            }
          }
          user.privacySettings.hideNotificationPreviews = true;
          user.privacySettings.hideOnlinePresence = true;
        }
        store.schedulePersist();
        res.json({
          unlocked: true,
          configured: true,
          duressTriggered: true,
          duressBehavior: user.duressBehavior ?? 'decoy_screen',
        });
        return;
      }
    }

    if (!user.vaultPinHash) {
      res.json({ unlocked: true, configured: false, duressTriggered: false });
      return;
    }
    const candidate = sha256Hex(`rrchat1-vault:${user.id}:${pin}`);
    if (candidate !== user.vaultPinHash) {
      res.status(401).json({ error: 'Incorrect Private Vault PIN.' });
      return;
    }
    res.json({ unlocked: true, configured: true, duressTriggered: false });
  });

  // Emergency Privacy Mode (locks previews, revokes other sessions immediately)
  app.post('/api/security/emergency-lock', requireAuth, (req: AuthedRequest, res) => {
    const { user, device, tokenHash } = req.auth!;
    let revokedSessions = 0;
    for (const s of Object.values(store.state.sessions)) {
      if (s.userId === user.id && s.tokenHash !== tokenHash && !s.revoked) {
        s.revoked = true;
        revokedSessions++;
        disconnectDeviceSockets(user.id, s.deviceId, 'Emergency Privacy Mode triggered');
      }
    }
    user.privacySettings.hideNotificationPreviews = true;
    user.privacySettings.hideOnlinePresence = true;
    user.notificationSettings.previewMode = 'none';
    recordLoginAlert(user.id, 'emergency_lock', device.deviceName, device.platform, req.ip);
    store.schedulePersist();
    res.json({
      locked: true,
      revokedSessions,
      privacySettings: user.privacySettings,
      notificationSettings: user.notificationSettings,
    });
  });

  app.post('/api/security/unlock', requireAuth, async (req: AuthedRequest, res) => {
    const { user, device, tokenHash } = req.auth!;
    const rawSecret = String(req.body?.secret ?? '');
    const trimmed = rawSecret.trim();

    if (user.duressPinHash && /^\d{4,8}$/.test(trimmed)) {
      const candidateDuress = sha256Hex(`rrchat1-duress:${user.id}:${trimmed}`);
      if (candidateDuress === user.duressPinHash) {
        recordLoginAlert(user.id, 'duress_pin_triggered', device.deviceName, device.platform, req.ip);
        if (user.duressBehavior === 'wipe_and_decoy') {
          for (const s of Object.values(store.state.sessions)) {
            if (s.userId === user.id && s.tokenHash !== tokenHash && !s.revoked) {
              s.revoked = true;
              disconnectDeviceSockets(user.id, s.deviceId, 'Duress PIN wipe-and-decoy triggered');
            }
          }
          user.privacySettings.hideNotificationPreviews = true;
          user.privacySettings.hideOnlinePresence = true;
        }
        store.schedulePersist();
        res.json({
          unlocked: true,
          duressTriggered: true,
          duressBehavior: user.duressBehavior ?? 'decoy_screen',
        });
        return;
      }
    }

    if (user.vaultPinHash && /^\d{4,8}$/.test(trimmed)) {
      const candidateVault = sha256Hex(`rrchat1-vault:${user.id}:${trimmed}`);
      if (candidateVault === user.vaultPinHash) {
        res.json({ unlocked: true, duressTriggered: false });
        return;
      }
    }

    if (!user.passwordHash.startsWith('!oauth!')) {
      const ok = rawSecret.length > 0 && (await verifyPasswordArgon2id(rawSecret, user.passwordHash));
      if (!ok) {
        res.status(401).json({ error: 'Invalid unlock credentials.' });
        return;
      }
      res.json({ unlocked: true, duressTriggered: false });
      return;
    }

    const oauthConfirmed = trimmed === user.username || trimmed.toUpperCase() === 'UNLOCK';
    if (!oauthConfirmed) {
      res.status(401).json({
        error: user.vaultPinHash
          ? 'Enter your Vault PIN, or type your username / UNLOCK.'
          : 'Enter your username or type UNLOCK to re-authenticate.',
      });
      return;
    }
    res.json({ unlocked: true, duressTriggered: false });
  });

  // Call History Log (metadata only, no call audio/video ever stored)
  app.get('/api/calls/history', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const calls = (store.state.callLogs ?? [])
      .filter((c) => c.participantIds.includes(user.id))
      .slice(-50)
      .reverse()
      .map((c) => {
        const peerId = c.participantIds.find((id) => id !== user.id) ?? c.callerId;
        const peer = store.state.users[peerId];
        return {
          ...c,
          direction: c.callerId === user.id ? 'outgoing' : 'incoming',
          peerDisplayName: peer?.displayName ?? 'Private Contact',
          peerUsername: peer?.username ?? 'unknown',
        };
      });
    res.json({ calls });
  });

  app.post('/api/calls/log', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const { roomId, callMode, status, durationSeconds } = req.body ?? {};
    const room = store.state.rooms[String(roomId ?? '')];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    const entry: CallLogEntry = {
      id: crypto.randomUUID(),
      roomId: room.id,
      participantIds: [...room.memberIds],
      callerId: user.id,
      callMode: callMode === 'video' ? 'video' : 'audio',
      status: ['completed', 'missed', 'declined', 'canceled'].includes(status) ? status : 'completed',
      durationSeconds: Math.max(0, Math.round(Number(durationSeconds) || 0)),
      createdAt: Date.now(),
    };
    if (!store.state.callLogs) store.state.callLogs = [];
    store.state.callLogs.push(entry);
    store.schedulePersist();
    res.status(201).json({ entry });
  });

  // RR AI Assistant (Opt-In Only; requires explicit user consent flag)
  app.post('/api/ai/assist', requireAuth, async (req: AuthedRequest, res) => {
    const { consentGranted, mode, text, messages, targetLang, tone, voiceName } = req.body ?? {};
    if (consentGranted !== true) {
      res.status(400).json({
        error: 'Explicit user consent is required before sending decrypted text to RR AI Assistant.',
      });
      return;
    }
    try {
      const result = await runAIAssistant(mode as AIAssistMode, { text, messages, targetLang, tone, voiceName });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'RR AI Assistant request failed.' });
    }
  });

  app.post('/api/ai/transcribe', requireAuth, async (req: AuthedRequest, res) => {
    const { consentGranted, audioBase64, mimeType } = req.body ?? {};
    if (consentGranted !== true) {
      res.status(400).json({
        error: 'Explicit user consent is required before sending voice audio for transcription.',
      });
      return;
    }
    try {
      const result = await transcribeAudioWithGemini(String(audioBase64 ?? ''), String(mimeType ?? 'audio/webm'));
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Voice-to-text transcription failed.' });
    }
  });

  // Admin & Moderation Dashboard (Strictly Metadata & Abuse Reports — Zero E2EE Message Access)
  app.get('/api/admin/overview', requireAuth, (_req: AuthedRequest, res) => {
    const allUsers = Object.values(store.state.users);
    const allRooms = Object.values(store.state.rooms);
    const totalEncryptedMessages = Object.values(store.state.messages).reduce((sum, list) => sum + list.length, 0);
    const activeSocketsCount = Array.from(userSockets.values()).reduce((sum, set) => sum + set.size, 0);

    const reports = store.state.reports
      .slice()
      .reverse()
      .map((r) => ({
        id: r.id,
        reporterUsername: store.state.users[r.reporterId]?.username ?? 'unknown',
        targetId: r.targetId,
        targetUsername: store.state.users[r.targetId]?.username ?? 'unknown',
        targetSuspended: Boolean(store.state.users[r.targetId]?.suspended),
        reason: r.reason,
        resolved: Boolean(r.resolved),
        createdAt: r.createdAt,
      }));

    const recentSecurityEvents = store.state.loginAlerts.slice(0, 20).map((a) => ({
      id: a.id,
      username: store.state.users[a.userId]?.username ?? 'unknown',
      eventType: a.eventType,
      platform: a.platform,
      ipMasked: a.ipMasked,
      timestamp: a.timestamp,
    }));

    const usersDirectory = allUsers.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      suspended: u.suspended,
      totpEnabled: u.totpEnabled,
      createdAt: u.createdAt,
      deviceCount: Object.values(store.state.devices).filter((d) => d.userId === u.id && d.revokedAt === null).length,
    }));

    res.json({
      health: {
        status: 'healthy',
        uptimeSeconds: Math.round(process.uptime()),
        totalUsers: allUsers.length,
        suspendedUsers: allUsers.filter((u) => u.suspended).length,
        activeWebSockets: activeSocketsCount,
        encryptedRooms: allRooms.length,
        opaqueCiphertextBlobs: totalEncryptedMessages,
        openReports: reports.filter((r) => !r.resolved).length,
      },
      reports,
      recentSecurityEvents,
      usersDirectory,
      cryptographicBoundary:
        'Administrators cannot access private keys, room keys, or decrypted message plaintext. Only abuse metadata and system health metrics are visible.',
    });
  });

  app.post('/api/admin/reports/:reportId/resolve', requireAuth, (req: AuthedRequest, res) => {
    const target = store.state.reports.find((r) => r.id === req.params.reportId);
    if (!target) {
      res.status(404).json({ error: 'Report not found.' });
      return;
    }
    target.resolved = true;
    target.resolvedAt = Date.now();
    store.schedulePersist();
    res.json({ resolved: true });
  });

  app.post('/api/admin/users/:targetUserId/moderate', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const target = store.state.users[req.params.targetUserId];
    if (!target || target.id === user.id) {
      res.status(400).json({ error: 'Select another valid user account to moderate.' });
      return;
    }
    const suspend = Boolean(req.body?.suspend);
    target.suspended = suspend;
    target.suspensionReason = suspend ? String(req.body?.reason ?? 'Moderated for abuse report').slice(0, 120) : null;
    if (suspend) {
      for (const s of Object.values(store.state.sessions)) {
        if (s.userId === target.id) s.revoked = true;
      }
      for (const d of Object.values(store.state.devices)) {
        if (d.userId === target.id) disconnectDeviceSockets(target.id, d.deviceId, 'Account suspended by moderation');
      }
    }
    store.schedulePersist();
    res.json({ userId: target.id, suspended: target.suspended });
  });

  // RR Vault Personal Encrypted File / Photo / Video / Document Locker
  app.get('/api/vault/items', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const items = (store.state.vaultItems ?? [])
      .filter((item) => item.userId === user.id)
      .slice()
      .reverse();
    res.json({ items });
  });

  app.post('/api/vault/items', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const body = req.body ?? {};
    if ('plaintext' in body || 'filename' in body || 'content' in body || 'data' in body || 'title' in body) {
      res.status(400).json({ error: 'Plaintext vault payloads are strictly rejected. Encrypt files client-side first.' });
      return;
    }
    const { kind, ciphertextB64, ivB64, metaEncB64, metaIvB64, sizeBytes } = body;
    if (!ciphertextB64 || !ivB64 || !metaEncB64 || !metaIvB64) {
      res.status(400).json({ error: 'Encrypted ciphertextB64, ivB64, metaEncB64, and metaIvB64 are required.' });
      return;
    }
    const numericSize = Math.max(1, Math.min(20 * 1024 * 1024, Number(sizeBytes) || 0));
    if (numericSize > 16 * 1024 * 1024) {
      res.status(400).json({ error: 'Encrypted vault file exceeds 16MB limit.' });
      return;
    }
    const item = {
      id: crypto.randomUUID(),
      userId: user.id,
      kind: (['photo', 'video', 'file', 'doc'].includes(String(kind)) ? kind : 'file') as
        | 'photo'
        | 'video'
        | 'file'
        | 'doc',
      ciphertextB64: String(ciphertextB64),
      ivB64: String(ivB64),
      metaEncB64: String(metaEncB64),
      metaIvB64: String(metaIvB64),
      sizeBytes: numericSize,
      createdAt: Date.now(),
    };
    store.state.vaultItems.push(item);
    store.schedulePersist();
    res.status(201).json({ item });
  });

  app.delete('/api/vault/items/:itemId', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const before = store.state.vaultItems.length;
    store.state.vaultItems = store.state.vaultItems.filter(
      (i) => !(i.id === req.params.itemId && i.userId === user.id)
    );
    if (store.state.vaultItems.length === before) {
      res.status(404).json({ error: 'Vault item not found.' });
      return;
    }
    store.schedulePersist();
    res.json({ deleted: true });
  });

  // Scheduled E2EE Messages & Message Recall
  app.get('/api/rooms/:roomId/scheduled', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    const items = store.state.scheduledMessages.filter(
      (s) => s.roomId === room.id && s.senderId === user.id
    );
    res.json({ scheduled: items });
  });

  app.post('/api/rooms/:roomId/scheduled', requireAuth, (req: AuthedRequest, res) => {
    const { user, device } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    const body = req.body ?? {};
    if ('plaintext' in body || 'body' in body || 'text' in body || 'message' in body) {
      res.status(400).json({ error: 'Plaintext scheduled messages are strictly rejected. Encrypt client-side.' });
      return;
    }
    const { ciphertextB64, ivB64, deliverAt, kind } = body;
    if (!ciphertextB64 || !ivB64 || typeof deliverAt !== 'number') {
      res.status(400).json({ error: 'Encrypted ciphertextB64, ivB64, and numeric deliverAt are required.' });
      return;
    }
    const clampedDeliverAt = Math.min(Date.now() + 30 * 24 * 3600 * 1000, Math.max(Date.now(), deliverAt));
    const item = {
      id: crypto.randomUUID(),
      roomId: room.id,
      senderId: user.id,
      senderDeviceId: device.deviceId,
      kind: (kind === 'sticker' ? 'sticker' : 'text') as 'text' | 'sticker',
      ciphertextB64: String(ciphertextB64),
      ivB64: String(ivB64),
      deliverAt: clampedDeliverAt,
      createdAt: Date.now(),
    };
    store.state.scheduledMessages.push(item);
    store.schedulePersist();
    res.status(201).json({ scheduled: item });
  });

  app.delete('/api/rooms/:roomId/scheduled/:scheduleId', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const before = store.state.scheduledMessages.length;
    store.state.scheduledMessages = store.state.scheduledMessages.filter(
      (s) => !(s.id === req.params.scheduleId && s.roomId === req.params.roomId && s.senderId === user.id)
    );
    if (store.state.scheduledMessages.length === before) {
      res.status(404).json({ error: 'Scheduled message not found.' });
      return;
    }
    store.schedulePersist();
    res.json({ canceled: true });
  });

  app.post('/api/rooms/:roomId/messages/:messageId/recall', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.rooms[req.params.roomId];
    if (!room || !room.memberIds.includes(user.id)) {
      res.status(404).json({ error: 'Room not found.' });
      return;
    }
    const msgs = store.state.messages[room.id] ?? [];
    const target = msgs.find((m) => m.id === req.params.messageId);
    if (!target || target.senderId !== user.id) {
      res.status(403).json({ error: 'You can only recall your own messages.' });
      return;
    }
    target.deleted = true;
    target.recalledAt = Date.now();
    target.ciphertextB64 = '';
    target.ivB64 = '';
    delete target.attachmentCiphertextB64;
    delete target.attachmentIvB64;
    delete target.attachmentMetaEncB64;
    delete target.attachmentMetaIvB64;
    store.schedulePersist();
    sendToRoom(room, 'message:recalled', { roomId: room.id, messageId: target.id, recalledAt: target.recalledAt });
    res.json({ recalled: true, messageId: target.id, recalledAt: target.recalledAt });
  });

  // Custom 3D Animated Sticker Pack
  app.put('/api/profile/stickers', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const rawPack = Array.isArray(req.body?.stickerPack) ? req.body.stickerPack : [];
    const cleaned: Sticker3DItem[] = rawPack.slice(0, 24).map((s: Partial<Sticker3DItem>) => ({
      id: typeof s.id === 'string' && s.id ? s.id.slice(0, 48) : crypto.randomUUID(),
      name: String(s.name ?? 'Custom 3D Sticker').slice(0, 32),
      shape: ['cube', 'torus', 'prism', 'star'].includes(String(s.shape))
        ? (s.shape as Sticker3DItem['shape'])
        : 'prism',
      color: typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : '#A855F7',
      glowColor: typeof s.glowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.glowColor) ? s.glowColor : '#E2E8F0',
      animation: ['spin', 'bounce', 'pulse', 'orbit'].includes(String(s.animation))
        ? (s.animation as Sticker3DItem['animation'])
        : 'orbit',
      label: String(s.label ?? 'RR 3D').slice(0, 20),
      createdAt: Number(s.createdAt) || Date.now(),
    }));
    user.stickerPack = cleaned;
    store.schedulePersist();
    res.json({ stickerPack: user.stickerPack });
  });

  // 26-Feature Switchboard & Advanced Security Toggles
  app.put('/api/features', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const b = req.body ?? {};
    if (b.featureSelection && typeof b.featureSelection === 'object') {
      const next = { ...(user.featureSelection ?? createDefaultFeatureSelection()) };
      for (const id of ALL_26_FEATURE_IDS) {
        if (id in b.featureSelection) {
          next[id] = Boolean((b.featureSelection as Record<string, unknown>)[id]);
        }
      }
      user.featureSelection = next;
    }
    if (typeof b.screenshotPrivacy === 'boolean') user.screenshotPrivacy = b.screenshotPrivacy;
    if (typeof b.phishingProtection === 'boolean') user.phishingProtection = b.phishingProtection;
    if (typeof b.nearbyDiscoveryEnabled === 'boolean') user.nearbyDiscoveryEnabled = b.nearbyDiscoveryEnabled;
    if (typeof b.nearbyZoneLabel === 'string') user.nearbyZoneLabel = b.nearbyZoneLabel.trim().slice(0, 40);
    if (['crystal', 'pulse', 'chime', 'silent'].includes(String(b.customSound))) {
      user.notificationSettings.customSound = b.customSound;
    }
    store.schedulePersist();
    res.json({ user: serializeUser(user) });
  });

  // RR Shield Security Score (real deterministic breakdown from user security controls)
  app.get('/api/shield/score', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const activeDevices = Object.values(store.state.devices).filter((d) => d.userId === user.id && d.revokedAt === null);
    const allVerified = activeDevices.length > 0 && activeDevices.every((d) => d.verifiedByUser);
    const hasBackup = Boolean(store.state.keyBackups[user.id]);
    const checks = [
      { id: '2fa', label: 'Two-Factor Authentication (TOTP)', passed: user.totpEnabled, weight: 20 },
      { id: 'vault_pin', label: 'Private Vault PIN', passed: Boolean(user.vaultPinHash), weight: 15 },
      { id: 'duress_pin', label: 'Duress PIN Configured', passed: Boolean(user.duressPinHash), weight: 15 },
      { id: 'device_verify', label: 'All Active Devices Cryptographically Verified', passed: allVerified, weight: 15 },
      { id: 'key_backup', label: 'Zero-Knowledge Encrypted Key Backup', passed: hasBackup, weight: 10 },
      { id: 'privacy_shield', label: 'Notification Preview & Presence Shield', passed: user.privacySettings.hideNotificationPreviews && user.privacySettings.hideOnlinePresence, weight: 10 },
      { id: 'phishing', label: 'Phishing & Suspicious Link Protection', passed: user.phishingProtection ?? true, weight: 8 },
      { id: 'screenshot', label: 'Screenshot & Print Privacy Shield', passed: user.screenshotPrivacy ?? true, weight: 7 },
    ];
    const score = checks.reduce((acc, c) => acc + (c.passed ? c.weight : 0), 0);
    res.json({ score, maxScore: 100, checks });
  });

  // Social Hub Endpoints (24h Stories, Private Communities & Username Channels, Voice Rooms & Live Streaming, Polls, Friend Activity, Opt-in Nearby Discovery)
  app.get('/api/social/feed', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    store.purgeExpiredMessages();
    const now = Date.now();
    const stories = store.state.stories
      .filter((s) => s.expiresAt > now && !store.isBlocked(user.id, s.userId))
      .slice()
      .reverse()
      .map((s) => {
        const author = store.state.users[s.userId];
        return {
          ...s,
          authorUsername: author?.username ?? 'unknown',
          authorDisplayName: author?.displayName ?? 'Private User',
        };
      });

    const channels = store.state.channels.map((ch) => {
      const owner = store.state.users[ch.ownerId];
      return {
        ...ch,
        ownerUsername: owner?.username ?? 'unknown',
        subscriberCount: ch.subscriberIds.length,
        isSubscribed: ch.subscriberIds.includes(user.id),
      };
    });

    const voiceRooms = store.state.voiceRooms.slice().reverse();
    const polls = store.state.polls.slice().reverse();
    const activities = store.state.friendActivities
      .filter((a) => !store.isBlocked(user.id, a.userId))
      .slice(0, 25);

    const nearbyUsers = user.nearbyDiscoveryEnabled
      ? Object.values(store.state.users)
          .filter((u) => u.id !== user.id && !u.suspended && u.nearbyDiscoveryEnabled && !store.isBlocked(user.id, u.id))
          .map((u) => ({
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            zoneLabel: u.nearbyZoneLabel || 'Local Zone',
            badge: u.identity3D?.badge ?? 'none',
          }))
      : [];

    res.json({ stories, channels, voiceRooms, polls, activities, nearbyUsers });
  });

  app.post('/api/social/stories', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const text = String(req.body?.text ?? '').trim().slice(0, 240);
    if (!text) {
      res.status(400).json({ error: 'Story text is required.' });
      return;
    }
    const theme = ['obsidian_purple', 'chrome_silver', 'neon_violet'].includes(String(req.body?.theme))
      ? (req.body.theme as 'obsidian_purple' | 'chrome_silver' | 'neon_violet')
      : 'obsidian_purple';
    const story = {
      id: crypto.randomUUID(),
      userId: user.id,
      text,
      theme,
      viewedBy: [user.id],
      reactions: {},
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600 * 1000,
    };
    store.state.stories.push(story);
    if (!user.privacySettings.hideOnlinePresence) {
      store.state.friendActivities.unshift({
        id: crypto.randomUUID(),
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        action: 'shared a 24-hour encrypted status story',
        createdAt: Date.now(),
      });
    }
    store.schedulePersist();
    broadcastSocialUpdate('stories');
    res.status(201).json({ story });
  });

  app.post('/api/social/stories/:storyId/react', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const emoji = String(req.body?.emoji ?? '🔥').slice(0, 8);
    const story = store.state.stories.find((s) => s.id === req.params.storyId);
    if (!story) {
      res.status(404).json({ error: 'Story not found or expired.' });
      return;
    }
    if (!story.viewedBy.includes(user.id)) story.viewedBy.push(user.id);
    const list = story.reactions[emoji] ?? [];
    story.reactions[emoji] = list.includes(user.id) ? list.filter((id) => id !== user.id) : [...list, user.id];
    store.schedulePersist();
    broadcastSocialUpdate('stories');
    res.json({ story });
  });

  app.post('/api/social/channels', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const rawHandle = String(req.body?.handle ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 28);
    const title = String(req.body?.title ?? '').trim().slice(0, 64);
    const description = String(req.body?.description ?? '').trim().slice(0, 180);
    if (!rawHandle || !title) {
      res.status(400).json({ error: 'Channel @handle and title are required.' });
      return;
    }
    if (store.state.channels.some((c) => c.handle === rawHandle)) {
      res.status(409).json({ error: 'Channel @handle already taken.' });
      return;
    }
    const channel = {
      id: crypto.randomUUID(),
      handle: rawHandle,
      title,
      description,
      ownerId: user.id,
      isPrivateCommunity: Boolean(req.body?.isPrivateCommunity),
      subscriberIds: [user.id],
      posts: [],
      createdAt: Date.now(),
    };
    store.state.channels.push(channel);
    store.schedulePersist();
    broadcastSocialUpdate('channels');
    res.status(201).json({ channel });
  });

  app.post('/api/social/channels/:channelId/subscribe', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const channel = store.state.channels.find((c) => c.id === req.params.channelId);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found.' });
      return;
    }
    const exists = channel.subscriberIds.includes(user.id);
    channel.subscriberIds = exists
      ? channel.subscriberIds.filter((id) => id !== user.id)
      : [...channel.subscriberIds, user.id];
    store.schedulePersist();
    broadcastSocialUpdate('channels');
    res.json({ isSubscribed: !exists, subscriberCount: channel.subscriberIds.length });
  });

  app.post('/api/social/channels/:channelId/posts', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const channel = store.state.channels.find((c) => c.id === req.params.channelId);
    if (!channel || channel.ownerId !== user.id) {
      res.status(403).json({ error: 'Only the channel owner can publish broadcasts.' });
      return;
    }
    const text = String(req.body?.text ?? '').trim().slice(0, 500);
    if (!text) {
      res.status(400).json({ error: 'Post content required.' });
      return;
    }
    const post = { id: crypto.randomUUID(), authorId: user.id, text, createdAt: Date.now() };
    channel.posts.unshift(post);
    store.schedulePersist();
    broadcastSocialUpdate('channels');
    res.status(201).json({ post });
  });

  app.post('/api/social/voice-rooms', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const title = String(req.body?.title ?? '').trim().slice(0, 64);
    const topic = String(req.body?.topic ?? '').trim().slice(0, 120);
    if (!title) {
      res.status(400).json({ error: 'Voice room or stream title required.' });
      return;
    }
    const room = {
      id: crypto.randomUUID(),
      title,
      topic: topic || 'Open Private Audio / Stream',
      hostId: user.id,
      isLiveStream: Boolean(req.body?.isLiveStream),
      participants: [
        { userId: user.id, username: user.username, displayName: user.displayName, muted: false, handRaised: false },
      ],
      liveComments: [],
      createdAt: Date.now(),
    };
    store.state.voiceRooms.push(room);
    store.schedulePersist();
    broadcastSocialUpdate('voiceRooms');
    res.status(201).json({ voiceRoom: room });
  });

  app.post('/api/social/voice-rooms/:roomId/join', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.voiceRooms.find((v) => v.id === req.params.roomId);
    if (!room) {
      res.status(404).json({ error: 'Voice room not found.' });
      return;
    }
    if (!room.participants.some((p) => p.userId === user.id)) {
      room.participants.push({
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        muted: true,
        handRaised: false,
      });
      store.schedulePersist();
      broadcastSocialUpdate('voiceRooms');
    }
    res.json({ voiceRoom: room });
  });

  app.post('/api/social/voice-rooms/:roomId/leave', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.voiceRooms.find((v) => v.id === req.params.roomId);
    if (!room) {
      res.status(404).json({ error: 'Voice room not found.' });
      return;
    }
    room.participants = room.participants.filter((p) => p.userId !== user.id);
    store.schedulePersist();
    broadcastSocialUpdate('voiceRooms');
    res.json({ left: true });
  });

  app.post('/api/social/voice-rooms/:roomId/toggle-mute', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.voiceRooms.find((v) => v.id === req.params.roomId);
    if (!room) {
      res.status(404).json({ error: 'Voice room not found.' });
      return;
    }
    const p = room.participants.find((item) => item.userId === user.id);
    if (p) {
      p.muted = !p.muted;
      store.schedulePersist();
      broadcastSocialUpdate('voiceRooms');
    }
    res.json({ voiceRoom: room });
  });

  app.post('/api/social/voice-rooms/:roomId/comment', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const room = store.state.voiceRooms.find((v) => v.id === req.params.roomId);
    if (!room) {
      res.status(404).json({ error: 'Voice room not found.' });
      return;
    }
    const text = String(req.body?.text ?? '').trim().slice(0, 180);
    if (!text) {
      res.status(400).json({ error: 'Comment text required.' });
      return;
    }
    room.liveComments.push({ id: crypto.randomUUID(), username: user.username, text, createdAt: Date.now() });
    if (room.liveComments.length > 50) room.liveComments.shift();
    store.schedulePersist();
    broadcastSocialUpdate('voiceRooms');
    res.status(201).json({ voiceRoom: room });
  });

  app.post('/api/social/polls', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const question = String(req.body?.question ?? '').trim().slice(0, 140);
    const rawOptions = Array.isArray(req.body?.options) ? req.body.options : [];
    const options = rawOptions
      .map((o: unknown) => String(o).trim().slice(0, 64))
      .filter(Boolean)
      .slice(0, 6)
      .map((label: string) => ({ id: crypto.randomUUID(), label, voterIds: [] as string[] }));
    if (!question || options.length < 2) {
      res.status(400).json({ error: 'Poll question and at least 2 options are required.' });
      return;
    }
    const poll = {
      id: crypto.randomUUID(),
      question,
      options,
      creatorId: user.id,
      createdAt: Date.now(),
    };
    store.state.polls.push(poll);
    store.schedulePersist();
    broadcastSocialUpdate('polls');
    res.status(201).json({ poll });
  });

  app.post('/api/social/polls/:pollId/vote', requireAuth, (req: AuthedRequest, res) => {
    const { user } = req.auth!;
    const poll = store.state.polls.find((p) => p.id === req.params.pollId);
    const optionId = String(req.body?.optionId ?? '');
    if (!poll || !poll.options.some((o) => o.id === optionId)) {
      res.status(404).json({ error: 'Poll or option not found.' });
      return;
    }
    for (const opt of poll.options) {
      opt.voterIds = opt.voterIds.filter((id) => id !== user.id);
      if (opt.id === optionId) opt.voterIds.push(user.id);
    }
    store.schedulePersist();
    broadcastSocialUpdate('polls');
    res.json({ poll });
  });

  return {
    app,
    server,
    wss,
    store,
    close: () => {
      clearInterval(expiryInterval);
      wss.close();
      server.close();
    },
  };
}
