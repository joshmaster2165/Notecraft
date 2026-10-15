// ⌘E: search this section, this notebook or every notebook (titles, text,
// table cells and image OCR text).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Element, Library, Page } from "../model/types.ts";
import { pageText } from "../model/ops.ts";
import { store, useStore } from "../store/store.ts";
import { selectPage } from "../store/actions.ts";
import { Icon } from "./icons.tsx";

interface Hit {
  page: Page;
  where: string;
  snippet: [string, string, string];
  elementId?: string;
  offset?: number;
}

function findElement(page: Page, q: string): { id: string; offset: number } | undefined {
  const walk = (els: Element[]): { id: string; offset: number } | undefined => {
    for (const e of els) {
      if (e.kind === "text") {
        const i = e.runs.map((r) => r.text).join("").toLowerCase().indexOf(q);
        if (i >= 0) return { id: e.id, offset: i };
      } else if (e.kind === "table") {
        for (const r of e.rows) for (const c of r.cells) {
          const hit = walk(c.elements);
          if (hit) return hit;
        }
      }
    }
    return undefined;
  };
  for (const o of page.outlines) {
    const hit = walk(o.elements);
    if (hit) return hit;
  }
  return undefined;
}

export type SearchScope = "section" | "notebook" | "all";
const SCOPES: [SearchScope, string][] = [["section", "This section"], ["notebook", "This notebook"], ["all", "All notebooks"]];
let lastScope: SearchScope = "all";

function search(lib: Library, query: string, scope: SearchScope, notebookId: string | null, sectionId: string | null): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Hit[] = [];
  for (const nb of lib.notebooks) {
    if (scope !== "all" && nb.id !== notebookId) continue;
    for (const s of nb.sections) {
      if (scope === "section" && s.id !== sectionId) continue;
      for (const page of s.pages) {
        const text = pageText(page);
        const i = text.toLowerCase().indexOf(q);
        if (i < 0) continue;
        const start = Math.max(0, i - 40);
        const before = (start > 0 ? "…" : "") + text.slice(start, i).replace(/\s+/g, " ");
        const after = text.slice(i + q.length, i + q.length + 80).replace(/\s+/g, " ");
        const el = findElement(page, q);
        hits.push({ page, where: `${nb.name} › ${s.name}`, snippet: [before, text.slice(i, i + q.length), after], ...(el ? { elementId: el.id, offset: el.offset } : {}) });
        if (hits.length >= 60) return hits;
      }
    }
  }
  return hits;
}

export function SearchPanel() {
  const lib = useStore((s) => s.lib);
  const notebookId = useStore((s) => s.ui.notebookId);
  const sectionId = useStore((s) => s.ui.sectionId);
  const [scope, setScopeState] = useState<SearchScope>(lastScope);
  const setScope = (v: SearchScope) => (setScopeState(v), (lastScope = v), input.current?.focus());
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => search(lib, query, scope, notebookId, sectionId), [lib, query, scope, notebookId, sectionId]);
  const label = scope === "section" ? "Search this section" : scope === "notebook" ? "Search this notebook" : "Search all notebooks";
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setCursor(0), [query, scope]);

  const close = () => store.setUi({ searchOpen: false });
  const open = (h: Hit) => {
    close();
    selectPage(h.page.id);
    if (h.elementId) setTimeout(() => store.focus(h.elementId!, h.offset ?? 0), 30);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="search" role="dialog" aria-modal="true" aria-label={label}>
        <label className="search-box">
          <Icon.search />
          <input
            ref={input}
            value={query}
            placeholder={label}
            aria-label={label}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(hits.length - 1, c + 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(0, c - 1)));
              if (e.key === "Enter" && hits[cursor]) open(hits[cursor]!);
            }}
          />
          <kbd>esc</kbd>
        </label>
        <div className="search-scope" role="radiogroup" aria-label="Search in">
          {SCOPES.map(([v, l]) => (
            <button key={v} role="radio" aria-checked={scope === v} className={scope === v ? "is-on" : ""} onClick={() => setScope(v)}>{l}</button>
          ))}
        </div>
        {query.trim() && (
          <ul className="search-results" role="listbox">
            {hits.length === 0 && <li className="search-empty">No pages {scope === "all" ? "" : scope === "section" ? "in this section " : "in this notebook "}match “{query.trim()}”.</li>}
            {hits.map((h, i) => (
              <li key={h.page.id} role="option" aria-selected={i === cursor} className={i === cursor ? "is-cursor" : ""} onMouseEnter={() => setCursor(i)} onClick={() => open(h)}>
                <div className="hit-title">{h.page.title || "Untitled page"}</div>
                <div className="hit-where">{h.where}</div>
                <div className="hit-snippet">
                  {h.snippet[0]}
                  <mark>{h.snippet[1]}</mark>
                  {h.snippet[2]}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
