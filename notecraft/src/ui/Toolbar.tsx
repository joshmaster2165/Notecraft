// Formatting, insert and zoom controls. Buttons keep the editor's selection by
// preventing focus on mousedown.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Draft } from "immer";
import type { Element as NoteElement, Library, ParagraphStyle, TagKind } from "../model/types.ts";
import { LAYOUT } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { MAX_ZOOM, MIN_ZOOM } from "@re/canvas/viewport.ts";
import { store, useStore } from "../store/store.ts";
import { currentPage, exportPageMarkdown, insertImageFiles } from "../store/actions.ts";
import { persistSelection } from "../store/persist.ts";
import { canvasApi, useZoom } from "./canvasApi.ts";
import { promptLink } from "./editor/Paragraph.tsx";
import { Icon } from "./icons.tsx";

const STYLES: { value: ParagraphStyle; label: string }[] = [
  { value: "p", label: "Normal" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
  { value: "h4", label: "Heading 4" },
  { value: "quote", label: "Quote" },
  { value: "code", label: "Code" },
];

function Btn({ label, on, disabled, onClick, children, kbd }: { label: string; on?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; kbd?: string }) {
  return (
    <button
      type="button"
      className={`tb-btn${on ? " is-on" : ""}`}
      title={kbd ? `${label} (${kbd})` : label}
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function useSelectionFormats() {
  const [f, setF] = useState({ b: false, i: false, u: false, s: false });
  useEffect(() => {
    const update = () => {
      const node = document.getSelection()?.anchorNode;
      const inEditor = node && (node instanceof Element ? node : node.parentElement)?.closest(".oe-editable");
      if (!inEditor) return setF((p) => (p.b || p.i || p.u || p.s ? { b: false, i: false, u: false, s: false } : p));
      setF({
        b: document.queryCommandState("bold"),
        i: document.queryCommandState("italic"),
        u: document.queryCommandState("underline"),
        s: document.queryCommandState("strikeThrough"),
      });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  return f;
}

function useActiveElement(): NoteElement | undefined {
  return useStore((s) => {
    const a = s.ui.active;
    return a ? ops.getList(s.lib, a.ref)?.find((e) => e.id === a.elementId) : undefined;
  });
}

function Menu({ button, children, label }: { button: ReactNode; children: (close: () => void) => ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="tb-menu" ref={ref}>
      <button type="button" className="tb-btn tb-menu-btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>
        {button}
      </button>
      {open && (
        <div className="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Toolbar() {
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const active = useStore((s) => s.ui.active);
  const anchor = useStore((s) => s.ui.zoomAnchor);
  const versionsOpen = useStore((s) => s.ui.versionsOpen);
  const el = useActiveElement();
  const formats = useSelectionFormats();
  const zoom = useZoom();
  const imageInput = useRef<HTMLInputElement>(null);

  const editActive = (fn: (d: Draft<Library>) => unknown) => {
    if (active) store.edit(fn);
  };
  const exec = (cmd: string, value?: string) => {
    if (cmd === "hiliteColor") document.execCommand("styleWithCSS", false, "true");
    document.execCommand(cmd, false, value);
    document.execCommand("styleWithCSS", false, "false");
  };
  const tag = (kind: TagKind) => editActive((d) => ops.toggleTag(d, active!.ref, active!.elementId, kind));
  const inTable = !!active && "tableId" in active.ref;
  const style = el?.kind === "text" ? el.style : "p";

  const insertTable = () => {
    const page = currentPage();
    if (!page) return;
    const table = ops.newTable(3, 3);
    if (active && !inTable) store.edit((d) => ops.insertAfter(d, active.ref, active.elementId, table));
    else store.edit((d) => ops.createOutline(d, page.id, LAYOUT.bodyX, nextFreeY(page), table));
    store.focus(table.rows[0]!.cells[0]!.elements[0]!.id, 0);
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <div className="tb-group">
        <Btn label="Undo" kbd="⌘Z" disabled={!canUndo} onClick={() => store.undo()}><Icon.undo /></Btn>
        <Btn label="Redo" kbd="⇧⌘Z" disabled={!canRedo} onClick={() => store.redo()}><Icon.redo /></Btn>
      </div>
      <div className="tb-group">
        <Menu label="Paragraph style" button={<span className="tb-style">{STYLES.find((s) => s.value === style)?.label}<Icon.chevron width={14} height={14} /></span>}>
          {(close) =>
            STYLES.map((s) => (
              <button
                key={s.value}
                role="menuitemradio"
                aria-checked={s.value === style}
                className={`style-opt s-${s.value}`}
                disabled={el?.kind !== "text"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editActive((d) => ops.setParagraphStyle(d, active!.ref, active!.elementId, s.value));
                  close();
                }}
              >
                {s.label}
              </button>
            ))
          }
        </Menu>
      </div>
      <div className="tb-group">
        <Btn label="Bold" kbd="⌘B" on={formats.b} onClick={() => exec("bold")}><Icon.bold /></Btn>
        <Btn label="Italic" kbd="⌘I" on={formats.i} onClick={() => exec("italic")}><Icon.italic /></Btn>
        <Btn label="Underline" kbd="⌘U" on={formats.u} onClick={() => exec("underline")}><Icon.underline /></Btn>
        <Btn label="Strikethrough" on={formats.s} onClick={() => exec("strikeThrough")}><Icon.strike /></Btn>
        <Btn label="Highlight" kbd="⇧⌘H" onClick={() => exec("hiliteColor", "#fff3a3")}><Icon.highlight /></Btn>
      </div>
      <div className="tb-group">
        <Btn label="Bullets" kbd="⌘." on={el?.list?.kind === "bullet"} disabled={!active} onClick={() => editActive((d) => ops.toggleList(d, active!.ref, [active!.elementId], "bullet"))}><Icon.bullets /></Btn>
        <Btn label="Numbering" kbd="⌘/" on={el?.list?.kind === "numbered"} disabled={!active} onClick={() => editActive((d) => ops.toggleList(d, active!.ref, [active!.elementId], "numbered"))}><Icon.numbers /></Btn>
        <Btn label="Outdent" kbd="⇧Tab" disabled={!active} onClick={() => editActive((d) => ops.outdent(d, active!.ref, active!.elementId))}><Icon.outdent /></Btn>
        <Btn label="Indent" kbd="Tab" disabled={!active} onClick={() => editActive((d) => ops.indent(d, active!.ref, active!.elementId))}><Icon.indent /></Btn>
      </div>
      <div className="tb-group">
        <Btn label="To Do tag" kbd="⌘1" on={el?.tag?.kind === "todo"} disabled={!active} onClick={() => tag("todo")}><Icon.todo /></Btn>
        <Btn label="Important tag" kbd="⌘2" on={el?.tag?.kind === "important"} disabled={!active} onClick={() => tag("important")}><Icon.star /></Btn>
        <Btn label="Question tag" kbd="⌘3" on={el?.tag?.kind === "question"} disabled={!active} onClick={() => tag("question")}><Icon.question /></Btn>
      </div>
      <div className="tb-group">
        <Btn label="Insert table" onClick={insertTable}><Icon.table /></Btn>
        <Btn label="Insert image" onClick={() => imageInput.current?.click()}><Icon.image /></Btn>
        <Btn label="Link" kbd="⌘K" disabled={el?.kind !== "text"} onClick={promptLink}><Icon.link /></Btn>
        {inTable && active && "tableId" in active.ref && (
          <Menu label="Table" button={<span className="tb-style">Table<Icon.chevron width={14} height={14} /></span>}>
            {(close) => {
              const r = active.ref as Extract<typeof active.ref, { tableId: string }>;
              const colIndex = () => ops.findTable(store.getState().lib, r.pageId, r.outlineId, r.tableId)?.rows.find((x) => x.id === r.rowId)?.cells.findIndex((c) => c.id === r.cellId) ?? -1;
              const act = (fn: () => void) => () => (fn(), close());
              return (
                <>
                  <button onClick={act(() => store.edit((d) => ops.addTableRow(d, r.pageId, r.outlineId, r.tableId, r.rowId)))}>Insert row below</button>
                  <button onClick={act(() => store.edit((d) => ops.addTableColumn(d, r.pageId, r.outlineId, r.tableId, colIndex())))}>Insert column right</button>
                  <hr />
                  <button onClick={act(() => store.edit((d) => ops.deleteTableRow(d, r.pageId, r.outlineId, r.tableId, r.rowId)))}>Delete row</button>
                  <button onClick={act(() => store.edit((d) => ops.deleteTableColumn(d, r.pageId, r.outlineId, r.tableId, colIndex())))}>Delete column</button>
                  <button className="danger" onClick={act(() => store.edit((d) => ops.deleteElement(d, { pageId: r.pageId, outlineId: r.outlineId }, r.tableId)))}>Delete table</button>
                </>
              );
            }}
          </Menu>
        )}
      </div>

      <div className="tb-spacer" />

      <div className="tb-group tb-zoom">
        <Btn label="Zoom out" kbd="⌘−" disabled={zoom <= MIN_ZOOM} onClick={() => canvasApi.current?.zoomOut()}><Icon.minus /></Btn>
        <Menu label="Zoom" button={<span className="tb-zoom-val">{Math.round(zoom * 100)}%</span>}>
          {(close) => (
            <>
              {[0.5, 0.75, 1, 1.5, 2, 3].map((z) => (
                <button key={z} role="menuitemradio" aria-checked={Math.abs(zoom - z) < 0.005} onClick={() => (canvasApi.current?.setZoom(z), close())}>
                  {z * 100}%
                </button>
              ))}
              <button onClick={() => (canvasApi.current?.zoomToPageWidth(), close())}>Page width</button>
              <hr />
              <label className="menu-check">
                <input
                  type="checkbox"
                  checked={anchor === "pointer"}
                  onChange={(e) => {
                    store.setUi({ zoomAnchor: e.target.checked ? "pointer" : "viewportOrigin" });
                    persistSelection();
                  }}
                />
                Zoom around pointer
              </label>
              <p className="menu-note">Off matches OneNote: zoom keeps the top-left corner fixed. Range {MIN_ZOOM * 100}%–{MAX_ZOOM * 100}%.</p>
            </>
          )}
        </Menu>
        <Btn label="Zoom in" kbd="⌘=" disabled={zoom >= MAX_ZOOM} onClick={() => canvasApi.current?.zoomIn()}><Icon.plus /></Btn>
        <Btn label="Page width" onClick={() => canvasApi.current?.zoomToPageWidth()}><Icon.fitWidth /></Btn>
      </div>
      <div className="tb-group">
        <Btn label="Page versions" on={versionsOpen} onClick={() => store.setUi({ versionsOpen: !versionsOpen, ...(versionsOpen ? { preview: null } : {}) })}>
          <Icon.history />
        </Btn>
        <Menu label="More" button={<Icon.more />}>
          {(close) => (
            <>
              <button onClick={() => (store.setUi({ versionsOpen: true }), close())}>
                <Icon.history width={16} height={16} /> Page versions
              </button>
              <button onClick={() => (exportPageMarkdown(), close())}>
                <Icon.export width={16} height={16} /> Export page as Markdown
              </button>
            </>
          )}
        </Menu>
      </div>

      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const page = currentPage();
          if (!page || !files.length) return;
          if (active && !inTable) insertImageFiles(files, { ref: active.ref, afterId: active.elementId });
          else insertImageFiles(files, { pageId: page.id, x: LAYOUT.bodyX, y: nextFreeY(page) });
        }}
      />
    </div>
  );
}

/** Below the lowest outline: where a new block goes when nothing is focused. */
function nextFreeY(page: ReturnType<typeof currentPage> & object): number {
  let y: number = LAYOUT.bodyY;
  for (const o of page.outlines) {
    const node = document.querySelector<HTMLElement>(`[data-outline="${o.id}"]`);
    y = Math.max(y, o.y + (node?.offsetHeight ?? 40) + 24);
  }
  return y;
}
