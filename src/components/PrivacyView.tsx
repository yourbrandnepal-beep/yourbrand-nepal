import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BellOff,
  Download,
  ExternalLink,
  EyeOff,
  FileLock2,
  Gamepad2,
  KeyRound,
  Lock,
  Phone,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  UserCheck,
  Wallet,
} from 'lucide-react';
import { rrApi } from '../lib/api';
import {
  decryptBinaryPayload,
  decryptTextPayload,
  DeviceKeyVault,
  encryptBinaryPayload,
  encryptTextPayload,
} from '../lib/crypto';
import type {
  NotificationSettings,
  PaymentHistoryItem,
  PrivacySettings,
  UserProfile,
  VaultStorageItem,
} from '../lib/types';

interface PrivacyViewProps {
  token: string;
  user: UserProfile;
  vault?: DeviceKeyVault;
  onUserRefresh: () => Promise<void>;
}

const GAMING_PLATFORMS = [
  'PC / Steam',
  'PlayStation',
  'Xbox',
  'Mobile',
  'Riot Games',
  'Nintendo Switch',
];

function sanitizeInviteCode(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(www\.)?(discord\.gg|discord\.com\/invite)\//i, '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 32);
}

async function derivePersonalVaultKey(vault: DeviceKeyVault, userId: string): Promise<CryptoKey> {
  const seed = new TextEncoder().encode(JSON.stringify({ priv: vault.ecdhPrivJwk.d, userId }));
  const hash = await crypto.subtle.digest('SHA-256', seed);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export const PrivacyView: React.FC<PrivacyViewProps> = ({ token, user, vault, onUserRefresh }) => {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio);
  const [contactNumberInput, setContactNumberInput] = useState('');
  const [vaultPinInput, setVaultPinInput] = useState('');
  const [privacy, setPrivacy] = useState<PrivacySettings>(user.privacySettings);
  const [notifications, setNotifications] = useState<NotificationSettings>(user.notificationSettings);

  // RR Vault Personal Encrypted Storage
  const [vaultItems, setVaultItems] = useState<Array<{ raw: VaultStorageItem; name: string; mime: string }>>([]);
  const [vaultBusy, setVaultBusy] = useState(false);

  // Private Gaming & Discord state
  const [gamingPlatform, setGamingPlatform] = useState(user.gamingConnection?.platform || 'PC / Steam');
  const [gamertag, setGamertag] = useState(user.gamingConnection?.gamertag || '');
  const [discordUsername, setDiscordUsername] = useState(user.gamingConnection?.discordUsername || '');
  const [discordInviteInput, setDiscordInviteInput] = useState(
    user.gamingConnection?.discordInviteCode || ''
  );
  const [discordOAuthInfo, setDiscordOAuthInfo] = useState<{
    configured: boolean;
    url?: string;
    redirectUri: string;
  } | null>(null);

  // Private Wallet state
  const [walletBalanceCents, setWalletBalanceCents] = useState<number>(user.walletBalanceCents ?? 0);
  const [walletHistory, setWalletHistory] = useState<PaymentHistoryItem[]>([]);
  const [depositDollars, setDepositDollars] = useState('25');
  const [walletBusy, setWalletBusy] = useState(false);

  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setWalletBalanceCents(user.walletBalanceCents ?? 0);
  }, [user.walletBalanceCents]);

  const loadVaultItems = useCallback(async () => {
    if (!vault) return;
    try {
      const res = await rrApi.getVaultItems(token);
      const aesKey = await derivePersonalVaultKey(vault, user.id);
      const decoded = await Promise.all(
        res.items.map(async (item) => {
          try {
            const metaJson = await decryptTextPayload(aesKey, item.metaEncB64, item.metaIvB64);
            const meta = JSON.parse(metaJson) as { name?: string; mime?: string };
            return { raw: item, name: meta.name || 'Encrypted File', mime: meta.mime || 'application/octet-stream' };
          } catch {
            return { raw: item, name: 'Encrypted Item (Different Device Key)', mime: 'application/octet-stream' };
          }
        })
      );
      setVaultItems(decoded);
    } catch {
      // ignore
    }
  }, [token, vault, user.id]);

  useEffect(() => {
    rrApi
      .getDiscordAuthUrl(token)
      .then((info) => setDiscordOAuthInfo(info))
      .catch(() => {});
    rrApi
      .getWallet(token)
      .then((res) => {
        setWalletBalanceCents(res.balanceCents);
        setWalletHistory(res.history);
      })
      .catch(() => {});
    loadVaultItems();
  }, [token, loadVaultItems]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (
        !event.origin.endsWith('.run.app') &&
        !event.origin.includes('localhost') &&
        !event.origin.includes('127.0.0.1')
      ) {
        return;
      }
      if (event.data?.type === 'DISCORD_OAUTH_SUCCESS') {
        if (typeof event.data.username === 'string' && event.data.username) {
          setDiscordUsername(event.data.username);
        }
        onUserRefresh().catch(() => {});
        setSavedMsg('Discord account connected privately via OAuth2.');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onUserRefresh]);

  async function handleVaultFileUpload(file: File) {
    if (!vault) return;
    setErrorMsg(null);
    setVaultBusy(true);
    try {
      const aesKey = await derivePersonalVaultKey(vault, user.id);
      const buf = new Uint8Array(await file.arrayBuffer());
      const { ciphertextB64, ivB64 } = await encryptBinaryPayload(aesKey, buf);
      const { ciphertextB64: metaEncB64, ivB64: metaIvB64 } = await encryptTextPayload(
        aesKey,
        JSON.stringify({ name: file.name, mime: file.type || 'application/octet-stream' })
      );
      const kind = file.type.startsWith('image/')
        ? 'photo'
        : file.type.startsWith('video/')
          ? 'video'
          : /\.(pdf|doc|docx|txt|md)$/i.test(file.name)
            ? 'doc'
            : 'file';
      await rrApi.uploadVaultItem(token, {
        kind,
        ciphertextB64,
        ivB64,
        metaEncB64,
        metaIvB64,
        sizeBytes: file.size,
      });
      await loadVaultItems();
      setSavedMsg(`Encrypted & locked "${file.name}" inside your RR Vault.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to encrypt file to RR Vault.');
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleDownloadVaultItem(entry: { raw: VaultStorageItem; name: string; mime: string }) {
    if (!vault) return;
    try {
      const aesKey = await derivePersonalVaultKey(vault, user.id);
      const bytes = await decryptBinaryPayload(aesKey, entry.raw.ciphertextB64, entry.raw.ivB64);
      const blob = new Blob([bytes], { type: entry.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setErrorMsg('Unable to decrypt item on this device.');
    }
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    try {
      await rrApi.updateProfile(token, displayName, bio);
      await onUserRefresh();
      setSavedMsg('Profile updated.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update profile.');
    }
  }

  async function saveVaultPin(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    try {
      await rrApi.setVaultPin(token, vaultPinInput);
      setVaultPinInput('');
      await onUserRefresh();
      setSavedMsg('Private Vault App PIN updated. Vault conversations now require PIN verification.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Vault PIN must be 4 to 8 digits.');
    }
  }

  async function savePrivacy(next: PrivacySettings, phone?: string) {
    setErrorMsg(null);
    const prev = privacy;
    setPrivacy(next);
    try {
      await rrApi.updatePrivacy(token, phone !== undefined ? { ...next, contactNumber: phone } : next);
      await onUserRefresh();
      setSavedMsg('Privacy preferences saved.');
      return true;
    } catch (err) {
      setPrivacy(prev);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save privacy settings.');
      return false;
    }
  }

  async function saveContactNumber(e: React.FormEvent) {
    e.preventDefault();
    const ok = await savePrivacy(privacy, contactNumberInput);
    if (ok) {
      setContactNumberInput('');
      setSavedMsg('Private contact number hashed and updated. It remains hidden from all other users.');
    }
  }

  async function saveGamingAndDiscord(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    try {
      const res = await rrApi.updateGamingPrivacy(token, {
        platform: gamingPlatform,
        gamertag,
        discordUsername,
        discordInviteCode: discordInviteInput,
      });
      setDiscordInviteInput(res.gamingConnection.discordInviteCode);
      await onUserRefresh();
      setSavedMsg('Gaming ID and Discord settings saved privately. Nothing is shared in chats or directory.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save gaming & Discord settings.');
    }
  }

  async function handleDeposit(amountDollars: number) {
    const cents = Math.round(amountDollars * 100);
    if (!Number.isFinite(cents) || cents < 100) {
      setErrorMsg('Enter at least $1.00 to add to your private wallet.');
      return;
    }
    setErrorMsg(null);
    setWalletBusy(true);
    try {
      const res = await rrApi.depositWallet(token, cents);
      setWalletBalanceCents(res.balanceCents);
      const refreshed = await rrApi.getWallet(token);
      setWalletHistory(refreshed.history);
      await onUserRefresh();
      setSavedMsg(`Added $${(cents / 100).toFixed(2)} to your private wallet.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Wallet deposit failed.');
    } finally {
      setWalletBusy(false);
    }
  }

  async function setAllPrivate() {
    setErrorMsg(null);
    const prevPrivacy = privacy;
    const prevNotifs = notifications;
    const allPrivate: PrivacySettings = {
      discoverableByUsername: false,
      sendReadReceipts: false,
      hideNotificationPreviews: true,
      allowGroupInvites: false,
      contactNumberVisibility: 'private',
      allowLookupByContactNumber: false,
      hideOnlinePresence: true,
    };
    const allPrivateNotifs: NotificationSettings = {
      ...notifications,
      previewMode: 'none',
    };
    setPrivacy(allPrivate);
    setNotifications(allPrivateNotifs);
    try {
      await Promise.all([
        rrApi.updatePrivacy(token, allPrivate),
        rrApi.updateNotifications(token, allPrivateNotifs),
      ]);
      await onUserRefresh();
      setSavedMsg('All privacy, contact number, gaming, wallet, read receipt, and presence settings locked to Private.');
    } catch (err) {
      setPrivacy(prevPrivacy);
      setNotifications(prevNotifs);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to lock privacy settings.');
    }
  }

  async function saveNotifications(next: NotificationSettings) {
    setErrorMsg(null);
    const prev = notifications;
    setNotifications(next);
    try {
      await rrApi.updateNotifications(token, next);
      await onUserRefresh();
      setSavedMsg('Notification privacy settings saved.');
    } catch (err) {
      setNotifications(prev);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save notification settings.');
    }
  }

  const cleanInviteCode = sanitizeInviteCode(discordInviteInput);

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Private Settings &amp; RR Vault</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              Encrypted file locker, Vault PIN, private contact numbers, gaming profiles, Discord joins, and wallet
              balances stay strictly hidden from all chats and public search.
            </p>
          </div>
          <button
            type="button"
            onClick={setAllPrivate}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white whitespace-nowrap shrink-0"
          >
            <ShieldCheck className="w-4 h-4" />
            Lock All Settings Private
          </button>
        </div>

        {savedMsg && (
          <div className="p-3.5 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/70 text-purple-900 dark:text-purple-200 text-sm">
            {savedMsg}
          </div>
        )}
        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/70 text-red-800 dark:text-red-200 text-sm">
            {errorMsg}
          </div>
        )}

        {/* RR Vault Encrypted File / Photo / Video / Document Storage */}
        {vault && (
          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileLock2 className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  RR Vault · Encrypted Photo, Video, Document &amp; File Locker
                </h2>
              </div>
              <label className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                {vaultBusy ? 'Encrypting...' : 'Lock File in Vault'}
                <input
                  type="file"
                  className="hidden"
                  disabled={vaultBusy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleVaultFileUpload(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Files are encrypted with AES-256-GCM using your local key before upload; the server stores only opaque
              ciphertext blobs.
            </p>
            {vaultItems.length === 0 ? (
              <div className="p-4 rounded-xl bg-white/50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500">
                Your encrypted personal file vault is empty. Upload private photos, videos, documents, or keys above.
              </div>
            ) : (
              <div className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-950/70">
                {vaultItems.map((entry) => (
                  <div key={entry.raw.id} className="px-4 py-3 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{entry.name}</div>
                      <div className="text-[11px] font-mono text-zinc-500 tabular-nums">
                        {entry.raw.kind.toUpperCase()} · {(entry.raw.sizeBytes / 1024).toFixed(1)} KB
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleDownloadVaultItem(entry)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-purple-500"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Decrypt
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          setErrorMsg(null);
                          try {
                            await rrApi.deleteVaultItem(token, entry.raw.id);
                            await loadVaultItems();
                          } catch (err) {
                            setErrorMsg(err instanceof Error ? err.message : 'Failed to delete vault item.');
                          }
                        }}
                        className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                        title="Delete permanently"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Private Vault PIN Protection */}
        <form onSubmit={saveVaultPin} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Private Vault App PIN</h2>
            </div>
            <span className="text-xs font-mono text-purple-600 dark:text-purple-400">
              {user.hasVaultPin ? 'PIN Active' : 'Not Configured'}
            </span>
          </div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Protect hidden Private Vault conversations behind a 4 to 8 digit PIN.
          </p>
          <div className="flex flex-wrap gap-3">
            <input
              type="password"
              inputMode="numeric"
              minLength={4}
              maxLength={8}
              value={vaultPinInput}
              onChange={(e) => setVaultPinInput(e.target.value.replace(/\D/g, ''))}
              placeholder="Enter 4–8 digit Vault PIN"
              className="flex-1 min-w-[200px] px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm font-mono text-zinc-900 dark:text-zinc-100"
            />
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white whitespace-nowrap"
            >
              {user.hasVaultPin ? 'Update Vault PIN' : 'Enable Vault PIN'}
            </button>
          </div>
        </form>

        {/* Private Gaming & Discord Connection */}
        <form
          onSubmit={saveGamingAndDiscord}
          className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Gamepad2 className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Gaming &amp; Discord Connection
              </h2>
            </div>
            <span className="text-xs font-mono text-purple-600 dark:text-purple-400">Visibility: Private Only</span>
          </div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
            Link your gaming handle and Discord server invite inside Private Settings. Other users will never see your
            gaming ID or Discord username inside chats or public search.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">Gaming Platform</label>
              <select
                value={gamingPlatform}
                onChange={(e) => setGamingPlatform(e.target.value)}
                className="w-full px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100"
              >
                {GAMING_PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Gamertag / Player ID
              </label>
              <input
                type="text"
                value={gamertag}
                onChange={(e) => setGamertag(e.target.value)}
                placeholder="Private gamertag"
                className="w-full px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Discord Username {user.gamingConnection?.discordConnectedViaOAuth ? '(Verified via OAuth2)' : ''}
              </label>
              <input
                type="text"
                value={discordUsername}
                onChange={(e) => setDiscordUsername(e.target.value)}
                placeholder="e.g. player_one"
                className="w-full px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Discord Server Invite Link or Code
              </label>
              <input
                type="text"
                value={discordInviteInput}
                onChange={(e) => setDiscordInviteInput(e.target.value)}
                placeholder="discord.gg/your-invite or invite code"
                className="w-full px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm font-mono text-zinc-900 dark:text-zinc-100"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white whitespace-nowrap shrink-0"
            >
              <Save className="w-3.5 h-3.5" />
              Save Gaming &amp; Discord
            </button>

            {cleanInviteCode && (
              <a
                href={`https://discord.gg/${cleanInviteCode}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-white dark:bg-zinc-900 border border-purple-500/60 hover:border-purple-400 text-purple-600 dark:text-purple-300 whitespace-nowrap shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Join Discord Server
              </a>
            )}

            {discordOAuthInfo?.configured && discordOAuthInfo.url ? (
              <a
                href={discordOAuthInfo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-purple-500/60 text-zinc-900 dark:text-zinc-100 whitespace-nowrap shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Connect Discord OAuth2
              </a>
            ) : (
              <span className="text-[11px] text-zinc-500">
                Optional OAuth2 callback:{' '}
                <span className="font-mono text-zinc-600 dark:text-zinc-400">
                  {discordOAuthInfo?.redirectUri ?? '/auth/discord/callback'}
                </span>
              </span>
            )}
          </div>
        </form>

        {/* Private Wallet for Peer-to-Peer Payments */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Wallet className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Private Wallet &amp; Payments
              </h2>
            </div>
            <span className="text-xs font-mono text-purple-600 dark:text-purple-400">Visibility: Private Only</span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
            <div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">Available Private Balance</div>
              <div className="text-2xl font-semibold font-mono tabular-nums text-purple-600 dark:text-purple-400 mt-0.5">
                ${(walletBalanceCents / 100).toFixed(2)}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {[10, 25, 50].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  disabled={walletBusy}
                  onClick={() => handleDeposit(amt)}
                  className="px-3 py-1.5 text-xs font-mono rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-purple-500 text-zinc-800 dark:text-zinc-200 whitespace-nowrap"
                >
                  +${amt}
                </button>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleDeposit(Number(depositDollars));
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="number"
                  min="1"
                  max="10000"
                  step="0.01"
                  value={depositDollars}
                  onChange={(e) => setDepositDollars(e.target.value)}
                  className="w-24 px-2.5 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-xs font-mono text-zinc-900 dark:text-zinc-100"
                />
                <button
                  type="submit"
                  disabled={walletBusy}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 hover:bg-purple-500 text-white whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Funds
                </button>
              </form>
            </div>
          </div>

          {walletHistory.length > 0 && (
            <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl divide-y divide-zinc-200 dark:divide-zinc-800/70 bg-white/60 dark:bg-zinc-950/60">
              {walletHistory.slice(0, 8).map((tx) => (
                <div key={tx.id} className="px-4 py-2.5 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    {tx.direction === 'sent' ? (
                      <ArrowUpRight className="w-3.5 h-3.5 text-amber-500" />
                    ) : (
                      <ArrowDownLeft className="w-3.5 h-3.5 text-purple-500" />
                    )}
                    <span className="text-zinc-800 dark:text-zinc-200">
                      {tx.direction === 'sent' ? `Sent to @${tx.peerUsername}` : `Received from @${tx.peerUsername}`}
                    </span>
                  </div>
                  <span
                    className={`font-mono tabular-nums ${
                      tx.direction === 'sent' ? 'text-amber-600 dark:text-amber-300' : 'text-purple-600 dark:text-purple-400'
                    }`}
                  >
                    {tx.direction === 'sent' ? '-' : '+'}${(tx.amountCents / 100).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Profile */}
        <form onSubmit={saveProfile} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Display Profile (@{user.username})
            </h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">Status / Bio</label>
              <input
                type="text"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Optional short bio"
                className="w-full px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100"
              />
            </div>
          </div>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
          >
            <Save className="w-3.5 h-3.5" />
            Save Profile
          </button>
        </form>

        {/* Private Contact Number */}
        <form onSubmit={saveContactNumber} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Phone className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Private Contact Number</h2>
            </div>
            <span className="text-xs font-mono text-purple-600 dark:text-purple-400">Visibility: Private Only</span>
          </div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
            If you link a contact number, it is SHA-256 hashed on the server and never shared in directory results,
            QR codes, or chat headers. Current stored mask:{' '}
            <span className="font-mono text-zinc-900 dark:text-zinc-200">{user.contactNumberMasked ?? 'None linked'}</span>
          </p>
          <div className="flex flex-wrap gap-3">
            <input
              type="tel"
              value={contactNumberInput}
              onChange={(e) => setContactNumberInput(e.target.value)}
              placeholder="Enter new contact number (or leave blank to clear)"
              className="flex-1 min-w-[220px] px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm font-mono text-zinc-900 dark:text-zinc-100"
            />
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-purple-500/60 text-zinc-900 dark:text-zinc-100 whitespace-nowrap"
            >
              Update Private Number
            </button>
          </div>
        </form>

        {/* Privacy Controls */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl divide-y divide-zinc-200 dark:divide-zinc-800/80">
          <div className="p-5 flex items-center gap-2">
            <EyeOff className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Privacy Settings</h2>
          </div>
          {(
            [
              {
                key: 'allowLookupByContactNumber',
                title: 'Allow Contact Number Lookup (Off = Private)',
                desc: 'Keep unchecked so nobody can look you up using a phone number even if they have it.',
              },
              {
                key: 'hideOnlinePresence',
                title: 'Hide Online Status & Last Seen',
                desc: 'Prevent contacts from seeing when you are actively connected.',
              },
              {
                key: 'discoverableByUsername',
                title: 'Appear in Partial Username Directory',
                desc: 'When off, contacts can still verify you by exact @username or scanning your QR code.',
              },
              {
                key: 'sendReadReceipts',
                title: 'Send Read Receipts',
                desc: 'Inform conversation members when you have decrypted and read their messages.',
              },
              {
                key: 'allowGroupInvites',
                title: 'Allow Group Invitations',
                desc: 'Permit contacts to add your @username to encrypted Smart Rooms.',
              },
              {
                key: 'hideNotificationPreviews',
                title: 'Redact Notification Previews',
                desc: 'Prevent message text or attachment names from appearing on lock screens or OS notifications.',
              },
            ] as const
          ).map((item) => (
            <label key={item.key} className="p-5 flex items-center justify-between gap-6 cursor-pointer">
              <div>
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{item.desc}</div>
              </div>
              <input
                type="checkbox"
                checked={privacy[item.key]}
                onChange={(e) => savePrivacy({ ...privacy, [item.key]: e.target.checked })}
                className="w-4 h-4 accent-purple-600 shrink-0"
              />
            </label>
          ))}
        </div>

        {/* Notification Preview Protection */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <BellOff className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Notification Preview Protection</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex items-center gap-3 p-3.5 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 cursor-pointer">
              <input
                type="radio"
                name="previewMode"
                checked={notifications.previewMode === 'none'}
                onChange={() => saveNotifications({ ...notifications, previewMode: 'none' })}
                className="accent-purple-600"
              />
              <div>
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  Maximum Privacy (&quot;New encrypted message&quot;)
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Hides both sender username and message content.
                </div>
              </div>
            </label>
            <label className="flex items-center gap-3 p-3.5 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 cursor-pointer">
              <input
                type="radio"
                name="previewMode"
                checked={notifications.previewMode === 'sender_only'}
                onChange={() => saveNotifications({ ...notifications, previewMode: 'sender_only' })}
                className="accent-purple-600"
              />
              <div>
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Sender Username Only</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Shows @username without decrypting message text in push alerts.
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Metadata Transparency Table */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-zinc-200 dark:border-zinc-800/80 flex items-center gap-2">
            <Lock className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Server Metadata Transparency</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Even with E2EE enabled, servers must route packets. Here is the exact boundary of what the server sees.
              </p>
            </div>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-100 dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className="py-3 px-5 font-medium">Data Category</th>
                <th className="py-3 px-5 font-medium">Server Visibility</th>
                <th className="py-3 px-5 font-medium">Protection Mechanism</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800/70 text-zinc-700 dark:text-zinc-300">
              <tr>
                <td className="py-3 px-5 font-medium text-zinc-900 dark:text-zinc-100">
                  Vault Files, Contact Number, PINs, Gaming &amp; Wallet
                </td>
                <td className="py-3 px-5 text-purple-600 dark:text-purple-400">Private · Never Exposed</td>
                <td className="py-3 px-5">Client AES-GCM encryption; excluded from directory, QR &amp; chats</td>
              </tr>
              <tr>
                <td className="py-3 px-5 font-medium text-zinc-900 dark:text-zinc-100">
                  Message Text, Photos, Videos, Files &amp; Voice Notes
                </td>
                <td className="py-3 px-5 text-purple-600 dark:text-purple-400">Unreadable Ciphertext Only</td>
                <td className="py-3 px-5">Client-side AES-256-GCM; plaintext rejected at API</td>
              </tr>
              <tr>
                <td className="py-3 px-5 font-medium text-zinc-900 dark:text-zinc-100">Private Keys &amp; Key Backup</td>
                <td className="py-3 px-5 text-purple-600 dark:text-purple-400">Never Leaves Device Unencrypted</td>
                <td className="py-3 px-5">Local Keystore/Keychain/Vault + PBKDF2 wrapped backup</td>
              </tr>
              <tr>
                <td className="py-3 px-5 font-medium text-zinc-900 dark:text-zinc-100">Room Membership &amp; Timestamps</td>
                <td className="py-3 px-5 text-amber-600 dark:text-amber-300">Processed for Routing</td>
                <td className="py-3 px-5">Required by server to deliver messages and enforce disappearing TTL</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
