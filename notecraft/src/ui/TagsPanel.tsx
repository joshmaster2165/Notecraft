// Find Tags (OneNote's Tags Summary): every tagged paragraph, grouped by tag,
// in this section, this notebook or everywhere. Click to jump to it.
import { useMemo, useState } from "react";
import type { Element, Library, NoteTag } from "../model/types.ts";
import { tagDef, tagLabel, TAGS } from "../model/tags.ts";
import { store, useStore } from "../store/store.ts";
import { selectPage } from "../store/actions.ts";
import { TagIcon } from "./editor/TagIcon.tsx";
import { Icon } from "./icons.tsx";

type Scope = "section" | "notebook" | "all";

interface Hit {
  tag: NoteTag;
  text: string;
  pageId: string;
  pageTitle: string;
  elementId: string;
}

function collect(lib: Library, scope: Scope, notebookId: string | null, sectionId: string | null): Hit[] {
  const hits: Hit[] = [];
  const walk = (els: Element[], pageId: string, pageTitle: string) => {
    for (const e of els) {
      for (const tag of e.tags ?? []) {
        const text = e.kind === "text" ? e.runs.map((r) => r.text).join("") : e.kind === "image" ? e.image.alt ?? "Picture" : e.kind === "file" ? e.name : "Table";
        hits.push({ tag, text, pageId, pageTitle, elementId: e.id });
      }
      if (e.kind === "table") for (const r of e.rows) for (const c of r.cells) walk(c.elements, pageId, pageTitle);
    }
  };
  for (const nb of lib.notebooks) {
    if (scope !== "all" && nb.id !== notebookId) continue;
    for (const s of nb.sections) {
      if (scope === "section" && s.id !== sectionId) continue;
      for (const p of s.pages) for (const o of p.outlines) walk(o.elements, p.id, p.title || "Untitled page");
    }
  }
  return hits;
}

export function TagsPanel() {
  const lib = useStore((s) => s.lib);
  const notebookId = useStore((s) => s.ui.notebookId);
  const sectionId = useStore((s) => s.ui.sectionId);
  const [scope, setScope] = useState<Scope>("notebook");
  const [openOnly, setOpenOnly] = useState(false);
  const hits = useMemo(() => collect(lib, scope, notebookId, sectionId), [lib, scope, notebookId, sectionId]);

  const groups = useMemo(() => {
    const order = new Map(TAGS.map((t, i) => [t.id, i]));
    const byKey = new Map<string, Hit[]>();
    for (const h of hits) {
      if (openOnly && (h.tag.done === undefined || h.tag.done)) continue;
      const key = h.tag.kind === "custom" ? `custom:${h.tag.label ?? ""}` : h.tag.kind;
      byKey.set(key, [...(byKey.get(key) ?? []), h]);
    }
    return [...byKey.entries()].sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99));
  }, [hits, openOnly]);

  const open = (h: Hit) => {
    selectPage(h.pageId);
    setTimeout(() => store.focus(h.elementId, 0), 40);
  };

  return (
    <aside className="versions tags-panel" aria-label="Find Tags">
      <header className="versions-head">
        <Icon.todo />
        <h2>Tags Summary</h2>
        <button className="icon-btn" aria-label="Close Tags Summary" onClick={() => store.setUi({ sidePanel: null })}>
          <Icon.close />
        </button>
      </header>
      <div className="tags-controls">
        <label>
          Search
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="section">This section</option>
            <option value="notebook">This notebook</option>
            <option value="all">All notebooks</option>
          </select>
        </label>
        <label className="tb-check">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Show only unchecked items
        </label>
      </div>
      <div className="versions-list">
        {groups.length === 0 && <p className="versions-note">No tagged notes {scope === "section" ? "in this section" : scope === "notebook" ? "in this notebook" : "yet"}. Tag a line with ⌘1–⌘9 or the Tags menu.</p>}
        {groups.map(([key, items]) => (
          <section key={key} className="tag-group">
            <h3>
              <TagIcon def={tagDef(items[0]!.tag)} /> {tagLabel(items[0]!.tag)} <span className="menu-meta">{items.length}</span>
            </h3>
            <ul>
              {items.map((h, i) => (
                <li key={`${h.elementId}-${i}`}>
                  <button className={`tag-hit${h.tag.done ? " is-done" : ""}`} onClick={() => open(h)}>
                    <span className="tag-hit-text">{h.text || "(empty line)"}</span>
                    <span className="version-meta">{h.pageTitle}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
