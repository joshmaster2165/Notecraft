// Modal dialogs: Move or Copy (page / section), Page Templates, Deleted Notes.
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as ops from "../model/ops.ts";
import { TRASH_DAYS } from "../model/ops.ts";
import { BUILTIN_TEMPLATES } from "../model/templates.ts";
import { customTagId, tagDef, type TagShape } from "../model/tags.ts";
import type { CustomTagDef, Notebook } from "../model/types.ts";
import { TagIcon } from "./editor/TagIcon.tsx";
import { store, useStore, type PromptDialog as PromptDialogState } from "../store/store.ts";
import { importOneNoteNotebooks, movePage, moveSectionTo, newPageFromTemplate, restoreFromTrash, saveCurrentPageAsTemplate, type OneNoteImportProgress } from "../store/actions.ts";
import { desktop, type FoundNotebook } from "../desktop.ts";
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

type MoveTarget = { notebookId: string; groupId?: string };

/** Notebooks and their section groups, indented; `exclude` hides a group being moved and its subgroups. */
function GroupPicker({ target, setTarget, exclude }: { target: MoveTarget | null; setTarget: (t: MoveTarget) => void; exclude?: Set<string> }) {
  const lib = useStore((s) => s.lib);
  const key = (t: MoveTarget) => `${t.notebookId}/${t.groupId ?? ""}`;
  const depthOf = (nb: Notebook, id?: string): number => {
    let d = 0;
    for (let g = nb.groups?.find((x) => x.id === id); g; g = nb.groups?.find((x) => x.id === g!.parentId)) d++;
    return d;
  };
  return (
    <div className="pick-list">
      {lib.notebooks.map((nb) => {
        const ordered: MoveTarget[] = [{ notebookId: nb.id }];
        const add = (parent?: string) => {
          for (const g of nb.groups ?? []) {
            if ((g.parentId ?? undefined) !== parent || exclude?.has(g.id)) continue;
            ordered.push({ notebookId: nb.id, groupId: g.id });
            add(g.id);
          }
        };
        add(undefined);
        return ordered.map((o) => {
          const depth = depthOf(nb, o.groupId);
          const label = o.groupId ? nb.groups!.find((g) => g.id === o.groupId)!.name : nb.name;
          return (
            <button key={key(o)} className={`pick-item${target && key(target) === key(o) ? " is-on" : ""}`} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => setTarget(o)}>
              {depth === 0 ? <Icon.notebook width={15} height={15} /> : <Icon.folder width={15} height={15} />} {label}
            </button>
          );
        });
      })}
    </div>
  );
}

function MoveSectionDialog({ sectionId }: { sectionId: string }) {
  const lib = useStore((s) => s.lib);
  const hit = ops.findSection(lib, sectionId);
  const [target, setTarget] = useState<MoveTarget | null>(null);
  if (!hit) return null;
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
      <GroupPicker target={target} setTarget={setTarget} />
    </Modal>
  );
}

function MoveGroupDialog({ groupId }: { groupId: string }) {
  const lib = useStore((s) => s.lib);
  const nb = lib.notebooks.find((n) => n.groups?.some((g) => g.id === groupId));
  const group = nb?.groups?.find((g) => g.id === groupId);
  const [target, setTarget] = useState<MoveTarget | null>(null);
  if (!nb || !group) return null;
  const family = ops.groupFamily(nb, groupId);
  return (
    <Modal
      title={`Move “${group.name}”`}
      onClose={close}
      footer={
        <>
          <span className="tb-spacer" />
          <button
            className="btn btn-primary"
            disabled={!target}
            onClick={() => {
              store.edit((d) => ops.moveSectionGroup(d, groupId, { notebookId: target!.notebookId, ...(target!.groupId ? { parentId: target!.groupId } : {}) }));
              close();
            }}
          >
            Move
          </button>
        </>
      }
    >
      <p className="dialog-note">Move the section group, with its sections and groups, into:</p>
      <GroupPicker target={target} setTarget={setTarget} exclude={family} />
    </Modal>
  );
}

function PromptDialog({ dialog }: { dialog: PromptDialogState }) {
  const [value, setValue] = useState(dialog.value);
  const finish = (v: string | null) => {
    close();
    dialog.resolve(v);
  };
  return (
    <Modal
      title={dialog.title}
      onClose={() => finish(null)}
      footer={
        <>
          <span className="tb-spacer" />
          <button className="btn" onClick={() => finish(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => finish(value)}>OK</button>
        </>
      }
    >
      <label className="prompt-field">
        {dialog.label}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => e.key === "Enter" && finish(value)}
        />
      </label>
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

const sizeLabel = (b: number) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1e6).toFixed(1)} MB`);

/** Desktop only: pick OneNote notebooks/sections found on this computer and import them. */
function OneNoteImportDialog() {
  const [found, setFound] = useState<FoundNotebook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<OneNoteImportProgress | null>(null);
  useEffect(() => {
    desktop
      ?.scanOneNote()
      .then((r) => {
        setFound(r.notebooks);
        setPicked(new Set(r.notebooks.flatMap((n) => n.sections.map((s) => s.path))));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const toggle = (paths: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const p of paths) on ? next.add(p) : next.delete(p);
      return next;
    });
  const run = async () => {
    const picks = (found ?? []).map((n) => ({ notebook: n.name, sections: n.sections.filter((s) => picked.has(s.path)) })).filter((p) => p.sections.length);
    await importOneNoteNotebooks(picks, setProgress);
    close();
  };
  return (
    <Modal
      title="Import from OneNote"
      onClose={progress ? () => undefined : close}
      footer={
        <>
          <span className="dialog-note">{progress ? `Importing ${progress.done} of ${progress.total}… ${progress.current ?? ""}` : `${picked.size} section${picked.size === 1 ? "" : "s"} selected`}</span>
          <span className="tb-spacer" />
          <button className="btn btn-primary" disabled={!picked.size || !!progress} onClick={() => void run()}>Import</button>
        </>
      }
    >
      <p className="dialog-note">
        Notecraft reads OneNote's local copies of your notebooks. Each notebook is imported as a Notecraft notebook, with its page history and any pictures OneNote has downloaded. Nothing is uploaded, and OneNote is not changed.
      </p>
      {error && <p className="dialog-note">Couldn't read OneNote's folder: {error}</p>}
      {!found && !error && <p className="dialog-note">Looking for OneNote notebooks…</p>}
      {found?.length === 0 && <p className="dialog-note">No OneNote notebooks were found on this computer. Open OneNote once so it saves its local backups, or use File › Import .one Files.</p>}
      <div className="pick-list">
        {found?.map((n) => {
          const paths = n.sections.map((s) => s.path);
          const all = paths.every((p) => picked.has(p));
          return (
            <div key={n.name}>
              <label className="pick-group">
                <input type="checkbox" checked={all} onChange={(e) => toggle(paths, e.target.checked)} disabled={!!progress} />
                <Icon.notebook width={15} height={15} /> {n.name}
              </label>
              {n.sections.map((s) => (
                <label key={s.path} className="pick-item">
                  <input type="checkbox" checked={picked.has(s.path)} onChange={(e) => toggle([s.path], e.target.checked)} disabled={!!progress} />
                  {s.name}
                  <span className="menu-meta">{sizeLabel(s.bytes)}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

const SHAPES: TagShape[] = ["checkbox", "star", "question", "highlight", "letter", "alert", "person", "house", "phone", "globe", "bulb", "key", "film", "book", "music", "doc", "pen", "envelope", "calendar"];
const TAG_COLORS = ["#3a6db0", "#2b7bb9", "#3a9a3a", "#e3a008", "#e07b00", "#c2272d", "#7a4fbf", "#555b66"];
const TAG_HIGHLIGHTS = ["#fff3a3", "#c8f2c0", "#ffe08a", "#cde4ff", "#ffd6e7"];

/** OneNote's Customize Tags: create and edit your own tags. Imported OneNote tags show up here too. */
function CustomTagsDialog() {
  const tags = useStore((s) => s.lib.customTags) ?? NO_CUSTOM;
  const blank: CustomTagDef = { id: "", label: "", shape: "checkbox", color: TAG_COLORS[0]!, check: true };
  const [draft, setDraft] = useState<CustomTagDef>(blank);
  const editing = !!draft.id;
  const set = (patch: Partial<CustomTagDef>) => setDraft((d) => ({ ...d, ...patch }));
  const save = () => {
    const label = draft.label.trim();
    if (!label) return;
    const def: CustomTagDef = {
      ...draft,
      id: draft.id || customTagId(label),
      label,
      ...(draft.shape === "highlight" ? { highlight: draft.highlight ?? TAG_HIGHLIGHTS[0], check: undefined } : { highlight: undefined }),
    };
    if (!def.check) delete def.check;
    if (!def.highlight) delete def.highlight;
    store.edit((d) => ops.saveCustomTag(d, def));
    setDraft(blank);
  };
  return (
    <Modal title="Customize Tags" onClose={close}>
      <p className="dialog-note">Your own tags appear in the Tags menu and in Find Tags. Tags imported from OneNote are listed here too.</p>
      <ul className="trash-list">
        {tags.length === 0 && <li className="dialog-note">No custom tags yet.</li>}
        {tags.map((t) => (
          <li key={t.id}>
            <span className="trash-icon"><TagIcon def={tagDef({ kind: t.id, label: t.label })} /></span>
            <span className="trash-main">
              <strong>{t.label}</strong>
              <span className="version-meta">{t.check ? "Checkable" : t.highlight ? "Highlight" : "Icon"}</span>
            </span>
            <button className="btn" onClick={() => setDraft(t)}>Edit</button>
            <button className="icon-btn" aria-label={`Delete tag ${t.label}`} onClick={() => store.edit((d) => ops.deleteCustomTag(d, t.id))}>
              <Icon.trash width={15} height={15} />
            </button>
          </li>
        ))}
      </ul>
      <form className="tag-form" onSubmit={(e) => (e.preventDefault(), save())}>
        <h3>{editing ? `Edit “${draft.label}”` : "New tag"}</h3>
        <label>
          Name
          <input value={draft.label} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. Follow up" />
        </label>
        <div className="tag-form-row" role="group" aria-label="Icon">
          {SHAPES.map((shape) => (
            <button type="button" key={shape} className={`tag-shape${draft.shape === shape ? " is-on" : ""}`} aria-label={shape} aria-pressed={draft.shape === shape}
              onClick={() => set({ shape, check: shape === "checkbox" ? true : draft.check })}>
              <TagIcon def={{ id: "preview", label: draft.label || "Tag", shape, color: draft.color, ...(shape === "highlight" ? { highlight: draft.highlight ?? TAG_HIGHLIGHTS[0] } : {}), ...(shape === "letter" ? { badge: (draft.label || "T").slice(0, 1).toUpperCase() } : {}) }} />
            </button>
          ))}
        </div>
        <div className="tag-form-row" role="group" aria-label="Color">
          {(draft.shape === "highlight" ? TAG_HIGHLIGHTS : TAG_COLORS).map((c) => (
            <button type="button" key={c} className={`swatch${(draft.shape === "highlight" ? draft.highlight : draft.color) === c ? " is-on" : ""}`} style={{ background: c }} aria-label={c}
              onClick={() => set(draft.shape === "highlight" ? { highlight: c } : { color: c })} />
          ))}
        </div>
        {draft.shape !== "highlight" && (
          <label className="tb-check">
            <input type="checkbox" checked={!!draft.check} onChange={(e) => set({ check: e.target.checked })} /> Has a checkbox (to-do style)
          </label>
        )}
        <div className="tag-form-actions">
          {editing && <button type="button" className="btn" onClick={() => setDraft(blank)}>Cancel</button>}
          <button className="btn btn-primary" disabled={!draft.label.trim()}>{editing ? "Save tag" : "Add tag"}</button>
        </div>
      </form>
    </Modal>
  );
}

const NO_CUSTOM: CustomTagDef[] = [];

export function Dialogs() {
  const dialog = useStore((s) => s.ui.dialog);
  if (!dialog) return null;
  if (dialog.kind === "movePage") return <MovePageDialog pageId={dialog.pageId} />;
  if (dialog.kind === "moveSection") return <MoveSectionDialog sectionId={dialog.sectionId} />;
  if (dialog.kind === "moveGroup") return <MoveGroupDialog groupId={dialog.groupId} />;
  if (dialog.kind === "prompt") return <PromptDialog dialog={dialog} />;
  if (dialog.kind === "templates") return <TemplatesDialog />;
  if (dialog.kind === "oneNoteImport") return <OneNoteImportDialog />;
  if (dialog.kind === "customTags") return <CustomTagsDialog />;
  return <TrashDialog />;
}
