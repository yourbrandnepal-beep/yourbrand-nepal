import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  increment,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: Array<{
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) ?? [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(
  firestoreInstance = db
): Promise<'connected' | 'offline' | 'error'> {
  try {
    await getDocFromServer(doc(firestoreInstance, 'test', 'connection'));
    return 'connected';
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return 'offline';
    }
    return 'error';
  }
}

// --- Blueprint Validation & Sanitizers (Synced with firebase-blueprint.json & firestore.rules) ---

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_USERNAME_REGEX = /^[a-zA-Z0-9_.]{3,32}$/;

export function isValidDocId(id: string): boolean {
  return VALID_ID_REGEX.test(id);
}

export function sanitizeUsername(raw: string | null | undefined, fallbackUid: string): string {
  const cleaned = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28);
  if (cleaned.length >= 3 && VALID_USERNAME_REGEX.test(cleaned)) {
    return cleaned;
  }
  const suffix = fallbackUid.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 10) || 'node';
  return `rr_${suffix}`.slice(0, 32);
}

export function sanitizeDisplayName(raw: string | null | undefined, fallback = 'RRchat Node'): string {
  const trimmed = (raw ?? '').trim().slice(0, 64);
  return trimmed.length > 0 ? trimmed : fallback;
}

export function generateFirestoreId(prefix: string): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'id';
  const randBytes = new Uint8Array(9);
  crypto.getRandomValues(randBytes);
  const hex = Array.from(randBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${safePrefix}_${Date.now()}_${hex}`.slice(0, 64);
}

// --- Cloud AES-256-GCM Encryption Helpers (Zero Plaintext in Firestore) ---

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function generateCloudRoomKeyB64(): string {
  const bytes = new Uint8Array(new ArrayBuffer(32));
  crypto.getRandomValues(bytes);
  return bytesToB64(bytes);
}

export async function deriveCloudKeyFromPassphrase(roomId: string, passphrase: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(`RRchat1-CloudRoom-${roomId}`),
      iterations: 150000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function importCloudRoomKeyB64(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptCloudMessage(
  aesKey: CryptoKey,
  plaintext: string
): Promise<{ ciphertextB64: string; ivB64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);
  return {
    ciphertextB64: bytesToB64(new Uint8Array(cipher)),
    ivB64: bytesToB64(iv),
  };
}

export async function decryptCloudMessage(
  aesKey: CryptoKey,
  ciphertextB64: string,
  ivB64: string
): Promise<string> {
  const iv = b64ToBytes(ivB64);
  const cipher = base64ToBytesSafe(ciphertextB64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
  return new TextDecoder().decode(plain);
}

function base64ToBytesSafe(b64: string): Uint8Array<ArrayBuffer> {
  return b64ToBytes(b64);
}

// --- Typed Firestore Models ---

export interface CloudUserRoomLink {
  uid: string;
  roomId: string;
  title: string;
  role: 'owner' | 'member';
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface ChatRoomMetadataDoc {
  id: string;
  title: string;
  roomType: 'direct' | 'group';
  ownerId: string;
  participantUids: string[];
  lastMessagePreview?: string;
  lastSenderName?: string;
  messageCount: number;
  disappearingSeconds?: number;
  syncedFromLocalRoomId?: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface CloudPublicNode {
  uid: string;
  username: string;
  displayName: string;
  badge?: string;
  ecdhFingerprint?: string;
  discoverable: boolean;
  nearbyOptIn?: boolean;
  nearbyZone?: string;
  updatedAt?: Timestamp | null;
}

export interface CloudPresence {
  uid: string;
  username: string;
  status: 'online' | 'away' | 'hidden';
  sharePresence: boolean;
  typingRoomId?: string;
  lastActiveAt?: Timestamp | null;
}

export interface CloudRoomDoc {
  id: string;
  title: string;
  roomType: 'direct' | 'group';
  ownerId: string;
  participantUids: string[];
  disappearingSeconds?: number;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface CloudRoomMemberDoc {
  uid: string;
  roomId: string;
  role: 'owner' | 'member';
  wrappedRoomKeyB64?: string;
  joinedAt?: Timestamp | null;
}

export interface CloudMessageDoc {
  id: string;
  roomId: string;
  senderUid: string;
  senderName?: string;
  kind: 'text' | 'sticker' | 'signal';
  ciphertextB64: string;
  ivB64: string;
  participantUids: string[];
  recalled: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface CloudStoryDoc {
  id: string;
  authorUid: string;
  authorUsername: string;
  text: string;
  theme: 'obsidian_purple' | 'chrome_silver' | 'neon_violet';
  visibility: 'friends_or_public' | 'private';
  createdAt?: Timestamp | null;
}

// --- Firestore Write Operations ---

export async function syncFirebaseUserRecords(
  fbUser: FirebaseUser,
  opts: {
    preferredUsername?: string;
    preferredDisplayName?: string;
    badge?: string;
    ecdhFingerprint?: string;
    discoverable?: boolean;
    sharePresence?: boolean;
    nearbyOptIn?: boolean;
  }
): Promise<{ username: string; displayName: string }> {
  const uid = fbUser.uid;
  if (!isValidDocId(uid)) {
    throw new Error('Invalid Firebase UID format.');
  }
  const email = (fbUser.email ?? '').trim().slice(0, 160);
  if (!email) {
    throw new Error('Verified Google email is required for Firestore synchronization.');
  }

  const emailLocal = email.split('@')[0];
  const username = sanitizeUsername(opts.preferredUsername || emailLocal, uid);
  const displayName = sanitizeDisplayName(opts.preferredDisplayName || fbUser.displayName || username);
  const discoverable = opts.discoverable ?? true;
  const sharePresence = opts.sharePresence ?? true;
  const nearbyOptIn = opts.nearbyOptIn ?? false;

  const userRef = doc(db, 'users', uid);
  const publicRef = doc(db, 'publicNodes', uid);
  const presenceRef = doc(db, 'presence', uid);

  let userExists = false;
  let publicExists = false;
  let presenceExists = false;
  try {
    const [uSnap, pSnap, prSnap] = await Promise.all([
      getDoc(userRef),
      getDoc(publicRef),
      getDoc(presenceRef),
    ]);
    userExists = uSnap.exists();
    publicExists = pSnap.exists();
    presenceExists = prSnap.exists();
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `users/${uid}`);
  }

  const batch = writeBatch(db);

  if (userExists) {
    batch.update(userRef, {
      username,
      displayName,
      nearbyOptIn,
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.set(userRef, {
      uid,
      username,
      displayName,
      email,
      nearbyOptIn,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const publicPayload = {
    uid,
    username,
    displayName,
    badge: (opts.badge ?? 'verified').slice(0, 32),
    ecdhFingerprint: (opts.ecdhFingerprint ?? '').slice(0, 128),
    discoverable,
    nearbyOptIn,
    nearbyZone: nearbyOptIn ? 'Encrypted Local Mesh' : '',
    updatedAt: serverTimestamp(),
  };

  if (publicExists) {
    batch.update(publicRef, {
      username: publicPayload.username,
      displayName: publicPayload.displayName,
      badge: publicPayload.badge,
      ecdhFingerprint: publicPayload.ecdhFingerprint,
      discoverable: publicPayload.discoverable,
      nearbyOptIn: publicPayload.nearbyOptIn,
      nearbyZone: publicPayload.nearbyZone,
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.set(publicRef, publicPayload);
  }

  const presenceStatus: 'online' | 'hidden' = sharePresence ? 'online' : 'hidden';
  if (presenceExists) {
    batch.update(presenceRef, {
      username,
      status: presenceStatus,
      sharePresence,
      typingRoomId: '',
      lastActiveAt: serverTimestamp(),
    });
  } else {
    batch.set(presenceRef, {
      uid,
      username,
      status: presenceStatus,
      sharePresence,
      typingRoomId: '',
      lastActiveAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${uid}`);
  }

  return { username, displayName };
}

export async function updateCloudPresence(params: {
  uid: string;
  username: string;
  status: 'online' | 'away' | 'hidden';
  sharePresence: boolean;
  typingRoomId?: string;
}): Promise<void> {
  const path = `presence/${params.uid}`;
  try {
    await updateDoc(doc(db, 'presence', params.uid), {
      username: sanitizeUsername(params.username, params.uid),
      status: params.status,
      sharePresence: params.sharePresence,
      typingRoomId: (params.typingRoomId ?? '').slice(0, 128),
      lastActiveAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateCloudDiscoverySettings(params: {
  uid: string;
  username: string;
  displayName: string;
  discoverable: boolean;
  nearbyOptIn: boolean;
}): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, 'users', params.uid), {
    nearbyOptIn: params.nearbyOptIn,
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(db, 'publicNodes', params.uid), {
    username: sanitizeUsername(params.username, params.uid),
    displayName: sanitizeDisplayName(params.displayName),
    discoverable: params.discoverable,
    nearbyOptIn: params.nearbyOptIn,
    nearbyZone: params.nearbyOptIn ? 'Encrypted Local Mesh' : '',
    updatedAt: serverTimestamp(),
  });
  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `publicNodes/${params.uid}`);
  }
}

export async function createCloudRoom(params: {
  ownerUid: string;
  ownerDisplayName?: string;
  title: string;
  roomType: 'direct' | 'group';
  wrappedRoomKeyB64: string;
  disappearingSeconds?: number;
  syncedFromLocalRoomId?: string;
}): Promise<string> {
  const roomId = generateFirestoreId('room');
  const cleanTitle = params.title.trim().slice(0, 80) || 'Encrypted Cloud Room';
  const cleanSenderName = sanitizeDisplayName(params.ownerDisplayName, 'Owner');
  const disappearing = Math.max(0, Math.min(86400, Math.floor(params.disappearingSeconds ?? 0)));
  const batch = writeBatch(db);

  batch.set(doc(db, 'rooms', roomId), {
    id: roomId,
    title: cleanTitle,
    roomType: params.roomType,
    ownerId: params.ownerUid,
    participantUids: [params.ownerUid],
    disappearingSeconds: disappearing,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'chatRooms', roomId), {
    id: roomId,
    title: cleanTitle,
    roomType: params.roomType,
    ownerId: params.ownerUid,
    participantUids: [params.ownerUid],
    lastMessagePreview: 'AES-256-GCM cloud room ready',
    lastSenderName: cleanSenderName,
    messageCount: 0,
    disappearingSeconds: disappearing,
    syncedFromLocalRoomId: (params.syncedFromLocalRoomId ?? '').slice(0, 128),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'rooms', roomId, 'members', params.ownerUid), {
    uid: params.ownerUid,
    roomId,
    role: 'owner',
    wrappedRoomKeyB64: params.wrappedRoomKeyB64.slice(0, 2048),
    joinedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'users', params.ownerUid, 'roomLinks', roomId), {
    uid: params.ownerUid,
    roomId,
    title: cleanTitle,
    role: 'owner',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `chatRooms/${roomId}`);
  }
  return roomId;
}

export async function invitePeerToCloudRoom(params: {
  roomId: string;
  roomTitle: string;
  currentParticipantUids: string[];
  peerUid: string;
  wrappedRoomKeyB64: string;
}): Promise<void> {
  if (!isValidDocId(params.roomId) || !isValidDocId(params.peerUid)) {
    throw new Error('Invalid room or peer identifier.');
  }
  const nextParticipants = Array.from(new Set([...params.currentParticipantUids, params.peerUid])).slice(0, 25);

  let chatRoomMetaExists = false;
  try {
    const metaSnap = await getDoc(doc(db, 'chatRooms', params.roomId));
    chatRoomMetaExists = metaSnap.exists();
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `chatRooms/${params.roomId}`);
  }

  const batch = writeBatch(db);

  batch.update(doc(db, 'rooms', params.roomId), {
    participantUids: nextParticipants,
    updatedAt: serverTimestamp(),
  });

  if (chatRoomMetaExists) {
    batch.update(doc(db, 'chatRooms', params.roomId), {
      participantUids: nextParticipants,
      updatedAt: serverTimestamp(),
    });
  }

  batch.set(doc(db, 'rooms', params.roomId, 'members', params.peerUid), {
    uid: params.peerUid,
    roomId: params.roomId,
    role: 'member',
    wrappedRoomKeyB64: params.wrappedRoomKeyB64.slice(0, 2048),
    joinedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'users', params.peerUid, 'roomLinks', params.roomId), {
    uid: params.peerUid,
    roomId: params.roomId,
    title: params.roomTitle.trim().slice(0, 80) || 'Encrypted Cloud Room',
    role: 'member',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `rooms/${params.roomId}/members/${params.peerUid}`);
  }
}

export async function sendEncryptedCloudMessage(params: {
  roomId: string;
  senderUid: string;
  senderName: string;
  participantUids: string[];
  kind: 'text' | 'sticker' | 'signal';
  ciphertextB64: string;
  ivB64: string;
}): Promise<string> {
  const messageId = generateFirestoreId('msg');
  const path = `rooms/${params.roomId}/messages/${messageId}`;
  const participants = Array.from(new Set([params.senderUid, ...params.participantUids])).slice(0, 25);
  const cleanSenderName = sanitizeDisplayName(params.senderName, 'Node');

  let chatRoomMetaExists = false;
  try {
    const metaSnap = await getDoc(doc(db, 'chatRooms', params.roomId));
    chatRoomMetaExists = metaSnap.exists();
  } catch {
    chatRoomMetaExists = false;
  }

  const batch = writeBatch(db);
  batch.set(doc(db, 'rooms', params.roomId, 'messages', messageId), {
    id: messageId,
    roomId: params.roomId,
    senderUid: params.senderUid,
    senderName: cleanSenderName,
    kind: params.kind,
    ciphertextB64: params.ciphertextB64.slice(0, 32768),
    ivB64: params.ivB64.slice(0, 128),
    participantUids: participants,
    recalled: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (chatRoomMetaExists) {
    batch.update(doc(db, 'chatRooms', params.roomId), {
      lastMessagePreview: 'AES-256-GCM Encrypted Message',
      lastSenderName: cleanSenderName,
      messageCount: increment(1),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
  return messageId;
}

export async function recallCloudMessage(roomId: string, messageId: string): Promise<void> {
  const path = `rooms/${roomId}/messages/${messageId}`;
  let chatRoomMetaExists = false;
  try {
    const metaSnap = await getDoc(doc(db, 'chatRooms', roomId));
    chatRoomMetaExists = metaSnap.exists();
  } catch {
    chatRoomMetaExists = false;
  }

  const batch = writeBatch(db);
  batch.update(doc(db, 'rooms', roomId, 'messages', messageId), {
    recalled: true,
    ciphertextB64: '',
    ivB64: '',
    updatedAt: serverTimestamp(),
  });
  if (chatRoomMetaExists) {
    batch.update(doc(db, 'chatRooms', roomId), {
      lastMessagePreview: 'Message recalled by sender',
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function publishCloudStory(params: {
  authorUid: string;
  authorUsername: string;
  text: string;
  theme: 'obsidian_purple' | 'chrome_silver' | 'neon_violet';
  visibility: 'friends_or_public' | 'private';
}): Promise<string> {
  const storyId = generateFirestoreId('story');
  const path = `stories/${storyId}`;
  const cleanText = params.text.trim().slice(0, 280);
  if (!cleanText) {
    throw new Error('Story text cannot be empty.');
  }

  try {
    await setDoc(doc(db, 'stories', storyId), {
      id: storyId,
      authorUid: params.authorUid,
      authorUsername: sanitizeUsername(params.authorUsername, params.authorUid),
      text: cleanText,
      theme: params.theme,
      visibility: params.visibility,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
  return storyId;
}

export async function deleteCloudStory(storyId: string): Promise<void> {
  const path = `stories/${storyId}`;
  try {
    await deleteDoc(doc(db, 'stories', storyId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export { collection, doc };
