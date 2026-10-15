// IndexedDB storage for page versions. Snapshots are stored outside the
// library; image data URLs are moved into a shared blob store so repeated
// snapshots of a page with pictures keep one copy of each picture.
import type { Element, Id, Page, PageVersion, VersionReason } from "../model/types.ts";
import { MAX_VERSIONS_PER_PAGE, hashString, pageSignature, pruneIds } from "../model/versions.ts";
import { batch, get, getAllByIndex } from "../lib/idb.ts";
import { newId, nowIso } from "../lib/id.ts";
import { migratePage } from "../model/migrate.ts";

interface StoredVersion extends PageVersion {
  sig: string;
}

const BLOB_PREFIX = "notecraft-blob:";

// --- image blob extraction ------------------------------------------------------------

function mapImageSources(page: Page, fn: (src: string) => string): Page {
  const mapSrc = <T extends { src?: string }>(o: T): T => (o.src ? { ...o, src: fn(o.src) } : o);
  const mapEls = (els: Element[]): Element[] =>
    els.map((e) => {
      if (e.kind === "image") return { ...e, image: mapSrc(e.image) };
      if (e.kind === "file") return mapSrc(e);
      if (e.kind === "table") return { ...e, rows: e.rows.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, elements: mapEls(c.elements) })) })) };
      return e;
    });
  return { ...page, outlines: page.outlines.map((o) => ({ ...o, elements: mapEls(o.elements) })), images: page.images.map(mapSrc) };
}

function extractBlobs(page: Page): { page: Page; blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  const out = mapImageSources(page, (src) => {
    if (!src.startsWith("data:")) return src;
    const key = `${hashString(src)}-${src.length.toString(36)}`;
    blobs.set(key, src);
    return BLOB_PREFIX + key;
  });
  return { page: out, blobs };
}

async function hydrate(page: Page): Promise<Page> {
  const keys = new Set<string>();
  mapImageSources(page, (src) => (src.startsWith(BLOB_PREFIX) && keys.add(src.slice(BLOB_PREFIX.length)), src));
  if (!keys.size) return page;
  const found = new Map<string, string>();
  await Promise.all([...keys].map(async (k) => {
    const v = await get<string>("blobs", k);
    if (v) found.set(k, v);
  }));
  return mapImageSources(page, (src) => (src.startsWith(BLOB_PREFIX) ? found.get(src.slice(BLOB_PREFIX.length)) ?? "" : src));
}

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
  const all = await getAllByIndex<StoredVersion>("versions", "pageId", pageId);
  return all.sort((a, b) => b.at.localeCompare(a.at));
}

export async function loadVersion(id: Id): Promise<PageVersion | undefined> {
  const v = await get<StoredVersion>("versions", id);
  return v ? { ...v, page: migratePage(await hydrate(v.page)) } : undefined;
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
    const { page: stripped, blobs } = extractBlobs(page);
    const record: StoredVersion = { id: newId("v"), pageId, at: nowIso(), author: "You", source: "notecraft", reason, page: stripped, sig };
    existing ??= (await listVersions(pageId)) as StoredVersion[];
    const drop = pruneIds([...existing, record], MAX_VERSIONS_PER_PAGE);
    await batch(["versions", "blobs"], (tx) => {
      const vs = tx.objectStore("versions");
      vs.put(record);
      for (const id of drop) vs.delete(id);
      const bs = tx.objectStore("blobs");
      for (const [k, v] of blobs) bs.put(v, k);
    });
    latestSig.set(pageId, sig);
    notify(pageId);
    return record;
  });
}

/** Store OneNote's own page versions brought in by a .one import. */
export async function addImportedVersions(versions: Omit<PageVersion, "id">[]): Promise<number> {
  if (!versions.length) return 0;
  const records: StoredVersion[] = [];
  const blobs = new Map<string, string>();
  for (const v of versions) {
    const { page, blobs: b } = extractBlobs(v.page);
    b.forEach((val, k) => blobs.set(k, val));
    records.push({ ...v, id: newId("v"), page, sig: pageSignature(v.page) });
  }
  await batch(["versions", "blobs"], (tx) => {
    const vs = tx.objectStore("versions");
    records.forEach((r) => vs.put(r));
    const bs = tx.objectStore("blobs");
    blobs.forEach((val, k) => bs.put(val, k));
  });
  new Set(records.map((r) => r.pageId)).forEach(notify);
  return records.length;
}
