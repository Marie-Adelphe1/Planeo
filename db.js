// Stockage local (IndexedDB). Les données restent sur l'appareil.
const DB_NAME = 'planeo';
const DB_VERSION = 1;
export const STORES = ['projects', 'tasks', 'checkins'];
let dbPromise;
const listeners = new Set();

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export const onChange = fn => listeners.add(fn);
const emit = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });

export async function all(store) {
  const db = await open();
  return req(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, id) {
  const db = await open();
  return req(db.transaction(store).objectStore(store).get(id));
}

export async function put(store, obj, { silent = false } = {}) {
  obj.updatedAt = new Date().toISOString();
  if (!obj.createdAt) obj.createdAt = obj.updatedAt;
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).put(obj);
  await done(t);
  if (!silent) emit();
  return obj;
}

export async function putMany(store, items, { touch = true } = {}) {
  if (!items.length) return;
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  const now = new Date().toISOString();
  for (const o of items) {
    if (touch) { o.updatedAt = now; if (!o.createdAt) o.createdAt = now; }
    s.put(o);
  }
  await done(t);
  if (touch) emit();
}

export async function del(store, id) {
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).delete(id);
  await done(t);
  const tombs = await kvGet('tombstones', {});
  tombs[`${store}:${id}`] = new Date().toISOString();
  await kvSet('tombstones', tombs);
  emit();
}

export async function rawDelete(store, id) {
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).delete(id);
  await done(t);
}

export async function kvGet(key, fallback = null) {
  const db = await open();
  const r = await req(db.transaction('kv').objectStore('kv').get(key));
  return r ? r.value : fallback;
}

export async function kvSet(key, value) {
  const db = await open();
  const t = db.transaction('kv', 'readwrite');
  t.objectStore('kv').put({ key, value });
  await done(t);
}

export async function exportAll() {
  const out = { app: 'planeo', version: 1, exportedAt: new Date().toISOString(), tombstones: await kvGet('tombstones', {}) };
  for (const s of STORES) out[s] = await all(s);
  return out;
}

export async function clearAll() {
  const db = await open();
  const t = db.transaction([...STORES, 'kv'], 'readwrite');
  for (const s of [...STORES, 'kv']) t.objectStore(s).clear();
  await done(t);
  emit();
}

export const notify = emit;
