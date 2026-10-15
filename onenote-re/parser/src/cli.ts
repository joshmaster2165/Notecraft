// Usage: node parser/src/cli.ts <file.one> [--raw] [--assets <dir>] [--cache <dir> | --no-cache] [--out <file.json>]
//   --raw       dump the full revision-store object graph instead of blocks
//   --assets    write embedded images/attachments to <dir> and reference them
//   --cache     OneNote cache folder to take missing (<invfdo>) file data from;
//               by default the `cache` sibling of a .../15.0/Backup tree is used
//   --no-cache  never read a cache folder
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { OneStore } from "./onestore.ts";
import { NotebookConverter, dumpObjectGraph } from "./notebook.ts";
import { OneNoteCache } from "./cache.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const bool = (name: string) => {
  const i = args.indexOf(name);
  if (i !== -1) args.splice(i, 1);
  return i !== -1;
};
const raw = bool("--raw");
const noCache = bool("--no-cache");
const assetDir = flag("--assets");
const outFile = flag("--out");
const cacheArg = flag("--cache");
const input = args[0];
if (!input) {
  console.error("usage: cli.ts <file.one|file.onetoc2> [--raw] [--assets <dir>] [--cache <dir> | --no-cache] [--out <file.json>]");
  process.exit(2);
}

const cacheDir = noCache ? null : (cacheArg ?? OneNoteCache.findFor(input));
const cache = cacheDir && !raw ? new OneNoteCache(cacheDir) : null;

const store = new OneStore(new Uint8Array(readFileSync(input)));
const json = raw
  ? dumpObjectGraph(store)
  : new NotebookConverter(store, {
      sectionName: basename(input, extname(input)),
      resolveFileData: cache?.resolver(),
      onAsset: assetDir
        ? ({ bytes, extension, mediaType }) => {
            mkdirSync(assetDir, { recursive: true });
            const ext = extension || "." + (mediaType.split("/")[1] ?? "bin");
            const name = createHash("sha256").update(bytes).digest("hex").slice(0, 16) + ext;
            writeFileSync(join(assetDir, name), bytes);
            return name;
          }
        : undefined,
    }).convert();

if (cache && "diagnostics" in json) {
  const s = cache.stats();
  const l = json.diagnostics.fileDataLookups;
  console.error(`cache ${s.dir}: ${s.files} files (${s.fileData} file data, ${s.encrypted} encrypted); resolved ${l?.resolved ?? 0}/${l?.requested ?? 0} missing file data objects`);
}

const text = JSON.stringify(json, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
if (outFile) writeFileSync(outFile, text);
else process.stdout.write(text + "\n");
