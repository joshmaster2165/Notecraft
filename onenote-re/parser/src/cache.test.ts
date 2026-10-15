import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CACHE_HEADER_SIZE, OneNoteCache, fileIdToName, parseCacheHeader, parseFileIdName } from "./cache.ts";

test("FileIDs are 8 big-endian base-32 digits", () => {
  assert.equal(fileIdToName(0), "00000000.bin");
  assert.equal(fileIdToName(230), "00000076.bin");
  assert.equal(fileIdToName(0x7a, true), "0000003Q.enc");
  assert.equal(fileIdToName(2 ** 40 - 1), "VVVVVVVV.bin");
  assert.throws(() => fileIdToName(2 ** 40));
  assert.deepEqual(parseFileIdName("0000004P.bin"), { fileId: 4 * 32 + 25, encrypted: false });
  assert.equal(parseFileIdName("header"), null);
  assert.equal(parseFileIdName("0000004W.bin"), null);
  for (const id of [1, 31, 32, 1023, 123456789]) assert.equal(parseFileIdName(fileIdToName(id))!.fileId, id);
});

function header(lastFileId: number): Uint8Array {
  const b = new Uint8Array(CACHE_HEADER_SIZE);
  const dv = new DataView(b.buffer);
  dv.setUint32(4, 0x062c0f27, true);
  dv.setBigUint64(0x24, BigInt(lastFileId), true);
  return b;
}

test("header fields", () => {
  const h = parseCacheHeader(header(230));
  assert.equal(h.formatMode, 0);
  assert.equal(h.creationTag, 0x062c0f27);
  assert.equal(h.lastFileId, 230);
  assert.equal(h.words.length, 18);
  assert.throws(() => parseCacheHeader(new Uint8Array(10)));
});

test("indexes a cache folder and resolves file data by SHA-1", () => {
  const dir = mkdtempSync(join(tmpdir(), "onenote-cache-"));
  try {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const page = new Uint8Array(4096);
    page.set([0x42, 0x4d, 0x32, 0x00, 0x00, 0xc0]); // "BM" whose size field is wrong: not a BMP
    writeFileSync(join(dir, "header"), header(3));
    writeFileSync(join(dir, "00000000.bin"), page);
    writeFileSync(join(dir, "00000002.bin"), png);
    writeFileSync(join(dir, "00000003.enc"), new Uint8Array(16));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    mkdirSync(join(dir, "tmp"));
    writeFileSync(join(dir, "tmp", "00000004.bin"), new Uint8Array(1));

    const cache = new OneNoteCache(dir);
    assert.deepEqual(
      cache.files.map((f) => [f.name, f.kind, f.mediaType]),
      [["00000000.bin", "store", undefined], ["00000002.bin", "fileData", "image/png"], ["00000003.enc", "encrypted", undefined]],
    );
    assert.deepEqual(cache.stats(), { dir, files: 3, fileData: 1, encrypted: 1, store: 1, staged: 1, lastFileId: 3 });

    const sha1 = createHash("sha1").update(png).digest("hex");
    assert.equal(cache.findBySha1(sha1.toUpperCase())?.name, "00000002.bin");
    const resolve = cache.resolver();
    const hit = resolve({ containerId: "{X}#1", unverifiedHash: sha1 });
    assert.deepEqual(hit && [...hit.bytes], [...png]);
    assert.equal(hit?.source, "cache/00000002.bin");
    assert.equal(resolve({ containerId: "{X}#1", unverifiedHash: "00".repeat(20) }), undefined);
    assert.equal(resolve({ containerId: "{X}#1" }), undefined);

    assert.equal(OneNoteCache.findFor(join(dir, "..", "Backup", "nb", "s.one")), null);
    const root = mkdtempSync(join(tmpdir(), "onenote-15.0-"));
    try {
      mkdirSync(join(root, "cache"));
      writeFileSync(join(root, "cache", "header"), header(0));
      assert.equal(OneNoteCache.findFor(join(root, "Backup", "nb", "s.one")), join(root, "cache"));
    } finally {
      rmSync(root, { recursive: true });
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});
