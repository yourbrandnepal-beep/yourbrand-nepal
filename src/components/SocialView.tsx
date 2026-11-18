import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Clock,
  Compass,
  Lock,
  Mic,
  MicOff,
  Plus,
  Radio,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  VideoOff,
} from 'lucide-react';
import { rrApi } from '../lib/api';
import type { SocialFeedData, StoryItem, UserProfile, VoiceRoomRecord } from '../lib/types';

interface SocialViewProps {
  token: string;
  user: UserProfile;
  onUserRefresh: () => Promise<void>;
  onNavigateContacts?: () => void;
  socialRevision?: number;
}

type SocialSubTab = 'stories' | 'channels' | 'rooms' | 'polls' | 'nearby';

export const SocialView: React.FC<SocialViewProps> = ({
  token,
  user,
  onUserRefresh,
  onNavigateContacts,
  socialRevision,
}) => {
  const [tab, setTab] = useState<SocialSubTab>('stories');
  const [feed, setFeed] = useState<SocialFeedData>({
    stories: [],
    channels: [],
    voiceRooms: [],
    polls: [],
    activities: [],
    nearbyUsers: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Story form
  const [storyText, setStoryText] = useState('');
  const [storyTheme, setStoryTheme] = useState<StoryItem['theme']>('obsidian_purple');

  // Channel form
  const [chHandle, setChHandle] = useState('');
  const [chTitle, setChTitle] = useState('');
  const [chDesc, setChDesc] = useState('');
  const [chPrivate, setChPrivate] = useState(false);
  const [postDraftByCh, setPostDraftByCh] = useState<Record<string, string>>({});

  // Voice Room / Live Stream form
  const [vrTitle, setVrTitle] = useState('');
  const [vrTopic, setVrTopic] = useState('');
  const [vrLive, setVrLive] = useState(false);
  const [commentByVr, setCommentByVr] = useState<Record<string, string>>({});
  const [togglingMuteRoomId, setTogglingMuteRoomId] = useState<string | null>(null);
  const [localLivePreviewOn, setLocalLivePreviewOn] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);

  // Poll form
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptionsText, setPollOptionsText] = useState('Option A\nOption B\nOption C');

  // Nearby Opt-In
  const [nearbyZone, setNearbyZone] = useState(user.nearbyZoneLabel || 'Kathmandu Valley');

  const loadFeed = useCallback(async () => {
    try {
      const data = await rrApi.getSocialFeed(token);
      setFeed(data);
    } catch {
      // ignore transient error
    }
  }, [token]);

  useEffect(() => {
    loadFeed();
  }, [loadFeed, socialRevision]);

  useEffect(() => {
    return () => {
      previewStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function toggleLocalStreamPreview() {
    if (localLivePreviewOn) {
      previewStreamRef.current?.getTracks().forEach((t) => t.stop());
      previewStreamRef.current = null;
      setLocalLivePreviewOn(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      previewStreamRef.current = stream;
      setLocalLivePreviewOn(true);
      setTimeout(() => {
        if (previewVideoRef.current) previewVideoRef.current.srcObject = stream;
      }, 60);
    } catch {
      setError('Camera/microphone access denied for Live Stream preview.');
    }
  }

  async function handlePublishStory(e: React.FormEvent) {
    e.preventDefault();
    if (!storyText.trim()) return;
    setError(null);
    try {
      await rrApi.createStory(token, storyText.trim(), storyTheme);
      setStoryText('');
      await loadFeed();
      setStatus('24-hour story published.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish story.');
    }
  }

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await rrApi.createChannel(token, {
        handle: chHandle,
        title: chTitle,
        description: chDesc,
        isPrivateCommunity: chPrivate,
      });
      setChHandle('');
      setChTitle('');
      setChDesc('');
      await loadFeed();
      setStatus('Channel / Private Community created.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create channel.');
    }
  }

  async function handleCreateVoiceRoom(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await rrApi.createVoiceRoom(token, {
        title: vrTitle,
        topic: vrTopic,
        isLiveStream: vrLive,
      });
      setVrTitle('');
      setVrTopic('');
      await loadFeed();
      setStatus(vrLive ? 'Live Stream room started.' : 'Group Voice Room opened.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open voice room.');
    }
  }

  async function handleToggleVoiceMute(roomId: string) {
    if (togglingMuteRoomId === roomId) return;
    setError(null);
    setTogglingMuteRoomId(roomId);
    try {
      const res = await rrApi.toggleVoiceRoomMute(token, roomId);
      setFeed((prev) => ({
        ...prev,
        voiceRooms: prev.voiceRooms.map((item) => (item.id === roomId ? res.voiceRoom : item)),
      }));
      const updatedMe = res.voiceRoom.participants.find((p) => p.userId === user.id);
      if (updatedMe) {
        setStatus(updatedMe.muted ? 'Microphone muted in voice room.' : 'Microphone unmuted in voice room.');
      }
      await loadFeed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update microphone status.');
    } finally {
      setTogglingMuteRoomId(null);
    }
  }

  async function handleCreatePoll(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const options = pollOptionsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await rrApi.createPoll(token, pollQuestion, options);
      setPollQuestion('');
      await loadFeed();
      setStatus('Poll launched.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create poll.');
    }
  }

  const storiesDisabled = user.featureSelection?.stories_status === false;
  const communitiesDisabled = user.featureSelection?.private_communities === false;
  const liveDisabled = user.featureSelection?.live_streaming === false;

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="max-w-5xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2.5">
              <Sparkles className="w-6 h-6 text-purple-600 dark:text-purple-400" />
              RR Social &amp; Private Communities
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              24-hour Stories, Private Communities, Public @Channels, Group Voice &amp; Live Rooms, Polls, Friend
              Activity, and Opt-in Nearby Discovery.
            </p>
          </div>
          {onNavigateContacts && (
            <button
              type="button"
              onClick={onNavigateContacts}
              className="px-3.5 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs font-medium text-zinc-800 dark:text-zinc-200 hover:border-purple-500/60"
            >
              QR Code Friend Add
            </button>
          )}
        </div>

        {/* Sub-tab switcher */}
        <div className="flex flex-wrap gap-2">
          {(
            [
              { id: 'stories', label: '24h Stories', icon: Clock },
              { id: 'channels', label: 'Communities & @Channels', icon: Users },
              { id: 'rooms', label: 'Voice Rooms & Live', icon: Radio },
              { id: 'polls', label: 'Polls & Voting', icon: BarChart3 },
              { id: 'nearby', label: 'Activity & Nearby (Opt-in)', icon: Compass },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium border whitespace-nowrap ${
                  tab === item.id
                    ? 'bg-purple-600 text-white border-purple-500'
                    : 'rr-glass border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:border-purple-500/50'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {item.label}
              </button>
            );
          })}
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

        {/* TAB 1: 24-hour Stories */}
        {tab === 'stories' && (
          <div className="space-y-5">
            {storiesDisabled && (
              <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
                Note: Stories &amp; Status is currently toggled off in your 26-Feature Switchboard.
              </div>
            )}
            <form onSubmit={handlePublishStory} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
              <div className="text-sm font-semibold">Post 24-Hour Disappearing Story</div>
              <div className="flex flex-wrap gap-3">
                <input
                  type="text"
                  value={storyText}
                  onChange={(e) => setStoryText(e.target.value)}
                  placeholder="Share an encrypted 24h status update (Nepali or English)..."
                  className="flex-1 min-w-[220px] px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm"
                />
                <select
                  value={storyTheme}
                  onChange={(e) => setStoryTheme(e.target.value as StoryItem['theme'])}
                  className="px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                >
                  <option value="obsidian_purple">Obsidian Purple</option>
                  <option value="chrome_silver">Chrome Silver</option>
                  <option value="neon_violet">Neon Violet</option>
                </select>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold"
                >
                  Share 24h Story
                </button>
              </div>
            </form>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {feed.stories.length === 0 ? (
                <div className="col-span-full rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-8 text-center text-xs text-zinc-500">
                  No active 24-hour stories yet. Post the first update above.
                </div>
              ) : (
                feed.stories.map((st) => {
                  const hoursLeft = Math.max(1, Math.ceil((st.expiresAt - Date.now()) / 3600000));
                  const bgStyle =
                    st.theme === 'chrome_silver'
                      ? 'from-zinc-200 via-zinc-100 to-purple-100 dark:from-zinc-800 dark:via-zinc-900 dark:to-purple-950/60'
                      : st.theme === 'neon_violet'
                        ? 'from-purple-900 via-fuchsia-950 to-zinc-950 text-white'
                        : 'from-[#111320] via-[#19102A] to-[#090B12] text-zinc-100';
                  return (
                    <div
                      key={st.id}
                      className={`rounded-2xl p-5 border border-zinc-300 dark:border-purple-800/50 bg-gradient-to-br ${bgStyle} space-y-3 flex flex-col justify-between`}
                    >
                      <div className="flex items-center justify-between text-xs opacity-80">
                        <span className="font-semibold">@{st.authorUsername}</span>
                        <span className="font-mono tabular-nums">{hoursLeft}h left</span>
                      </div>
                      <p className="text-sm font-medium leading-relaxed py-2">{st.text}</p>
                      <div className="flex items-center gap-2 pt-2 border-t border-white/10">
                        {['🔥', '🔒', '❤️'].map((emoji) => {
                          const count = (st.reactions[emoji] ?? []).length;
                          return (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => {
                                setError(null);
                                rrApi
                                  .reactStory(token, st.id, emoji)
                                  .then(loadFeed)
                                  .catch((err) =>
                                    setError(err instanceof Error ? err.message : 'Failed to react to story.')
                                  );
                              }}
                              className="px-2 py-1 rounded-lg bg-black/25 text-xs hover:bg-black/40"
                            >
                              {emoji} {count > 0 ? count : ''}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* TAB 2: Private Communities & Public @Username Channels */}
        {tab === 'channels' && (
          <div className="space-y-5">
            {communitiesDisabled && (
              <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
                Private Communities feature toggle is currently off in your Feature Switchboard.
              </div>
            )}
            <form onSubmit={handleCreateChannel} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
              <div className="text-sm font-semibold">Create Public @Channel or Private Community</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="text"
                  required
                  value={chHandle}
                  onChange={(e) => setChHandle(e.target.value)}
                  placeholder="@handle (e.g. rr_nepal)"
                  className="px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm font-mono"
                />
                <input
                  type="text"
                  required
                  value={chTitle}
                  onChange={(e) => setChTitle(e.target.value)}
                  placeholder="Channel or Community Title"
                  className="px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm"
                />
                <input
                  type="text"
                  value={chDesc}
                  onChange={(e) => setChDesc(e.target.value)}
                  placeholder="Topic / description"
                  className="px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="inline-flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={chPrivate}
                    onChange={(e) => setChPrivate(e.target.checked)}
                    className="accent-purple-600"
                  />
                  Private Community (Invite / Subscriber Only)
                </label>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Launch Channel
                </button>
              </div>
            </form>

            <div className="space-y-4">
              {feed.channels.length === 0 ? (
                <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-8 text-center text-xs text-zinc-500">
                  No channels or communities created yet.
                </div>
              ) : (
                feed.channels.map((ch) => (
                  <div key={ch.id} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          {ch.isPrivateCommunity && <Lock className="w-3.5 h-3.5 text-purple-500" />}
                          <span className="text-sm font-semibold">{ch.title}</span>
                          <span className="text-xs font-mono text-purple-600 dark:text-purple-400">@{ch.handle}</span>
                        </div>
                        <p className="text-xs text-zinc-500 mt-0.5">
                          {ch.description || 'Broadcast channel'} · {ch.subscriberCount} member(s)
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setError(null);
                          rrApi
                            .toggleSubscribeChannel(token, ch.id)
                            .then(loadFeed)
                            .catch((err) =>
                              setError(err instanceof Error ? err.message : 'Failed to update subscription.')
                            );
                        }}
                        className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold ${
                          ch.isSubscribed
                            ? 'border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
                            : 'bg-purple-600 text-white'
                        }`}
                      >
                        {ch.isSubscribed ? 'Subscribed' : 'Subscribe / Join'}
                      </button>
                    </div>

                    {ch.ownerId === user.id && (
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const txt = (postDraftByCh[ch.id] ?? '').trim();
                          if (!txt) return;
                          setError(null);
                          try {
                            await rrApi.postChannelUpdate(token, ch.id, txt);
                            setPostDraftByCh((p) => ({ ...p, [ch.id]: '' }));
                            await loadFeed();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : 'Failed to broadcast channel update.');
                          }
                        }}
                        className="flex gap-2"
                      >
                        <input
                          type="text"
                          value={postDraftByCh[ch.id] ?? ''}
                          onChange={(e) => setPostDraftByCh((p) => ({ ...p, [ch.id]: e.target.value }))}
                          placeholder="Broadcast update to subscribers..."
                          className="flex-1 px-3 py-1.5 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                        />
                        <button type="submit" className="px-3 py-1.5 rounded-xl bg-purple-600 text-white text-xs font-semibold">
                          Post
                        </button>
                      </form>
                    )}

                    {ch.posts.length > 0 && (
                      <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                        {ch.posts.slice(0, 4).map((p) => (
                          <div key={p.id} className="text-xs p-2.5 rounded-xl bg-white/70 dark:bg-zinc-950/70 border border-zinc-200 dark:border-zinc-800">
                            <div>{p.text}</div>
                            <div className="text-[10px] text-zinc-500 mt-1 font-mono tabular-nums">
                              {new Date(p.createdAt).toLocaleTimeString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* TAB 3: Group Voice Rooms & Live Streaming */}
        {tab === 'rooms' && (
          <div className="space-y-5">
            {liveDisabled && (
              <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
                Live Streaming is currently disabled in your 26-Feature Switchboard.
              </div>
            )}
            <form onSubmit={handleCreateVoiceRoom} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
              <div className="text-sm font-semibold">Open Group Voice Room or Live Stream</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  value={vrTitle}
                  onChange={(e) => setVrTitle(e.target.value)}
                  placeholder="Room Title (e.g. Friday Tech Hangout)"
                  className="px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm"
                />
                <input
                  type="text"
                  value={vrTopic}
                  onChange={(e) => setVrTopic(e.target.value)}
                  placeholder="Session topic"
                  className="px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="inline-flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={vrLive}
                    onChange={(e) => setVrLive(e.target.checked)}
                    className="accent-purple-600"
                  />
                  Enable Live Streaming Video Stage
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleLocalStreamPreview}
                    className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs font-medium inline-flex items-center gap-1.5"
                  >
                    {localLivePreviewOn ? <VideoOff className="w-3.5 h-3.5 text-red-500" /> : <Video className="w-3.5 h-3.5 text-purple-500" />}
                    {localLivePreviewOn ? 'Stop Camera Preview' : 'Test Live Camera'}
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold"
                  >
                    Start Room
                  </button>
                </div>
              </div>
              {localLivePreviewOn && (
                <video
                  ref={previewVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full max-w-md aspect-video rounded-xl bg-black border border-purple-500/50 object-cover"
                />
              )}
            </form>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {feed.voiceRooms.length === 0 ? (
                <div className="col-span-full rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-8 text-center text-xs text-zinc-500">
                  No active Voice Rooms or Live Streams right now.
                </div>
              ) : (
                feed.voiceRooms.map((vr: VoiceRoomRecord) => {
                  const me = vr.participants.find((p) => p.userId === user.id);
                  return (
                    <div key={vr.id} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <Radio className="w-4 h-4 text-purple-500" />
                            <span className="text-sm font-semibold">{vr.title}</span>
                          </div>
                          <p className="text-xs text-zinc-500 mt-0.5">
                            {vr.isLiveStream ? 'Live Stream Stage' : 'Group Voice Room'} · {vr.topic}
                          </p>
                        </div>
                        {me ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleToggleVoiceMute(vr.id)}
                              disabled={togglingMuteRoomId === vr.id}
                              aria-label={me.muted ? 'Unmute microphone' : 'Mute microphone'}
                              aria-pressed={me.muted}
                              className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-purple-500/60 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                              title={me.muted ? 'Unmute mic' : 'Mute mic'}
                            >
                              {me.muted ? <MicOff className="w-3.5 h-3.5 text-amber-500" /> : <Mic className="w-3.5 h-3.5 text-purple-500" />}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setError(null);
                                rrApi
                                  .leaveVoiceRoom(token, vr.id)
                                  .then(loadFeed)
                                  .catch((err) =>
                                    setError(err instanceof Error ? err.message : 'Failed to leave voice room.')
                                  );
                              }}
                              className="px-2.5 py-1 rounded-lg border border-red-300 dark:border-red-800 text-red-500 text-xs whitespace-nowrap"
                            >
                              Leave
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setError(null);
                              rrApi
                                .joinVoiceRoom(token, vr.id)
                                .then(loadFeed)
                                .catch((err) =>
                                  setError(err instanceof Error ? err.message : 'Failed to join voice room.')
                                );
                            }}
                            className="px-3 py-1.5 rounded-xl bg-purple-600 text-white text-xs font-semibold whitespace-nowrap"
                          >
                            Join
                          </button>
                        )}
                      </div>

                      <div className="space-y-2">
                        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                          Listeners &amp; Speakers ({vr.participants.length})
                        </div>
                        {vr.participants.length === 0 ? (
                          <div className="text-xs text-zinc-500 py-2 px-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/40 dark:bg-zinc-950/40">
                            No active participants in this room yet.
                          </div>
                        ) : (
                          <ul className="divide-y divide-zinc-200/80 dark:divide-zinc-800/80 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-950/60">
                            {vr.participants.map((p) => {
                              const isSelf = p.userId === user.id;
                              const isHost = p.userId === vr.hostId;
                              return (
                                <li
                                  key={p.userId}
                                  className="px-3 py-2 flex items-center justify-between gap-3 text-xs"
                                >
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    {p.muted ? (
                                      <MicOff className="w-3.5 h-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                                    ) : (
                                      <Mic className="w-3.5 h-3.5 shrink-0 text-purple-500" aria-hidden="true" />
                                    )}
                                    <div className="min-w-0">
                                      <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                                        {p.displayName || `@${p.username}`}
                                      </div>
                                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono truncate">
                                        @{p.username}
                                        {isHost ? ' · Host' : ''}
                                        {isSelf ? ' · You' : ''}
                                        {' · '}
                                        {p.muted ? 'Muted' : 'Mic live'}
                                      </div>
                                    </div>
                                  </div>
                                  {isSelf && (
                                    <button
                                      type="button"
                                      onClick={() => handleToggleVoiceMute(vr.id)}
                                      disabled={togglingMuteRoomId === vr.id}
                                      aria-pressed={p.muted}
                                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium whitespace-nowrap shrink-0 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 ${
                                        p.muted
                                          ? 'border-amber-400/70 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40'
                                          : 'border-purple-400/70 dark:border-purple-700 text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/40'
                                      }`}
                                    >
                                      {p.muted ? (
                                        <>
                                          <Mic className="w-3 h-3" />
                                          Unmute
                                        </>
                                      ) : (
                                        <>
                                          <MicOff className="w-3 h-3" />
                                          Mute
                                        </>
                                      )}
                                    </button>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>

                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const txt = (commentByVr[vr.id] ?? '').trim();
                          if (!txt) return;
                          setError(null);
                          try {
                            await rrApi.commentVoiceRoom(token, vr.id, txt);
                            setCommentByVr((c) => ({ ...c, [vr.id]: '' }));
                            await loadFeed();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : 'Failed to send voice room comment.');
                          }
                        }}
                        className="flex gap-2"
                      >
                        <input
                          type="text"
                          value={commentByVr[vr.id] ?? ''}
                          onChange={(e) => setCommentByVr((c) => ({ ...c, [vr.id]: e.target.value }))}
                          placeholder="Live chat comment..."
                          className="flex-1 px-3 py-1.5 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                        />
                        <button type="submit" className="p-2 rounded-xl bg-purple-600 text-white">
                          <Send className="w-3.5 h-3.5" />
                        </button>
                      </form>

                      {vr.liveComments.length > 0 && (
                        <div className="max-h-28 overflow-y-auto space-y-1 text-xs bg-white/60 dark:bg-zinc-950/60 p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800">
                          {vr.liveComments.slice(-6).map((c) => (
                            <div key={c.id}>
                              <span className="font-mono text-purple-600 dark:text-purple-400">@{c.username}: </span>
                              <span>{c.text}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* TAB 4: Polls & Voting */}
        {tab === 'polls' && (
          <div className="space-y-5">
            <form onSubmit={handleCreatePoll} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
              <div className="text-sm font-semibold">Create Anonymous / Community Poll</div>
              <input
                type="text"
                required
                value={pollQuestion}
                onChange={(e) => setPollQuestion(e.target.value)}
                placeholder="Ask a question..."
                className="w-full px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm"
              />
              <textarea
                rows={3}
                value={pollOptionsText}
                onChange={(e) => setPollOptionsText(e.target.value)}
                placeholder="One option per line..."
                className="w-full px-3.5 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold"
              >
                Publish Poll
              </button>
            </form>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {feed.polls.map((poll) => {
                const totalVotes = poll.options.reduce((s, o) => s + o.voterIds.length, 0);
                return (
                  <div key={poll.id} className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold">{poll.question}</div>
                      <span className="text-xs font-mono tabular-nums text-zinc-500">{totalVotes} votes</span>
                    </div>
                    <div className="space-y-2">
                      {poll.options.map((opt) => {
                        const pct = totalVotes > 0 ? Math.round((opt.voterIds.length / totalVotes) * 100) : 0;
                        const voted = opt.voterIds.includes(user.id);
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => {
                              setError(null);
                              rrApi
                                .votePoll(token, poll.id, opt.id)
                                .then(loadFeed)
                                .catch((err) => setError(err instanceof Error ? err.message : 'Failed to cast vote.'));
                            }}
                            className={`w-full text-left p-2.5 rounded-xl border text-xs relative overflow-hidden ${
                              voted
                                ? 'border-purple-500 bg-purple-50/70 dark:bg-purple-950/30'
                                : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950'
                            }`}
                          >
                            <div
                              className="absolute inset-y-0 left-0 bg-purple-500/15"
                              style={{ width: `${pct}%` }}
                            />
                            <div className="relative flex items-center justify-between gap-2">
                              <span className="font-medium">{opt.label}</span>
                              <span className="font-mono tabular-nums text-zinc-500">{pct}%</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 5: Friend Activity & Opt-In Nearby Discovery */}
        {tab === 'nearby' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Compass className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                  <h2 className="text-sm font-semibold">Nearby Friend Discovery (Opt-In Only)</h2>
                </div>
                <span className="text-xs font-mono text-purple-600 dark:text-purple-400">
                  {user.nearbyDiscoveryEnabled ? 'Enabled (Opted In)' : 'Off by Default'}
                </span>
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                Off by default for maximum privacy. When enabled, you can discover other users who explicitly opted in
                around the same zone label—GPS coordinates are never required or stored.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={nearbyZone}
                  onChange={(e) => setNearbyZone(e.target.value)}
                  placeholder="Approximate Zone Label (e.g. Kathmandu)"
                  className="flex-1 min-w-[180px] px-3 py-2 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                />
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      const nextState = !user.nearbyDiscoveryEnabled;
                      await rrApi.saveFeatures(token, {
                        nearbyDiscoveryEnabled: nextState,
                        nearbyZoneLabel: nearbyZone,
                      });
                      await onUserRefresh();
                      await loadFeed();
                      setStatus(nextState ? 'Nearby Discovery enabled (Opt-in).' : 'Nearby Discovery disabled.');
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed to update nearby discovery setting.');
                    }
                  }}
                  className={`px-3.5 py-2 rounded-xl text-xs font-semibold ${
                    user.nearbyDiscoveryEnabled
                      ? 'border border-red-300 dark:border-red-800 text-red-500'
                      : 'bg-purple-600 text-white'
                  }`}
                >
                  {user.nearbyDiscoveryEnabled ? 'Turn Off Nearby' : 'Opt In Now'}
                </button>
              </div>

              {user.nearbyDiscoveryEnabled && (
                <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                  {feed.nearbyUsers.length === 0 ? (
                    <div className="text-xs text-zinc-500">No other opted-in nearby users right now.</div>
                  ) : (
                    feed.nearbyUsers.map((nu) => (
                      <div key={nu.id} className="p-3 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-xs">
                        <div>
                          <div className="font-semibold flex items-center gap-1.5">
                            {nu.displayName}
                            {nu.badge === 'verified_node' && <ShieldCheck className="w-3.5 h-3.5 text-purple-500" />}
                          </div>
                          <div className="font-mono text-zinc-500">@{nu.username} · {nu.zoneLabel}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                <h2 className="text-sm font-semibold">Friend Activity Feed</h2>
              </div>
              <p className="text-xs text-zinc-500">
                Respects privacy presence settings—users with &quot;Hide Online Presence&quot; never broadcast activity here.
              </p>
              <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {feed.activities.length === 0 ? (
                  <div className="py-6 text-center text-xs text-zinc-500">No friend activity entries yet.</div>
                ) : (
                  feed.activities.map((a) => (
                    <div key={a.id} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                      <span>
                        <strong className="font-mono text-purple-600 dark:text-purple-400">@{a.username}</strong>{' '}
                        {a.action}
                      </span>
                      <span className="font-mono tabular-nums text-zinc-500 shrink-0">
                        {new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
