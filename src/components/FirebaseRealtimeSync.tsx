import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithPopup, signOut, type User as FirebaseUser } from 'firebase/auth';
import { collection, doc, getDocFromServer, getFirestore, limit, onSnapshot, query, where } from 'firebase/firestore';
import {
  Cloud,
  Compass,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  LogOut,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  type ChatRoomMetadataDoc,
  type CloudMessageDoc,
  type CloudPresence,
  type CloudPublicNode,
  type CloudRoomDoc,
  type CloudRoomMemberDoc,
  type CloudStoryDoc,
  type CloudUserRoomLink,
  createCloudRoom,
  decryptCloudMessage,
  deleteCloudStory,
  deriveCloudKeyFromPassphrase,
  encryptCloudMessage,
  generateCloudRoomKeyB64,
  googleProvider,
  handleFirestoreError,
  importCloudRoomKeyB64,
  invitePeerToCloudRoom,
  OperationType,
  publishCloudStory,
  recallCloudMessage,
  sendEncryptedCloudMessage,
  syncFirebaseUserRecords,
  updateCloudDiscoverySettings,
  updateCloudPresence,
} from '../lib/firebase';
import type { ChatRoomRecord, UserProfile } from '../lib/types';

// Initialize Firebase & Firestore directly using firebase-applet-config.json
const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const firestoreDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
export const firebaseAuth = getAuth(firebaseApp);

type ConnectionStatus = 'checking' | 'connected' | 'offline' | 'error';

interface FirebaseContextValue {
  authReady: boolean;
  firebaseUser: FirebaseUser | null;
  connectionStatus: ConnectionStatus;
  authBusy: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<void>;
  signOutFirebase: () => Promise<void>;
  recheckConnection: () => Promise<void>;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

export function FirebaseProvider({ children }: { children: React.ReactNode }) {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('checking');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const recheckConnection = useCallback(async () => {
    setConnectionStatus('checking');
    try {
      await getDocFromServer(doc(firestoreDb, 'test', 'connection'));
      setConnectionStatus('connected');
    } catch (error) {
      if (error instanceof Error && error.message.includes('the client is offline')) {
        console.error('Please check your Firebase configuration.');
        setConnectionStatus('offline');
      } else {
        setConnectionStatus('error');
      }
    }
  }, []);

  useEffect(() => {
    recheckConnection();
    const unsub = onAuthStateChanged(firebaseAuth, (fbUser) => {
      setFirebaseUser(fbUser);
      setAuthReady(true);
    });
    return () => unsub();
  }, [recheckConnection]);

  const signInWithGoogle = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signInWithPopup(firebaseAuth, googleProvider);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google Sign-In could not be completed.');
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const signOutFirebase = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signOut(firebaseAuth);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign out failed.');
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const value = useMemo<FirebaseContextValue>(
    () => ({
      authReady,
      firebaseUser,
      connectionStatus,
      authBusy,
      authError,
      signInWithGoogle,
      signOutFirebase,
      recheckConnection,
    }),
    [authReady, firebaseUser, connectionStatus, authBusy, authError, signInWithGoogle, signOutFirebase, recheckConnection]
  );

  return <FirebaseContext.Provider value={value}>{children}</FirebaseContext.Provider>;
}

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) {
    throw new Error('useFirebase must be used inside FirebaseProvider.');
  }
  return ctx;
}

interface DecryptedCloudMessage {
  raw: CloudMessageDoc;
  plaintext: string;
  decryptError: boolean;
}

const STORY_THEMES: Record<CloudStoryDoc['theme'], string> = {
  obsidian_purple: 'from-[#161124] via-[#1C1430] to-[#0D1018] border-purple-500/40 text-zinc-100',
  chrome_silver: 'from-zinc-200 via-zinc-100 to-zinc-300 dark:from-zinc-800 dark:via-zinc-900 dark:to-zinc-950 border-zinc-400/40',
  neon_violet: 'from-purple-950 via-fuchsia-950/60 to-zinc-950 border-fuchsia-500/40 text-zinc-100',
};

function formatTimestamp(ts?: { toMillis: () => number } | null): string {
  if (!ts || typeof ts.toMillis !== 'function') return 'syncing...';
  return new Date(ts.toMillis()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function FirebaseRealtimeSyncView({
  localUser,
  localEcdhFingerprint,
  localRooms = [],
}: {
  localUser?: UserProfile | null;
  localEcdhFingerprint?: string;
  localRooms?: ChatRoomRecord[];
}) {
  const {
    authReady,
    firebaseUser,
    connectionStatus,
    authBusy,
    authError,
    signInWithGoogle,
    signOutFirebase,
    recheckConnection,
  } = useFirebase();

  const [fatalError, setFatalError] = useState<Error | null>(null);
  if (fatalError) {
    throw fatalError;
  }

  const forwardErrorToBoundary = useCallback((err: unknown, op: OperationType, path: string) => {
    try {
      handleFirestoreError(err, op, path);
    } catch (wrapped) {
      setFatalError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
    }
  }, []);

  const [syncedIdentity, setSyncedIdentity] = useState<{ username: string; displayName: string } | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);

  // Live onSnapshot collections
  const [chatRoomsMeta, setChatRoomsMeta] = useState<ChatRoomMetadataDoc[]>([]);
  const [roomLinks, setRoomLinks] = useState<CloudUserRoomLink[]>([]);
  const [publicNodes, setPublicNodes] = useState<CloudPublicNode[]>([]);
  const [presenceList, setPresenceList] = useState<CloudPresence[]>([]);
  const [stories, setStories] = useState<CloudStoryDoc[]>([]);

  // Active room live snapshots
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [activeRoom, setActiveRoom] = useState<CloudRoomDoc | null>(null);
  const [activeMembership, setActiveMembership] = useState<CloudRoomMemberDoc | null>(null);
  const [rawMessages, setRawMessages] = useState<CloudMessageDoc[]>([]);
  const [decryptedMessages, setDecryptedMessages] = useState<DecryptedCloudMessage[]>([]);

  // Privacy & controls state
  const [sharePresence, setSharePresence] = useState(true);
  const [presenceStatus, setPresenceStatus] = useState<'online' | 'away' | 'hidden'>('online');
  const [discoverable, setDiscoverable] = useState(true);
  const [nearbyOptIn, setNearbyOptIn] = useState(false);

  // Forms
  const [newRoomTitle, setNewRoomTitle] = useState('');
  const [newRoomType, setNewRoomType] = useState<'direct' | 'group'>('group');
  const [passphraseByRoom, setPassphraseByRoom] = useState<Record<string, string>>({});
  const [composerText, setComposerText] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);
  const [storyText, setStoryText] = useState('');
  const [storyTheme, setStoryTheme] = useState<CloudStoryDoc['theme']>('obsidian_purple');
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const typingTimeoutRef = useRef<number | null>(null);

  // 1. Sync user profile, public node & presence document on Google Auth sign-in
  useEffect(() => {
    if (!authReady || !firebaseUser) {
      setSyncedIdentity(null);
      return;
    }

    let cancelled = false;
    setSyncBusy(true);

    syncFirebaseUserRecords(firebaseUser, {
      preferredUsername: localUser?.username,
      preferredDisplayName: localUser?.displayName,
      badge: localUser?.identity3D?.badge ?? 'verified',
      ecdhFingerprint: localEcdhFingerprint ?? '',
      discoverable,
      sharePresence,
      nearbyOptIn,
    })
      .then((res) => {
        if (!cancelled) {
          setSyncedIdentity(res);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setFatalError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .finally(() => {
        if (!cancelled) setSyncBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authReady, firebaseUser?.uid]);

  // 2. Attach core real-time onSnapshot listeners ONLY when authReady && firebaseUser
  useEffect(() => {
    if (!authReady || !firebaseUser) {
      setChatRoomsMeta([]);
      setRoomLinks([]);
      setPublicNodes([]);
      setPresenceList([]);
      setStories([]);
      setActiveRoomId(null);
      return;
    }

    const uid = firebaseUser.uid;

    // Synchronized Chat Room Metadata ('chatRooms' collection)
    const chatRoomsQuery = query(
      collection(firestoreDb, 'chatRooms'),
      where('participantUids', 'array-contains', uid),
      limit(40)
    );
    const unsubChatRooms = onSnapshot(
      chatRoomsQuery,
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as ChatRoomMetadataDoc)
          .sort((a, b) => (b.updatedAt?.toMillis() ?? 0) - (a.updatedAt?.toMillis() ?? 0));
        setChatRoomsMeta(items);
        setActiveRoomId((prev) => {
          if (prev) return prev;
          return items[0]?.id ?? null;
        });
      },
      (err) => forwardErrorToBoundary(err, OperationType.LIST, 'chatRooms')
    );

    const roomLinksQuery = query(
      collection(firestoreDb, 'users', uid, 'roomLinks'),
      where('uid', '==', uid),
      limit(40)
    );
    const unsubRooms = onSnapshot(
      roomLinksQuery,
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as CloudUserRoomLink)
          .sort((a, b) => (b.updatedAt?.toMillis() ?? 0) - (a.updatedAt?.toMillis() ?? 0));
        setRoomLinks(items);
        setActiveRoomId((prev) => {
          if (prev && items.some((r) => r.roomId === prev)) return prev;
          return items[0]?.roomId ?? null;
        });
      },
      (err) => forwardErrorToBoundary(err, OperationType.LIST, `users/${uid}/roomLinks`)
    );

    const nodesQuery = query(collection(firestoreDb, 'publicNodes'), where('discoverable', '==', true), limit(30));
    const unsubNodes = onSnapshot(
      nodesQuery,
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as CloudPublicNode)
          .sort((a, b) => (b.updatedAt?.toMillis() ?? 0) - (a.updatedAt?.toMillis() ?? 0));
        setPublicNodes(items);
      },
      (err) => forwardErrorToBoundary(err, OperationType.LIST, 'publicNodes')
    );

    const presenceQuery = query(collection(firestoreDb, 'presence'), where('sharePresence', '==', true), limit(30));
    const unsubPresence = onSnapshot(
      presenceQuery,
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as CloudPresence)
          .sort((a, b) => (b.lastActiveAt?.toMillis() ?? 0) - (a.lastActiveAt?.toMillis() ?? 0));
        setPresenceList(items);
      },
      (err) => forwardErrorToBoundary(err, OperationType.LIST, 'presence')
    );

    const storiesQuery = query(collection(firestoreDb, 'stories'), where('visibility', '==', 'friends_or_public'), limit(30));
    const unsubStories = onSnapshot(
      storiesQuery,
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as CloudStoryDoc)
          .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0));
        setStories(items);
      },
      (err) => forwardErrorToBoundary(err, OperationType.LIST, 'stories')
    );

    return () => {
      unsubChatRooms();
      unsubRooms();
      unsubNodes();
      unsubPresence();
      unsubStories();
    };
  }, [authReady, firebaseUser?.uid, forwardErrorToBoundary]);

  // 3. Active room metadata + membership + live encrypted messages onSnapshot
  useEffect(() => {
    if (!authReady || !firebaseUser || !activeRoomId) {
      setActiveRoom(null);
      setActiveMembership(null);
      setRawMessages([]);
      return;
    }

    const uid = firebaseUser.uid;

    const unsubRoom = onSnapshot(
      doc(firestoreDb, 'rooms', activeRoomId),
      (snap) => {
        setActiveRoom(snap.exists() ? (snap.data() as CloudRoomDoc) : null);
      },
      (err) => forwardErrorToBoundary(err, OperationType.GET, `rooms/${activeRoomId}`)
    );

    const unsubMember = onSnapshot(
      doc(firestoreDb, 'rooms', activeRoomId, 'members', uid),
      (snap) => {
        setActiveMembership(snap.exists() ? (snap.data() as CloudRoomMemberDoc) : null);
      },
      (err) => forwardErrorToBoundary(err, OperationType.GET, `rooms/${activeRoomId}/members/${uid}`)
    );

    const messagesQuery = query(
      collection(firestoreDb, 'rooms', activeRoomId, 'messages'),
      where('participantUids', 'array-contains', uid),
      limit(120)
    );
    const unsubMessages = onSnapshot(
      messagesQuery,
      (snap) => {
        const msgs = snap.docs
          .map((d) => d.data() as CloudMessageDoc)
          .sort((a, b) => (a.createdAt?.toMillis() ?? Date.now()) - (b.createdAt?.toMillis() ?? Date.now()));
        setRawMessages(msgs);
      },
      (err) => forwardErrorToBoundary(err, OperationType.LIST, `rooms/${activeRoomId}/messages`)
    );

    return () => {
      unsubRoom();
      unsubMember();
      unsubMessages();
    };
  }, [authReady, firebaseUser?.uid, activeRoomId, forwardErrorToBoundary]);

  // 4. Client-side AES-256-GCM decryption for incoming live Firestore messages
  useEffect(() => {
    let cancelled = false;

    async function decryptAll() {
      if (!activeRoomId || rawMessages.length === 0) {
        setDecryptedMessages([]);
        return;
      }

      const customPass = passphraseByRoom[activeRoomId]?.trim();
      let aesKey: CryptoKey | null = null;
      try {
        if (customPass) {
          aesKey = await deriveCloudKeyFromPassphrase(activeRoomId, customPass);
        } else if (activeMembership?.wrappedRoomKeyB64) {
          aesKey = await importCloudRoomKeyB64(activeMembership.wrappedRoomKeyB64);
        }
      } catch {
        aesKey = null;
      }

      const resolved: DecryptedCloudMessage[] = [];
      for (const msg of rawMessages) {
        if (msg.recalled) {
          resolved.push({ raw: msg, plaintext: 'Message recalled by sender.', decryptError: false });
          continue;
        }
        if (!aesKey || !msg.ciphertextB64 || !msg.ivB64) {
          resolved.push({
            raw: msg,
            plaintext: 'Encrypted payload (room key or passphrase required)',
            decryptError: true,
          });
          continue;
        }
        try {
          const text = await decryptCloudMessage(aesKey, msg.ciphertextB64, msg.ivB64);
          resolved.push({ raw: msg, plaintext: text, decryptError: false });
        } catch {
          resolved.push({
            raw: msg,
            plaintext: 'Unable to decrypt with current room key/passphrase.',
            decryptError: true,
          });
        }
      }

      if (!cancelled) {
        setDecryptedMessages(resolved);
      }
    }

    decryptAll();
    return () => {
      cancelled = true;
    };
  }, [rawMessages, activeRoomId, activeMembership?.wrappedRoomKeyB64, passphraseByRoom]);

  // Broadcast live typing indicator cleanly
  const handleTypingChange = (nextVal: string) => {
    setComposerText(nextVal);
    if (!firebaseUser || !syncedIdentity || !activeRoomId || !sharePresence) return;

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }

    updateCloudPresence({
      uid: firebaseUser.uid,
      username: syncedIdentity.username,
      status: presenceStatus,
      sharePresence,
      typingRoomId: nextVal.trim() ? activeRoomId : '',
    }).catch(() => {});

    if (nextVal.trim()) {
      typingTimeoutRef.current = window.setTimeout(() => {
        if (firebaseUser && syncedIdentity) {
          updateCloudPresence({
            uid: firebaseUser.uid,
            username: syncedIdentity.username,
            status: presenceStatus,
            sharePresence,
            typingRoomId: '',
          }).catch(() => {});
        }
      }, 2500);
    }
  };

  async function handleCreateRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!firebaseUser) return;
    const roomKeyB64 = generateCloudRoomKeyB64();
    const roomId = await createCloudRoom({
      ownerUid: firebaseUser.uid,
      ownerDisplayName: syncedIdentity?.displayName ?? firebaseUser.displayName ?? 'Owner',
      title: newRoomTitle || `${syncedIdentity?.displayName ?? 'RRchat'} Cloud Room`,
      roomType: newRoomType,
      wrappedRoomKeyB64: roomKeyB64,
    });
    setNewRoomTitle('');
    setActiveRoomId(roomId);
    setActionNotice('Real-time room and chatRooms metadata synchronized to Firestore.');
  }

  async function handleSyncLocalRoomMetadata(localRoom: ChatRoomRecord) {
    if (!firebaseUser) return;
    const existingSync = chatRoomsMeta.find((c) => c.syncedFromLocalRoomId === localRoom.id);
    if (existingSync) {
      setActiveRoomId(existingSync.id);
      setActionNotice(`Local room "${localRoom.title}" is already synced in chatRooms.`);
      return;
    }
    const roomKeyB64 = generateCloudRoomKeyB64();
    const roomId = await createCloudRoom({
      ownerUid: firebaseUser.uid,
      ownerDisplayName: syncedIdentity?.displayName ?? firebaseUser.displayName ?? 'Owner',
      title: localRoom.title,
      roomType: localRoom.type === 'direct' ? 'direct' : 'group',
      wrappedRoomKeyB64: roomKeyB64,
      disappearingSeconds: localRoom.disappearingTtlSeconds ?? 0,
      syncedFromLocalRoomId: localRoom.id,
    });
    setActiveRoomId(roomId);
    setActionNotice(`Synced "${localRoom.title}" metadata to Firestore chatRooms collection.`);
  }

  async function handleInvitePeer(peer: CloudPublicNode) {
    if (!firebaseUser || !activeRoom) return;
    if (activeRoom.ownerId !== firebaseUser.uid) {
      setActionNotice('Only the room owner can invite additional peers.');
      return;
    }
    if (activeRoom.participantUids.includes(peer.uid)) {
      setActionNotice(`@${peer.username} is already in ${activeRoom.title}.`);
      return;
    }
    const keyToShare = activeMembership?.wrappedRoomKeyB64 || generateCloudRoomKeyB64();
    await invitePeerToCloudRoom({
      roomId: activeRoom.id,
      roomTitle: activeRoom.title,
      currentParticipantUids: activeRoom.participantUids,
      peerUid: peer.uid,
      wrappedRoomKeyB64: keyToShare,
    });
    setActionNotice(`Invited @${peer.username} into ${activeRoom.title}.`);
  }

  async function handleSendCloudMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!firebaseUser || !activeRoom || !composerText.trim()) return;
    setSendingMsg(true);
    try {
      const customPass = passphraseByRoom[activeRoom.id]?.trim();
      const keyB64 = activeMembership?.wrappedRoomKeyB64;
      let aesKey: CryptoKey;
      if (customPass) {
        aesKey = await deriveCloudKeyFromPassphrase(activeRoom.id, customPass);
      } else if (keyB64) {
        aesKey = await importCloudRoomKeyB64(keyB64);
      } else {
        throw new Error('Missing room encryption key. Set a passphrase or recreate room.');
      }

      const { ciphertextB64, ivB64 } = await encryptCloudMessage(aesKey, composerText.trim());
      await sendEncryptedCloudMessage({
        roomId: activeRoom.id,
        senderUid: firebaseUser.uid,
        senderName: syncedIdentity?.displayName ?? firebaseUser.displayName ?? 'Node',
        participantUids: activeRoom.participantUids,
        kind: 'text',
        ciphertextB64,
        ivB64,
      });

      setComposerText('');
      if (syncedIdentity && sharePresence) {
        updateCloudPresence({
          uid: firebaseUser.uid,
          username: syncedIdentity.username,
          status: presenceStatus,
          sharePresence,
          typingRoomId: '',
        }).catch(() => {});
      }
    } finally {
      setSendingMsg(false);
    }
  }

  async function handlePublishStory(e: React.FormEvent) {
    e.preventDefault();
    if (!firebaseUser || !syncedIdentity || !storyText.trim()) return;
    await publishCloudStory({
      authorUid: firebaseUser.uid,
      authorUsername: syncedIdentity.username,
      text: storyText,
      theme: storyTheme,
      visibility: 'friends_or_public',
    });
    setStoryText('');
    setActionNotice('Real-time story published to connected nodes.');
  }

  async function handleTogglePresencePrivacy(nextShare: boolean, nextStatus: 'online' | 'away' | 'hidden') {
    setSharePresence(nextShare);
    setPresenceStatus(nextStatus);
    if (!firebaseUser || !syncedIdentity) return;
    await updateCloudPresence({
      uid: firebaseUser.uid,
      username: syncedIdentity.username,
      status: nextShare ? nextStatus : 'hidden',
      sharePresence: nextShare,
      typingRoomId: '',
    });
  }

  async function handleToggleDiscovery(nextDiscoverable: boolean, nextNearby: boolean) {
    setDiscoverable(nextDiscoverable);
    setNearbyOptIn(nextNearby);
    if (!firebaseUser || !syncedIdentity) return;
    await updateCloudDiscoverySettings({
      uid: firebaseUser.uid,
      username: syncedIdentity.username,
      displayName: syncedIdentity.displayName,
      discoverable: nextDiscoverable,
      nearbyOptIn: nextNearby,
    });
  }

  const typingPeers = useMemo(() => {
    if (!activeRoomId || !firebaseUser) return [];
    return presenceList.filter(
      (p) => p.uid !== firebaseUser.uid && p.sharePresence && p.typingRoomId === activeRoomId
    );
  }, [presenceList, activeRoomId, firebaseUser]);

  if (!authReady) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-zinc-500">
        Initializing Firebase Real-Time Bridge...
      </div>
    );
  }

  if (!firebaseUser) {
    return (
      <div className="h-full overflow-y-auto p-6 flex items-center justify-center">
        <div className="w-full max-w-xl rounded-2xl rr-glass border border-zinc-200 dark:border-zinc-800 p-7 space-y-6 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-purple-600/15 border border-purple-500/40 flex items-center justify-center text-purple-500">
                <Cloud className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">Firebase Cloud Sync &amp; Real-Time</h1>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Firestore DB <code className="text-purple-500">{firebaseConfig.firestoreDatabaseId}</code> ·{' '}
                  <code className="text-purple-500">chatRooms</code> sync
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={recheckConnection}
              className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-[11px] font-medium flex items-center gap-1.5 hover:border-purple-500/60"
            >
              <Radio
                className={`w-3.5 h-3.5 ${
                  connectionStatus === 'connected'
                    ? 'text-emerald-500'
                    : connectionStatus === 'checking'
                      ? 'text-amber-500'
                      : 'text-red-500'
                }`}
              />
              <span className="capitalize">{connectionStatus}</span>
            </button>
          </div>

          <div className="grid sm:grid-cols-3 gap-3 text-xs">
            <div className="p-3.5 rounded-xl bg-zinc-100/80 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-800 space-y-1">
              <div className="font-semibold flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
                <Lock className="w-3.5 h-3.5" />
                Zero Plaintext
              </div>
              <p className="text-zinc-500 dark:text-zinc-400">
                Messages are encrypted with AES-256-GCM in your browser before Firestore stores ciphertext.
              </p>
            </div>
            <div className="p-3.5 rounded-xl bg-zinc-100/80 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-800 space-y-1">
              <div className="font-semibold flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
                <Database className="w-3.5 h-3.5" />
                chatRooms Metadata
              </div>
              <p className="text-zinc-500 dark:text-zinc-400">
                Live synchronized chat metadata, participant lists, and counters stored in <code className="text-purple-400">chatRooms</code>.
              </p>
            </div>
            <div className="p-3.5 rounded-xl bg-zinc-100/80 dark:bg-zinc-900/70 border border-zinc-200 dark:border-zinc-800 space-y-1">
              <div className="font-semibold flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
                <ShieldCheck className="w-3.5 h-3.5" />
                Rules Enforced
              </div>
              <p className="text-zinc-500 dark:text-zinc-400">
                Verified Google Auth UID membership gates every room, message, and private PII node.
              </p>
            </div>
          </div>

          {authError && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/40 text-xs text-red-500">
              {authError}
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
            <div className="text-[11px] text-zinc-500">
              Local RRchat 1 node:{' '}
              <span className="font-mono text-zinc-700 dark:text-zinc-300">
                @{localUser?.username ?? 'guest'}
              </span>
            </div>
            <button
              type="button"
              disabled={authBusy}
              onClick={signInWithGoogle}
              className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-60 text-white text-xs font-semibold flex items-center justify-center gap-2 shadow-lg shadow-purple-600/20"
            >
              <Cloud className="w-4 h-4" />
              {authBusy ? 'Connecting Google Auth...' : 'Connect Google Account for Real-Time Cloud Sync'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Top Firebase Session & Privacy Controls Bar */}
      <header className="px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800 rr-glass-strong flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-purple-600/15 border border-purple-500/40 flex items-center justify-center text-purple-500 shrink-0">
            <Cloud className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold truncate">Firebase Real-Time Cloud Sync</h1>
              <span className="text-[11px] font-mono text-emerald-500 flex items-center gap-1">
                <Radio className="w-3 h-3" />
                {syncBusy ? 'Syncing...' : connectionStatus === 'connected' ? 'Live' : connectionStatus}
              </span>
            </div>
            <p className="text-[11px] text-zinc-500 truncate">
              @{syncedIdentity?.username ?? 'syncing'} · {firebaseUser.email}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={sharePresence ? presenceStatus : 'hidden'}
            onChange={(e) => {
              const v = e.target.value as 'online' | 'away' | 'hidden';
              handleTogglePresencePrivacy(v !== 'hidden', v);
            }}
            className="px-2.5 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs"
            aria-label="Real-time presence status"
          >
            <option value="online">Presence: Online</option>
            <option value="away">Presence: Away</option>
            <option value="hidden">Presence: Hidden</option>
          </select>

          <button
            type="button"
            onClick={() => handleToggleDiscovery(!discoverable, nearbyOptIn)}
            className={`px-2.5 py-1.5 rounded-lg border text-xs flex items-center gap-1.5 ${
              discoverable
                ? 'border-purple-500/50 bg-purple-500/10 text-purple-600 dark:text-purple-300'
                : 'border-zinc-200 dark:border-zinc-800 text-zinc-500'
            }`}
          >
            {discoverable ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {discoverable ? 'Discoverable' : 'Unlisted'}
          </button>

          <button
            type="button"
            onClick={() => handleToggleDiscovery(discoverable, !nearbyOptIn)}
            className={`px-2.5 py-1.5 rounded-lg border text-xs flex items-center gap-1.5 ${
              nearbyOptIn
                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                : 'border-zinc-200 dark:border-zinc-800 text-zinc-500'
            }`}
          >
            <Compass className="w-3.5 h-3.5" />
            {nearbyOptIn ? 'Nearby On' : 'Nearby Off'}
          </button>

          <button
            type="button"
            onClick={signOutFirebase}
            className="px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-300 hover:border-red-500/50 flex items-center gap-1.5"
          >
            <LogOut className="w-3.5 h-3.5" />
            Disconnect
          </button>
        </div>
      </header>

      {actionNotice && (
        <div className="px-5 py-2 bg-purple-600/10 border-b border-purple-500/30 text-xs text-purple-600 dark:text-purple-300 flex items-center justify-between shrink-0">
          <span>{actionNotice}</span>
          <button type="button" onClick={() => setActionNotice(null)} className="underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Main 3-Panel Real-Time Grid */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
        {/* Left Rail: Synchronized chatRooms Metadata + Local Sync + Discoverable Nodes & Live Presence */}
        <aside className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-zinc-200 dark:border-zinc-800 flex flex-col min-h-0 overflow-y-auto p-4 space-y-5">
          {/* Create Cloud Room */}
          <form onSubmit={handleCreateRoom} className="rounded-2xl rr-glass border border-zinc-200 dark:border-zinc-800 p-3.5 space-y-2.5">
            <div className="text-xs font-semibold flex items-center justify-between">
              <span>Create Real-Time Encrypted Room</span>
              <select
                value={newRoomType}
                onChange={(e) => setNewRoomType(e.target.value as 'direct' | 'group')}
                className="text-[11px] bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-2 py-0.5"
              >
                <option value="group">Group</option>
                <option value="direct">Direct</option>
              </select>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newRoomTitle}
                onChange={(e) => setNewRoomTitle(e.target.value)}
                placeholder="Room name (e.g. Ops Vault)"
                maxLength={80}
                className="flex-1 min-w-0 px-3 py-1.5 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
              />
              <button
                type="submit"
                className="px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1 shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Create
              </button>
            </div>
          </form>

          {/* Synchronized chatRooms Metadata Collection */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-purple-500" />
                chatRooms Metadata ({chatRoomsMeta.length})
              </span>
            </div>
            {chatRoomsMeta.length === 0 && roomLinks.length === 0 ? (
              <p className="text-xs text-zinc-500 p-3 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-800">
                No synchronized rooms in <code className="text-purple-500">chatRooms</code> yet. Create one above or sync a local room below.
              </p>
            ) : (
              <div className="space-y-1.5">
                {(chatRoomsMeta.length > 0 ? chatRoomsMeta : roomLinks.map((l) => ({
                  id: l.roomId,
                  title: l.title,
                  roomType: 'group' as const,
                  ownerId: l.uid,
                  participantUids: [l.uid],
                  messageCount: 0,
                  lastMessagePreview: `Role: ${l.role}`,
                  updatedAt: l.updatedAt,
                }))).map((meta) => {
                  const selected = meta.id === activeRoomId;
                  return (
                    <button
                      key={meta.id}
                      type="button"
                      onClick={() => setActiveRoomId(meta.id)}
                      className={`w-full text-left px-3.5 py-2.5 rounded-xl border transition-colors space-y-1 ${
                        selected
                          ? 'bg-purple-600 text-white border-purple-500 shadow-sm'
                          : 'rr-glass border-zinc-200 dark:border-zinc-800 hover:border-purple-500/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold truncate">{meta.title}</span>
                        <span className={`text-[10px] font-mono tabular-nums ${selected ? 'text-purple-100' : 'text-zinc-500'}`}>
                          {meta.messageCount} msgs · {meta.participantUids.length} peers
                        </span>
                      </div>
                      <div className={`flex items-center justify-between gap-2 text-[11px] ${selected ? 'text-purple-100' : 'text-zinc-500'}`}>
                        <span className="truncate">{meta.lastMessagePreview || 'Encrypted room'}</span>
                        <span className="font-mono shrink-0 tabular-nums">{formatTimestamp(meta.updatedAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Sync Local RRchat Rooms Metadata into Firestore chatRooms */}
          {localRooms.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5" />
                Sync Local Rooms to chatRooms
              </div>
              <div className="space-y-1.5">
                {localRooms.slice(0, 6).map((lr) => {
                  const alreadySynced = chatRoomsMeta.some((c) => c.syncedFromLocalRoomId === lr.id);
                  return (
                    <div
                      key={lr.id}
                      className="p-2.5 rounded-xl rr-glass border border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">{lr.title}</div>
                        <div className="text-[10px] font-mono text-zinc-500">
                          {lr.type} · {lr.messageCount} local msgs
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSyncLocalRoomMetadata(lr)}
                        className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium shrink-0 ${
                          alreadySynced
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                            : 'border-purple-500/40 bg-purple-600/15 hover:bg-purple-600/25 text-purple-600 dark:text-purple-300'
                        }`}
                      >
                        {alreadySynced ? 'Synced' : 'Sync Meta'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Live Online Presence & Discoverable Nodes */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              Live Nodes &amp; Presence ({publicNodes.length})
            </div>
            <div className="space-y-1.5">
              {publicNodes.map((node) => {
                const livePresence = presenceList.find((p) => p.uid === node.uid);
                const isSelf = node.uid === firebaseUser.uid;
                const alreadyInRoom = activeRoom?.participantUids.includes(node.uid);
                return (
                  <div
                    key={node.uid}
                    className="p-2.5 rounded-xl rr-glass border border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            livePresence?.status === 'online'
                              ? 'bg-emerald-500'
                              : livePresence?.status === 'away'
                                ? 'bg-amber-500'
                                : 'bg-zinc-500'
                          }`}
                        />
                        <span className="text-xs font-semibold truncate">{node.displayName}</span>
                        {isSelf && <span className="text-[10px] font-mono text-purple-500">(you)</span>}
                      </div>
                      <div className="text-[11px] font-mono text-zinc-500 truncate">
                        @{node.username}
                        {node.nearbyOptIn ? ' · Nearby' : ''}
                      </div>
                    </div>
                    {!isSelf && activeRoom && activeRoom.ownerId === firebaseUser.uid && !alreadyInRoom && (
                      <button
                        type="button"
                        onClick={() => handleInvitePeer(node)}
                        className="px-2.5 py-1 rounded-lg bg-purple-600/15 hover:bg-purple-600/25 border border-purple-500/40 text-[11px] font-medium text-purple-600 dark:text-purple-300 flex items-center gap-1 shrink-0"
                      >
                        <UserPlus className="w-3 h-3" />
                        Invite
                      </button>
                    )}
                    {alreadyInRoom && !isSelf && (
                      <span className="text-[10px] font-mono text-emerald-500 shrink-0">In Room</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Center/Right: Live E2EE Room Messages + Real-Time 24h Stories */}
        <section className="lg:col-span-8 flex flex-col min-h-0 overflow-hidden">
          {/* Real-Time Cloud Stories Strip */}
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 space-y-2.5 shrink-0">
            <form onSubmit={handlePublishStory} className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-purple-600 dark:text-purple-400 shrink-0">
                <Sparkles className="w-3.5 h-3.5" />
                Live Stories
              </div>
              <input
                type="text"
                value={storyText}
                onChange={(e) => setStoryText(e.target.value)}
                maxLength={280}
                placeholder="Broadcast a real-time 24h cloud story..."
                className="flex-1 min-w-[180px] px-3 py-1.5 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
              />
              <select
                value={storyTheme}
                onChange={(e) => setStoryTheme(e.target.value as CloudStoryDoc['theme'])}
                className="px-2.5 py-1.5 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs"
              >
                <option value="obsidian_purple">Obsidian Purple</option>
                <option value="chrome_silver">Chrome Silver</option>
                <option value="neon_violet">Neon Violet</option>
              </select>
              <button
                type="submit"
                disabled={!storyText.trim()}
                className="px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold"
              >
                Post Story
              </button>
            </form>

            {stories.length > 0 && (
              <div className="flex gap-2.5 overflow-x-auto pb-1">
                {stories.map((story) => (
                  <div
                    key={story.id}
                    className={`min-w-[210px] max-w-[250px] p-2.5 rounded-xl border bg-gradient-to-br shrink-0 space-y-1 ${STORY_THEMES[story.theme]}`}
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] font-mono opacity-80">
                      <span className="truncate">@{story.authorUsername}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="tabular-nums">{formatTimestamp(story.createdAt)}</span>
                        {story.authorUid === firebaseUser.uid && (
                          <button
                            type="button"
                            onClick={() => deleteCloudStory(story.id)}
                            className="hover:text-red-400"
                            title="Delete story"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-xs leading-snug break-words">{story.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Active Encrypted Cloud Room Chat Area */}
          {!activeRoom ? (
            <div className="flex-1 flex items-center justify-center p-6 text-center text-xs text-zinc-500">
              Select or create a Cloud Room to exchange real-time end-to-end encrypted Firestore messages.
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Active Room Header & Optional Passphrase Override */}
              <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2 shrink-0">
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{activeRoom.title}</div>
                  <div className="text-[11px] font-mono text-zinc-500">
                    {activeRoom.participantUids.length} participant(s) · AES-256-GCM · chatRooms synced
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                    <KeyRound className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                    <input
                      type="password"
                      value={passphraseByRoom[activeRoom.id] ?? ''}
                      onChange={(e) =>
                        setPassphraseByRoom((prev) => ({ ...prev, [activeRoom.id]: e.target.value }))
                      }
                      placeholder="Optional Zero-Knowledge Passphrase"
                      className="bg-transparent text-[11px] w-44 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Messages Feed */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {decryptedMessages.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-xs text-zinc-500">
                    No messages in this cloud room yet. Send the first AES-256-GCM encrypted message below.
                  </div>
                ) : (
                  decryptedMessages.map(({ raw, plaintext, decryptError }) => {
                    const isMine = raw.senderUid === firebaseUser.uid;
                    return (
                      <div key={raw.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 border rr-3d-bubble space-y-1 ${
                            raw.recalled
                              ? 'bg-zinc-200/60 dark:bg-zinc-900/60 border-zinc-300 dark:border-zinc-800 text-zinc-500 italic'
                              : isMine
                                ? 'bg-purple-600 text-white border-purple-500'
                                : 'rr-glass border-zinc-200 dark:border-zinc-800'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3 text-[10px] opacity-80">
                            <span className="font-semibold">{raw.senderName ?? 'Node'}</span>
                            <span className="font-mono tabular-nums">{formatTimestamp(raw.createdAt)}</span>
                          </div>
                          <p className={`text-xs leading-relaxed break-words ${decryptError ? 'text-amber-300 font-mono' : ''}`}>
                            {plaintext}
                          </p>
                          {isMine && !raw.recalled && (
                            <div className="flex justify-end pt-0.5">
                              <button
                                type="button"
                                onClick={() => recallCloudMessage(activeRoom.id, raw.id)}
                                className="text-[10px] opacity-75 hover:opacity-100 flex items-center gap-1"
                              >
                                <RotateCcw className="w-2.5 h-2.5" />
                                Recall
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Typing Indicator + Encrypted Composer */}
              <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 space-y-1.5 shrink-0">
                {typingPeers.length > 0 && (
                  <div className="text-[11px] font-mono text-purple-500">
                    {typingPeers.map((p) => `@${p.username}`).join(', ')} typing in real time...
                  </div>
                )}
                <form onSubmit={handleSendCloudMessage} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={composerText}
                    onChange={(e) => handleTypingChange(e.target.value)}
                    placeholder="Type an encrypted message (encrypted before Firestore write)..."
                    className="flex-1 px-3.5 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-xs focus:outline-none focus:border-purple-500"
                  />
                  <button
                    type="submit"
                    disabled={sendingMsg || !composerText.trim()}
                    className="px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Send E2EE
                  </button>
                </form>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
