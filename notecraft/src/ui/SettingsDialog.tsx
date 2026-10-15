// Settings: AI providers and keys, connecting agents (CLI / MCP), and where
// the library folder is. Also the Generate image / video dialog.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { store } from "../store/store.ts";
import { desktop } from "../desktop.ts";
import { chooseLibraryFolder, revealLibrary } from "../store/actions.ts";
import { CAPABILITY_LABEL, PROVIDERS, loadAiSettings, providerDef, resolve, saveAiSettings, type AiSettings, type Capability } from "../ai/providers.ts";
import { chat, keyStatus, setApiKey } from "../ai/client.ts";
import { generateImageOnPage, generateVideoOnPage } from "../ai/features.ts";
import { Modal } from "./Modal.tsx";

const close = () => store.setUi({ dialog: null });
const CAPS: Capability[] = ["chat", "vision", "transcribe", "image", "video"];

function AiTab() {
  const [s, setS] = useState<AiSettings>(loadAiSettings);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [test, setTest] = useState<Record<string, string>>({});
  useEffect(() => void keyStatus(PROVIDERS.map((p) => p.id)).then(setKeys).catch(() => {}), []);
  const update = (next: AiSettings) => (setS(next), saveAiSettings(next));
  const used = new Set(Object.values(s.use));

  const saveKey = async (id: string) => {
    try {
      await setApiKey(id, draft[id] ?? "");
      setDraft((d) => ({ ...d, [id]: "" }));
      setKeys(await keyStatus(PROVIDERS.map((p) => p.id)));
      store.toast(draft[id] ? "Key saved" + (desktop ? " in your keychain" : " in this browser") : "Key removed");
    } catch (e) {
      store.toast(String(e));
    }
  };

  const runTest = async () => {
    setTest({ chat: "Testing…" });
    try {
      const reply = await chat("Reply with exactly: OK", [{ role: "user", text: "Say OK" }]);
      setTest({ chat: reply ? `Working: “${reply.slice(0, 40)}”` : "No reply" });
    } catch (e) {
      setTest({ chat: (e as Error).message });
    }
  };

  return (
    <div className="settings-ai">
      <p className="dialog-note">
        Pick which provider does each job. Local models run on this computer and need no key. Notes are only sent when you use an AI feature, and only to the provider you picked.
        {desktop ? " Keys are kept in your system keychain." : " In the browser, keys are kept in this browser's storage; the desktop app keeps them in your system keychain."}
      </p>
      <table className="settings-table">
        <tbody>
          {CAPS.map((cap) => {
            const id = s.use[cap] ?? "";
            const def = providerDef(id);
            const options = PROVIDERS.filter((p) => p.models[cap] || p.id === "custom" || p.local);
            const model = s.providers[id]?.models?.[cap] ?? "";
            return (
              <tr key={cap}>
                <th>{CAPABILITY_LABEL[cap]}</th>
                <td>
                  <select value={id} onChange={(e) => update({ ...s, use: { ...s.use, [cap]: e.target.value || undefined } })}>
                    <option value="">Off</option>
                    {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </td>
                <td>
                  {def && (
                    <>
                      <input
                        list={`models-${cap}-${id}`}
                        value={model}
                        placeholder={def.models[cap]?.[0] ?? "model name"}
                        aria-label={`${CAPABILITY_LABEL[cap]} model`}
                        onChange={(e) => update({ ...s, providers: { ...s.providers, [id]: { ...s.providers[id], models: { ...s.providers[id]?.models, [cap]: e.target.value } } } })}
                      />
                      <datalist id={`models-${cap}-${id}`}>{(def.models[cap] ?? []).map((m) => <option key={m} value={m} />)}</datalist>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="settings-row">
        <button className="btn" onClick={() => void runTest()} disabled={"error" in resolve("chat", s)}>Test the writing assistant</button>
        {test.chat && <span className="menu-meta">{test.chat}</span>}
      </div>
      <h3 className="settings-h">Providers</h3>
      {PROVIDERS.filter((p) => used.has(p.id) || p.id === "openai" || p.id === "anthropic" || p.id === "ollama").map((p) => (
        <div key={p.id} className={`provider-row${used.has(p.id) ? " is-used" : ""}`}>
          <div className="provider-name">
            <b>{p.name}</b> {p.auth !== "none" && <span className={`key-state${keys[p.id] ? " is-set" : ""}`}>{keys[p.id] ? "key saved" : "no key"}</span>}
            {p.note && <p className="menu-meta">{p.note}</p>}
          </div>
          {(p.local || p.id === "custom") && (
            <input
              className="provider-url"
              value={s.providers[p.id]?.baseUrl ?? ""}
              placeholder={p.baseUrl || "https://…/v1"}
              aria-label={`${p.name} address`}
              onChange={(e) => update({ ...s, providers: { ...s.providers, [p.id]: { ...s.providers[p.id], baseUrl: e.target.value } } })}
            />
          )}
          {p.auth !== "none" && (
            <form className="provider-key" onSubmit={(e) => (e.preventDefault(), void saveKey(p.id))}>
              <input type="password" autoComplete="off" value={draft[p.id] ?? ""} placeholder={keys[p.id] ? "•••••••• (saved)" : "API key"} aria-label={`${p.name} API key`} onChange={(e) => setDraft((d) => ({ ...d, [p.id]: e.target.value }))} />
              <button className="btn" type="submit">{draft[p.id] ? "Save" : keys[p.id] ? "Remove" : "Save"}</button>
              {p.keyUrl && <a className="menu-meta" href={p.keyUrl} target="_blank" rel="noreferrer">Get a key</a>}
            </form>
          )}
        </div>
      ))}
    </div>
  );
}

function AgentsTab() {
  const [info, setInfo] = useState<{ cli: string; library: string; mcp: unknown } | null>(null);
  useEffect(() => {
    if (desktop) void invoke<{ cli: string; library: string; mcp: unknown }>("agent_setup").then(setInfo).catch(() => {});
  }, []);
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => store.toast("Copied"));
  if (!desktop) return <p className="dialog-note">Agents connect to the desktop app's library folder. Install Notecraft for macOS, Windows or Linux to use the `notecraft` command and its MCP server.</p>;
  const cli = info?.cli ?? "notecraft";
  const mcpJson = JSON.stringify(info?.mcp ?? {}, null, 2);
  const claudeCode = `claude mcp add notecraft -- "${cli}" mcp`;
  return (
    <div className="settings-agents">
      <p className="dialog-note">AI agents and scripts can search, read and write your notes, and ask this window to show a page. Changes appear here within a second.</p>
      <h3 className="settings-h">MCP (Claude, Cursor, other agents)</h3>
      <p className="menu-meta">Add this to your client's MCP configuration (for Claude Desktop: Settings › Developer › Edit Config):</p>
      <pre className="code-block">{mcpJson}</pre>
      <div className="settings-row">
        <button className="btn" onClick={() => copy(mcpJson)}>Copy configuration</button>
        <button className="btn" onClick={() => copy(claudeCode)}>Copy Claude Code command</button>
      </div>
      <h3 className="settings-h">Command line</h3>
      <pre className="code-block">{`"${cli}" list\n"${cli}" search "launch plan"\n"${cli}" new-page "Work/Meetings" "Standup" "- [ ] Ship it"\n"${cli}" todos --json`}</pre>
      <p className="menu-meta">Tools: outline, search, read page (Markdown), to-dos, create page, append, check to-do, rename, delete (to Deleted Notes), create section or notebook, open page, show search.</p>
    </div>
  );
}

function LibraryTab() {
  const [info, setInfo] = useState<{ path: string } | null>(null);
  useEffect(() => void desktop?.library.info().then(setInfo).catch(() => {}), []);
  if (!desktop) return <p className="dialog-note">In the browser your library is stored in this browser. The desktop app keeps it as ordinary files in a folder you choose.</p>;
  return (
    <div>
      <p className="dialog-note">Your notes are plain files in this folder: one JSON file per page, pictures and recordings as normal files. Back it up, sync it with any service, or point agents at it.</p>
      <pre className="code-block">{info?.path ?? "…"}</pre>
      <div className="settings-row">
        <button className="btn" onClick={revealLibrary}>Show in {desktop.platform === "darwin" ? "Finder" : "file manager"}</button>
        <button className="btn" onClick={() => void chooseLibraryFolder()}>Change folder…</button>
      </div>
    </div>
  );
}

export function SettingsDialog({ tab: initial }: { tab: "ai" | "agents" | "library" }) {
  const [tab, setTab] = useState(initial);
  return (
    <Modal title="Settings" onClose={close}>
      <div className="search-scope settings-tabs" role="tablist">
        {(["ai", "agents", "library"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "is-on" : ""} onClick={() => setTab(t)}>
            {t === "ai" ? "AI" : t === "agents" ? "Agents" : "Library"}
          </button>
        ))}
      </div>
      {tab === "ai" ? <AiTab /> : tab === "agents" ? <AgentsTab /> : <LibraryTab />}
    </Modal>
  );
}

export function GenerateDialog({ media }: { media: "image" | "video" }) {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [seconds, setSeconds] = useState(4);
  const [busy, setBusy] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const cap = media === "image" ? "image" : "video";
  const r = resolve(cap);
  const go = async () => {
    if (!prompt.trim()) return;
    setBusy("Starting…");
    abort.current = new AbortController();
    try {
      if (media === "image") {
        setBusy("Generating…");
        await generateImageOnPage(prompt.trim(), size);
      } else {
        await generateVideoOnPage(prompt.trim(), seconds, (pct, status) => setBusy(`${status === "queued" ? "Queued" : status === "downloading" ? "Downloading" : "Rendering"}… ${Math.round(pct)}%`), abort.current.signal);
      }
      close();
      store.toast(media === "image" ? "Picture added" : "Video added");
    } catch (e) {
      setBusy(null);
      store.toast((e as Error).message ?? String(e));
    }
  };
  return (
    <Modal
      title={media === "image" ? "Generate a picture" : "Generate a video"}
      onClose={() => (abort.current?.abort(), close())}
      footer={
        <>
          <span className="menu-meta">{"error" in r ? r.error : `${providerDef(r.def.id)?.name} · ${r.model}`}</span>
          <span className="tb-spacer" />
          <button className="btn" onClick={() => store.setUi({ dialog: { kind: "settings", tab: "ai" } })}>Settings</button>
          <button className="btn btn-primary" disabled={!!busy || "error" in r || !prompt.trim()} onClick={() => void go()}>{busy ?? "Generate"}</button>
        </>
      }
    >
      <label className="prompt-field">
        Describe {media === "image" ? "the picture" : "the clip"}
        <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={media === "image" ? "A watercolor map of a small harbor town at sunrise" : "A slow pan across a desk with notebooks and coffee, morning light"} />
      </label>
      {media === "image" ? (
        <label className="prompt-field">
          Size
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            <option value="1024x1024">Square</option>
            <option value="1536x1024">Landscape</option>
            <option value="1024x1536">Portrait</option>
          </select>
        </label>
      ) : (
        <label className="prompt-field">
          Length
          <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
            <option value={4}>4 seconds</option>
            <option value={8}>8 seconds</option>
            <option value={12}>12 seconds</option>
          </select>
        </label>
      )}
      <p className="menu-meta">The result is added to the current page and saved in your library. Generation can take a while and may cost credits with your provider.</p>
    </Modal>
  );
}
