import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createRRChatBackend } from '../backend/app.ts';
import { computeTotpCode, hashPasswordArgon2id } from '../backend/security.ts';
import { createDefaultFeatureSelection, DEFAULT_IDENTITY_3D, DEFAULT_STICKER_PACK } from '../backend/store.ts';

async function makeKeyPair() {
  const ecdh = crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const id = crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const [ecdhPair, idPair] = await Promise.all([ecdh, id]);
  const ecdhPubJwk = await crypto.webcrypto.subtle.exportKey('jwk', ecdhPair.publicKey);
  const idPubJwk = await crypto.webcrypto.subtle.exportKey('jwk', idPair.publicKey);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ecdhPubJwk, idPubJwk })).digest('hex').slice(0, 32);
  return { ecdhPair, idPair, ecdhPubJwk, idPubJwk, fingerprint };
}

function connectWs(wsUrl: string): Promise<{ ws: WebSocket; events: Array<{ event: string; payload: unknown }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const events: Array<{ event: string; payload: unknown }> = [];
    const timer = setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as { event: string; payload: unknown };
        events.push(parsed);
        if (parsed.event === 'session:connected') {
          clearTimeout(timer);
          resolve({ ws, events });
        }
      } catch {
        // ignore
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForEvent(
  events: Array<{ event: string; payload: any }>,
  eventName: string,
  predicate?: (payload: any) => boolean,
  timeoutMs = 3000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find((e) => e.event === eventName && (!predicate || predicate(e.payload)));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for WS event "${eventName}"`);
}

test('E2E 1: OAuth origin derivation, OAuth-only 2FA disable, and /api/security/unlock (local, Vault PIN, Duress PIN, OAuth)', async () => {
  const prevAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'MY_APP_URL';

  const backend = createRRChatBackend({
    storePath: null,
    argon2Options: { m: 1024, t: 1, p: 1 },
  });

  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const addr = backend.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. OAuth provider list derives origin from forwarded headers when APP_URL is placeholder
    const providersRes = await fetch(`${baseUrl}/api/auth/oauth/providers`, {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'rrchat-preview.example.com',
      },
    });
    assert.equal(providersRes.status, 200);
    const providersJson = (await providersRes.json()) as {
      providers: Array<{ provider: string; redirectUri?: string; mode: string }>;
    };
    const fb = providersJson.providers.find((p) => p.provider === 'facebook');
    const gh = providersJson.providers.find((p) => p.provider === 'github');
    const dc = providersJson.providers.find((p) => p.provider === 'discord');
    assert.equal(fb?.redirectUri, 'https://rrchat-preview.example.com/auth/oauth/facebook/callback');
    assert.equal(gh?.redirectUri, 'https://rrchat-preview.example.com/auth/oauth/github/callback');
    assert.equal(dc?.redirectUri, 'https://rrchat-preview.example.com/auth/oauth/discord/callback');

    // Invalid OAuth exchange code rejected
    const badExchange = await fetch(`${baseUrl}/api/auth/oauth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'github', exchangeCode: 'invalid-code-123' }),
    });
    assert.equal(badExchange.status, 401);

    // 2. Local account: test Vault PIN, Duress PIN, and password unlock via /api/security/unlock
    const k1 = await makeKeyPair();
    const regLocal = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'unlock_alice',
        password: 'Strong!Password#401',
        identityPubKeyJwk: k1.idPubJwk,
        ecdhPubKeyJwk: k1.ecdhPubJwk,
        fingerprint: k1.fingerprint,
      }),
    });
    assert.equal(regLocal.status, 201);
    const localData = (await regLocal.json()) as { token: string; user: { id: string } };

    // Secondary login session to confirm wipe_and_decoy revokes other devices during unlock
    const secLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'unlock_alice',
        password: 'Strong!Password#401',
        deviceName: 'Secondary Laptop',
        platform: 'Windows',
        identityPubKeyJwk: k1.idPubJwk,
        ecdhPubKeyJwk: k1.ecdhPubJwk,
        fingerprint: `${k1.fingerprint}-sec`,
      }),
    });
    assert.equal(secLogin.status, 200);
    const secData = (await secLogin.json()) as { token: string };

    // Wrong password rejected
    const badUnlock = await fetch(`${baseUrl}/api/security/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localData.token}` },
      body: JSON.stringify({ secret: 'Wrong!Password1' }),
    });
    assert.equal(badUnlock.status, 401);

    // Password unlock works when no Vault PIN is set
    const passUnlock = await fetch(`${baseUrl}/api/security/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localData.token}` },
      body: JSON.stringify({ secret: 'Strong!Password#401' }),
    });
    assert.equal(passUnlock.status, 200);
    const passUnlockJson = (await passUnlock.json()) as { unlocked: boolean; duressTriggered: boolean };
    assert.equal(passUnlockJson.unlocked, true);
    assert.equal(passUnlockJson.duressTriggered, false);

    // Set Vault PIN + Duress PIN and verify both through /api/security/unlock
    await fetch(`${baseUrl}/api/vault/pin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localData.token}` },
      body: JSON.stringify({ pin: '2468' }),
    });
    await fetch(`${baseUrl}/api/vault/duress-pin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localData.token}` },
      body: JSON.stringify({ pin: '9753', behavior: 'wipe_and_decoy' }),
    });

    const vaultUnlock = await fetch(`${baseUrl}/api/security/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localData.token}` },
      body: JSON.stringify({ secret: '2468' }),
    });
    assert.equal(vaultUnlock.status, 200);
    assert.equal(((await vaultUnlock.json()) as { duressTriggered: boolean }).duressTriggered, false);

    const duressUnlock = await fetch(`${baseUrl}/api/security/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localData.token}` },
      body: JSON.stringify({ secret: '9753' }),
    });
    assert.equal(duressUnlock.status, 200);
    const duressUnlockJson = (await duressUnlock.json()) as { unlocked: boolean; duressTriggered: boolean; duressBehavior: string };
    assert.equal(duressUnlockJson.unlocked, true);
    assert.equal(duressUnlockJson.duressTriggered, true);
    assert.equal(duressUnlockJson.duressBehavior, 'wipe_and_decoy');

    // Secondary session must be revoked after duress unlock
    const secAfterDuress = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${secData.token}` },
    });
    assert.equal(secAfterDuress.status, 401);

    // 3. OAuth-only user: 2FA enable/disable & /api/security/unlock without password
    const oauthUserId = crypto.randomUUID();
    const oauthDeviceId = crypto.randomUUID();
    const oauthToken = `oauth_tok_${crypto.randomBytes(16).toString('hex')}`;
    const oauthTokenHash = crypto.createHash('sha256').update(oauthToken).digest('hex');

    backend.store.state.users[oauthUserId] = {
      id: oauthUserId,
      username: 'oauth_google_user',
      displayName: 'OAuth Google User',
      bio: '',
      authProvider: 'google',
      linkedProviders: ['google'],
      contactNumberMasked: null,
      contactNumberHash: null,
      gamingConnection: {
        platform: '',
        gamertag: '',
        discordUsername: '',
        discordInviteCode: '',
        discordConnectedViaOAuth: false,
        visibility: 'private',
      },
      walletBalanceCents: 0,
      vaultPinHash: null,
      duressPinHash: null,
      duressBehavior: 'decoy_screen',
      identity3D: { ...DEFAULT_IDENTITY_3D },
      screenshotPrivacy: true,
      phishingProtection: true,
      nearbyDiscoveryEnabled: false,
      nearbyZoneLabel: '',
      featureSelection: createDefaultFeatureSelection(),
      stickerPack: DEFAULT_STICKER_PACK.map((s) => ({ ...s })),
      passwordHash: `!oauth!${crypto.randomBytes(16).toString('hex')}`,
      totpEnabled: false,
      totpSecret: null,
      recoveryCodeHashes: [await hashPasswordArgon2id('RECOVERY-1234', { m: 1024, t: 1, p: 1 })],
      suspended: false,
      suspensionReason: null,
      privacySettings: {
        discoverableByUsername: true,
        sendReadReceipts: true,
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
    backend.store.state.usernameIndex['oauth_google_user'] = oauthUserId;
    backend.store.state.oauthIndex['google:sub-123'] = oauthUserId;
    backend.store.state.devices[oauthDeviceId] = {
      deviceId: oauthDeviceId,
      userId: oauthUserId,
      deviceName: 'Chrome Web',
      platform: 'Web',
      identityPubKeyJwk: k1.idPubJwk,
      ecdhPubKeyJwk: k1.ecdhPubJwk,
      fingerprint: 'oauth-fp',
      verifiedByUser: true,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revokedAt: null,
    };
    backend.store.state.sessions[oauthTokenHash] = {
      tokenHash: oauthTokenHash,
      userId: oauthUserId,
      deviceId: oauthDeviceId,
      ipMasked: '127.0.0.x',
      userAgent: 'Test',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      revoked: false,
    };

    // OAuth unlock rejects wrong phrase, accepts UNLOCK & username
    const oauthBadUnlock = await fetch(`${baseUrl}/api/security/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oauthToken}` },
      body: JSON.stringify({ secret: 'wrong-phrase' }),
    });
    assert.equal(oauthBadUnlock.status, 401);

    const oauthGoodUnlock = await fetch(`${baseUrl}/api/security/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oauthToken}` },
      body: JSON.stringify({ secret: 'UNLOCK' }),
    });
    assert.equal(oauthGoodUnlock.status, 200);
    assert.equal(((await oauthGoodUnlock.json()) as { unlocked: boolean }).unlocked, true);

    // Setup, verify, and disable 2FA on OAuth-only account using TOTP code or DISABLE
    const setup2fa = await fetch(`${baseUrl}/api/auth/2fa/setup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${oauthToken}` },
    });
    assert.equal(setup2fa.status, 200);
    const { secret: totpSecret } = (await setup2fa.json()) as { secret: string };

    const totpCode = computeTotpCode(totpSecret, Date.now());
    const verify2fa = await fetch(`${baseUrl}/api/auth/2fa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oauthToken}` },
      body: JSON.stringify({ code: totpCode }),
    });
    assert.equal(verify2fa.status, 200);

    const failDisable = await fetch(`${baseUrl}/api/auth/2fa/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oauthToken}` },
      body: JSON.stringify({ password: 'not-valid-confirmation' }),
    });
    assert.equal(failDisable.status, 401);

    const okDisable = await fetch(`${baseUrl}/api/auth/2fa/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oauthToken}` },
      body: JSON.stringify({ password: 'DISABLE' }),
    });
    assert.equal(okDisable.status, 200);
    assert.equal(((await okDisable.json()) as { totpEnabled: boolean }).totpEnabled, false);
  } finally {
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
    backend.close();
  }
});

test('E2E 2: Real-time WebSocket delivery, encrypted voice notes, reactions, read receipts, edit/recall/delete, voice room mute/unmute, and admin moderation', async () => {
  const backend = createRRChatBackend({
    storePath: null,
    argon2Options: { m: 1024, t: 1, p: 1 },
  });

  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const addr = backend.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsBaseUrl = `ws://127.0.0.1:${port}`;

  let wsAlice: WebSocket | undefined;
  let wsBob: WebSocket | undefined;

  try {
    const k1 = await makeKeyPair();
    const k2 = await makeKeyPair();

    const r1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'rt_alice',
        password: 'Strong!Password#501',
        identityPubKeyJwk: k1.idPubJwk,
        ecdhPubKeyJwk: k1.ecdhPubJwk,
        fingerprint: k1.fingerprint,
      }),
    });
    const d1 = (await r1.json()) as { token: string; deviceId: string; user: { id: string } };

    const r2 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'rt_bob',
        password: 'Strong!Password#502',
        identityPubKeyJwk: k2.idPubJwk,
        ecdhPubKeyJwk: k2.ecdhPubJwk,
        fingerprint: k2.fingerprint,
      }),
    });
    const d2 = (await r2.json()) as { token: string; deviceId: string; user: { id: string } };

    // Enable read receipts for Bob
    await fetch(`${baseUrl}/api/privacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d2.token}` },
      body: JSON.stringify({ sendReadReceipts: true }),
    });

    // Reject invalid WebSocket token with close code 4003
    await new Promise<void>((resolve, reject) => {
      const badWs = new WebSocket(`${wsBaseUrl}/ws?token=invalid_token_xyz`);
      const timer = setTimeout(() => reject(new Error('Expected unauthorized WS to close')), 3000);
      badWs.on('close', (code) => {
        clearTimeout(timer);
        assert.equal(code, 4003);
        resolve();
      });
    });

    // Connect valid WebSockets for Alice and Bob
    const aliceConn = await connectWs(`${wsBaseUrl}/ws?token=${encodeURIComponent(d1.token)}`);
    const bobConn = await connectWs(`${wsBaseUrl}/ws?token=${encodeURIComponent(d2.token)}`);
    wsAlice = aliceConn.ws;
    wsBob = bobConn.ws;

    // Create 1:1 room
    const roomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        type: 'direct',
        memberIds: [d2.user.id],
        encryptedRoomKeys: {
          [d1.deviceId]: { senderDeviceId: d1.deviceId, senderEcdhPubJwk: k1.ecdhPubJwk, ivB64: 'iv1', wrappedKeyB64: 'wk1' },
          [d2.deviceId]: { senderDeviceId: d1.deviceId, senderEcdhPubJwk: k1.ecdhPubJwk, ivB64: 'iv2', wrappedKeyB64: 'wk2' },
        },
      }),
    });
    assert.equal(roomRes.status, 201);
    const { room } = (await roomRes.json()) as { room: { id: string } };
    await waitForEvent(bobConn.events, 'room:updated', (p) => p?.id === room.id);

    // Send encrypted voice note (kind: 'voice') with encrypted attachment metadata & bytes
    const voiceRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        kind: 'voice',
        ciphertextB64: Buffer.from('enc-voice-caption').toString('base64'),
        ivB64: Buffer.from('123456789012').toString('base64'),
        attachmentCiphertextB64: Buffer.from('enc-ogg-audio-payload').toString('base64'),
        attachmentIvB64: Buffer.from('abcdefghijkl').toString('base64'),
        attachmentMetaEncB64: Buffer.from('enc-meta-voice.webm').toString('base64'),
        attachmentMetaIvB64: Buffer.from('mnopqrstuvwx').toString('base64'),
        attachmentMime: 'audio/webm',
        attachmentBytes: 4096,
      }),
    });
    assert.equal(voiceRes.status, 201);
    const { message: voiceMsg } = (await voiceRes.json()) as { message: { id: string; kind: string } };
    assert.equal(voiceMsg.kind, 'voice');
    await waitForEvent(bobConn.events, 'message:new', (p) => p?.id === voiceMsg.id && p?.kind === 'voice');

    // Bob reacts + marks read -> Alice receives WS events
    const reactRes = await fetch(`${baseUrl}/api/messages/${voiceMsg.id}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d2.token}` },
      body: JSON.stringify({ roomId: room.id, emoji: '🎧' }),
    });
    assert.equal(reactRes.status, 200);
    await waitForEvent(aliceConn.events, 'message:reaction', (p) => p?.messageId === voiceMsg.id && p?.reactions?.['🎧']?.includes(d2.user.id));

    const readRes = await fetch(`${baseUrl}/api/rooms/${room.id}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    assert.equal(readRes.status, 200);
    await waitForEvent(aliceConn.events, 'message:read', (p) => p?.roomId === room.id && p?.userId === d2.user.id);

    // Send text message -> Edit -> Recall -> Send second message -> Delete
    const msg2Res = await fetch(`${baseUrl}/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        kind: 'text',
        ciphertextB64: Buffer.from('msg-v1').toString('base64'),
        ivB64: Buffer.from('123456789012').toString('base64'),
      }),
    });
    const { message: textMsg } = (await msg2Res.json()) as { message: { id: string } };

    const editRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages/${textMsg.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        ciphertextB64: Buffer.from('msg-v2-edited').toString('base64'),
        ivB64: Buffer.from('223456789012').toString('base64'),
      }),
    });
    assert.equal(editRes.status, 200);
    await waitForEvent(bobConn.events, 'message:edited', (p) => p?.messageId === textMsg.id);

    const recallRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages/${textMsg.id}/recall`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    assert.equal(recallRes.status, 200);
    await waitForEvent(bobConn.events, 'message:recalled', (p) => p?.messageId === textMsg.id);

    const msg3Res = await fetch(`${baseUrl}/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        kind: 'text',
        ciphertextB64: Buffer.from('msg-to-delete').toString('base64'),
        ivB64: Buffer.from('123456789012').toString('base64'),
      }),
    });
    const { message: delTarget } = (await msg3Res.json()) as { message: { id: string } };

    const delRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages/${delTarget.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    assert.equal(delRes.status, 200);
    await waitForEvent(bobConn.events, 'message:deleted', (p) => p?.messageId === delTarget.id);

    // Social Hub: Voice Room create, Bob joins (default muted: true), toggle-mute twice -> comment -> leave
    const vrCreate = await fetch(`${baseUrl}/api/social/voice-rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ title: 'Zero-Trust Townhall', topic: 'Audio E2E verification', isLiveStream: false }),
    });
    assert.equal(vrCreate.status, 201);
    const { voiceRoom } = (await vrCreate.json()) as { voiceRoom: { id: string } };
    await waitForEvent(bobConn.events, 'social:updated', (p) => p?.kind === 'voiceRooms');

    const vrJoin = await fetch(`${baseUrl}/api/social/voice-rooms/${voiceRoom.id}/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    assert.equal(vrJoin.status, 200);
    const joinedRoom = ((await vrJoin.json()) as { voiceRoom: { participants: Array<{ userId: string; muted: boolean }> } }).voiceRoom;
    assert.equal(joinedRoom.participants.find((p) => p.userId === d2.user.id)?.muted, true);

    // Unmute
    const vrUnmute = await fetch(`${baseUrl}/api/social/voice-rooms/${voiceRoom.id}/toggle-mute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    assert.equal(vrUnmute.status, 200);
    const unmutedRoom = ((await vrUnmute.json()) as { voiceRoom: { participants: Array<{ userId: string; muted: boolean }> } }).voiceRoom;
    assert.equal(unmutedRoom.participants.find((p) => p.userId === d2.user.id)?.muted, false);

    // Mute again
    const vrMute = await fetch(`${baseUrl}/api/social/voice-rooms/${voiceRoom.id}/toggle-mute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    assert.equal(vrMute.status, 200);
    const mutedRoom = ((await vrMute.json()) as { voiceRoom: { participants: Array<{ userId: string; muted: boolean }> } }).voiceRoom;
    assert.equal(mutedRoom.participants.find((p) => p.userId === d2.user.id)?.muted, true);

    // Comment and leave
    const vrComment = await fetch(`${baseUrl}/api/social/voice-rooms/${voiceRoom.id}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d2.token}` },
      body: JSON.stringify({ text: 'Crystal clear mic check!' }),
    });
    assert.equal(vrComment.status, 201);

    const vrLeave = await fetch(`${baseUrl}/api/social/voice-rooms/${voiceRoom.id}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    assert.equal(vrLeave.status, 200);

    // Channel permissions: non-owner cannot post (403), owner can post (201)
    const chRes = await fetch(`${baseUrl}/api/social/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ handle: 'sec_ops', title: 'Security Ops', description: 'Alerts' }),
    });
    const { channel } = (await chRes.json()) as { channel: { id: string } };
    const nonOwnerPost = await fetch(`${baseUrl}/api/social/channels/${channel.id}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d2.token}` },
      body: JSON.stringify({ text: 'Unauthorized post' }),
    });
    assert.equal(nonOwnerPost.status, 403);
    const ownerPost = await fetch(`${baseUrl}/api/social/channels/${channel.id}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ text: 'Verified broadcast' }),
    });
    assert.equal(ownerPost.status, 201);

    // Report abuse -> Admin resolve -> Admin suspend & restore target
    const reportRes = await fetch(`${baseUrl}/api/users/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ targetUserId: d2.user.id, reason: 'Spam simulation test' }),
    });
    assert.equal(reportRes.status, 201);

    const overview1 = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    const ovJson = (await overview1.json()) as { reports: Array<{ id: string; resolved: boolean }> };
    assert.ok(ovJson.reports.length >= 1);
    const reportId = ovJson.reports[0].id;

    const resolveRes = await fetch(`${baseUrl}/api/admin/reports/${reportId}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    assert.equal(resolveRes.status, 200);

    const suspendRes = await fetch(`${baseUrl}/api/admin/users/${d2.user.id}/moderate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ suspend: true, reason: 'E2E test moderation' }),
    });
    assert.equal(suspendRes.status, 200);
    assert.equal(((await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${d2.token}` } }))).status, 401);

    const restoreRes = await fetch(`${baseUrl}/api/admin/users/${d2.user.id}/moderate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ suspend: false }),
    });
    assert.equal(restoreRes.status, 200);
  } finally {
    wsAlice?.close();
    wsBob?.close();
    backend.close();
  }
});
