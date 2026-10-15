// Markdown ↔ notes, matching notecraft-core's markdown.rs: AI answers and
// agent text become paragraphs (headings, lists, to-dos, emphasis, links).
import type { Element, ParagraphEl, Run } from "../model/types.ts";
import { paragraph } from "../model/ops.ts";
import { defaultList } from "../model/lists.ts";
import { normalizeRuns } from "./richtext.ts";

// Inline Markdown: bold, italic, strikethrough, code spans and links.
export function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  const re = /\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(?!\s)(.+?)\*|_(?!\s)(.+?)_|`(.+?)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1] ?? m[2]) runs.push({ text: (m[1] ?? m[2])!, b: true });
    else if (m[3]) runs.push({ text: m[3], s: true });
    else if (m[4] ?? m[5]) runs.push({ text: (m[4] ?? m[5])!, i: true });
    else if (m[6]) runs.push({ text: m[6], font: "Consolas" });
    else if (m[7]) runs.push({ text: m[7], ...(/^(https?:|mailto:|notecraft:)/i.test(m[8]!) ? { href: m[8] } : {}) });
    last = m.index! + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return normalizeRuns(runs.filter((r) => r.text));
}

export function markdownToElements(md: string): Element[] {
  const out: Element[] = [];
  let inCode = false;
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(paragraph([{ text: line, font: "Consolas" }], { style: "code" }));
      continue;
    }
    if (!line.trim()) continue;
    const depth = Math.min(8, Math.floor((line.length - line.trimStart().length) / 2));
    const t = line.trimStart();
    let m: RegExpExecArray | null;
    let el: ParagraphEl;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) el = paragraph(inlineRuns(m[2]!), { style: `h${m[1]!.length}` as ParagraphEl["style"] });
    else if ((m = /^>\s?(.*)$/.exec(t))) el = paragraph(inlineRuns(m[1]!), { depth, style: "quote" });
    else if ((m = /^[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(t))) el = paragraph(inlineRuns(m[2]!), { depth, tags: [{ kind: "todo", done: m[1] !== " " }] });
    else if ((m = /^[-*+]\s+(.*)$/.exec(t))) el = paragraph(inlineRuns(m[1]!), { depth, list: defaultList("bullet", depth) });
    else if ((m = /^\d{1,3}[.)]\s+(.*)$/.exec(t))) el = paragraph(inlineRuns(m[1]!), { depth, list: defaultList("numbered", depth) });
    else if (/^(-{3,}|\*{3,})$/.test(t)) continue;
    else el = paragraph(inlineRuns(t), { depth });
    out.push(el);
  }
  return out;
}
