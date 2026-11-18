import type { WrappedRoomKey } from './types';

export interface DeviceKeyVault {
  ecdhPubJwk: JsonWebKey;
  ecdhPrivJwk: JsonWebKey;
  identityPubJwk: JsonWebKey;
  identityPrivJwk: JsonWebKey;
  fingerprint: string;
  // Local safety verification marks for peer devices
  verifiedPeerDevices: Record<string, string>;
}

const VAULT_PREFIX = 'rrchat1_keyvault_';

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function computeKeyFingerprint(ecdhPubJwk: JsonWebKey, identityPubJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({
    ecdh: { crv: ecdhPubJwk.crv, kty: ecdhPubJwk.kty, x: ecdhPubJwk.x, y: ecdhPubJwk.y },
    id: { crv: identityPubJwk.crv, kty: identityPubJwk.kty, x: identityPubJwk.x, y: identityPubJwk.y },
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest))
    .slice(0, 24)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
  return hex.match(/.{1,4}/g)?.join(' ') ?? hex;
}

export async function generateDeviceKeyVault(): Promise<DeviceKeyVault> {
  const ecdhPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const idPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const ecdhPubJwk = await crypto.subtle.exportKey('jwk', ecdhPair.publicKey);
  const ecdhPrivJwk = await crypto.subtle.exportKey('jwk', ecdhPair.privateKey);
  const identityPubJwk = await crypto.subtle.exportKey('jwk', idPair.publicKey);
  const identityPrivJwk = await crypto.subtle.exportKey('jwk', idPair.privateKey);
  const fingerprint = await computeKeyFingerprint(ecdhPubJwk, identityPubJwk);

  return {
    ecdhPubJwk,
    ecdhPrivJwk,
    identityPubJwk,
    identityPrivJwk,
    fingerprint,
    verifiedPeerDevices: {},
  };
}

export function saveVaultToLocal(username: string, deviceId: string, vault: DeviceKeyVault): void {
  localStorage.setItem(`${VAULT_PREFIX}${username}_${deviceId}`, JSON.stringify(vault));
}

export function loadVaultFromLocal(username: string, deviceId: string): DeviceKeyVault | null {
  const raw = localStorage.getItem(`${VAULT_PREFIX}${username}_${deviceId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeviceKeyVault;
  } catch {
    return null;
  }
}

export function removeVaultFromLocal(username: string, deviceId: string): void {
  localStorage.removeItem(`${VAULT_PREFIX}${username}_${deviceId}`);
}

async function deriveKeyWrapAesKey(
  myEcdhPrivJwk: JsonWebKey,
  peerEcdhPubJwk: JsonWebKey
): Promise<CryptoKey> {
  const privKey = await crypto.subtle.importKey(
    'jwk',
    myEcdhPrivJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  const pubKey = await crypto.subtle.importKey(
    'jwk',
    peerEcdhPubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('RRchat1-KeyWrap-Salt'),
      info: new TextEncoder().encode('RRchat1-RoomKeyWrap-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function generateRoomKeyBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const buf = new Uint8Array(new ArrayBuffer(32));
  crypto.getRandomValues(buf);
  return buf;
}

export async function importRoomAesKey(rawKeyBytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKeyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function wrapRoomKeyForDevice(
  rawRoomKey: Uint8Array<ArrayBuffer>,
  myDeviceId: string,
  vault: DeviceKeyVault,
  recipientDeviceEcdhPubJwk: JsonWebKey
): Promise<WrappedRoomKey> {
  const wrapKey = await deriveKeyWrapAesKey(vault.ecdhPrivJwk, recipientDeviceEcdhPubJwk);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, rawRoomKey);
  return {
    senderDeviceId: myDeviceId,
    senderEcdhPubJwk: vault.ecdhPubJwk,
    ivB64: bytesToBase64(iv),
    wrappedKeyB64: bytesToBase64(new Uint8Array(wrapped)),
  };
}

export async function unwrapRoomKey(
  wrapped: WrappedRoomKey,
  vault: DeviceKeyVault
): Promise<Uint8Array<ArrayBuffer>> {
  const wrapKey = await deriveKeyWrapAesKey(vault.ecdhPrivJwk, wrapped.senderEcdhPubJwk);
  const iv = base64ToBytes(wrapped.ivB64);
  const cipher = base64ToBytes(wrapped.wrappedKeyB64);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrapKey, cipher);
  return new Uint8Array(plainBuf);
}

export async function encryptTextPayload(
  roomAesKey: CryptoKey,
  plaintext: string
): Promise<{ ciphertextB64: string; ivB64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, roomAesKey, encoded);
  return {
    ciphertextB64: bytesToBase64(new Uint8Array(cipher)),
    ivB64: bytesToBase64(iv),
  };
}

export async function decryptTextPayload(
  roomAesKey: CryptoKey,
  ciphertextB64: string,
  ivB64: string
): Promise<string> {
  const iv = base64ToBytes(ivB64);
  const cipher = base64ToBytes(ciphertextB64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, roomAesKey, cipher);
  return new TextDecoder().decode(plain);
}

export async function encryptBinaryPayload(
  roomAesKey: CryptoKey,
  data: Uint8Array<ArrayBuffer>
): Promise<{ ciphertextB64: string; ivB64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, roomAesKey, data);
  return {
    ciphertextB64: bytesToBase64(new Uint8Array(cipher)),
    ivB64: bytesToBase64(iv),
  };
}

export async function decryptBinaryPayload(
  roomAesKey: CryptoKey,
  ciphertextB64: string,
  ivB64: string
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = base64ToBytes(ivB64);
  const cipher = base64ToBytes(ciphertextB64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, roomAesKey, cipher);
  return new Uint8Array(plain);
}

export async function createEncryptedKeyBackup(
  vault: DeviceKeyVault,
  backupPassphrase: string
): Promise<{ saltB64: string; ivB64: string; wrappedVaultB64: string; iterations: number }> {
  const iterations = 310000;
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const keyMat = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(backupPassphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const plain = new TextEncoder().encode(JSON.stringify(vault));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);
  return {
    saltB64: bytesToBase64(salt),
    ivB64: bytesToBase64(iv),
    wrappedVaultB64: bytesToBase64(new Uint8Array(cipher)),
    iterations,
  };
}

export async function restoreEncryptedKeyBackup(
  backup: { saltB64: string; ivB64: string; wrappedVaultB64: string; iterations: number },
  backupPassphrase: string
): Promise<DeviceKeyVault> {
  const salt = base64ToBytes(backup.saltB64);
  const iv = base64ToBytes(backup.ivB64);
  const cipher = base64ToBytes(backup.wrappedVaultB64);
  const keyMat = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(backupPassphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: backup.iterations, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
  return JSON.parse(new TextDecoder().decode(plain)) as DeviceKeyVault;
}
