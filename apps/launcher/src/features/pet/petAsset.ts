/**
 * @file petAsset.ts
 * Custom pet image stored as a Blob in IndexedDB — localStorage's ~5MB
 * quota is too tight for GIFs. Served to the <img> via objectURL at
 * runtime, so nothing ships outside the local profile.
 */

const DB_NAME = 'chlauncher-pet';
const STORE = 'assets';
const FISH_KEY = 'fish';
/** Guard against multi-hundred-MB picks (IndexedDB can take more, but
 * an 8MB GIF is already heavy for a 160px widget). */
export const MAX_FISH_BYTES = 8 * 1024 * 1024;

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((res, rej) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
          db.close();
          rej(tx.error);
        };
      })
  );
}

export const saveFishBlob = (blob: Blob) =>
  withStore('readwrite', (s) => s.put(blob, FISH_KEY)).then(() => {});

export const loadFishBlob = () =>
  withStore('readonly', (s) => s.get(FISH_KEY) as IDBRequest<Blob | undefined>)
    .then((b) => b ?? null)
    .catch(() => null);

export const clearFish = () =>
  withStore('readwrite', (s) => s.delete(FISH_KEY)).then(() => {});
