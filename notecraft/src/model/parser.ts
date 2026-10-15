/// <reference types="vite/client" />
// Which .one parser runs in the browser: the Rust one compiled to
// WebAssembly (`npm run build:wasm`), or, when that build isn't present, the
// TypeScript reference parser it was ported from. Both produce the same JSON.
import type { NotebookJson } from "@re/parser/src/notebook.ts";
import type { NotebookToc } from "@re/parser/src/toc.ts";

interface WasmModule {
  default: () => Promise<unknown>;
  parse_one_note(bytes: Uint8Array, sectionName: string | undefined, includeVersions: boolean): { json: NotebookJson; assets: { id: string; mediaType: string; bytes: Uint8Array }[] };
  parse_notebook_toc(bytes: Uint8Array): NotebookToc;
}

const builds = import.meta.glob<WasmModule>("../wasm/onenote_re/onenote_re.js");
let wasm: Promise<WasmModule | null> | null = null;

function loadWasm(): Promise<WasmModule | null> {
  wasm ??= (async () => {
    const load = Object.values(builds)[0];
    if (!load) return null;
    try {
      const m = await load();
      await m.default();
      return m;
    } catch (e) {
      console.warn("Notecraft: WebAssembly parser unavailable, using the TypeScript parser", e);
      return null;
    }
  })();
  return wasm;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface ParsedSection {
  json: NotebookJson;
  /** Asset id → data: URL. */
  assets: Map<string, string>;
  engine: "rust" | "typescript";
}

export async function parseSection(bytes: Uint8Array, fileName: string): Promise<ParsedSection> {
  const assets = new Map<string, string>();
  const w = await loadWasm();
  if (w) {
    const out = w.parse_one_note(bytes, fileName, true);
    for (const a of out.assets) assets.set(a.id, `data:${a.mediaType};base64,${toBase64(a.bytes)}`);
    return { json: out.json, assets, engine: "rust" };
  }
  const { parseOneNote } = await import("@re/parser/src/notebook.ts");
  const json = parseOneNote(bytes, {
    sectionName: fileName,
    includeVersions: true,
    onAsset: ({ id, bytes: data, mediaType }) => {
      assets.set(id, `data:${mediaType};base64,${toBase64(data)}`);
      return id;
    },
  });
  return { json, assets, engine: "typescript" };
}

export async function parseToc(bytes: Uint8Array): Promise<NotebookToc> {
  const w = await loadWasm();
  if (w) return w.parse_notebook_toc(bytes);
  const { parseNotebookToc } = await import("@re/parser/src/toc.ts");
  return parseNotebookToc(bytes);
}
