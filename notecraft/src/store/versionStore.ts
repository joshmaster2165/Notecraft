// Page versions, stored outside the library: in the library folder's
// versions/ (desktop) or in IndexedDB (browser). Image data URLs become blob
// references so repeated snapshots of a page keep one copy of each picture.
import type { Id, Page, PageVersion, VersionReason } from "../model/types.ts";
import { MAX_VERSIONS_PER_PAGE, pageSignature, pruneIds } from "../model/versions.ts";
import { batch, get, getAllByIndex } from "../lib/idb.ts";
import { newId, nowIso } from "../lib/id.ts";
import { migratePage } from "../model/migrate.ts";
import { blobRefs, extractBlobs, hydrateBlobs } from "../lib/blobs.ts";
import { desktop } from "../desktop.ts";

interface StoredVersion extends PageVersion {
  sig: string;
}

// --- backends ---------------------------------------------------------------------------

interface Backend {
  list(pageId: Id): Promise<StoredVersion[]>;
  /** With pictures as data URLs. */
  load(id: Id): Promise<StoredVersion | undefined>;
  commit(put: StoredVersion[], drop: Id[], blobs: Map<string, string>): Promise<void>;
}

const indexedDbBackend: Backend = {
  list: (pageId) => getAllByIndex<StoredVersion>("versions", "pageId", pageId),
  async load(id) {
    const v = await get<StoredVersion>("versions", id);
    if (!v) return undefined;
    const found = new Map<string, string>();
    await Promise.all(
      [...blobRefs(v.page)].map(async (k) => {
        const url = await get<string>("blobs", k);
        if (url) found.set(k, url);
      }),
    );
    return { ...v, page: hydrateBlobs(v.page, (k) => found.get(k)) };
  },
  commit: (put, drop, blobs) =>
    batch(["versions", "blobs"], (tx) => {
      const vs = tx.objectStore("versions");
      put.forEach((r) => vs.put(r));
      drop.forEach((id) => vs.delete(id));
      const bs = tx.objectStore("blobs");
      blobs.forEach((url, k) => bs.put(url, k));
    }),
};

const diskBackend = (lib: NonNullable<typeof desktop>["library"]): Backend => ({
  list: (pageId) => lib.listVersions<StoredVersion>(pageId),
  load: async (id) => (await lib.getVersion<StoredVersion>(id)) ?? undefined,
  commit: (put, drop, blobs) => lib.commitVersions({ put, delete: drop, blobs: Object.fromEntries(blobs) }),
});

const backend: Backend = desktop ? diskBackend(desktop.library) : indexedDbBackend;

// --- change notifications --------------------------------------------------------------

const listeners = new Set<(pageId: Id) => void>();
export function onVersionsChanged(fn: (pageId: Id) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = (pageId: Id) => listeners.forEach((l) => l(pageId));

// --- queries ------------------------------------------------------------------------------

/** Newest first. Pages keep image references; use loadVersion() for a renderable copy. */
export async function listVersions(pageId: Id): Promise<PageVersion[]> {
  const all = await backend.list(pageId);
  return all.sort((a, b) => b.at.localeCompare(a.at));
}

export async function loadVersion(id: Id): Promise<PageVersion | undefined> {
  const v = await backend.load(id);
  return v ? { ...v, page: migratePage(v.page) } : undefined;
}

// --- writes -------------------------------------------------------------------------------

const latestSig = new Map<Id, string>();
const queues = new Map<Id, Promise<unknown>>();

/** Serialise writes per page so dedupe and pruning see each other's results. */
function enqueue<T>(pageId: Id, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(pageId) ?? Promise.resolve()).then(job, job);
  queues.set(pageId, run.catch(() => undefined));
  return run;
}

/** Save a Notecraft snapshot unless it matches the page's latest version. */
export function saveSnapshot(pageId: Id, page: Page, reason: VersionReason): Promise<PageVersion | null> {
  const sig = pageSignature(page);
  return enqueue(pageId, async () => {
    let existing: StoredVersion[] | undefined;
    if (!latestSig.has(pageId)) {
      existing = (await listVersions(pageId)) as StoredVersion[];
      const newest = existing.find((v) => v.source === "notecraft") ?? existing[0];
      if (newest) latestSig.set(pageId, newest.sig);
    }
    if (latestSig.get(pageId) === sig) return null;
    const blobs = new Map<string, string>();
    const stripped = extractBlobs(page, blobs);
    const record: StoredVersion = { id: newId("v"), pageId, at: nowIso(), author: "You", source: "notecraft", reason, page: stripped, sig };
    existing ??= (await listVersions(pageId)) as StoredVersion[];
    const drop = pruneIds([...existing, record], MAX_VERSIONS_PER_PAGE);
    await backend.commit([record], drop, blobs);
    latestSig.set(pageId, sig);
    notify(pageId);
    return record;
  });
}

/** Store OneNote's own page versions brought in by a .one import. */
export async function addImportedVersions(versions: Omit<PageVersion, "id">[]): Promise<number> {
  if (!versions.length) return 0;
  const blobs = new Map<string, string>();
  const records: StoredVersion[] = versions.map((v) => ({ ...v, id: newId("v"), page: extractBlobs(v.page, blobs), sig: pageSignature(v.page) }));
  await backend.commit(records, [], blobs);
  new Set(records.map((r) => r.pageId)).forEach(notify);
  return records.length;
}
