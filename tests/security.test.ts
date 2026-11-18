import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createRRChatBackend } from '../backend/app.ts';
import {
  computeTotpCode,
  hashPasswordArgon2id,
  sanitizeLogPayload,
  validateEncryptedAttachmentMeta,
  validatePasswordStrength,
  verifyPasswordArgon2id,
  verifyTotpToken,
} from '../backend/security.ts';

async function makeWebCryptoLikeKeyPair() {
  const ecdh = crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const id = crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const [ecdhPair, idPair] = await Promise.all([ecdh, id]);
  const ecdhPubJwk = await crypto.webcrypto.subtle.exportKey('jwk', ecdhPair.publicKey);
  const idPubJwk = await crypto.webcrypto.subtle.exportKey('jwk', idPair.publicKey);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ecdhPubJwk, idPubJwk })).digest('hex').slice(0, 32);
  return { ecdhPair, idPair, ecdhPubJwk, idPubJwk, fingerprint };
}

test('1. Password policy & Argon2id hashing', async () => {
  assert.equal(validatePasswordStrength('short', 'alice_sec').valid, false);
  assert.equal(validatePasswordStrength('Alice_sec!1234', 'alice_sec').valid, false);
  assert.equal(validatePasswordStrength('Correct!Horse99#Vault', 'alice_sec').valid, true);

  const hash = await hashPasswordArgon2id('Correct!Horse99#Vault', { m: 1024, t: 1, p: 1 });
  assert.ok(hash.startsWith('$argon2id$v=19$'));
  assert.equal(await verifyPasswordArgon2id('Correct!Horse99#Vault', hash), true);
  assert.equal(await verifyPasswordArgon2id('WrongPassword!123', hash), false);
});

test('2. RFC 6238 TOTP 2FA verification', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const now = Date.now();
  const code = computeTotpCode(secret, now);
  assert.equal(verifyTotpToken(secret, code, 1, now), true);
  assert.equal(verifyTotpToken(secret, '000000', 0, now), code === '000000');
});

test('3. File upload MIME & size validation blocks XSS/executables', () => {
  assert.equal(validateEncryptedAttachmentMeta('image/png', 1024).valid, true);
  assert.equal(validateEncryptedAttachmentMeta('image/svg+xml', 1024).valid, false);
  assert.equal(validateEncryptedAttachmentMeta('text/html', 1024).valid, false);
  assert.equal(validateEncryptedAttachmentMeta('application/x-msdownload', 1024).valid, false);
  assert.equal(validateEncryptedAttachmentMeta('application/pdf', 20 * 1024 * 1024).valid, false);
});

test('4. Log sanitization redacts secrets and plaintext fields', () => {
  const sanitized = sanitizeLogPayload({
    userId: 'u1',
    password: 'SecretPassword!123',
    plaintext: 'Sensitive message',
    nested: { privateKey: 'PEM', token: 'abc' },
  });
  assert.equal(sanitized.userId, 'u1');
  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.plaintext, '[REDACTED]');
  assert.deepEqual(sanitized.nested, { privateKey: '[REDACTED]', token: '[REDACTED]' });
});

test('5. End-to-end API security: auth, E2EE opacity, brute-force, session revocation & disappearing TTL', async () => {
  const backend = createRRChatBackend({
    storePath: null,
    argon2Options: { m: 1024, t: 1, p: 1 },
    loginMaxAttempts: 3,
    loginLockoutMs: 60_000,
  });

  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const addr = backend.server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  try {
    const aliceKeys = await makeWebCryptoLikeKeyPair();
    const bobKeys = await makeWebCryptoLikeKeyPair();

    // Register Alice
    const regAlice = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice_test',
        password: 'Strong!Password#991',
        identityPubKeyJwk: aliceKeys.idPubJwk,
        ecdhPubKeyJwk: aliceKeys.ecdhPubJwk,
        fingerprint: aliceKeys.fingerprint,
      }),
    });
    assert.equal(regAlice.status, 201);
    const aliceData = (await regAlice.json()) as { token: string; deviceId: string; user: { id: string } };

    // Register Bob
    const regBob = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'bob_test',
        password: 'Strong!Password#992',
        identityPubKeyJwk: bobKeys.idPubJwk,
        ecdhPubKeyJwk: bobKeys.ecdhPubJwk,
        fingerprint: bobKeys.fingerprint,
      }),
    });
    assert.equal(regBob.status, 201);
    const bobData = (await regBob.json()) as { token: string; deviceId: string; user: { id: string } };

    // Authorization check: unauthenticated request rejected
    const unauthRes = await fetch(`${baseUrl}/api/rooms`);
    assert.equal(unauthRes.status, 401);

    // Path traversal blocked on repo file endpoint
    const traversalRes = await fetch(`${baseUrl}/api/repo/file?path=../../etc/passwd`);
    assert.equal(traversalRes.status, 400);

    // Create 1:1 room with client-side ECDH wrapped room key
    const roomKeyRaw = crypto.randomBytes(32);
    const sharedBits = await crypto.webcrypto.subtle.deriveBits(
      { name: 'ECDH', public: await crypto.webcrypto.subtle.importKey('jwk', bobKeys.ecdhPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []) },
      aliceKeys.ecdhPair.privateKey,
      256
    );
    const hkdfKey = await crypto.webcrypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    const wrapAes = await crypto.webcrypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: Buffer.from('RRchat1-KeyWrap-Salt'),
        info: Buffer.from('RRchat1-RoomKeyWrap-v1'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    const wrapIv = crypto.randomBytes(12);
    const wrappedForBob = Buffer.from(
      await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, wrapAes, roomKeyRaw)
    ).toString('base64');

    const createRoomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceData.token}`,
      },
      body: JSON.stringify({
        type: 'direct',
        memberIds: [bobData.user.id],
        encryptedRoomKeys: {
          [bobData.deviceId]: {
            senderDeviceId: aliceData.deviceId,
            senderEcdhPubJwk: aliceKeys.ecdhPubJwk,
            ivB64: wrapIv.toString('base64'),
            wrappedKeyB64: wrappedForBob,
          },
        },
        disappearingTtlSeconds: 1,
      }),
    });
    assert.equal(createRoomRes.status, 201);
    const { room } = (await createRoomRes.json()) as { room: { id: string } };

    // API rejects plaintext messages
    const plaintextReject = await fetch(`${baseUrl}/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceData.token}`,
      },
      body: JSON.stringify({ plaintext: 'Leaked unencrypted text!' }),
    });
    assert.equal(plaintextReject.status, 400);

    // Send genuinely AES-256-GCM encrypted message
    const secretText = 'Top secret rendezvous at 19:00';
    const msgIv = crypto.randomBytes(12);
    const roomAes = await crypto.webcrypto.subtle.importKey('raw', roomKeyRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const cipherBuf = await crypto.webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: msgIv },
      roomAes,
      Buffer.from(secretText, 'utf8')
    );

    const sendRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceData.token}`,
      },
      body: JSON.stringify({
        kind: 'text',
        ciphertextB64: Buffer.from(cipherBuf).toString('base64'),
        ivB64: msgIv.toString('base64'),
      }),
    });
    assert.equal(sendRes.status, 201);

    // Verify server store holds ZERO plaintext
    const storedSerialized = JSON.stringify(backend.store.state.messages[room.id]);
    assert.equal(storedSerialized.includes(secretText), false);

    // Verify Bob can unwrap key and decrypt message
    const bobSharedBits = await crypto.webcrypto.subtle.deriveBits(
      { name: 'ECDH', public: await crypto.webcrypto.subtle.importKey('jwk', aliceKeys.ecdhPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []) },
      bobKeys.ecdhPair.privateKey,
      256
    );
    const bobHkdf = await crypto.webcrypto.subtle.importKey('raw', bobSharedBits, 'HKDF', false, ['deriveKey']);
    const bobWrapAes = await crypto.webcrypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: Buffer.from('RRchat1-KeyWrap-Salt'),
        info: Buffer.from('RRchat1-RoomKeyWrap-v1'),
      },
      bobHkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const unwrappedRoomKey = await crypto.webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: wrapIv },
      bobWrapAes,
      Buffer.from(wrappedForBob, 'base64')
    );
    const bobRoomAes = await crypto.webcrypto.subtle.importKey('raw', unwrappedRoomKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const decrypted = Buffer.from(
      await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: msgIv }, bobRoomAes, cipherBuf)
    ).toString('utf8');
    assert.equal(decrypted, secretText);

    // Brute-force protection locks after maxAttempts
    for (let i = 0; i < 3; i++) {
      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice_test', password: 'Wrong!Password123' }),
      });
    }
    const lockedRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice_test', password: 'Strong!Password#991' }),
    });
    assert.equal(lockedRes.status, 429);

    // Session revocation terminates access immediately
    const revokeRes = await fetch(`${baseUrl}/api/devices/${aliceData.deviceId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceData.token}` },
    });
    assert.equal(revokeRes.status, 200);
    const postRevoke = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${aliceData.token}` },
    });
    assert.equal(postRevoke.status, 401);

    // Disappearing message expiry purge
    const futurePurge = backend.store.purgeExpiredMessages(Date.now() + 5000);
    assert.equal(futurePurge.length, 1);
    assert.equal(backend.store.state.messages[room.id].length, 0);
  } finally {
    backend.close();
  }
});

test('6. Private contact number defaults & QR userId lookup never leak phone numbers', async () => {
  const backend = createRRChatBackend({
    storePath: null,
    argon2Options: { m: 1024, t: 1, p: 1 },
  });
  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const addr = backend.server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  try {
    const k1 = await makeWebCryptoLikeKeyPair();
    const k2 = await makeWebCryptoLikeKeyPair();

    const r1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'carol_priv',
        password: 'Strong!Password#993',
        contactNumber: '+15550192837',
        identityPubKeyJwk: k1.idPubJwk,
        ecdhPubKeyJwk: k1.ecdhPubJwk,
        fingerprint: k1.fingerprint,
      }),
    });
    const d1 = (await r1.json()) as { user: { id: string; contactNumberMasked: string; privacySettings: Record<string, unknown> } };
    assert.equal(d1.user.privacySettings.contactNumberVisibility, 'private');
    assert.equal(d1.user.privacySettings.allowLookupByContactNumber, false);
    assert.equal(d1.user.privacySettings.hideOnlinePresence, true);
    assert.equal(d1.user.privacySettings.sendReadReceipts, false);

    const r2 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'dave_scan',
        password: 'Strong!Password#994',
        identityPubKeyJwk: k2.idPubJwk,
        ecdhPubKeyJwk: k2.ecdhPubJwk,
        fingerprint: k2.fingerprint,
      }),
    });
    const d2 = (await r2.json()) as { token: string };

    // Searching by Carol's phone number must return 0 results by default
    const phoneSearch = await fetch(`${baseUrl}/api/users/search?q=${encodeURIComponent('+15550192837')}`, {
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    const phoneJson = (await phoneSearch.json()) as { users: Array<Record<string, unknown>> };
    assert.equal(phoneJson.users.length, 0);

    // QR userId lookup returns Carol's public key fingerprint without leaking any contact number
    const qrLookup = await fetch(`${baseUrl}/api/users/search?userId=${encodeURIComponent(d1.user.id)}`, {
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    const qrJson = (await qrLookup.json()) as { users: Array<Record<string, unknown>> };
    assert.equal(qrJson.users.length, 1);
    assert.equal('contactNumberMasked' in qrJson.users[0], false);
    assert.equal('contactNumberHash' in qrJson.users[0], false);
  } finally {
    backend.close();
  }
});

test('7. Private gaming & Discord settings isolation + atomic P2P wallet transfers + E2EE payment/call messages', async () => {
  const backend = createRRChatBackend({
    storePath: null,
    argon2Options: { m: 1024, t: 1, p: 1 },
  });
  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const addr = backend.server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  try {
    const k1 = await makeWebCryptoLikeKeyPair();
    const k2 = await makeWebCryptoLikeKeyPair();

    const r1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'gamer_alice',
        password: 'Strong!Password#995',
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
        username: 'gamer_bob',
        password: 'Strong!Password#996',
        identityPubKeyJwk: k2.idPubJwk,
        ecdhPubKeyJwk: k2.ecdhPubJwk,
        fingerprint: k2.fingerprint,
      }),
    });
    const d2 = (await r2.json()) as { token: string; deviceId: string; user: { id: string } };

    // Save private gaming & Discord invite settings for Alice
    const gamingRes = await fetch(`${baseUrl}/api/privacy/gaming`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${d1.token}`,
      },
      body: JSON.stringify({
        platform: 'PC / Steam',
        gamertag: 'SecretSnipe99',
        discordUsername: 'alice_disc#0001',
        discordInviteCode: 'https://discord.gg/rrchat-private-squad',
      }),
    });
    assert.equal(gamingRes.status, 200);
    const gamingJson = (await gamingRes.json()) as { gamingConnection: { discordInviteCode: string; visibility: string } };
    assert.equal(gamingJson.gamingConnection.discordInviteCode, 'rrchat-private-squad');
    assert.equal(gamingJson.gamingConnection.visibility, 'private');

    // Directory search by Bob must NOT leak Alice's gaming ID, Discord username, or wallet balance
    const searchRes = await fetch(`${baseUrl}/api/users/search?q=gamer_alice`, {
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    const searchJson = (await searchRes.json()) as { users: Array<Record<string, unknown>> };
    assert.equal(searchJson.users.length, 1);
    assert.equal('gamingConnection' in searchJson.users[0], false);
    assert.equal('walletBalanceCents' in searchJson.users[0], false);

    // Create 1:1 room between Alice and Bob
    const roomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${d1.token}`,
      },
      body: JSON.stringify({
        type: 'direct',
        memberIds: [d2.user.id],
        encryptedRoomKeys: { [d1.deviceId]: { senderDeviceId: d1.deviceId, senderEcdhPubJwk: k1.ecdhPubJwk, ivB64: 'iv', wrappedKeyB64: 'key' } },
      }),
    });
    assert.equal(roomRes.status, 201);
    const { room } = (await roomRes.json()) as { room: { id: string } };

    // Transfer fails with insufficient funds
    const overdrawRes = await fetch(`${baseUrl}/api/payments/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${d1.token}`,
      },
      body: JSON.stringify({ roomId: room.id, recipientId: d2.user.id, amountCents: 2500 }),
    });
    assert.equal(overdrawRes.status, 400);

    // Alice deposits $50.00 into private wallet and sends $15.50 to Bob
    const depRes = await fetch(`${baseUrl}/api/wallet/deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${d1.token}`,
      },
      body: JSON.stringify({ amountCents: 5000 }),
    });
    assert.equal(depRes.status, 200);

    // Self-transfer must be rejected
    const selfPayRes = await fetch(`${baseUrl}/api/payments/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${d1.token}`,
      },
      body: JSON.stringify({ roomId: room.id, recipientId: d1.user.id, amountCents: 500 }),
    });
    assert.equal(selfPayRes.status, 400);

    const payRes = await fetch(`${baseUrl}/api/payments/transfer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${d1.token}`,
      },
      body: JSON.stringify({ roomId: room.id, recipientId: d2.user.id, amountCents: 1550 }),
    });
    assert.equal(payRes.status, 201);
    const payJson = (await payRes.json()) as { balanceCents: number };
    assert.equal(payJson.balanceCents, 3450);

    // Check Bob's private wallet balance increased atomically
    const bobWalletRes = await fetch(`${baseUrl}/api/wallet`, {
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    const bobWallet = (await bobWalletRes.json()) as { balanceCents: number; history: Array<{ direction: string; amountCents: number }> };
    assert.equal(bobWallet.balanceCents, 1550);
    assert.equal(bobWallet.history[0].direction, 'received');
    assert.equal(bobWallet.history[0].amountCents, 1550);

    // Encrypted payment & call messages are accepted cleanly
    for (const kind of ['payment', 'call'] as const) {
      const msgRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${d1.token}`,
        },
        body: JSON.stringify({
          kind,
          ciphertextB64: Buffer.from(`cipher-${kind}`).toString('base64'),
          ivB64: Buffer.from('123456789012').toString('base64'),
        }),
      });
      assert.equal(msgRes.status, 201);
    }
  } finally {
    backend.close();
  }
});

test('8. Next-Gen RRchat features: edit/delete E2EE messages, Vault PIN, Smart Room moderation, Emergency Lock, AI consent gate, and Admin metadata boundary', async () => {
  const backend = createRRChatBackend({
    storePath: null,
    argon2Options: { m: 1024, t: 1, p: 1 },
  });
  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const addr = backend.server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  try {
    const k1 = await makeWebCryptoLikeKeyPair();
    const k2 = await makeWebCryptoLikeKeyPair();

    const r1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'next_alice',
        password: 'Strong!Password#997',
        identityPubKeyJwk: k1.idPubJwk,
        ecdhPubKeyJwk: k1.ecdhPubJwk,
        fingerprint: k1.fingerprint,
      }),
    });
    const d1 = (await r1.json()) as { token: string; deviceId: string; user: { id: string } };

    // Second login session for Alice to verify Emergency Lock revokes other sessions
    const r1Second = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'next_alice',
        password: 'Strong!Password#997',
        deviceName: 'Alice Tablet',
        platform: 'Android',
        identityPubKeyJwk: k1.idPubJwk,
        ecdhPubKeyJwk: k1.ecdhPubJwk,
        fingerprint: `${k1.fingerprint}-2`,
      }),
    });
    const d1Second = (await r1Second.json()) as { token: string; deviceId: string };

    const r2 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'next_bob',
        password: 'Strong!Password#998',
        identityPubKeyJwk: k2.idPubJwk,
        ecdhPubKeyJwk: k2.ecdhPubJwk,
        fingerprint: k2.fingerprint,
      }),
    });
    const d2 = (await r2.json()) as { token: string; deviceId: string; user: { id: string } };

    // 1. Vault PIN set & verification
    const setPinRes = await fetch(`${baseUrl}/api/vault/pin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ pin: '4829' }),
    });
    assert.equal(setPinRes.status, 200);

    const badPinRes = await fetch(`${baseUrl}/api/vault/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(badPinRes.status, 401);

    const okPinRes = await fetch(`${baseUrl}/api/vault/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ pin: '4829' }),
    });
    assert.equal(okPinRes.status, 200);

    // 2. Smart Room creation, vault toggle, settings update & kick
    const roomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        type: 'group',
        title: 'Smart Ops',
        topic: 'Zero-trust sync',
        inviteOnly: true,
        slowModeSeconds: 10,
        memberIds: [d2.user.id],
        encryptedRoomKeys: { [d1.deviceId]: { senderDeviceId: d1.deviceId, senderEcdhPubJwk: k1.ecdhPubJwk, ivB64: 'iv', wrappedKeyB64: 'key' } },
      }),
    });
    assert.equal(roomRes.status, 201);
    const { room } = (await roomRes.json()) as { room: { id: string } };

    const vaultToggle = await fetch(`${baseUrl}/api/rooms/${room.id}/vault`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ inVault: true }),
    });
    assert.equal(vaultToggle.status, 200);

    // 3. E2EE message send, edit (rejects plaintext), and delete
    const sendRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        kind: 'text',
        ciphertextB64: Buffer.from('cipher-v1').toString('base64'),
        ivB64: Buffer.from('123456789012').toString('base64'),
      }),
    });
    assert.equal(sendRes.status, 201);
    const { message } = (await sendRes.json()) as { message: { id: string } };

    const badEdit = await fetch(`${baseUrl}/api/rooms/${room.id}/messages/${message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ plaintext: 'forbidden' }),
    });
    assert.equal(badEdit.status, 400);

    const goodEdit = await fetch(`${baseUrl}/api/rooms/${room.id}/messages/${message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        ciphertextB64: Buffer.from('cipher-v2').toString('base64'),
        ivB64: Buffer.from('abcdefghijkl').toString('base64'),
      }),
    });
    assert.equal(goodEdit.status, 200);

    const delRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages/${message.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    assert.equal(delRes.status, 200);
    assert.equal(backend.store.state.messages[room.id][0].deleted, true);
    assert.equal(backend.store.state.messages[room.id][0].ciphertextB64, '');

    // 4. Kick member from Smart Room
    const kickRes = await fetch(`${baseUrl}/api/rooms/${room.id}/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ targetUserId: d2.user.id }),
    });
    assert.equal(kickRes.status, 200);
    assert.equal(backend.store.state.rooms[room.id].memberIds.includes(d2.user.id), false);

    // 5. AI Consent Gate strictly blocks requests without consentGranted === true
    const aiNoConsent = await fetch(`${baseUrl}/api/ai/assist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ consentGranted: false, mode: 'translate', text: 'hello', targetLang: 'Spanish' }),
    });
    assert.equal(aiNoConsent.status, 400);

    const transcribeNoConsent = await fetch(`${baseUrl}/api/ai/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ consentGranted: false, audioBase64: 'AA==', mimeType: 'audio/webm' }),
    });
    assert.equal(transcribeNoConsent.status, 400);

    // 6. Emergency Privacy Mode revokes Alice's secondary session immediately
    const lockRes = await fetch(`${baseUrl}/api/security/emergency-lock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    assert.equal(lockRes.status, 200);
    const lockJson = (await lockRes.json()) as {
      revokedSessions: number;
      privacySettings: { hideNotificationPreviews: boolean };
    };
    assert.equal(lockJson.revokedSessions >= 1, true);
    assert.equal(lockJson.privacySettings.hideNotificationPreviews, true);

    const secondMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${d1Second.token}` },
    });
    assert.equal(secondMe.status, 401);

    // 7. Admin overview returns metadata health & zero plaintext
    const adminRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    assert.equal(adminRes.status, 200);
    const adminJson = (await adminRes.json()) as {
      health: { encryptedRooms: number };
      cryptographicBoundary: string;
    };
    assert.equal(adminJson.health.encryptedRooms, 1);
    assert.match(adminJson.cryptographicBoundary, /cannot access private keys/i);
  } finally {
    backend.close();
  }
});

test('9. Duress PIN, RR Vault file locker, Scheduled E2EE messages, Message Recall, 26 Features, Shield Score, and Opt-In Social Hub', async () => {
  const backend = createRRChatBackend({
    storePath: null,
    argon2Options: { m: 1024, t: 1, p: 1 },
  });
  await new Promise<void>((resolve) => backend.server.listen(0, '127.0.0.1', resolve));
  const addr = backend.server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  try {
    const k1 = await makeWebCryptoLikeKeyPair();
    const k2 = await makeWebCryptoLikeKeyPair();

    const r1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'shield_alice',
        password: 'Strong!Password#999',
        identityPubKeyJwk: k1.idPubJwk,
        ecdhPubKeyJwk: k1.ecdhPubJwk,
        fingerprint: k1.fingerprint,
      }),
    });
    const d1 = (await r1.json()) as { token: string; deviceId: string; user: { id: string } };

    // Secondary session to verify wipe_and_decoy revokes other sessions
    const r1Sec = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'shield_alice',
        password: 'Strong!Password#999',
        deviceName: 'Backup Phone',
        platform: 'iOS',
        identityPubKeyJwk: k1.idPubJwk,
        ecdhPubKeyJwk: k1.ecdhPubJwk,
        fingerprint: `${k1.fingerprint}-b`,
      }),
    });
    const d1Sec = (await r1Sec.json()) as { token: string };

    const r2 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'social_bob',
        password: 'Strong!Password#990',
        identityPubKeyJwk: k2.idPubJwk,
        ecdhPubKeyJwk: k2.ecdhPubJwk,
        fingerprint: k2.fingerprint,
      }),
    });
    const d2 = (await r2.json()) as { token: string; user: { id: string } };

    // 1. Set normal Vault PIN + Duress PIN (wipe_and_decoy) and trigger duress
    await fetch(`${baseUrl}/api/vault/pin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ pin: '1122' }),
    });
    const setDuress = await fetch(`${baseUrl}/api/vault/duress-pin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ pin: '9911', behavior: 'wipe_and_decoy' }),
    });
    assert.equal(setDuress.status, 200);

    const triggerDuress = await fetch(`${baseUrl}/api/vault/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ pin: '9911' }),
    });
    assert.equal(triggerDuress.status, 200);
    const duressJson = (await triggerDuress.json()) as { duressTriggered: boolean; duressBehavior: string };
    assert.equal(duressJson.duressTriggered, true);
    assert.equal(duressJson.duressBehavior, 'wipe_and_decoy');

    // Secondary session must now be revoked + alert recorded
    const secCheck = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${d1Sec.token}` },
    });
    assert.equal(secCheck.status, 401);
    const alertsRes = await fetch(`${baseUrl}/api/security/alerts`, {
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    const alertsJson = (await alertsRes.json()) as { alerts: Array<{ eventType: string }> };
    assert.ok(alertsJson.alerts.some((a) => a.eventType === 'duress_pin_triggered'));

    // 2. RR Vault file locker rejects plaintext & stores ciphertext
    const badVault = await fetch(`${baseUrl}/api/vault/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ kind: 'doc', plaintext: 'secret.pdf' }),
    });
    assert.equal(badVault.status, 400);

    const okVault = await fetch(`${baseUrl}/api/vault/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        kind: 'doc',
        ciphertextB64: Buffer.from('cipher-file').toString('base64'),
        ivB64: Buffer.from('123456789012').toString('base64'),
        metaEncB64: Buffer.from('cipher-meta').toString('base64'),
        metaIvB64: Buffer.from('abcdefghijkl').toString('base64'),
        sizeBytes: 1024,
      }),
    });
    assert.equal(okVault.status, 201);

    // 3. Scheduled message & Message recall
    const roomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        type: 'direct',
        memberIds: [d2.user.id],
        encryptedRoomKeys: { [d1.deviceId]: { senderDeviceId: d1.deviceId, senderEcdhPubJwk: k1.ecdhPubJwk, ivB64: 'iv', wrappedKeyB64: 'key' } },
      }),
    });
    const { room } = (await roomRes.json()) as { room: { id: string } };

    const badSched = await fetch(`${baseUrl}/api/rooms/${room.id}/scheduled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ plaintext: 'unencrypted', deliverAt: Date.now() + 60000 }),
    });
    assert.equal(badSched.status, 400);

    const okSched = await fetch(`${baseUrl}/api/rooms/${room.id}/scheduled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        kind: 'text',
        ciphertextB64: Buffer.from('future-cipher').toString('base64'),
        ivB64: Buffer.from('123456789012').toString('base64'),
        deliverAt: Date.now() + 60_000,
      }),
    });
    assert.equal(okSched.status, 201);

    const msgRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        kind: 'text',
        ciphertextB64: Buffer.from('recall-me').toString('base64'),
        ivB64: Buffer.from('123456789012').toString('base64'),
      }),
    });
    const { message } = (await msgRes.json()) as { message: { id: string } };
    const recallRes = await fetch(`${baseUrl}/api/rooms/${room.id}/messages/${message.id}/recall`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    assert.equal(recallRes.status, 200);
    assert.equal(backend.store.state.messages[room.id][0].deleted, true);
    assert.ok(backend.store.state.messages[room.id][0].recalledAt);

    // 4. 26-Feature Switchboard & RR Shield score
    const featRes = await fetch(`${baseUrl}/api/features`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({
        featureSelection: { panic_lock: true, duress_pin: true },
        screenshotPrivacy: true,
        phishingProtection: true,
      }),
    });
    assert.equal(featRes.status, 200);

    const shieldRes = await fetch(`${baseUrl}/api/shield/score`, {
      headers: { Authorization: `Bearer ${d1.token}` },
    });
    assert.equal(shieldRes.status, 200);
    const shieldJson = (await shieldRes.json()) as { score: number; maxScore: number };
    assert.equal(shieldJson.maxScore, 100);
    assert.ok(shieldJson.score > 0);

    // 5. Social Hub: Story, Channel subscribe, Poll vote, Voice Room, Opt-in Nearby Discovery
    await fetch(`${baseUrl}/api/social/stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ text: 'Hello 24h story', theme: 'obsidian_purple' }),
    });
    const chRes = await fetch(`${baseUrl}/api/social/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ handle: 'rr_news', title: 'RR News', description: 'Zero phone channel', isPrivateCommunity: false }),
    });
    const { channel } = (await chRes.json()) as { channel: { id: string } };
    await fetch(`${baseUrl}/api/social/channels/${channel.id}/subscribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d2.token}` },
    });

    const pollRes = await fetch(`${baseUrl}/api/social/polls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ question: 'Theme?', options: ['Neon Purple', 'Chrome'] }),
    });
    const { poll } = (await pollRes.json()) as { poll: { id: string; options: Array<{ id: string }> } };
    await fetch(`${baseUrl}/api/social/polls/${poll.id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d2.token}` },
      body: JSON.stringify({ optionId: poll.options[0].id }),
    });

    // Nearby discovery stays empty while Alice is opted-out
    const feedOptOut = await fetch(`${baseUrl}/api/social/feed`, {
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    const feedOutJson = (await feedOptOut.json()) as { nearbyUsers: unknown[] };
    assert.equal(feedOutJson.nearbyUsers.length, 0);

    // Enable opt-in nearby discovery for both Alice and Bob in same zone
    await fetch(`${baseUrl}/api/features`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d1.token}` },
      body: JSON.stringify({ nearbyDiscoveryEnabled: true, nearbyZoneLabel: 'Kathmandu Hub' }),
    });
    await fetch(`${baseUrl}/api/features`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d2.token}` },
      body: JSON.stringify({ nearbyDiscoveryEnabled: true, nearbyZoneLabel: 'Kathmandu Hub' }),
    });
    const feedOptIn = await fetch(`${baseUrl}/api/social/feed`, {
      headers: { Authorization: `Bearer ${d2.token}` },
    });
    const feedInJson = (await feedOptIn.json()) as {
      stories: unknown[];
      channels: Array<{ subscriberCount: number }>;
      polls: Array<{ options: Array<{ voterIds: string[] }> }>;
      nearbyUsers: Array<{ username: string }>;
    };
    assert.equal(feedInJson.stories.length, 1);
    assert.equal(feedInJson.channels[0].subscriberCount, 2);
    assert.equal(feedInJson.polls[0].options[0].voterIds.length, 1);
    assert.ok(feedInJson.nearbyUsers.some((u) => u.username === 'shield_alice'));
  } finally {
    backend.close();
  }
});



