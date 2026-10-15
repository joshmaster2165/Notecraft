// Rich text runs <-> contentEditable DOM. A paragraph is a list of runs, the
// same shape as OneNote's RichEditTextUnicode split by TextRunIndex with one
// style object per run (TextRunFormatting).

import type { Run } from "../model/types.ts";

type Style = Omit<Run, "text">;
const STYLE_KEYS: (keyof Style)[] = ["b", "i", "u", "s", "sup", "sub", "highlight", "color", "font", "size", "href"];

export function sameStyle(a: Style, b: Style): boolean {
  return STYLE_KEYS.every((k) => (a[k] ?? undefined) === (b[k] ?? undefined));
}

export function styleOf(run: Run): Style {
  const { text: _t, ...s } = run;
  return s;
}

/** Merge adjacent runs with identical style and drop empty ones. */
export function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(styleOf(last), styleOf(r))) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

export function runsText(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}

export function textLength(runs: Run[]): number {
  return runs.reduce((n, r) => n + r.text.length, 0);
}

/** Split at a character offset into [before, after]. */
export function splitRuns(runs: Run[], offset: number): [Run[], Run[]] {
  const before: Run[] = [];
  const after: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    if (end <= offset) before.push({ ...r });
    else if (pos >= offset) after.push({ ...r });
    else {
      before.push({ ...r, text: r.text.slice(0, offset - pos) });
      after.push({ ...r, text: r.text.slice(offset - pos) });
    }
    pos = end;
  }
  return [normalizeRuns(before), normalizeRuns(after)];
}

// --- HTML rendering ------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function runsToHtml(runs: Run[], opts: { darkPaper?: boolean } = {}): string {
  let html = "";
  for (const r of runs) {
    let inner = esc(r.text).replace(/\n/g, "<br>");
    const css: string[] = [];
    if (r.highlight) css.push(`background-color:${r.highlight}`);
    if (r.color && !(opts.darkPaper && isNearBlack(r.color))) css.push(`color:${r.color}`);
    if (r.font) css.push(`font-family:${esc(cssFont(r.font))}`);
    if (r.size) css.push(`font-size:${r.size}pt`);
    if (css.length) inner = `<span style="${css.join(";")}">${inner}</span>`;
    if (r.sub) inner = `<sub>${inner}</sub>`;
    if (r.sup) inner = `<sup>${inner}</sup>`;
    if (r.s) inner = `<s>${inner}</s>`;
    if (r.u) inner = `<u>${inner}</u>`;
    if (r.i) inner = `<i>${inner}</i>`;
    if (r.b) inner = `<b>${inner}</b>`;
    if (r.href) inner = `<a href="${esc(r.href)}" target="_blank" rel="noreferrer">${inner}</a>`;
    html += inner;
  }
  // A trailing <br> needs a sentinel or the browser collapses the empty line.
  if (html.endsWith("<br>") || html.endsWith("<br></span>")) html += "<br>";
  return html;
}

function cssFont(font: string): string {
  return `"${font.replace(/"/g, "")}", var(--font-note)`;
}

function isNearBlack(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  const r = n >> 16, g = (n >> 8) & 0xff, b = n & 0xff;
  return r + g + b < 120;
}

// --- DOM serialisation --------------------------------------------------------------

function rgbToHex(v: string): string | undefined {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(v);
  if (!m) return v || undefined;
  if (m[4] !== undefined && Number(m[4]) === 0) return undefined;
  return "#" + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("");
}

function fontName(v: string): string | undefined {
  const first = v.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
  return first && !first.startsWith("var(") ? first : undefined;
}

/** Read a contentEditable element back into runs. */
export function domToRuns(root: HTMLElement): Run[] {
  const runs: Run[] = [];
  const walk = (node: Node, style: Style) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/ /g, " ");
      if (text) runs.push({ ...style, text });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      runs.push({ ...style, text: "\n" });
      return;
    }
    const s: Style = { ...style };
    switch (node.tagName) {
      case "B": case "STRONG": s.b = true; break;
      case "I": case "EM": s.i = true; break;
      case "U": s.u = true; break;
      case "S": case "STRIKE": case "DEL": s.s = true; break;
      case "SUP": s.sup = true; break;
      case "SUB": s.sub = true; break;
      case "MARK": s.highlight = "#fff3a3"; break;
      case "A": s.href = node.getAttribute("href") ?? undefined; break;
    }
    const st = node.style;
    if (st.fontWeight === "bold" || Number(st.fontWeight) >= 600) s.b = true;
    if (st.fontWeight === "normal" || st.fontWeight === "400") delete s.b;
    if (st.fontStyle === "italic") s.i = true;
    const deco = st.textDecorationLine || st.textDecoration;
    if (deco.includes("underline")) s.u = true;
    if (deco.includes("line-through")) s.s = true;
    if (st.backgroundColor) s.highlight = rgbToHex(st.backgroundColor);
    if (st.color) s.color = rgbToHex(st.color);
    if (st.fontFamily) s.font = fontName(st.fontFamily) ?? s.font;
    if (st.fontSize.endsWith("pt")) s.size = parseFloat(st.fontSize);
    // Block children (pasted <div>/<p>) become line breaks.
    const block = /^(DIV|P|LI|H[1-6])$/.test(node.tagName) && node !== root;
    if (block && runs.length && !runs[runs.length - 1]!.text.endsWith("\n")) runs.push({ ...style, text: "\n" });
    node.childNodes.forEach((c) => walk(c, s));
  };
  root.childNodes.forEach((c) => walk(c, {}));
  // Drop the sentinel <br> that keeps a trailing empty line visible.
  const out = normalizeRuns(runs);
  const last = out[out.length - 1];
  if (last?.text.endsWith("\n")) {
    last.text = last.text.slice(0, -1);
    if (!last.text) out.pop();
  }
  return out;
}

// --- caret helpers --------------------------------------------------------------------

/** Character offset of the caret inside `root`, counting <br> as one character. */
export function getCaretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  return offsetOf(root, range.startContainer, range.startOffset);
}

export function getSelectionOffsets(root: HTMLElement): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
  return [offsetOf(root, r.startContainer, r.startOffset), offsetOf(root, r.endContainer, r.endOffset)];
}

function offsetOf(root: HTMLElement, container: Node, offset: number): number {
  let count = 0;
  let done = false;
  const walk = (node: Node) => {
    if (done) return;
    if (node === container && node.nodeType === Node.TEXT_NODE) {
      count += offset;
      done = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      count += node.textContent?.length ?? 0;
      return;
    }
    if (node instanceof HTMLElement && node.tagName === "BR") {
      count += 1; // callers clamp to the model length (the trailing sentinel <br> overshoots by one)
      return;
    }
    const kids = Array.from(node.childNodes);
    for (let i = 0; i < kids.length; i++) {
      if (node === container && i === offset) {
        done = true;
        return;
      }
      walk(kids[i]!);
      if (done) return;
    }
    if (node === container) done = true;
  };
  walk(root);
  return count;
}

/** Place the caret at a character offset (clamped). */
export function setCaretOffset(root: HTMLElement, target: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let remaining = Math.max(0, target);
  let placed = false;
  const walk = (node: Node) => {
    if (placed) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        placed = true;
      } else remaining -= len;
      return;
    }
    if (node instanceof HTMLElement && node.tagName === "BR") {
      if (remaining === 0) {
        range.setStartBefore(node);
        placed = true;
      } else remaining -= 1;
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** True when the caret sits on the first / last rendered line of `root`. */
export function caretOnEdgeLine(root: HTMLElement, edge: "first" | "last"): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return true;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  let rect = range.getClientRects()[0];
  if (!rect) {
    const off = getCaretOffset(root) ?? 0;
    return edge === "first" ? off === 0 : off >= (root.textContent?.length ?? 0);
  }
  const box = root.getBoundingClientRect();
  const lineH = parseFloat(getComputedStyle(root).lineHeight) || rect.height || 16;
  return edge === "first" ? rect.top - box.top < lineH * 0.8 : box.bottom - rect.bottom < lineH * 0.8;
}

/** Find bare URLs typed or pasted into plain runs and turn them into links. */
export function autoLink(runs: Run[]): Run[] {
  const out: Run[] = [];
  const re = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;
  for (const r of runs) {
    if (r.href) {
      out.push(r);
      continue;
    }
    let last = 0;
    for (const m of r.text.matchAll(re)) {
      if (m.index! > last) out.push({ ...r, text: r.text.slice(last, m.index) });
      out.push({ ...r, text: m[0], href: m[0] });
      last = m.index! + m[0].length;
    }
    if (last < r.text.length) out.push({ ...r, text: r.text.slice(last) });
  }
  return normalizeRuns(out);
}
