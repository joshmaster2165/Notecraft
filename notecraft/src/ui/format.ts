// Character formatting on the current selection inside a paragraph editor.
// Results are written as inline styles, which domToRuns reads back into runs
// (font, size, color, highlight), the same shape the .one importer produces.

export const FONTS = ["Calibri", "Arial", "Helvetica Neue", "Segoe UI", "Georgia", "Times New Roman", "Verdana", "Trebuchet MS", "Courier New", "Consolas", "Comic Sans MS"];
/** OneNote's font size list. */
export const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
/** Office standard + grayscale colors for Font Color. */
export const FONT_COLORS = ["#000000", "#444444", "#7f7f7f", "#bfbfbf", "#ffffff", "#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050", "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0"];
/** OneNote/Word text highlight palette. */
export const HIGHLIGHT_COLORS = ["#ffff00", "#00ff00", "#00ffff", "#ff00ff", "#0000ff", "#ff0000", "#000080", "#008080", "#008000", "#800080", "#800000", "#808000", "#808080", "#c0c0c0", "#000000"];

function editingHost(): HTMLElement | null {
  const node = window.getSelection()?.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  return (el?.closest(".oe-editable") as HTMLElement | null) ?? null;
}

/** With only a caret, OneNote-style formatting applies to the whole paragraph. */
function selectionOrParagraph(): { range: Range; host: HTMLElement } | null {
  const sel = window.getSelection();
  const host = editingHost();
  if (!sel || !sel.rangeCount || !host) return null;
  let range = sel.getRangeAt(0);
  if (range.collapsed) {
    range = document.createRange();
    range.selectNodeContents(host);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return { range, host };
}

const commit = (host: HTMLElement) => host.dispatchEvent(new Event("input", { bubbles: true }));

/** Wrap the selection in a span with these styles, removing the same properties underneath. */
export function applyStyle(style: Partial<Record<"fontFamily" | "fontSize" | "color" | "backgroundColor", string>>): void {
  const target = selectionOrParagraph();
  if (!target) return;
  const { range, host } = target;
  const frag = range.extractContents();
  const props = Object.keys(style).map((k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
  frag.querySelectorAll<HTMLElement>("[style]").forEach((el) => props.forEach((p) => el.style.removeProperty(p)));
  const span = document.createElement("span");
  for (const [k, v] of Object.entries(style)) if (v) (span.style as unknown as Record<string, string>)[k] = v;
  span.appendChild(frag);
  range.insertNode(span);
  const sel = window.getSelection()!;
  const after = document.createRange();
  after.selectNodeContents(span);
  sel.removeAllRanges();
  sel.addRange(after);
  commit(host);
}

export function clearStyle(prop: "color" | "background-color"): void {
  const target = selectionOrParagraph();
  if (!target) return;
  const { range, host } = target;
  const frag = range.extractContents();
  frag.querySelectorAll<HTMLElement>("[style]").forEach((el) => el.style.removeProperty(prop));
  frag.querySelectorAll("mark").forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
  range.insertNode(frag);
  commit(host);
}

export function exec(cmd: string, value?: string): void {
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand(cmd, false, value);
}

/** Font and size at the caret, for the toolbar's dropdowns. */
export function currentFont(): { font?: string; size?: number } {
  const node = window.getSelection()?.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  if (!el?.closest(".oe-editable")) return {};
  const cs = getComputedStyle(el);
  const font = cs.fontFamily.split(",")[0]?.replace(/["']/g, "").trim();
  const size = Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2;
  return { font, size };
}
