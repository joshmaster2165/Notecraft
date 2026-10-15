// Notebooks and their sections (SectionNode color tabs).
import { useEffect, useRef, useState } from "react";
import type { Section } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { store, useStore } from "../store/store.ts";
import { deleteSection, exportNotebook, importFiles, newNotebook, newSection, selectNotebook, selectSection } from "../store/actions.ts";
import { Icon, Logo } from "./icons.tsx";

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

      <ul className="sections" role="list">
        {notebook?.sections.map((s) => (
          <li key={s.id} className={`section${s.id === sectionId ? " is-active" : ""}`}>
            <button className="section-btn" onClick={() => selectSection(s.id)} onDoubleClick={() => setRenaming(s.id)} aria-current={s.id === sectionId ? "true" : undefined}>
              <span className="section-tab" style={{ background: s.color }} />
              {renaming === s.id ? (
                <InlineRename
                  value={s.name}
                  onDone={(v) => {
                    if (v) store.edit((d) => ops.renameSection(d, s.id, v));
                    setRenaming(null);
                  }}
                />
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
      </ul>
      <button className="add-row" onClick={() => newSection()}>
        <Icon.plus width={16} height={16} /> Add section
      </button>

      <div className="sidebar-foot">
        <button className="foot-btn" onClick={() => fileInput.current?.click()} title="Import .one sections or an Notecraft export">
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
