import fs from 'node:fs';
import path from 'node:path';

export interface PrivacySettings {
  discoverableByUsername: boolean;
  sendReadReceipts: boolean;
  hideNotificationPreviews: boolean;
  allowGroupInvites: boolean;
  contactNumberVisibility: 'private';
  allowLookupByContactNumber: boolean;
  hideOnlinePresence: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  soundEnabled: boolean;
  loginAlertsEnabled: boolean;
  previewMode: 'none' | 'sender_only';
  customSound?: 'crystal' | 'pulse' | 'chime' | 'silent';
}

export interface GamingConnection {
  platform: string;
  gamertag: string;
  discordUsername: string;
  discordInviteCode: string;
  discordConnectedViaOAuth: boolean;
  visibility: 'private';
}

export interface Identity3DConfig {
  form: 'sentinel' | 'orbital' | 'helm';
  finish: 'obsidian' | 'silver' | 'titanium';
  auraColor: 'purple' | 'violet' | 'silver' | 'emerald';
  effect: 'pulse' | 'orbit' | 'static';
  badge: 'none' | 'zero_phone' | 'vault_guard' | 'verified_node';
  profileTheme: 'obsidian_purple' | 'silver_frost' | 'midnight_glass';
}

export const DEFAULT_IDENTITY_3D: Identity3DConfig = {
  form: 'sentinel',
  finish: 'obsidian',
  auraColor: 'purple',
  effect: 'orbit',
  badge: 'zero_phone',
  profileTheme: 'obsidian_purple',
};

export interface Sticker3DItem {
  id: string;
  name: string;
  shape: 'cube' | 'torus' | 'prism' | 'star';
  color: string;
  glowColor: string;
  animation: 'spin' | 'bounce' | 'pulse' | 'orbit';
  label: string;
  createdAt: number;
}

export const DEFAULT_STICKER_PACK: Sticker3DItem[] = [
  {
    id: 'stk-shield-lock',
    name: 'Cyber Shield',
    shape: 'prism',
    color: '#A855F7',
    glowColor: '#C084FC',
    animation: 'orbit',
    label: 'LOCKED 🔒',
    createdAt: 1,
  },
  {
    id: 'stk-namaste-pulse',
    name: 'Silver Namaste',
    shape: 'star',
    color: '#E2E8F0',
    glowColor: '#A855F7',
    animation: 'pulse',
    label: 'NAMASTE 🙏',
    createdAt: 2,
  },
  {
    id: 'stk-gg-cube',
    name: 'GG Matrix',
    shape: 'cube',
    color: '#8B5CF6',
    glowColor: '#22D3EE',
    animation: 'spin',
    label: 'GG ⚡',
    createdAt: 3,
  },
  {
    id: 'stk-ghost-ring',
    name: 'Ghost Mode',
    shape: 'torus',
    color: '#CBD5E1',
    glowColor: '#9333EA',
    animation: 'bounce',
    label: 'GHOST 👻',
    createdAt: 4,
  },
];

export const ALL_26_FEATURE_IDS = [
  'private_username_chat',
  'end_to_end_encryption',
  'voice_video_call',
  '3d_animated_profile',
  'ghost_message',
  'private_vault',
  'panic_lock',
  'duress_pin',
  'ai_assistant',
  'ai_image_sticker_gen',
  'live_translation',
  'stories_status',
  'private_communities',
  'live_streaming',
  'screen_sharing',
  '3d_chat_themes',
  'qr_friend_connect',
  'encrypted_cloud_backup',
  'multi_device_sync',
  'security_radar',
  'offline_message_queue',
  'custom_notification_sound',
  'scheduled_messages',
  'message_recall',
  'spam_scam_detection',
  'desktop_multi_window',
] as const;

export function createDefaultFeatureSelection(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const id of ALL_26_FEATURE_IDS) map[id] = true;
  return map;
}

export type OAuthProviderId = 'google' | 'facebook' | 'github' | 'discord';

export interface UserAccount {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  authProvider?: 'local' | OAuthProviderId;
  linkedProviders?: OAuthProviderId[];
  contactNumberHash: string | null;
  contactNumberMasked: string | null;
  gamingConnection: GamingConnection;
  walletBalanceCents: number;
  identity3D: Identity3DConfig;
  vaultPinHash: string | null;
  duressPinHash: string | null;
  duressBehavior: 'decoy_screen' | 'wipe_and_decoy';
  screenshotPrivacy: boolean;
  phishingProtection: boolean;
  nearbyDiscoveryEnabled: boolean;
  nearbyZoneLabel: string;
  featureSelection: Record<string, boolean>;
  stickerPack: Sticker3DItem[];
  passwordHash: string;
  totpEnabled: boolean;
  totpSecret: string | null;
  recoveryCodeHashes: string[];
  suspended: boolean;
  suspensionReason: string | null;
  privacySettings: PrivacySettings;
  notificationSettings: NotificationSettings;
  createdAt: number;
}

export interface DeviceRecord {
  deviceId: string;
  userId: string;
  deviceName: string;
  platform: 'Web' | 'Android' | 'iOS' | 'Windows';
  identityPubKeyJwk: JsonWebKey;
  ecdhPubKeyJwk: JsonWebKey;
  fingerprint: string;
  verifiedByUser: boolean;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  deviceId: string;
  ipMasked: string;
  userAgent: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface LoginAlert {
  id: string;
  userId: string;
  eventType:
    | 'login_success'
    | 'login_blocked_bruteforce'
    | 'device_revoked'
    | '2fa_enabled'
    | 'account_recovered'
    | 'emergency_lock'
    | 'duress_pin_triggered';
  deviceName: string;
  platform: string;
  ipMasked: string;
  timestamp: number;
  acknowledged: boolean;
}

export interface EncryptedKeyBackup {
  userId: string;
  saltB64: string;
  ivB64: string;
  wrappedVaultB64: string;
  iterations: number;
  updatedAt: number;
}

export interface VaultStorageItem {
  id: string;
  userId: string;
  kind: 'photo' | 'video' | 'file' | 'doc';
  ciphertextB64: string;
  ivB64: string;
  metaEncB64: string;
  metaIvB64: string;
  sizeBytes: number;
  createdAt: number;
}

export interface WrappedRoomKey {
  senderDeviceId: string;
  senderEcdhPubJwk: JsonWebKey;
  ivB64: string;
  wrappedKeyB64: string;
}

export interface ChatRoom {
  id: string;
  type: 'direct' | 'group';
  title: string;
  topic?: string;
  inviteOnly?: boolean;
  slowModeSeconds?: number | null;
  inVaultByUser?: Record<string, boolean>;
  memberIds: string[];
  adminIds: string[];
  disappearingTtlSeconds: number | null;
  createdAt: number;
  // Per-device wrapped AES-256-GCM room key; server cannot decrypt this
  encryptedRoomKeys: Record<string, WrappedRoomKey>;
}

export interface EncryptedMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderDeviceId: string;
  kind: 'text' | 'image' | 'video' | 'file' | 'voice' | 'payment' | 'call' | 'sticker';
  // Strictly E2EE ciphertext; server never stores plaintext
  ciphertextB64: string;
  ivB64: string;
  attachmentCiphertextB64?: string;
  attachmentIvB64?: string;
  attachmentMetaEncB64?: string;
  attachmentMetaIvB64?: string;
  replyToId?: string | null;
  editedAt?: number | null;
  deleted?: boolean;
  recalledAt?: number | null;
  reactions: Record<string, string[]>;
  deliveredTo: string[];
  readBy: string[];
  createdAt: number;
  expiresAt: number | null;
}

export interface ScheduledMessageRecord {
  id: string;
  roomId: string;
  senderId: string;
  senderDeviceId: string;
  kind: 'text' | 'sticker';
  ciphertextB64: string;
  ivB64: string;
  deliverAt: number;
  createdAt: number;
}

export interface PaymentTransfer {
  id: string;
  roomId: string;
  senderId: string;
  recipientId: string;
  amountCents: number;
  currency: 'USD';
  createdAt: number;
}

export interface CallLogEntry {
  id: string;
  roomId: string;
  participantIds: string[];
  callerId: string;
  callMode: 'audio' | 'video';
  status: 'completed' | 'missed' | 'declined' | 'canceled';
  durationSeconds: number;
  createdAt: number;
}

export interface StoryItem {
  id: string;
  userId: string;
  text: string;
  theme: 'obsidian_purple' | 'chrome_silver' | 'neon_violet';
  viewedBy: string[];
  reactions: Record<string, string[]>;
  createdAt: number;
  expiresAt: number;
}

export interface ChannelPost {
  id: string;
  authorId: string;
  text: string;
  createdAt: number;
}

export interface ChannelRecord {
  id: string;
  handle: string;
  title: string;
  description: string;
  ownerId: string;
  isPrivateCommunity: boolean;
  subscriberIds: string[];
  posts: ChannelPost[];
  createdAt: number;
}

export interface VoiceRoomParticipant {
  userId: string;
  username: string;
  displayName: string;
  muted: boolean;
  handRaised: boolean;
}

export interface VoiceRoomRecord {
  id: string;
  title: string;
  topic: string;
  hostId: string;
  isLiveStream: boolean;
  participants: VoiceRoomParticipant[];
  liveComments: Array<{ id: string; username: string; text: string; createdAt: number }>;
  createdAt: number;
}

export interface PollOption {
  id: string;
  label: string;
  voterIds: string[];
}

export interface PollRecord {
  id: string;
  question: string;
  options: PollOption[];
  creatorId: string;
  createdAt: number;
}

export interface FriendActivityItem {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  action: string;
  createdAt: number;
}

export interface UserBlock {
  blockerId: string;
  targetId: string;
  createdAt: number;
}

export interface AbuseReport {
  id: string;
  reporterId: string;
  targetId: string;
  reason: string;
  resolved?: boolean;
  resolvedAt?: number | null;
  createdAt: number;
}

export interface PersistedState {
  users: Record<string, UserAccount>;
  usernameIndex: Record<string, string>;
  oauthIndex: Record<string, string>;
  devices: Record<string, DeviceRecord>;
  sessions: Record<string, SessionRecord>;
  loginAlerts: LoginAlert[];
  keyBackups: Record<string, EncryptedKeyBackup>;
  vaultItems: VaultStorageItem[];
  rooms: Record<string, ChatRoom>;
  messages: Record<string, EncryptedMessage[]>;
  scheduledMessages: ScheduledMessageRecord[];
  stories: StoryItem[];
  channels: ChannelRecord[];
  voiceRooms: VoiceRoomRecord[];
  polls: PollRecord[];
  friendActivities: FriendActivityItem[];
  blocks: UserBlock[];
  reports: AbuseReport[];
  payments: PaymentTransfer[];
  callLogs: CallLogEntry[];
}

export class RRChatStore {
  public state: PersistedState;
  private readonly filePath: string | null;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(filePath: string | null = null) {
    this.filePath = filePath;
    this.state = this.createEmptyState();
    if (this.filePath) {
      this.loadFromDisk();
    }
  }

  private createEmptyState(): PersistedState {
    return {
      users: {},
      usernameIndex: {},
      oauthIndex: {},
      devices: {},
      sessions: {},
      loginAlerts: [],
      keyBackups: {},
      vaultItems: [],
      rooms: {},
      messages: {},
      scheduledMessages: [],
      stories: [],
      channels: [],
      voiceRooms: [],
      polls: [],
      friendActivities: [],
      blocks: [],
      reports: [],
      payments: [],
      callLogs: [],
    };
  }

  private loadFromDisk(): void {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        this.state = {
          ...this.createEmptyState(),
          ...parsed,
        };
      }
    } catch {
      this.state = this.createEmptyState();
    }
  }

  public persistNow(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  public schedulePersist(): void {
    if (!this.filePath) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 150);
  }

  public isBlocked(userA: string, userB: string): boolean {
    return this.state.blocks.some(
      (b) => (b.blockerId === userA && b.targetId === userB) || (b.blockerId === userB && b.targetId === userA)
    );
  }

  public hasBlocked(blockerId: string, targetId: string): boolean {
    return this.state.blocks.some((b) => b.blockerId === blockerId && b.targetId === targetId);
  }

  public purgeExpiredMessages(now = Date.now()): Array<{ roomId: string; messageIds: string[] }> {
    const expiredByRoom: Array<{ roomId: string; messageIds: string[] }> = [];
    for (const [roomId, msgs] of Object.entries(this.state.messages)) {
      const removed: string[] = [];
      const kept = msgs.filter((m) => {
        if (m.expiresAt !== null && m.expiresAt <= now) {
          removed.push(m.id);
          return false;
        }
        return true;
      });
      if (removed.length > 0) {
        this.state.messages[roomId] = kept;
        expiredByRoom.push({ roomId, messageIds: removed });
      }
    }
    // Also clean expired 24-hour stories
    if (this.state.stories.length > 0) {
      const before = this.state.stories.length;
      this.state.stories = this.state.stories.filter((s) => s.expiresAt > now);
      if (this.state.stories.length !== before) {
        this.schedulePersist();
      }
    }
    if (expiredByRoom.length > 0) {
      this.schedulePersist();
    }
    return expiredByRoom;
  }
}
