import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { OneNoteCanvas, type OneNoteCanvasHandle } from "../OneNoteCanvas.tsx";
import type { Rect, ViewportState } from "../viewport.ts";
import { PageRenderer } from "./PageRenderer.tsx";
import type { NotebookJson, Page, OutlineElementBlock } from "../../parser/src/notebook.ts";

// Synthetic sample page in the parser's output shape (no real notebook data).
let nextId = 0;
const id = () => `{demo}#${nextId++}`;
const para = (text: string, style: Record<string, unknown> = {}): OutlineElementBlock => ({
  type: "outlineElement", id: id(), content: [{ type: "richText", id: id(), text, runs: [{ start: 0, end: text.length, text, style }], paragraph: {} }], children: [],
});
const SAMPLE: Page = {
  id: "sample", title: "Canvas mechanics demo", size: {},
  titleBlocks: [
    { type: "outline", id: id(), layout: {}, role: "titleText", children: [para("Canvas mechanics demo")] },
    { type: "outline", id: id(), layout: {}, role: "titleDate", children: [para("Two-finger scroll pans · pinch or ⌃-scroll zooms")] },
  ],
  blocks: [
    { type: "outline", id: id(), layout: { x: 54, y: 110, width: 420 }, children: [
      para("Pan", { bold: true, fontSize: 14 }),
      { ...para("Two-finger scroll moves the clip origin; it stops at the page extent."), list: { kind: "bullet", bullet: "•" } },
      { ...para("Momentum comes from the OS, exactly as NSScrollView receives it."), list: { kind: "bullet", bullet: "•" } },
      para("Zoom", { bold: true, fontSize: 14 }),
      { ...para("Pinch: increment = magnification / 1.5"), list: { kind: "numbered", scheme: "decimal", suffix: "." } },
      { ...para("⌃ + wheel: increment = deltaY / 15"), list: { kind: "numbered", scheme: "decimal", suffix: "." } },
      { ...para("Menu ±: increment = ±0.1, clamped to 25%–500%"), list: { kind: "numbered", scheme: "decimal", suffix: "." } },
      { ...para("Zoom keeps the viewport's top-left content point fixed."), children: [para("Toggle the anchor below to compare with pointer-anchored zoom.", { italic: true, color: "#4a5568" })] },
    ] },
    { type: "outline", id: id(), layout: { x: 560, y: 140, width: 300 }, children: [
      { type: "outlineElement", id: id(), children: [], content: [{
        type: "table", id: id(), columnWidths: [110, 150], bordersVisible: true, rows: [
          ["Gesture", "OneNote selector"], ["Pinch", "pinchZoom:"], ["⌃ + scroll", "mouseWheelZoom:"], ["Scroll", "NSScrollView"], ["⌘ + / ⌘ −", "zoomIn / zoomOut"],
        ].map((r) => ({ id: id(), cells: r.map((t) => ({ id: id(), children: [para(t)] })) })),
      }] },
    ] },
    ...Array.from({ length: 6 }, (_, i) => ({
      type: "outline" as const, id: id(), layout: { x: 54 + (i % 3) * 330, y: 520 + Math.floor(i / 3) * 420, width: 290 },
      children: [para(`Note ${i + 1}`, { bold: true }), ...Array.from({ length: 10 }, (_, j) => para(`Line ${j + 1} of a free-form outline placed at an absolute page position.`))],
    })),
  ],
};

function useContentExtent(dep: unknown): [React.RefObject<HTMLDivElement | null>, Rect] {
  const ref = useRef<HTMLDivElement>(null);
  const [extent, setExtent] = useState<Rect>({ x: 0, y: 0, width: 1000, height: 1400 });
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      // offset* ignores CSS transforms, so this is the zoom-1 layout size.
      let w = 0, h = 0;
      root.querySelectorAll<HTMLElement>(":scope > div > div").forEach((el) => {
        w = Math.max(w, el.offsetLeft + el.offsetWidth);
        h = Math.max(h, el.offsetTop + el.offsetHeight);
      });
      setExtent({ x: 0, y: 0, width: w + 72, height: h + 72 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    root.querySelectorAll<HTMLElement>(":scope > div > div").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [dep]);
  return [ref, extent];
}

function App() {
  const canvas = useRef<OneNoteCanvasHandle>(null);
  const [pages, setPages] = useState<Page[]>([SAMPLE]);
  const [pageIndex, setPageIndex] = useState(0);
  const [anchor, setAnchor] = useState<"viewportOrigin" | "pointer">("viewportOrigin");
  const [vp, setVp] = useState<ViewportState>({ zoom: 1, origin: { x: 0, y: 0 } });
  const page = pages[pageIndex] ?? SAMPLE;
  const [contentRef, extent] = useContentExtent(page);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") canvas.current?.zoomIn();
      else if (e.key === "-") canvas.current?.zoomOut();
      else if (e.key === "0") canvas.current?.setZoom(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadJson = async (file: File) => {
    const json = JSON.parse(await file.text()) as NotebookJson;
    if (json?.section?.pages?.length) {
      setPages(json.section.pages);
      setPageIndex(0);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100vh", font: "13px system-ui", color: "var(--fg)", background: "var(--bg)" }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "8px 16px", borderBottom: "1px solid var(--line)" }}>
        <strong style={{ marginRight: 8 }}>OneNote canvas</strong>
        <button onClick={() => canvas.current?.zoomOut()} aria-label="Zoom out">−</button>
        <output data-testid="zoom" style={{ minWidth: 48, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{Math.round(vp.zoom * 100)}%</output>
        <button onClick={() => canvas.current?.zoomIn()} aria-label="Zoom in">+</button>
        <button onClick={() => canvas.current?.setZoom(1)}>100%</button>
        <button onClick={() => canvas.current?.zoomToPageWidth()}>Page width</button>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={anchor === "pointer"} onChange={(e) => setAnchor(e.target.checked ? "pointer" : "viewportOrigin")} />
          Anchor zoom at pointer
        </label>
        <span data-testid="origin" style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
          origin {vp.origin.x.toFixed(0)}, {vp.origin.y.toFixed(0)}
        </span>
        <span style={{ flex: 1 }} />
        {pages.length > 1 && (
          <select value={pageIndex} onChange={(e) => setPageIndex(Number(e.target.value))} style={{ maxWidth: 240 }}>
            {pages.map((p, i) => (
              <option key={p.id} value={i}>{p.title || `Page ${i + 1}`}</option>
            ))}
          </select>
        )}
        <label style={{ cursor: "pointer", color: "var(--accent)" }}>
          Load parser JSON…
          <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && loadJson(e.target.files[0])} />
        </label>
      </header>
      <OneNoteCanvas
        ref={canvas}
        key={page.id}
        contentExtent={extent}
        zoomAnchor={anchor}
        onViewportChange={setVp}
        style={{ background: "var(--canvas)" }}
        aria-label={`Page: ${page.title}`}
      >
        <div ref={contentRef} style={{ position: "relative", color: "#1a202c" }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: extent.width, height: extent.height, background: "#fff", boxShadow: "0 0 0 1px rgba(0,0,0,.06)" }} />
          <PageRenderer page={page} />
        </div>
      </OneNoteCanvas>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
