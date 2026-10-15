// Modal dialogs: Move or Copy (page / section), Page Templates, Deleted Notes.
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as ops from "../model/ops.ts";
import { TRASH_DAYS } from "../model/ops.ts";
import { BUILTIN_TEMPLATES } from "../model/templates.ts";
import { store, useStore } from "../store/store.ts";
import { movePage, moveSectionTo, newPageFromTemplate, restoreFromTrash, saveCurrentPageAsTemplate } from "../store/actions.ts";
import { Icon } from "./icons.tsx";

function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon.close />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

const close = () => store.setUi({ dialog: null });

function MovePageDialog({ pageId }: { pageId: string }) {
  const lib = useStore((s) => s.lib);
  const hit = ops.findPage(lib, pageId);
  const [target, setTarget] = useState<string | null>(null);
  if (!hit) return null;
  return (
    <Modal
      title={`Move or copy “${hit.page.title || "Untitled page"}”`}
      onClose={close}
      footer={
        <>
          <span className="tb-spacer" />
          <button className="btn" disabled={!target} onClick={() => (movePage(pageId, target!, true), close())}>Copy</button>
          <button className="btn btn-primary" disabled={!target || target === hit.section.id} onClick={() => (movePage(pageId, target!, false), close())}>Move</button>
        </>
      }
    >
      <p className="dialog-note">Move or copy page to:</p>
      <div className="pick-list" role="listbox" aria-label="Sections">
        {lib.notebooks.map((nb) => (
          <div key={nb.id}>
            <div className="pick-group"><Icon.notebook width={15} height={15} /> {nb.name}</div>
            {nb.sections.map((s) => (
              <button key={s.id} role="option" aria-selected={target === s.id} className={`pick-item${target === s.id ? " is-on" : ""}`} onClick={() => setTarget(s.id)}>
                <span className="section-tab" style={{ background: s.color }} /> {s.name}
                {s.id === hit.section.id && <span className="menu-meta">current</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function MoveSectionDialog({ sectionId }: { sectionId: string }) {
  const lib = useStore((s) => s.lib);
  const hit = ops.findSection(lib, sectionId);
  const [target, setTarget] = useState<{ notebookId: string; groupId?: string } | null>(null);
  if (!hit) return null;
  const key = (t: { notebookId: string; groupId?: string }) => `${t.notebookId}/${t.groupId ?? ""}`;
  return (
    <Modal
      title={`Move “${hit.section.name}”`}
      onClose={close}
      footer={
        <>
          <span className="tb-spacer" />
          <button className="btn btn-primary" disabled={!target} onClick={() => (moveSectionTo(sectionId, target!.notebookId, target!.groupId), close())}>Move</button>
        </>
      }
    >
      <p className="dialog-note">Move section into a notebook or section group:</p>
      <div className="pick-list">
        {lib.notebooks.map((nb) => {
          const options = [{ notebookId: nb.id, label: nb.name, depth: 0 }, ...(nb.groups ?? []).map((g) => ({ notebookId: nb.id, groupId: g.id, label: g.name, depth: g.parentId ? 2 : 1 }))];
          return options.map((o) => (
            <button key={key(o)} className={`pick-item${target && key(target) === key(o) ? " is-on" : ""}`} style={{ paddingLeft: 10 + o.depth * 16 }} onClick={() => setTarget(o)}>
              {o.depth === 0 ? <Icon.notebook width={15} height={15} /> : <Icon.folder width={15} height={15} />} {o.label}
            </button>
          ));
        })}
      </div>
    </Modal>
  );
}

const NO_TEMPLATES: never[] = [];

function TemplatesDialog() {
  const custom = useStore((s) => s.lib.templates) ?? NO_TEMPLATES;
  const [name, setName] = useState("");
  const categories = [...new Set(BUILTIN_TEMPLATES.map((t) => t.category))];
  return (
    <Modal title="Page Templates" onClose={close}>
      <p className="dialog-note">Add a page based on one of the templates below.</p>
      {categories.map((c) => (
        <section key={c} className="tpl-group">
          <h3>{c}</h3>
          <div className="tpl-grid">
            {BUILTIN_TEMPLATES.filter((t) => t.category === c).map((t) => (
              <button key={t.id} className="tpl" onClick={() => (newPageFromTemplate(t.build()), close())}>
                <Icon.page /> {t.name}
              </button>
            ))}
          </div>
        </section>
      ))}
      <section className="tpl-group">
        <h3>My Templates</h3>
        {custom.length === 0 && <p className="dialog-note">None yet.</p>}
        <div className="tpl-grid">
          {custom.map((t) => (
            <span key={t.id} className="tpl-wrap">
              <button className="tpl" onClick={() => (newPageFromTemplate(t.page), close())}>
                <Icon.page /> {t.name}
              </button>
              <button className="icon-btn" aria-label={`Delete template ${t.name}`} onClick={() => store.edit((d) => ops.deleteTemplate(d, t.id))}>
                <Icon.trash width={15} height={15} />
              </button>
            </span>
          ))}
        </div>
        <form className="tpl-save" onSubmit={(e) => (e.preventDefault(), saveCurrentPageAsTemplate(name), setName(""))}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" aria-label="Template name" />
          <button className="btn" disabled={!name.trim()}>Save current page as a template</button>
        </form>
      </section>
    </Modal>
  );
}

const ago = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function daysAgo(iso: string) {
  const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
  return ago.format(days, "day");
}

function TrashDialog() {
  const notebookId = useStore((s) => s.ui.notebookId);
  const nb = useStore((s) => s.lib.notebooks.find((n) => n.id === s.ui.notebookId));
  const items = nb?.trash ?? [];
  return (
    <Modal
      title={`Deleted Notes${nb ? ` for “${nb.name}”` : ""}`}
      onClose={close}
      footer={
        <>
          <span className="dialog-note">Items are kept for {TRASH_DAYS} days.</span>
          <span className="tb-spacer" />
          <button className="btn" disabled={!items.length} onClick={() => confirm("Permanently delete everything in Deleted Notes?") && store.edit((d) => ops.purgeTrash(d, notebookId!))}>Empty Deleted Notes</button>
        </>
      }
    >
      {items.length === 0 && <p className="dialog-note">Nothing here. Deleted pages and sections stay here for {TRASH_DAYS} days.</p>}
      <ul className="trash-list">
        {items.map((t, i) => (
          <li key={`${t.kind}-${t.kind === "page" ? t.page.id : t.section.id}`}>
            <span className="trash-icon">{t.kind === "page" ? <Icon.page /> : <Icon.notebook />}</span>
            <span className="trash-main">
              <strong>{t.kind === "page" ? t.page.title || "Untitled page" : t.section.name}</strong>
              <span className="version-meta">
                {t.kind === "page" ? `Page from ${t.sectionName}` : `Section · ${t.section.pages.length} pages`} · deleted {daysAgo(t.deletedAt)}
              </span>
            </span>
            <button className="btn" onClick={() => (restoreFromTrash(notebookId!, i), close())}>
              <Icon.restore width={15} height={15} /> Restore
            </button>
            <button className="icon-btn" aria-label="Delete permanently" title="Delete permanently" onClick={() => store.edit((d) => ops.purgeTrash(d, notebookId!, i))}>
              <Icon.trash width={15} height={15} />
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.ui.dialog);
  if (!dialog) return null;
  if (dialog.kind === "movePage") return <MovePageDialog pageId={dialog.pageId} />;
  if (dialog.kind === "moveSection") return <MoveSectionDialog sectionId={dialog.sectionId} />;
  if (dialog.kind === "templates") return <TemplatesDialog />;
  return <TrashDialog />;
}
