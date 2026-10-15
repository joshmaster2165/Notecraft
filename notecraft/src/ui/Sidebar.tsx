// Notebooks and their sections (SectionNode color tabs).
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Notebook, Section, SectionGroup } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { store, useStore } from "../store/store.ts";
import { deleteSection, exportNotebook, importFiles, newNotebook, newSection, newSectionGroup, selectNotebook, selectSection } from "../store/actions.ts";
import { Icon, Logo } from "./icons.tsx";
import { desktop } from "../desktop.ts";

function InlineRename({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="rename"
      defaultValue={value}
      aria-label="Name"
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(e.currentTarget.value);
        if (e.key === "Escape") onDone(null);
      }}
      onBlur={(e) => onDone(e.currentTarget.value)}
    />
  );
}

function SectionMenu({ section, onClose, onRename }: { section: Section; onClose: () => void; onRename: () => void }) {
  return (
    <div className="menu" role="menu" onMouseLeave={onClose}>
      <button role="menuitem" onClick={() => (onRename(), onClose())}>Rename</button>
      <button role="menuitem" onClick={() => (store.setUi({ dialog: { kind: "moveSection", sectionId: section.id } }), onClose())}>Move to…</button>
      <div className="menu-swatches" role="group" aria-label="Section color">
        {ops.SECTION_COLORS.map((c) => (
          <button
            key={c}
            className={`swatch${c === section.color ? " is-on" : ""}`}
            style={{ background: c }}
            aria-label={`Color ${c}`}
            onClick={() => {
              store.edit((d) => ops.setSectionColor(d, section.id, c));
              onClose();
            }}
          />
        ))}
      </div>
      <button role="menuitem" className="danger" onClick={() => (deleteSection(section.id), onClose())}>
        Delete section
      </button>
    </div>
  );
}

const DRAG_TYPE = "application/x-notecraft-section";

interface TreeProps {
  notebook: Notebook;
  sectionId: string | null;
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  menuFor: string | null;
  setMenuFor: (id: string | null) => void;
  depth: number;
  groupId?: string;
}

/** Sections and section groups, nested; drag a section onto another to reorder, onto a group to file it. */
function SectionTree(props: TreeProps) {
  const { notebook, sectionId, renaming, setRenaming, menuFor, setMenuFor, depth, groupId } = props;
  const [over, setOver] = useState<string | null>(null);
  const known = new Set((notebook.groups ?? []).map((g) => g.id));
  const sections = notebook.sections.filter((s) => (groupId ? s.groupId === groupId : !s.groupId || !known.has(s.groupId)));
  const groups = (notebook.groups ?? []).filter((g) => (groupId ? g.parentId === groupId : !g.parentId || !known.has(g.parentId)));
  const drop = (e: DragEvent, to: { beforeSectionId?: string; groupId?: string }) => {
    const id = e.dataTransfer.getData(DRAG_TYPE);
    setOver(null);
    if (!id) return;
    e.preventDefault();
    store.edit((d) => ops.moveSection(d, id, { notebookId: notebook.id, ...to }));
  };
  return (
    <>
      {sections.map((s) => (
        <li
          key={s.id}
          role="treeitem"
          aria-selected={s.id === sectionId}
          className={`section${s.id === sectionId ? " is-active" : ""}${over === s.id ? " drop-before" : ""}`}
          style={{ paddingLeft: depth * 14 }}
          draggable
          onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, s.id)}
          onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && (e.preventDefault(), setOver(s.id))}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => drop(e, { beforeSectionId: s.id, ...(groupId ? { groupId } : {}) })}
        >
          <button className="section-btn" onClick={() => selectSection(s.id)} onDoubleClick={() => setRenaming(s.id)} aria-current={s.id === sectionId ? "true" : undefined}>
            <span className="section-tab" style={{ background: s.color }} />
            {renaming === s.id ? (
              <InlineRename value={s.name} onDone={(v) => (v && store.edit((d) => ops.renameSection(d, s.id, v)), setRenaming(null))} />
            ) : (
              <span className="section-name">{s.name}</span>
            )}
            <span className="section-count">{s.pages.length}</span>
          </button>
          <button className="icon-btn section-more" aria-label={`${s.name} options`} onClick={() => setMenuFor(menuFor === s.id ? null : s.id)}>
            <Icon.more />
          </button>
          {menuFor === s.id && <SectionMenu section={s} onClose={() => setMenuFor(null)} onRename={() => setRenaming(s.id)} />}
        </li>
      ))}
      {groups.map((g) => (
        <GroupNode key={g.id} group={g} {...props} />
      ))}
    </>
  );
}

function GroupNode(props: TreeProps & { group: SectionGroup }) {
  const { group: g, notebook, renaming, setRenaming, menuFor, setMenuFor, depth } = props;
  const [over, setOver] = useState(false);
  return (
    <li role="treeitem" aria-expanded={!g.collapsed} className="group">
      <div
        className={`section group-row${over ? " is-drop" : ""}`}
        style={{ paddingLeft: depth * 14 }}
        onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const id = e.dataTransfer.getData(DRAG_TYPE);
          if (!id) return;
          e.preventDefault();
          store.edit((d) => ops.moveSection(d, id, { notebookId: notebook.id, groupId: g.id }));
        }}
      >
        <button className="section-btn" onClick={() => store.edit((d) => ops.toggleGroupCollapsed(d, g.id))} onDoubleClick={() => setRenaming(g.id)}>
          <Icon.chevron className={g.collapsed ? "rot" : ""} width={14} height={14} />
          <Icon.folder width={16} height={16} />
          {renaming === g.id ? (
            <InlineRename value={g.name} onDone={(v) => (v && store.edit((d) => ops.renameSectionGroup(d, g.id, v)), setRenaming(null))} />
          ) : (
            <span className="section-name">{g.name}</span>
          )}
        </button>
        <button className="icon-btn section-more" aria-label={`${g.name} options`} onClick={() => setMenuFor(menuFor === g.id ? null : g.id)}>
          <Icon.more />
        </button>
        {menuFor === g.id && (
          <div className="menu" role="menu" onMouseLeave={() => setMenuFor(null)}>
            <button onClick={() => (setRenaming(g.id), setMenuFor(null))}>Rename</button>
            <button onClick={() => {
              const s = store.edit((d) => {
                const sec = ops.createSection(d, notebook.id);
                sec.groupId = g.id;
                return sec;
              });
              selectSection(s.id);
              setRenaming(s.id);
              setMenuFor(null);
            }}>New section in group</button>
            <button onClick={() => {
              const id = newSectionGroup(g.id);
              if (id) setRenaming(id);
              setMenuFor(null);
            }}>New section group inside</button>
            <button className="danger" onClick={() => (store.edit((d) => ops.deleteSectionGroup(d, g.id)), setMenuFor(null))}>Ungroup (keeps sections)</button>
          </div>
        )}
      </div>
      {!g.collapsed && (
        <ul role="group">
          <SectionTree {...props} depth={depth + 1} groupId={g.id} />
        </ul>
      )}
    </li>
  );
}

export function Sidebar() {
  const notebooks = useStore((s) => s.lib.notebooks);
  const { notebookId, sectionId } = useStore((s) => s.ui);
  const saveState = useStore((s) => s.saveState);
  const notebook = notebooks.find((n) => n.id === notebookId) ?? notebooks[0];
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <nav className="sidebar" aria-label="Notebooks">
      <div className="brand">
        <Logo />
        <span className="brand-name">Notecraft</span>
        <button className="icon-btn" title="Search all notebooks (⌘E)" aria-label="Search" onClick={() => store.setUi({ searchOpen: true })}>
          <Icon.search />
        </button>
      </div>

      <div className="notebook-picker">
        <button className="notebook-current" aria-expanded={pickerOpen} onClick={() => setPickerOpen((v) => !v)}>
          <Icon.notebook />
          {renaming === notebook?.id ? (
            <InlineRename
              value={notebook.name}
              onDone={(v) => {
                if (v) store.edit((d) => ops.renameNotebook(d, notebook.id, v));
                setRenaming(null);
              }}
            />
          ) : (
            <span className="notebook-name" onDoubleClick={() => notebook && setRenaming(notebook.id)}>{notebook?.name}</span>
          )}
          <Icon.chevron className={pickerOpen ? "flip" : ""} />
        </button>
        {pickerOpen && (
          <div className="menu notebook-menu" role="menu">
            {notebooks.map((n) => (
              <button
                key={n.id}
                role="menuitemradio"
                aria-checked={n.id === notebook?.id}
                onClick={() => {
                  selectNotebook(n.id);
                  setPickerOpen(false);
                }}
              >
                <span className="dot" style={{ background: n.color }} /> {n.name}
                <span className="menu-meta">{n.sections.length}</span>
              </button>
            ))}
            <hr />
            <button onClick={() => (newNotebook(), setPickerOpen(false))}>
              <Icon.plus width={16} height={16} /> New notebook
            </button>
            {notebook && (
              <button onClick={() => (setRenaming(notebook.id), setPickerOpen(false))}>Rename “{notebook.name}”</button>
            )}
          </div>
        )}
      </div>

      <ul className="sections" role="tree" aria-label="Sections">
        {notebook && <SectionTree notebook={notebook} sectionId={sectionId} renaming={renaming} setRenaming={setRenaming} menuFor={menuFor} setMenuFor={setMenuFor} depth={0} />}
      </ul>
      <div className="add-rows">
        <button className="add-row" onClick={() => newSection()}>
          <Icon.plus width={16} height={16} /> Section
        </button>
        <button className="add-row" onClick={() => {
          const id = newSectionGroup();
          if (id) setRenaming(id);
        }}>
          <Icon.folder width={16} height={16} /> Section group
        </button>
      </div>
      <button className="add-row trash-row" onClick={() => store.setUi({ dialog: { kind: "trash" } })}>
        <Icon.trash width={16} height={16} /> Deleted Notes
        {!!notebook?.trash?.length && <span className="section-count">{notebook.trash.length}</span>}
      </button>

      <div className="sidebar-foot">
        {desktop && (
          <button className="foot-btn foot-wide" onClick={() => store.setUi({ dialog: { kind: "oneNoteImport" } })} title="Import notebooks from OneNote on this computer">
            <Icon.notebook /> Import from OneNote
          </button>
        )}
        <button className="foot-btn" onClick={() => fileInput.current?.click()} title="Import .one sections or a Notecraft export">
          <Icon.import /> Import .one
        </button>
        <button className="foot-btn" onClick={exportNotebook} title="Download this notebook as Notecraft JSON">
          <Icon.export /> Export
        </button>
        <span className={`save-state is-${saveState}`} role="status">
          {saveState === "saved" ? "Saved on this device" : saveState === "saving" ? "Saving…" : "Couldn’t save"}
        </span>
        <input
          ref={fileInput}
          type="file"
          accept=".one,.json,application/json"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void importFiles(files);
          }}
        />
      </div>
    </nav>
  );
}
