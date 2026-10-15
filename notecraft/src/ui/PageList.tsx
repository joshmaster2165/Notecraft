// Pages of the current section, in PageSeriesNode order, indented by PageLevel.
import { useState } from "react";
import * as ops from "../model/ops.ts";
import { store, useStore } from "../store/store.ts";
import { deletePage, newPage, selectPage } from "../store/actions.ts";
import { Icon } from "./icons.tsx";

const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export function PageList() {
  const sectionId = useStore((s) => s.ui.sectionId);
  const pageId = useStore((s) => s.ui.pageId);
  const section = useStore((s) => (s.ui.sectionId ? ops.findSection(s.lib, s.ui.sectionId)?.section : undefined));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (!section || !sectionId) return <aside className="pagelist" />;

  return (
    <aside className="pagelist" aria-label={`Pages in ${section.name}`}>
      <header className="pagelist-head">
        <span className="section-tab" style={{ background: section.color }} />
        <h2 title={section.source ? `Imported from ${section.source.file}` : undefined}>{section.name}</h2>
        <button className="btn-add-page" onClick={() => newPage()} title="Add page">
          <Icon.plus width={16} height={16} /> Page
        </button>
      </header>
      <ol className="pages" onDragLeave={() => setDropIndex(null)}>
        {section.pages.map((p, i) => (
          <li
            key={p.id}
            className={`page-item level-${p.level}${p.id === pageId ? " is-active" : ""}${dropIndex === i ? " drop-before" : ""}`}
            draggable
            onDragStart={(e) => {
              setDragId(p.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setDropIndex(e.clientY > r.top + r.height / 2 ? i + 1 : i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && dropIndex !== null) store.edit((d) => ops.movePage(d, dragId, dropIndex));
              setDragId(null);
              setDropIndex(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropIndex(null);
            }}
          >
            <button className="page-btn" onClick={() => selectPage(p.id)} aria-current={p.id === pageId ? "page" : undefined}>
              <span className={`page-title-line${p.title ? "" : " is-untitled"}`}>{p.title || "Untitled page"}</span>
              <span className="page-meta">{short.format(new Date(p.modifiedAt))}</span>
            </button>
            <span className="page-actions">
              {p.level > 1 ? (
                <button className="icon-btn" title="Promote" aria-label="Promote page" onClick={() => store.edit((d) => ops.setPageLevel(d, p.id, -1))}>
                  <Icon.unsubpage width={16} height={16} />
                </button>
              ) : null}
              {i > 0 && p.level < 3 && (
                <button className="icon-btn" title="Make subpage" aria-label="Make subpage" onClick={() => store.edit((d) => ops.setPageLevel(d, p.id, 1))}>
                  <Icon.subpage width={16} height={16} />
                </button>
              )}
              <button className="icon-btn" title="Delete page" aria-label="Delete page" onClick={() => deletePage(p.id)}>
                <Icon.trash width={16} height={16} />
              </button>
            </span>
          </li>
        ))}
        {dropIndex === section.pages.length && <li className="drop-end" />}
      </ol>
    </aside>
  );
}
