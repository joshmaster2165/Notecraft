// ⌘F: find on this page. Matches are painted with the CSS Custom Highlight
// API, so the editable DOM is never modified.
import { useEffect, useRef, useState } from "react";
import { store, useStore } from "../store/store.ts";
import { revealRect } from "./canvasApi.ts";
import { Icon } from "./icons.tsx";

const supported = typeof CSS !== "undefined" && "highlights" in CSS;

function findRanges(query: string): Range[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const roots = document.querySelectorAll<HTMLElement>(".paper .page-title-text, .paper .oe-editable");
  const ranges: Range[] = [];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.toLowerCase() ?? "";
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + q.length);
        ranges.push(r);
      }
    }
  }
  return ranges;
}

export function FindBar() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const lib = useStore((s) => s.lib);
  const pageId = useStore((s) => s.ui.pageId);

  useEffect(() => input.current?.focus(), []);
  // Recompute after edits or page switches (after React has painted).
  useEffect(() => {
    const t = setTimeout(() => setRanges(findRanges(query)), 30);
    return () => clearTimeout(t);
  }, [query, lib, pageId]);
  useEffect(() => setIndex(0), [query, pageId]);

  useEffect(() => {
    if (!supported) return;
    const current = ranges[Math.min(index, ranges.length - 1)];
    CSS.highlights.set("find", new Highlight(...ranges));
    if (current) {
      CSS.highlights.set("find-current", new Highlight(current));
      revealRect(current.getBoundingClientRect(), 80);
    } else CSS.highlights.delete("find-current");
    return () => {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-current");
    };
  }, [ranges, index]);

  const step = (d: number) => ranges.length && setIndex((i) => (i + d + ranges.length) % ranges.length);
  const close = () => store.setUi({ findOpen: false });

  return (
    <div className="find-bar" role="search">
      <Icon.search />
      <input
        ref={input}
        value={query}
        placeholder="Find on page"
        aria-label="Find on page"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.preventDefault(), step(e.shiftKey ? -1 : 1));
          if (e.key === "Escape") close();
        }}
      />
      <span className="find-count" aria-live="polite">{query ? (ranges.length ? `${Math.min(index, ranges.length - 1) + 1} of ${ranges.length}` : "No matches") : ""}</span>
      <button className="icon-btn" aria-label="Previous match" onClick={() => step(-1)} disabled={!ranges.length}><Icon.chevron className="flip" /></button>
      <button className="icon-btn" aria-label="Next match" onClick={() => step(1)} disabled={!ranges.length}><Icon.chevron /></button>
      <button className="icon-btn" aria-label="Close find" onClick={close}><Icon.close /></button>
    </div>
  );
}
