// OneNote for Mac's local cache store: .../OneNote/15.0/cache (docs/file-format.md §11).
//
//   header             72 bytes: format mode, last allocated FileID, root references.
//   <FileID>.bin|.enc  one file per FileID. A FileID is a 40-bit counter written as
//                      8 base-32 digits (0-9, A-V), most significant first.
//   tmp/               staging: new files are created here and moved into place
//                      when their transaction commits.
//
// Two kinds of file share the FileID namespace:
//   - allocator files: memory-mapped pages of OneNote's transactional object
//     store (revisions, object groups, property sets, dictionaries). Not decoded.
//   - file data objects (FDOs): one standard-I/O file per downloaded image or
//     attachment, holding the downloaded bytes. OneNote fetches FDOs on demand,
//     so a cache can hold a notebook's whole graph and none of its pictures.
//
// FDOs are matched to images by content: an ImageNode's 20-byte UnverifiedHash
// is compared with the SHA-1 of every readable cache file. A match is conclusive;
// a miss is not, because the algorithm behind UnverifiedHash is not confirmed in
// OneNote's code.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { sniffMediaType, type FileDataResolver } from "./notebook.ts";

export const CACHE_HEADER_SIZE = 0x48;
const FILE_ID_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
const FILE_NAME = /^([0-9A-V]{8})\.(bin|enc)$/;

/** File name for a FileID (FUN_1000716ec + FUN_100071664). */
export function fileIdToName(id: number, encrypted = false): string {
  if (!Number.isInteger(id) || id < 0 || id >= 2 ** 40) throw new RangeError(`FileID ${id} is not a 40-bit value`);
  let s = "";
  for (let i = 0, v = id; i < 8; i++, v = Math.floor(v / 32)) s = FILE_ID_DIGITS[v % 32] + s;
  return s + (encrypted ? ".enc" : ".bin");
}

export function parseFileIdName(name: string): { fileId: number; encrypted: boolean } | null {
  const m = FILE_NAME.exec(name);
  if (!m) return null;
  let id = 0;
  for (const c of m[1]!) id = id * 32 + FILE_ID_DIGITS.indexOf(c);
  return { fileId: id, encrypted: m[2] === "enc" };
}

export interface CacheHeader {
  /** u32 @0x00. 0 on an unencrypted store; the initializer can also write 4 or 5. */
  formatMode: number;
  /** u32 @0x04, written once when the store is created. */
  creationTag: number;
  /** u64 @0x24: the last FileID handed out (new IDs are pre-incremented). */
  lastFileId: number;
  /** All 18 little-endian u32 words, including the reference fields not decoded yet. */
  words: number[];
}

export function parseCacheHeader(buf: Uint8Array): CacheHeader {
  if (buf.length < CACHE_HEADER_SIZE) throw new Error(`cache header is ${buf.length} bytes, expected ${CACHE_HEADER_SIZE}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, CACHE_HEADER_SIZE);
  const words = Array.from({ length: CACHE_HEADER_SIZE / 4 }, (_, i) => dv.getUint32(i * 4, true));
  return { formatMode: words[0]!, creationTag: words[1]!, lastFileId: Number(dv.getBigUint64(0x24, true)), words };
}

/**
 * "fileData": the bytes start with a known media signature (an FDO).
 * "encrypted": a .enc file, written when OneNote's cache-encryption gate is on.
 * "store": anything else, normally an allocator file. An FDO of an unrecognised
 * type also lands here; hash matching still covers it.
 */
export type CacheFileKind = "fileData" | "encrypted" | "store";

export interface CacheFile {
  fileId: number;
  name: string;
  size: number;
  kind: CacheFileKind;
  mediaType?: string;
}

function signatureType(head: Uint8Array, size: number): string | undefined {
  const t = sniffMediaType(head);
  if (t === "application/octet-stream") return undefined;
  // "BM" alone is too weak against allocator pages; a real BMP repeats its size.
  if (t === "image/bmp" && (head.length < 6 || new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(2, true) !== size)) return undefined;
  return t;
}

export class OneNoteCache {
  readonly dir: string;
  readonly header: CacheHeader | null;
  readonly files: CacheFile[] = [];
  /** Files left in tmp/ by an uncommitted transaction. */
  readonly stagedFiles: number;
  private hashes: Map<string, CacheFile> | null = null;

  constructor(dir: string) {
    this.dir = dir;
    const headerPath = join(dir, "header");
    this.header = existsSync(headerPath) ? parseCacheHeader(new Uint8Array(readFileSync(headerPath))) : null;
    for (const name of readdirSync(dir).sort()) {
      const id = parseFileIdName(name);
      if (!id) continue;
      const size = statSync(join(dir, name)).size;
      const file: CacheFile = { fileId: id.fileId, name, size, kind: id.encrypted ? "encrypted" : "store" };
      if (!id.encrypted) {
        const mediaType = signatureType(this.head(name, 64), size);
        if (mediaType) Object.assign(file, { kind: "fileData", mediaType });
      }
      this.files.push(file);
    }
    const tmp = join(dir, "tmp");
    this.stagedFiles = existsSync(tmp) ? readdirSync(tmp).filter((n) => FILE_NAME.test(n)).length : 0;
  }

  /**
   * The cache folder that belongs to a OneNote backup or data path: the
   * `cache` sibling of the nearest `15.0`-style ancestor that has a header.
   */
  static findFor(path: string): string | null {
    for (let d = path; d !== dirname(d); d = dirname(d)) {
      const candidate = join(d, "cache");
      if (existsSync(join(candidate, "header"))) return candidate;
    }
    return null;
  }

  read(file: CacheFile): Uint8Array {
    return new Uint8Array(readFileSync(join(this.dir, file.name)));
  }

  /** The cache file whose SHA-1 is `hex`. Encrypted files cannot be hashed and are skipped. */
  findBySha1(hex: string): CacheFile | undefined {
    if (!this.hashes) {
      this.hashes = new Map();
      for (const f of this.files) {
        if (f.kind === "encrypted") continue;
        this.hashes.set(createHash("sha1").update(this.read(f)).digest("hex"), f);
      }
    }
    return this.hashes.get(hex.toLowerCase());
  }

  /** Plugs the cache into ConvertOptions.resolveFileData. */
  resolver(): FileDataResolver {
    return ({ unverifiedHash }) => {
      const f = unverifiedHash ? this.findBySha1(unverifiedHash) : undefined;
      return f ? { bytes: this.read(f), source: `cache/${f.name}` } : undefined;
    };
  }

  stats() {
    const count = (k: CacheFileKind) => this.files.filter((f) => f.kind === k).length;
    return {
      dir: this.dir,
      files: this.files.length,
      fileData: count("fileData"),
      encrypted: count("encrypted"),
      store: count("store"),
      staged: this.stagedFiles,
      lastFileId: this.header?.lastFileId ?? null,
    };
  }

  private head(name: string, n: number): Uint8Array {
    const fd = openSync(join(this.dir, name), "r");
    try {
      const b = new Uint8Array(n);
      return b.subarray(0, readSync(fd, b, 0, n, 0));
    } finally {
      closeSync(fd);
    }
  }
}
