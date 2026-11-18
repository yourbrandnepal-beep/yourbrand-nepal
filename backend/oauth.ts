import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OAuthProviderId } from './store.ts';

export type ThirdPartyOAuthProvider = Exclude<OAuthProviderId, 'google'>;

export interface VerifiedOAuthIdentity {
  provider: OAuthProviderId;
  subject: string;
  displayName: string;
  preferredUsername: string;
  email?: string | null;
}

interface GoogleCertCache {
  certs: Record<string, string>;
  expiresAt: number;
}

let googleCertCache: GoogleCertCache = { certs: {}, expiresAt: 0 };

function getFirebaseProjectId(): string {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { projectId?: string };
      if (parsed.projectId) return parsed.projectId;
    }
  } catch {
    // ignore
  }
  return process.env.FIREBASE_PROJECT_ID || 'gen-lang-client-0179248652';
}

function decodeBase64UrlJson<T>(segment: string): T {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as T;
}

async function fetchGoogleSecureTokenCerts(): Promise<Record<string, string>> {
  if (Date.now() < googleCertCache.expiresAt && Object.keys(googleCertCache.certs).length > 0) {
    return googleCertCache.certs;
  }
  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) {
    throw new Error(`Unable to fetch Google token signing certificates (${res.status}).`);
  }
  const certs = (await res.json()) as Record<string, string>;
  const cc = res.headers.get('cache-control') || '';
  const match = cc.match(/max-age=(\d+)/i);
  const maxAgeSec = match ? Number(match[1]) : 3600;
  googleCertCache = {
    certs,
    expiresAt: Date.now() + Math.max(60, maxAgeSec) * 1000,
  };
  return certs;
}

export async function verifyFirebaseGoogleIdToken(idToken: string): Promise<VerifiedOAuthIdentity> {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token.');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(headerB64);
  const payload = decodeBase64UrlJson<{
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  }>(payloadB64);

  const projectId = getFirebaseProjectId();
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Google ID token algorithm.');
  }

  const certs = await fetchGoogleSecureTokenCerts();
  const certPem = certs[header.kid];
  if (!certPem) {
    throw new Error('Unknown Google token signing key.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const sigBuf = Buffer.from(
    signatureB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(signatureB64.length / 4) * 4, '='),
    'base64'
  );
  if (!verifier.verify(certPem, sigBuf)) {
    throw new Error('Invalid Google ID token cryptographic signature.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) {
    throw new Error('Google ID token audience mismatch.');
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Google ID token issuer mismatch.');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Google ID token subject missing.');
  }
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Google ID token has expired.');
  }
  if (!payload.iat || payload.iat > nowSec + 300) {
    throw new Error('Google ID token issued-at timestamp invalid.');
  }

  const emailLocal = payload.email ? payload.email.split('@')[0] : '';
  const displayName = (payload.name || emailLocal || 'Google User').trim().slice(0, 48);
  const preferredUsername = emailLocal || displayName || `g_${payload.sub.slice(0, 8)}`;

  return {
    provider: 'google',
    subject: payload.sub,
    displayName,
    preferredUsername,
    email: payload.email ?? null,
  };
}

export interface ThirdPartyProviderMeta {
  provider: ThirdPartyOAuthProvider;
  label: string;
  configured: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  requiredEnv: [string, string];
  authBaseUrl: string;
  scopes: string;
  dashboardUrl: string;
}

export function getAppBaseUrl(reqOrigin?: string): string {
  const configured = (process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured && !configured.includes('MY_APP_URL')) {
    return configured;
  }
  if (reqOrigin) {
    return reqOrigin.replace(/\/$/, '');
  }
  return 'http://localhost:3000';
}

export function getThirdPartyProviderMeta(
  provider: ThirdPartyOAuthProvider,
  reqOrigin?: string
): ThirdPartyProviderMeta {
  const appBase = getAppBaseUrl(reqOrigin);
  const redirectUri = `${appBase}/auth/oauth/${provider}/callback`;

  if (provider === 'facebook') {
    const clientId = (process.env.FACEBOOK_CLIENT_ID || '').trim();
    const clientSecret = (process.env.FACEBOOK_CLIENT_SECRET || '').trim();
    return {
      provider: 'facebook',
      label: 'Facebook',
      configured: Boolean(clientId && clientSecret),
      clientId,
      clientSecret,
      redirectUri,
      requiredEnv: ['FACEBOOK_CLIENT_ID', 'FACEBOOK_CLIENT_SECRET'],
      authBaseUrl: 'https://www.facebook.com/v20.0/dialog/oauth',
      scopes: 'email,public_profile',
      dashboardUrl: 'https://developers.facebook.com/apps/',
    };
  }

  if (provider === 'github') {
    const clientId = (process.env.GITHUB_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GITHUB_CLIENT_SECRET || '').trim();
    return {
      provider: 'github',
      label: 'GitHub',
      configured: Boolean(clientId && clientSecret),
      clientId,
      clientSecret,
      redirectUri,
      requiredEnv: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
      authBaseUrl: 'https://github.com/login/oauth/authorize',
      scopes: 'read:user user:email',
      dashboardUrl: 'https://github.com/settings/developers',
    };
  }

  const clientId = (process.env.DISCORD_CLIENT_ID || '').trim();
  const clientSecret = (process.env.DISCORD_CLIENT_SECRET || '').trim();
  return {
    provider: 'discord',
    label: 'Discord',
    configured: Boolean(clientId && clientSecret),
    clientId,
    clientSecret,
    redirectUri,
    requiredEnv: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
    authBaseUrl: 'https://discord.com/oauth2/authorize',
    scopes: 'identify email',
    dashboardUrl: 'https://discord.com/developers/applications',
  };
}

export async function exchangeThirdPartyCodeForIdentity(
  provider: ThirdPartyOAuthProvider,
  code: string,
  meta: ThirdPartyProviderMeta
): Promise<VerifiedOAuthIdentity> {
  if (!meta.clientId || !meta.clientSecret) {
    throw new Error(`${meta.label} OAuth is not configured.`);
  }

  if (provider === 'facebook') {
    const tokenParams = new URLSearchParams({
      client_id: meta.clientId,
      client_secret: meta.clientSecret,
      redirect_uri: meta.redirectUri,
      code,
    });
    const tokenRes = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?${tokenParams.toString()}`);
    if (!tokenRes.ok) {
      throw new Error(`Facebook token exchange failed (${tokenRes.status}).`);
    }
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenJson.access_token) {
      throw new Error('Facebook access token missing.');
    }

    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(tokenJson.access_token)}`
    );
    if (!profileRes.ok) {
      throw new Error(`Facebook profile fetch failed (${profileRes.status}).`);
    }
    const profile = (await profileRes.json()) as { id?: string; name?: string; email?: string };
    if (!profile.id) {
      throw new Error('Facebook user ID missing.');
    }
    const emailLocal = profile.email ? profile.email.split('@')[0] : '';
    const displayName = (profile.name || emailLocal || 'Facebook User').trim().slice(0, 48);
    return {
      provider: 'facebook',
      subject: profile.id,
      displayName,
      preferredUsername: emailLocal || displayName || `fb_${profile.id.slice(-8)}`,
      email: profile.email ?? null,
    };
  }

  if (provider === 'github') {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: meta.clientId,
        client_secret: meta.clientSecret,
        code,
        redirect_uri: meta.redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`GitHub token exchange failed (${tokenRes.status}).`);
    }
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenJson.access_token) {
      throw new Error('GitHub access token missing.');
    }

    const profileRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'RRchat-1',
      },
    });
    if (!profileRes.ok) {
      throw new Error(`GitHub profile fetch failed (${profileRes.status}).`);
    }
    const profile = (await profileRes.json()) as {
      id?: number;
      login?: string;
      name?: string;
      email?: string | null;
    };
    if (!profile.id) {
      throw new Error('GitHub user ID missing.');
    }
    const displayName = (profile.name || profile.login || 'GitHub User').trim().slice(0, 48);
    return {
      provider: 'github',
      subject: String(profile.id),
      displayName,
      preferredUsername: profile.login || displayName || `gh_${profile.id}`,
      email: profile.email ?? null,
    };
  }

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: meta.clientId,
      client_secret: meta.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: meta.redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Discord token exchange failed (${tokenRes.status}).`);
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new Error('Discord access token missing.');
  }

  const profileRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!profileRes.ok) {
    throw new Error(`Discord profile fetch failed (${profileRes.status}).`);
  }
  const profile = (await profileRes.json()) as {
    id?: string;
    username?: string;
    global_name?: string | null;
    email?: string | null;
  };
  if (!profile.id) {
    throw new Error('Discord user ID missing.');
  }
  const displayName = (profile.global_name || profile.username || 'Discord User').trim().slice(0, 48);
  return {
    provider: 'discord',
    subject: profile.id,
    displayName,
    preferredUsername: profile.username || displayName || `dc_${profile.id.slice(-8)}`,
    email: profile.email ?? null,
  };
}

export function deriveUniqueOAuthUsername(
  preferred: string,
  provider: OAuthProviderId,
  usernameIndex: Record<string, string>
): string {
  let base = preferred
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 18);

  if (base.length < 3 || !/^[a-zA-Z0-9]/.test(base)) {
    base = `${provider.slice(0, 2)}_${base || 'user'}`.slice(0, 18);
  }
  if (!usernameIndex[base]) {
    return base;
  }
  for (let i = 0; i < 20; i++) {
    const suffix = crypto.randomInt(100, 9999);
    const candidate = `${base.slice(0, 18)}_${suffix}`;
    if (!usernameIndex[candidate]) {
      return candidate;
    }
  }
  return `${base.slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
}
