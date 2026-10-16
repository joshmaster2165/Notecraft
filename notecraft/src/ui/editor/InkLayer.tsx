// Draw tab: pen, highlighter, shapes, stroke eraser and lasso select over the
// page. Strokes are stored in page points (zoom 1), so they stay aligned with
// text at any zoom.
import { memo, useEffect, useRef, useState, type PointerEvent } from "react";
import type { InkStroke, Page } from "../../model/types.ts";
import * as ops from "../../model/ops.ts";
import { newId } from "../../lib/id.ts";
import { store, useStore, type ShapeKind } from "../../store/store.ts";
import { currentZoom } from "../canvasApi.ts";
import { recognizeShape } from "../../engine.ts";

/** Smooth path through the points using midpoint quadratic curves. */
export function strokePath(p: number[]): string {
  if (p.length < 4) return p.length === 2 ? `M${p[0]} ${p[1]}l0.01 0` : "";
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i]! + p[i + 2]!) / 2;
    const my = (p[i + 1]! + p[i + 3]!) / 2;
    d += `Q${p[i]} ${p[i + 1]} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  return `${d}L${p[p.length - 2]} ${p[p.length - 1]}`;
}

/** Distance from a point to a stroke's polyline. */
export function distanceToStroke(x: number, y: number, p: number[]): number {
  if (p.length < 4) return p.length === 2 ? Math.hypot(x - p[0]!, y - p[1]!) : Infinity;
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i]!, ay = p[i + 1]!;
    const dx = p[i + 2]! - ax, dy = p[i + 3]! - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

export function inkBounds(ink: InkStroke[] | undefined): { right: number; bottom: number } {
  let right = 0, bottom = 0;
  for (const s of ink ?? []) {
    for (let i = 0; i < s.points.length; i += 2) {
      right = Math.max(right, s.points[i]! + s.width);
      bottom = Math.max(bottom, s.points[i + 1]! + s.width);
    }
  }
  return { right, bottom };
}

/** Straight segments for shapes. */
function polylinePath(p: number[]): string {
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i + 1 < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
  return d;
}

/** Draw › Shapes: the outline of a line, arrow, rectangle or ellipse dragged from (x0, y0) to (x1, y1). */
export function shapePoints(kind: ShapeKind, x0: number, y0: number, x1: number, y1: number, width: number): number[] {
  switch (kind) {
    case "line":
      return [x0, y0, x1, y1];
    case "rect":
      return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
    case "ellipse": {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
      const out: number[] = [];
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        out.push(round(cx + rx * Math.cos(a)), round(cy + ry * Math.sin(a)));
      }
      return out;
    }
    case "arrow": {
      const a = Math.atan2(y1 - y0, x1 - x0);
      const len = Math.min(18, Math.hypot(x1 - x0, y1 - y0) / 3) + width * 2;
      const head = (t: number) => [round(x1 - len * Math.cos(a + t)), round(y1 - len * Math.sin(a + t))];
      return [x0, y0, x1, y1, ...head(0.45), x1, y1, ...head(-0.45)];
    }
  }
}

function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i]!, yi = poly[i + 1]!, xj = poly[j]!, yj = poly[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Lasso Select picks strokes that are mostly inside the loop. */
function lassoPick(strokes: InkStroke[], poly: number[]): Set<string> {
  const out = new Set<string>();
  if (poly.length < 6) return out;
  for (const s of strokes) {
    let inside = 0;
    for (let i = 0; i < s.points.length; i += 2) if (pointInPolygon(s.points[i]!, s.points[i + 1]!, poly)) inside++;
    if (inside / (s.points.length / 2) >= 0.6) out.add(s.id);
  }
  return out;
}

function boundsOf(strokes: InkStroke[]): { x: number; y: number; w: number; h: number } | null {
  if (!strokes.length) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i < s.points.length; i += 2) {
      l = Math.min(l, s.points[i]! - s.width / 2);
      r = Math.max(r, s.points[i]! + s.width / 2);
      t = Math.min(t, s.points[i + 1]! - s.width / 2);
      b = Math.max(b, s.points[i + 1]! + s.width / 2);
    }
  }
  return { x: l - 4, y: t - 4, w: r - l + 8, h: b - t + 8 };
}

function Stroke({ s, hidden, offset }: { s: InkStroke; hidden?: boolean; offset?: { dx: number; dy: number } }) {
  return (
    <path
      d={s.shape ? polylinePath(s.points) : strokePath(s.points)}
      fill="none"
      stroke={s.color}
      strokeWidth={s.width}
      strokeLinecap={s.tool === "highlighter" ? "square" : "round"}
      strokeLinejoin="round"
      className={s.tool === "highlighter" ? "ink-highlighter" : undefined}
      opacity={hidden ? 0.15 : undefined}
      transform={offset ? `translate(${offset.dx} ${offset.dy})` : undefined}
    />
  );
}

/** The current lasso selection, read by Draw › Ink to Text. */
export const inkSelection: { pageId: string | null; ids: string[] } = { pageId: null, ids: [] };

export const InkLayer = memo(function InkLayer({ page, readOnly }: { page: Page; readOnly: boolean }) {
  const draw = useStore((s) => s.ui.draw);
  const active = !readOnly && draw.tool !== "type";
  const svg = useRef<SVGSVGElement>(null);
  // The gesture lives in refs (pointer events can outrun React renders);
  // state only mirrors it for drawing.
  const [live, setLive] = useState<InkStroke | null>(null);
  const [erasing, setErasing] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lasso, setLasso] = useState<number[] | null>(null);
  const [offset, setOffset] = useState<{ dx: number; dy: number } | null>(null);
  const liveRef = useRef<InkStroke | null>(null);
  const erasingRef = useRef<Set<string>>(new Set());
  const points = useRef<number[]>([]);
  const gesture = useRef<{ kind: "lasso" | "move" | "shape"; x: number; y: number; dx: number; dy: number } | null>(null);

  const ink = page.ink ?? [];
  const selection = ink.filter((s) => selected.has(s.id));
  const box = boundsOf(selection);

  // Leaving the lasso (or the page) drops the selection.
  useEffect(() => setSelected(new Set()), [draw.tool, page.id]);
  useEffect(() => {
    inkSelection.pageId = page.id;
    inkSelection.ids = [...selected];
  }, [selected, page.id]);
  useEffect(() => {
    if (!selected.size) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(new Set());
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        const ids = [...selected];
        setSelected(new Set());
        store.edit((d) => ops.removeInkStrokes(d, page.id, ids));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, page.id]);

  const toPage = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const z = currentZoom();
    return [(e.clientX - r.left) / z, (e.clientY - r.top) / z] as const;
  };

  const eraseAt = (x: number, y: number, acc: Set<string>) => {
    const radius = 8 / currentZoom();
    for (const s of ink) if (!acc.has(s.id) && distanceToStroke(x, y, s.points) <= radius + s.width / 2) acc.add(s.id);
    return acc;
  };

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!active || e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already released (or synthetic); the gesture still works without capture.
    }
    const [x, y] = toPage(e);
    if (draw.tool === "eraser") {
      erasingRef.current = eraseAt(x, y, new Set());
      setErasing(new Set(erasingRef.current));
      return;
    }
    if (draw.tool === "lasso") {
      if (box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
        gesture.current = { kind: "move", x, y, dx: 0, dy: 0 };
        setOffset({ dx: 0, dy: 0 });
      } else {
        gesture.current = { kind: "lasso", x, y, dx: 0, dy: 0 };
        points.current = [round(x), round(y)];
        setSelected(new Set());
        setLasso(points.current);
      }
      return;
    }
    if (draw.tool === "shape") {
      gesture.current = { kind: "shape", x: round(x), y: round(y), dx: 0, dy: 0 };
      liveRef.current = { id: newId("k"), tool: "pen", color: draw.penColor, width: draw.penWidth, points: [round(x), round(y)], shape: true };
      setLive(liveRef.current);
      return;
    }
    points.current = [round(x), round(y)];
    const hl = draw.tool === "highlighter";
    liveRef.current = { id: newId("k"), tool: hl ? "highlighter" : "pen", color: hl ? draw.highlighterColor : draw.penColor, width: hl ? draw.highlighterWidth : draw.penWidth, points: points.current };
    setLive(liveRef.current);
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!active || !(e.buttons & 1)) return;
    const [x, y] = toPage(e);
    if (draw.tool === "eraser") {
      const before = erasingRef.current.size;
      eraseAt(x, y, erasingRef.current);
      if (erasingRef.current.size !== before) setErasing(new Set(erasingRef.current));
      return;
    }
    const g = gesture.current;
    if (g?.kind === "move") {
      g.dx = round(x - g.x);
      g.dy = round(y - g.y);
      setOffset({ dx: g.dx, dy: g.dy });
      return;
    }
    if (g?.kind === "shape" && liveRef.current) {
      liveRef.current = { ...liveRef.current, points: shapePoints(draw.shape, g.x, g.y, round(x), round(y), draw.penWidth) };
      setLive(liveRef.current);
      return;
    }
    const p = points.current;
    const min = 0.8 / currentZoom();
    if (Math.hypot(x - p[p.length - 2]!, y - p[p.length - 1]!) < min) return;
    points.current = [...p, round(x), round(y)];
    if (g?.kind === "lasso") return setLasso(points.current);
    if (!liveRef.current) return;
    liveRef.current = { ...liveRef.current, points: points.current };
    setLive(liveRef.current);
  };

  const onUp = () => {
    if (draw.tool === "eraser") {
      const ids = [...erasingRef.current];
      erasingRef.current = new Set();
      setErasing(new Set());
      if (ids.length) store.edit((d) => ops.removeInkStrokes(d, page.id, ids));
      return;
    }
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind === "move") {
      setOffset(null);
      if (g.dx || g.dy) store.edit((d) => ops.moveInkStrokes(d, page.id, [...selected], g.dx, g.dy));
      return;
    }
    if (g?.kind === "lasso") {
      setLasso(null);
      setSelected(lassoPick(ink, points.current));
      return;
    }
    const stroke = liveRef.current;
    liveRef.current = null;
    setLive(null);
    if (!stroke) return;
    if (g?.kind === "shape") {
      if (stroke.points.length >= 4) store.edit((d) => ops.addInkStroke(d, page.id, stroke));
      return;
    }
    const done = { ...stroke, points: points.current };
    if (draw.inkToShape && done.tool === "pen" && done.points.length >= 6) {
      // Ink to Shape: keep showing the stroke until the engine answers.
      setLive(done);
      void recognizeShape(done.points)
        .catch(() => null)
        .then((shape) => {
          store.edit((d) => ops.addInkStroke(d, page.id, shape ? { ...done, points: shape.points, shape: true, shapeKind: shape.kind } : done));
          setLive((l) => (l === done ? null : l));
        });
      return;
    }
    store.edit((d) => ops.addInkStroke(d, page.id, done));
  };

  return (
    <svg
      ref={svg}
      className={`ink-layer${active ? " is-drawing" : ""} tool-${draw.tool}${box && offset ? " is-moving" : ""}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      aria-hidden={!ink.length}
    >
      {ink.map((s) => <Stroke key={s.id} s={s} hidden={erasing.has(s.id)} offset={offset && selected.has(s.id) ? offset : undefined} />)}
      {live && <Stroke s={live} />}
      {lasso && <path className="ink-lasso" d={polylinePath(lasso) + "Z"} />}
      {box && <rect className="ink-selection" x={box.x + (offset?.dx ?? 0)} y={box.y + (offset?.dy ?? 0)} width={box.w} height={box.h} rx={3} />}
    </svg>
  );
});

const round = (v: number) => Math.round(v * 10) / 10;
