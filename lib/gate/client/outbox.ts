// The phone's outbox.
//
// ONE queue for everything — trips, scans, shifts, face checks and the images
// that belong to them. One queue means one retry path and one place to look
// when a phone comes back after four hours offline, instead of four half-drained
// queues that disagree about what landed.
//
// IndexedDB, not localStorage: localStorage is a few megabytes, synchronous
// (so it janks the scan loop) and cannot hold image blobs at all.
//
// NOTHING IS EVER DELETED BEFORE THE SERVER CONFIRMS IT. An entry leaves only
// on an explicit "stored" or "duplicate" verdict. A rejected one is kept and
// marked, because a row silently dropped at a gate is a unit nobody can account
// for — the exact failure the paper register already has.

const DB = "gate-outbox";
const VERSION = 1;
const ITEMS = "items";
const BLOBS = "blobs";

export type Kind = "trip" | "scan" | "shift" | "face" | "void";

// "void" is the odd one out and worth saying plainly: it is not a movement,
// it is a RETRACTION of one. A guard who scans the wrong box removes it, and
// if that scan has already reached the server the removal has to travel too --
// otherwise the phone shows twelve items and the reconciler counts thirteen.
// A scan still sitting in this queue is simply deleted; nothing was claimed
// yet, so there is nothing to retract.

export interface OutboxItem {
  clientId: string;
  kind: Kind;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  /** Set when the server refuses it. Kept, shown, never silently discarded. */
  rejected?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(ITEMS)) {
        const s = db.createObjectStore(ITEMS, { keyPath: "clientId" });
        s.createIndex("kind", "kind");
        s.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode,
                     fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => res(req.result as T);
    req.onerror = () => rej(req.error);
  });
}

export async function enqueue(item: Omit<OutboxItem, "createdAt" | "attempts">) {
  await tx(ITEMS, "readwrite", (s) =>
    s.put({ ...item, createdAt: Date.now(), attempts: 0 }));
}

export async function putBlob(clientId: string, blob: Blob) {
  await tx(BLOBS, "readwrite", (s) => s.put(blob, clientId));
}

export async function getBlob(clientId: string): Promise<Blob | undefined> {
  return tx<Blob | undefined>(BLOBS, "readonly", (s) => s.get(clientId));
}

export async function all(): Promise<OutboxItem[]> {
  const items = await tx<OutboxItem[]>(ITEMS, "readonly", (s) => s.getAll());
  // Oldest first, so a long backlog drains in the order it happened and a trip
  // is always applied before the scans that reference it.
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export async function pending(): Promise<OutboxItem[]> {
  return (await all()).filter((i) => !i.rejected);
}

export async function remove(clientId: string) {
  await tx(ITEMS, "readwrite", (s) => s.delete(clientId));
  await tx(BLOBS, "readwrite", (s) => s.delete(clientId)).catch(() => {});
}

/**
 * Drop an entry only if it is still queued, and say whether it was.
 *
 * The answer decides what happens next: `true` means the scan never left the
 * phone and deleting it is the whole job; `false` means the server already has
 * it and a void has to be sent. Doing this as one function rather than a
 * separate "is it there?" check keeps the two from racing against a drain
 * running at the same moment.
 */
export async function removeIfQueued(clientId: string): Promise<boolean> {
  const cur = await tx<OutboxItem | undefined>(ITEMS, "readonly", (s) => s.get(clientId));
  if (!cur) return false;
  await remove(clientId);
  return true;
}

export async function markRejected(clientId: string, reason: string) {
  const cur = await tx<OutboxItem | undefined>(ITEMS, "readonly", (s) => s.get(clientId));
  if (!cur) return;
  await tx(ITEMS, "readwrite", (s) => s.put({ ...cur, rejected: reason, attempts: cur.attempts + 1 }));
}

export async function bumpAttempts(ids: string[]) {
  for (const id of ids) {
    const cur = await tx<OutboxItem | undefined>(ITEMS, "readonly", (s) => s.get(id));
    if (cur) await tx(ITEMS, "readwrite", (s) => s.put({ ...cur, attempts: cur.attempts + 1 }));
  }
}

export async function counts() {
  const items = await all();
  return {
    waiting: items.filter((i) => !i.rejected).length,
    rejected: items.filter((i) => i.rejected).length,
    oldest: items.length ? items[0].createdAt : null,
  };
}
