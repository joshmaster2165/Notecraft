// The writing assistant: summarize, find action items, rewrite, translate or
// ask about the selection, page, section or notebook, then put the answer
// into your notes.
import { useEffect, useRef, useState } from "react";
import { store, useStore } from "../store/store.ts";
import { ASSIST_ACTIONS, askNotes, assist, insertMarkdown, newPageFromMarkdown, scopeText, type AssistScope } from "../ai/features.ts";
import { CAPABILITY_LABEL, loadAiSettings, onAiSettings, providerDef, resolve } from "../ai/providers.ts";
import { Icon } from "./icons.tsx";
import { markdownToElements } from "../lib/markdown.ts";
import { runsToHtml } from "../lib/richtext.ts";

interface Result {
  id: number;
  title: string;
  text?: string;
  error?: string;
  busy?: boolean;
}

const SCOPES: [AssistScope, string][] = [["selection", "Selection"], ["page", "Page"], ["section", "Section"], ["notebook", "Notebook"]];
const LANGUAGES = ["English", "Spanish", "French", "German", "Italian", "Portuguese", "Chinese", "Japanese", "Korean", "Hebrew", "Arabic", "Hindi"];

let seq = 0;

/** The answer as it will look once inserted: headings, lists, to-dos, emphasis. */
function MarkdownPreview({ text }: { text: string }) {
  const els = markdownToElements(text);
  return (
    <div className="assist-text">
      {els.map((e) => {
        if (e.kind !== "text") return null;
        const html = runsToHtml(e.runs);
        const todo = e.tags?.find((t) => t.done !== undefined);
        const marker = todo ? (todo.done ? "☑" : "☐") : e.list?.kind === "bullet" ? "•" : e.list?.kind === "numbered" ? "–" : "";
        const Tag = e.style.startsWith("h") ? "strong" : "span";
        return (
          <p key={e.id} className={`md-line md-${e.style}`} style={{ paddingLeft: e.depth * 14 + (marker ? 16 : 0) }}>
            {marker && <span className="md-marker">{marker}</span>}
            <Tag dangerouslySetInnerHTML={{ __html: html }} />
          </p>
        );
      })}
    </div>
  );
}

export function AssistantPanel() {
  const pageId = useStore((s) => s.ui.pageId);
  const [scope, setScope] = useState<AssistScope>("page");
  const [question, setQuestion] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [settings, setSettings] = useState(loadAiSettings);
  const selection = useRef<{ text: string; range: Range | null }>({ text: "", range: null });
  useEffect(() => onAiSettings(setSettings), []);

  // Remember the last text selection in the page, since clicking here moves focus.
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      const inPage = node && (node.nodeType === 1 ? (node as HTMLElement) : node.parentElement)?.closest(".oe-editable");
      if (sel && inPage && !sel.isCollapsed) selection.current = { text: sel.toString(), range: sel.getRangeAt(0).cloneRange() };
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const chat = resolve("chat", settings);
  const using = "error" in chat ? null : `${providerDef(chat.def.id)?.name ?? chat.def.id} · ${chat.model}`;

  const run = async (title: string, job: (notes: string) => Promise<string>) => {
    const effectiveScope = scope === "selection" && !selection.current.text ? "page" : scope;
    const { text, label } = scopeText(effectiveScope, selection.current.text);
    const id = ++seq;
    setResults((r) => [{ id, title: `${title} · ${label}`, busy: true }, ...r]);
    try {
      const answer = await job(text);
      setResults((r) => r.map((x) => (x.id === id ? { ...x, busy: false, text: answer } : x)));
    } catch (e) {
      setResults((r) => r.map((x) => (x.id === id ? { ...x, busy: false, error: (e as Error).message ?? String(e) } : x)));
    }
  };

  const ask = () => {
    const q = question.trim();
    if (!q) return;
    setQuestion("");
    void run(q, (notes) => askNotes(q, notes));
  };

  const replaceSelection = (text: string) => {
    const { range } = selection.current;
    if (range) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand("delete");
    }
    insertMarkdown(text);
  };

  return (
    <aside className="versions assistant-panel" aria-label="Assistant">
      <header className="versions-head">
        <Icon.sparkle />
        <h2>Assistant</h2>
        <button className="icon-btn" aria-label="AI settings" title="AI settings" onClick={() => store.setUi({ dialog: { kind: "settings", tab: "ai" } })}>
          <Icon.gear />
        </button>
        <button className="icon-btn" aria-label="Close Assistant" onClick={() => store.setUi({ sidePanel: null })}>
          <Icon.close />
        </button>
      </header>
      <div className="assist-body">
        <p className="assist-using">
          {using ? <>Using {using}</> : <>{"error" in chat ? chat.error : ""} <button className="link-btn" onClick={() => store.setUi({ dialog: { kind: "settings", tab: "ai" } })}>Set up AI</button></>}
        </p>
        <div className="search-scope assist-scope" role="radiogroup" aria-label="Work on">
          {SCOPES.map(([v, l]) => (
            <button key={v} role="radio" aria-checked={scope === v} className={scope === v ? "is-on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => setScope(v)}>{l}</button>
          ))}
        </div>
        <div className="assist-actions">
          {ASSIST_ACTIONS.map((a) => (
            <button key={a.id} className="btn" disabled={!using || !pageId} onMouseDown={(e) => e.preventDefault()} onClick={() => void run(a.label, (notes) => assist(a.prompt, notes))}>
              {a.label}
            </button>
          ))}
          <select
            className="btn"
            disabled={!using || !pageId}
            value=""
            aria-label="Translate to"
            onChange={(e) => {
              const lang = e.target.value;
              if (lang) void run(`Translate to ${lang}`, (notes) => assist(`Translate these notes into ${lang}. Keep the Markdown structure.`, notes));
            }}
          >
            <option value="">Translate to…</option>
            {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
          </select>
        </div>
        <form className="assist-ask" onSubmit={(e) => (e.preventDefault(), ask())}>
          <textarea
            value={question}
            placeholder={`Ask about this ${scope}…`}
            rows={2}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), ask())}
          />
          <button className="btn btn-primary" disabled={!using || !question.trim()}>Ask</button>
        </form>
        <div className="assist-results">
          {!results.length && <p className="versions-note">Answers appear here. Nothing is sent anywhere until you pick an action, and only to the provider you chose for the {CAPABILITY_LABEL.chat.toLowerCase()}.</p>}
          {results.map((r) => (
            <section key={r.id} className={`assist-card${r.error ? " is-error" : ""}`}>
              <h3>{r.title}</h3>
              {r.busy && <p className="assist-busy"><span className="spinner" /> Thinking…</p>}
              {r.error && <p className="assist-error">{r.error}</p>}
              {r.text && (
                <>
                  <MarkdownPreview text={r.text} />
                  <div className="assist-card-actions">
                    <button className="btn" onClick={() => insertMarkdown(r.text!)}>Insert on page</button>
                    {scope === "selection" && selection.current.range && <button className="btn" onClick={() => replaceSelection(r.text!)}>Replace selection</button>}
                    <button className="btn" onClick={() => newPageFromMarkdown(r.title.split(" · ")[0]!, r.text!)}>New page</button>
                    <button className="btn" onClick={() => void navigator.clipboard.writeText(r.text!).then(() => store.toast("Copied"))}>Copy</button>
                  </div>
                </>
              )}
            </section>
          ))}
        </div>
      </div>
    </aside>
  );
}
