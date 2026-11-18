import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Cloud,
  Compass,
  FolderGit2,
  Home,
  Lock,
  LogOut,
  Moon,
  Phone,
  Radar,
  ShieldAlert,
  Sliders,
  SlidersHorizontal,
  Sparkles,
  Sun,
  User,
  Users,
  Vault,
} from 'lucide-react';
import { AdminView } from './components/AdminView';
import { AIAssistantView } from './components/AIAssistantView';
import { ArchitectureView } from './components/ArchitectureView';
import { AuthView } from './components/AuthView';
import { Avatar3DCanvas, Avatar3DStudio, BADGE_LABELS } from './components/Avatar3DStudio';
import { CallsView } from './components/CallsView';
import { ChatWorkspace, type WorkspaceNavTarget } from './components/ChatWorkspace';
import { ContactsView } from './components/ContactsView';
import { DecoyAppScreen } from './components/DecoyAppScreen';
import { FeatureSelectorView } from './components/FeatureSelectorView';
import { FirebaseRealtimeSyncView } from './components/FirebaseRealtimeSync';
import { Logo3D } from './components/Logo3D';
import { PrivacyView } from './components/PrivacyView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { SecurityView } from './components/SecurityView';
import { SocialView } from './components/SocialView';
import { ApiError, rrApi } from './lib/api';
import {
  DeviceKeyVault,
  generateRoomKeyBytes,
  loadVaultFromLocal,
  removeVaultFromLocal,
  wrapRoomKeyForDevice,
} from './lib/crypto';
import { playNotificationChime } from './lib/mediaUtils';
import {
  clearOfflineCacheForUser,
  loadAllCachedMessagesForUser,
  loadCachedRooms,
  loadSessionSnapshot,
  saveCachedRoomMessages,
  saveCachedRooms,
  saveSessionSnapshot,
} from './lib/offlineStore';
import { useOnlineStatus, useServiceWorker } from './lib/usePWA';
import {
  DEFAULT_IDENTITY_3D,
  type CallSignalPayload,
  type ChatRoomRecord,
  type DirectoryUser,
  type EncryptedMessageRecord,
  type StoredAccountSession,
  type UserProfile,
} from './lib/types';

type AppTab = WorkspaceNavTarget | 'profile';

const SESSIONS_STORAGE_KEY = 'rrchat1_sessions_v1';
const ACTIVE_SESSION_KEY = 'rrchat1_active_session_v1';
const THEME_STORAGE_KEY = 'rrchat1_theme_v1';

function readSavedSessions(): StoredAccountSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredAccountSession[]) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      return saved === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', themeMode === 'dark');
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // ignore
    }
  }, [themeMode]);

  const [savedSessions, setSavedSessions] = useState<StoredAccountSession[]>(() => readSavedSessions());
  const [token, setToken] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
      return raw ? (JSON.parse(raw) as StoredAccountSession).token : null;
    } catch {
      return null;
    }
  });
  const [deviceId, setDeviceId] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
      return raw ? (JSON.parse(raw) as StoredAccountSession).deviceId : null;
    } catch {
      return null;
    }
  });
  const [sessionUsername, setSessionUsername] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
      return raw ? (JSON.parse(raw) as StoredAccountSession).username : null;
    } catch {
      return null;
    }
  });

  const [user, setUser] = useState<UserProfile | null>(null);
  const [vault, setVault] = useState<DeviceKeyVault | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('chats');
  const [vaultMode, setVaultMode] = useState(false);
  const [chatBoxOnly, setChatBoxOnly] = useState(false);
  const [rooms, setRooms] = useState<ChatRoomRecord[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, EncryptedMessageRecord[]>>({});
  const [bootstrapping, setBootstrapping] = useState<boolean>(Boolean(token));
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [bannerAlert, setBannerAlert] = useState<string | null>(null);

  useServiceWorker();
  const isOnline = useOnlineStatus();

  // Opt-In AI Assistant state
  const [aiConsentGranted, setAiConsentGranted] = useState(false);
  const [activeRoomSnippets, setActiveRoomSnippets] = useState<{ title: string; snippets: string[] }>({
    title: '',
    snippets: [],
  });
  const [pendingAiDraft, setPendingAiDraft] = useState<string | null>(null);
  const [externalCallRequest, setExternalCallRequest] = useState<{ roomId: string; mode: 'audio' | 'video' } | null>(
    null
  );
  const [focusSearchTrigger, setFocusSearchTrigger] = useState(0);

  // Emergency Privacy Lock & App Decoy / Duress PIN state
  const [emergencyLocked, setEmergencyLocked] = useState(false);
  const [decoyMode, setDecoyMode] = useState(false);
  const [duressTriggered, setDuressTriggered] = useState(false);
  const [socialRevision, setSocialRevision] = useState(0);
  const [splitRoomId, setSplitRoomId] = useState<string | null>(null);
  const [unlockSecret, setUnlockSecret] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [authSessionNotice, setAuthSessionNotice] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const userRef = useRef<UserProfile | null>(null);
  const prevOnlineRef = useRef<boolean>(isOnline);
  const callSubscribersRef = useRef<Set<(signal: CallSignalPayload) => void>>(new Set());

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const subscribeCallSignals = useCallback((cb: (signal: CallSignalPayload) => void) => {
    callSubscribersRef.current.add(cb);
    return () => {
      callSubscribersRef.current.delete(cb);
    };
  }, []);

  const sendWsSignal = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const persistActiveSession = useCallback((sess: StoredAccountSession | null) => {
    if (!sess) {
      localStorage.removeItem(ACTIVE_SESSION_KEY);
      return;
    }
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(sess));
    setSavedSessions((prev) => {
      const filtered = prev.filter((s) => !(s.username === sess.username && s.deviceId === sess.deviceId));
      const next = [sess, ...filtered].slice(0, 5);
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const clearSessionState = useCallback(() => {
    const prevUserId = userRef.current?.id;
    const prevUsername = userRef.current?.username ?? sessionUsername;
    const prevDeviceId = deviceId;
    wsRef.current?.close();
    wsRef.current = null;
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    if (prevUserId || (prevUsername && prevDeviceId)) {
      void clearOfflineCacheForUser(prevUserId, prevUsername, prevDeviceId);
    }
    setToken(null);
    setDeviceId(null);
    setSessionUsername(null);
    setUser(null);
    setVault(null);
    setRooms([]);
    setActiveRoomId(null);
    setMessagesByRoom({});
    setLastSyncedAt(null);
    setEmergencyLocked(false);
  }, [deviceId, sessionUsername]);

  const hydrateFromOfflineStore = useCallback(async () => {
    if (!deviceId) return false;
    const targetUsername =
      sessionUsername ??
      savedSessions.find((s) => s.deviceId === deviceId)?.username ??
      null;
    if (!targetUsername) return false;

    const snapshot = await loadSessionSnapshot(targetUsername, deviceId);
    if (!snapshot) return false;

    const localVault = loadVaultFromLocal(snapshot.username, deviceId);
    if (!localVault) return false;

    const [cachedRoomData, cachedMessages] = await Promise.all([
      loadCachedRooms(snapshot.user.id),
      loadAllCachedMessagesForUser(snapshot.user.id),
    ]);

    setUser((prev) => prev ?? snapshot.user);
    setVault((prev) => prev ?? localVault);
    setVaultMode((prev) => prev || snapshot.vaultMode);
    if (cachedRoomData.rooms.length > 0) {
      setRooms((prev) => (prev.length > 0 ? prev : cachedRoomData.rooms));
      setActiveRoomId((prev) => prev ?? snapshot.activeRoomId ?? cachedRoomData.rooms[0].id);
    } else if (snapshot.activeRoomId) {
      setActiveRoomId((prev) => prev ?? snapshot.activeRoomId);
    }
    if (Object.keys(cachedMessages).length > 0) {
      setMessagesByRoom((prev) => (Object.keys(prev).length > 0 ? prev : cachedMessages));
    }
    if (cachedRoomData.updatedAt ?? snapshot.updatedAt) {
      setLastSyncedAt((prev) => prev ?? cachedRoomData.updatedAt ?? snapshot.updatedAt);
    }
    return true;
  }, [deviceId, sessionUsername, savedSessions]);

  const refreshProfileAndRooms = useCallback(async () => {
    if (!token || !deviceId) return;
    const hydrated = await hydrateFromOfflineStore();
    if (hydrated) {
      setBootstrapping(false);
    }

    try {
      const me = await rrApi.getMe(token);
      setUser(me.user);
      setSessionUsername(me.user.username);
      const localVault = loadVaultFromLocal(me.user.username, deviceId);
      setVault(localVault);
      const roomRes = await rrApi.getRooms(token);
      setRooms(roomRes.rooms);
      const nextActiveRoomId =
        activeRoomId && roomRes.rooms.some((r) => r.id === activeRoomId)
          ? activeRoomId
          : roomRes.rooms.length > 0
            ? roomRes.rooms[0].id
            : null;
      if (nextActiveRoomId && nextActiveRoomId !== activeRoomId) {
        setActiveRoomId(nextActiveRoomId);
      }
      const cachedMessages = await loadAllCachedMessagesForUser(me.user.id);
      if (Object.keys(cachedMessages).length > 0) {
        setMessagesByRoom((prev) => ({ ...cachedMessages, ...prev }));
      }
      setLastSyncedAt(Date.now());
      await Promise.all([
        saveSessionSnapshot(me.user.username, deviceId, {
          user: me.user,
          activeRoomId: nextActiveRoomId,
          vaultMode,
        }),
        saveCachedRooms(me.user.id, roomRes.rooms),
      ]);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearSessionState();
      } else if (!hydrated) {
        const recovered = await hydrateFromOfflineStore();
        if (!recovered && navigator.onLine) {
          clearSessionState();
        }
      }
    } finally {
      setBootstrapping(false);
    }
  }, [token, deviceId, activeRoomId, vaultMode, hydrateFromOfflineStore, clearSessionState]);

  useEffect(() => {
    if (token && deviceId) {
      void refreshProfileAndRooms();
    } else {
      setBootstrapping(false);
    }
  }, [token, deviceId]);

  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;
    if (!wasOnline && isOnline && token && deviceId) {
      void refreshProfileAndRooms();
    }
  }, [isOnline, token, deviceId, refreshProfileAndRooms]);

  // Persist user session snapshot & chat room metadata to IndexedDB whenever they change
  useEffect(() => {
    if (!user || !deviceId) return;
    void saveSessionSnapshot(user.username, deviceId, {
      user,
      activeRoomId,
      vaultMode,
    });
  }, [user, deviceId, activeRoomId, vaultMode]);

  useEffect(() => {
    if (!user) return;
    void saveCachedRooms(user.id, rooms);
  }, [user, rooms]);

  // Windows Desktop keyboard shortcuts & PrintScreen deterrence notice
  useEffect(() => {
    if (!user) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setActiveTab('chats');
        setFocusSearchTrigger((n) => n + 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setActiveTab('ai');
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (token) {
          rrApi.emergencyLock(token).catch(() => {});
        }
        setEmergencyLocked(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'PrintScreen' && user.screenshotPrivacy !== false) {
        setBannerAlert(
          'Screenshot key detected. Privacy Shield is active, though OS/hardware capture or external copies cannot be fully prevented by any app.'
        );
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [user, token]);

  // Real-time WebSocket connection
  useEffect(() => {
    if (!token) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
    let closedByEffect = false;
    let reconnectTimer: number | null = null;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(ev.data) as { event: string; payload: any };
          if (frame.event === 'message:new') {
            const msg = frame.payload as EncryptedMessageRecord;
            setMessagesByRoom((prev) => {
              const existing = prev[msg.roomId] ?? [];
              if (existing.some((m) => m.id === msg.id)) return prev;
              const nextRoomMsgs = [...existing, msg];
              if (userRef.current) {
                void saveCachedRoomMessages(userRef.current.id, msg.roomId, nextRoomMsgs);
              }
              return { ...prev, [msg.roomId]: nextRoomMsgs };
            });
            setRooms((prev) =>
              prev.map((r) => (r.id === msg.roomId ? { ...r, lastMessage: msg, messageCount: r.messageCount + 1 } : r))
            );
            const curUser = userRef.current;
            if (
              curUser &&
              msg.senderId !== curUser.id &&
              curUser.notificationSettings?.enabled !== false &&
              curUser.notificationSettings?.soundEnabled !== false
            ) {
              playNotificationChime(curUser.notificationSettings?.customSound ?? 'crystal');
            }
          } else if (frame.event === 'message:edited') {
            const { roomId, messageId, ciphertextB64, ivB64, editedAt } = frame.payload as {
              roomId: string;
              messageId: string;
              ciphertextB64: string;
              ivB64: string;
              editedAt: number;
            };
            setMessagesByRoom((prev) => {
              const nextRoomMsgs = (prev[roomId] ?? []).map((m) =>
                m.id === messageId ? { ...m, ciphertextB64, ivB64, editedAt } : m
              );
              if (userRef.current) {
                void saveCachedRoomMessages(userRef.current.id, roomId, nextRoomMsgs);
              }
              return { ...prev, [roomId]: nextRoomMsgs };
            });
          } else if (frame.event === 'message:deleted') {
            const { roomId, messageId } = frame.payload as { roomId: string; messageId: string };
            setMessagesByRoom((prev) => {
              const nextRoomMsgs = (prev[roomId] ?? []).map((m) =>
                m.id === messageId ? { ...m, deleted: true, ciphertextB64: '', ivB64: '' } : m
              );
              if (userRef.current) {
                void saveCachedRoomMessages(userRef.current.id, roomId, nextRoomMsgs);
              }
              return { ...prev, [roomId]: nextRoomMsgs };
            });
          } else if (frame.event === 'message:recalled') {
            const { roomId, messageId, recalledAt } = frame.payload as {
              roomId: string;
              messageId: string;
              recalledAt: number;
            };
            setMessagesByRoom((prev) => {
              const nextRoomMsgs = (prev[roomId] ?? []).map((m) =>
                m.id === messageId ? { ...m, deleted: true, recalledAt, ciphertextB64: '', ivB64: '' } : m
              );
              if (userRef.current) {
                void saveCachedRoomMessages(userRef.current.id, roomId, nextRoomMsgs);
              }
              return { ...prev, [roomId]: nextRoomMsgs };
            });
          } else if (frame.event === 'social:updated') {
            setSocialRevision((r) => r + 1);
          } else if (frame.event === 'message:reaction') {
            const { roomId, messageId, reactions } = frame.payload as {
              roomId: string;
              messageId: string;
              reactions: Record<string, string[]>;
            };
            setMessagesByRoom((prev) => {
              const nextRoomMsgs = (prev[roomId] ?? []).map((m) =>
                m.id === messageId ? { ...m, reactions } : m
              );
              if (userRef.current) {
                void saveCachedRoomMessages(userRef.current.id, roomId, nextRoomMsgs);
              }
              return { ...prev, [roomId]: nextRoomMsgs };
            });
          } else if (frame.event === 'message:read') {
            const { roomId, userId, messageIds } = frame.payload as {
              roomId: string;
              userId: string;
              messageIds: string[];
            };
            setMessagesByRoom((prev) => {
              const nextRoomMsgs = (prev[roomId] ?? []).map((m) =>
                messageIds.includes(m.id) && !m.readBy.includes(userId)
                  ? { ...m, readBy: [...m.readBy, userId] }
                  : m
              );
              if (userRef.current) {
                void saveCachedRoomMessages(userRef.current.id, roomId, nextRoomMsgs);
              }
              return { ...prev, [roomId]: nextRoomMsgs };
            });
          } else if (frame.event === 'message:expired') {
            const { roomId, messageIds } = frame.payload as { roomId: string; messageIds: string[] };
            setMessagesByRoom((prev) => {
              const nextRoomMsgs = (prev[roomId] ?? []).filter((m) => !messageIds.includes(m.id));
              if (userRef.current) {
                void saveCachedRoomMessages(userRef.current.id, roomId, nextRoomMsgs);
              }
              return { ...prev, [roomId]: nextRoomMsgs };
            });
          } else if (frame.event === 'room:updated') {
            rrApi.getRooms(token!).then((r) => setRooms(r.rooms)).catch(() => {});
          } else if (frame.event === 'wallet:updated') {
            const { balanceCents } = frame.payload as { balanceCents: number };
            setUser((prev) => (prev ? { ...prev, walletBalanceCents: balanceCents } : prev));
          } else if (['call:offer', 'call:answer', 'call:ice', 'call:end', 'call:reject'].includes(frame.event)) {
            setActiveTab('chats');
            const signal: CallSignalPayload = {
              type: frame.event as CallSignalPayload['type'],
              ...frame.payload,
            };
            callSubscribersRef.current.forEach((cb) => cb(signal));
          } else if (frame.event === 'login:alert') {
            const alert = frame.payload as { eventType: string; deviceName: string };
            if (alert.eventType === 'login_blocked_bruteforce') {
              setBannerAlert(`Security alert: Brute-force login attempt blocked from ${alert.deviceName}.`);
            }
          } else if (frame.event === 'device:revoked') {
            setBannerAlert('This device session was revoked from another authorized device.');
            clearSessionState();
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = () => {
        if (!closedByEffect) {
          reconnectTimer = window.setTimeout(connect, 2500);
        }
      };
    }

    connect();
    return () => {
      closedByEffect = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [token, clearSessionState]);

  async function handleStartDirectChat(target: DirectoryUser) {
    if (!token || !deviceId || !vault) return;
    const rawKey = await generateRoomKeyBytes();
    const wrappedKeys: Record<string, unknown> = {};
    wrappedKeys[deviceId] = await wrapRoomKeyForDevice(rawKey, deviceId, vault, vault.ecdhPubJwk);
    for (const dev of target.devices) {
      wrappedKeys[dev.deviceId] = await wrapRoomKeyForDevice(rawKey, deviceId, vault, dev.ecdhPubKeyJwk);
    }
    const res = await rrApi.createRoom(token, {
      type: 'direct',
      memberIds: [target.id],
      encryptedRoomKeys: wrappedKeys,
    });
    const roomList = await rrApi.getRooms(token);
    setRooms(roomList.rooms);
    setActiveRoomId(res.room.id);
    setVaultMode(false);
    setActiveTab('chats');
  }

  async function handleLogout() {
    if (token) {
      await rrApi.logout(token).catch(() => {});
    }
    if (user && deviceId) {
      setSavedSessions((prev) => {
        const next = prev.filter((s) => !(s.username === user.username && s.deviceId === deviceId));
        localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(next));
        return next;
      });
      removeVaultFromLocal(user.username, deviceId);
    }
    clearSessionState();
  }

  async function handleUnlockEmergencyLock(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !token || !deviceId) return;
    setUnlockError(null);
    try {
      const res = await rrApi.unlockSession(token, unlockSecret);
      if (res.duressTriggered) {
        setEmergencyLocked(false);
        setUnlockSecret('');
        setDuressTriggered(true);
        setDecoyMode(true);
        refreshProfileAndRooms().catch(() => {});
        return;
      }
      setEmergencyLocked(false);
      setUnlockSecret('');
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : 'Verification failed.');
    }
  }

  if (bootstrapping) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-[#06070B] text-zinc-600 dark:text-zinc-300 flex items-center justify-center text-sm">
        Unlocking local cryptographic session...
      </div>
    );
  }

  if (!token || !deviceId || !user || !vault) {
    return (
      <AuthView
        savedSessions={savedSessions}
        sessionNotice={authSessionNotice}
        themeMode={themeMode}
        onToggleTheme={() => setThemeMode((m) => (m === 'dark' ? 'light' : 'dark'))}
        onSwitchSession={(sess) => {
          const localVault = loadVaultFromLocal(sess.username, sess.deviceId);
          if (!localVault) {
            setSavedSessions((prev) => {
              const next = prev.filter((s) => !(s.username === sess.username && s.deviceId === sess.deviceId));
              localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(next));
              return next;
            });
            setAuthSessionNotice(
              `Local cryptographic key vault missing for @${sess.username}. Please sign in again to re-initialize keys.`
            );
            return;
          }
          setAuthSessionNotice(null);
          persistActiveSession(sess);
          setSessionUsername(sess.username);
          setToken(sess.token);
          setDeviceId(sess.deviceId);
          setVault(localVault);
        }}
        onAuthenticated={({ token: t, deviceId: d, user: u }) => {
          setAuthSessionNotice(null);
          persistActiveSession({ token: t, deviceId: d, username: u.username });
          setSessionUsername(u.username);
          setToken(t);
          setDeviceId(d);
          setUser(u);
          setVault(loadVaultFromLocal(u.username, d));
          setActiveTab('chats');
        }}
      />
    );
  }

  if (decoyMode) {
    return (
      <DecoyAppScreen
        username={user.username}
        token={token}
        hasVaultPin={Boolean(user.hasVaultPin)}
        authProvider={user.authProvider}
        duressTriggered={duressTriggered}
        onUnlockRealApp={() => {
          setDecoyMode(false);
          setDuressTriggered(false);
        }}
      />
    );
  }

  const desktopNavItems: Array<{ id: AppTab; label: string; icon: React.ReactNode }> = [
    { id: 'chats', label: 'Home', icon: <Home className="w-4 h-4" /> },
    { id: 'vault', label: 'Vault', icon: <Vault className="w-4 h-4" /> },
    { id: 'calls', label: 'Calls', icon: <Phone className="w-4 h-4" /> },
    { id: 'contacts', label: 'Contacts', icon: <Users className="w-4 h-4" /> },
    { id: 'social', label: 'Social', icon: <Compass className="w-4 h-4" /> },
    { id: 'cloud', label: 'Cloud Sync', icon: <Cloud className="w-4 h-4" /> },
    { id: 'ai', label: 'RR AI', icon: <Bot className="w-4 h-4" /> },
    { id: 'studio', label: '3D Studio', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'security', label: 'RR Shield', icon: <Radar className="w-4 h-4" /> },
    { id: 'features', label: '26 Features', icon: <Sliders className="w-4 h-4" /> },
    { id: 'privacy', label: 'Settings', icon: <SlidersHorizontal className="w-4 h-4" /> },
    { id: 'admin', label: 'Admin', icon: <Activity className="w-4 h-4" /> },
    { id: 'architecture', label: 'Repo', icon: <FolderGit2 className="w-4 h-4" /> },
  ];

  const handleNavigate = (tab: AppTab) => {
    if (tab === 'vault') {
      setVaultMode(true);
      setActiveTab('chats');
    } else if (tab === 'chats') {
      setVaultMode(false);
      setActiveTab('chats');
    } else {
      setActiveTab(tab);
    }
  };

  const identityCfg = user.identity3D ?? DEFAULT_IDENTITY_3D;

  return (
    <div className="h-screen w-screen overflow-hidden bg-zinc-50 dark:bg-[#06070B] text-zinc-900 dark:text-zinc-100 flex flex-col md:flex-row relative">
      {/* Emergency Privacy Mode Lock Overlay */}
      {emergencyLocked && (
        <div className="fixed inset-0 z-[100] bg-zinc-950/95 backdrop-blur-2xl flex items-center justify-center p-6">
          <form
            onSubmit={handleUnlockEmergencyLock}
            className="w-full max-w-sm rounded-2xl bg-[#0D1018] border border-purple-700/60 p-6 space-y-4 text-zinc-100 shadow-2xl"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-600/20 border border-red-500/40 flex items-center justify-center text-red-400">
                <Lock className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold">Emergency Privacy Lock</h2>
                <p className="text-xs text-zinc-400">
                  Other sessions revoked. Previews hidden. Re-authenticate to unlock.
                </p>
              </div>
            </div>
            {unlockError && <p className="text-xs text-red-400">{unlockError}</p>}
            <input
              type={user.authProvider && user.authProvider !== 'local' && !user.hasVaultPin ? 'text' : 'password'}
              required
              autoFocus
              value={unlockSecret}
              onChange={(e) => setUnlockSecret(e.target.value)}
              placeholder={
                user.authProvider && user.authProvider !== 'local'
                  ? user.hasVaultPin
                    ? 'Enter Vault PIN or UNLOCK'
                    : `Type ${user.username} or UNLOCK`
                  : user.hasVaultPin
                    ? 'Enter Account Password or Vault PIN'
                    : 'Enter Account Password'
              }
              className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-100"
            />
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={handleLogout}
                className="px-3.5 py-2 text-xs rounded-xl border border-zinc-700 text-zinc-300"
              >
                Sign Out
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white"
              >
                Unlock RRchat 1
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Windows Desktop Glassmorphic Left Navigation Rail */}
      {!chatBoxOnly && (
        <aside className="hidden md:flex w-[76px] lg:w-56 border-r border-zinc-200 dark:border-zinc-800/80 rr-glass-strong flex-col justify-between py-4 px-2.5 lg:px-3 shrink-0 z-20">
          <div className="space-y-4">
            <div className="flex items-center justify-center lg:justify-start gap-2.5 px-2">
              <Logo3D size="badge" />
              <span className="hidden lg:inline text-sm font-bold tracking-tight whitespace-nowrap">RRchat 1</span>
            </div>

            <nav className="space-y-1">
              {desktopNavItems.map((item) => {
                const isSelected =
                  item.id === 'vault'
                    ? activeTab === 'chats' && vaultMode
                    : item.id === 'chats'
                      ? activeTab === 'chats' && !vaultMode
                      : activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavigate(item.id)}
                    className={`w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-colors whitespace-nowrap ${
                      isSelected
                        ? 'bg-purple-600 text-white shadow-sm'
                        : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70 hover:text-zinc-900 dark:hover:text-zinc-100'
                    }`}
                  >
                    {item.icon}
                    <span className="hidden lg:inline">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="space-y-1.5 pt-3 border-t border-zinc-200 dark:border-zinc-800/80">
            <PWAInstallButton />
            <button
              type="button"
              onClick={() => setThemeMode((m) => (m === 'dark' ? 'light' : 'dark'))}
              className="w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2 rounded-xl text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70"
              title="Toggle Dark / Light Mode"
            >
              {themeMode === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              <span className="hidden lg:inline">{themeMode === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                rrApi.emergencyLock(token).catch(() => {});
                setEmergencyLocked(true);
              }}
              className="w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2 rounded-xl text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
              title="Emergency Privacy Lock (Ctrl+Shift+L)"
            >
              <ShieldAlert className="w-4 h-4" />
              <span className="hidden lg:inline">Emergency Lock</span>
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2 rounded-xl text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden lg:inline">Sign Out</span>
            </button>
          </div>
        </aside>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <OfflineIndicator cachedRoomCount={rooms.length} lastSyncedAt={lastSyncedAt} />
        {bannerAlert && (
          <div className="px-6 py-2.5 bg-amber-100 dark:bg-amber-950/60 border-b border-amber-300 dark:border-amber-800/60 text-xs text-amber-900 dark:text-amber-200 flex items-center justify-between">
            <span>{bannerAlert}</span>
            <button type="button" onClick={() => setBannerAlert(null)} className="underline">
              Dismiss
            </button>
          </div>
        )}

        <main className="flex-1 min-h-0 overflow-hidden">
          {activeTab === 'chats' && (
            <ChatWorkspace
              token={token}
              user={user}
              deviceId={deviceId}
              vault={vault}
              onVaultUpdated={setVault}
              onUserRefresh={refreshProfileAndRooms}
              rooms={rooms}
              activeRoomId={activeRoomId}
              onSelectRoom={setActiveRoomId}
              onRoomsChanged={async () => {
                const res = await rrApi.getRooms(token);
                setRooms(res.rooms);
              }}
              messagesByRoom={messagesByRoom}
              onMessagesLoaded={(roomId, msgs) => {
                setMessagesByRoom((prev) => ({ ...prev, [roomId]: msgs }));
                void saveCachedRoomMessages(user.id, roomId, msgs);
              }}
              onNavigateTab={(tab) => handleNavigate(tab)}
              onLogout={handleLogout}
              chatBoxOnly={chatBoxOnly}
              onToggleChatBoxOnly={() => setChatBoxOnly((v) => !v)}
              vaultMode={vaultMode}
              onToggleVaultMode={(v) => setVaultMode(v)}
              aiConsentGranted={aiConsentGranted}
              pendingAiDraft={pendingAiDraft}
              onClearAiDraft={() => setPendingAiDraft(null)}
              onDecryptedSnippetsChange={(title, snippets) => setActiveRoomSnippets({ title, snippets })}
              externalCallRequest={externalCallRequest}
              onClearExternalCallRequest={() => setExternalCallRequest(null)}
              focusSearchTrigger={focusSearchTrigger}
              sendWsSignal={sendWsSignal}
              subscribeCallSignals={subscribeCallSignals}
              onDuressTriggered={(behavior) => {
                if (behavior === 'wipe_and_decoy') {
                  void clearOfflineCacheForUser(user.id, user.username, deviceId);
                }
                setDuressTriggered(true);
                setDecoyMode(true);
                refreshProfileAndRooms().catch(() => {});
              }}
              splitRoomId={splitRoomId}
              onSelectSplitRoom={setSplitRoomId}
            />
          )}

          {activeTab === 'calls' && (
            <CallsView
              token={token}
              currentUserId={user.id}
              rooms={rooms}
              onStartCallFromRoom={(roomId, mode) => {
                setVaultMode(false);
                setActiveTab('chats');
                setExternalCallRequest({ roomId, mode });
              }}
            />
          )}

          {activeTab === 'contacts' && (
            <ContactsView
              token={token}
              user={user}
              deviceId={deviceId}
              vault={vault}
              onVaultUpdated={setVault}
              onStartDirectChat={handleStartDirectChat}
            />
          )}

          {activeTab === 'social' && (
            <SocialView
              token={token}
              user={user}
              onUserRefresh={refreshProfileAndRooms}
              onNavigateContacts={() => setActiveTab('contacts')}
              socialRevision={socialRevision}
            />
          )}

          {activeTab === 'cloud' && (
            <FirebaseRealtimeSyncView
              localUser={user}
              localEcdhFingerprint={vault.fingerprint}
              localRooms={rooms}
            />
          )}

          {activeTab === 'ai' && (
            <AIAssistantView
              token={token}
              user={user}
              onUserRefresh={refreshProfileAndRooms}
              consentGranted={aiConsentGranted}
              onConsentChange={setAiConsentGranted}
              activeRoomTitle={activeRoomSnippets.title}
              recentDecryptedSnippets={activeRoomSnippets.snippets}
              onInsertReplyToChat={(text) => {
                setPendingAiDraft(text);
                setActiveTab('chats');
              }}
            />
          )}

          {activeTab === 'studio' && (
            <Avatar3DStudio token={token} user={user} onUserRefresh={refreshProfileAndRooms} />
          )}

          {activeTab === 'security' && (
            <SecurityView
              token={token}
              user={user}
              deviceId={deviceId}
              vault={vault}
              onVaultUpdated={setVault}
              onUserRefresh={refreshProfileAndRooms}
              onAccountTerminated={clearSessionState}
              onEmergencyLocked={() => setEmergencyLocked(true)}
              onOpenDecoy={() => setDecoyMode(true)}
            />
          )}

          {activeTab === 'features' && (
            <FeatureSelectorView token={token} user={user} onUserRefresh={refreshProfileAndRooms} />
          )}

          {activeTab === 'privacy' && (
            <PrivacyView token={token} user={user} vault={vault} onUserRefresh={refreshProfileAndRooms} />
          )}

          {activeTab === 'admin' && <AdminView token={token} currentUserId={user.id} />}

          {activeTab === 'architecture' && <ArchitectureView />}

          {/* Mobile Profile Hub combining 3D Identity, Vault, Social, 26 Features, Radar, Settings & Emergency Lock */}
          {activeTab === 'profile' && (
            <div className="h-full overflow-y-auto p-6 space-y-6">
              <div className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 flex items-center gap-4">
                <div className="shrink-0">
                  <Avatar3DCanvas config={identityCfg} size={88} />
                </div>
                <div className="min-w-0">
                  <div className="text-lg font-semibold truncate">{user.displayName}</div>
                  <div className="text-xs font-mono text-purple-600 dark:text-purple-400">@{user.username}</div>
                  {identityCfg.badge !== 'none' && (
                    <div className="text-xs text-zinc-500 mt-1">{BADGE_LABELS[identityCfg.badge]}</div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {[
                  { tab: 'cloud' as const, label: 'Firebase Cloud Sync', icon: Cloud },
                  { tab: 'social' as const, label: 'Social Hub', icon: Compass },
                  { tab: 'features' as const, label: '26 Features', icon: Sliders },
                  { tab: 'studio' as const, label: '3D Identity Studio', icon: Sparkles },
                  { tab: 'vault' as const, label: 'Private Vault', icon: Vault },
                  { tab: 'security' as const, label: 'RR Shield & Radar', icon: Radar },
                  { tab: 'privacy' as const, label: 'Private Settings', icon: SlidersHorizontal },
                  { tab: 'admin' as const, label: 'Admin Console', icon: Activity },
                  { tab: 'architecture' as const, label: 'Architecture', icon: FolderGit2 },
                ].map((card) => {
                  const Icon = card.icon;
                  return (
                    <button
                      key={card.tab}
                      type="button"
                      onClick={() => handleNavigate(card.tab)}
                      className="rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 text-left space-y-2 hover:border-purple-500/60"
                    >
                      <Icon className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                      <div className="text-xs font-semibold">{card.label}</div>
                    </button>
                  );
                })}
              </div>

              <div className="space-y-2.5">
                <PWAInstallButton compact />
                <button
                  type="button"
                  onClick={() => setThemeMode((m) => (m === 'dark' ? 'light' : 'dark'))}
                  className="w-full p-3.5 rounded-2xl rr-glass border border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-xs font-medium"
                >
                  <span className="flex items-center gap-2">
                    {themeMode === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                    Switch to {themeMode === 'dark' ? 'Light Mode' : 'Dark Mode'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    rrApi.emergencyLock(token).catch(() => {});
                    setEmergencyLocked(true);
                  }}
                  className="w-full p-3.5 rounded-2xl bg-red-600 text-white flex items-center justify-center gap-2 text-xs font-semibold"
                >
                  <ShieldAlert className="w-4 h-4" />
                  Activate Emergency Privacy Mode
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="w-full p-3.5 rounded-2xl border border-zinc-200 dark:border-zinc-800 flex items-center justify-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-300"
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </main>

        {/* Mobile Bottom Navigation Bar (exact 5 tabs: Home, Calls, Contacts, AI, Profile) */}
        <nav className="md:hidden h-16 px-2 border-t border-zinc-200 dark:border-zinc-800/80 rr-glass-strong grid grid-cols-5 items-center shrink-0">
          {(
            [
              { id: 'chats', label: 'Home', icon: Home },
              { id: 'calls', label: 'Calls', icon: Phone },
              { id: 'contacts', label: 'Contacts', icon: Users },
              { id: 'ai', label: 'AI', icon: Bot },
              { id: 'profile', label: 'Profile', icon: User },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active =
              item.id === 'chats'
                ? activeTab === 'chats'
                : item.id === 'profile'
                  ? ['profile', 'cloud', 'studio', 'security', 'privacy', 'admin', 'architecture', 'social', 'features'].includes(activeTab)
                  : activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium transition-colors ${
                  active ? 'text-purple-600 dark:text-purple-400' : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
