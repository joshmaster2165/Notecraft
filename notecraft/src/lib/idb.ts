// Minimal promise wrapper over IndexedDB for Notecraft's three stores:
//   kv        the library (one record)
//   versions  page snapshots, indexed by pageId
//   blobs     image data URLs shared between snapshots, keyed by content hash

export const DB_NAME = "notecraft";
const DB_VERSION = 1;
/** Before the rename the app stored its library in an "onecraft" database. */
export const LEGACY_DB_NAME = "onecraft";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("versions")) db.createObjectStore("versions", { keyPath: "id" }).createIndex("pageId", "pageId");
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const committed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export async function get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function put(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  return committed(tx);
}

export async function getAllByIndex<T>(store: string, index: string, key: IDBValidKey): Promise<T[]> {
  const db = await openDb();
  return done(db.transaction(store).objectStore(store).index(index).getAll(key)) as Promise<T[]>;
}

/** Write several records and deletions across stores in one transaction. */
export async function batch(stores: string[], fn: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(stores, "readwrite");
  fn(tx);
  return committed(tx);
}

/** Read the library saved under the app's previous name, if any, without creating that database. */
export async function readLegacyLibrary<T>(): Promise<T | undefined> {
  if (indexedDB.databases) {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === LEGACY_DB_NAME)) return undefined;
  }
  return new Promise((resolve) => {
    const req = indexedDB.open(LEGACY_DB_NAME);
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) {
        db.close();
        return resolve(undefined);
      }
      const get = db.transaction("kv").objectStore("kv").get("library");
      get.onsuccess = () => {
        db.close();
        resolve(get.result as T | undefined);
      };
      get.onerror = () => {
        db.close();
        resolve(undefined);
      };
    };
  });
}
