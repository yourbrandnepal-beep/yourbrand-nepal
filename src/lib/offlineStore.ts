import type { ChatRoomRecord, EncryptedMessageRecord, UserProfile } from './types';

const DB_NAME = 'rrchat1_offline_db';
const DB_VERSION = 1;
const STORE_SESSION = 'session_snapshots';
const STORE_ROOMS = 'room_metadata';
const STORE_MESSAGES = 'room_messages';
const FALLBACK_PREFIX = 'rrchat1_offline_v1_';
const MAX_CACHED_MESSAGES_PER_ROOM = 120;

export interface CachedSessionSnapshot {
  key: string; // `${username}:${deviceId}`
  username: string;
  deviceId: string;
  user: UserProfile;
  activeRoomId: string | null;
  vaultMode: boolean;
  updatedAt: number;
}

interface CachedRoomMetadataRecord {
  userId: string;
  rooms: ChatRoomRecord[];
  updatedAt: number;
}

interface CachedRoomMessagesRecord {
  key: string; // `${userId}:${roomId}`
  userId: string;
  roomId: string;
  messages: EncryptedMessageRecord[];
  updatedAt: number;
}

export interface OfflineCacheStats {
  cachedRoomCount: number;
  cachedMessageCount: number;
  lastSyncedAt: number | null;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openOfflineDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SESSION)) {
          db.createObjectStore(STORE_SESSION, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_ROOMS)) {
          db.createObjectStore(STORE_ROOMS, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'key' });
          msgStore.createIndex('by_userId', 'userId', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        resolve(null);
      };
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });

  return dbPromise;
}

function readLocalFallback<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`${FALLBACK_PREFIX}${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLocalFallback(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${FALLBACK_PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

function removeLocalFallback(key: string): void {
  try {
    localStorage.removeItem(`${FALLBACK_PREFIX}${key}`);
  } catch {
    // Ignore
  }
}

function runIdbRequest<T>(
  storeName: string,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openOfflineDb().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = op(store);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function saveSessionSnapshot(
  username: string,
  deviceId: string,
  payload: {
    user: UserProfile;
    activeRoomId: string | null;
    vaultMode: boolean;
  }
): Promise<void> {
  const key = `${username}:${deviceId}`;
  const record: CachedSessionSnapshot = {
    key,
    username,
    deviceId,
    user: payload.user,
    activeRoomId: payload.activeRoomId,
    vaultMode: payload.vaultMode,
    updatedAt: Date.now(),
  };
  writeLocalFallback(`session_${key}`, record);
  await runIdbRequest(STORE_SESSION, 'readwrite', (store) => store.put(record));
}

export async function loadSessionSnapshot(
  username: string,
  deviceId: string
): Promise<CachedSessionSnapshot | null> {
  const key = `${username}:${deviceId}`;
  const fromIdb = await runIdbRequest<CachedSessionSnapshot>(STORE_SESSION, 'readonly', (store) =>
    store.get(key)
  );
  if (fromIdb) return fromIdb;
  return readLocalFallback<CachedSessionSnapshot>(`session_${key}`);
}

export async function saveCachedRooms(userId: string, rooms: ChatRoomRecord[]): Promise<void> {
  const record: CachedRoomMetadataRecord = {
    userId,
    rooms,
    updatedAt: Date.now(),
  };
  writeLocalFallback(`rooms_${userId}`, record);
  await runIdbRequest(STORE_ROOMS, 'readwrite', (store) => store.put(record));
}

export async function loadCachedRooms(
  userId: string
): Promise<{ rooms: ChatRoomRecord[]; updatedAt: number | null }> {
  const fromIdb = await runIdbRequest<CachedRoomMetadataRecord>(STORE_ROOMS, 'readonly', (store) =>
    store.get(userId)
  );
  if (fromIdb) {
    return { rooms: fromIdb.rooms, updatedAt: fromIdb.updatedAt };
  }
  const fallback = readLocalFallback<CachedRoomMetadataRecord>(`rooms_${userId}`);
  return fallback ? { rooms: fallback.rooms, updatedAt: fallback.updatedAt } : { rooms: [], updatedAt: null };
}

export async function saveCachedRoomMessages(
  userId: string,
  roomId: string,
  messages: EncryptedMessageRecord[]
): Promise<void> {
  const trimmed = messages.slice(-MAX_CACHED_MESSAGES_PER_ROOM);
  const key = `${userId}:${roomId}`;
  const record: CachedRoomMessagesRecord = {
    key,
    userId,
    roomId,
    messages: trimmed,
    updatedAt: Date.now(),
  };
  writeLocalFallback(`msgs_${key}`, record);
  await runIdbRequest(STORE_MESSAGES, 'readwrite', (store) => store.put(record));
}

export async function loadAllCachedMessagesForUser(
  userId: string
): Promise<Record<string, EncryptedMessageRecord[]>> {
  const db = await openOfflineDb();
  if (db) {
    const records = await new Promise<CachedRoomMessagesRecord[]>((resolve) => {
      try {
        const tx = db.transaction(STORE_MESSAGES, 'readonly');
        const store = tx.objectStore(STORE_MESSAGES);
        const index = store.index('by_userId');
        const req = index.getAll(userId);
        req.onsuccess = () => resolve((req.result as CachedRoomMessagesRecord[]) ?? []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    if (records.length > 0) {
      const byRoom: Record<string, EncryptedMessageRecord[]> = {};
      for (const rec of records) {
        byRoom[rec.roomId] = rec.messages;
      }
      return byRoom;
    }
  }

  const fallbackMap: Record<string, EncryptedMessageRecord[]> = {};
  try {
    const prefix = `${FALLBACK_PREFIX}msgs_${userId}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) {
        const raw = localStorage.getItem(k);
        if (raw) {
          const parsed = JSON.parse(raw) as CachedRoomMessagesRecord;
          fallbackMap[parsed.roomId] = parsed.messages;
        }
      }
    }
  } catch {
    // Ignore
  }
  return fallbackMap;
}

export async function getOfflineCacheStats(userId: string): Promise<OfflineCacheStats> {
  const { rooms, updatedAt } = await loadCachedRooms(userId);
  const messagesByRoom = await loadAllCachedMessagesForUser(userId);
  const cachedMessageCount = Object.values(messagesByRoom).reduce((acc, list) => acc + list.length, 0);
  return {
    cachedRoomCount: rooms.length,
    cachedMessageCount,
    lastSyncedAt: updatedAt,
  };
}

export async function clearOfflineCacheForUser(
  userId?: string | null,
  username?: string | null,
  deviceId?: string | null
): Promise<void> {
  if (username && deviceId) {
    const sessionKey = `${username}:${deviceId}`;
    removeLocalFallback(`session_${sessionKey}`);
    await runIdbRequest(STORE_SESSION, 'readwrite', (store) => store.delete(sessionKey));
  }

  if (userId) {
    removeLocalFallback(`rooms_${userId}`);
    await runIdbRequest(STORE_ROOMS, 'readwrite', (store) => store.delete(userId));

    try {
      const prefix = `${FALLBACK_PREFIX}msgs_${userId}:`;
      const keysToDelete: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keysToDelete.push(k);
      }
      keysToDelete.forEach((k) => localStorage.removeItem(k));
    } catch {
      // Ignore
    }

    const db = await openOfflineDb();
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE_MESSAGES, 'readwrite');
          const store = tx.objectStore(STORE_MESSAGES);
          const index = store.index('by_userId');
          const req = index.getAllKeys(userId);
          req.onsuccess = () => {
            const keys = req.result ?? [];
            for (const key of keys) {
              store.delete(key);
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }
  }
}
