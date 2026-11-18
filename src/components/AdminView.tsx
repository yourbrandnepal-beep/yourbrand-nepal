import React, { useEffect, useState } from 'react';
import { Activity, CheckCircle2, Lock, RefreshCw, ShieldAlert, UserX } from 'lucide-react';
import { rrApi } from '../lib/api';
import type { AdminOverviewData } from '../lib/types';

interface AdminViewProps {
  token: string;
  currentUserId: string;
}

export const AdminView: React.FC<AdminViewProps> = ({ token, currentUserId }) => {
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await rrApi.getAdminOverview(token);
      setData(res);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load admin overview.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [token]);

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              Admin &amp; Moderation Console
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              Server telemetry, abuse report triage, account moderation, and security events.
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 hover:border-purple-500/60"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>

        {/* Cryptographic Zero-Plaintext Boundary */}
        <div className="p-4 rounded-2xl bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800/60 flex items-start gap-3">
          <Lock className="w-5 h-5 text-purple-600 dark:text-purple-400 shrink-0 mt-0.5" />
          <div className="text-xs text-purple-950 dark:text-purple-100 leading-relaxed">
            <strong>Cryptographic Boundary:</strong>{' '}
            {data?.cryptographicBoundary ??
              'Administrators cannot access private keys, room keys, or decrypted message plaintext. Only abuse metadata and server health metrics are visible.'}
          </div>
        </div>

        {statusMsg && (
          <div className="p-3 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-800 dark:text-zinc-200">
            {statusMsg}
          </div>
        )}
        {errorMsg && (
          <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200">
            {errorMsg}
          </div>
        )}

        {loading && !data ? (
          <div className="text-sm text-zinc-500">Loading server metrics...</div>
        ) : data ? (
          <>
            {/* Health KPI Grid */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: 'Active WebSockets', value: data.health.activeWebSockets },
                { label: 'Registered Users', value: data.health.totalUsers },
                { label: 'Opaque E2EE Blobs', value: data.health.opaqueCiphertextBlobs },
                { label: 'Open Abuse Reports', value: data.health.openReports },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4"
                >
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">{stat.label}</div>
                  <div className="text-2xl font-semibold font-mono tabular-nums text-zinc-900 dark:text-zinc-100 mt-1">
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Abuse Reports Queue */}
            <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
              <div className="p-5 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Abuse Reports Queue</h2>
              </div>
              {data.reports.length === 0 ? (
                <div className="p-5 text-xs text-zinc-500">No abuse reports submitted.</div>
              ) : (
                <div className="divide-y divide-zinc-200 dark:divide-zinc-800/80">
                  {data.reports.map((r) => (
                    <div key={r.id} className="p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
                      <div className="space-y-1">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">
                          @{r.targetUsername} reported by @{r.reporterUsername}
                          {r.resolved && <span className="ml-2 text-purple-500">· Resolved</span>}
                        </div>
                        <div className="text-zinc-600 dark:text-zinc-400">{r.reason}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {!r.resolved && (
                          <button
                            type="button"
                            onClick={async () => {
                              setErrorMsg(null);
                              try {
                                await rrApi.resolveReport(token, r.id);
                                setStatusMsg(`Marked report on @${r.targetUsername} as resolved.`);
                                await load();
                              } catch (err) {
                                setErrorMsg(err instanceof Error ? err.message : 'Failed to resolve report.');
                              }
                            }}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-purple-500 text-zinc-800 dark:text-zinc-200"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Resolve
                          </button>
                        )}
                        {r.targetId !== currentUserId && (
                          <button
                            type="button"
                            onClick={async () => {
                              setErrorMsg(null);
                              try {
                                await rrApi.moderateUser(token, r.targetId, !r.targetSuspended, r.reason);
                                setStatusMsg(
                                  r.targetSuspended
                                    ? `Restored @${r.targetUsername}.`
                                    : `Suspended @${r.targetUsername}.`
                                );
                                await load();
                              } catch (err) {
                                setErrorMsg(err instanceof Error ? err.message : 'Failed to update user status.');
                              }
                            }}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white"
                          >
                            <UserX className="w-3.5 h-3.5" />
                            {r.targetSuspended ? 'Unsuspend' : 'Suspend'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Metadata User Directory */}
            <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
              <div className="p-5 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
                <Activity className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  Account Metadata Directory ({data.usersDirectory.length})
                </h2>
              </div>
              <div className="divide-y divide-zinc-200 dark:divide-zinc-800/80">
                {data.usersDirectory.map((u) => (
                  <div key={u.id} className="px-5 py-3 flex items-center justify-between gap-4 text-xs">
                    <div>
                      <span className="font-semibold text-zinc-900 dark:text-zinc-100">{u.displayName}</span>
                      <span className="mx-1.5 text-zinc-400">·</span>
                      <span className="font-mono text-zinc-500">@{u.username}</span>
                      <span className="mx-1.5 text-zinc-400">·</span>
                      <span className="text-zinc-500">{u.deviceCount} active device(s)</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={u.suspended ? 'text-red-500 font-medium' : 'text-purple-500 font-medium'}>
                        {u.suspended ? 'Suspended' : 'Active'}
                      </span>
                      {u.id !== currentUserId && (
                        <button
                          type="button"
                          onClick={async () => {
                            setErrorMsg(null);
                            try {
                              await rrApi.moderateUser(token, u.id, !u.suspended);
                              await load();
                            } catch (err) {
                              setErrorMsg(err instanceof Error ? err.message : 'Failed to moderate user.');
                            }
                          }}
                          className="px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:border-purple-500"
                        >
                          {u.suspended ? 'Restore' : 'Suspend'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
};
