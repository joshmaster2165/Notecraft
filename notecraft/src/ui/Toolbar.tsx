// OneNote-style ribbon: Home, Insert, Draw and View tabs. Buttons keep the
// editor's selection by preventing focus on mousedown.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Draft } from "immer";
import type { Element as NoteElement, Library, ParagraphStyle, RuleLines } from "../model/types.ts";
import { LAYOUT } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { TAGS } from "../model/tags.ts";
import { MAX_ZOOM, MIN_ZOOM } from "@re/canvas/viewport.ts";
import { store, useStore, type DrawTool } from "../store/store.ts";
import { currentPage, exportPageMarkdown, insertAttachments, insertImageFiles, printPage } from "../store/actions.ts";
import { persistSelection } from "../store/persist.ts";
import { canvasApi, useZoom } from "./canvasApi.ts";
import { promptLink } from "./editor/Paragraph.tsx";
import { TagIcon } from "./editor/TagIcon.tsx";
import { FONTS, FONT_COLORS, HIGHLIGHT_COLORS, SIZES, applyStyle, clearStyle, currentFont, exec } from "./format.ts";
import { Icon } from "./icons.tsx";

const STYLES: { value: ParagraphStyle; label: string }[] = [
  { value: "p", label: "Normal" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
  { value: "h4", label: "Heading 4" },
  { value: "h5", label: "Heading 5" },
  { value: "h6", label: "Heading 6" },
  { value: "quote", label: "Quote" },
  { value: "code", label: "Code" },
];

export const PAGE_COLORS: [string, string | undefined][] = [
  ["None", undefined], ["Blue", "#dbe9f9"], ["Yellow", "#fff6c7"], ["Green", "#e3f4d6"], ["Red", "#fde0dd"], ["Purple", "#ece2f6"],
  ["Cyan", "#d9f3f3"], ["Orange", "#fde8d2"], ["Magenta", "#f9dcf0"], ["Blue Mist", "#e8eef3"], ["Purple Mist", "#eee9f3"],
  ["Tan", "#f3ebdf"], ["Silver", "#ececec"], ["Rose", "#f9e6e6"],
];
const RULES: [RuleLines, string][] = [
  ["none", "None"], ["narrow", "Narrow Ruled"], ["standard", "Standard Ruled"], ["college", "College Ruled"],
  ["grid-small", "Small Grid"], ["grid-medium", "Medium Grid"], ["grid-large", "Large Grid"],
];
const RULE_COLORS: [string, string][] = [["Blue", "#9ec1e6"], ["Gray", "#c8ccd2"], ["Red", "#f2a6a6"], ["Green", "#a8d8a0"], ["Purple", "#c9b3e6"]];
const PEN_COLORS = ["#1d1f23", "#1f3a5f", "#2f6fb3", "#c2272d", "#2e8b3a", "#7a4fbf", "#e07b00"];
const HIGHLIGHTER_COLORS = ["#ffe14d", "#7cf27c", "#68d8ff", "#ff8ad8", "#ffb35c"];

type Tab = "home" | "insert" | "draw" | "view";

function Btn({ label, on, disabled, onClick, children, kbd, wide }: { label: string; on?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; kbd?: string; wide?: boolean }) {
  return (
    <button
      type="button"
      className={`tb-btn${on ? " is-on" : ""}${wide ? " tb-wide" : ""}`}
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

function Menu({ button, children, label, wide }: { button: ReactNode; children: (close: () => void) => ReactNode; label: string; wide?: boolean }) {
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
      <button type="button" className={`tb-btn tb-menu-btn${wide ? " tb-wide" : ""}`} title={label} aria-haspopup="menu" aria-expanded={open} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>
        {button}
      </button>
      {open && (
        <div className="menu" role="menu" onMouseDown={(e) => e.target instanceof HTMLButtonElement && e.preventDefault()}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function Swatches({ colors, onPick, none, label }: { colors: string[]; onPick: (c: string | null) => void; none?: string; label: string }) {
  return (
    <div className="swatch-grid" role="group" aria-label={label}>
      {none && (
        <button className="swatch-none" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(null)}>
          {none}
        </button>
      )}
      {colors.map((c) => (
        <button key={c} className="swatch" style={{ background: c }} aria-label={c} title={c} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(c)} />
      ))}
    </div>
  );
}

function useSelectionFormats() {
  const empty = { b: false, i: false, u: false, s: false, sub: false, sup: false, font: undefined as string | undefined, size: undefined as number | undefined };
  const [f, setF] = useState(empty);
  useEffect(() => {
    const update = () => {
      const node = document.getSelection()?.anchorNode;
      const inEditor = node && (node instanceof Element ? node : node.parentElement)?.closest(".oe-editable");
      if (!inEditor) return;
      setF({
        b: document.queryCommandState("bold"),
        i: document.queryCommandState("italic"),
        u: document.queryCommandState("underline"),
        s: document.queryCommandState("strikeThrough"),
        sub: document.queryCommandState("subscript"),
        sup: document.queryCommandState("superscript"),
        font: currentFont().font,
        size: currentFont().size,
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

/** Below the lowest outline: where a new block goes when nothing is focused. */
function nextFreeY(page: NonNullable<ReturnType<typeof currentPage>>): number {
  let y: number = LAYOUT.bodyY;
  for (const o of page.outlines) {
    const node = document.querySelector<HTMLElement>(`[data-outline="${o.id}"]`);
    y = Math.max(y, o.y + (node?.offsetHeight ?? 40) + 24);
  }
  return y;
}

function TableGrid({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  return (
    <div className="table-grid-wrap">
      <div className="table-grid" onMouseLeave={() => setHover([0, 0])}>
        {Array.from({ length: 8 * 8 }, (_, i) => {
          const r = Math.floor(i / 8) + 1;
          const c = (i % 8) + 1;
          return (
            <button
              key={i}
              className={r <= hover[0] && c <= hover[1] ? "is-on" : ""}
              aria-label={`${r} by ${c} table`}
              onMouseEnter={() => setHover([r, c])}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(r, c)}
            />
          );
        })}
      </div>
      <div className="menu-note">{hover[0] ? `${hover[0]} × ${hover[1]} table` : "Insert table"}</div>
    </div>
  );
}

export function Toolbar() {
  const [tab, setTab] = useState<Tab>("home");
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const active = useStore((s) => s.ui.active);
  const anchor = useStore((s) => s.ui.zoomAnchor);
  const sidePanel = useStore((s) => s.ui.sidePanel);
  const draw = useStore((s) => s.ui.draw);
  const fullPage = useStore((s) => s.ui.fullPage);
  const page = useStore((s) => (s.ui.pageId ? ops.findPage(s.lib, s.ui.pageId)?.page : undefined));
  const el = useActiveElement();
  const formats = useSelectionFormats();
  const zoom = useZoom();
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const editActive = (fn: (d: Draft<Library>) => unknown) => {
    if (active) store.edit(fn);
  };
  const inTable = !!active && "tableId" in active.ref;
  const style = el?.kind === "text" ? el.style : "p";
  const align = el?.kind === "text" ? el.align ?? "left" : "left";
  const hasTag = (kind: string) => !!el?.tags?.some((t) => t.kind === kind);
  const setDraw = (patch: Partial<typeof draw>) => store.setUi({ draw: { ...draw, ...patch } });
  const pickTool = (tool: DrawTool) => {
    setDraw({ tool });
    if (tool !== "type") (document.activeElement as HTMLElement | null)?.blur?.();
  };

  const insertTable = (rows: number, cols: number) => {
    const p = currentPage();
    if (!p) return;
    const table = ops.newTable(rows, cols, Math.min(560, cols * 120));
    if (active && !inTable) store.edit((d) => ops.insertAfter(d, active.ref, active.elementId, table));
    else store.edit((d) => ops.createOutline(d, p.id, LAYOUT.bodyX, nextFreeY(p), table));
    store.focus(table.rows[0]!.cells[0]!.elements[0]!.id, 0);
  };
  const insertText = (text: string) => {
    if (!el || el.kind !== "text") return store.toast("Click in a paragraph first.");
    document.execCommand("insertText", false, text);
  };
  const now = () => new Date();
  const dateStr = () => now().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const timeStr = () => now().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const filesTarget = () => {
    const p = currentPage();
    if (!p) return null;
    return active && !inTable ? { ref: active.ref, afterId: active.elementId } : { pageId: p.id, x: LAYOUT.bodyX, y: nextFreeY(p) };
  };

  const tabs: [Tab, string][] = [["home", "Home"], ["insert", "Insert"], ["draw", "Draw"], ["view", "View"]];

  return (
    <div className="ribbon">
      <div className="ribbon-tabs" role="tablist" aria-label="Ribbon">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`ribbon-tab${tab === id ? " is-on" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <div className="tb-spacer" />
        <div className="tb-group tb-zoom">
          <Btn label="Zoom out" kbd="⌘−" disabled={zoom <= MIN_ZOOM} onClick={() => canvasApi.current?.zoomOut()}><Icon.minus /></Btn>
          <Menu label="Zoom" button={<span className="tb-zoom-val">{Math.round(zoom * 100)}%</span>}>
            {(close) => (
              <>
                {[0.5, 0.75, 1, 1.5, 2, 3].map((z) => (
                  <button key={z} role="menuitemradio" aria-checked={Math.abs(zoom - z) < 0.005} onClick={() => (canvasApi.current?.setZoom(z), close())}>{z * 100}%</button>
                ))}
                <button onClick={() => (canvasApi.current?.zoomToPageWidth(), close())}>Page width</button>
                <p className="menu-note">Range {MIN_ZOOM * 100}%–{MAX_ZOOM * 100}%. Pinch or ⌃-scroll to zoom.</p>
              </>
            )}
          </Menu>
          <Btn label="Zoom in" kbd="⌘=" disabled={zoom >= MAX_ZOOM} onClick={() => canvasApi.current?.zoomIn()}><Icon.plus /></Btn>
          <Btn label="Page width" onClick={() => canvasApi.current?.zoomToPageWidth()}><Icon.fitWidth /></Btn>
        </div>

        <Btn label="Undo" kbd="⌘Z" disabled={!canUndo} onClick={() => store.undo()}><Icon.undo /></Btn>
        <Btn label="Redo" kbd="⇧⌘Z" disabled={!canRedo} onClick={() => store.redo()}><Icon.redo /></Btn>
        <Btn label="Find Tags" on={sidePanel === "tags"} onClick={() => store.setUi({ sidePanel: sidePanel === "tags" ? null : "tags", preview: null })}><Icon.todo /></Btn>
        <Btn label="Page versions" on={sidePanel === "versions"} onClick={() => store.setUi({ sidePanel: sidePanel === "versions" ? null : "versions", preview: null })}><Icon.history /></Btn>
        <Menu label="More" button={<Icon.more />}>
          {(close) => (
            <>
              <button onClick={() => (store.setUi({ dialog: { kind: "templates" } }), close())}>Page templates…</button>
              <button onClick={() => (printPage(), close())}>Print or save as PDF…</button>
              <button onClick={() => (exportPageMarkdown(), close())}>Export page as Markdown</button>
            </>
          )}
        </Menu>
      </div>

      <div className="toolbar" role="toolbar" aria-label={tabs.find((t) => t[0] === tab)![1]}>
        {tab === "home" && (
          <>
            <div className="tb-group">
              <Menu label="Paragraph style" wide button={<span className="tb-style">{STYLES.find((s) => s.value === style)?.label}<Icon.chevron width={14} height={14} /></span>}>
                {(close) =>
                  STYLES.map((s) => (
                    <button key={s.value} role="menuitemradio" aria-checked={s.value === style} className={`style-opt s-${s.value}`} disabled={el?.kind !== "text"}
                      onClick={() => (editActive((d) => ops.setParagraphStyle(d, active!.ref, active!.elementId, s.value)), close())}>
                      {s.label}
                    </button>
                  ))
                }
              </Menu>
              <Menu label="Font" wide button={<span className="tb-style tb-font">{formats.font ?? "Font"}<Icon.chevron width={14} height={14} /></span>}>
                {(close) => FONTS.map((f) => (
                  <button key={f} role="menuitemradio" aria-checked={formats.font === f} style={{ fontFamily: f }} onClick={() => (applyStyle({ fontFamily: f }), close())}>{f}</button>
                ))}
              </Menu>
              <Menu label="Font size" button={<span className="tb-style tb-size">{formats.size ?? 11}<Icon.chevron width={14} height={14} /></span>}>
                {(close) => SIZES.map((sz) => (
                  <button key={sz} role="menuitemradio" aria-checked={formats.size === sz} onClick={() => (applyStyle({ fontSize: `${sz}pt` }), close())}>{sz}</button>
                ))}
              </Menu>
            </div>
            <div className="tb-group">
              <Btn label="Bold" kbd="⌘B" on={formats.b} onClick={() => exec("bold")}><Icon.bold /></Btn>
              <Btn label="Italic" kbd="⌘I" on={formats.i} onClick={() => exec("italic")}><Icon.italic /></Btn>
              <Btn label="Underline" kbd="⌘U" on={formats.u} onClick={() => exec("underline")}><Icon.underline /></Btn>
              <Btn label="Strikethrough" on={formats.s} onClick={() => exec("strikeThrough")}><Icon.strike /></Btn>
              <Btn label="Subscript" on={formats.sub} onClick={() => exec("subscript")}><span className="tb-text">x<sub>2</sub></span></Btn>
              <Btn label="Superscript" on={formats.sup} onClick={() => exec("superscript")}><span className="tb-text">x<sup>2</sup></span></Btn>
              <Menu label="Highlight color" button={<span className="tb-color"><Icon.highlight /><i style={{ background: "#ffff00" }} /></span>}>
                {(close) => <Swatches label="Highlight colors" colors={HIGHLIGHT_COLORS} none="No color" onPick={(c) => (c ? exec("hiliteColor", c) : clearStyle("background-color"), close())} />}
              </Menu>
              <Menu label="Font color" button={<span className="tb-color"><span className="tb-text tb-a">A</span><i style={{ background: "#c00000" }} /></span>}>
                {(close) => <Swatches label="Font colors" colors={FONT_COLORS} none="Automatic" onPick={(c) => (c ? exec("foreColor", c) : clearStyle("color"), close())} />}
              </Menu>
              <Btn label="Clear formatting" kbd="⌥⌘0" disabled={el?.kind !== "text"} onClick={() => editActive((d) => ops.clearFormatting(d, active!.ref, active!.elementId))}><span className="tb-text">A<sub>⌫</sub></span></Btn>
            </div>
            <div className="tb-group">
              <Btn label="Bullets" kbd="⌘." on={el?.list?.kind === "bullet"} disabled={!active} onClick={() => editActive((d) => ops.toggleList(d, active!.ref, [active!.elementId], "bullet"))}><Icon.bullets /></Btn>
              <Btn label="Numbering" kbd="⌘/" on={el?.list?.kind === "numbered"} disabled={!active} onClick={() => editActive((d) => ops.toggleList(d, active!.ref, [active!.elementId], "numbered"))}><Icon.numbers /></Btn>
              <Btn label="Outdent" kbd="⇧Tab" disabled={!active} onClick={() => editActive((d) => ops.outdent(d, active!.ref, active!.elementId))}><Icon.outdent /></Btn>
              <Btn label="Indent" kbd="Tab" disabled={!active} onClick={() => editActive((d) => ops.indent(d, active!.ref, active!.elementId))}><Icon.indent /></Btn>
              <Menu label="Alignment" button={align === "center" ? <Icon.alignCenter /> : align === "right" ? <Icon.alignRight /> : <Icon.alignLeft />}>
                {(close) => (["left", "center", "right"] as const).map((a) => (
                  <button key={a} role="menuitemradio" aria-checked={align === a} disabled={el?.kind !== "text"}
                    onClick={() => (editActive((d) => ops.setAlignment(d, active!.ref, active!.elementId, a)), close())}>
                    {a === "left" ? <Icon.alignLeft /> : a === "center" ? <Icon.alignCenter /> : <Icon.alignRight />} Align {a}
                  </button>
                ))}
              </Menu>
            </div>
            <div className="tb-group">
              <Btn label="To Do tag" kbd="⌘1" on={hasTag("todo")} disabled={!active} onClick={() => editActive((d) => ops.toggleTag(d, active!.ref, active!.elementId, "todo"))}><TagIcon def={TAGS[0]!} /></Btn>
              <Menu label="Tags" wide button={<span className="tb-style">Tags<Icon.chevron width={14} height={14} /></span>}>
                {(close) => (
                  <div className="tag-menu">
                    {TAGS.map((t) => (
                      <button key={t.id} role="menuitemcheckbox" aria-checked={hasTag(t.id)} disabled={!active}
                        onClick={() => (editActive((d) => ops.toggleTag(d, active!.ref, active!.elementId, t.id)), close())}>
                        <TagIcon def={t} /> <span>{t.label}</span>
                        {t.shortcut && <kbd>⌘{t.shortcut}</kbd>}
                      </button>
                    ))}
                    <hr />
                    <button disabled={!el?.tags?.length} onClick={() => (editActive((d) => ops.clearTags(d, active!.ref, active!.elementId)), close())}>
                      Remove tags <kbd>⌘0</kbd>
                    </button>
                    <button onClick={() => (store.setUi({ sidePanel: "tags" }), close())}>Find Tags…</button>
                  </div>
                )}
              </Menu>
            </div>
            {inTable && active && "tableId" in active.ref && <TableMenu />}
          </>
        )}

        {tab === "insert" && (
          <>
            <div className="tb-group">
              <Menu label="Table" wide button={<span className="tb-labeled"><Icon.table /> Table</span>}>
                {(close) => <TableGrid onPick={(r, c) => (insertTable(r, c), close())} />}
              </Menu>
              <Btn label="Picture" wide onClick={() => imageInput.current?.click()}><span className="tb-labeled"><Icon.image /> Picture</span></Btn>
              <Btn label="File attachment" wide onClick={() => fileInput.current?.click()}><span className="tb-labeled"><Icon.file /> File</span></Btn>
              <Btn label="Link" kbd="⌘K" wide disabled={el?.kind !== "text"} onClick={promptLink}><span className="tb-labeled"><Icon.link /> Link</span></Btn>
            </div>
            <div className="tb-group">
              <Btn label="Insert date" kbd="⌥⇧D" wide onClick={() => insertText(dateStr())}><span className="tb-labeled">Date</span></Btn>
              <Btn label="Insert time" kbd="⌥⇧T" wide onClick={() => insertText(timeStr())}><span className="tb-labeled">Time</span></Btn>
              <Btn label="Insert date and time" kbd="⌥⇧F" wide onClick={() => insertText(`${dateStr()} ${timeStr()}`)}><span className="tb-labeled">Date &amp; Time</span></Btn>
            </div>
            <div className="tb-group">
              <Btn label="Page templates" wide onClick={() => store.setUi({ dialog: { kind: "templates" } })}><span className="tb-labeled"><Icon.page /> Page templates</span></Btn>
            </div>
          </>
        )}

        {tab === "draw" && (
          <>
            <div className="tb-group">
              <Btn label="Type" on={draw.tool === "type"} wide onClick={() => pickTool("type")}><span className="tb-labeled">Type</span></Btn>
              <Btn label="Pen" on={draw.tool === "pen"} onClick={() => pickTool("pen")}><Icon.pen /></Btn>
              <Btn label="Highlighter" on={draw.tool === "highlighter"} onClick={() => pickTool("highlighter")}><Icon.highlight /></Btn>
              <Btn label="Eraser" on={draw.tool === "eraser"} onClick={() => pickTool("eraser")}><Icon.eraser /></Btn>
            </div>
            <div className="tb-group">
              {(draw.tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS).map((c) => {
                const on = draw.tool === "highlighter" ? draw.highlighterColor === c : draw.penColor === c;
                return (
                  <button key={c} className={`pen-swatch${on ? " is-on" : ""}`} style={{ background: c }} aria-label={`Ink color ${c}`} aria-pressed={on}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setDraw(draw.tool === "highlighter" ? { highlighterColor: c } : { penColor: c, tool: "pen" })} />
                );
              })}
            </div>
            <div className="tb-group">
              {(draw.tool === "highlighter" ? [8, 14, 22] : [1, 2, 4]).map((w) => {
                const on = draw.tool === "highlighter" ? draw.highlighterWidth === w : draw.penWidth === w;
                return (
                  <Btn key={w} label={`Thickness ${w}`} on={on} onClick={() => setDraw(draw.tool === "highlighter" ? { highlighterWidth: w } : { penWidth: w })}>
                    <span className="thickness" style={{ height: Math.min(12, Math.max(2, w)) }} />
                  </Btn>
                );
              })}
            </div>
            <div className="tb-group tb-hint">{draw.tool === "type" ? "Pick a pen to draw on the page." : draw.tool === "eraser" ? "Drag across strokes to erase them." : "Draw anywhere on the page. Two-finger scroll still pans."}</div>
          </>
        )}

        {tab === "view" && page && (
          <>
            <div className="tb-group">
              <Btn label="Full page view" on={fullPage} wide onClick={() => store.setUi({ fullPage: !fullPage })}><span className="tb-labeled"><Icon.fullPage /> Full page</span></Btn>
              <Btn label="Hide page title" on={!!page.hideTitle} wide onClick={() => store.edit((d) => ops.setHideTitle(d, page.id, !page.hideTitle))}><span className="tb-labeled">Hide title</span></Btn>
            </div>
            <div className="tb-group">
              <Menu label="Page color" wide button={<span className="tb-labeled"><i className="paper-chip" style={{ background: page.paper?.color ?? "var(--paper)" }} /> Page color</span>}>
                {(close) => PAGE_COLORS.map(([name, c]) => (
                  <button key={name} role="menuitemradio" aria-checked={(page.paper?.color ?? undefined) === c} onClick={() => (store.edit((d) => ops.setPaper(d, page.id, { color: c })), close())}>
                    <i className="paper-chip" style={{ background: c ?? "var(--paper)" }} /> {name}
                  </button>
                ))}
              </Menu>
              <Menu label="Rule lines" wide button={<span className="tb-labeled"><Icon.ruled /> Rule lines</span>}>
                {(close) => (
                  <>
                    {RULES.map(([v, name]) => (
                      <button key={v} role="menuitemradio" aria-checked={(page.paper?.rule ?? "none") === v} onClick={() => (store.edit((d) => ops.setPaper(d, page.id, { rule: v === "none" ? undefined : v })), close())}>
                        {name}
                      </button>
                    ))}
                    <hr />
                    <div className="menu-note">Rule line color</div>
                    {RULE_COLORS.map(([name, c]) => (
                      <button key={c} role="menuitemradio" aria-checked={(page.paper?.ruleColor ?? RULE_COLORS[0]![1]) === c} onClick={() => (store.edit((d) => ops.setPaper(d, page.id, { ruleColor: c })), close())}>
                        <i className="paper-chip" style={{ background: c }} /> {name}
                      </button>
                    ))}
                  </>
                )}
              </Menu>
            </div>
            <div className="tb-group">
              <label className="tb-check">
                <input type="checkbox" checked={anchor === "pointer"} onChange={(e) => (store.setUi({ zoomAnchor: e.target.checked ? "pointer" : "viewportOrigin" }), persistSelection())} />
                Zoom around pointer
              </label>
            </div>
          </>
        )}

        <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const t = filesTarget();
          if (t && files.length) insertImageFiles(files, t);
        }} />
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const t = filesTarget();
          if (t && files.length) insertAttachments(files, t);
        }} />
      </div>
    </div>
  );
}

function TableMenu() {
  const active = useStore((s) => s.ui.active);
  if (!active || !("tableId" in active.ref)) return null;
  const r = active.ref;
  const colIndex = () => ops.findTable(store.getState().lib, r.pageId, r.outlineId, r.tableId)?.rows.find((x) => x.id === r.rowId)?.cells.findIndex((c) => c.id === r.cellId) ?? -1;
  const rowIndex = () => ops.findTable(store.getState().lib, r.pageId, r.outlineId, r.tableId)?.rows.findIndex((x) => x.id === r.rowId) ?? -1;
  return (
    <div className="tb-group">
      <Menu label="Table" wide button={<span className="tb-style">Table<Icon.chevron width={14} height={14} /></span>}>
        {(close) => {
          const act = (fn: () => void) => () => (fn(), close());
          const t = ops.findTable(store.getState().lib, r.pageId, r.outlineId, r.tableId);
          return (
            <>
              <button onClick={act(() => store.edit((d) => ops.addTableRow(d, r.pageId, r.outlineId, r.tableId, rowIndex() > 0 ? t?.rows[rowIndex() - 1]!.id : undefined, rowIndex() === 0)))}>Insert row above</button>
              <button onClick={act(() => store.edit((d) => ops.addTableRow(d, r.pageId, r.outlineId, r.tableId, r.rowId)))}>Insert row below</button>
              <button onClick={act(() => store.edit((d) => ops.addTableColumn(d, r.pageId, r.outlineId, r.tableId, colIndex() - 1)))}>Insert column left</button>
              <button onClick={act(() => store.edit((d) => ops.addTableColumn(d, r.pageId, r.outlineId, r.tableId, colIndex())))}>Insert column right</button>
              <hr />
              <button onClick={act(() => store.edit((d) => ops.setTableBorders(d, r.pageId, r.outlineId, r.tableId, !t?.borders)))}>{t?.borders ? "Hide borders" : "Show borders"}</button>
              <div className="menu-note">Cell shading</div>
              <Swatches label="Cell shading" colors={["#fde0dd", "#fff6c7", "#e3f4d6", "#dbe9f9", "#ece2f6", "#ececec"]} none="None"
                onPick={(c) => (store.edit((d) => ops.setCellShading(d, r, c)), close())} />
              <hr />
              <button onClick={act(() => store.edit((d) => ops.sortTable(d, r.pageId, r.outlineId, r.tableId, colIndex())))}>Sort rows by this column</button>
              <hr />
              <button onClick={act(() => store.edit((d) => ops.deleteTableRow(d, r.pageId, r.outlineId, r.tableId, r.rowId)))}>Delete row</button>
              <button onClick={act(() => store.edit((d) => ops.deleteTableColumn(d, r.pageId, r.outlineId, r.tableId, colIndex())))}>Delete column</button>
              <button className="danger" onClick={act(() => store.edit((d) => ops.deleteElement(d, { pageId: r.pageId, outlineId: r.outlineId }, r.tableId)))}>Delete table</button>
            </>
          );
        }}
      </Menu>
    </div>
  );
}
