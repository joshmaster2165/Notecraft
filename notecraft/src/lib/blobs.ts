// Pictures, attachments and recordings live in the model as data: URLs. When
// a page is stored (IndexedDB versions, or the library folder on disk) each
// one is replaced by a short reference and stored once, keyed by content.
import { hashString } from "../model/versions.ts";

export const BLOB_PREFIX = "notecraft-blob:";

export const blobKey = (dataUrl: string) => `${hashString(dataUrl)}-${dataUrl.length.toString(36)}`;

/**
 * Copy `value`, replacing every `src` that holds a data: URL with a
 * `notecraft-blob:` reference; the URLs are added to `blobs` by key.
 * Unchanged branches are shared, not copied.
 */
export function extractBlobs<T>(value: T, blobs: Map<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    if (v && typeof v === "object") {
      let out: Record<string, unknown> | null = null;
      for (const [k, x] of Object.entries(v)) {
        let y: unknown;
        if (k === "src" && typeof x === "string" && x.startsWith("data:")) {
          const key = blobKey(x);
          blobs.set(key, x);
          y = BLOB_PREFIX + key;
        } else y = walk(x);
        if (y !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = y;
      }
      return out ?? v;
    }
    return v;
  };
  return walk(value) as T;
}

/** Every blob key referenced in `value`. */
export function blobRefs(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (value.startsWith(BLOB_PREFIX)) into.add(value.slice(BLOB_PREFIX.length));
  } else if (Array.isArray(value)) value.forEach((x) => blobRefs(x, into));
  else if (value && typeof value === "object") Object.values(value).forEach((x) => blobRefs(x, into));
  return into;
}

/** Copy `value`, turning blob references back into data URLs from `lookup`. */
export function hydrateBlobs<T>(value: T, lookup: (key: string) => string | undefined): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.startsWith(BLOB_PREFIX) ? lookup(v.slice(BLOB_PREFIX.length)) ?? "" : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
