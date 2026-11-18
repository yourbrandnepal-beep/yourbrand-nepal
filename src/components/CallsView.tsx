import React, { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Phone, PhoneCall, Video } from 'lucide-react';
import { rrApi } from '../lib/api';
import type { CallLogItem, ChatRoomRecord } from '../lib/types';

interface CallsViewProps {
  token: string;
  currentUserId: string;
  rooms: ChatRoomRecord[];
  onStartCallFromRoom: (roomId: string, mode: 'audio' | 'video') => void;
}

export const CallsView: React.FC<CallsViewProps> = ({
  token,
  currentUserId,
  rooms,
  onStartCallFromRoom,
}) => {
  const [calls, setCalls] = useState<CallLogItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    rrApi
      .getCallHistory(token)
      .then((res) => setCalls(res.calls))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  const directRooms = rooms.filter((r) => r.type === 'direct');

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Encrypted Calls</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Peer-to-peer WebRTC voice &amp; video calls encrypted over DTLS-SRTP. Audio and video streams never touch
            server storage.
          </p>
        </div>

        {/* Quick Call Launchers */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Start Encrypted Call
          </div>
          {directRooms.length === 0 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Start a direct conversation in Contacts first to place voice or video calls.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {directRooms.map((room) => {
                const peer = room.members.find((m) => m.id !== currentUserId);
                return (
                  <div
                    key={room.id}
                    className="p-3.5 rounded-xl bg-white/80 dark:bg-zinc-900/80 border border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                        {peer?.displayName ?? 'Direct Peer'}
                      </div>
                      <div className="text-xs font-mono text-zinc-500 truncate">@{peer?.username ?? 'unknown'}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onStartCallFromRoom(room.id, 'audio')}
                        className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-purple-600 hover:text-white text-zinc-700 dark:text-zinc-200 transition-colors"
                        title="Voice Call"
                      >
                        <Phone className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onStartCallFromRoom(room.id, 'video')}
                        className="p-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors"
                        title="Video Call"
                      >
                        <Video className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Call History */}
        <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
            <PhoneCall className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Recent Call Log</h2>
          </div>
          {loading ? (
            <div className="p-6 text-xs text-zinc-500">Loading encrypted call logs...</div>
          ) : calls.length === 0 ? (
            <div className="p-6 text-xs text-zinc-500">
              No voice or video calls logged yet. Launch a call above or from inside any chat header.
            </div>
          ) : (
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800/80">
              {calls.map((c) => (
                <div key={c.id} className="px-5 py-3.5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    {c.direction === 'outgoing' ? (
                      <ArrowUpRight className="w-4 h-4 text-purple-500 shrink-0" />
                    ) : (
                      <ArrowDownLeft className="w-4 h-4 text-zinc-400 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {c.peerDisplayName}{' '}
                        <span className="text-xs font-mono text-zinc-500">@{c.peerUsername}</span>
                      </div>
                      <div className="text-xs text-zinc-500">
                        {c.callMode === 'video' ? 'Video Call' : 'Voice Call'} · {c.status}
                        {c.durationSeconds > 0 ? ` · ${c.durationSeconds}s` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs font-mono tabular-nums text-zinc-500">
                      {new Date(c.createdAt).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      onClick={() => onStartCallFromRoom(c.roomId, c.callMode)}
                      className="p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-purple-500 text-zinc-700 dark:text-zinc-300"
                      title="Call back"
                    >
                      {c.callMode === 'video' ? <Video className="w-3.5 h-3.5" /> : <Phone className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
