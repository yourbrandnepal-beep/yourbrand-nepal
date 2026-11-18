import type {
  AdminOverviewData,
  AIAssistMode,
  AIAssistResponse,
  CallLogItem,
  ChannelRecord,
  ChatRoomRecord,
  DevicePublicInfo,
  DirectoryUser,
  EncryptedMessageRecord,
  GamingConnection,
  Identity3DConfig,
  LoginAlertRecord,
  NotificationSettings,
  OAuthProviderId,
  PaymentHistoryItem,
  PollRecord,
  PrivacySettings,
  ScheduledMessageItem,
  ShieldScoreData,
  SocialFeedData,
  Sticker3DItem,
  StoryItem,
  UserProfile,
  VaultStorageItem,
  VoiceRoomRecord,
} from './types';

export class ApiError extends Error {
  status: number;
  isNetworkError: boolean;

  constructor(message: string, status: number, isNetworkError = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.isNetworkError = isNetworkError;
  }
}

export async function apiFetch<T>(
  path: string,
  opts: RequestInit = {},
  token?: string | null
): Promise<T> {
  const headers: Record<string, string> = {
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network unavailable';
    throw new ApiError(msg, 0, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status, false);
  }
  return data as T;
}

export const rrApi = {
  register: (payload: {
    username: string;
    password: string;
    displayName?: string;
    contactNumber?: string;
    deviceName?: string;
    platform?: string;
    identityPubKeyJwk: JsonWebKey;
    ecdhPubKeyJwk: JsonWebKey;
    fingerprint: string;
  }) =>
    apiFetch<{
      token: string;
      deviceId: string;
      recoveryCodes: string[];
      user: UserProfile;
    }>('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }),

  login: (payload: {
    username: string;
    password: string;
    totpCode?: string;
    deviceName?: string;
    platform?: string;
    identityPubKeyJwk?: JsonWebKey;
    ecdhPubKeyJwk?: JsonWebKey;
    fingerprint?: string;
    existingDeviceId?: string;
  }) =>
    apiFetch<{
      requires2FA?: boolean;
      token?: string;
      deviceId?: string;
      verifiedByUser?: boolean;
      user?: UserProfile;
    }>('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),

  getOAuthProviders: () =>
    apiFetch<{
      providers: Array<{
        provider: OAuthProviderId;
        label: string;
        configured: boolean;
        mode: 'firebase_popup' | 'oauth_popup';
        redirectUri?: string;
        requiredEnv?: [string, string];
        dashboardUrl?: string;
      }>;
    }>('/api/auth/oauth/providers'),

  oauthGoogleLogin: (payload: {
    idToken: string;
    deviceName?: string;
    platform?: string;
    identityPubKeyJwk: JsonWebKey;
    ecdhPubKeyJwk: JsonWebKey;
    fingerprint: string;
  }) =>
    apiFetch<{
      token: string;
      deviceId: string;
      user: UserProfile;
      isNewAccount: boolean;
      recoveryCodes?: string[];
    }>('/api/auth/oauth/google', { method: 'POST', body: JSON.stringify(payload) }),

  getOAuthLoginUrl: (provider: Exclude<OAuthProviderId, 'google'>) =>
    apiFetch<{
      configured: boolean;
      provider: Exclude<OAuthProviderId, 'google'>;
      label: string;
      url?: string;
      redirectUri: string;
      requiredEnv?: [string, string];
      dashboardUrl?: string;
    }>(`/api/auth/oauth/${provider}/url`),

  exchangeOAuthLogin: (payload: {
    provider: Exclude<OAuthProviderId, 'google'>;
    exchangeCode: string;
    deviceName?: string;
    platform?: string;
    identityPubKeyJwk: JsonWebKey;
    ecdhPubKeyJwk: JsonWebKey;
    fingerprint: string;
  }) =>
    apiFetch<{
      token: string;
      deviceId: string;
      user: UserProfile;
      isNewAccount: boolean;
      recoveryCodes?: string[];
    }>('/api/auth/oauth/exchange', { method: 'POST', body: JSON.stringify(payload) }),

  recoverAccount: (payload: { username: string; recoveryCode: string; newPassword: string }) =>
    apiFetch<{ recovered: boolean; remainingRecoveryCodes: number }>('/api/auth/recover', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  logout: (token: string) => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }, token),

  getMe: (token: string) =>
    apiFetch<{ user: UserProfile; currentDevice: DevicePublicInfo }>('/api/auth/me', {}, token),

  updateProfile: (token: string, displayName: string, bio: string) =>
    apiFetch<{ displayName: string; bio: string }>(
      '/api/auth/profile',
      { method: 'PATCH', body: JSON.stringify({ displayName, bio }) },
      token
    ),

  updateIdentity3D: (token: string, identity3D: Identity3DConfig) =>
    apiFetch<{ identity3D: Identity3DConfig }>(
      '/api/profile/identity3d',
      { method: 'PUT', body: JSON.stringify(identity3D) },
      token
    ),

  saveStickers: (token: string, stickerPack: Sticker3DItem[]) =>
    apiFetch<{ stickerPack: Sticker3DItem[] }>(
      '/api/profile/stickers',
      { method: 'PUT', body: JSON.stringify({ stickerPack }) },
      token
    ),

  saveFeatures: (
    token: string,
    payload: {
      featureSelection?: Record<string, boolean>;
      screenshotPrivacy?: boolean;
      phishingProtection?: boolean;
      nearbyDiscoveryEnabled?: boolean;
      nearbyZoneLabel?: string;
      customSound?: 'crystal' | 'pulse' | 'chime' | 'silent';
    }
  ) =>
    apiFetch<{ user: UserProfile }>(
      '/api/features',
      { method: 'PUT', body: JSON.stringify(payload) },
      token
    ),

  getShieldScore: (token: string) => apiFetch<ShieldScoreData>('/api/shield/score', {}, token),

  setVaultPin: (token: string, pin: string) =>
    apiFetch<{ hasVaultPin: boolean }>('/api/vault/pin', { method: 'PUT', body: JSON.stringify({ pin }) }, token),

  setDuressPin: (token: string, pin: string, behavior: 'decoy_screen' | 'wipe_and_decoy') =>
    apiFetch<{ hasDuressPin: boolean; duressBehavior: 'decoy_screen' | 'wipe_and_decoy' }>(
      '/api/vault/duress-pin',
      { method: 'PUT', body: JSON.stringify({ pin, behavior }) },
      token
    ),

  verifyVaultPin: (token: string, pin: string) =>
    apiFetch<{
      unlocked: boolean;
      configured: boolean;
      duressTriggered?: boolean;
      duressBehavior?: 'decoy_screen' | 'wipe_and_decoy';
    }>('/api/vault/verify', { method: 'POST', body: JSON.stringify({ pin }) }, token),

  getVaultItems: (token: string) => apiFetch<{ items: VaultStorageItem[] }>('/api/vault/items', {}, token),

  uploadVaultItem: (
    token: string,
    payload: {
      kind: 'photo' | 'video' | 'file' | 'doc';
      ciphertextB64: string;
      ivB64: string;
      metaEncB64: string;
      metaIvB64: string;
      sizeBytes: number;
    }
  ) =>
    apiFetch<{ item: VaultStorageItem }>('/api/vault/items', { method: 'POST', body: JSON.stringify(payload) }, token),

  deleteVaultItem: (token: string, itemId: string) =>
    apiFetch<{ deleted: boolean }>(`/api/vault/items/${itemId}`, { method: 'DELETE' }, token),

  setup2FA: (token: string) =>
    apiFetch<{ secret: string; otpauthUri: string }>('/api/auth/2fa/setup', { method: 'POST' }, token),

  verify2FA: (token: string, code: string) =>
    apiFetch<{ totpEnabled: boolean }>(
      '/api/auth/2fa/verify',
      { method: 'POST', body: JSON.stringify({ code }) },
      token
    ),

  disable2FA: (token: string, password: string) =>
    apiFetch<{ totpEnabled: boolean }>(
      '/api/auth/2fa/disable',
      { method: 'POST', body: JSON.stringify({ password }) },
      token
    ),

  suspendAccount: (token: string, reason: string) =>
    apiFetch<{ suspended: boolean }>(
      '/api/auth/suspend',
      { method: 'POST', body: JSON.stringify({ reason }) },
      token
    ),

  deleteAccount: (token: string, password: string) =>
    apiFetch<{ deleted: boolean }>(
      '/api/auth/account',
      { method: 'DELETE', body: JSON.stringify({ password }) },
      token
    ),

  getDevices: (token: string) =>
    apiFetch<{
      devices: DevicePublicInfo[];
      sessions: Array<{ deviceId: string; ipMasked: string; userAgent: string; createdAt: number; expiresAt: number }>;
    }>('/api/devices', {}, token),

  verifyDevice: (token: string, targetDeviceId: string) =>
    apiFetch<{ verified: boolean }>(
      '/api/devices/verify',
      { method: 'POST', body: JSON.stringify({ targetDeviceId }) },
      token
    ),

  revokeDevice: (token: string, deviceId: string) =>
    apiFetch<{ revoked: boolean }>(`/api/devices/${deviceId}/revoke`, { method: 'POST' }, token),

  emergencyLock: (token: string) =>
    apiFetch<{
      locked: boolean;
      revokedSessions: number;
      privacySettings: PrivacySettings;
      notificationSettings: NotificationSettings;
    }>('/api/security/emergency-lock', { method: 'POST' }, token),

  unlockSession: (token: string, secret: string) =>
    apiFetch<{
      unlocked: boolean;
      duressTriggered?: boolean;
      duressBehavior?: 'decoy_screen' | 'wipe_and_decoy';
    }>('/api/security/unlock', { method: 'POST', body: JSON.stringify({ secret }) }, token),

  getAlerts: (token: string) => apiFetch<{ alerts: LoginAlertRecord[] }>('/api/security/alerts', {}, token),

  ackAlerts: (token: string) => apiFetch<{ ok: boolean }>('/api/security/alerts/ack', { method: 'POST' }, token),

  updatePrivacy: (token: string, settings: Partial<PrivacySettings> & { contactNumber?: string }) =>
    apiFetch<{ privacySettings: PrivacySettings; contactNumberMasked?: string | null }>(
      '/api/privacy',
      { method: 'PUT', body: JSON.stringify(settings) },
      token
    ),

  updateGamingPrivacy: (
    token: string,
    payload: {
      platform: string;
      gamertag: string;
      discordUsername: string;
      discordInviteCode: string;
    }
  ) =>
    apiFetch<{ gamingConnection: GamingConnection }>(
      '/api/privacy/gaming',
      { method: 'PUT', body: JSON.stringify(payload) },
      token
    ),

  getDiscordAuthUrl: (token: string) =>
    apiFetch<{ configured: boolean; url?: string; redirectUri: string }>('/api/discord/auth-url', {}, token),

  getWallet: (token: string) =>
    apiFetch<{ balanceCents: number; history: PaymentHistoryItem[] }>('/api/wallet', {}, token),

  depositWallet: (token: string, amountCents: number) =>
    apiFetch<{ balanceCents: number }>(
      '/api/wallet/deposit',
      { method: 'POST', body: JSON.stringify({ amountCents }) },
      token
    ),

  transferPayment: (
    token: string,
    payload: { roomId: string; recipientId: string; amountCents: number }
  ) =>
    apiFetch<{
      transfer: { id: string; roomId: string; senderId: string; recipientId: string; amountCents: number; currency: 'USD'; createdAt: number };
      balanceCents: number;
    }>('/api/payments/transfer', { method: 'POST', body: JSON.stringify(payload) }, token),

  updateNotifications: (token: string, settings: NotificationSettings) =>
    apiFetch<{ notificationSettings: NotificationSettings }>(
      '/api/notifications',
      { method: 'PUT', body: JSON.stringify(settings) },
      token
    ),

  uploadKeyBackup: (
    token: string,
    backup: { saltB64: string; ivB64: string; wrappedVaultB64: string; iterations: number }
  ) => apiFetch<{ backedUp: boolean; updatedAt: number }>('/api/keys/backup', { method: 'PUT', body: JSON.stringify(backup) }, token),

  fetchKeyBackup: (token: string) =>
    apiFetch<{
      backup: { saltB64: string; ivB64: string; wrappedVaultB64: string; iterations: number; updatedAt: number };
    }>('/api/keys/backup', {}, token),

  searchUsers: (token: string, query: string, userId?: string) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (userId) params.set('userId', userId);
    return apiFetch<{
      users: DirectoryUser[];
      blockedUsers: Array<{ id: string; username: string; displayName: string }>;
    }>(`/api/users/search?${params.toString()}`, {}, token);
  },

  blockUser: (token: string, targetUserId: string) =>
    apiFetch<{ blocked: boolean }>('/api/users/block', { method: 'POST', body: JSON.stringify({ targetUserId }) }, token),

  unblockUser: (token: string, targetUserId: string) =>
    apiFetch<{ unblocked: boolean }>(`/api/users/block/${targetUserId}`, { method: 'DELETE' }, token),

  reportUser: (token: string, targetUserId: string, reason: string) =>
    apiFetch<{ reported: boolean }>(
      '/api/users/report',
      { method: 'POST', body: JSON.stringify({ targetUserId, reason }) },
      token
    ),

  getRooms: (token: string) => apiFetch<{ rooms: ChatRoomRecord[] }>('/api/rooms', {}, token),

  createRoom: (
    token: string,
    payload: {
      type: 'direct' | 'group';
      title?: string;
      topic?: string;
      inviteOnly?: boolean;
      slowModeSeconds?: number | null;
      memberIds: string[];
      encryptedRoomKeys: Record<string, unknown>;
      disappearingTtlSeconds?: number | null;
    }
  ) =>
    apiFetch<{ room: ChatRoomRecord; existing?: boolean }>(
      '/api/rooms',
      { method: 'POST', body: JSON.stringify(payload) },
      token
    ),

  updateDisappearingTtl: (token: string, roomId: string, disappearingTtlSeconds: number | null) =>
    apiFetch<{ disappearingTtlSeconds: number | null }>(
      `/api/rooms/${roomId}/disappearing`,
      { method: 'PATCH', body: JSON.stringify({ disappearingTtlSeconds }) },
      token
    ),

  toggleRoomVault: (token: string, roomId: string, inVault: boolean) =>
    apiFetch<{ inVault: boolean }>(
      `/api/rooms/${roomId}/vault`,
      { method: 'PATCH', body: JSON.stringify({ inVault }) },
      token
    ),

  updateRoomSettings: (
    token: string,
    roomId: string,
    payload: { topic?: string; inviteOnly?: boolean; slowModeSeconds?: number | null }
  ) =>
    apiFetch<{ room: ChatRoomRecord }>(
      `/api/rooms/${roomId}/settings`,
      { method: 'PATCH', body: JSON.stringify(payload) },
      token
    ),

  kickRoomMember: (token: string, roomId: string, targetUserId: string) =>
    apiFetch<{ removed: boolean }>(
      `/api/rooms/${roomId}/kick`,
      { method: 'POST', body: JSON.stringify({ targetUserId }) },
      token
    ),

  getMessages: (token: string, roomId: string) =>
    apiFetch<{ messages: EncryptedMessageRecord[] }>(`/api/rooms/${roomId}/messages`, {}, token),

  sendEncryptedMessage: (
    token: string,
    roomId: string,
    payload: {
      kind: 'text' | 'image' | 'video' | 'file' | 'voice' | 'payment' | 'call' | 'sticker';
      ciphertextB64: string;
      ivB64: string;
      attachmentCiphertextB64?: string;
      attachmentIvB64?: string;
      attachmentMetaEncB64?: string;
      attachmentMetaIvB64?: string;
      attachmentMime?: string;
      attachmentBytes?: number;
      replyToId?: string | null;
    }
  ) =>
    apiFetch<{ message: EncryptedMessageRecord }>(
      `/api/rooms/${roomId}/messages`,
      { method: 'POST', body: JSON.stringify(payload) },
      token
    ),

  getScheduledMessages: (token: string, roomId: string) =>
    apiFetch<{ scheduled: ScheduledMessageItem[] }>(`/api/rooms/${roomId}/scheduled`, {}, token),

  scheduleMessage: (
    token: string,
    roomId: string,
    payload: { ciphertextB64: string; ivB64: string; deliverAt: number; kind?: 'text' | 'sticker' }
  ) =>
    apiFetch<{ scheduled: ScheduledMessageItem }>(
      `/api/rooms/${roomId}/scheduled`,
      { method: 'POST', body: JSON.stringify(payload) },
      token
    ),

  cancelScheduledMessage: (token: string, roomId: string, scheduleId: string) =>
    apiFetch<{ canceled: boolean }>(`/api/rooms/${roomId}/scheduled/${scheduleId}`, { method: 'DELETE' }, token),

  recallMessage: (token: string, roomId: string, messageId: string) =>
    apiFetch<{ recalled: boolean; messageId: string; recalledAt: number }>(
      `/api/rooms/${roomId}/messages/${messageId}/recall`,
      { method: 'POST' },
      token
    ),

  editMessage: (
    token: string,
    roomId: string,
    messageId: string,
    payload: { ciphertextB64: string; ivB64: string }
  ) =>
    apiFetch<{ message: EncryptedMessageRecord }>(
      `/api/rooms/${roomId}/messages/${messageId}`,
      { method: 'PATCH', body: JSON.stringify(payload) },
      token
    ),

  deleteMessage: (token: string, roomId: string, messageId: string) =>
    apiFetch<{ deleted: boolean; messageId: string }>(
      `/api/rooms/${roomId}/messages/${messageId}`,
      { method: 'DELETE' },
      token
    ),

  reactMessage: (token: string, messageId: string, roomId: string, emoji: string) =>
    apiFetch<{ reactions: Record<string, string[]> }>(
      `/api/messages/${messageId}/react`,
      { method: 'POST', body: JSON.stringify({ roomId, emoji }) },
      token
    ),

  markRoomRead: (token: string, roomId: string) =>
    apiFetch<{ readCount: number }>(`/api/rooms/${roomId}/read`, { method: 'POST' }, token),

  getCallHistory: (token: string) => apiFetch<{ calls: CallLogItem[] }>('/api/calls/history', {}, token),

  logCall: (
    token: string,
    payload: {
      roomId: string;
      callMode: 'audio' | 'video';
      status: 'completed' | 'missed' | 'declined' | 'canceled';
      durationSeconds: number;
    }
  ) => apiFetch<{ entry: CallLogItem }>('/api/calls/log', { method: 'POST', body: JSON.stringify(payload) }, token),

  aiAssist: (
    token: string,
    payload: {
      consentGranted: boolean;
      mode: AIAssistMode;
      text?: string;
      messages?: string[];
      targetLang?: string;
      tone?: string;
      voiceName?: string;
    }
  ) =>
    apiFetch<AIAssistResponse>(
      '/api/ai/assist',
      { method: 'POST', body: JSON.stringify(payload) },
      token
    ),

  aiTranscribe: (
    token: string,
    payload: { consentGranted: boolean; audioBase64: string; mimeType: string }
  ) =>
    apiFetch<{ transcript: string; model: string }>(
      '/api/ai/transcribe',
      { method: 'POST', body: JSON.stringify(payload) },
      token
    ),

  // Social Hub
  getSocialFeed: (token: string) => apiFetch<SocialFeedData>('/api/social/feed', {}, token),

  createStory: (token: string, text: string, theme: StoryItem['theme']) =>
    apiFetch<{ story: StoryItem }>('/api/social/stories', { method: 'POST', body: JSON.stringify({ text, theme }) }, token),

  reactStory: (token: string, storyId: string, emoji: string) =>
    apiFetch<{ story: StoryItem }>(`/api/social/stories/${storyId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) }, token),

  createChannel: (token: string, payload: { handle: string; title: string; description: string; isPrivateCommunity: boolean }) =>
    apiFetch<{ channel: ChannelRecord }>('/api/social/channels', { method: 'POST', body: JSON.stringify(payload) }, token),

  toggleSubscribeChannel: (token: string, channelId: string) =>
    apiFetch<{ isSubscribed: boolean; subscriberCount: number }>(
      `/api/social/channels/${channelId}/subscribe`,
      { method: 'POST' },
      token
    ),

  postChannelUpdate: (token: string, channelId: string, text: string) =>
    apiFetch<{ post: { id: string; authorId: string; text: string; createdAt: number } }>(
      `/api/social/channels/${channelId}/posts`,
      { method: 'POST', body: JSON.stringify({ text }) },
      token
    ),

  createVoiceRoom: (token: string, payload: { title: string; topic: string; isLiveStream: boolean }) =>
    apiFetch<{ voiceRoom: VoiceRoomRecord }>('/api/social/voice-rooms', { method: 'POST', body: JSON.stringify(payload) }, token),

  joinVoiceRoom: (token: string, roomId: string) =>
    apiFetch<{ voiceRoom: VoiceRoomRecord }>(`/api/social/voice-rooms/${roomId}/join`, { method: 'POST' }, token),

  leaveVoiceRoom: (token: string, roomId: string) =>
    apiFetch<{ left: boolean }>(`/api/social/voice-rooms/${roomId}/leave`, { method: 'POST' }, token),

  toggleVoiceRoomMute: (token: string, roomId: string) =>
    apiFetch<{ voiceRoom: VoiceRoomRecord }>(`/api/social/voice-rooms/${roomId}/toggle-mute`, { method: 'POST' }, token),

  commentVoiceRoom: (token: string, roomId: string, text: string) =>
    apiFetch<{ voiceRoom: VoiceRoomRecord }>(
      `/api/social/voice-rooms/${roomId}/comment`,
      { method: 'POST', body: JSON.stringify({ text }) },
      token
    ),

  createPoll: (token: string, question: string, options: string[]) =>
    apiFetch<{ poll: PollRecord }>('/api/social/polls', { method: 'POST', body: JSON.stringify({ question, options }) }, token),

  votePoll: (token: string, pollId: string, optionId: string) =>
    apiFetch<{ poll: PollRecord }>(`/api/social/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ optionId }) }, token),

  getAdminOverview: (token: string) => apiFetch<AdminOverviewData>('/api/admin/overview', {}, token),

  resolveReport: (token: string, reportId: string) =>
    apiFetch<{ resolved: boolean }>(`/api/admin/reports/${reportId}/resolve`, { method: 'POST' }, token),

  moderateUser: (token: string, targetUserId: string, suspend: boolean, reason?: string) =>
    apiFetch<{ userId: string; suspended: boolean }>(
      `/api/admin/users/${targetUserId}/moderate`,
      { method: 'POST', body: JSON.stringify({ suspend, reason }) },
      token
    ),

  getRepoTree: () =>
    apiFetch<{ files: Array<{ path: string; size: number; group: string }> }>('/api/repo/tree'),

  getRepoFile: (filePath: string) =>
    apiFetch<{ path: string; content: string }>(`/api/repo/file?path=${encodeURIComponent(filePath)}`),
};
