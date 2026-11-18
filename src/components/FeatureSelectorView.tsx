import React, { useState } from 'react';
import {
  CheckSquare,
  RotateCcw,
  ShieldCheck,
  Sliders,
  Volume2,
} from 'lucide-react';
import { rrApi } from '../lib/api';
import { playNotificationChime } from '../lib/mediaUtils';
import { ALL_26_FEATURES, createDefaultFeatureSelection, type UserProfile } from '../lib/types';

interface FeatureSelectorViewProps {
  token: string;
  user: UserProfile;
  onUserRefresh: () => Promise<void>;
}

const GROUPS = Array.from(new Set(ALL_26_FEATURES.map((f) => f.group)));

export const FeatureSelectorView: React.FC<FeatureSelectorViewProps> = ({ token, user, onUserRefresh }) => {
  const [selection, setSelection] = useState<Record<string, boolean>>(
    () => user.featureSelection ?? createDefaultFeatureSelection()
  );
  const [screenshotPrivacy, setScreenshotPrivacy] = useState<boolean>(user.screenshotPrivacy ?? true);
  const [phishingProtection, setPhishingProtection] = useState<boolean>(user.phishingProtection ?? true);
  const [customSound, setCustomSound] = useState<'crystal' | 'pulse' | 'chime' | 'silent'>(
    user.notificationSettings?.customSound ?? 'crystal'
  );
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedCount = ALL_26_FEATURES.filter((f) => selection[f.id] !== false).length;

  async function persistUpdates(next: {
    featureSelection?: Record<string, boolean>;
    screenshotPrivacy?: boolean;
    phishingProtection?: boolean;
    customSound?: 'crystal' | 'pulse' | 'chime' | 'silent';
  }) {
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      await rrApi.saveFeatures(token, next);
      await onUserRefresh();
      setStatus('Configuration synced to your private account.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save feature configuration.');
    } finally {
      setSaving(false);
    }
  }

  function handleSelectAll() {
    const all = createDefaultFeatureSelection();
    setSelection(all);
    persistUpdates({ featureSelection: all }).catch(() => {});
  }

  function handleResetMinimal() {
    const minimal: Record<string, boolean> = {};
    for (const f of ALL_26_FEATURES) {
      minimal[f.id] = ['private_username_chat', 'end_to_end_encryption', 'private_vault', 'security_radar'].includes(f.id);
    }
    setSelection(minimal);
    persistUpdates({ featureSelection: minimal }).catch(() => {});
  }

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2.5">
              <Sliders className="w-6 h-6 text-purple-600 dark:text-purple-400" />
              RRchat 1 Feature Switchboard
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              Enable or customize all 26 core messaging, security, AI, 3D, social, and power modules.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3.5 py-2 rounded-xl bg-purple-600/15 border border-purple-500/40 text-xs font-mono font-semibold text-purple-600 dark:text-purple-300 tabular-nums">
              {selectedCount} Selected
            </span>
            <button
              type="button"
              disabled={saving}
              onClick={handleSelectAll}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold whitespace-nowrap"
            >
              <CheckSquare className="w-3.5 h-3.5" />
              Select All (सबै छान्नुहोस्)
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={handleResetMinimal}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:border-purple-500/50 whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </button>
          </div>
        </div>

        {status && (
          <div className="p-3 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 text-xs text-purple-900 dark:text-purple-200">
            {status}
          </div>
        )}
        {error && (
          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200">
            {error}
          </div>
        )}

        {/* Custom Notification Sound & Screenshot/Phishing Safeguards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Volume2 className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              Custom Notification Sound
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(['crystal', 'pulse', 'chime', 'silent'] as const).map((snd) => (
                <button
                  key={snd}
                  type="button"
                  onClick={() => {
                    setCustomSound(snd);
                    playNotificationChime(snd);
                    persistUpdates({ customSound: snd }).catch(() => {});
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium border capitalize ${
                    customSound === snd
                      ? 'bg-purple-600 text-white border-purple-500'
                      : 'bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  {snd}
                </button>
              ))}
            </div>
          </div>

          <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              Screenshot &amp; Phishing Controls
            </div>
            <div className="space-y-2 text-xs">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span>Screenshot Privacy deterrence (OS/print protection + capture notice)</span>
                <input
                  type="checkbox"
                  checked={screenshotPrivacy}
                  onChange={(e) => {
                    setScreenshotPrivacy(e.target.checked);
                    persistUpdates({ screenshotPrivacy: e.target.checked }).catch(() => {});
                  }}
                  className="accent-purple-600 w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span>Phishing &amp; suspicious URL scanner in decrypted chats</span>
                <input
                  type="checkbox"
                  checked={phishingProtection}
                  onChange={(e) => {
                    setPhishingProtection(e.target.checked);
                    persistUpdates({ phishingProtection: e.target.checked }).catch(() => {});
                  }}
                  className="accent-purple-600 w-4 h-4"
                />
              </label>
              <p className="text-[11px] text-amber-700 dark:text-amber-300 pt-1">
                Notice: Screenshot controls, Self-Destruct timers, and Panic Lock cannot prevent another user from
                capturing photos or copying content they already saved externally.
              </p>
            </div>
          </div>
        </div>

        {/* 26-Item Interactive Checklist Grouped by Pillar */}
        <div className="space-y-5">
          {GROUPS.map((groupName) => (
            <div key={groupName} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
              <h2 className="text-sm font-semibold text-purple-600 dark:text-purple-400">{groupName}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {ALL_26_FEATURES.filter((f) => f.group === groupName).map((feat) => {
                  const enabled = selection[feat.id] !== false;
                  return (
                    <label
                      key={feat.id}
                      className={`p-3.5 rounded-xl border cursor-pointer transition-colors flex items-start gap-3 ${
                        enabled
                          ? 'bg-purple-50/60 dark:bg-purple-950/25 border-purple-300 dark:border-purple-700/60'
                          : 'bg-white/60 dark:bg-zinc-950/60 border-zinc-200 dark:border-zinc-800 opacity-75'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => {
                          const next = { ...selection, [feat.id]: e.target.checked };
                          setSelection(next);
                          persistUpdates({ featureSelection: next }).catch(() => {});
                        }}
                        className="mt-0.5 w-4 h-4 accent-purple-600 shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{feat.label}</div>
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">
                          {feat.description}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
