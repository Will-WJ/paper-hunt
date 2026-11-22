// 轻量存储层
// - 大块缓存（原始 API 响应）走 IndexedDB
// - 小状态（已读/收藏/关键词）走 localStorage
// 两者都带内存兜底，便于在 Node 里跑测试

const DB_NAME = 'paperhunt';
const DB_VERSION = 1;
const STORE = 'kv';

const hasIDB = typeof indexedDB !== 'undefined';
const hasLS = typeof localStorage !== 'undefined';

const memCache = new Map();
const memState = new Map();

let dbPromise = null;

function openDB() {
  if (!hasIDB) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const os = t.objectStore(STORE);
    let result;
    try {
      result = fn(os);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** 读缓存，返回 { ts, data } 或 null */
export async function cacheGet(key) {
  const db = await openDB();
  if (!db) return memCache.get(key) ?? null;
  try {
    const val = await tx(db, 'readonly', (os) => ({ __req: os.get(key) }));
    return val ?? null;
  } catch {
    return memCache.get(key) ?? null;
  }
}

/** 写缓存 */
export async function cacheSet(key, data) {
  const rec = { ts: Date.now(), data };
  memCache.set(key, rec);
  const db = await openDB();
  if (!db) return;
  try {
    await tx(db, 'readwrite', (os) => os.put(rec, key));
  } catch {
    /* 存不进就算了，内存里还有 */
  }
}

export async function cacheClear() {
  memCache.clear();
  const db = await openDB();
  if (!db) return;
  try {
    await tx(db, 'readwrite', (os) => os.clear());
  } catch {
    /* ignore */
  }
}

/** 带 TTL 的读取：过期返回 null */
export async function cacheGetFresh(key, ttl) {
  const rec = await cacheGet(key);
  if (!rec) return null;
  if (!Number.isFinite(ttl)) return rec.data;
  if (Date.now() - rec.ts > ttl) return null;
  return rec.data;
}

// ---------- 小状态 ----------
export function stateGet(key, fallback) {
  try {
    if (hasLS) {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    }
  } catch {
    /* 损坏就回退 */
  }
  return memState.has(key) ? memState.get(key) : fallback;
}

export function stateSet(key, value) {
  memState.set(key, value);
  try {
    if (hasLS) localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满等情况忽略 */
  }
}
