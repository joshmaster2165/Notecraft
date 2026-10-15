// Parses every .one/.onetoc2 under a directory and reports structural stats.
// Exits non-zero if any file fails or produces warnings.
// Usage: node parser/src/smoke.ts <dir> [--cache <dir> | --no-cache]
//   File data missing from the sections is looked up in OneNote's cache folder
//   (by default the `cache` sibling of a .../15.0/Backup tree); see cache.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OneStore } from "./onestore.ts";
import { NotebookConverter } from "./notebook.ts";
import { OneNoteCache } from "./cache.ts";

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(one|onetoc2)$/i.test(name)) yield p;
  }
}

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) {
  console.error("usage: smoke.ts <dir> [--cache <dir> | --no-cache]");
  process.exit(2);
}
const cacheAt = args.indexOf("--cache");
const cacheDir = args.includes("--no-cache") ? null : cacheAt !== -1 ? args[cacheAt + 1]! : OneNoteCache.findFor(dir);
const cache = cacheDir ? new OneNoteCache(cacheDir) : null;
const resolveFileData = cache?.resolver();

let failed = 0;
const totals = { images: 0, embeddedFiles: 0, requested: 0, resolved: 0 };
for (const file of walk(dir)) {
  const t0 = performance.now();
  try {
    const store = new OneStore(new Uint8Array(readFileSync(file)));
    const json = new NotebookConverter(store, { resolveFileData }).convert();
    const count = (type: string) => JSON.stringify(json).split(`"type":"${type}"`).length - 1;
    const warnings = json.diagnostics.warnings.length;
    const lookups = json.diagnostics.fileDataLookups;
    if (warnings) failed++;
    totals.images += count("image");
    totals.embeddedFiles += count("embeddedFile");
    totals.requested += lookups?.requested ?? 0;
    totals.resolved += lookups?.resolved ?? 0;
    console.log(
      [
        warnings ? "WARN" : "ok  ",
        `${(performance.now() - t0).toFixed(0).padStart(4)}ms`,
        `spaces=${store.objectSpaces.size}`,
        `pages=${json.section.pages.length}`,
        `outlines=${count("outline")}`,
        `paragraphs=${count("richText")}`,
        `tables=${count("table")}`,
        `images=${count("image")}`,
        `unknown=${count("unknown")}`,
        ...(lookups ? [`cached=${lookups.resolved}/${lookups.requested}`] : []),
        file.split("/").pop(),
      ].join("  "),
    );
    for (const w of json.diagnostics.warnings.slice(0, 5)) console.log("      ", w);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${file.split("/").pop()}: ${(e as Error).message}`);
  }
}
if (cache) {
  const s = cache.stats();
  console.log(
    `cache ${s.dir}: ${s.files} files (${s.fileData} file data, ${s.encrypted} encrypted, ${s.staged} staged), last FileID ${s.lastFileId}`,
  );
  console.log(`file data from cache: ${totals.resolved} of ${totals.requested} missing objects (${totals.images} images, ${totals.embeddedFiles} attachments)`);
}
process.exit(failed ? 1 : 0);
