import React, { useEffect, useRef, useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Moon,
  ShieldCheck,
  Sun,
  UserPlus,
} from 'lucide-react';
import { rrApi } from '../lib/api';
import { generateDeviceKeyVault, saveVaultToLocal } from '../lib/crypto';
import { googleProvider } from '../lib/firebase';
import type { OAuthProviderId, StoredAccountSession, UserProfile } from '../lib/types';
import { firebaseAuth } from './FirebaseRealtimeSync';
import { Logo3D } from './Logo3D';
import { PWAInstallButton } from './PWAInstallButton';

interface AuthViewProps {
  savedSessions: StoredAccountSession[];
  sessionNotice?: string | null;
  themeMode: 'dark' | 'light';
  onToggleTheme: () => void;
  onSwitchSession: (session: StoredAccountSession) => void;
  onAuthenticated: (payload: {
    token: string;
    deviceId: string;
    user: UserProfile;
  }) => void;
}

type AuthMode = 'login' | 'register' | 'recover';

export const AuthView: React.FC<AuthViewProps> = ({
  savedSessions,
  sessionNotice,
  themeMode,
  onToggleTheme,
  onSwitchSession,
  onAuthenticated,
}) => {
  const oauthPollTimerRef = useRef<number | null>(null);
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [deviceName, setDeviceName] = useState('Web Workstation');
  const [totpCode, setTotpCode] = useState('');
  const [requires2FA, setRequires2FA] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthBusyProvider, setOauthBusyProvider] = useState<OAuthProviderId | null>(null);
  const [oauthConfigNotice, setOauthConfigNotice] = useState<{
    provider: Exclude<OAuthProviderId, 'google'>;
    label: string;
    redirectUri: string;
    requiredEnv: [string, string];
    dashboardUrl?: string;
  } | null>(null);
  const [copiedRedirect, setCopiedRedirect] = useState(false);

  const [pendingAuth, setPendingAuth] = useState<{
    token: string;
    deviceId: string;
    user: UserProfile;
    recoveryCodes: string[];
  } | null>(null);
  const [copiedCodes, setCopiedCodes] = useState(false);

  const passwordChecks = [
    { label: 'At least 12 characters', ok: password.length >= 12 },
    { label: 'Uppercase & lowercase letters', ok: /[A-Z]/.test(password) && /[a-z]/.test(password) },
    { label: 'Number & symbol', ok: /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password) },
    {
      label: 'Does not contain username',
      ok:
        username.trim().length < 3 ||
        !password.toLowerCase().includes(username.trim().toLowerCase().replace(/^@/, '')),
    },
  ];

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const vault = await generateDeviceKeyVault();
      const res = await rrApi.register({
        username,
        password,
        displayName: displayName.trim() || undefined,
        contactNumber: contactNumber.trim() || undefined,
        deviceName,
        platform: 'Web',
        identityPubKeyJwk: vault.identityPubJwk,
        ecdhPubKeyJwk: vault.ecdhPubJwk,
        fingerprint: vault.fingerprint,
      });
      saveVaultToLocal(res.user.username, res.deviceId, vault);
      setPendingAuth(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const cleanUser = username.trim().toLowerCase().replace(/^@/, '');
      const vault = await generateDeviceKeyVault();
      const res = await rrApi.login({
        username: cleanUser,
        password,
        totpCode: requires2FA ? totpCode : undefined,
        deviceName,
        platform: 'Web',
        identityPubKeyJwk: vault.identityPubJwk,
        ecdhPubKeyJwk: vault.ecdhPubJwk,
        fingerprint: vault.fingerprint,
      });
      if (res.requires2FA) {
        setRequires2FA(true);
        setInfo('Two-factor authentication is enabled on this account. Enter your 6-digit authenticator code.');
        setLoading(false);
        return;
      }
      if (res.token && res.deviceId && res.user) {
        saveVaultToLocal(res.user.username, res.deviceId, vault);
        onAuthenticated({ token: res.token, deviceId: res.deviceId, user: res.user });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRecover(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await rrApi.recoverAccount({
        username,
        recoveryCode,
        newPassword: password,
      });
      setInfo(
        `Account recovered (${res.remainingRecoveryCodes} recovery codes remaining). You can now sign in with your new password.`
      );
      setMode('login');
      setRecoveryCode('');
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recovery failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const handleOAuthMessage = async (event: MessageEvent) => {
      const origin = event.origin;
      if (
        origin !== window.location.origin &&
        !origin.endsWith('.run.app') &&
        !origin.includes('localhost')
      ) {
        return;
      }

      if (event.data?.type === 'RRCHAT_OAUTH_ERROR') {
        setOauthBusyProvider(null);
        setError(typeof event.data.error === 'string' ? event.data.error : 'Social sign-in failed.');
        return;
      }

      if (event.data?.type === 'RRCHAT_OAUTH_SUCCESS' && event.data.exchangeCode && event.data.provider) {
        const provider = event.data.provider as Exclude<OAuthProviderId, 'google'>;
        setOauthBusyProvider(provider);
        setError(null);
        try {
          const vault = await generateDeviceKeyVault();
          const res = await rrApi.exchangeOAuthLogin({
            provider,
            exchangeCode: String(event.data.exchangeCode),
            deviceName,
            platform: 'Web',
            identityPubKeyJwk: vault.identityPubJwk,
            ecdhPubKeyJwk: vault.ecdhPubJwk,
            fingerprint: vault.fingerprint,
          });
          saveVaultToLocal(res.user.username, res.deviceId, vault);
          if (res.isNewAccount && res.recoveryCodes?.length) {
            setPendingAuth({
              token: res.token,
              deviceId: res.deviceId,
              user: res.user,
              recoveryCodes: res.recoveryCodes,
            });
          } else {
            onAuthenticated({ token: res.token, deviceId: res.deviceId, user: res.user });
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Unable to complete social authentication.');
        } finally {
          setOauthBusyProvider(null);
        }
      }
    };

    window.addEventListener('message', handleOAuthMessage);
    return () => {
      window.removeEventListener('message', handleOAuthMessage);
      if (oauthPollTimerRef.current !== null) {
        window.clearInterval(oauthPollTimerRef.current);
        oauthPollTimerRef.current = null;
      }
    };
  }, [deviceName, onAuthenticated]);

  async function handleGoogleSignIn() {
    setError(null);
    setInfo(null);
    setOauthConfigNotice(null);
    setOauthBusyProvider('google');
    try {
      const cred = await signInWithPopup(firebaseAuth, googleProvider);
      const idToken = await cred.user.getIdToken();
      const vault = await generateDeviceKeyVault();
      const res = await rrApi.oauthGoogleLogin({
        idToken,
        deviceName,
        platform: 'Web',
        identityPubKeyJwk: vault.identityPubJwk,
        ecdhPubKeyJwk: vault.ecdhPubJwk,
        fingerprint: vault.fingerprint,
      });
      saveVaultToLocal(res.user.username, res.deviceId, vault);
      if (res.isNewAccount && res.recoveryCodes?.length) {
        setPendingAuth({
          token: res.token,
          deviceId: res.deviceId,
          user: res.user,
          recoveryCodes: res.recoveryCodes,
        });
      } else {
        onAuthenticated({ token: res.token, deviceId: res.deviceId, user: res.user });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google Sign-In could not be completed.');
    } finally {
      setOauthBusyProvider(null);
    }
  }

  async function handleThirdPartySignIn(provider: Exclude<OAuthProviderId, 'google'>) {
    setError(null);
    setInfo(null);
    setOauthConfigNotice(null);
    setCopiedRedirect(false);
    setOauthBusyProvider(provider);
    try {
      const res = await rrApi.getOAuthLoginUrl(provider);
      if (!res.configured || !res.url) {
        setOauthConfigNotice({
          provider: res.provider,
          label: res.label,
          redirectUri: res.redirectUri,
          requiredEnv: res.requiredEnv ?? [
            `${provider.toUpperCase()}_CLIENT_ID`,
            `${provider.toUpperCase()}_CLIENT_SECRET`,
          ],
          dashboardUrl: res.dashboardUrl,
        });
        setOauthBusyProvider(null);
        return;
      }

      const authWindow = window.open(res.url, 'rrchat_oauth_popup', 'width=600,height=700');
      if (!authWindow) {
        setOauthBusyProvider(null);
        setError(`Please allow popups for this site to sign in with ${res.label}.`);
        return;
      }

      if (oauthPollTimerRef.current !== null) {
        window.clearInterval(oauthPollTimerRef.current);
      }
      oauthPollTimerRef.current = window.setInterval(() => {
        if (authWindow.closed) {
          if (oauthPollTimerRef.current !== null) {
            window.clearInterval(oauthPollTimerRef.current);
            oauthPollTimerRef.current = null;
          }
          setOauthBusyProvider((current) => (current === provider ? null : current));
        }
      }, 600);
    } catch (err) {
      setOauthBusyProvider(null);
      setError(err instanceof Error ? err.message : `Failed to start ${provider} sign-in.`);
    }
  }

  if (pendingAuth) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-[#06070B] text-zinc-900 dark:text-zinc-100 flex items-center justify-center p-6">
        <div className="w-full max-w-xl rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-600 dark:text-purple-400">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Save Your Single-Use Recovery Codes</h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                @{pendingAuth.user.username} · Argon2id protected · Device keys generated locally
              </p>
            </div>
          </div>

          <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed mb-5">
            RRchat 1 does not require a phone number or email. Store these 8 single-use codes offline. Each code can
            restore account access or lift a security suspension if you lose your password or authenticator.
          </p>

          <div className="grid grid-cols-2 gap-2.5 p-4 bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl font-mono text-sm tabular-nums mb-5">
            {pendingAuth.recoveryCodes.map((code) => (
              <div
                key={code}
                className="px-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-purple-700 dark:text-purple-300"
              >
                {code}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(pendingAuth.recoveryCodes.join('\n'));
                setCopiedCodes(true);
              }}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 hover:border-purple-500/50 transition-colors whitespace-nowrap shrink-0"
            >
              {copiedCodes ? <Check className="w-4 h-4 text-purple-500" /> : <Copy className="w-4 h-4" />}
              {copiedCodes ? 'Copied to Clipboard' : 'Copy Recovery Codes'}
            </button>

            <button
              type="button"
              onClick={() =>
                onAuthenticated({
                  token: pendingAuth.token,
                  deviceId: pendingAuth.deviceId,
                  user: pendingAuth.user,
                })
              }
              className="px-5 py-2.5 text-sm font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white transition-colors whitespace-nowrap shrink-0"
            >
              I Saved My Codes — Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-[#06070B] text-zinc-900 dark:text-zinc-100 flex flex-col justify-between relative overflow-x-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[780px] h-[360px] rounded-full bg-purple-600/10 blur-3xl"
      />

      <header className="w-full max-w-6xl mx-auto px-6 py-5 flex items-center justify-between gap-6 border-b border-zinc-200 dark:border-zinc-800/80 relative z-10">
        <div className="flex items-center gap-3 shrink-0">
          <Logo3D size="badge" />
          <span className="text-lg font-bold tracking-tight font-display whitespace-nowrap shrink-0">RRchat 1</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-xs text-zinc-500 dark:text-zinc-400 hidden sm:flex items-center gap-3">
            <span>Zero-Phone Identity</span>
            <span aria-hidden="true">·</span>
            <span>Client-Side E2EE</span>
            <span aria-hidden="true">·</span>
            <span>3D Identity Studio</span>
          </div>
          <PWAInstallButton compact />
          <button
            type="button"
            onClick={onToggleTheme}
            className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 text-zinc-700 dark:text-zinc-300 hover:border-purple-500/50"
            title={themeMode === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {themeMode === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      <main className="w-full max-w-6xl mx-auto px-6 py-10 lg:py-12 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-start relative z-10">
        <section className="lg:col-span-6 space-y-8 pt-2">
          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
            <Logo3D size="hero" />
            <div className="space-y-3">
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
                Next-generation private social messaging.
              </h1>
              <p className="text-base text-zinc-600 dark:text-zinc-300 leading-relaxed max-w-xl">
                Communicate via unique usernames with 3D cryptographic identities, Ghost Chat, Private Vault, Security
                Radar, and opt-in AI assistance—encrypted locally with ECDH P-256 and AES-256-GCM.
              </p>
            </div>
          </div>

          <div className="divide-y divide-zinc-200 dark:divide-zinc-800/80 border-t border-b border-zinc-200 dark:border-zinc-800/80">
            <div className="py-4 flex items-start gap-3">
              <Lock className="w-5 h-5 text-purple-600 dark:text-purple-400 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold">Zero-Plaintext Server Relay &amp; Private Vault</h2>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                  Plaintext messages are rejected at the API boundary. Lock sensitive conversations inside a PIN-guarded
                  Private Vault.
                </p>
              </div>
            </div>
            <div className="py-4 flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-purple-600 dark:text-purple-400 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold">Security Radar &amp; Emergency Privacy Mode</h2>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                  Approve trusted devices, inspect SHA-256 fingerprints via QR scan, and revoke other sessions in one
                  click.
                </p>
              </div>
            </div>
            <div className="py-4 flex items-start gap-3">
              <UserPlus className="w-5 h-5 text-purple-600 dark:text-purple-400 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold">3D Identity Studio &amp; Cross-Platform Suite</h2>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                  Customize 3D obsidian/silver/neon-purple avatars while keeping contact numbers, gaming IDs, and wallet
                  balances strictly private.
                </p>
              </div>
            </div>
          </div>

          {savedSessions.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Active Browser Sessions</h3>
              <div className="flex flex-wrap gap-2">
                {savedSessions.map((s) => (
                  <button
                    key={`${s.username}-${s.deviceId}`}
                    type="button"
                    onClick={() => onSwitchSession(s)}
                    className="px-3.5 py-2 text-sm rounded-xl rr-glass border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-800 dark:text-zinc-200 transition-colors whitespace-nowrap shrink-0"
                  >
                    Resume @{s.username}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="lg:col-span-6">
          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl">
            <div className="flex items-center gap-1 p-1 bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl mb-6">
              {(
                [
                  { id: 'login', label: 'Sign In' },
                  { id: 'register', label: 'Create Account' },
                  { id: 'recover', label: 'Recover' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setMode(tab.id);
                    setError(null);
                    setInfo(null);
                    setRequires2FA(false);
                  }}
                  className={`flex-1 py-2 px-3 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    mode === tab.id
                      ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-700/80 shadow-sm'
                      : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {(error || sessionNotice) && (
              <div className="mb-5 p-3.5 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/70 text-red-800 dark:text-red-200 text-sm flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <span>{error || sessionNotice}</span>
              </div>
            )}

            {info && (
              <div className="mb-5 p-3.5 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/70 text-purple-900 dark:text-purple-200 text-sm">
                {info}
              </div>
            )}

            <form
              onSubmit={mode === 'register' ? handleRegister : mode === 'recover' ? handleRecover : handleLogin}
              className="space-y-4"
            >
              <div>
                <label htmlFor="auth-username" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  Username
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 font-mono text-sm">@</span>
                  <input
                    id="auth-username"
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="alice_sec"
                    autoComplete="username"
                    className="w-full pl-8 pr-3.5 py-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              {mode === 'register' && (
                <>
                  <div>
                    <label
                      htmlFor="auth-display"
                      className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
                    >
                      Display Name (Optional)
                    </label>
                    <input
                      id="auth-display"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Alice Vance"
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="auth-contact-num"
                      className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
                    >
                      Contact Number (Optional · All Settings Private)
                    </label>
                    <input
                      id="auth-contact-num"
                      type="tel"
                      value={contactNumber}
                      onChange={(e) => setContactNumber(e.target.value)}
                      placeholder="Optional · Never shown publicly"
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm font-mono text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
                    />
                  </div>
                </>
              )}

              {mode === 'recover' && (
                <div>
                  <label
                    htmlFor="auth-recovery-code"
                    className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
                  >
                    Single-Use Recovery Code
                  </label>
                  <input
                    id="auth-recovery-code"
                    type="text"
                    required
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    placeholder="XXXX-XXXX-XXXX"
                    className="w-full px-3.5 py-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm font-mono text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
                  />
                </div>
              )}

              <div>
                <label
                  htmlFor="auth-password"
                  className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
                >
                  {mode === 'recover' ? 'New Strong Password' : 'Password'}
                </label>
                <div className="relative">
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 12 characters"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    className="w-full pl-3.5 pr-10 py-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {(mode === 'register' || mode === 'recover') && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  {passwordChecks.map((chk) => (
                    <div
                      key={chk.label}
                      className={`text-xs flex items-center gap-1.5 ${
                        chk.ok ? 'text-purple-600 dark:text-purple-400' : 'text-zinc-400 dark:text-zinc-500'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5 shrink-0" />
                      <span>{chk.label}</span>
                    </div>
                  ))}
                </div>
              )}

              {mode !== 'recover' && (
                <div>
                  <label
                    htmlFor="auth-device"
                    className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
                  >
                    Device Label
                  </label>
                  <input
                    id="auth-device"
                    type="text"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    placeholder="Workstation Browser"
                    className="w-full px-3.5 py-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
                  />
                </div>
              )}

              {mode === 'login' && requires2FA && (
                <div>
                  <label
                    htmlFor="auth-totp"
                    className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
                  >
                    2FA Authenticator Code
                  </label>
                  <input
                    id="auth-totp"
                    type="text"
                    required
                    maxLength={6}
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    placeholder="123456"
                    className="w-full px-3.5 py-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm font-mono tabular-nums text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={loading || oauthBusyProvider !== null}
                className="w-full py-2.5 px-4 text-sm font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white transition-colors whitespace-nowrap"
              >
                {loading
                  ? 'Deriving Keys & Authenticating...'
                  : mode === 'register'
                    ? 'Create Encrypted Account'
                    : mode === 'recover'
                      ? 'Reset Password with Recovery Code'
                      : requires2FA
                        ? 'Verify 2FA & Sign In'
                        : 'Sign In'}
              </button>
            </form>

            {mode !== 'recover' && (
              <div className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800 space-y-3">
                <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 text-center">
                  Or continue with an existing account
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => void handleGoogleSignIn()}
                    disabled={loading || oauthBusyProvider !== null}
                    className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 hover:border-purple-500/60 text-xs font-semibold text-zinc-800 dark:text-zinc-100 disabled:opacity-50 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#EA4335"
                        d="M12 10.2v3.9h5.5c-.2 1.2-1.4 3.6-5.5 3.6-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.1.8 3.9 1.5l2.6-2.5C16.8 3.1 14.6 2 12 2 6.5 2 2 6.5 2 12s4.5 10 10 10c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-2H12z"
                      />
                    </svg>
                    <span>{oauthBusyProvider === 'google' ? 'Connecting...' : 'Google'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleThirdPartySignIn('facebook')}
                    disabled={loading || oauthBusyProvider !== null}
                    className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 hover:border-purple-500/60 text-xs font-semibold text-zinc-800 dark:text-zinc-100 disabled:opacity-50 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#1877F2"
                        d="M24 12a12 12 0 1 0-13.9 11.9v-8.4H7.1V12h3V9.4c0-3 1.8-4.7 4.5-4.7 1.3 0 2.7.2 2.7.2v3h-1.5c-1.5 0-2 .9-2 1.9V12h3.4l-.5 3.5h-2.9v8.4A12 12 0 0 0 24 12z"
                      />
                    </svg>
                    <span>{oauthBusyProvider === 'facebook' ? 'Connecting...' : 'Facebook'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleThirdPartySignIn('github')}
                    disabled={loading || oauthBusyProvider !== null}
                    className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 hover:border-purple-500/60 text-xs font-semibold text-zinc-800 dark:text-zinc-100 disabled:opacity-50 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                  >
                    <svg className="w-4 h-4 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 .5A11.5 11.5 0 0 0 .5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.2-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11.1 11.1 0 0 1 5.9 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.9 1.2 1.9 1.2 3.2 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z" />
                    </svg>
                    <span>{oauthBusyProvider === 'github' ? 'Connecting...' : 'GitHub'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleThirdPartySignIn('discord')}
                    disabled={loading || oauthBusyProvider !== null}
                    className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 hover:border-purple-500/60 text-xs font-semibold text-zinc-800 dark:text-zinc-100 disabled:opacity-50 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#5865F2"
                        d="M20.3 4.4A19.7 19.7 0 0 0 15.4 3a13.7 13.7 0 0 0-.6 1.3 18.3 18.3 0 0 0-5.6 0A13.7 13.7 0 0 0 8.6 3a19.7 19.7 0 0 0-4.9 1.4C.6 9.1-.2 13.7.2 18.2a19.9 19.9 0 0 0 6 3c.5-.7.9-1.4 1.3-2.1-.7-.3-1.4-.6-2-1 .2-.1.3-.3.5-.4 3.9 1.8 8.1 1.8 12 0 .2.1.3.3.5.4-.6.4-1.3.7-2 1 .4.7.8 1.4 1.3 2.1a19.9 19.9 0 0 0 6-3c.5-5.2-.8-9.8-3.5-13.8zM8.5 15.4c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4zm7 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4z"
                      />
                    </svg>
                    <span>{oauthBusyProvider === 'discord' ? 'Connecting...' : 'Discord'}</span>
                  </button>
                </div>

                {oauthConfigNotice && (
                  <div className="p-3.5 rounded-xl border border-amber-300 dark:border-amber-800/70 bg-amber-50/90 dark:bg-amber-950/40 text-xs text-amber-950 dark:text-amber-200 space-y-2">
                    <div className="font-semibold">
                      {oauthConfigNotice.label} OAuth credentials required
                    </div>
                    <p className="leading-relaxed opacity-90">
                      Google Sign-In works immediately. To enable {oauthConfigNotice.label} sign-in, configure{' '}
                      <code className="font-mono font-semibold">{oauthConfigNotice.requiredEnv[0]}</code> and{' '}
                      <code className="font-mono font-semibold">{oauthConfigNotice.requiredEnv[1]}</code> in AI Studio
                      Secrets and add this Callback URL in your {oauthConfigNotice.label} App settings:
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-2.5 py-1.5 rounded-lg bg-white/80 dark:bg-zinc-950 border border-amber-300/70 dark:border-amber-800 font-mono text-[11px] truncate">
                        {oauthConfigNotice.redirectUri}
                      </code>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(oauthConfigNotice.redirectUri);
                          setCopiedRedirect(true);
                        }}
                        className="px-2.5 py-1.5 rounded-lg border border-amber-400/70 dark:border-amber-700 font-medium whitespace-nowrap shrink-0 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                      >
                        {copiedRedirect ? 'Copied' : 'Copy URI'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="w-full max-w-6xl mx-auto px-6 py-5 border-t border-zinc-200 dark:border-zinc-800/70 flex flex-wrap items-center justify-between gap-4 text-xs text-zinc-500 relative z-10">
        <span>RRchat 1 · Black, Silver &amp; Neon Purple Privacy Architecture</span>
        <span>Open another browser tab or create a second account to test live multi-user E2EE</span>
      </footer>
    </div>
  );
};
