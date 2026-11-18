import crypto from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';

export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'security',
  'rrchat',
  'moderator',
  'postmaster',
  'hostmaster',
  'null',
  'undefined',
]);

export function validateUsername(raw: string): { valid: boolean; normalized: string; error?: string } {
  if (typeof raw !== 'string') {
    return { valid: false, normalized: '', error: 'Username must be a string.' };
  }
  const normalized = raw.trim().toLowerCase().replace(/^@/, '');
  if (normalized.length < 3 || normalized.length > 32) {
    return { valid: false, normalized, error: 'Username must be between 3 and 32 characters.' };
  }
  if (!/^[a-z0-9][a-z0-9_.-]*[a-z0-9]$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Username may only contain lowercase letters, numbers, underscores, hyphens, and periods.',
    };
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return { valid: false, normalized, error: 'This username is reserved by the system.' };
  }
  return { valid: true, normalized };
}

export function validatePasswordStrength(password: string, username: string): { valid: boolean; error?: string } {
  if (typeof password !== 'string' || password.length < 12) {
    return { valid: false, error: 'Password must be at least 12 characters long.' };
  }
  if (password.length > 128) {
    return { valid: false, error: 'Password cannot exceed 128 characters.' };
  }
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  if (!hasUpper || !hasLower || !hasDigit || !hasSymbol) {
    return {
      valid: false,
      error: 'Password must include uppercase, lowercase, numeric, and symbol characters.',
    };
  }
  const cleanUser = username.trim().toLowerCase().replace(/^@/, '');
  if (cleanUser.length >= 3 && password.toLowerCase().includes(cleanUser)) {
    return {
      valid: false,
      error: 'Password must not contain your username. Never derive authentication secrets from a username.',
    };
  }
  return { valid: true };
}

// Argon2id parameters: RFC 9106 balanced interactive profile (m=65536 KiB = 64 MiB, t=3, p=1)
const ARGON2_M = 65536;
const ARGON2_T = 3;
const ARGON2_P = 1;
const ARGON2_DKLEN = 32;

export async function hashPasswordArgon2id(
  password: string,
  opts?: { m?: number; t?: number; p?: number }
): Promise<string> {
  const salt = crypto.randomBytes(16);
  const m = opts?.m ?? ARGON2_M;
  const t = opts?.t ?? ARGON2_T;
  const p = opts?.p ?? ARGON2_P;
  const derived = await argon2idAsync(password, salt, {
    m,
    t,
    p,
    dkLen: ARGON2_DKLEN,
    asyncTick: 10,
  });
  const saltB64 = Buffer.from(salt).toString('base64');
  const hashB64 = Buffer.from(derived).toString('base64');
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${saltB64}$${hashB64}`;
}

export async function verifyPasswordArgon2id(password: string, encoded: string): Promise<boolean> {
  try {
    const parts = encoded.split('$');
    // ['', 'argon2id', 'v=19', 'm=...,t=...,p=...', '<salt>', '<hash>']
    if (parts.length !== 6 || parts[1] !== 'argon2id') {
      return false;
    }
    const params = Object.fromEntries(
      parts[3].split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k, Number(v)];
      })
    );
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!params.m || !params.t || !params.p || salt.length < 8 || expected.length < 16) {
      return false;
    }
    const actual = await argon2idAsync(password, salt, {
      m: params.m,
      t: params.t,
      p: params.p,
      dkLen: expected.length,
      asyncTick: 10,
    });
    return crypto.timingSafeEqual(Buffer.from(actual), expected);
  } catch {
    return false;
  }
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

// RFC 4648 Base32 for TOTP secrets
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error('Invalid Base32 character');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function buildOtpAuthUri(username: string, secret: string): string {
  const issuer = encodeURIComponent('RRchat 1');
  const label = encodeURIComponent(`RRchat 1:@${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

export function computeTotpCode(secretBase32: string, timeMs = Date.now(), stepSeconds = 30): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function verifyTotpToken(secretBase32: string, token: string, window = 1, timeMs = Date.now()): boolean {
  const clean = token.trim();
  if (!/^\d{6}$/.test(clean)) return false;
  const candidateBuf = Buffer.from(clean, 'utf8');
  for (let offset = -window; offset <= window; offset++) {
    const expected = computeTotpCode(secretBase32, timeMs + offset * 30_000);
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (crypto.timingSafeEqual(candidateBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

export function generateRecoveryCodes(count = 8): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(12);
    let code = '';
    for (let j = 0; j < 12; j++) {
      if (j > 0 && j % 4 === 0) code += '-';
      code += alphabet[bytes[j] % alphabet.length];
    }
    codes.push(code);
  }
  return codes;
}

export function maskIpAddress(ip: string | undefined): string {
  if (!ip) return '0.0.x.x';
  const clean = ip.replace(/^::ffff:/, '');
  if (clean.includes('.')) {
    const parts = clean.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.x.x`;
  }
  if (clean.includes(':')) {
    const parts = clean.split(':');
    return `${parts.slice(0, 2).join(':')}::/32`;
  }
  return 'private-net';
}

const ALLOWED_ATTACHMENT_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/aac',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'text/plain',
  'application/zip',
]);

export const MAX_ENCRYPTED_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MiB

export function validateEncryptedAttachmentMeta(
  mimeType: string,
  sizeBytes: number
): { valid: boolean; error?: string } {
  const baseMime = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (!baseMime || !ALLOWED_ATTACHMENT_MIME.has(baseMime)) {
    return {
      valid: false,
      error: `MIME type "${mimeType}" is blocked by security policy (HTML/SVG/executables prohibited).`,
    };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_ENCRYPTED_ATTACHMENT_BYTES) {
    return {
      valid: false,
      error: 'Encrypted attachment size must be between 1 byte and 15 MiB.',
    };
  }
  return { valid: true };
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly lockouts = new Map<string, number>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly lockoutMs = 0
  ) {}

  isLocked(key: string, now = Date.now()): { locked: boolean; retryAfterSeconds: number } {
    const until = this.lockouts.get(key);
    if (until && until > now) {
      return { locked: true, retryAfterSeconds: Math.ceil((until - now) / 1000) };
    }
    if (until && until <= now) {
      this.lockouts.delete(key);
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  consume(key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const lock = this.isLocked(key, now);
    if (lock.locked) {
      return { allowed: false, remaining: 0, retryAfterSeconds: lock.retryAfterSeconds };
    }

    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.maxAttempts) {
      if (this.lockoutMs > 0) {
        this.lockouts.set(key, now + this.lockoutMs);
      }
      this.hits.set(key, recent);
      const retryMs = this.lockoutMs > 0 ? this.lockoutMs : recent[0] + this.windowMs - now;
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    if (recent.length >= this.maxAttempts && this.lockoutMs > 0) {
      this.lockouts.set(key, now + this.lockoutMs);
    }
    return { allowed: true, remaining: Math.max(0, this.maxAttempts - recent.length), retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.hits.delete(key);
    this.lockouts.delete(key);
  }
}

const SENSITIVE_LOG_KEYS = new Set([
  'password',
  'passwordHash',
  'plaintext',
  'body',
  'messageText',
  'privateKey',
  'totpSecret',
  'totpSecretEnc',
  'token',
  'recoveryCodes',
]);

export function sanitizeLogPayload(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SENSITIVE_LOG_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeLogPayload(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
