// Calls to AI providers. Requests are built here; the desktop app sends them
// from Rust with the key from the OS keychain, the browser sends them itself.
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "../desktop.ts";
import { resolve, type Capability, type ProviderDef } from "./providers.ts";

interface HttpRequest {
  provider: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  json?: unknown;
  multipart?: { name: string; value?: string; filename?: string; dataUrl?: string }[];
  auth: ProviderDef["auth"];
  binary?: boolean;
  timeoutSecs?: number;
}
interface HttpResponse {
  status: number;
  contentType: string;
  body: string;
}

// --- keys ---------------------------------------------------------------------------------

const BROWSER_KEYS = "notecraft.ai.keys";
const browserKeys = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(BROWSER_KEYS) ?? "{}");
  } catch {
    return {};
  }
};

export async function setApiKey(provider: string, key: string): Promise<void> {
  if (desktop) return invoke("ai_key_set", { provider, key });
  const keys = browserKeys();
  if (key.trim()) keys[provider] = key.trim();
  else delete keys[provider];
  localStorage.setItem(BROWSER_KEYS, JSON.stringify(keys));
}

export async function keyStatus(providers: string[]): Promise<Record<string, boolean>> {
  if (desktop) return invoke("ai_key_status", { providers });
  const keys = browserKeys();
  return Object.fromEntries(providers.map((p) => [p, !!keys[p]]));
}

// --- transport ------------------------------------------------------------------------------

async function send(req: HttpRequest): Promise<HttpResponse> {
  if (desktop) return invoke<HttpResponse>("ai_http", { req });
  const headers: Record<string, string> = { ...req.headers };
  const key = browserKeys()[req.provider];
  if (req.auth !== "none") {
    if (!key) throw new Error(`No API key saved for ${req.provider}. Add one in Settings › AI.`);
    if (req.auth === "x-api-key") {
      headers["x-api-key"] = key;
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    } else headers.Authorization = `Bearer ${key}`;
  }
  let body: BodyInit | undefined;
  if (req.multipart) {
    const form = new FormData();
    for (const p of req.multipart) {
      if (p.value !== undefined) form.append(p.name, p.value);
      else if (p.dataUrl) form.append(p.name, await (await fetch(p.dataUrl)).blob(), p.filename ?? "file");
    }
    body = form;
  } else if (req.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.json);
  }
  const res = await fetch(req.url, { method: req.method ?? "POST", headers, body });
  const contentType = res.headers.get("content-type") ?? "";
  if (req.binary && res.ok) {
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((ok) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.readAsDataURL(blob);
    });
    return { status: res.status, contentType, body: dataUrl };
  }
  return { status: res.status, contentType, body: await res.text() };
}

function errorText(res: HttpResponse): string {
  try {
    const j = JSON.parse(res.body);
    return j.error?.message ?? j.error ?? j.message ?? res.body.slice(0, 300);
  } catch {
    return res.body.slice(0, 300) || `HTTP ${res.status}`;
  }
}

async function sendJson<T>(req: HttpRequest): Promise<T> {
  const res = await send(req);
  if (res.status >= 400) throw new Error(`${req.provider}: ${errorText(res)}`);
  return JSON.parse(res.body) as T;
}

function setup(cap: Capability) {
  const r = resolve(cap);
  if ("error" in r) throw new Error(r.error);
  return r;
}

// --- chat and vision ------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Pictures for vision requests, as data: URLs. */
  images?: string[];
}

/** One reply from the chat (or, with images, the vision) model. */
export async function chat(system: string, messages: ChatMessage[], cap: "chat" | "vision" = "chat"): Promise<string> {
  const { def, baseUrl, model } = setup(cap);
  if (def.kind === "anthropic") {
    const res = await sendJson<{ content: { type: string; text?: string }[] }>({
      provider: def.id,
      url: `${baseUrl}/messages`,
      auth: def.auth,
      headers: { "anthropic-version": "2023-06-01" },
      json: {
        model,
        max_tokens: 4096,
        system,
        messages: messages.map((m) => ({
          role: m.role,
          content: [
            ...(m.images ?? []).map((url) => {
              const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/.exec(url) ?? [];
              return { type: "image", source: { type: "base64", media_type: mediaType, data } };
            }),
            { type: "text", text: m.text },
          ],
        })),
      },
    });
    return res.content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  }
  const res = await sendJson<{ choices: { message: { content: string | { type: string; text?: string }[] } }[] }>({
    provider: def.id,
    url: `${baseUrl}/chat/completions`,
    auth: def.auth,
    json: {
      model,
      messages: [
        { role: "system", content: system },
        ...messages.map((m) => ({
          role: m.role,
          content: m.images?.length ? [{ type: "text", text: m.text }, ...m.images.map((url) => ({ type: "image_url", image_url: { url } }))] : m.text,
        })),
      ],
    },
  });
  const content = res.choices[0]?.message.content ?? "";
  return (typeof content === "string" ? content : content.map((c) => c.text ?? "").join("")).trim();
}

// --- images, audio, video --------------------------------------------------------------------

/** A generated picture as a data: URL. */
export async function generateImage(prompt: string, size = "1024x1024"): Promise<string> {
  const { def, baseUrl, model } = setup("image");
  const res = await sendJson<{ data: { b64_json?: string; url?: string }[] }>({
    provider: def.id,
    url: `${baseUrl}/images/generations`,
    auth: def.auth,
    timeoutSecs: 300,
    json: { model, prompt, size, n: 1, ...(model.startsWith("dall-e") ? { response_format: "b64_json" } : {}) },
  });
  const item = res.data[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url) {
    const img = await send({ provider: def.id, url: item.url, method: "GET", auth: "none", binary: true });
    return img.body;
  }
  throw new Error("The provider returned no image.");
}

export interface Transcript {
  text: string;
  segments?: { start: number; end: number; text: string }[];
}

/** Speech to text for a recording (data: URL). */
export async function transcribe(audio: string, fileName: string): Promise<Transcript> {
  const { def, baseUrl, model } = setup("transcribe");
  const verbose = /whisper/i.test(model);
  const res = await sendJson<{ text: string; segments?: { start: number; end: number; text: string }[] }>({
    provider: def.id,
    url: `${baseUrl}/audio/transcriptions`,
    auth: def.auth,
    timeoutSecs: 600,
    multipart: [
      { name: "model", value: model },
      { name: "response_format", value: verbose ? "verbose_json" : "json" },
      { name: "file", filename: fileName, dataUrl: audio },
    ],
  });
  return { text: res.text.trim(), ...(res.segments?.length ? { segments: res.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })) } : {}) };
}

/**
 * A generated video clip as a data: URL (OpenAI's video API: create, poll,
 * download). Calls `onProgress` with 0–100 while the provider renders.
 */
export async function generateVideo(prompt: string, seconds: number, onProgress: (pct: number, status: string) => void, signal?: AbortSignal): Promise<string> {
  const { def, baseUrl, model } = setup("video");
  let job = await sendJson<{ id: string; status: string; progress?: number; error?: { message?: string } }>({
    provider: def.id,
    url: `${baseUrl}/videos`,
    auth: def.auth,
    json: { model, prompt, seconds: String(seconds) },
  });
  while (job.status === "queued" || job.status === "in_progress") {
    if (signal?.aborted) throw new Error("Cancelled");
    onProgress(job.progress ?? 0, job.status);
    await new Promise((r) => setTimeout(r, 5000));
    job = await sendJson({ provider: def.id, url: `${baseUrl}/videos/${job.id}`, method: "GET", auth: def.auth });
  }
  if (job.status !== "completed") throw new Error(job.error?.message ?? `Video ${job.status}`);
  onProgress(100, "downloading");
  const res = await send({ provider: def.id, url: `${baseUrl}/videos/${job.id}/content`, method: "GET", auth: def.auth, binary: true, timeoutSecs: 600 });
  if (res.status >= 400) throw new Error(errorText(res));
  return res.body.replace(/^data:application\/octet-stream/, "data:video/mp4");
}
