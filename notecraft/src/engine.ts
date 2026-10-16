/// <reference types="vite/client" />
// The Rust document engine (crates/engine): native Tauri commands in the
// desktop app, the same code as WebAssembly in the browser (loaded the first
// time a feature needs it).
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./desktop.ts";

export interface CropRect {
  topLeftXPercentage: number;
  topLeftYPercentage: number;
  widthPercentage: number;
  heightPercentage: number;
}
export interface Shape {
  kind: "line" | "arrow" | "triangle" | "rectangle" | "diamond" | "polygon" | "ellipse";
  points: number[];
}
export interface Sealed {
  version: number;
  kdf: string;
  iterations: number;
  salt: string;
  nonce: string;
  data: string;
}
export interface PrintoutPage {
  src: string;
  widthPt: number;
  heightPt: number;
}

interface Wasm {
  default: () => Promise<unknown>;
  crop_image(bytes: Uint8Array, x: number, y: number, w: number, h: number): { bytes: Uint8Array; mediaType: string; width: number; height: number };
  render_pdf(bytes: Uint8Array, scale: number, maxPages: number): { pageCount: number; pages: { png: Uint8Array; widthPt: number; heightPt: number }[] };
  recognize_shape(points: Float32Array): Shape | null;
  to_mathml(linear: string, block: boolean): string;
  export_docx(pagesJson: string): Uint8Array;
  export_one(sectionJson: string, fileName?: string): { bytes: Uint8Array; fileName: string; warnings: string[] };
  protect(plaintext: string, password: string): string;
  unlock(sealed: string, password: string): string;
  reseal(plaintext: string, key: string, like: string): string;
}

const builds = import.meta.glob<Wasm>("./wasm/engine/notecraft_engine.js");
let wasm: Promise<Wasm> | null = null;
function engine(): Promise<Wasm> {
  wasm ??= (async () => {
    const load = Object.values(builds)[0];
    if (!load) throw new Error("This feature needs the Rust engine: run `npm run build:wasm`.");
    const m = await load();
    await m.default();
    return m;
  })();
  return wasm;
}

const toBytes = async (dataUrl: string) => new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
function toDataUrl(bytes: Uint8Array, type: string): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(s)}`;
}

export async function cropImage(src: string, rect: CropRect): Promise<{ src: string; width: number; height: number }> {
  if (desktop) return invoke("engine_crop", { src, rect });
  const out = (await engine()).crop_image(await toBytes(src), rect.topLeftXPercentage, rect.topLeftYPercentage, rect.widthPercentage, rect.heightPercentage);
  return { src: toDataUrl(out.bytes, out.mediaType), width: out.width, height: out.height };
}

export async function renderPdf(src: string, scale = 2, maxPages = 200): Promise<{ pageCount: number; pages: PrintoutPage[] }> {
  if (desktop) return invoke("engine_render_pdf", { src, scale, maxPages });
  const out = (await engine()).render_pdf(await toBytes(src), scale, maxPages);
  return { pageCount: out.pageCount, pages: out.pages.map((p) => ({ src: toDataUrl(p.png, "image/png"), widthPt: p.widthPt, heightPt: p.heightPt })) };
}

export async function recognizeShape(points: number[]): Promise<Shape | null> {
  if (desktop) return invoke("engine_recognize_shape", { points });
  return (await engine()).recognize_shape(new Float32Array(points));
}

export async function toMathML(linear: string, block = true): Promise<string> {
  if (desktop) return invoke("engine_mathml", { linear, block });
  return (await engine()).to_mathml(linear, block);
}

/** Saves through a dialog (desktop) or downloads (browser). Resolves to the path, or null. */
export async function exportDocx(pages: unknown[], name: string): Promise<string | null> {
  if (desktop) return invoke("engine_export_docx", { pages, defaultName: name });
  const bytes = (await engine()).export_docx(JSON.stringify(pages));
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/**
 * Export a section as a OneNote section file: a save dialog (desktop) or a
 * download (browser). Resolves to the saved path or file name and any
 * warnings, or null if cancelled.
 */
export async function exportOneNote(section: unknown): Promise<{ saved: string; warnings: string[] } | null> {
  if (desktop) {
    const out = await invoke<[string, string[]] | null>("engine_export_one", { section });
    return out && { saved: out[0], warnings: out[1] };
  }
  const out = (await engine()).export_one(JSON.stringify(section));
  const url = URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: "application/onenote" }));
  Object.assign(document.createElement("a"), { href: url, download: out.fileName }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { saved: out.fileName, warnings: out.warnings };
}

/** Password protect: seal under a new password. `key` re-seals while the section stays unlocked. */
export async function protect(plaintext: string, password: string): Promise<{ sealed: Sealed; key: string }> {
  if (desktop) return invoke("engine_protect", { plaintext, password });
  return JSON.parse((await engine()).protect(plaintext, password)) as { sealed: Sealed; key: string };
}

/** Open with the password. Rejects with "That password isn't right." on a wrong one. */
export async function unlock(sealed: Sealed, password: string): Promise<{ plaintext: string; key: string }> {
  if (desktop) return invoke("engine_unlock", { sealed, password });
  return JSON.parse((await engine()).unlock(JSON.stringify(sealed), password)) as { plaintext: string; key: string };
}

/** Seal again with an unlocked section's key (same salt, fresh nonce). */
export async function reseal(plaintext: string, key: string, like: Sealed): Promise<Sealed> {
  if (desktop) return invoke("engine_reseal", { plaintext, key, like });
  return JSON.parse((await engine()).reseal(plaintext, key, JSON.stringify(like))) as Sealed;
}
