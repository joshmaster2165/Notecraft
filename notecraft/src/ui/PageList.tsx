// Pages of the current section, in PageSeriesNode order, indented by PageLevel.
import { useState } from "react";
import * as ops from "../model/ops.ts";
import { store, useStore } from "../store/store.ts";
import { deletePage, newPage, selectPage } from "../store/actions.ts";
import { copyPageLink } from "../store/links.ts";
import { Icon } from "./icons.tsx";
import { desktop } from "../desktop.ts";
import { lockState, useLockVersion } from "../store/locks.ts";
import { useLayout } from "./layout.ts";
import { CollapseButton, PaneRail, PaneResizer } from "./PaneChrome.tsx";

const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export function PageList() {
  const sectionId = useStore((s) => s.ui.sectionId);
  const pageId = useStore((s) => s.ui.pageId);
  const section = useStore((s) => (s.ui.sectionId ? ops.findSection(s.lib, s.ui.sectionId)?.section : undefined));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  useLockVersion();
  const collapsed = useLayout().pages.collapsed;

  if (collapsed) {
    return (
      <aside className="pagelist is-collapsed" aria-label="Pages (hidden)">
        <PaneRail pane="pages" label={section?.name ?? "Pages"} color={section?.color} />
      </aside>
    );
  }
  if (!section || !sectionId) return <aside className="pagelist"><PaneResizer pane="pages" /></aside>;
  if (lockState(section) === "locked") {
    return (
      <aside className="pagelist" aria-label={`${section.name} (locked)`}>
        {desktop && <div className="drag-strip" data-tauri-drag-region />}
        <header className="pagelist-head">
          <span className="section-tab" style={{ background: section.color }} />
          <h2>{section.name}</h2>
          <CollapseButton pane="pages" />
        </header>
        <p className="pagelist-locked"><Icon.lock width={16} height={16} /> This section is locked.</p>
        <PaneResizer pane="pages" />
      </aside>
    );
  }

  return (
    <aside className="pagelist" aria-label={`Pages in ${section.name}`}>
      {desktop && <div className="drag-strip" data-tauri-drag-region />}
      <header className="pagelist-head">
        <span className="section-tab" style={{ background: section.color }} />
        <h2 title={section.source ? `Imported from ${section.source.file}` : undefined}>{section.name}</h2>
        <span className="split-btn">
          <button className="btn-add-page" onClick={() => newPage()} title="Add page">
            <Icon.plus width={16} height={16} /> Page
          </button>
          <button className="btn-add-page split-caret" onClick={() => store.setUi({ dialog: { kind: "templates" } })} title="New page from a template" aria-label="Page templates">
            <Icon.chevron width={14} height={14} />
          </button>
        </span>
          <CollapseButton pane="pages" />
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
              <button className="icon-btn" title="More" aria-label={`${p.title || "Untitled page"} options`} onClick={() => setMenuFor(menuFor === p.id ? null : p.id)}>
                <Icon.more width={16} height={16} />
              </button>
            </span>
            {menuFor === p.id && (
              <div className="menu page-menu" role="menu" onMouseLeave={() => setMenuFor(null)}>
                <button onClick={() => (void copyPageLink(p.id), setMenuFor(null))}><Icon.link width={16} height={16} /> Copy link to page</button>
                <button onClick={() => (store.setUi({ dialog: { kind: "movePage", pageId: p.id } }), setMenuFor(null))}><Icon.move width={16} height={16} /> Move or copy…</button>
                <button onClick={() => (selectPage(p.id), newPage({ asSubpage: true }), setMenuFor(null))}><Icon.subpage width={16} height={16} /> New subpage</button>
                <hr />
                <button className="danger" onClick={() => (deletePage(p.id), setMenuFor(null))}><Icon.trash width={16} height={16} /> Delete page</button>
              </div>
            )}
          </li>
        ))}
        {dropIndex === section.pages.length && <li className="drop-end" />}
      </ol>
      <PaneResizer pane="pages" />
    </aside>
  );
}
