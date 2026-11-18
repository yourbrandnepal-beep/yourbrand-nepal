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

export const ALL_26_FEATURES = [
  { id: 'private_username_chat', label: 'Private Username Chat', group: 'Core & Identity', description: 'Phone-less unique @username messaging' },
  { id: 'end_to_end_encryption', label: 'End-to-End Encryption', group: 'Core & Identity', description: 'Client-side ECDH + HKDF + AES-256-GCM' },
  { id: 'voice_video_call', label: 'Voice & Video Call', group: 'Communication', description: 'WebRTC peer-to-peer encrypted calls' },
  { id: '3d_animated_profile', label: '3D Animated Profile', group: 'Core & Identity', description: 'Three.js interactive 3D avatar & badge' },
  { id: 'ghost_message', label: 'Ghost Message', group: 'Communication', description: 'Self-destruct countdown timers' },
  { id: 'private_vault', label: 'Private Vault', group: 'Security & Vault', description: 'PIN-locked rooms & encrypted file locker' },
  { id: 'panic_lock', label: 'Panic Lock', group: 'Security & Vault', description: 'Instant lock + revoke other sessions' },
  { id: 'duress_pin', label: 'Duress PIN', group: 'Security & Vault', description: 'Secondary PIN opening Decoy / wipe flow' },
  { id: 'ai_assistant', label: 'AI Assistant', group: 'RR AI Brain', description: 'Opt-in Gemini assistant, writer & grammar' },
  { id: 'ai_image_sticker_gen', label: 'AI Image & Sticker Generator', group: 'RR AI Brain', description: 'Vector art & custom 3D sticker creator' },
  { id: 'live_translation', label: 'Live Translation', group: 'RR AI Brain', description: 'Nepali (नेपाली), English & global chat translation' },
  { id: 'stories_status', label: 'Stories & Status', group: 'Social', description: '24-hour disappearing friend stories' },
  { id: 'private_communities', label: 'Private Communities', group: 'Social', description: 'Invite-only rooms & public @channels' },
  { id: 'live_streaming', label: 'Live Streaming', group: 'Social', description: 'Group voice rooms & live broadcasts' },
  { id: 'screen_sharing', label: 'Screen Sharing', group: 'Communication', description: 'Share window or screen in video calls' },
  { id: '3d_chat_themes', label: '3D Chat Themes', group: 'Communication', description: 'Animated 3D depth bubbles & themes' },
  { id: 'qr_friend_connect', label: 'QR Friend Connect', group: 'Core & Identity', description: 'Scan & verify identity fingerprint QR' },
  { id: 'encrypted_cloud_backup', label: 'Encrypted Cloud Backup', group: 'Security & Vault', description: 'PBKDF2 310k + AES-GCM wrapped backup' },
  { id: 'multi_device_sync', label: 'Multi-device Sync', group: 'Core & Identity', description: 'Device approval & wrapped room keys' },
  { id: 'security_radar', label: 'Security Radar', group: 'Security & Vault', description: 'RR Shield score & login threat alerts' },
  { id: 'offline_message_queue', label: 'Offline Message Queue', group: 'Power Tools', description: 'Local encrypted queue auto-flushed online' },
  { id: 'custom_notification_sound', label: 'Custom Notification Sound', group: 'Power Tools', description: 'Synthesized crystal, pulse & chime alerts' },
  { id: 'scheduled_messages', label: 'Scheduled Messages', group: 'Power Tools', description: 'Timed client-encrypted future delivery' },
  { id: 'message_recall', label: 'Message Recall', group: 'Power Tools', description: 'Recall sent message across connected peers' },
  { id: 'spam_scam_detection', label: 'Spam & Scam Detection', group: 'Security & Vault', description: 'Phishing link scanner & AI scam check' },
  { id: 'desktop_multi_window', label: 'Desktop Multi-window Chat', group: 'Power Tools', description: 'Split dual-room pane & multi-window sync' },
] as const;

export function createDefaultFeatureSelection(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const f of ALL_26_FEATURES) map[f.id] = true;
  return map;
}

export interface PaymentHistoryItem {
  id: string;
  direction: 'sent' | 'received';
  peerUsername: string;
  amountCents: number;
  currency: 'USD';
  createdAt: number;
}

export interface CallLogItem {
  id: string;
  roomId: string;
  participantIds: string[];
  callerId: string;
  callMode: 'audio' | 'video';
  status: 'completed' | 'missed' | 'declined' | 'canceled';
  durationSeconds: number;
  createdAt: number;
  direction: 'outgoing' | 'incoming';
  peerDisplayName: string;
  peerUsername: string;
}

export interface CallSignalPayload {
  type: 'call:offer' | 'call:answer' | 'call:ice' | 'call:end' | 'call:reject';
  roomId: string;
  fromUserId: string;
  fromDisplayName: string;
  fromUsername: string;
  callMode: 'audio' | 'video';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  reason?: string;
}

export type OAuthProviderId = 'google' | 'facebook' | 'github' | 'discord';

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  authProvider?: 'local' | OAuthProviderId;
  linkedProviders?: OAuthProviderId[];
  contactNumberMasked?: string | null;
  gamingConnection?: GamingConnection;
  walletBalanceCents?: number;
  identity3D: Identity3DConfig;
  hasVaultPin?: boolean;
  hasDuressPin?: boolean;
  duressBehavior?: 'decoy_screen' | 'wipe_and_decoy';
  screenshotPrivacy?: boolean;
  phishingProtection?: boolean;
  nearbyDiscoveryEnabled?: boolean;
  nearbyZoneLabel?: string;
  featureSelection?: Record<string, boolean>;
  stickerPack?: Sticker3DItem[];
  totpEnabled: boolean;
  suspended?: boolean;
  remainingRecoveryCodes?: number;
  privacySettings: PrivacySettings;
  notificationSettings: NotificationSettings;
  createdAt?: number;
}

export interface DevicePublicInfo {
  deviceId: string;
  deviceName: string;
  platform: 'Web' | 'Android' | 'iOS' | 'Windows';
  identityPubKeyJwk: JsonWebKey;
  ecdhPubKeyJwk: JsonWebKey;
  fingerprint: string;
  verifiedByUser: boolean;
  createdAt?: number;
  lastSeenAt?: number;
  revokedAt?: number | null;
  isCurrent?: boolean;
}

export interface DirectoryUser {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  identity3D?: Identity3DConfig;
  devices: DevicePublicInfo[];
}

export interface WrappedRoomKey {
  senderDeviceId: string;
  senderEcdhPubJwk: JsonWebKey;
  ivB64: string;
  wrappedKeyB64: string;
}

export interface EncryptedMessageRecord {
  id: string;
  roomId: string;
  senderId: string;
  senderDeviceId: string;
  kind: 'text' | 'image' | 'video' | 'file' | 'voice' | 'payment' | 'call' | 'sticker';
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

export interface ScheduledMessageItem {
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

export interface ChatRoomRecord {
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
  encryptedRoomKeys: Record<string, WrappedRoomKey>;
  members: DirectoryUser[];
  lastMessage: EncryptedMessageRecord | null;
  messageCount: number;
}

export interface LoginAlertRecord {
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

export interface StoredAccountSession {
  token: string;
  deviceId: string;
  username: string;
}

export type AIAssistMode =
  | 'personal_assistant'
  | 'voice_assistant'
  | 'smart_replies'
  | 'translate'
  | 'summary'
  | 'rewrite'
  | 'grammar'
  | 'spam_check'
  | 'image_spec'
  | 'sticker_spec';

export interface AIAssistResponse {
  resultText?: string;
  text?: string;
  suggestions?: string[];
  audioDataUrl?: string;
  grammar?: { correctedText: string; issues: string[] };
  spamReport?: { riskLevel: 'safe' | 'suspicious' | 'phishing'; score: number; reasons: string[]; advice: string };
  generatedArt?: {
    title: string;
    svgMarkup: string;
    shape?: 'cube' | 'torus' | 'prism' | 'star';
    color?: string;
    glowColor?: string;
    label?: string;
  };
  model: string;
}

export interface ShieldScoreData {
  score: number;
  maxScore: number;
  checks: Array<{ id: string; label: string; passed: boolean; weight: number }>;
}

export interface StoryItem {
  id: string;
  userId: string;
  authorUsername: string;
  authorDisplayName: string;
  text: string;
  theme: 'obsidian_purple' | 'chrome_silver' | 'neon_violet';
  viewedBy: string[];
  reactions: Record<string, string[]>;
  createdAt: number;
  expiresAt: number;
}

export interface ChannelRecord {
  id: string;
  handle: string;
  title: string;
  description: string;
  ownerId: string;
  ownerUsername: string;
  isPrivateCommunity: boolean;
  subscriberIds: string[];
  subscriberCount: number;
  isSubscribed: boolean;
  posts: Array<{ id: string; authorId: string; text: string; createdAt: number }>;
  createdAt: number;
}

export interface VoiceRoomRecord {
  id: string;
  title: string;
  topic: string;
  hostId: string;
  isLiveStream: boolean;
  participants: Array<{
    userId: string;
    username: string;
    displayName: string;
    muted: boolean;
    handRaised: boolean;
  }>;
  liveComments: Array<{ id: string; username: string; text: string; createdAt: number }>;
  createdAt: number;
}

export interface PollRecord {
  id: string;
  question: string;
  options: Array<{ id: string; label: string; voterIds: string[] }>;
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

export interface NearbyUserSummary {
  id: string;
  username: string;
  displayName: string;
  zoneLabel: string;
  badge: string;
}

export interface SocialFeedData {
  stories: StoryItem[];
  channels: ChannelRecord[];
  voiceRooms: VoiceRoomRecord[];
  polls: PollRecord[];
  activities: FriendActivityItem[];
  nearbyUsers: NearbyUserSummary[];
}

export interface AdminOverviewData {
  health: {
    status: string;
    uptimeSeconds: number;
    totalUsers: number;
    suspendedUsers: number;
    activeWebSockets: number;
    encryptedRooms: number;
    opaqueCiphertextBlobs: number;
    openReports: number;
  };
  reports: Array<{
    id: string;
    reporterUsername: string;
    targetId: string;
    targetUsername: string;
    targetSuspended: boolean;
    reason: string;
    resolved: boolean;
    createdAt: number;
  }>;
  recentSecurityEvents: Array<{
    id: string;
    username: string;
    eventType: string;
    platform: string;
    ipMasked: string;
    timestamp: number;
  }>;
  usersDirectory: Array<{
    id: string;
    username: string;
    displayName: string;
    suspended: boolean;
    totpEnabled: boolean;
    createdAt: number;
    deviceCount: number;
  }>;
  cryptographicBoundary: string;
}
