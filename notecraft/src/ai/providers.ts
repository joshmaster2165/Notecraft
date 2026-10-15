// AI providers and per-device AI settings. Keys are stored in the OS keychain
// by the desktop app (src-tauri/src/ai.rs); in the browser they stay in this
// browser's storage. Models are free text: providers rename them often.

export type Capability = "chat" | "vision" | "image" | "transcribe" | "video";

export const CAPABILITY_LABEL: Record<Capability, string> = {
  chat: "Writing assistant",
  vision: "Handwriting & picture text",
  image: "Image generation",
  transcribe: "Audio transcription",
  video: "Video generation",
};

export type ProviderKind = "openai" | "anthropic";

export interface ProviderDef {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** How the key is sent. */
  auth: "bearer" | "x-api-key" | "none";
  local?: boolean;
  /** Suggested models per capability (the first is the default). */
  models: Partial<Record<Capability, string[]>>;
  keyUrl?: string;
  note?: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "ollama",
    name: "Ollama (on this computer)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    auth: "none",
    local: true,
    models: { chat: ["llama3.2", "qwen2.5", "mistral"], vision: ["llama3.2-vision", "llava"] },
    note: "Free and offline. Install Ollama, then run `ollama pull llama3.2` (and `llama3.2-vision` for handwriting).",
  },
  {
    id: "lmstudio",
    name: "LM Studio (on this computer)",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    auth: "none",
    local: true,
    models: { chat: [], vision: [] },
    note: "Start LM Studio's local server and type the model name it shows.",
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: "bearer",
    models: {
      chat: ["gpt-5-mini", "gpt-5", "gpt-4.1-mini"],
      vision: ["gpt-5-mini", "gpt-4.1-mini"],
      image: ["gpt-image-1", "dall-e-3"],
      transcribe: ["gpt-4o-transcribe", "whisper-1"],
      video: ["sora-2", "sora-2-pro"],
    },
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: "x-api-key",
    models: { chat: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"], vision: ["claude-sonnet-5-5", "claude-haiku-5-5"] },
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "groq",
    name: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: "bearer",
    models: { chat: ["llama-3.3-70b-versatile"], vision: ["meta-llama/llama-4-scout-17b-16e-instruct"], transcribe: ["whisper-large-v3-turbo", "whisper-large-v3"] },
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: "bearer",
    models: { chat: ["gemini-2.5-flash", "gemini-2.5-pro"], vision: ["gemini-2.5-flash"], image: ["imagen-4.0-generate-001"] },
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "custom",
    name: "Other OpenAI-compatible service",
    kind: "openai",
    baseUrl: "",
    auth: "bearer",
    models: {},
    note: "Any service with an OpenAI-style API (OpenRouter, Together, LocalAI, vLLM…). Set its address and models.",
  },
];

export const providerDef = (id: string) => PROVIDERS.find((p) => p.id === id);

export interface ProviderSettings {
  baseUrl?: string;
  /** Model per capability, overriding the suggestion. */
  models?: Partial<Record<Capability, string>>;
}

export interface AiSettings {
  /** Which provider handles each capability. */
  use: Partial<Record<Capability, string>>;
  providers: Record<string, ProviderSettings>;
}

const KEY = "notecraft.ai";

export function loadAiSettings(): AiSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as AiSettings | null;
    if (v?.use && v.providers) return v;
  } catch {
    /* defaults */
  }
  return { use: { chat: "ollama", vision: "ollama" }, providers: {} };
}

export function saveAiSettings(s: AiSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l(s));
}

const listeners = new Set<(s: AiSettings) => void>();
export function onAiSettings(fn: (s: AiSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The provider, address and model to use for a capability, or why there is none. */
export function resolve(cap: Capability, s = loadAiSettings()): { def: ProviderDef; baseUrl: string; model: string } | { error: string } {
  const id = s.use[cap];
  const def = id ? providerDef(id) : undefined;
  if (!def) return { error: `Choose a provider for ${CAPABILITY_LABEL[cap].toLowerCase()} in Settings › AI.` };
  const ps = s.providers[def.id] ?? {};
  const baseUrl = (ps.baseUrl || def.baseUrl).replace(/\/+$/, "");
  const model = ps.models?.[cap] || def.models[cap]?.[0] || "";
  if (!baseUrl) return { error: `Set the address for ${def.name} in Settings › AI.` };
  if (!model) return { error: `Choose a ${CAPABILITY_LABEL[cap].toLowerCase()} model for ${def.name} in Settings › AI.` };
  return { def, baseUrl, model };
}
