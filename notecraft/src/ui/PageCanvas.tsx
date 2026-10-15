// The page surface: OneNote's reconstructed pan/zoom canvas hosting the title,
// free-form outlines and floating images.
import { inkFor } from "../lib/color.ts";
import { memo, useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { OneNoteCanvas } from "@re/canvas/OneNoteCanvas.tsx";
import type { Rect } from "@re/canvas/viewport.ts";
import type { Page } from "../model/types.ts";
import { LAYOUT } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { store, useStore } from "../store/store.ts";
import { createOutlineAt, focusBody, importFiles, insertImageFiles } from "../store/actions.ts";
import { cacheView, cachedView } from "../store/persist.ts";
import { canvasApi, currentZoom, publishView } from "./canvasApi.ts";
import { OutlineView } from "./editor/OutlineView.tsx";
import { FloatingImageView } from "./editor/media.tsx";
import { ReadOnlyContext } from "./editor/readOnly.ts";
import { InkLayer, inkBounds } from "./editor/InkLayer.tsx";
import type { PaperStyle } from "../model/types.ts";

const MIN_EXTENT = { width: 1000, height: 1300 };
const MARGIN = { right: 480, bottom: 640 };

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function PageTitle({ page, readOnly }: { page: Page; readOnly: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current && ref.current.textContent !== page.title) ref.current.textContent = page.title;
  }, [page.title]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      focusBody(page.id);
    }
  };
  const created = new Date(page.createdAt);
  return (
    <div className="page-title" style={{ left: LAYOUT.titleX, top: LAYOUT.titleY }}>
      <div
        ref={ref}
        className="page-title-text"
        contentEditable={readOnly ? false : "plaintext-only"}
        suppressContentEditableWarning
        role="textbox"
        aria-label="Page title"
        data-title-for={page.id}
        data-placeholder="Untitled page"
        onKeyDown={onKeyDown}
        onInput={(e) => {
          const title = (e.currentTarget.textContent ?? "").replace(/\n/g, " ");
          store.edit((d) => ops.setPageTitle(d, page.id, title), { coalesce: `title:${page.id}` });
        }}
      />
      <div className="page-date">
        <span>{dateFmt.format(created)}</span>
        <span>{timeFmt.format(created)}</span>
      </div>
    </div>
  );
}

/** Measure laid-out content (zoom-independent offset sizes) to size the scrollable page. */
function useContentExtent(layer: RefObject<HTMLDivElement | null>, pageId: string, extra: { right: number; bottom: number }): Rect {
  const [extent, setExtent] = useState<Rect>({ x: 0, y: 0, ...MIN_EXTENT });
  const measure = useCallback(() => {
    const root = layer.current;
    if (!root) return;
    let right = 0;
    let bottom = 0;
    for (const child of Array.from(root.children) as HTMLElement[]) {
      if (child.classList.contains("paper-bg") || child.classList.contains("ink-layer")) continue;
      right = Math.max(right, child.offsetLeft + child.offsetWidth);
      bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
    }
    right = Math.max(right, extra.right);
    bottom = Math.max(bottom, extra.bottom);
    const width = Math.max(MIN_EXTENT.width, Math.ceil(right + MARGIN.right));
    const height = Math.max(MIN_EXTENT.height, Math.ceil(bottom + MARGIN.bottom));
    setExtent((e) => (e.width === width && e.height === height ? e : { x: 0, y: 0, width, height }));
  }, [layer, extra.right, extra.bottom]);

  useLayoutEffect(() => {
    const root = layer.current;
    if (!root) return;
    measure();
    const ro = new ResizeObserver(measure);
    const observeAll = () => Array.from(root.children).forEach((c) => ro.observe(c));
    observeAll();
    const mo = new MutationObserver(() => {
      observeAll();
      measure();
    });
    mo.observe(root, { childList: true, attributes: true, attributeFilter: ["style"], subtree: false });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure, pageId]);
  return extent;
}

/** `version` previews a saved state of the page read-only (version history). */
export const PageCanvas = memo(function PageCanvas({ page, version }: { page: Page; version?: string }) {
  const readOnly = !!version;
  const layer = useRef<HTMLDivElement>(null);
  const ink = useMemo(() => inkBounds(page.ink), [page.ink]);
  const extent = useContentExtent(layer, page.id, ink);
  const anchor = useStore((s) => s.ui.zoomAnchor);
  const initial = cachedView(page.id);
  const [dropping, setDropping] = useState(false);

  // The canvas region must never scroll natively (focus/caret scrolling would
  // fight the transform), so pin it and let revealRect move the origin instead.
  useEffect(() => {
    const region = layer.current?.closest<HTMLElement>("[role=region]") ?? null;
    canvasApi.region = region;
    if (!region) return;
    const pin = () => {
      if (region.scrollTop || region.scrollLeft) region.scrollTo(0, 0);
    };
    region.addEventListener("scroll", pin);
    return () => region.removeEventListener("scroll", pin);
  }, [page.id]);

  const toPagePoint = (clientX: number, clientY: number) => {
    const rect = layer.current!.getBoundingClientRect();
    const zoom = currentZoom();
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  };

  // Clicking empty paper starts a new outline at that spot.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || readOnly) return;
    const target = e.target as HTMLElement;
    if (target !== layer.current && !target.classList.contains("paper-bg")) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const p = toPagePoint(e.clientX, e.clientY);
    if (p.y < LAYOUT.titleY + 64 && p.x < LAYOUT.titleX + 420) {
      document.querySelector<HTMLElement>(`[data-title-for="${page.id}"]`)?.focus();
      return;
    }
    createOutlineAt(page.id, p.x - 6, p.y - 11);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropping(false);
    if (readOnly) return;
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length) {
      const p = toPagePoint(e.clientX, e.clientY);
      insertImageFiles(images, { pageId: page.id, x: p.x, y: p.y });
    }
    const docs = files.filter((f) => /\.(one|json)$/i.test(f.name));
    if (docs.length) void importFiles(docs);
  };

  const empty = page.outlines.length === 0 && page.images.length === 0;

  return (
    <OneNoteCanvas
      key={version ? `${page.id}:${version}` : page.id}
      ref={(h) => {
        canvasApi.current = h;
      }}
      className={`canvas${dropping ? " is-dropping" : ""}${readOnly ? " is-preview" : ""}`}
      contentExtent={extent}
      initialZoom={initial?.zoom ?? 1}
      initialOrigin={initial?.origin ?? { x: 0, y: 0 }}
      zoomAnchor={anchor}
      onViewportChange={(v) => {
        publishView(v);
        if (!readOnly) cacheView(page.id, v);
      }}
      aria-label={`Page: ${page.title || "Untitled page"}`}
    >
      <div
        ref={layer}
        className="paper"
        style={{ width: extent.width, height: extent.height }}
        onPointerDown={onPointerDown}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDropping(true);
          }
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        <ReadOnlyContext.Provider value={readOnly}>
        <div className="paper-bg" style={paperBackground(page.paper)} />
        {!page.hideTitle && <PageTitle page={page} readOnly={readOnly} />}
        {empty && !readOnly && (
          <div className="paper-hint" style={{ left: LAYOUT.bodyX, top: LAYOUT.bodyY }}>
            Click anywhere to start writing
          </div>
        )}
        {page.outlines.map((o) => (
          <OutlineView key={o.id} pageId={page.id} outline={o} />
        ))}
        {page.images.map((img) => (
          <FloatingImageView key={img.id} pageId={page.id} img={img} />
        ))}
        <InkLayer page={page} readOnly={readOnly} />
        </ReadOnlyContext.Provider>
      </div>
    </OneNoteCanvas>
  );
});

/** View > Paper Style: page color plus ruled or grid lines (spacing in points, as OneNote draws them). */
const RULE_SPACING: Record<string, number> = { narrow: 18, standard: 22, college: 26, "grid-small": 12, "grid-medium": 18, "grid-large": 27 };

function paperBackground(paper: PaperStyle | undefined) {
  const style: Record<string, string> = {};
  if (paper?.color) {
    style.backgroundColor = paper.color;
    const ink = inkFor(paper.color);
    if (ink) (style["--ink"] = ink), (style.color = ink);
  }
  const rule = paper?.rule;
  if (rule && rule !== "none") {
    const gap = RULE_SPACING[rule]!;
    const c = paper.ruleColor ?? "#9ec1e6";
    const lines = `repeating-linear-gradient(to bottom, transparent 0 ${gap - 1}px, ${c} ${gap - 1}px ${gap}px)`;
    style.backgroundImage = rule.startsWith("grid") ? `${lines}, repeating-linear-gradient(to right, transparent 0 ${gap - 1}px, ${c} ${gap - 1}px ${gap}px)` : lines;
    // Ruled paper starts below the title area, like OneNote's.
    style.backgroundPosition = rule.startsWith("grid") ? "0 0" : "0 96px";
  }
  return style;
}

export function useActivePage(): Page | undefined {
  return useStore((s) => (s.ui.pageId ? ops.findPage(s.lib, s.ui.pageId)?.page : undefined));
}
