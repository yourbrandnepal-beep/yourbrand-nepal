import React, { useState } from 'react';
import { Download, HardDrive, Share, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../lib/usePWA';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className={
          compact
            ? 'inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500'
            : 'w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2 rounded-xl bg-purple-600/15 hover:bg-purple-600/25 border border-purple-500/40 text-xs font-semibold text-purple-700 dark:text-purple-300 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500'
        }
        title="Install RRchat 1 for offline access"
      >
        <Download className="w-4 h-4 shrink-0" />
        <span className={compact ? 'inline' : 'hidden lg:inline'}>Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className={
            compact
              ? 'inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:border-purple-500/60 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500'
              : 'w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:border-purple-500/60 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500'
          }
          title="Add RRchat 1 to Home Screen on iOS"
        >
          <Share className="w-4 h-4 shrink-0" />
          <span className={compact ? 'inline' : 'hidden lg:inline'}>Install on iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800 p-6 shadow-2xl space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  Install on iPhone or iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close installation guide"
                  className="p-1 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ol className="space-y-2 text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed list-decimal list-inside">
                <li>
                  Tap the <strong>Share</strong> button in the Safari toolbar.
                </li>
                <li>
                  Scroll down and tap <strong>Add to Home Screen</strong>.
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full rounded-xl bg-purple-600 hover:bg-purple-500 py-2 text-xs font-semibold text-white whitespace-nowrap"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

interface OfflineIndicatorProps {
  cachedRoomCount?: number;
  lastSyncedAt?: number | null;
}

export const OfflineIndicator: React.FC<OfflineIndicatorProps> = ({
  cachedRoomCount = 0,
  lastSyncedAt = null,
}) => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  const syncLabel = lastSyncedAt
    ? new Date(lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="px-4 py-2 bg-amber-50 dark:bg-amber-950/60 border-b border-amber-300 dark:border-amber-800/70 text-xs text-amber-950 dark:text-amber-200 flex flex-wrap items-center justify-between gap-3 shrink-0"
    >
      <div className="flex items-center gap-2 min-w-0">
        <WifiOff className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="font-medium">
          Offline Mode — Serving cached session &amp; {cachedRoomCount} chat room(s) from local storage
          {syncLabel ? ` · Last synced ${syncLabel}` : ''}
        </span>
      </div>
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-amber-800 dark:text-amber-300 shrink-0">
        <HardDrive className="w-3 h-3" />
        IndexedDB Cache Active
      </span>
    </div>
  );
};
