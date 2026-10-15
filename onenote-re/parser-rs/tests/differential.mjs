// Differential test: the TypeScript parser (in-process) against the Rust CLI.
//
// Usage: node onenote-re/parser-rs/tests/differential.mjs [<dir>] [--fuzz <n>] [--seed <s>] [--synthetic <n>] [--wasm] [--no-raw] [--no-toc]
//   Build the CLI first: cargo build -p onenote-re --release
//   ONENOTE_PARSE_BIN overrides the binary (default: <repo>/target/release/onenote-parse).
//
// For every .one/.onetoc2 under <dir> (read in place, never copied):
//   json  NotebookConverter (includeVersions, onAsset, OneNoteCache resolver as in
//         cli.ts) vs `onenote-parse <file> --versions --asset-ids`; .onetoc2 files
//         go through notebookToc, as in cli.ts.
//   raw   dumpObjectGraph vs `onenote-parse <file> --raw`.
//   toc   notebookToc on every file vs `onenote-parse <file> --toc`.
//   fuzz  (--fuzz n) n byte-mutated copies per file, kept in memory and piped to
//         the CLI's stdin: both sides must fail with the same message or agree.
// --wasm also checks the wasm-bindgen build (notecraft/src/wasm/onenote_re, from
// `npm run build:wasm` in notecraft/) in-process: parse_one_note's json against
// the TypeScript object (onAsset returning the asset id) and its assets list
// against the onAsset calls; parse_notebook_toc against notebookToc.
// --synthetic n also generates n files with tests/synthetic.mjs (every node
// type, property type and converter path; one in five is a .onetoc2) and runs
// the same comparisons on them, plus the fuzz copies.
// Values are deep-compared (numbers within 1e-9, key order ignored); the text is
// also compared byte for byte against JSON.stringify(json, null, 2).
//
// Notes are personal: this prints file numbers, counts, JSON paths and value
// types/lengths only, never names or values.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { OneStore } = await import("../../parser/src/onestore.ts");
const { NotebookConverter, dumpObjectGraph } = await import("../../parser/src/notebook.ts");
const { notebookToc } = await import("../../parser/src/toc.ts");
const { OneNoteCache } = await import("../../parser/src/cache.ts");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const valueFlags = new Set(["--fuzz", "--seed", "--synthetic"]);
const dir = args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1]));
const syntheticCount = Number(opt("--synthetic", 0));
if (!dir && !syntheticCount) {
  console.error("usage: differential.mjs [<dir>] [--fuzz <n>] [--seed <s>] [--synthetic <n>] [--wasm] [--no-raw] [--no-toc]");
  process.exit(2);
}
const fuzzCount = Number(opt("--fuzz", 0));
let seed = Number(opt("--seed", 1)) >>> 0 || 1;
const doRaw = !args.includes("--no-raw");
const doWasm = args.includes("--wasm");
const doToc = !args.includes("--no-toc");
const bin = process.env.ONENOTE_PARSE_BIN ?? join(here, "../../../target/release/onenote-parse");

// --- helpers --------------------------------------------------------------------

// Error messages can carry paths (fs) or input snippets (JSON.parse): print codes only.
process.on("uncaughtException", (e) => {
  console.error(`fatal: ${e?.code ?? e?.name ?? "error"}`);
  process.exit(3);
});

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("invalid JSON"), { code: `invalid JSON from ${what}` });
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** macOS privacy checks can make reads of the OneNote container fail transiently. */
function retry(fn, what) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 6 || !["EPERM", "EACCES", "EAGAIN", "EBUSY", "ETIMEDOUT", "EINTR"].includes(e.code)) throw e;
      console.error(`  retrying ${what} (${e.code}), attempt ${attempt + 1}`);
      sleep(500 * attempt);
    }
  }
}

function* walk(d) {
  for (const name of retry(() => readdirSync(d), "directory listing").sort()) {
    const p = join(d, name);
    if (retry(() => statSync(p), "stat").isDirectory()) yield* walk(p);
    else if (/\.(one|onetoc2)$/i.test(name)) yield p;
  }
}

const stringify = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const assetRef = ({ id, bytes }) => `${id} sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;

function typeOf(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(len ${v.length})`;
  if (typeof v === "string") return `string(len ${v.length})`;
  return typeof v;
}

/** What kind of code unit differs, without saying which. */
function unitKind(s, i) {
  if (i >= s.length) return "end";
  const c = s.charCodeAt(i);
  if (c === 0xfffd) return "U+FFFD";
  if (c >= 0xd800 && c <= 0xdfff) return "surrogate";
  if (/\s/.test(s[i])) return "whitespace";
  if (c < 0x20) return "control";
  return c < 0x80 ? "ascii" : "non-ascii";
}

/** Error and warning messages are templates; strip the numbers and ids anyway. */
const template = (m) =>
  String(m)
    .replace(/\{[0-9A-Fa-f-]{36}\}(#\d+)?/g, "{GUID}")
    .replace(/0x[0-9a-f]+/gi, "0x#")
    .replace(/-?\d+(\.\d+)?/g, "#");

/**
 * Deep compare; returns mismatch descriptions: paths and types only, plus the
 * values themselves when `show` is set (synthetic files only).
 */
function diff(a, b, show, path = "$", out = [], limit = 12) {
  if (out.length >= limit) return out;
  const values = () => (show ? `  [${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}]` : "");
  if (typeof a === "number" && typeof b === "number") {
    const same = a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-9;
    if (!same) out.push(`${path}: number vs number (|Δ| ${Math.abs(a - b).toExponential(1)})${values()}`);
    return out;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a !== b) {
      let i = 0;
      while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
      out.push(`${path}: ${typeOf(a)} vs ${typeOf(b)}, first difference at unit ${i} (${unitKind(a, i)} vs ${unitKind(b, i)})${values()}`);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: ${typeOf(a)} vs ${typeOf(b)}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], show, `${path}[${i}]`, out, limit);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], show, `${path}.${k}`, out, limit);
    return out;
  }
  if (a !== b) out.push(`${path}: ${typeOf(a)} vs ${typeOf(b)}${values()}`);
  return out;
}

function runRust(cliArgs, input) {
  const t0 = performance.now();
  const r = spawnSync(bin, [...cliArgs, "--timing"], { input, maxBuffer: 1 << 30 });
  const wall = performance.now() - t0;
  if (r.error) throw r.error;
  const stderr = r.stderr.toString();
  const inner = Number(/onenote-parse: ([\d.]+) ms/.exec(stderr)?.[1] ?? NaN);
  const error = r.status === 0 ? null : (/^Error: (.*)$/m.exec(stderr)?.[1] ?? `exit ${r.status}`);
  return { text: r.stdout.toString(), error, wall, inner };
}

function runTs(fn) {
  const t0 = performance.now();
  try {
    const text = stringify(fn());
    return { text, error: null, ms: performance.now() - t0 };
  } catch (e) {
    return { text: "", error: e?.message ?? String(e), ms: performance.now() - t0 };
  }
}

const results = { compared: 0, identical: 0, textIdentical: 0, failed: 0, illFormed: 0 };

/**
 * Rust strings are always valid Unicode: where TypeScript leaves a lone
 * surrogate (a TextRunIndex offset inside a surrogate pair), Rust has U+FFFD,
 * which is what String.prototype.toWellFormed gives. Count each such string.
 */
function wellFormed(v, counter) {
  if (typeof v === "string") {
    if (v.isWellFormed()) return v;
    counter.n++;
    return v.toWellFormed();
  }
  if (Array.isArray(v)) return v.map((x) => wellFormed(x, counter));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wellFormed(x, counter)]));
  return v;
}
const timing = { ts: 0, rustWall: 0, rustInner: 0 };
const modeStats = {};

/** Compare one TS result with one Rust result; prints and counts. */
function check(label, ts, rust) {
  results.compared++;
  const m = (modeStats[label.mode] ??= { compared: 0, identical: 0, textIdentical: 0, bothFailed: 0 });
  m.compared++;
  if (ts.error || rust.error) {
    if (ts.error && rust.error && template(ts.error) === template(rust.error) && ts.error === rust.error) {
      results.identical++;
      results.textIdentical++;
      m.identical++;
      m.textIdentical++;
      m.bothFailed++;
      return true;
    }
    results.failed++;
    const what = ts.error && rust.error ? "different errors" : ts.error ? "only TypeScript failed" : "only Rust failed";
    const shown = (m) => (label.synthetic ? m ?? "-" : template(m ?? "-"));
    console.log(`  FAIL ${label.name}: ${what}: ${shown(ts.error)} | ${shown(rust.error)}`);
    return false;
  }
  const counter = { n: 0 };
  const tsValue = wellFormed(parseJson(ts.text, "TypeScript"), counter);
  if (counter.n) {
    results.illFormed += counter.n;
    m.illFormed = (m.illFormed ?? 0) + counter.n;
  }
  const problems = diff(tsValue, parseJson(rust.text, "onenote-parse"), !!label.synthetic);
  if (problems.length) {
    results.failed++;
    console.log(`  FAIL ${label.name}: ${problems.length >= 12 ? "12+" : problems.length} mismatches`);
    for (const p of problems) console.log(`       ${p}`);
    return false;
  }
  results.identical++;
  m.identical++;
  if (rust.text === ts.text + "\n") {
    results.textIdentical++;
    m.textIdentical++;
  } else if (!counter.n) {
    // Equal values, different text, and not because of lone surrogates: key
    // order or number formatting. Report it (paths are safe to print).
    m.textOnly = (m.textOnly ?? 0) + 1;
    const a = ts.text + "\n";
    let i = 0;
    while (i < a.length && a[i] === rust.text[i]) i++;
    const line = a.slice(0, i).split("\n").length;
    console.log(`  NOTE ${label.name}: values equal but text differs from line ${line}`);
  }
  return true;
}

// --- wasm -------------------------------------------------------------------------

let wasm = null;
if (doWasm) {
  const dirWasm = join(here, "../../../notecraft/src/wasm/onenote_re");
  wasm = await import(join(dirWasm, "onenote_re.js"));
  wasm.initSync({ module: readFileSync(join(dirWasm, "onenote_re_bg.wasm")) });
}
const wasmTiming = { ts: 0, wasm: 0 };

/** wasm parse vs TypeScript, in-process (values, not JSON text). */
function checkWasm(label, bytes, sectionName) {
  const tsAssets = new Map();
  const t0 = performance.now();
  let ts;
  try {
    const store = new OneStore(bytes);
    ts = store.header.fileKind === "toc"
      ? { toc: notebookToc(store) }
      : {
          json: new NotebookConverter(store, {
            sectionName,
            includeVersions: true,
            onAsset: ({ id, bytes: b, extension, mediaType }) => {
              if (!tsAssets.has(id)) tsAssets.set(id, { id, mediaType, extension, sha: createHash("sha256").update(b).digest("hex") });
              return id;
            },
          }).convert(),
        };
  } catch (e) {
    ts = { error: e.message };
  }
  const t1 = performance.now();
  let w;
  try {
    w = ts.toc ? { toc: wasm.parse_notebook_toc(bytes) } : wasm.parse_one_note(bytes, sectionName, true);
  } catch (e) {
    w = { error: e.message };
  }
  const t2 = performance.now();
  if (label.timed) {
    wasmTiming.ts += t1 - t0;
    wasmTiming.wasm += t2 - t1;
  }
  const m = (modeStats[label.mode] ??= { compared: 0, identical: 0, textIdentical: 0, bothFailed: 0 });
  m.compared++;
  results.compared++;
  if (ts.error || w.error) {
    if (ts.error === w.error) {
      m.identical++;
      m.bothFailed++;
      results.identical++;
      return;
    }
    results.failed++;
    console.log(`  FAIL ${label.name}: errors: ${template(ts.error ?? "-")} | ${template(w.error ?? "-")}`);
    return;
  }
  const counter = { n: 0 };
  const problems = ts.toc
    ? diff(wellFormed(ts.toc, counter), w.toc, !!label.synthetic)
    : diff(wellFormed(ts.json, counter), w.json, !!label.synthetic);
  if (!ts.toc) {
    const wAssets = new Map(
      w.assets.map((a) => [a.id, { id: a.id, mediaType: a.mediaType, extension: a.extension, sha: createHash("sha256").update(a.bytes).digest("hex") }]),
    );
    diff([...tsAssets.values()], [...wAssets.values()], !!label.synthetic, "$assets", problems);
  }
  if (counter.n) m.illFormed = (m.illFormed ?? 0) + counter.n;
  if (problems.length) {
    results.failed++;
    console.log(`  FAIL ${label.name}: ${problems.length} mismatches`);
    for (const p of problems) console.log(`       ${p}`);
    return;
  }
  m.identical++;
  results.identical++;
}

// --- fuzzing ----------------------------------------------------------------------

function rand() {
  // xorshift32: reproducible with --seed.
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 0x100000000;
}

function mutate(bytes) {
  const b = Uint8Array.from(bytes);
  const kind = rand();
  if (kind < 0.1) return b.subarray(0, Math.floor(rand() * b.length)); // truncate
  const n = 1 + Math.floor(rand() * 16);
  for (let i = 0; i < n; i++) {
    // Bias toward the structured front of the file, where most chunks start.
    const at = rand() < 0.5 ? Math.floor(rand() * Math.min(b.length, 65536)) : Math.floor(rand() * b.length);
    const r = rand();
    if (r < 0.4) b[at] ^= 1 << Math.floor(rand() * 8);
    else if (r < 0.7) b[at] = Math.floor(rand() * 256);
    else if (r < 0.85) b[at] = [0, 0xff, 0x7f, 0x80][Math.floor(rand() * 4)];
    else for (let k = 0; k < 4 && at + k < b.length; k++) b[at + k] = 0xff;
  }
  return b;
}

// --- main -------------------------------------------------------------------------

const files = dir ? [...walk(dir)] : [];
console.log(`${files.length} files; binary ${basename(bin)}; fuzz ${fuzzCount}/file`);
let fileNo = 0;
const perFile = [];
for (const file of files) {
  fileNo++;
  const name = `file #${fileNo}`;
  const bytes = retry(() => new Uint8Array(readFileSync(file)), "read");
  const isToc = /\.onetoc2$/i.test(file);

  // json, as cli.ts: a fresh cache per file, section name from the file name.
  const cacheDir = OneNoteCache.findFor(file);
  const ts = runTs(() => {
    const store = new OneStore(bytes);
    if (store.header.fileKind === "toc") return notebookToc(store);
    const cache = cacheDir ? new OneNoteCache(cacheDir) : null;
    return new NotebookConverter(store, {
      sectionName: basename(file, extname(file)),
      includeVersions: true,
      resolveFileData: cache?.resolver(),
      onAsset: assetRef,
    }).convert();
  });
  const rust = retry(() => runRust([file, "--versions", "--asset-ids"]), "rust run");
  const ok = check({ name: `${name} json`, mode: "json" }, ts, rust);
  timing.ts += ts.ms;
  timing.rustWall += rust.wall;
  timing.rustInner += rust.inner;
  perFile.push({ name, bytes: bytes.length, ts: ts.ms, rust: rust.wall, rustInner: rust.inner, ok, textOk: rust.text === ts.text + "\n" });

  if (doRaw) {
    const tsRaw = runTs(() => dumpObjectGraph(new OneStore(bytes)));
    check({ name: `${name} raw`, mode: "raw" }, tsRaw, runRust([file, "--raw"]));
  }
  if (doToc && !isToc) {
    const tsToc = runTs(() => notebookToc(new OneStore(bytes)));
    check({ name: `${name} toc`, mode: "toc" }, tsToc, runRust([file, "--toc", "--no-cache"]));
  }
  for (let k = 0; k < fuzzCount; k++) {
    const m = mutate(bytes);
    const tsF = runTs(() => {
      const store = new OneStore(m);
      return store.header.fileKind === "toc"
        ? notebookToc(store)
        : new NotebookConverter(store, { includeVersions: true, onAsset: assetRef }).convert();
    });
    check({ name: `${name} fuzz ${k + 1}`, mode: "fuzz" }, tsF, runRust(["-", "--versions", "--asset-ids", "--no-cache"], m));
  }
  if (wasm) checkWasm({ name: `${name} wasm`, mode: "wasm", timed: true }, bytes, basename(file, extname(file)));
  const status = ok ? (perFile.at(-1).textOk ? "identical" : "equal (text differs)") : "MISMATCH";
  console.log(
    `${name}: ${status}  ${(bytes.length / 1048576).toFixed(1)} MB  ts ${ts.ms.toFixed(0)} ms  rust ${rust.wall.toFixed(0)} ms (in-process ${rust.inner.toFixed(0)} ms)`,
  );
}

if (syntheticCount) {
  const { generateSection, generateToc } = await import("./synthetic.mjs");
  const before = results.failed;
  for (let k = 0; k < syntheticCount; k++) {
    const isToc = k % 5 === 4;
    const bytes = isToc ? generateToc(1000 + k) : generateSection(1000 + k);
    const name = `synthetic #${k + 1}${isToc ? " (toc)" : ""}`;
    const convert = (b) => {
      const store = new OneStore(b);
      return store.header.fileKind === "toc"
        ? notebookToc(store)
        : new NotebookConverter(store, { includeVersions: true, onAsset: assetRef }).convert();
    };
    const label = (mode, suffix = "") => ({ name: `${name} ${mode}${suffix}`, mode: `s-${mode}`, synthetic: true });
    check(label("json"), runTs(() => convert(bytes)), runRust(["-", "--versions", "--asset-ids", "--no-cache"], bytes));
    if (doRaw) check(label("raw"), runTs(() => dumpObjectGraph(new OneStore(bytes))), runRust(["-", "--raw"], bytes));
    if (doToc && !isToc) check(label("toc"), runTs(() => notebookToc(new OneStore(bytes))), runRust(["-", "--toc", "--no-cache"], bytes));
    if (wasm) checkWasm(label("wasm"), bytes, undefined);
    for (let f = 0; f < fuzzCount; f++) {
      const m = mutate(bytes);
      check(label("fuzz", ` ${f + 1}`), runTs(() => convert(m)), runRust(["-", "--versions", "--asset-ids", "--no-cache"], m));
      if (wasm) checkWasm(label("wfuzz", ` ${f + 1}`), m, undefined);
    }
  }
  console.log(`synthetic: ${syntheticCount} files, ${results.failed - before} failed comparisons`);
}

console.log("");
for (const [mode, s] of Object.entries(modeStats)) {
  const text = /wasm|wfuzz/.test(mode) ? "" : `, ${s.textIdentical}/${s.compared} byte-identical text`;
  console.log(
    `${mode.padEnd(8)} ${s.identical}/${s.compared} equal${text}${s.bothFailed ? `, ${s.bothFailed} failed identically on both sides` : ""}${s.illFormed ? `, ${s.illFormed} lone-surrogate strings normalized` : ""}${s.textOnly ? `, ${s.textOnly} text-only differences` : ""}`,
  );
}
if (files.length) console.log(
  `json timings (sum over ${files.length} files): TypeScript ${timing.ts.toFixed(0)} ms in-process; Rust ${timing.rustWall.toFixed(0)} ms wall (spawn + read + parse + print), ${timing.rustInner.toFixed(0)} ms in-process (cache index + parse + convert + serialize)`,
);
if (wasm && files.length) {
  console.log(`wasm timings (sum over ${files.length} files, no cache): TypeScript ${wasmTiming.ts.toFixed(0)} ms, wasm ${wasmTiming.wasm.toFixed(0)} ms (both in-process in Node, including JSON object creation)`);
}
console.log(results.failed ? `FAILED: ${results.failed} of ${results.compared} comparisons` : `OK: ${results.compared} comparisons`);
process.exit(results.failed ? 1 : 0);
