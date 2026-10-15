// Paste with formatting: turn clipboard HTML (web pages, Word, OneNote) into
// paragraphs of runs. Keeps emphasis, links, colors, headings and lists; drops
// fonts, sizes and backgrounds so pasted text matches the page.
import type { ListStyle, ParagraphStyle, Run } from "../model/types.ts";
import { domToRuns, normalizeRuns } from "./richtext.ts";
import { defaultList } from "../model/lists.ts";

export interface PastedBlock {
  runs: Run[];
  style?: ParagraphStyle;
  list?: ListStyle;
  depth?: number;
}

const BLOCKS = new Set(
  "P DIV LI UL OL H1 H2 H3 H4 H5 H6 BLOCKQUOTE PRE TABLE TBODY THEAD TR DL DT DD SECTION ARTICLE HEADER FOOTER MAIN ASIDE NAV FIGURE FIGCAPTION HR".split(" "),
);
const SKIP = "script,style,head,meta,title,noscript,template,iframe,object,svg,img,video,audio,canvas";

const isBlock = (n: Node): n is HTMLElement => n instanceof HTMLElement && BLOCKS.has(n.tagName);

/** Near-black, near-white and grey text colors come from the source page's theme, not the author. */
function themeColor(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return true;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x!, 16) / 255) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 0.25 || lum > 0.9 || Math.max(r, g, b) - Math.min(r, g, b) < 0.08;
}

function cleanRuns(runs: Run[]): Run[] {
  const out = runs.map((r) => {
    const { font: _f, size: _s, highlight: _h, ...rest } = r;
    if (rest.color && themeColor(rest.color)) delete rest.color;
    if (rest.href && !/^(https?:|mailto:|notecraft:)/i.test(rest.href)) delete rest.href;
    return rest;
  });
  if (out[0]) out[0].text = out[0].text.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, "");
  return normalizeRuns(out.filter((r) => r.text));
}

function collapseWhitespace(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) n.textContent = (n.textContent ?? "").replace(/[ \t\r\n]+/g, " ");
}

export function htmlToBlocks(html: string): PastedBlock[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(SKIP).forEach((n) => n.remove());
  const blocks: PastedBlock[] = [];

  const emit = (owner: HTMLElement, nodes: Node[], meta: Omit<PastedBlock, "runs">, pre: boolean) => {
    if (!nodes.length) return;
    const host = document.createElement("div");
    const shell = document.createElement("span");
    shell.style.cssText = owner.style.cssText;
    nodes.forEach((n) => shell.appendChild(document.importNode(n, true)));
    if (!pre) collapseWhitespace(shell);
    host.appendChild(shell);
    const runs = cleanRuns(domToRuns(host));
    if (runs.length) blocks.push({ runs, ...meta });
  };

  /** Lists use OneNote's per-level schemes (• ◦ ▪, 1. a. i.). */
  const visit = (el: HTMLElement, list: ListStyle["kind"] | undefined, depth: number, inItem: boolean, pre: boolean) => {
    const tag = el.tagName;
    const h = /^H([1-6])$/.exec(tag);
    const style: ParagraphStyle | undefined = h ? (`h${h[1]}` as ParagraphStyle) : tag === "BLOCKQUOTE" ? "quote" : tag === "PRE" ? "code" : undefined;
    const item = tag === "LI" || (inItem && (tag === "P" || tag === "DIV"));
    const meta = { ...(style ? { style } : {}), ...(item && list ? { list: defaultList(list, depth), depth } : {}) };
    const isPre = pre || tag === "PRE";
    let inline: Node[] = [];
    for (const c of Array.from(el.childNodes)) {
      if (!isBlock(c)) {
        inline.push(c);
        continue;
      }
      emit(el, inline, meta, isPre);
      inline = [];
      const nested = c.tagName === "UL" || c.tagName === "OL";
      const childList = c.tagName === "UL" ? "bullet" : c.tagName === "OL" ? "numbered" : list;
      const childDepth = nested && (tag === "LI" || tag === "UL" || tag === "OL") ? depth + 1 : depth;
      visit(c, childList, childDepth, tag === "LI", isPre);
    }
    emit(el, inline, meta, isPre);
  };

  visit(doc.body, undefined, 0, false, false);
  return blocks;
}
