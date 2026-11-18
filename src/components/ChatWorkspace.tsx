import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCheck,
  Clock,
  Columns2,
  Compass,
  DollarSign,
  Download,
  Eye,
  EyeOff,
  FileText,
  Film,
  FolderGit2,
  Gamepad2,
  Ghost,
  Image as ImageIcon,
  KeyRound,
  Languages,
  Lock,
  LogOut,
  Maximize2,
  Menu,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  Palette,
  Paperclip,
  Pencil,
  Phone,
  PhoneIncoming,
  PhoneOff,
  Plus,
  Reply,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Trash2,
  Unlock,
  UserMinus,
  Users,
  Vault,
  Video,
  VideoOff,
  WifiOff,
  X,
} from 'lucide-react';
import { rrApi } from '../lib/api';
import {
  decryptBinaryPayload,
  decryptTextPayload,
  DeviceKeyVault,
  encryptBinaryPayload,
  encryptTextPayload,
  generateRoomKeyBytes,
  importRoomAesKey,
  saveVaultToLocal,
  unwrapRoomKey,
  wrapRoomKeyForDevice,
} from '../lib/crypto';
import {
  scanTextForSuspiciousUrls,
  VOICE_EFFECTS,
  type VoiceEffectId,
} from '../lib/mediaUtils';
import type {
  CallSignalPayload,
  ChatRoomRecord,
  DirectoryUser,
  EncryptedMessageRecord,
  ScheduledMessageItem,
  Sticker3DItem,
  UserProfile,
} from '../lib/types';
import { Logo3D } from './Logo3D';
import { EncryptedVoicePlayer, formatVoiceDuration, VoiceMessageRecorder } from './VoiceMessageRecorder';

interface DecryptedMessageView {
  raw: EncryptedMessageRecord;
  plaintext: string;
  decryptionError: string | null;
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentMime?: string;
  voiceDurationSec?: number;
  voiceEffect?: string;
  stickerData?: Omit<Sticker3DItem, 'id' | 'createdAt'>;
  suspiciousUrls?: Array<{ url: string; reasons: string[] }>;
  paymentData?: {
    amountCents: number;
    currency: string;
    recipientName: string;
    note?: string;
  };
}

interface QueuedOutboxItem {
  id: string;
  roomId: string;
  kind: 'text' | 'sticker';
  ciphertextB64: string;
  ivB64: string;
  replyToId?: string | null;
  createdAt: number;
}

interface IncomingCallState {
  roomId: string;
  fromUserId: string;
  fromDisplayName: string;
  callMode: 'audio' | 'video';
  sdp: RTCSessionDescriptionInit;
}

interface ActiveCallState {
  roomId: string;
  peerUserId: string;
  peerDisplayName: string;
  callMode: 'audio' | 'video';
  status: 'calling' | 'connected';
  startedAt: number;
  muted: boolean;
  cameraOff: boolean;
}

export type WorkspaceNavTarget =
  | 'chats'
  | 'vault'
  | 'calls'
  | 'contacts'
  | 'social'
  | 'cloud'
  | 'ai'
  | 'studio'
  | 'security'
  | 'features'
  | 'privacy'
  | 'admin'
  | 'architecture';

interface ChatWorkspaceProps {
  token: string;
  user: UserProfile;
  deviceId: string;
  vault: DeviceKeyVault;
  onVaultUpdated: (vault: DeviceKeyVault) => void;
  onUserRefresh?: () => Promise<void>;
  rooms: ChatRoomRecord[];
  activeRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onRoomsChanged: () => Promise<void>;
  messagesByRoom: Record<string, EncryptedMessageRecord[]>;
  onMessagesLoaded: (roomId: string, msgs: EncryptedMessageRecord[]) => void;
  onNavigateTab: (tab: WorkspaceNavTarget) => void;
  onLogout: () => void;
  chatBoxOnly: boolean;
  onToggleChatBoxOnly: () => void;
  vaultMode: boolean;
  onToggleVaultMode: (vaultOnly: boolean) => void;
  aiConsentGranted: boolean;
  pendingAiDraft?: string | null;
  onClearAiDraft?: () => void;
  onDecryptedSnippetsChange?: (roomTitle: string, snippets: string[]) => void;
  externalCallRequest?: { roomId: string; mode: 'audio' | 'video' } | null;
  onClearExternalCallRequest?: () => void;
  focusSearchTrigger?: number;
  sendWsSignal: (payload: Record<string, unknown>) => void;
  subscribeCallSignals: (cb: (signal: CallSignalPayload) => void) => () => void;
  onDuressTriggered?: (behavior: 'decoy_screen' | 'wipe_and_decoy') => void;
  splitRoomId?: string | null;
  onSelectSplitRoom?: (roomId: string | null) => void;
}

const CHAT_THEMES = {
  obsidian_neon: {
    label: 'Obsidian Neon',
    viewport: 'bg-zinc-50 dark:bg-[#06070B]',
    mineBubble:
      'bg-gradient-to-br from-purple-600/15 via-fuchsia-600/10 to-purple-500/5 dark:from-purple-950/60 dark:via-[#150E24] dark:to-[#0D1018] border-purple-300 dark:border-purple-600/50',
    peerBubble: 'bg-white dark:bg-[#0D1018] border-zinc-200 dark:border-zinc-800',
  },
  chrome_silver: {
    label: 'Chrome Silver',
    viewport: 'bg-zinc-100 dark:bg-[#090B10]',
    mineBubble:
      'bg-gradient-to-br from-slate-200 to-zinc-100 dark:from-zinc-800/80 dark:to-zinc-900 border-zinc-300 dark:border-zinc-600/60',
    peerBubble: 'bg-white dark:bg-[#11141C] border-zinc-200 dark:border-zinc-700/70',
  },
  hologram_glass: {
    label: 'Hologram 3D',
    viewport: 'bg-gradient-to-b from-purple-50/40 via-zinc-50 to-cyan-50/30 dark:from-[#070612] dark:via-[#06070B] dark:to-[#071018]',
    mineBubble:
      'bg-gradient-to-br from-violet-500/15 to-cyan-500/10 dark:from-violet-900/45 dark:to-cyan-950/40 border-violet-300 dark:border-cyan-500/40',
    peerBubble: 'bg-white/90 dark:bg-[#0B101B]/90 border-zinc-200 dark:border-indigo-900/60',
  },
  midnight_pulse: {
    label: 'Midnight Pulse',
    viewport: 'bg-zinc-50 dark:bg-[#040509]',
    mineBubble:
      'bg-purple-600/15 dark:bg-purple-900/35 border-purple-400/50 dark:border-purple-500/50',
    peerBubble: 'bg-white dark:bg-[#0A0C12] border-zinc-200 dark:border-zinc-800',
  },
} as const;

type ChatThemeId = keyof typeof CHAT_THEMES;

const TRANSLATE_LANGS = ['Nepali', 'English', 'Hindi', 'Japanese', 'Spanish', 'French'] as const;

const Sticker3DGraphic: React.FC<{
  sticker: Omit<Sticker3DItem, 'id' | 'createdAt'>;
  size?: number;
}> = ({ sticker, size = 76 }) => {
  const animClass =
    sticker.animation === 'spin'
      ? 'rr-anim-spin'
      : sticker.animation === 'bounce'
        ? 'rr-anim-bounce'
        : sticker.animation === 'orbit'
          ? 'rr-anim-orbit'
          : 'rr-anim-pulse';

  const shapeEl =
    sticker.shape === 'cube' ? (
      <g>
        <polygon points="50,12 85,31 50,50 15,31" fill={sticker.color} fillOpacity="0.95" />
        <polygon points="15,31 50,50 50,88 15,69" fill={sticker.color} fillOpacity="0.72" />
        <polygon points="85,31 50,50 50,88 85,69" fill={sticker.glowColor} fillOpacity="0.82" />
      </g>
    ) : sticker.shape === 'torus' ? (
      <g>
        <circle cx="50" cy="50" r="32" fill="none" stroke={sticker.color} strokeWidth="14" />
        <circle cx="50" cy="50" r="32" fill="none" stroke={sticker.glowColor} strokeWidth="4" strokeDasharray="16 8" />
      </g>
    ) : sticker.shape === 'prism' ? (
      <g>
        <polygon points="50,10 86,78 50,64" fill={sticker.glowColor} fillOpacity="0.85" />
        <polygon points="50,10 14,78 50,64" fill={sticker.color} fillOpacity="0.95" />
        <polygon points="14,78 86,78 50,64" fill={sticker.color} fillOpacity="0.6" />
      </g>
    ) : (
      <polygon
        points="50,8 61,35 90,37 67,56 75,85 50,69 25,85 33,56 10,37 39,35"
        fill={sticker.color}
        stroke={sticker.glowColor}
        strokeWidth="3"
      />
    );

  return (
    <div className="inline-flex flex-col items-center gap-1 select-none">
      <div
        className={animClass}
        style={{
          width: size,
          height: size,
          filter: `drop-shadow(0 8px 16px ${sticker.glowColor}66)`,
        }}
      >
        <svg viewBox="0 0 100 100" className="w-full h-full">
          {shapeEl}
        </svg>
      </div>
      <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {sticker.label}
      </span>
    </div>
  );
};

const TTL_OPTIONS = [
  { label: 'Ghost Off', value: null },
  { label: '30s', value: 30 },
  { label: '5m', value: 300 },
  { label: '1h', value: 3600 },
  { label: '24h', value: 86400 },
];

const QUICK_REACTIONS = ['👍', '🔒', '✅', '❤️'];

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({
  token,
  user,
  deviceId,
  vault,
  onVaultUpdated,
  onUserRefresh,
  rooms,
  activeRoomId,
  onSelectRoom,
  onRoomsChanged,
  messagesByRoom,
  onMessagesLoaded,
  onNavigateTab,
  onLogout,
  chatBoxOnly,
  onToggleChatBoxOnly,
  vaultMode,
  onToggleVaultMode,
  aiConsentGranted,
  pendingAiDraft,
  onClearAiDraft,
  onDecryptedSnippetsChange,
  externalCallRequest,
  onClearExternalCallRequest,
  focusSearchTrigger,
  sendWsSignal,
  subscribeCallSignals,
  onDuressTriggered,
  splitRoomId,
  onSelectSplitRoom,
}) => {
  const [inboxSearch, setInboxSearch] = useState('');
  const [threadSearch, setThreadSearch] = useState('');
  const [showThreadSearch, setShowThreadSearch] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [replyTo, setReplyTo] = useState<DecryptedMessageView | null>(null);
  const [editingMsg, setEditingMsg] = useState<{ id: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showVerifyPanel, setShowVerifyPanel] = useState(false);
  const [showRoomModeration, setShowRoomModeration] = useState(false);

  // Advanced Chat Controls (3D theme, voice effect, translation, stickers, schedule, privacy shield, phishing, offline queue)
  const [chatTheme, setChatTheme] = useState<ChatThemeId>('obsidian_neon');
  const [voiceEffect, setVoiceEffect] = useState<VoiceEffectId>('natural');
  const [translateLang, setTranslateLang] = useState<(typeof TRANSLATE_LANGS)[number]>('Nepali');
  const [privacyShieldBlur, setPrivacyShieldBlur] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [showStickerCreator, setShowStickerCreator] = useState(false);
  const [newStickerName, setNewStickerName] = useState('');
  const [newStickerLabel, setNewStickerLabel] = useState('RR-3D');
  const [newStickerShape, setNewStickerShape] = useState<Sticker3DItem['shape']>('cube');
  const [newStickerColor, setNewStickerColor] = useState('#9333ea');
  const [newStickerAnim, setNewStickerAnim] = useState<Sticker3DItem['animation']>('spin');

  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleText, setScheduleText] = useState('');
  const [scheduleMinutes, setScheduleMinutes] = useState(1);
  const [scheduledItems, setScheduledItems] = useState<ScheduledMessageItem[]>([]);
  const [pendingExternalUrl, setPendingExternalUrl] = useState<{ url: string; reasons: string[] } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [splitComposerText, setSplitComposerText] = useState('');

  const outboxStorageKey = `rrchat1_outbox_${user.id}`;
  const [offlineOutbox, setOfflineOutbox] = useState<QueuedOutboxItem[]>(() => {
    try {
      const raw = localStorage.getItem(`rrchat1_outbox_${user.id}`);
      return raw ? (JSON.parse(raw) as QueuedOutboxItem[]) : [];
    } catch {
      return [];
    }
  });
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));

  // Private Vault PIN lock state
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [vaultPinInput, setVaultPinInput] = useState('');
  const [vaultPinError, setVaultPinError] = useState<string | null>(null);

  // Smart Room creation modal state
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupTopic, setGroupTopic] = useState('');
  const [groupInviteOnly, setGroupInviteOnly] = useState(true);
  const [groupSlowMode, setGroupSlowMode] = useState<number>(0);
  const [directoryUsers, setDirectoryUsers] = useState<DirectoryUser[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);

  // Room Moderation edit fields
  const [modTopic, setModTopic] = useState('');
  const [modSlowMode, setModSlowMode] = useState<number>(0);

  const [decryptedByRoom, setDecryptedByRoom] = useState<Record<string, DecryptedMessageView[]>>({});
  const [roomAesKeys, setRoomAesKeys] = useState<Record<string, CryptoKey>>({});
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);

  // Opt-in AI inline helpers
  const [smartReplies, setSmartReplies] = useState<string[]>([]);
  const [loadingSmartReplies, setLoadingSmartReplies] = useState(false);
  const [translatedByMsgId, setTranslatedByMsgId] = useState<Record<string, string>>({});

  // Payment composer state
  const [showPaymentBox, setShowPaymentBox] = useState(false);
  const [payAmountDollars, setPayAmountDollars] = useState('10');
  const [payNote, setPayNote] = useState('');
  const [payRecipientId, setPayRecipientId] = useState('');

  // WebRTC call state
  const [incomingCall, setIncomingCall] = useState<IncomingCallState | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [callSeconds, setCallSeconds] = useState(0);

  const inboxSearchRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeCallRef = useRef<ActiveCallState | null>(null);
  const incomingCallRef = useRef<IncomingCallState | null>(null);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    if (pendingAiDraft) {
      setComposerText(pendingAiDraft);
      onClearAiDraft?.();
    }
  }, [pendingAiDraft, onClearAiDraft]);

  useEffect(() => {
    if (focusSearchTrigger && focusSearchTrigger > 0) {
      inboxSearchRef.current?.focus();
    }
  }, [focusSearchTrigger]);

  const activeRoom = useMemo(() => rooms.find((r) => r.id === activeRoomId) ?? null, [rooms, activeRoomId]);

  useEffect(() => {
    if (activeRoom) {
      setModTopic(activeRoom.topic ?? '');
      setModSlowMode(activeRoom.slowModeSeconds ?? 0);
      setSmartReplies([]);
    }
  }, [activeRoom?.id, activeRoom?.topic, activeRoom?.slowModeSeconds]);

  const peerMembers = useMemo(
    () => (activeRoom ? activeRoom.members.filter((m) => m.id !== user.id) : []),
    [activeRoom, user.id]
  );

  useEffect(() => {
    if (peerMembers.length > 0 && !peerMembers.some((m) => m.id === payRecipientId)) {
      setPayRecipientId(peerMembers[0].id);
    }
  }, [peerMembers, payRecipientId]);

  const ensureRoomAesKey = useCallback(
    async (room: ChatRoomRecord): Promise<CryptoKey | null> => {
      if (roomAesKeys[room.id]) return roomAesKeys[room.id];
      const wrapped = room.encryptedRoomKeys[deviceId];
      if (!wrapped) return null;
      try {
        const rawBytes = await unwrapRoomKey(wrapped, vault);
        const aesKey = await importRoomAesKey(rawBytes);
        setRoomAesKeys((prev) => ({ ...prev, [room.id]: aesKey }));
        return aesKey;
      } catch {
        return null;
      }
    },
    [roomAesKeys, deviceId, vault]
  );

  useEffect(() => {
    try {
      localStorage.setItem(outboxStorageKey, JSON.stringify(offlineOutbox));
    } catch {
      // ignore
    }
  }, [offlineOutbox, outboxStorageKey]);

  const flushOfflineOutbox = useCallback(async () => {
    if (offlineOutbox.length === 0) return;
    const remaining: QueuedOutboxItem[] = [];
    for (const item of offlineOutbox) {
      try {
        await rrApi.sendEncryptedMessage(token, item.roomId, {
          kind: item.kind,
          ciphertextB64: item.ciphertextB64,
          ivB64: item.ivB64,
          replyToId: item.replyToId ?? null,
        });
      } catch {
        remaining.push(item);
      }
    }
    setOfflineOutbox(remaining);
  }, [offlineOutbox, token]);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      flushOfflineOutbox().catch(() => {});
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [flushOfflineOutbox]);

  // Multi-window BroadcastChannel sync
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('rrchat1_sync');
    bc.onmessage = (ev) => {
      if (ev.data?.type === 'select_room' && typeof ev.data.roomId === 'string') {
        onRoomsChanged().catch(() => {});
      }
    };
    return () => bc.close();
  }, [onRoomsChanged]);

  const loadScheduledMessages = useCallback(
    async (roomId: string) => {
      try {
        const res = await rrApi.getScheduledMessages(token, roomId);
        setScheduledItems(res.scheduled);
      } catch {
        setScheduledItems([]);
      }
    },
    [token]
  );

  useEffect(() => {
    if (!activeRoom) return;
    rrApi
      .getMessages(token, activeRoom.id)
      .then((res) => {
        onMessagesLoaded(activeRoom.id, res.messages);
        rrApi.markRoomRead(token, activeRoom.id).catch(() => {});
      })
      .catch(() => {});
    loadScheduledMessages(activeRoom.id);
  }, [activeRoom?.id, token, loadScheduledMessages]);

  const decryptRoomList = useCallback(
    async (room: ChatRoomRecord, rawMessages: EncryptedMessageRecord[]): Promise<DecryptedMessageView[]> => {
      const aesKey = await ensureRoomAesKey(room);
      const views: DecryptedMessageView[] = [];
      for (const m of rawMessages) {
        if (m.deleted) {
          views.push({
            raw: m,
            plaintext: m.recalledAt ? '[Message recalled by sender]' : '[Message deleted]',
            decryptionError: null,
          });
          continue;
        }
        if (!aesKey) {
          views.push({
            raw: m,
            plaintext: '',
            decryptionError: 'Encrypted message locked for this device.',
          });
          continue;
        }
        try {
          const plaintext = await decryptTextPayload(aesKey, m.ciphertextB64, m.ivB64);
          let attachmentUrl: string | undefined;
          let attachmentName: string | undefined;
          let attachmentMime: string | undefined;
          let voiceDurationSec: number | undefined;
          let voiceEffectName: string | undefined;
          let paymentData: DecryptedMessageView['paymentData'];
          let stickerData: DecryptedMessageView['stickerData'];
          let suspiciousUrls: DecryptedMessageView['suspiciousUrls'];

          if (m.kind === 'sticker') {
            try {
              const parsed = JSON.parse(plaintext) as Omit<Sticker3DItem, 'id' | 'createdAt'>;
              if (parsed.shape && parsed.color && parsed.label) {
                stickerData = parsed;
              }
            } catch {
              // ignore
            }
          }

          if (m.kind === 'text' && user.phishingProtection !== false) {
            const findings = scanTextForSuspiciousUrls(plaintext).filter((f) => f.risk === 'suspicious');
            if (findings.length > 0) {
              suspiciousUrls = findings.map((f) => ({ url: f.url, reasons: f.reasons }));
            }
          }

          if (m.kind === 'payment') {
            try {
              const parsed = JSON.parse(plaintext) as {
                amountCents?: number;
                currency?: string;
                recipientName?: string;
                note?: string;
              };
              if (typeof parsed.amountCents === 'number') {
                paymentData = {
                  amountCents: parsed.amountCents,
                  currency: parsed.currency || 'USD',
                  recipientName: parsed.recipientName || 'Recipient',
                  note: parsed.note,
                };
              }
            } catch {
              // ignore
            }
          }

          if (m.attachmentCiphertextB64 && m.attachmentIvB64 && m.attachmentMetaEncB64 && m.attachmentMetaIvB64) {
            const metaJson = await decryptTextPayload(aesKey, m.attachmentMetaEncB64, m.attachmentMetaIvB64);
            const meta = JSON.parse(metaJson) as {
              name: string;
              mime: string;
              durationSec?: number;
              effect?: string;
            };
            const plainBytes = await decryptBinaryPayload(aesKey, m.attachmentCiphertextB64, m.attachmentIvB64);
            const blob = new Blob([plainBytes], { type: meta.mime });
            attachmentUrl = URL.createObjectURL(blob);
            attachmentName = meta.name;
            attachmentMime = meta.mime;
            if (typeof meta.durationSec === 'number') voiceDurationSec = meta.durationSec;
            if (typeof meta.effect === 'string') voiceEffectName = meta.effect;
          }

          views.push({
            raw: m,
            plaintext,
            decryptionError: null,
            attachmentUrl,
            attachmentName,
            attachmentMime,
            voiceDurationSec,
            voiceEffect: voiceEffectName,
            paymentData,
            stickerData,
            suspiciousUrls,
          });
        } catch {
          views.push({
            raw: m,
            plaintext: '',
            decryptionError: 'Unable to decrypt message with current key.',
          });
        }
      }
      return views;
    },
    [ensureRoomAesKey, user.phishingProtection]
  );

  useEffect(() => {
    if (!activeRoom) return;
    let cancelled = false;
    const rawMessages = messagesByRoom[activeRoom.id] ?? [];

    (async () => {
      const views = await decryptRoomList(activeRoom, rawMessages);
      if (!cancelled) {
        setDecryptedByRoom((prev) => ({ ...prev, [activeRoom.id]: views }));
        const snippets = views
          .filter((v) => !v.raw.deleted && !v.decryptionError && v.raw.kind === 'text' && v.plaintext)
          .slice(-12)
          .map((v) => v.plaintext);
        onDecryptedSnippetsChange?.(getRoomDisplayTitle(activeRoom), snippets);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeRoom?.id, messagesByRoom[activeRoom?.id ?? ''], deviceId, decryptRoomList]);

  // Also decrypt secondary split room if open
  const splitRoom = useMemo(() => (splitRoomId ? rooms.find((r) => r.id === splitRoomId) ?? null : null), [rooms, splitRoomId]);

  useEffect(() => {
    if (!splitRoom) return;
    rrApi
      .getMessages(token, splitRoom.id)
      .then((res) => onMessagesLoaded(splitRoom.id, res.messages))
      .catch(() => {});
  }, [splitRoom?.id, token]);

  useEffect(() => {
    if (!splitRoom) return;
    let cancelled = false;
    const rawMessages = messagesByRoom[splitRoom.id] ?? [];
    (async () => {
      const views = await decryptRoomList(splitRoom, rawMessages);
      if (!cancelled) {
        setDecryptedByRoom((prev) => ({ ...prev, [splitRoom.id]: views }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [splitRoom?.id, messagesByRoom[splitRoom?.id ?? ''], decryptRoomList]);

  // Live 1s countdown ticker for self-destruct timers & scheduled messages
  useEffect(() => {
    const hasExpiring = (messagesByRoom[activeRoom?.id ?? ''] ?? []).some((m) => Boolean(m.expiresAt));
    if (!hasExpiring && scheduledItems.length === 0) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeRoom?.id, messagesByRoom, scheduledItems.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [decryptedByRoom[activeRoom?.id ?? '']?.length]);

  useEffect(() => {
    if (!activeCall || activeCall.status !== 'connected') {
      setCallSeconds(0);
      return;
    }
    const id = window.setInterval(() => {
      setCallSeconds(Math.floor((Date.now() - activeCall.startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [activeCall?.status, activeCall?.startedAt]);

  const attachStreamsToMediaElements = useCallback(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
    if (remoteVideoRef.current && remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
    if (remoteAudioRef.current && remoteStreamRef.current) {
      remoteAudioRef.current.srcObject = remoteStreamRef.current;
    }
  }, []);

  useEffect(() => {
    attachStreamsToMediaElements();
  }, [activeCall, attachStreamsToMediaElements]);

  const cleanupCallMedia = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    cameraTrackRef.current = null;
    remoteStreamRef.current = null;
    pendingIceRef.current = [];
    setIsScreenSharing(false);
    setActiveCall(null);
  }, []);

  const logEncryptedCallSummary = useCallback(
    async (roomId: string, label: string, callMode: 'audio' | 'video', status: 'completed' | 'canceled', durationSeconds: number) => {
      rrApi.logCall(token, { roomId, callMode, status, durationSeconds }).catch(() => {});
      const targetRoom = rooms.find((r) => r.id === roomId);
      if (!targetRoom) return;
      try {
        const aesKey = await ensureRoomAesKey(targetRoom);
        if (!aesKey) return;
        const { ciphertextB64, ivB64 } = await encryptTextPayload(aesKey, label);
        await rrApi.sendEncryptedMessage(token, roomId, {
          kind: 'call',
          ciphertextB64,
          ivB64,
        });
      } catch {
        // Non-fatal
      }
    },
    [rooms, ensureRoomAesKey, token]
  );

  useEffect(() => {
    return subscribeCallSignals(async (sig) => {
      if (sig.type === 'call:offer' && sig.sdp) {
        if (activeCallRef.current || incomingCallRef.current) {
          sendWsSignal({
            type: 'call:reject',
            roomId: sig.roomId,
            targetUserId: sig.fromUserId,
            reason: 'User is busy on another call.',
          });
          return;
        }
        onSelectRoom(sig.roomId);
        setIncomingCall({
          roomId: sig.roomId,
          fromUserId: sig.fromUserId,
          fromDisplayName: sig.fromDisplayName,
          callMode: sig.callMode,
          sdp: sig.sdp,
        });
      } else if (sig.type === 'call:answer' && sig.sdp) {
        const pc = pcRef.current;
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
        for (const cand of pendingIceRef.current) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        pendingIceRef.current = [];
        setActiveCall((prev) => (prev ? { ...prev, status: 'connected', startedAt: Date.now() } : prev));
      } else if (sig.type === 'call:ice' && sig.candidate) {
        const pc = pcRef.current;
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => {});
        } else {
          pendingIceRef.current.push(sig.candidate);
        }
      } else if (sig.type === 'call:end' || sig.type === 'call:reject') {
        if (incomingCallRef.current?.fromUserId === sig.fromUserId) {
          setIncomingCall(null);
        }
        if (activeCallRef.current) {
          if (sig.type === 'call:reject') {
            setError(sig.reason || 'Call declined.');
          }
          cleanupCallMedia();
        }
      }
    });
  }, [subscribeCallSignals, sendWsSignal, onSelectRoom, cleanupCallMedia]);

  function createPeerConnection(roomId: string, peerUserId: string, callMode: 'audio' | 'video') {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const remoteStream = new MediaStream();
    remoteStreamRef.current = remoteStream;

    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      if (!event.streams[0]) {
        remoteStream.addTrack(event.track);
      }
      attachStreamsToMediaElements();
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWsSignal({
          type: 'call:ice',
          roomId,
          targetUserId: peerUserId,
          callMode,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        cleanupCallMedia();
      }
    };

    pcRef.current = pc;
    return pc;
  }

  const startCall = useCallback(
    async (mode: 'audio' | 'video', targetRoomOverride?: ChatRoomRecord) => {
      const targetRoom = targetRoomOverride ?? activeRoom;
      if (!targetRoom) return;
      const peer = targetRoom.members.find((m) => m.id !== user.id);
      if (!peer) {
        setError('No recipient available in this room for a call.');
        return;
      }
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: mode === 'video',
        });
        localStreamRef.current = stream;
        const pc = createPeerConnection(targetRoom.id, peer.id, mode);
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        setActiveCall({
          roomId: targetRoom.id,
          peerUserId: peer.id,
          peerDisplayName: peer.displayName,
          callMode: mode,
          status: 'calling',
          startedAt: Date.now(),
          muted: false,
          cameraOff: false,
        });

        sendWsSignal({
          type: 'call:offer',
          roomId: targetRoom.id,
          targetUserId: peer.id,
          callMode: mode,
          sdp: pc.localDescription,
        });
        attachStreamsToMediaElements();
      } catch {
        cleanupCallMedia();
        setError(
          mode === 'video'
            ? 'Camera or microphone permission was denied or unavailable.'
            : 'Microphone permission was denied or unavailable.'
        );
      }
    },
    [activeRoom, user.id, sendWsSignal, attachStreamsToMediaElements, cleanupCallMedia]
  );

  useEffect(() => {
    if (externalCallRequest) {
      const targetRoom = rooms.find((r) => r.id === externalCallRequest.roomId);
      onClearExternalCallRequest?.();
      if (targetRoom) {
        onSelectRoom(targetRoom.id);
        startCall(externalCallRequest.mode, targetRoom);
      }
    }
  }, [externalCallRequest, rooms, onClearExternalCallRequest, onSelectRoom, startCall]);

  async function acceptIncomingCall() {
    if (!incomingCall) return;
    const call = incomingCall;
    setIncomingCall(null);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: call.callMode === 'video',
      });
      localStreamRef.current = stream;
      const pc = createPeerConnection(call.roomId, call.fromUserId, call.callMode);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(new RTCSessionDescription(call.sdp));
      for (const cand of pendingIceRef.current) {
        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      }
      pendingIceRef.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      setActiveCall({
        roomId: call.roomId,
        peerUserId: call.fromUserId,
        peerDisplayName: call.fromDisplayName,
        callMode: call.callMode,
        status: 'connected',
        startedAt: Date.now(),
        muted: false,
        cameraOff: false,
      });

      sendWsSignal({
        type: 'call:answer',
        roomId: call.roomId,
        targetUserId: call.fromUserId,
        callMode: call.callMode,
        sdp: pc.localDescription,
      });
      attachStreamsToMediaElements();
    } catch {
      cleanupCallMedia();
      sendWsSignal({
        type: 'call:reject',
        roomId: call.roomId,
        targetUserId: call.fromUserId,
        reason: 'Could not access microphone/camera.',
      });
      setError('Permission denied while answering call.');
    }
  }

  function declineIncomingCall() {
    if (!incomingCall) return;
    sendWsSignal({
      type: 'call:reject',
      roomId: incomingCall.roomId,
      targetUserId: incomingCall.fromUserId,
      reason: 'Call declined.',
    });
    rrApi
      .logCall(token, {
        roomId: incomingCall.roomId,
        callMode: incomingCall.callMode,
        status: 'declined',
        durationSeconds: 0,
      })
      .catch(() => {});
    setIncomingCall(null);
  }

  function endActiveCall() {
    const current = activeCallRef.current;
    if (!current) return;
    sendWsSignal({
      type: 'call:end',
      roomId: current.roomId,
      targetUserId: current.peerUserId,
      callMode: current.callMode,
    });
    const mins = Math.floor(callSeconds / 60);
    const secs = String(callSeconds % 60).padStart(2, '0');
    const isConnected = current.status === 'connected';
    const summary = isConnected
      ? `${current.callMode === 'video' ? 'Video' : 'Voice'} call ended · ${mins}:${secs}`
      : `${current.callMode === 'video' ? 'Video' : 'Voice'} call canceled`;
    cleanupCallMedia();
    logEncryptedCallSummary(
      current.roomId,
      summary,
      current.callMode,
      isConnected ? 'completed' : 'canceled',
      isConnected ? callSeconds : 0
    ).catch(() => {});
  }

  function toggleMute() {
    if (!localStreamRef.current || !activeCall) return;
    const nextMuted = !activeCall.muted;
    localStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setActiveCall({ ...activeCall, muted: nextMuted });
  }

  function toggleCamera() {
    if (!localStreamRef.current || !activeCall) return;
    const nextOff = !activeCall.cameraOff;
    localStreamRef.current.getVideoTracks().forEach((t) => {
      t.enabled = !nextOff;
    });
    setActiveCall({ ...activeCall, cameraOff: nextOff });
  }

  async function toggleScreenShare() {
    if (!activeCall || activeCall.callMode !== 'video' || !pcRef.current) return;
    const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) {
      setError('No active video track sender available for screen share.');
      return;
    }

    if (isScreenSharing) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      if (cameraTrackRef.current) {
        await sender.replaceTrack(cameraTrackRef.current).catch(() => {});
        if (localVideoRef.current && localStreamRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
        }
      }
      setIsScreenSharing(false);
      return;
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = displayStream.getVideoTracks()[0];
      if (!screenTrack) return;
      if (!cameraTrackRef.current) {
        cameraTrackRef.current = sender.track ?? localStreamRef.current?.getVideoTracks()[0] ?? null;
      }
      screenStreamRef.current = displayStream;
      await sender.replaceTrack(screenTrack);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = displayStream;
      }
      setIsScreenSharing(true);
      screenTrack.onended = () => {
        if (cameraTrackRef.current && pcRef.current) {
          const vSender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video');
          vSender?.replaceTrack(cameraTrackRef.current).catch(() => {});
          if (localVideoRef.current && localStreamRef.current) {
            localVideoRef.current.srcObject = localStreamRef.current;
          }
        }
        screenStreamRef.current = null;
        setIsScreenSharing(false);
      };
    } catch {
      setError('Screen share permission was canceled or unsupported in this browser.');
    }
  }

  function getRoomDisplayTitle(room: ChatRoomRecord): string {
    if (room.type === 'group') return room.title || 'Smart Room';
    const other = room.members.find((m) => m.id !== user.id);
    return other ? other.displayName : 'Private Chat';
  }

  function getRoomPeerVerificationStatus(room: ChatRoomRecord): 'verified' | 'unverified' {
    const others = room.members.filter((m) => m.id !== user.id);
    if (others.length === 0) return 'verified';
    for (const member of others) {
      for (const dev of member.devices) {
        if (vault.verifiedPeerDevices[dev.deviceId] !== dev.fingerprint) {
          return 'unverified';
        }
      }
    }
    return 'verified';
  }

  async function handleSendText(e: React.FormEvent, targetRoomOverride?: ChatRoomRecord, textOverride?: string) {
    e.preventDefault();
    const targetRoom = targetRoomOverride ?? activeRoom;
    const textValue = (textOverride ?? composerText).trim();
    if (!targetRoom || !textValue) return;
    setError(null);
    setSending(true);
    try {
      const aesKey = await ensureRoomAesKey(targetRoom);
      if (!aesKey) throw new Error('Room key unavailable on this device.');
      const { ciphertextB64, ivB64 } = await encryptTextPayload(aesKey, textValue);

      const queueEnabled = user.featureSelection?.offline_message_queue !== false;
      if (!isOnline && queueEnabled) {
        setOfflineOutbox((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            roomId: targetRoom.id,
            kind: 'text',
            ciphertextB64,
            ivB64,
            replyToId: targetRoomOverride ? null : replyTo?.raw.id ?? null,
            createdAt: Date.now(),
          },
        ]);
        if (targetRoomOverride) setSplitComposerText('');
        else {
          setComposerText('');
          setReplyTo(null);
        }
        return;
      }

      try {
        await rrApi.sendEncryptedMessage(token, targetRoom.id, {
          kind: 'text',
          ciphertextB64,
          ivB64,
          replyToId: targetRoomOverride ? null : replyTo?.raw.id ?? null,
        });
      } catch (sendErr) {
        if (queueEnabled && !navigator.onLine) {
          setOfflineOutbox((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              roomId: targetRoom.id,
              kind: 'text',
              ciphertextB64,
              ivB64,
              replyToId: targetRoomOverride ? null : replyTo?.raw.id ?? null,
              createdAt: Date.now(),
            },
          ]);
        } else {
          throw sendErr;
        }
      }

      if (targetRoomOverride) {
        setSplitComposerText('');
      } else {
        setComposerText('');
        setReplyTo(null);
        setSmartReplies([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to encrypt and send message.');
    } finally {
      setSending(false);
    }
  }

  async function handleSaveMessageEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeRoom || !editingMsg || !editingMsg.text.trim()) return;
    setError(null);
    try {
      const aesKey = await ensureRoomAesKey(activeRoom);
      if (!aesKey) throw new Error('Room key unavailable.');
      const { ciphertextB64, ivB64 } = await encryptTextPayload(aesKey, editingMsg.text.trim());
      await rrApi.editMessage(token, activeRoom.id, editingMsg.id, { ciphertextB64, ivB64 });
      setEditingMsg(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Message edit failed.');
    }
  }

  async function handleFileUpload(file: File) {
    if (!activeRoom) return;
    setError(null);
    setSending(true);
    try {
      const aesKey = await ensureRoomAesKey(activeRoom);
      if (!aesKey) throw new Error('Room key unavailable on this device.');
      const buf = new Uint8Array(await file.arrayBuffer());
      const { ciphertextB64: attCipher, ivB64: attIv } = await encryptBinaryPayload(aesKey, buf);
      const metaStr = JSON.stringify({ name: file.name, mime: file.type || 'application/octet-stream' });
      const { ciphertextB64: metaCipher, ivB64: metaIv } = await encryptTextPayload(aesKey, metaStr);
      const caption =
        composerText.trim() ||
        (file.type.startsWith('image/')
          ? 'Photo'
          : file.type.startsWith('video/')
            ? 'Video'
            : file.name);
      const { ciphertextB64, ivB64 } = await encryptTextPayload(aesKey, caption);

      const kind = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : file.type.startsWith('audio/')
            ? 'voice'
            : 'file';

      await rrApi.sendEncryptedMessage(token, activeRoom.id, {
        kind,
        ciphertextB64,
        ivB64,
        attachmentCiphertextB64: attCipher,
        attachmentIvB64: attIv,
        attachmentMetaEncB64: metaCipher,
        attachmentMetaIvB64: metaIv,
        attachmentMime: file.type || 'application/octet-stream',
        attachmentBytes: file.size,
        replyToId: replyTo?.raw.id ?? null,
      });
      setComposerText('');
      setReplyTo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Attachment encryption or policy check failed.');
    } finally {
      setSending(false);
    }
  }

  async function handleSendPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!activeRoom) return;
    const recipient = activeRoom.members.find((m) => m.id === payRecipientId) ?? peerMembers[0];
    if (!recipient) {
      setError('No recipient found in this conversation.');
      return;
    }
    const cents = Math.round(Number(payAmountDollars) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError('Enter a valid payment amount.');
      return;
    }
    setError(null);
    setSending(true);
    try {
      const aesKey = await ensureRoomAesKey(activeRoom);
      if (!aesKey) throw new Error('Room key unavailable on this device.');

      const transferRes = await rrApi.transferPayment(token, {
        roomId: activeRoom.id,
        recipientId: recipient.id,
        amountCents: cents,
      });

      const receiptJson = JSON.stringify({
        type: 'payment',
        transferId: transferRes.transfer.id,
        amountCents: cents,
        currency: 'USD',
        recipientName: recipient.displayName,
        note: payNote.trim() || undefined,
      });
      const { ciphertextB64, ivB64 } = await encryptTextPayload(aesKey, receiptJson);

      await rrApi.sendEncryptedMessage(token, activeRoom.id, {
        kind: 'payment',
        ciphertextB64,
        ivB64,
      });

      setShowPaymentBox(false);
      setPayNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment transfer failed.');
    } finally {
      setSending(false);
    }
  }

  async function handleSendVoiceMessage(file: File, durationSec: number, effect: VoiceEffectId) {
    if (!activeRoom) return;
    setError(null);
    setSending(true);
    try {
      const aesKey = await ensureRoomAesKey(activeRoom);
      if (!aesKey) throw new Error('Room key unavailable on this device.');

      const buf = new Uint8Array(await file.arrayBuffer());
      const { ciphertextB64: attCipher, ivB64: attIv } = await encryptBinaryPayload(aesKey, buf);
      const mime = file.type || 'audio/webm';
      const metaStr = JSON.stringify({
        name: file.name,
        mime,
        durationSec,
        effect,
      });
      const { ciphertextB64: metaCipher, ivB64: metaIv } = await encryptTextPayload(aesKey, metaStr);

      const effectLabel = VOICE_EFFECTS.find((v) => v.id === effect)?.label;
      const caption =
        composerText.trim() ||
        `Voice message (${formatVoiceDuration(durationSec)})${effect !== 'natural' && effectLabel ? ` · ${effectLabel}` : ''}`;
      const { ciphertextB64, ivB64 } = await encryptTextPayload(aesKey, caption);

      await rrApi.sendEncryptedMessage(token, activeRoom.id, {
        kind: 'voice',
        ciphertextB64,
        ivB64,
        attachmentCiphertextB64: attCipher,
        attachmentIvB64: attIv,
        attachmentMetaEncB64: metaCipher,
        attachmentMetaIvB64: metaIv,
        attachmentMime: mime,
        attachmentBytes: file.size,
        replyToId: replyTo?.raw.id ?? null,
      });

      setComposerText('');
      setReplyTo(null);
      setShowVoiceRecorder(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to encrypt and send voice message.';
      setError(msg);
      throw new Error(msg);
    } finally {
      setSending(false);
    }
  }

  async function handleSendSticker(sticker: Sticker3DItem) {
    if (!activeRoom) return;
    setError(null);
    setSending(true);
    try {
      const aesKey = await ensureRoomAesKey(activeRoom);
      if (!aesKey) throw new Error('Room key unavailable on this device.');
      const payloadJson = JSON.stringify({
        name: sticker.name,
        shape: sticker.shape,
        color: sticker.color,
        glowColor: sticker.glowColor,
        animation: sticker.animation,
        label: sticker.label,
      });
      const { ciphertextB64, ivB64 } = await encryptTextPayload(aesKey, payloadJson);
      await rrApi.sendEncryptedMessage(token, activeRoom.id, {
        kind: 'sticker',
        ciphertextB64,
        ivB64,
      });
      setShowStickerPicker(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send 3D sticker.');
    } finally {
      setSending(false);
    }
  }

  async function handleCreateCustomSticker(e: React.FormEvent) {
    e.preventDefault();
    if (!newStickerName.trim() || !newStickerLabel.trim()) return;
    const item: Sticker3DItem = {
      id: `stk-${Date.now()}`,
      name: newStickerName.trim(),
      shape: newStickerShape,
      color: newStickerColor,
      glowColor: '#a855f7',
      animation: newStickerAnim,
      label: newStickerLabel.trim().slice(0, 12),
      createdAt: Date.now(),
    };
    const nextPack = [item, ...(user.stickerPack ?? [])].slice(0, 24);
    setError(null);
    try {
      await rrApi.saveStickers(token, nextPack);
      await onUserRefresh?.();
      setShowStickerCreator(false);
      setNewStickerName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save custom 3D sticker.');
    }
  }

  async function handleScheduleMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!activeRoom || !scheduleText.trim()) return;
    setError(null);
    try {
      const aesKey = await ensureRoomAesKey(activeRoom);
      if (!aesKey) throw new Error('Room key unavailable on this device.');
      const { ciphertextB64, ivB64 } = await encryptTextPayload(aesKey, scheduleText.trim());
      const deliverAt = Date.now() + Math.max(1, scheduleMinutes) * 60_000;
      await rrApi.scheduleMessage(token, activeRoom.id, {
        kind: 'text',
        ciphertextB64,
        ivB64,
        deliverAt,
      });
      setScheduleText('');
      await loadScheduledMessages(activeRoom.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to schedule message.');
    }
  }

  async function handleCreateSmartRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!groupTitle.trim() || selectedMemberIds.length === 0) return;
    setError(null);
    try {
      const rawKey = await generateRoomKeyBytes();
      const wrappedKeys: Record<string, unknown> = {};
      const selectedUsers = directoryUsers.filter((u) => selectedMemberIds.includes(u.id));
      wrappedKeys[deviceId] = await wrapRoomKeyForDevice(rawKey, deviceId, vault, vault.ecdhPubJwk);
      for (const member of selectedUsers) {
        for (const dev of member.devices) {
          wrappedKeys[dev.deviceId] = await wrapRoomKeyForDevice(rawKey, deviceId, vault, dev.ecdhPubKeyJwk);
        }
      }
      const res = await rrApi.createRoom(token, {
        type: 'group',
        title: groupTitle.trim(),
        topic: groupTopic.trim(),
        inviteOnly: groupInviteOnly,
        slowModeSeconds: groupSlowMode > 0 ? groupSlowMode : null,
        memberIds: selectedMemberIds,
        encryptedRoomKeys: wrappedKeys,
      });
      setShowGroupModal(false);
      setGroupTitle('');
      setGroupTopic('');
      setSelectedMemberIds([]);
      await onRoomsChanged();
      onSelectRoom(res.room.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Smart Room.');
    }
  }

  function handleMarkDeviceVerified(targetDeviceId: string, fingerprint: string) {
    const updated: DeviceKeyVault = {
      ...vault,
      verifiedPeerDevices: {
        ...vault.verifiedPeerDevices,
        [targetDeviceId]: fingerprint,
      },
    };
    saveVaultToLocal(user.username, deviceId, updated);
    onVaultUpdated(updated);
  }

  async function handleQuickSmartReplies() {
    if (!aiConsentGranted) {
      setError('Enable Opt-In AI Consent inside the RR AI tab first.');
      return;
    }
    if (!activeRoom) return;
    setLoadingSmartReplies(true);
    setError(null);
    try {
      const snippets = (decryptedByRoom[activeRoom.id] ?? [])
        .filter((v) => !v.raw.deleted && v.plaintext)
        .slice(-6)
        .map((v) => v.plaintext);
      const res = await rrApi.aiAssist(token, {
        consentGranted: true,
        mode: 'smart_replies',
        messages: snippets,
      });
      setSmartReplies(res.suggestions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI smart replies unavailable.');
    } finally {
      setLoadingSmartReplies(false);
    }
  }

  async function handleQuickTranslate(msgId: string, text: string) {
    if (!aiConsentGranted) {
      setError('Enable Opt-In AI Consent in the RR AI tab before translating decrypted messages.');
      return;
    }
    try {
      const res = await rrApi.aiAssist(token, {
        consentGranted: true,
        mode: 'translate',
        text,
        targetLang: translateLang,
      });
      if (res.text) {
        setTranslatedByMsgId((prev) => ({ ...prev, [msgId]: `${translateLang}: ${res.text!}` }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Translation failed.');
    }
  }

  async function handleUnlockVault(e: React.FormEvent) {
    e.preventDefault();
    setVaultPinError(null);
    try {
      const res = await rrApi.verifyVaultPin(token, vaultPinInput);
      if (res.duressTriggered) {
        setVaultPinInput('');
        onDuressTriggered?.(res.duressBehavior ?? 'decoy_screen');
        return;
      }
      if (res.unlocked) {
        setVaultUnlocked(true);
        setVaultPinInput('');
      }
    } catch (err) {
      setVaultPinError(err instanceof Error ? err.message : 'Incorrect Vault PIN.');
    }
  }

  const vaultLocked = vaultMode && Boolean(user.hasVaultPin) && !vaultUnlocked;

  const filteredRooms = rooms.filter((r) => {
    const isInVault = Boolean(r.inVaultByUser?.[user.id]);
    if (vaultMode !== isInVault) return false;
    if (!inboxSearch.trim()) return true;
    return getRoomDisplayTitle(r).toLowerCase().includes(inboxSearch.trim().toLowerCase());
  });

  const activeMessages = activeRoom ? decryptedByRoom[activeRoom.id] ?? [] : [];
  const visibleMessages = activeMessages.filter((m) => {
    if (!threadSearch.trim()) return true;
    return m.plaintext.toLowerCase().includes(threadSearch.trim().toLowerCase());
  });

  const isActiveRoomInVault = Boolean(activeRoom?.inVaultByUser?.[user.id]);
  const isRoomAdmin = Boolean(activeRoom?.adminIds.includes(user.id));

  const renderMenuDropdown = () =>
    showMenu ? (
      <div className="absolute right-0 top-11 w-64 bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-700 rounded-2xl shadow-2xl py-1.5 z-50">
        <button
          type="button"
          onClick={() => {
            setShowMenu(false);
            onNavigateTab('contacts');
          }}
          className="w-full px-4 py-2.5 text-left text-xs text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center gap-2.5"
        >
          <Users className="w-4 h-4 text-purple-500" />
          Contacts &amp; QR Scanner
        </button>
        <button
          type="button"
          onClick={() => {
            setShowMenu(false);
            onNavigateTab('social');
          }}
          className="w-full px-4 py-2.5 text-left text-xs text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center gap-2.5"
        >
          <Compass className="w-4 h-4 text-purple-500" />
          Social Hub (Stories / Live / Channels)
        </button>
        <button
          type="button"
          onClick={() => {
            setShowMenu(false);
            onNavigateTab('features');
          }}
          className="w-full px-4 py-2.5 text-left text-xs text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center gap-2.5"
        >
          <Sliders className="w-4 h-4 text-purple-500" />
          26-Feature Switchboard
        </button>
        <button
          type="button"
          onClick={() => {
            setShowMenu(false);
            onNavigateTab('privacy');
          }}
          className="w-full px-4 py-2.5 text-left text-xs text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center gap-2.5"
        >
          <Gamepad2 className="w-4 h-4 text-purple-500" />
          Private Settings (Vault / Discord / Wallet)
        </button>
        <button
          type="button"
          onClick={() => {
            setShowMenu(false);
            onNavigateTab('security');
          }}
          className="w-full px-4 py-2.5 text-left text-xs text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center gap-2.5"
        >
          <Shield className="w-4 h-4 text-purple-500" />
          RR Shield &amp; Security Radar
        </button>
        <button
          type="button"
          onClick={() => {
            setShowMenu(false);
            onNavigateTab('architecture');
          }}
          className="w-full px-4 py-2.5 text-left text-xs text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center gap-2.5"
        >
          <FolderGit2 className="w-4 h-4 text-zinc-400" />
          Architecture &amp; Tests
        </button>
        <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
        <button
          type="button"
          onClick={() => {
            setShowMenu(false);
            onLogout();
          }}
          className="w-full px-4 py-2.5 text-left text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-2.5"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    ) : null;

  if (vaultLocked) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <form
          onSubmit={handleUnlockVault}
          className="w-full max-w-sm rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4 shadow-xl"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-600/15 border border-purple-500/40 flex items-center justify-center text-purple-600 dark:text-purple-400">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Private Vault Locked</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Enter your Vault PIN to view hidden chats</p>
            </div>
          </div>
          {vaultPinError && <p className="text-xs text-red-500">{vaultPinError}</p>}
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={vaultPinInput}
            onChange={(e) => setVaultPinInput(e.target.value.replace(/\D/g, ''))}
            placeholder="4–8 digit Vault PIN"
            className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-sm font-mono text-zinc-900 dark:text-zinc-100"
          />
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onToggleVaultMode(false)}
              className="px-3.5 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
            >
              Back to Home
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
            >
              Unlock Vault
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="h-full flex overflow-hidden">
      <audio ref={remoteAudioRef} autoPlay className="hidden" />

      {/* Conversation List Sidebar */}
      {!chatBoxOnly && (
        <aside className="w-full md:w-80 border-r border-zinc-200 dark:border-zinc-800/80 bg-white/60 dark:bg-[#090B11] flex flex-col shrink-0">
          <div className="p-4 border-b border-zinc-200 dark:border-zinc-800/80 space-y-3">
            <div className="flex items-center justify-between gap-2 relative">
              <div className="flex items-center gap-2 min-w-0">
                <Logo3D size="badge" />
                <span className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-100 truncate">
                  {vaultMode ? 'Private Vault' : 'RRchat 1'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={async () => {
                    const res = await rrApi.searchUsers(token, '');
                    setDirectoryUsers(res.users);
                    setShowGroupModal(true);
                  }}
                  className="p-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-700 dark:text-zinc-200"
                  title="New Smart Room"
                >
                  <Plus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigateTab('contacts')}
                  className="p-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-700 dark:text-zinc-200"
                  title="Contacts & QR Scanner"
                >
                  <Users className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowMenu((v) => !v)}
                  className="p-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-700 dark:text-zinc-200"
                  title="Menu & Private Settings"
                >
                  <Menu className="w-4 h-4" />
                </button>
              </div>
              {renderMenuDropdown()}
            </div>

            {/* Home / Vault Switcher */}
            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => onToggleVaultMode(false)}
                className={`py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  !vaultMode
                    ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                    : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                Home Chats
              </button>
              <button
                type="button"
                onClick={() => onToggleVaultMode(true)}
                className={`py-1.5 text-xs font-medium rounded-lg inline-flex items-center justify-center gap-1 transition-colors ${
                  vaultMode
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <Vault className="w-3 h-3" />
                Private Vault
              </button>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                ref={inboxSearchRef}
                type="text"
                value={inboxSearch}
                onChange={(e) => setInboxSearch(e.target.value)}
                placeholder="Search chats (Ctrl+K)..."
                className="w-full pl-8 pr-3 py-2 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-zinc-200 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-zinc-200 dark:divide-zinc-800/50">
            {filteredRooms.length === 0 ? (
              <div className="p-6 text-center space-y-3">
                <p className="text-sm text-zinc-700 dark:text-zinc-300">
                  {vaultMode ? 'No conversations in Private Vault' : 'No chats yet'}
                </p>
                <p className="text-xs text-zinc-500">
                  {vaultMode
                    ? 'Open any chat and click the Vault icon in its header to move it here.'
                    : 'Find a contact or scan a QR code to start chatting.'}
                </p>
                {!vaultMode && (
                  <button
                    type="button"
                    onClick={() => onNavigateTab('contacts')}
                    className="px-3.5 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
                  >
                    Open Contacts
                  </button>
                )}
              </div>
            ) : (
              filteredRooms.map((room) => {
                const selected = room.id === activeRoom?.id;
                return (
                  <button
                    key={room.id}
                    type="button"
                    onClick={() => onSelectRoom(room.id)}
                    className={`w-full text-left p-4 transition-colors ${
                      selected
                        ? 'bg-purple-50/80 dark:bg-purple-950/30 border-r-2 border-purple-600'
                        : 'hover:bg-zinc-100/70 dark:hover:bg-zinc-900/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {getRoomDisplayTitle(room)}
                      </span>
                      {room.lastMessage && (
                        <span className="text-[11px] font-mono tabular-nums text-zinc-500 shrink-0">
                          {new Date(room.lastMessage.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {room.type === 'group' ? (
                        <Users className="w-3 h-3 text-purple-500 shrink-0" />
                      ) : (
                        <Lock className="w-3 h-3 text-purple-500 shrink-0" />
                      )}
                      <span className="truncate">
                        {room.type === 'group'
                          ? room.topic || `${room.memberIds.length} members · Smart Room`
                          : room.disappearingTtlSeconds
                            ? `Ghost Chat · ${room.disappearingTtlSeconds}s`
                            : 'Private E2EE chat'}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      )}

      {/* Active Conversation Viewport */}
      <section className={`flex-1 flex flex-col min-w-0 ${CHAT_THEMES[chatTheme].viewport} ${!activeRoom && !chatBoxOnly ? 'hidden md:flex' : 'flex'}`}>
        {incomingCall && (
          <div className="px-5 py-3 bg-purple-100 dark:bg-purple-950/70 border-b border-purple-300 dark:border-purple-700/60 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <PhoneIncoming className="w-5 h-5 text-purple-600 dark:text-purple-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                  Incoming {incomingCall.callMode === 'video' ? 'Video' : 'Voice'} Call · {incomingCall.fromDisplayName}
                </div>
                <div className="text-xs text-purple-700 dark:text-purple-300">Peer-to-peer WebRTC media</div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={acceptIncomingCall}
                className="px-3.5 py-1.5 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white whitespace-nowrap"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={declineIncomingCall}
                className="px-3.5 py-1.5 text-xs font-semibold rounded-xl bg-red-600 hover:bg-red-500 text-white whitespace-nowrap"
              >
                Decline
              </button>
            </div>
          </div>
        )}

        {activeCall && (
          <div className="p-4 bg-white dark:bg-[#0D1018] border-b border-zinc-200 dark:border-zinc-800 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {activeCall.callMode === 'video' ? 'Video Call' : 'Voice Call'} · {activeCall.peerDisplayName}
                  {isScreenSharing && <span className="ml-2 text-xs text-purple-500">(Screen Sharing)</span>}
                </div>
                <div className="text-xs font-mono text-purple-600 dark:text-purple-400">
                  {activeCall.status === 'calling'
                    ? 'Ringing...'
                    : `Connected · ${Math.floor(callSeconds / 60)}:${String(callSeconds % 60).padStart(2, '0')}`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleMute}
                  className={`p-2.5 rounded-xl border ${
                    activeCall.muted
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-300'
                      : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200'
                  }`}
                >
                  {activeCall.muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
                {activeCall.callMode === 'video' && (
                  <>
                    <button
                      type="button"
                      onClick={toggleCamera}
                      className={`p-2.5 rounded-xl border ${
                        activeCall.cameraOff
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-300'
                          : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200'
                      }`}
                    >
                      {activeCall.cameraOff ? <VideoOff className="w-4 h-4" /> : <Video className="w-4 h-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={toggleScreenShare}
                      className={`p-2.5 rounded-xl border inline-flex items-center gap-1.5 text-xs font-medium ${
                        isScreenSharing
                          ? 'border-purple-500 bg-purple-600 text-white'
                          : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200'
                      }`}
                      title={isScreenSharing ? 'Stop Screen Share' : 'Share Screen'}
                    >
                      <MonitorUp className="w-4 h-4" />
                      <span className="hidden sm:inline">{isScreenSharing ? 'Stop Share' : 'Screen'}</span>
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={endActiveCall}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-red-600 hover:bg-red-500 text-white whitespace-nowrap"
                >
                  <PhoneOff className="w-4 h-4" />
                  End Call
                </button>
              </div>
            </div>

            {activeCall.callMode === 'video' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="relative rounded-xl overflow-hidden bg-black border border-zinc-800 aspect-video">
                  <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
                  <span className="absolute bottom-2 left-2 px-2 py-0.5 text-[11px] rounded bg-black/70 text-zinc-200">
                    {activeCall.peerDisplayName}
                  </span>
                </div>
                <div className="relative rounded-xl overflow-hidden bg-black border border-zinc-800 aspect-video">
                  <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
                  <span className="absolute bottom-2 left-2 px-2 py-0.5 text-[11px] rounded bg-black/70 text-zinc-200">
                    You
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {!activeRoom ? (
          <div className="flex-1 flex flex-col">
            {chatBoxOnly && (
              <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#0D1018] flex items-center justify-between relative">
                <div className="flex items-center gap-2">
                  <Logo3D size="badge" />
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">RRchat 1</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onToggleChatBoxOnly}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200"
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                    Show Chats
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowMenu((v) => !v)}
                    className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200"
                  >
                    <Menu className="w-4 h-4" />
                  </button>
                </div>
                {renderMenuDropdown()}
              </div>
            )}
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-sm text-center space-y-4">
                <Lock className="w-8 h-8 text-purple-600 dark:text-purple-400 mx-auto" />
                <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Start a Private Chat</h2>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Add a contact by username or scan their QR code to begin messaging, voice/video calls, photo &amp;
                  video sharing, and private payments.
                </p>
                <div className="flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => onNavigateTab('contacts')}
                    className="px-4 py-2 text-sm font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
                  >
                    Open Contacts
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigateTab('privacy')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-purple-500/60 text-zinc-800 dark:text-zinc-200"
                  >
                    <SlidersHorizontal className="w-4 h-4" />
                    Private Settings
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800/80 rr-glass flex items-center justify-between gap-2 relative flex-wrap">
              <div className="min-w-0 flex items-center gap-2.5">
                <Lock className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                    {getRoomDisplayTitle(activeRoom)}
                  </h3>
                  {activeRoom.type === 'group' && activeRoom.topic && (
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{activeRoom.topic}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                <button
                  type="button"
                  disabled={Boolean(activeCall) || peerMembers.length === 0}
                  onClick={() => startCall('audio')}
                  className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-700 dark:text-zinc-200 disabled:opacity-40"
                  title="Voice Call"
                >
                  <Phone className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  disabled={Boolean(activeCall) || peerMembers.length === 0}
                  onClick={() => startCall('video')}
                  className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-700 dark:text-zinc-200 disabled:opacity-40"
                  title="Video Call & Screen Share"
                >
                  <Video className="w-4 h-4" />
                </button>

                {/* Live Translation Target Language */}
                <div className="hidden md:flex items-center gap-1 px-2 py-1.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs">
                  <Languages className="w-3.5 h-3.5 text-purple-500" />
                  <select
                    aria-label="Live translation language"
                    value={translateLang}
                    onChange={(e) => setTranslateLang(e.target.value as (typeof TRANSLATE_LANGS)[number])}
                    className="bg-transparent text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none"
                  >
                    {TRANSLATE_LANGS.map((l) => (
                      <option key={l} value={l} className="bg-white dark:bg-zinc-900">
                        {l === 'Nepali' ? 'Nepali (नेपाली)' : l}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 3D Chat Theme Switcher */}
                <div className="hidden xl:flex items-center gap-1 px-2 py-1.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs">
                  <Palette className="w-3.5 h-3.5 text-purple-500" />
                  <select
                    aria-label="3D chat theme"
                    value={chatTheme}
                    onChange={(e) => setChatTheme(e.target.value as ChatThemeId)}
                    className="bg-transparent text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none"
                  >
                    {Object.entries(CHAT_THEMES).map(([id, cfg]) => (
                      <option key={id} value={id} className="bg-white dark:bg-zinc-900">
                        {cfg.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Ghost Chat Timer */}
                <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-700 dark:text-zinc-300">
                  <Clock className="w-3.5 h-3.5 text-purple-500" />
                  <select
                    aria-label="Ghost Chat expiration timer"
                    value={activeRoom.disappearingTtlSeconds ?? ''}
                    onChange={async (e) => {
                      const val = e.target.value ? Number(e.target.value) : null;
                      await rrApi.updateDisappearingTtl(token, activeRoom.id, val);
                      await onRoomsChanged();
                    }}
                    className="bg-transparent text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none"
                  >
                    {TTL_OPTIONS.map((opt) => (
                      <option key={opt.label} value={opt.value ?? ''} className="bg-white dark:bg-zinc-900">
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Scheduled Messages */}
                <button
                  type="button"
                  onClick={() => {
                    loadScheduledMessages(activeRoom.id);
                    setShowScheduleModal(true);
                  }}
                  className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/50 text-zinc-600 dark:text-zinc-300 relative"
                  title="Schedule Encrypted Message"
                >
                  <CalendarClock className="w-4 h-4" />
                  {scheduledItems.length > 0 && (
                    <span className="absolute -top-1 -right-1 px-1 rounded-full bg-purple-600 text-[9px] text-white font-mono">
                      {scheduledItems.length}
                    </span>
                  )}
                </button>

                {/* Privacy Shield (Blur Previews) */}
                <button
                  type="button"
                  onClick={() => setPrivacyShieldBlur((v) => !v)}
                  className={`p-2 rounded-xl border transition-colors ${
                    privacyShieldBlur
                      ? 'border-purple-500 bg-purple-600/15 text-purple-600 dark:text-purple-400'
                      : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-purple-500/50'
                  }`}
                  title={privacyShieldBlur ? 'Privacy Shield On (hover to reveal)' : 'Enable Privacy Shield Blur'}
                >
                  {privacyShieldBlur ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>

                {/* Desktop Split Multi-Window Chat */}
                {user.featureSelection?.desktop_multi_window !== false && rooms.length > 1 && onSelectSplitRoom && (
                  <button
                    type="button"
                    onClick={() => {
                      if (splitRoomId) {
                        onSelectSplitRoom(null);
                      } else {
                        const other = rooms.find((r) => r.id !== activeRoom.id);
                        if (other) onSelectSplitRoom(other.id);
                      }
                    }}
                    className={`hidden lg:inline-flex p-2 rounded-xl border transition-colors ${
                      splitRoomId
                        ? 'border-purple-500 bg-purple-600/15 text-purple-600 dark:text-purple-400'
                        : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-purple-500/50'
                    }`}
                    title="Toggle Dual Split-Window Chat"
                  >
                    <Columns2 className="w-4 h-4" />
                  </button>
                )}

                {/* Move to / Remove from Private Vault */}
                <button
                  type="button"
                  onClick={async () => {
                    await rrApi.toggleRoomVault(token, activeRoom.id, !isActiveRoomInVault);
                    await onRoomsChanged();
                  }}
                  className={`p-2 rounded-xl border transition-colors ${
                    isActiveRoomInVault
                      ? 'border-purple-500 bg-purple-600/15 text-purple-600 dark:text-purple-400'
                      : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-purple-500/50'
                  }`}
                  title={isActiveRoomInVault ? 'Remove from Private Vault' : 'Move to Private Vault'}
                >
                  {isActiveRoomInVault ? <Unlock className="w-4 h-4" /> : <Vault className="w-4 h-4" />}
                </button>

                {activeRoom.type === 'group' && (
                  <button
                    type="button"
                    onClick={() => setShowRoomModeration((v) => !v)}
                    className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/50 text-zinc-600 dark:text-zinc-300"
                    title="Smart Room Moderation & Settings"
                  >
                    <Settings2 className="w-4 h-4" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setShowThreadSearch((v) => !v)}
                  className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/50 text-zinc-600 dark:text-zinc-300"
                  title="Search messages"
                >
                  <Search className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => setShowVerifyPanel((v) => !v)}
                  className={`p-2 rounded-xl border transition-colors ${
                    getRoomPeerVerificationStatus(activeRoom) === 'verified'
                      ? 'border-purple-500/60 bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-300'
                      : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300'
                  }`}
                  title="Verify Encryption Keys"
                >
                  <ShieldCheck className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={onToggleChatBoxOnly}
                  className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300"
                  title={chatBoxOnly ? 'Show Chat List' : 'Focus Chat Box Only'}
                >
                  {chatBoxOnly ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </button>

                {chatBoxOnly && (
                  <button
                    type="button"
                    onClick={() => setShowMenu((v) => !v)}
                    className="p-2 rounded-xl border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200"
                    title="Menu & Private Settings"
                  >
                    <Menu className="w-4 h-4" />
                  </button>
                )}
              </div>
              {chatBoxOnly && renderMenuDropdown()}
            </div>

            {/* Ghost Chat Explicit Privacy Notice */}
            {activeRoom.disappearingTtlSeconds && (
              <div className="px-5 py-2 bg-purple-50 dark:bg-purple-950/30 border-b border-purple-200 dark:border-purple-800/60 text-[11px] text-purple-900 dark:text-purple-200 flex items-center gap-2">
                <Ghost className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
                <span>
                  Ghost Chat ({activeRoom.disappearingTtlSeconds}s): Messages auto-expire from server &amp; chats,
                  though recipients can still capture screenshots, copy text, or save exported media.
                </span>
              </div>
            )}

            {showThreadSearch && (
              <div className="px-5 py-2.5 border-b border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-zinc-950 flex items-center gap-2">
                <Search className="w-4 h-4 text-zinc-400" />
                <input
                  type="text"
                  value={threadSearch}
                  onChange={(e) => setThreadSearch(e.target.value)}
                  placeholder="Search decrypted messages in this chat..."
                  className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none"
                />
                {threadSearch && (
                  <button type="button" onClick={() => setThreadSearch('')} className="text-xs text-zinc-500">
                    Clear
                  </button>
                )}
              </div>
            )}

            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Message Feed */}
              <div
                className={`flex-1 overflow-y-auto p-5 space-y-3.5 ${
                  user.screenshotPrivacy !== false ? 'rr-screenshot-shield' : ''
                }`}
              >
                {visibleMessages.length === 0 ? (
                  <div className="py-16 text-center text-sm text-zinc-500">
                    No messages yet. Say hello, send a 3D sticker, share media, start a call, or send a payment.
                  </div>
                ) : (
                  visibleMessages.map((item) => {
                    const isMine = item.raw.senderId === user.id;
                    const senderUser = activeRoom.members.find((m) => m.id === item.raw.senderId);
                    const repliedItem = item.raw.replyToId
                      ? activeMessages.find((m) => m.raw.id === item.raw.replyToId)
                      : null;
                    const readCount = item.raw.readBy.filter((id) => id !== item.raw.senderId).length;
                    const deliveredCount = item.raw.deliveredTo.filter((id) => id !== item.raw.senderId).length;
                    const isEditingThis = editingMsg?.id === item.raw.id;
                    const use3D = user.featureSelection?.['3d_chat_themes'] !== false;
                    const bubbleThemeClass = isMine
                      ? CHAT_THEMES[chatTheme].mineBubble
                      : CHAT_THEMES[chatTheme].peerBubble;

                    return (
                      <div key={item.raw.id} className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
                        <div
                          className={`max-w-xl rounded-2xl px-4 py-3 border shadow-sm text-zinc-900 dark:text-zinc-100 ${bubbleThemeClass} ${
                            use3D ? 'rr-3d-bubble' : ''
                          } ${privacyShieldBlur ? 'blur-sm hover:blur-none transition-all duration-200' : ''}`}
                        >
                          {(activeRoom.type === 'group' && !isMine) || item.raw.expiresAt ? (
                            <div className="flex items-center justify-between gap-4 mb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                              {activeRoom.type === 'group' && !isMine && (
                                <span className="font-medium text-purple-600 dark:text-purple-400">
                                  {senderUser?.displayName ?? 'Member'}
                                </span>
                              )}
                              {item.raw.expiresAt && (
                                <span className="text-amber-600 dark:text-amber-400 font-mono tabular-nums">
                                  Self-destructs in {Math.max(0, Math.ceil((item.raw.expiresAt - nowTick) / 1000))}s
                                </span>
                              )}
                            </div>
                          ) : null}

                          {repliedItem && (
                            <div className="mb-2 px-2.5 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-950/80 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 truncate">
                              {repliedItem.paymentData
                                ? `Payment $${(repliedItem.paymentData.amountCents / 100).toFixed(2)}`
                                : repliedItem.stickerData
                                  ? `3D Sticker: ${repliedItem.stickerData.name}`
                                  : repliedItem.plaintext || 'Message'}
                            </div>
                          )}

                          {item.raw.deleted ? (
                            <p className="text-xs italic text-zinc-500">
                              {item.raw.recalledAt ? '[Message recalled by sender]' : '[Message deleted]'}
                            </p>
                          ) : isEditingThis ? (
                            <form onSubmit={handleSaveMessageEdit} className="space-y-2 min-w-[240px]">
                              <input
                                type="text"
                                autoFocus
                                value={editingMsg.text}
                                onChange={(e) => setEditingMsg({ ...editingMsg, text: e.target.value })}
                                className="w-full px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-purple-500 text-sm"
                              />
                              <div className="flex justify-end gap-2 text-xs">
                                <button
                                  type="button"
                                  onClick={() => setEditingMsg(null)}
                                  className="px-2.5 py-1 rounded border border-zinc-300 dark:border-zinc-700"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="submit"
                                  className="px-2.5 py-1 rounded bg-purple-600 text-white font-medium"
                                >
                                  Save
                                </button>
                              </div>
                            </form>
                          ) : item.decryptionError ? (
                            <p className="text-xs text-amber-500">{item.decryptionError}</p>
                          ) : item.stickerData ? (
                            <div className="py-2 px-3">
                              <Sticker3DGraphic sticker={item.stickerData} size={86} />
                            </div>
                          ) : item.paymentData ? (
                            <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-purple-300 dark:border-purple-700/50 space-y-1 min-w-[210px]">
                              <div className="flex items-center gap-1.5 text-xs text-purple-600 dark:text-purple-400 font-medium">
                                <DollarSign className="w-3.5 h-3.5" />
                                <span>{isMine ? 'Payment Sent' : 'Payment Received'}</span>
                              </div>
                              <div className="text-xl font-semibold font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
                                ${(item.paymentData.amountCents / 100).toFixed(2)}
                              </div>
                              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                                To {item.paymentData.recipientName}
                              </div>
                              {item.paymentData.note && (
                                <div className="text-xs text-zinc-700 dark:text-zinc-300 pt-1 border-t border-zinc-200 dark:border-zinc-800">
                                  {item.paymentData.note}
                                </div>
                              )}
                            </div>
                          ) : item.raw.kind === 'call' ? (
                            <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                              <Phone className="w-3.5 h-3.5 text-purple-500" />
                              <span>{item.plaintext}</span>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{item.plaintext}</p>
                              {item.suspiciousUrls && item.suspiciousUrls.length > 0 && (
                                <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-700/60 text-xs space-y-1">
                                  <div className="flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-300">
                                    <AlertTriangle className="w-3.5 h-3.5" />
                                    Phishing Protection Warning
                                  </div>
                                  {item.suspiciousUrls.map((su, idx) => (
                                    <div key={idx} className="flex items-center justify-between gap-2 text-[11px]">
                                      <span className="truncate font-mono text-amber-900 dark:text-amber-200">{su.url}</span>
                                      <button
                                        type="button"
                                        onClick={() => setPendingExternalUrl(su)}
                                        className="px-2 py-0.5 rounded bg-amber-600 text-white shrink-0"
                                      >
                                        Inspect
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {translatedByMsgId[item.raw.id] && (
                            <div className="mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-800 text-xs text-purple-700 dark:text-purple-300">
                              <span className="font-semibold">Translated · </span>
                              {translatedByMsgId[item.raw.id]}
                            </div>
                          )}

                          {!item.raw.deleted && item.attachmentUrl && item.raw.kind === 'image' && (
                            <img
                              src={item.attachmentUrl}
                              alt={item.attachmentName ?? 'Photo'}
                              className="mt-2.5 max-h-72 rounded-xl border border-zinc-200 dark:border-zinc-800 object-contain"
                            />
                          )}

                          {!item.raw.deleted && item.attachmentUrl && item.raw.kind === 'video' && (
                            <video
                              controls
                              src={item.attachmentUrl}
                              className="mt-2.5 max-h-72 rounded-xl border border-zinc-200 dark:border-zinc-800 max-w-full"
                            />
                          )}

                          {!item.raw.deleted && item.attachmentUrl && item.raw.kind === 'voice' && (
                            <EncryptedVoicePlayer
                              url={item.attachmentUrl}
                              durationSec={item.voiceDurationSec}
                              effect={item.voiceEffect}
                              isMine={isMine}
                            />
                          )}

                          {!item.raw.deleted && item.attachmentUrl && item.raw.kind === 'file' && (
                            <a
                              href={item.attachmentUrl}
                              download={item.attachmentName ?? 'file'}
                              className="mt-2.5 inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs text-purple-700 dark:text-purple-300 hover:border-purple-500/60"
                            >
                              <FileText className="w-4 h-4" />
                              <span className="truncate max-w-[200px]">{item.attachmentName}</span>
                              <Download className="w-3.5 h-3.5" />
                            </a>
                          )}

                          {!item.raw.deleted && Object.keys(item.raw.reactions).length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                              {Object.entries(item.raw.reactions).map(([emoji, reactors]) => (
                                <button
                                  key={emoji}
                                  type="button"
                                  onClick={() => rrApi.reactMessage(token, item.raw.id, activeRoom.id, emoji)}
                                  className="px-2 py-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200 font-mono tabular-nums"
                                >
                                  {emoji} {reactors.length}
                                </button>
                              ))}
                            </div>
                          )}

                          <div className="mt-2 pt-1.5 border-t border-zinc-200/70 dark:border-zinc-800/60 flex items-center justify-between gap-3 text-[11px] text-zinc-500">
                            {!item.raw.deleted ? (
                              <div className="flex items-center gap-2 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() => setReplyTo(item)}
                                  className="hover:text-zinc-900 dark:hover:text-zinc-200 inline-flex items-center gap-1"
                                >
                                  <Reply className="w-3 h-3" />
                                  Reply
                                </button>
                                {isMine && item.raw.kind === 'text' && (
                                  <button
                                    type="button"
                                    onClick={() => setEditingMsg({ id: item.raw.id, text: item.plaintext })}
                                    className="hover:text-purple-500 inline-flex items-center gap-1"
                                    title="Edit message"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                                {isMine && user.featureSelection?.message_recall !== false && (
                                  <button
                                    type="button"
                                    onClick={() => rrApi.recallMessage(token, activeRoom.id, item.raw.id)}
                                    className="hover:text-amber-500 inline-flex items-center gap-1"
                                    title="Recall message for everyone"
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                  </button>
                                )}
                                {(isMine || isRoomAdmin) && (
                                  <button
                                    type="button"
                                    onClick={() => rrApi.deleteMessage(token, activeRoom.id, item.raw.id)}
                                    className="hover:text-red-500 inline-flex items-center gap-1"
                                    title="Delete message"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                )}
                                {item.raw.kind === 'text' && item.plaintext && (
                                  <button
                                    type="button"
                                    onClick={() => handleQuickTranslate(item.raw.id, item.plaintext)}
                                    className="hover:text-purple-500 inline-flex items-center gap-1"
                                    title={`Translate to ${translateLang} (Opt-In AI)`}
                                  >
                                    <Languages className="w-3 h-3" />
                                  </button>
                                )}
                                {QUICK_REACTIONS.map((emoji) => (
                                  <button
                                    key={emoji}
                                    type="button"
                                    onClick={() => rrApi.reactMessage(token, item.raw.id, activeRoom.id, emoji)}
                                    className="hover:scale-110 transition-transform"
                                  >
                                    {emoji}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <span />
                            )}

                            <div className="flex items-center gap-2 font-mono tabular-nums shrink-0">
                              {item.raw.editedAt && <span className="text-[10px]">(edited)</span>}
                              <span>
                                {new Date(item.raw.createdAt).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                              {isMine && !item.raw.deleted && (
                                <span className="inline-flex items-center gap-0.5 text-zinc-400">
                                  {readCount > 0 ? (
                                    <CheckCheck className="w-3.5 h-3.5 text-purple-500" />
                                  ) : deliveredCount > 0 ? (
                                    <CheckCheck className="w-3.5 h-3.5" />
                                  ) : (
                                    <Check className="w-3.5 h-3.5" />
                                  )}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={bottomRef} />
              </div>

              {/* Desktop Multi-Window Split Room Pane */}
              {splitRoom && onSelectSplitRoom && (
                <aside className="hidden lg:flex w-80 xl:w-96 border-l border-zinc-200 dark:border-zinc-800/80 bg-white/80 dark:bg-[#090B12] flex-col shrink-0">
                  <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2">
                    <select
                      value={splitRoom.id}
                      onChange={(e) => onSelectSplitRoom(e.target.value)}
                      className="text-xs font-semibold bg-transparent text-zinc-900 dark:text-zinc-100 truncate focus:outline-none"
                    >
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id} className="bg-white dark:bg-zinc-900">
                          Split: {getRoomDisplayTitle(r)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => onSelectSplitRoom(null)}
                      className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                      title="Close split pane"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
                    {(decryptedByRoom[splitRoom.id] ?? []).slice(-25).map((item) => {
                      const isMineSplit = item.raw.senderId === user.id;
                      return (
                        <div key={item.raw.id} className={`flex flex-col ${isMineSplit ? 'items-end' : 'items-start'}`}>
                          <div
                            className={`max-w-[90%] rounded-xl px-3 py-2 border text-xs ${
                              isMineSplit
                                ? 'bg-purple-600/15 dark:bg-purple-950/40 border-purple-300 dark:border-purple-700/60'
                                : 'bg-white dark:bg-[#0D1018] border-zinc-200 dark:border-zinc-800'
                            }`}
                          >
                            {item.raw.deleted ? (
                              <span className="italic text-zinc-500">
                                {item.raw.recalledAt ? '[Recalled]' : '[Deleted]'}
                              </span>
                            ) : item.stickerData ? (
                              <Sticker3DGraphic sticker={item.stickerData} size={52} />
                            ) : (
                              <span>{item.plaintext || item.decryptionError}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <form
                    onSubmit={(e) => handleSendText(e, splitRoom, splitComposerText)}
                    className="p-2.5 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-1.5"
                  >
                    <input
                      type="text"
                      value={splitComposerText}
                      onChange={(e) => setSplitComposerText(e.target.value)}
                      placeholder="Reply in split pane..."
                      className="flex-1 px-3 py-1.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                    />
                    <button
                      type="submit"
                      disabled={!splitComposerText.trim()}
                      className="p-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                  </form>
                </aside>
              )}

              {/* Smart Room Moderation Drawer */}
              {showRoomModeration && activeRoom.type === 'group' && (
                <aside className="w-80 border-l border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#0D1018] p-5 overflow-y-auto space-y-5 shrink-0">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Smart Room Moderation</h4>
                    <button
                      type="button"
                      onClick={() => setShowRoomModeration(false)}
                      className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {isRoomAdmin && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await rrApi.updateRoomSettings(token, activeRoom.id, {
                          topic: modTopic,
                          slowModeSeconds: modSlowMode > 0 ? modSlowMode : null,
                        });
                        await onRoomsChanged();
                      }}
                      className="space-y-3 border-b border-zinc-200 dark:border-zinc-800 pb-4"
                    >
                      <div>
                        <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                          Room Topic
                        </label>
                        <input
                          type="text"
                          value={modTopic}
                          onChange={(e) => setModTopic(e.target.value)}
                          placeholder="Encrypted team briefing..."
                          className="w-full px-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                          Slow Mode Interval
                        </label>
                        <select
                          value={modSlowMode}
                          onChange={(e) => setModSlowMode(Number(e.target.value))}
                          className="w-full px-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                        >
                          <option value={0}>Off</option>
                          <option value={5}>5 seconds</option>
                          <option value={15}>15 seconds</option>
                          <option value={30}>30 seconds</option>
                          <option value={60}>60 seconds</option>
                        </select>
                      </div>
                      <button
                        type="submit"
                        className="w-full py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
                      >
                        Update Room Policy
                      </button>
                    </form>
                  )}

                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                      Members ({activeRoom.members.length})
                    </div>
                    {activeRoom.members.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                      >
                        <div className="truncate">
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{m.displayName}</span>
                          {activeRoom.adminIds.includes(m.id) && (
                            <span className="ml-1.5 text-purple-500 font-mono">Admin</span>
                          )}
                        </div>
                        {isRoomAdmin && m.id !== user.id && (
                          <button
                            type="button"
                            onClick={async () => {
                              await rrApi.kickRoomMember(token, activeRoom.id, m.id);
                              await onRoomsChanged();
                            }}
                            className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 rounded"
                            title="Remove member"
                          >
                            <UserMinus className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </aside>
              )}

              {/* Peer Safety Fingerprint Drawer */}
              {showVerifyPanel && (
                <aside className="w-80 border-l border-zinc-200 dark:border-zinc-800/80 bg-white dark:bg-[#0D1018] p-5 overflow-y-auto space-y-5 shrink-0">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Encryption Verification</h4>
                    <button
                      type="button"
                      onClick={() => setShowVerifyPanel(false)}
                      className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    Verify device fingerprints out-of-band or via QR code in Contacts.
                  </p>

                  <div className="space-y-4">
                    {activeRoom.members.map((member) => (
                      <div key={member.id} className="space-y-2 border-t border-zinc-200 dark:border-zinc-800 pt-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                            {member.displayName}
                          </span>
                          {member.id !== user.id && (
                            <button
                              type="button"
                              onClick={async () => {
                                await rrApi.blockUser(token, member.id);
                                await onRoomsChanged();
                                setError(`Blocked ${member.displayName}.`);
                              }}
                              className="text-[11px] text-red-500 hover:text-red-400 inline-flex items-center gap-1"
                            >
                              <ShieldAlert className="w-3 h-3" />
                              Block
                            </button>
                          )}
                        </div>
                        {member.devices.map((dev) => {
                          const isSelf = dev.deviceId === deviceId;
                          const isVerified = isSelf || vault.verifiedPeerDevices[dev.deviceId] === dev.fingerprint;
                          return (
                            <div
                              key={dev.deviceId}
                              className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 space-y-2"
                            >
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-zinc-800 dark:text-zinc-200 font-medium">{dev.deviceName}</span>
                                <span className={isVerified ? 'text-purple-600 dark:text-purple-400' : 'text-amber-500'}>
                                  {isSelf ? 'This Device' : isVerified ? 'Verified' : 'Unverified'}
                                </span>
                              </div>
                              <div className="font-mono text-[11px] text-zinc-500 break-all leading-relaxed">
                                {dev.fingerprint}
                              </div>
                              {!isSelf && !isVerified && (
                                <button
                                  type="button"
                                  onClick={() => handleMarkDeviceVerified(dev.deviceId, dev.fingerprint)}
                                  className="w-full py-1.5 text-xs font-medium rounded-lg bg-purple-600 hover:bg-purple-500 text-white inline-flex items-center justify-center gap-1.5"
                                >
                                  <ShieldCheck className="w-3.5 h-3.5" />
                                  Verify Fingerprint
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </aside>
              )}
            </div>

            {/* Composer */}
            <div className="p-4 border-t border-zinc-200 dark:border-zinc-800/80 rr-glass space-y-2.5 relative">
              {error && <p className="text-xs text-red-500">{error}</p>}

              {(!isOnline || offlineOutbox.length > 0) && (
                <div className="px-3 py-1.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800/60 flex items-center justify-between text-xs text-amber-900 dark:text-amber-200">
                  <span className="flex items-center gap-1.5">
                    <WifiOff className="w-3.5 h-3.5" />
                    {!isOnline
                      ? `Offline Mode · ${offlineOutbox.length} encrypted message(s) queued locally`
                      : `${offlineOutbox.length} queued message(s) ready to deliver`}
                  </span>
                  {isOnline && offlineOutbox.length > 0 && (
                    <button
                      type="button"
                      onClick={() => flushOfflineOutbox()}
                      className="px-2.5 py-0.5 rounded bg-amber-600 text-white font-semibold"
                    >
                      Flush Now
                    </button>
                  )}
                </div>
              )}

              {showStickerPicker && (
                <div className="p-3.5 rounded-2xl bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800 shadow-xl space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">3D Animated Stickers</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowStickerCreator(true)}
                        className="px-2.5 py-1 rounded-lg bg-purple-600 text-white text-[11px] font-medium inline-flex items-center gap-1"
                      >
                        <Plus className="w-3 h-3" />
                        Create 3D Sticker
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowStickerPicker(false)}
                        className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
                    {(user.stickerPack ?? []).map((stk) => (
                      <button
                        key={stk.id}
                        type="button"
                        onClick={() => handleSendSticker(stk)}
                        className="p-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 hover:border-purple-500 flex flex-col items-center"
                      >
                        <Sticker3DGraphic sticker={stk} size={48} />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {smartReplies.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-purple-600 dark:text-purple-400 font-medium">AI Replies:</span>
                  {smartReplies.map((s, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setComposerText(s);
                        setSmartReplies([]);
                      }}
                      className="px-3 py-1 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/60 text-xs text-purple-900 dark:text-purple-200 hover:border-purple-500"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {showPaymentBox && (
                <form
                  onSubmit={handleSendPayment}
                  className="p-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-950 border border-purple-300 dark:border-purple-800/60 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-purple-600 dark:text-purple-400 flex items-center gap-1.5">
                      <DollarSign className="w-3.5 h-3.5" />
                      Send Private Peer-to-Peer Payment
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowPaymentBox(false)}
                      className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {peerMembers.length > 1 && (
                      <select
                        value={payRecipientId}
                        onChange={(e) => setPayRecipientId(e.target.value)}
                        className="px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-zinc-100"
                      >
                        {peerMembers.map((m) => (
                          <option key={m.id} value={m.id}>
                            To {m.displayName}
                          </option>
                        ))}
                      </select>
                    )}

                    <div className="flex items-center gap-1.5">
                      {[5, 10, 25].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setPayAmountDollars(String(preset))}
                          className="px-2.5 py-1.5 text-xs font-mono rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-purple-500 text-zinc-800 dark:text-zinc-200"
                        >
                          ${preset}
                        </button>
                      ))}
                    </div>

                    <input
                      type="number"
                      min="0.01"
                      max="10000"
                      step="0.01"
                      value={payAmountDollars}
                      onChange={(e) => setPayAmountDollars(e.target.value)}
                      placeholder="Amount USD"
                      className="w-28 px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs font-mono text-zinc-900 dark:text-zinc-100"
                    />
                    <input
                      type="text"
                      value={payNote}
                      onChange={(e) => setPayNote(e.target.value)}
                      placeholder="Optional note"
                      className="flex-1 min-w-[140px] px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-zinc-100"
                    />
                    <button
                      type="submit"
                      disabled={sending}
                      className="px-3.5 py-1.5 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white whitespace-nowrap"
                    >
                      Pay ${Number(payAmountDollars || 0).toFixed(2)}
                    </button>
                  </div>
                </form>
              )}

              {replyTo && (
                <div className="px-3 py-1.5 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-300">
                  <span className="truncate">Replying to: {replyTo.plaintext}</span>
                  <button
                    type="button"
                    onClick={() => setReplyTo(null)}
                    className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {showVoiceRecorder && (
                <VoiceMessageRecorder
                  sending={sending}
                  voiceEffect={voiceEffect}
                  onVoiceEffectChange={setVoiceEffect}
                  onSendVoice={handleSendVoiceMessage}
                  onClose={() => setShowVoiceRecorder(false)}
                />
              )}

              <form onSubmit={(e) => handleSendText(e)} className="flex items-center gap-1.5 sm:gap-2 flex-wrap sm:flex-nowrap">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileUpload(file);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,video/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileUpload(file);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileUpload(file);
                    e.target.value = '';
                  }}
                />

                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  disabled={sending}
                  className="p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-700 dark:text-zinc-200 shrink-0"
                  title="Send Photo"
                >
                  <ImageIcon className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => videoInputRef.current?.click()}
                  disabled={sending}
                  className="p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-700 dark:text-zinc-200 shrink-0"
                  title="Send Video"
                >
                  <Film className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending}
                  className="p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-600 dark:text-zinc-300 shrink-0"
                  title="Attach File"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowStickerPicker((v) => !v)}
                  disabled={sending}
                  className={`p-2.5 rounded-xl border shrink-0 transition-colors ${
                    showStickerPicker
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/50 text-purple-600 dark:text-purple-300'
                      : 'border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-600 dark:text-zinc-300'
                  }`}
                  title="3D Animated Stickers"
                >
                  <Smile className="w-4 h-4" />
                </button>

                {/* Encrypted Voice Message Recorder Toggle */}
                <button
                  type="button"
                  onClick={() => setShowVoiceRecorder((v) => !v)}
                  disabled={sending}
                  className={`p-2.5 rounded-xl border shrink-0 transition-colors ${
                    showVoiceRecorder
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/50 text-purple-600 dark:text-purple-300'
                      : 'border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-600 dark:text-zinc-300'
                  }`}
                  title={showVoiceRecorder ? 'Close voice recorder' : 'Record & encrypt voice message'}
                  aria-label="Toggle encrypted voice message recorder"
                >
                  <Mic className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => setShowPaymentBox((v) => !v)}
                  disabled={sending || peerMembers.length === 0}
                  className={`p-2.5 rounded-xl border shrink-0 transition-colors ${
                    showPaymentBox
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/50 text-purple-600 dark:text-purple-300'
                      : 'border-zinc-200 dark:border-zinc-800 hover:border-purple-500/60 text-zinc-700 dark:text-zinc-200'
                  }`}
                  title="Send Payment"
                >
                  <DollarSign className="w-4 h-4" />
                </button>
                {aiConsentGranted && (
                  <button
                    type="button"
                    disabled={loadingSmartReplies}
                    onClick={handleQuickSmartReplies}
                    className="p-2.5 rounded-xl border border-purple-300 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-300 shrink-0"
                    title="Suggest AI Replies"
                  >
                    <Sparkles className="w-4 h-4" />
                  </button>
                )}
                <input
                  type="text"
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  placeholder="Write an encrypted message..."
                  className="flex-1 min-w-[140px] px-4 py-2.5 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-purple-500"
                />
                <button
                  type="submit"
                  disabled={sending || !composerText.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white whitespace-nowrap shrink-0"
                >
                  <Send className="w-4 h-4" />
                  Send
                </button>
              </form>
            </div>
          </>
        )}
      </section>

      {/* Smart Room Creation Modal */}
      {showGroupModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <form
            onSubmit={handleCreateSmartRoom}
            className="w-full max-w-md bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Create Smart Chat Room</h3>
              <button
                type="button"
                onClick={() => setShowGroupModal(false)}
                className="text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">Room Name</label>
              <input
                type="text"
                required
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
                placeholder="Core Security Ops"
                className="w-full px-3.5 py-2 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-purple-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Topic (Optional)
              </label>
              <input
                type="text"
                value={groupTopic}
                onChange={(e) => setGroupTopic(e.target.value)}
                placeholder="Private topic & coordination"
                className="w-full px-3.5 py-2 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-purple-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
                <input
                  type="checkbox"
                  checked={groupInviteOnly}
                  onChange={(e) => setGroupInviteOnly(e.target.checked)}
                  className="accent-purple-600"
                />
                <span>Invite-Only Room</span>
              </label>
              <select
                value={groupSlowMode}
                onChange={(e) => setGroupSlowMode(Number(e.target.value))}
                className="px-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-800 dark:text-zinc-200"
              >
                <option value={0}>Slow Mode: Off</option>
                <option value={5}>Slow Mode: 5s</option>
                <option value={15}>Slow Mode: 15s</option>
                <option value={30}>Slow Mode: 30s</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Invite Members
              </label>
              <div className="max-h-40 overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-xl divide-y divide-zinc-200 dark:divide-zinc-800/70 bg-zinc-50 dark:bg-zinc-950">
                {directoryUsers.length === 0 ? (
                  <p className="p-3 text-xs text-zinc-500">No other users registered yet.</p>
                ) : (
                  directoryUsers.map((u) => {
                    const checked = selectedMemberIds.includes(u.id);
                    return (
                      <label
                        key={u.id}
                        className="flex items-center gap-3 p-3 text-sm cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-900"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedMemberIds((prev) =>
                              checked ? prev.filter((id) => id !== u.id) : [...prev, u.id]
                            )
                          }
                          className="accent-purple-600"
                        />
                        <span className="text-zinc-900 dark:text-zinc-200">{u.displayName}</span>
                        <span className="font-mono text-xs text-purple-600 dark:text-purple-400">@{u.username}</span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowGroupModal(false)}
                className="px-4 py-2 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={selectedMemberIds.length === 0}
                className="px-4 py-2 text-sm font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white"
              >
                Create Smart Room
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Custom 3D Sticker Creator Modal */}
      {showStickerCreator && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <form
            onSubmit={handleCreateCustomSticker}
            className="w-full max-w-md bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Create 3D Animated Sticker</h3>
              <button type="button" onClick={() => setShowStickerCreator(false)} className="text-zinc-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex justify-center py-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800">
              <Sticker3DGraphic
                sticker={{
                  name: newStickerName || 'Preview',
                  shape: newStickerShape,
                  color: newStickerColor,
                  glowColor: '#a855f7',
                  animation: newStickerAnim,
                  label: newStickerLabel || 'RR-3D',
                }}
                size={88}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                required
                value={newStickerName}
                onChange={(e) => setNewStickerName(e.target.value)}
                placeholder="Sticker Name"
                className="px-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
              />
              <input
                type="text"
                required
                value={newStickerLabel}
                onChange={(e) => setNewStickerLabel(e.target.value)}
                placeholder="Badge Label"
                className="px-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs font-mono"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <select
                value={newStickerShape}
                onChange={(e) => setNewStickerShape(e.target.value as Sticker3DItem['shape'])}
                className="px-2.5 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
              >
                <option value="cube">Cube</option>
                <option value="torus">Torus</option>
                <option value="prism">Prism</option>
                <option value="star">Star</option>
              </select>
              <select
                value={newStickerAnim}
                onChange={(e) => setNewStickerAnim(e.target.value as Sticker3DItem['animation'])}
                className="px-2.5 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
              >
                <option value="spin">3D Spin</option>
                <option value="bounce">Float Bounce</option>
                <option value="orbit">Orbit</option>
                <option value="pulse">Neon Pulse</option>
              </select>
              <input
                type="color"
                value={newStickerColor}
                onChange={(e) => setNewStickerColor(e.target.value)}
                className="w-full h-9 rounded-xl border border-zinc-200 dark:border-zinc-800 cursor-pointer bg-transparent"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowStickerCreator(false)}
                className="px-3.5 py-2 text-xs rounded-xl border border-zinc-200 dark:border-zinc-700"
              >
                Cancel
              </button>
              <button type="submit" className="px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 text-white">
                Save to Sticker Pack
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Scheduled Encrypted Messages Modal */}
      {showScheduleModal && activeRoom && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-md bg-white dark:bg-[#0D1018] border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                <CalendarClock className="w-4 h-4 text-purple-500" />
                Schedule Encrypted Message
              </h3>
              <button type="button" onClick={() => setShowScheduleModal(false)} className="text-zinc-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleScheduleMessage} className="space-y-3">
              <textarea
                rows={3}
                required
                value={scheduleText}
                onChange={(e) => setScheduleText(e.target.value)}
                placeholder="Write message to encrypt locally now & deliver later..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
              />
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">Deliver in:</span>
                <select
                  value={scheduleMinutes}
                  onChange={(e) => setScheduleMinutes(Number(e.target.value))}
                  className="px-3 py-1.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                >
                  <option value={1}>1 minute</option>
                  <option value={5}>5 minutes</option>
                  <option value={15}>15 minutes</option>
                  <option value={60}>1 hour</option>
                </select>
                <button
                  type="submit"
                  className="ml-auto px-4 py-1.5 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
                >
                  Schedule E2EE Send
                </button>
              </div>
            </form>
            {scheduledItems.length > 0 && (
              <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3 space-y-2 max-h-40 overflow-y-auto">
                <div className="text-[11px] font-semibold text-zinc-500">Pending Scheduled Deliveries</div>
                {scheduledItems.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
                  >
                    <span className="font-mono text-zinc-600 dark:text-zinc-300">
                      Deliver at {new Date(s.deliverAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        await rrApi.cancelScheduledMessage(token, activeRoom.id, s.id);
                        await loadScheduledMessages(activeRoom.id);
                      }}
                      className="text-red-500 text-[11px] hover:underline"
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Phishing URL Inspection Modal */}
      {pendingExternalUrl && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-md bg-white dark:bg-[#0D1018] border border-amber-500/60 rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2.5 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="text-base font-semibold">Suspicious Link Inspection</h3>
            </div>
            <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 font-mono text-xs break-all">
              {pendingExternalUrl.url}
            </div>
            <ul className="list-disc pl-5 text-xs text-zinc-600 dark:text-zinc-300 space-y-1">
              {pendingExternalUrl.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingExternalUrl(null)}
                className="px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 text-white"
              >
                Stay Safe &amp; Close
              </button>
              <a
                href={pendingExternalUrl.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setPendingExternalUrl(null)}
                className="px-4 py-2 text-xs rounded-xl border border-amber-500 text-amber-600 dark:text-amber-300"
              >
                Open Anyway
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
