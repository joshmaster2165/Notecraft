// One editable paragraph (RichTextOENode). The DOM is uncontrolled while the
// user types; the model is updated on every input and the DOM is only
// rewritten when the model changes from elsewhere (undo, merge, import).
import { memo, useLayoutEffect, useRef, type KeyboardEvent, type ClipboardEvent } from "react";
import type { Id, ListRef, ParagraphEl, ParagraphStyle, TagKind } from "../../model/types.ts";
import * as ops from "../../model/ops.ts";
import { store, useStore } from "../../store/store.ts";
import { insertImageFiles, pasteBlocks, pasteLines } from "../../store/actions.ts";
import { htmlToBlocks } from "../../lib/paste.ts";
import { autoLink, caretOnEdgeLine, domToRuns, getCaretOffset, runsToHtml, setCaretOffset, textLength } from "../../lib/richtext.ts";
import { revealRect } from "../canvasApi.ts";
import { TagGutter } from "./TagGutter.tsx";
import { tagByShortcut, tagHighlight } from "../../model/tags.ts";
import { followLink, linkPagesByTitle, pageLinkHtml } from "../../store/links.ts";
import { LAYOUT } from "../../model/types.ts";
import { useReadOnly } from "./readOnly.ts";
import { askText } from "../prompt.ts";

export interface CellNav {
  next(): void;
  prev(): void;
}

interface Props {
  el: ParagraphEl;
  listRef: ListRef;
  marker: string | null;
  prevId: Id | null;
  nextId: Id | null;
  cellNav?: CellNav;
  placeholder?: string;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

const darkPaper = () => document.documentElement.dataset.paper === "dark";

export const Paragraph = memo(function Paragraph({ el, listRef, marker, prevId, nextId, cellNav, placeholder }: Props) {
  const readOnly = useReadOnly();
  const ref = useRef<HTMLDivElement>(null);
  const renderedKey = useRef<string | null>(null);
  const pastePlain = useRef(false);
  const focusReq = useStore((s) => (s.ui.focus?.elementId === el.id ? s.ui.focus : null));

  // Sync model -> DOM only when the runs differ from what the DOM already shows.
  useLayoutEffect(() => {
    const key = JSON.stringify(el.runs);
    if (key === renderedKey.current || !ref.current) return;
    renderedKey.current = key;
    ref.current.innerHTML = runsToHtml(el.runs, { darkPaper: darkPaper() });
  }, [el.runs]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!focusReq || !node) return;
    node.focus({ preventScroll: true });
    const len = textLength(el.runs);
    setCaretOffset(node, focusReq.offset === "end" ? len : Math.min(focusReq.offset, len));
    revealCaret(node);
  }, [focusReq?.seq]);

  const edit: typeof store.edit = (fn, opts) => store.edit(fn, opts);

  const commitDom = () => {
    const node = ref.current;
    if (!node) return;
    const runs = domToRuns(node);
    // [[Page title]] links to that page (created if it doesn't exist), as in OneNote.
    if (runs.some((r) => !r.href && r.text.includes("]]"))) {
      const at = getCaretOffset(node) ?? 0;
      const linked = store.edit((d) => {
        const res = linkPagesByTitle(d, listRef.pageId, runs);
        ops.setRuns(d, listRef, el.id, res.runs);
        return res;
      });
      if (linked.changed) {
        store.focus(el.id, Math.max(0, at - linked.removedBefore(at)));
        return;
      }
    }
    renderedKey.current = JSON.stringify(runs);
    store.edit((d) => ops.setRuns(d, listRef, el.id, runs), { coalesce: `text:${el.id}` });
    revealCaret(node);
  };

  const caret = () => {
    const off = getCaretOffset(ref.current!) ?? 0;
    return Math.min(off, textLength(el.runs));
  };

  const collapsed = () => {
    const sel = window.getSelection();
    return !sel || sel.isCollapsed;
  };

  const setStyle = (style: ParagraphStyle) => edit((d) => ops.setParagraphStyle(d, listRef, el.id, style));
  const tag = (kind: TagKind) => edit((d) => ops.toggleTag(d, listRef, el.id, kind));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const node = ref.current!;
    const m = mod(e);
    // ⌥⇧⌘V: Paste and Match Style.
    pastePlain.current = m && e.shiftKey && e.code === "KeyV";

    if (e.key === "Enter" && !e.shiftKey && !m) {
      e.preventDefault();
      const res = edit((d) => ops.splitParagraph(d, listRef, el.id, caret()));
      store.focus(res.focusId, res.offset);
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (cellNav) (e.shiftKey ? cellNav.prev : cellNav.next)();
      else edit((d) => (e.shiftKey ? ops.outdent : ops.indent)(d, listRef, el.id));
      return;
    }
    if (e.key === "Backspace" && collapsed() && caret() === 0 && !m) {
      e.preventDefault();
      const res = edit((d) => ops.backspaceAtStart(d, listRef, el.id));
      if (res) store.focus(res.focusId, res.offset);
      return;
    }
    if (e.key === "Delete" && collapsed() && caret() >= textLength(el.runs)) {
      e.preventDefault();
      const res = edit((d) => ops.deleteAtEnd(d, listRef, el.id));
      if (res) store.focus(res.focusId, res.offset);
      return;
    }
    if (e.key === "ArrowUp" && !e.shiftKey && prevId && caretOnEdgeLine(node, "first")) {
      e.preventDefault();
      store.focus(prevId, "end");
      return;
    }
    if (e.key === "ArrowDown" && !e.shiftKey && nextId && caretOnEdgeLine(node, "last")) {
      e.preventDefault();
      store.focus(nextId, 0);
      return;
    }
    if (e.key === "Escape") {
      node.blur();
      return;
    }
    // OneNote: Alt+Shift+D date, Alt+Shift+T time, Alt+Shift+F date and time.
    if (e.altKey && e.shiftKey && !m && (e.code === "KeyD" || e.code === "KeyT" || e.code === "KeyF")) {
      e.preventDefault();
      const now = new Date();
      const date = now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
      const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      document.execCommand("insertText", false, e.code === "KeyD" ? date : e.code === "KeyT" ? time : `${date} ${time}`);
      return;
    }
    if (!m) return;

    // OneNote shortcuts (Ctrl on Windows, ⌘ here).
    const k = e.key.toLowerCase();
    const code = e.code;
    if (k === "." || k === "/") {
      e.preventDefault();
      edit((d) => ops.toggleList(d, listRef, [el.id], k === "." ? "bullet" : "numbered"));
      return;
    }
    if (e.altKey && /^Digit[0-6]$/.test(code)) {
      e.preventDefault();
      const n = Number(code.slice(5));
      return setStyle(n === 0 ? "p" : (`h${n}` as ParagraphStyle));
    }
    if (!e.altKey && !e.shiftKey && /^Digit[0-9]$/.test(code)) {
      const n = Number(code.slice(5));
      e.preventDefault();
      if (n === 0) return void edit((d) => ops.clearTags(d, listRef, el.id));
      const def = tagByShortcut(n);
      return def ? tag(def.id) : undefined;
    }
    if (k === "k") {
      e.preventDefault();
      return void promptLink();
    }
    if (e.shiftKey && k === "h") {
      e.preventDefault();
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand("hiliteColor", false, "#fff3a3");
      return;
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      insertImageFiles(files, { ref: listRef, afterId: el.id });
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    const html = e.clipboardData.getData("text/html");
    if (!text && !html) return;
    e.preventDefault();
    const pageLink = pageLinkHtml(text.trim());
    if (pageLink) return void document.execCommand("insertHTML", false, pageLink);
    // ⌥⇧⌘V / "Paste and Match Style" arrives without HTML; keep formatting otherwise.
    if (html && !pastePlain.current) {
      const blocks = htmlToBlocks(html);
      if (blocks.length) {
        commitDom();
        return pasteBlocks(listRef, el.id, caret(), blocks);
      }
    }
    pastePlain.current = false;
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length === 1) document.execCommand("insertText", false, text);
    else {
      commitDom();
      pasteLines(listRef, el.id, caret(), lines);
    }
  };

  const onBlur = () => {
    const linked = autoLink(el.runs);
    if (JSON.stringify(linked) !== JSON.stringify(el.runs)) {
      store.edit((d) => ops.setRuns(d, listRef, el.id, linked), { coalesce: `text:${el.id}` });
    }
  };

  const indentPx = el.depth * LAYOUT.indent;
  const iconTags = el.tags ?? [];
  const checkable = iconTags.filter((t) => t.done !== undefined);
  const allDone = checkable.length > 0 && checkable.every((t) => t.done);
  return (
    <div className={`oe oe-text s-${el.style}${allDone ? " is-done" : ""}`} style={{ paddingLeft: indentPx }} data-el={el.id}>
      {(marker || iconTags.length > 0) && (
        <span className="oe-gutter" contentEditable={false}>
          {iconTags.length > 0 && <TagGutter tags={iconTags} onToggle={readOnly ? undefined : (kind) => edit((d) => ops.toggleTagDone(d, listRef, el.id, kind))} />}
          {marker && <span className="oe-marker">{marker}</span>}
        </span>
      )}
      <div
        ref={ref}
        className="oe-editable"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={commitDom}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={onBlur}
        onFocus={() => store.setUi({ active: { ref: listRef, elementId: el.id } })}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          // Links open on click, as in OneNote; ⌥-click puts the caret in the link text instead.
          if (a && !e.altKey && window.getSelection()?.isCollapsed) {
            e.preventDefault();
            followLink(a.getAttribute("href") ?? "");
          }
        }}
        style={{
          textAlign: el.align,
          marginTop: el.spaceBefore ? `${el.spaceBefore}pt` : undefined,
          marginBottom: el.spaceAfter ? `${el.spaceAfter}pt` : undefined,
          lineHeight: el.lineSpacing ? `max(1.4em, ${el.lineSpacing}pt)` : undefined,
          ...(tagHighlight(el.tags) ? { background: tagHighlight(el.tags), color: "#1d1f23" } : {}),
        }}
      />
    </div>
  );
});

/** Keep the caret (not the whole paragraph) inside the canvas viewport. */
function revealCaret(node: HTMLElement) {
  const sel = window.getSelection();
  let rect: DOMRect | undefined;
  if (sel?.rangeCount) {
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(false);
    rect = r.getClientRects()[0];
  }
  if (!rect) {
    const box = node.getBoundingClientRect();
    rect = new DOMRect(box.left, box.top, 2, Math.min(box.height, 24));
  }
  revealRect(rect);
}

/** ⌘K: wrap the selection in a link (or insert the URL when nothing is selected). */
export async function promptLink() {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const existing = (range?.startContainer.parentElement?.closest("a") as HTMLAnchorElement | null)?.getAttribute("href");
  const url = (await askText("Insert link", "Address", existing ?? "https://"))?.trim();
  if (!url || url === "https://" || !range) return;
  (range.startContainer.parentElement?.closest("[contenteditable]") as HTMLElement | null)?.focus();
  sel!.removeAllRanges();
  sel!.addRange(range);
  if (range.collapsed) document.execCommand("insertHTML", false, `<a href="${url.replace(/"/g, "&quot;")}">${url.replace(/</g, "&lt;")}</a>`);
  else document.execCommand("createLink", false, url);
}
