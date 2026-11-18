import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Download,
  KeyRound,
  Laptop,
  Lock,
  Radar,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { rrApi } from '../lib/api';
import {
  createEncryptedKeyBackup,
  DeviceKeyVault,
  restoreEncryptedKeyBackup,
  saveVaultToLocal,
} from '../lib/crypto';
import type { DevicePublicInfo, LoginAlertRecord, ShieldScoreData, UserProfile } from '../lib/types';

interface SecurityViewProps {
  token: string;
  user: UserProfile;
  deviceId: string;
  vault: DeviceKeyVault;
  onVaultUpdated: (vault: DeviceKeyVault) => void;
  onUserRefresh: () => Promise<void>;
  onAccountTerminated: () => void;
  onEmergencyLocked?: () => void;
  onOpenDecoy?: () => void;
}

export const SecurityView: React.FC<SecurityViewProps> = ({
  token,
  user,
  deviceId,
  vault,
  onVaultUpdated,
  onUserRefresh,
  onAccountTerminated,
  onEmergencyLocked,
  onOpenDecoy,
}) => {
  const [devices, setDevices] = useState<DevicePublicInfo[]>([]);
  const [alerts, setAlerts] = useState<LoginAlertRecord[]>([]);
  const [shieldScore, setShieldScore] = useState<ShieldScoreData | null>(null);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpInput, setTotpInput] = useState('');
  const [disablePw, setDisablePw] = useState('');
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [duressPinInput, setDuressPinInput] = useState('');
  const [duressBehavior, setDuressBehavior] = useState<'decoy_screen' | 'wipe_and_decoy'>(
    user.duressBehavior ?? 'decoy_screen'
  );
  const [deletePw, setDeletePw] = useState('');
  const [confirmEmergencyModal, setConfirmEmergencyModal] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadSecurityData() {
    const [devRes, alertRes, scoreRes] = await Promise.all([
      rrApi.getDevices(token),
      rrApi.getAlerts(token),
      rrApi.getShieldScore(token),
    ]);
    setDevices(devRes.devices);
    setAlerts(alertRes.alerts);
    setShieldScore(scoreRes);
  }

  useEffect(() => {
    loadSecurityData().catch(() => {});
  }, [token]);

  async function handleStart2FA() {
    setError(null);
    setStatus(null);
    try {
      const res = await rrApi.setup2FA(token);
      setTotpSetup(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize 2FA setup.');
    }
  }

  async function handleVerify2FA(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await rrApi.verify2FA(token, totpInput);
      setTotpSetup(null);
      setTotpInput('');
      setStatus('Two-factor authentication (RFC 6238 TOTP) is now active.');
      await onUserRefresh();
      await loadSecurityData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid TOTP code.');
    }
  }

  async function handleDisable2FA(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await rrApi.disable2FA(token, disablePw);
      setDisablePw('');
      setStatus('Two-factor authentication disabled.');
      await onUserRefresh();
      await loadSecurityData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable 2FA.');
    }
  }

  async function handleSaveDuressPin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await rrApi.setDuressPin(token, duressPinInput, duressBehavior);
      setDuressPinInput('');
      await onUserRefresh();
      await loadSecurityData();
      setStatus(
        `Duress PIN configured (${duressBehavior === 'wipe_and_decoy' ? 'Revoke Other Sessions & Open Decoy' : 'Open App Decoy Screen'}).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Duress PIN must be 4 to 8 digits and differ from Vault PIN.');
    }
  }

  async function handleBackupKeys(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (backupPassphrase.length < 10) {
      setError('Key backup passphrase must be at least 10 characters.');
      return;
    }
    try {
      const payload = await createEncryptedKeyBackup(vault, backupPassphrase);
      await rrApi.uploadKeyBackup(token, payload);
      setBackupPassphrase('');
      await loadSecurityData();
      setStatus('Encrypted key vault backed up with PBKDF2-SHA256 (310,000 iterations) + AES-256-GCM.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Key backup failed.');
    }
  }

  async function handleDownloadBackupJson() {
    try {
      const { backup } = await rrApi.fetchKeyBackup(token);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rrchat1-encrypted-backup-${user.username}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create an encrypted key backup first before exporting JSON.');
    }
  }

  async function handleRestoreKeys(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { backup } = await rrApi.fetchKeyBackup(token);
      const restored = await restoreEncryptedKeyBackup(backup, restorePassphrase);
      saveVaultToLocal(user.username, deviceId, restored);
      onVaultUpdated(restored);
      setRestorePassphrase('');
      setStatus('Private key vault decrypted and restored locally.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decrypt key backup. Verify your passphrase.');
    }
  }

  async function executeEmergencyLock() {
    setError(null);
    try {
      const res = await rrApi.emergencyLock(token);
      setConfirmEmergencyModal(false);
      await onUserRefresh();
      await loadSecurityData();
      setStatus(
        `Panic Lock activated: revoked ${res.revokedSessions} other session(s) and locked message previews.`
      );
      onEmergencyLocked?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger Panic Lock.');
    }
  }

  const activeDevices = devices.filter((d) => d.revokedAt === null || d.revokedAt === undefined);
  const unverifiedDevices = activeDevices.filter((d) => !d.verifiedByUser);

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="max-w-5xl space-y-6">
        {/* RR Shield Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2.5">
              <Radar className="w-6 h-6 text-purple-600 dark:text-purple-400" />
              RR Shield · Security Radar &amp; Defense
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              Live Security Score, Panic Lock, Duress PIN, App Decoy, Device Approval, Login Radar, and Encrypted Backups.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onOpenDecoy && (
              <button
                type="button"
                onClick={onOpenDecoy}
                className="inline-flex items-center gap-2 px-3.5 py-2.5 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-700 hover:border-purple-500/60 text-zinc-800 dark:text-zinc-200 whitespace-nowrap shrink-0"
              >
                <Calculator className="w-4 h-4 text-purple-500" />
                Switch to App Decoy
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirmEmergencyModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-xl bg-red-600 hover:bg-red-500 text-white shadow-sm whitespace-nowrap shrink-0"
            >
              <ShieldAlert className="w-4 h-4" />
              Panic Lock
            </button>
          </div>
        </div>

        {/* Emergency Privacy Confirmation Modal */}
        {confirmEmergencyModal && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#0D1018] border border-red-300 dark:border-red-900/70 p-6 space-y-4 shadow-2xl">
              <div className="flex items-center gap-2.5 text-red-600 dark:text-red-400">
                <ShieldAlert className="w-5 h-5" />
                <h2 className="text-base font-semibold">Activate Panic Lock?</h2>
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                This will immediately hide notification previews, hide online presence, kill all other active device
                sessions, and lock this screen until you re-authenticate. Note: Panic Lock cannot erase copies someone
                already saved externally.
              </p>
              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setConfirmEmergencyModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={executeEmergencyLock}
                  className="px-4 py-2 text-xs font-semibold rounded-xl bg-red-600 hover:bg-red-500 text-white"
                >
                  Panic Lock &amp; Kill Sessions
                </button>
              </div>
            </div>
          </div>
        )}

        {/* RR Shield Score & Summary Tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="rr-glass border border-purple-300 dark:border-purple-800/60 rounded-2xl p-4">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">RR Shield Score</div>
            <div className="text-2xl font-semibold font-mono tabular-nums text-purple-600 dark:text-purple-400 mt-1">
              {shieldScore ? `${shieldScore.score}/100` : '--/100'}
            </div>
          </div>
          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">Active Devices</div>
            <div className="text-2xl font-semibold font-mono tabular-nums text-zinc-900 dark:text-zinc-100 mt-1">
              {activeDevices.length}
            </div>
          </div>
          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">Device Approval Queue</div>
            <div
              className={`text-2xl font-semibold font-mono tabular-nums mt-1 ${
                unverifiedDevices.length > 0 ? 'text-amber-500' : 'text-purple-600 dark:text-purple-400'
              }`}
            >
              {unverifiedDevices.length}
            </div>
          </div>
          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">Duress PIN</div>
            <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mt-1.5">
              {user.hasDuressPin ? 'Configured' : 'Not Set'}
            </div>
          </div>
        </div>

        {/* Security Score Check Breakdown */}
        {shieldScore && (
          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">RR Shield Security Posture Breakdown</span>
              <span className="text-xs font-mono text-purple-600 dark:text-purple-400 tabular-nums">
                {shieldScore.score}% hardened
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {shieldScore.checks.map((c) => (
                <div key={c.id} className="flex items-center justify-between p-2.5 rounded-xl bg-white/60 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800">
                  <span className={c.passed ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500'}>
                    {c.passed ? '✓ ' : '○ '}
                    {c.label}
                  </span>
                  <span className="font-mono tabular-nums text-zinc-500">+{c.weight}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {unverifiedDevices.length > 0 && (
          <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800/60 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
            <span>
              <strong>Device Approval Alert:</strong> {unverifiedDevices.length} new device login(s) waiting for
              approval before receiving E2EE trust.
            </span>
          </div>
        )}

        {status && (
          <div className="p-3.5 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/70 text-purple-900 dark:text-purple-200 text-sm">
            {status}
          </div>
        )}
        {error && (
          <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/70 text-red-800 dark:text-red-200 text-sm">
            {error}
          </div>
        )}

        {/* Duress PIN & Screenshot/Phishing Hardening */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form onSubmit={handleSaveDuressPin} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Lock className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                <h2 className="text-base font-semibold">Duress PIN (Emergency Coercion PIN)</h2>
              </div>
              <span className="text-xs font-mono text-purple-600 dark:text-purple-400">
                {user.hasDuressPin ? 'Active' : 'Unset'}
              </span>
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Entering your Duress PIN instead of your Vault PIN immediately opens the discreet Calculator/Notes App Decoy
              screen and records a security alert.
            </p>
            <div className="space-y-2 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="duressBehavior"
                  checked={duressBehavior === 'decoy_screen'}
                  onChange={() => setDuressBehavior('decoy_screen')}
                  className="accent-purple-600"
                />
                <span>Open App Decoy Screen only (keep sessions intact)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="duressBehavior"
                  checked={duressBehavior === 'wipe_and_decoy'}
                  onChange={() => setDuressBehavior('wipe_and_decoy')}
                  className="accent-purple-600"
                />
                <span>Revoke all other sessions + hide previews + open App Decoy Screen</span>
              </label>
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                inputMode="numeric"
                minLength={4}
                maxLength={8}
                required
                value={duressPinInput}
                onChange={(e) => setDuressPinInput(e.target.value.replace(/\D/g, ''))}
                placeholder="4–8 digit Duress PIN"
                className="flex-1 px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs font-mono"
              />
              <button type="submit" className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold">
                Save Duress PIN
              </button>
            </div>
          </form>

          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              <h2 className="text-base font-semibold">Screenshot Privacy &amp; Phishing Protection</h2>
            </div>
            <div className="space-y-3 text-xs">
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <div>
                  <div className="font-medium text-zinc-900 dark:text-zinc-100">Screenshot Privacy Shield</div>
                  <div className="text-zinc-500">Applies selection lock, print-hide CSS &amp; capture key alerts where OS permits</div>
                </div>
                <input
                  type="checkbox"
                  checked={user.screenshotPrivacy ?? true}
                  onChange={async (e) => {
                    setError(null);
                    try {
                      await rrApi.saveFeatures(token, { screenshotPrivacy: e.target.checked });
                      await onUserRefresh();
                      await loadSecurityData();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed to update screenshot privacy setting.');
                    }
                  }}
                  className="w-4 h-4 accent-purple-600 shrink-0"
                />
              </label>
              <label className="flex items-center justify-between gap-4 cursor-pointer">
                <div>
                  <div className="font-medium text-zinc-900 dark:text-zinc-100">Phishing Link Guard</div>
                  <div className="text-zinc-500">Flags IP links, punycode domains &amp; HTTP links before opening</div>
                </div>
                <input
                  type="checkbox"
                  checked={user.phishingProtection ?? true}
                  onChange={async (e) => {
                    setError(null);
                    try {
                      await rrApi.saveFeatures(token, { phishingProtection: e.target.checked });
                      await onUserRefresh();
                      await loadSecurityData();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed to update phishing protection setting.');
                    }
                  }}
                  className="w-4 h-4 accent-purple-600 shrink-0"
                />
              </label>
              <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-[11px] text-amber-800 dark:text-amber-200">
                Important: Screenshot controls, self-destruct timers, or Panic Lock cannot remove content another person
                has already copied or photographed externally.
              </div>
            </div>
          </div>
        </div>

        {/* Current Device Identity Key */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-3">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Current Device Cryptographic Identity
            </h2>
          </div>
          <div className="p-3.5 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 font-mono text-xs text-purple-700 dark:text-purple-300 tabular-nums break-all">
            {vault.fingerprint}
          </div>
        </div>

        {/* Trusted Device System & Sessions */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-zinc-200 dark:border-zinc-800/80 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Device Approval &amp; Session Kill
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Revoking a device kills its bearer session and terminates WebSocket streams immediately.
              </p>
            </div>
          </div>
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800/80">
            {devices.map((dev) => {
              const revoked = dev.revokedAt !== null && dev.revokedAt !== undefined;
              return (
                <div key={dev.deviceId} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm flex-wrap">
                      {dev.platform === 'Android' || dev.platform === 'iOS' ? (
                        <Smartphone className="w-4 h-4 text-zinc-400" />
                      ) : (
                        <Laptop className="w-4 h-4 text-zinc-400" />
                      )}
                      <span className="font-semibold text-zinc-900 dark:text-zinc-100">{dev.deviceName}</span>
                      <span className="text-zinc-400">·</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">{dev.platform}</span>
                      {dev.isCurrent && (
                        <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">· Current Session</span>
                      )}
                      {revoked ? (
                        <span className="text-xs text-red-500 font-medium">· Killed / Revoked</span>
                      ) : dev.verifiedByUser ? (
                        <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">· Approved</span>
                      ) : (
                        <span className="text-xs text-amber-500 font-medium">· Pending Approval</span>
                      )}
                    </div>
                    <div className="font-mono text-xs text-zinc-500">Fingerprint: {dev.fingerprint}</div>
                  </div>

                  {!revoked && (
                    <div className="flex items-center gap-2 shrink-0">
                      {!dev.verifiedByUser && (
                        <button
                          type="button"
                          onClick={async () => {
                            setError(null);
                            try {
                              await rrApi.verifyDevice(token, dev.deviceId);
                              await loadSecurityData();
                              setStatus(`Approved "${dev.deviceName}" as a Trusted Device.`);
                            } catch (err) {
                              setError(err instanceof Error ? err.message : 'Failed to approve device.');
                            }
                          }}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-600 hover:bg-purple-500 text-white whitespace-nowrap"
                        >
                          Approve Device
                        </button>
                      )}
                      {!dev.isCurrent && (
                        <button
                          type="button"
                          onClick={async () => {
                            setError(null);
                            try {
                              await rrApi.revokeDevice(token, dev.deviceId);
                              await loadSecurityData();
                              setStatus(`Killed session for "${dev.deviceName}".`);
                            } catch (err) {
                              setError(err instanceof Error ? err.message : 'Failed to revoke device session.');
                            }
                          }}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-300 dark:border-red-800/70 text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 whitespace-nowrap"
                        >
                          Kill Session
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 2FA & Encrypted Key Backup */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Two-Factor Authentication (TOTP)
              </h2>
            </div>

            {user.totpEnabled ? (
              <form onSubmit={handleDisable2FA} className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-purple-600 dark:text-purple-400">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>TOTP 2FA is active on your account</span>
                </div>
                <input
                  type={user.authProvider && user.authProvider !== 'local' ? 'text' : 'password'}
                  required
                  value={disablePw}
                  onChange={(e) => setDisablePw(e.target.value)}
                  placeholder={
                    user.authProvider && user.authProvider !== 'local'
                      ? 'Type DISABLE, your username, or 6-digit TOTP code'
                      : 'Enter password to disable 2FA'
                  }
                  className="w-full px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100"
                />
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-xl border border-red-300 dark:border-red-800/70 text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
                >
                  Disable 2FA
                </button>
              </form>
            ) : totpSetup ? (
              <form onSubmit={handleVerify2FA} className="space-y-3">
                <div className="p-3 bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl font-mono text-xs text-purple-700 dark:text-purple-300 break-all">
                  {totpSetup.secret}
                </div>
                <input
                  type="text"
                  required
                  maxLength={6}
                  value={totpInput}
                  onChange={(e) => setTotpInput(e.target.value)}
                  placeholder="6-digit code"
                  className="w-full px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm font-mono tabular-nums text-zinc-900 dark:text-zinc-100"
                />
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
                >
                  Verify &amp; Enable 2FA
                </button>
              </form>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
                  Protect logins with RFC 6238 time-based one-time passcodes alongside Argon2id password verification.
                </p>
                <button
                  type="button"
                  onClick={handleStart2FA}
                  className="px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
                >
                  Configure Authenticator 2FA
                </button>
              </div>
            )}
          </div>

          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Encrypted Backup Vault</h2>
              </div>
              <button
                type="button"
                onClick={handleDownloadBackupJson}
                className="inline-flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 hover:underline"
              >
                <Download className="w-3.5 h-3.5" />
                Export JSON
              </button>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              Your private keys are encrypted locally using PBKDF2-SHA256 (310,000 iterations) + AES-256-GCM before
              cloud storage.
            </p>
            <form onSubmit={handleBackupKeys} className="flex gap-2">
              <input
                type="password"
                value={backupPassphrase}
                onChange={(e) => setBackupPassphrase(e.target.value)}
                placeholder="Backup passphrase (min 10 chars)"
                className="flex-1 px-3 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-zinc-100"
              />
              <button
                type="submit"
                className="px-3.5 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white whitespace-nowrap"
              >
                Encrypt &amp; Backup
              </button>
            </form>
            <form onSubmit={handleRestoreKeys} className="flex gap-2">
              <input
                type="password"
                value={restorePassphrase}
                onChange={(e) => setRestorePassphrase(e.target.value)}
                placeholder="Passphrase to restore backup"
                className="flex-1 px-3 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-zinc-100"
              />
              <button
                type="submit"
                className="px-3.5 py-2 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 hover:border-purple-500/50 whitespace-nowrap"
              >
                Restore Vault
              </button>
            </form>
          </div>
        </div>

        {/* Security & Login Alerts */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-zinc-200 dark:border-zinc-800/80 flex items-center justify-between">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Login Radar Alerts</h2>
            <button
              type="button"
              onClick={async () => {
                setError(null);
                try {
                  await rrApi.ackAlerts(token);
                  await loadSecurityData();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Failed to acknowledge alerts.');
                }
              }}
              className="text-xs text-purple-600 dark:text-purple-400 hover:underline"
            >
              Mark All Read
            </button>
          </div>
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800/80">
            {alerts.length === 0 ? (
              <div className="p-5 text-xs text-zinc-500">No recent security events.</div>
            ) : (
              alerts.slice(0, 12).map((a) => (
                <div key={a.id} className="px-5 py-3.5 flex items-center justify-between gap-4 text-xs">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`font-medium ${
                        a.eventType === 'login_blocked_bruteforce' ||
                        a.eventType === 'device_revoked' ||
                        a.eventType === 'emergency_lock' ||
                        a.eventType === 'duress_pin_triggered'
                          ? 'text-amber-500'
                          : 'text-zinc-900 dark:text-zinc-200'
                      }`}
                    >
                      {a.eventType.replace(/_/g, ' ')}
                    </span>
                    <span className="text-zinc-400">·</span>
                    <span className="text-zinc-500 dark:text-zinc-400 truncate">
                      {a.deviceName} ({a.platform}) · {a.ipMasked}
                    </span>
                  </div>
                  <span className="font-mono tabular-nums text-zinc-500 shrink-0">
                    {new Date(a.timestamp).toLocaleString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Account Suspension & Deletion */}
        <div className="rr-glass border border-red-200 dark:border-red-900/50 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertTriangle className="w-5 h-5" />
            <h2 className="text-base font-semibold">Account Freeze &amp; Deletion Controls</h2>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-xs text-zinc-600 dark:text-zinc-400 max-w-xl">
              Suspend your account immediately to terminate all sessions and block logins, or permanently delete your
              account.
            </p>
            <button
              type="button"
              onClick={async () => {
                setError(null);
                try {
                  await rrApi.suspendAccount(token, 'Self-initiated freeze');
                  onAccountTerminated();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Failed to suspend account.');
                }
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl border border-amber-400 dark:border-amber-700/70 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 whitespace-nowrap"
            >
              <Lock className="w-3.5 h-3.5" />
              Suspend Account
            </button>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await rrApi.deleteAccount(token, deletePw);
                onAccountTerminated();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Account deletion failed.');
              }
            }}
            className="pt-3 border-t border-zinc-200 dark:border-zinc-800/80 flex flex-wrap items-center gap-3"
          >
            <input
              type={user.authProvider && user.authProvider !== 'local' ? 'text' : 'password'}
              required
              value={deletePw}
              onChange={(e) => setDeletePw(e.target.value)}
              placeholder={
                user.authProvider && user.authProvider !== 'local'
                  ? 'Type DELETE or your username to permanently delete account'
                  : 'Confirm password to permanently delete account'
              }
              className="flex-1 min-w-[240px] px-3.5 py-2 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-zinc-100"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-red-600 hover:bg-red-500 text-white whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Account Permanently
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
