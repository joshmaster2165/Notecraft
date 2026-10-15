// Draw tab: pen, highlighter and stroke eraser over the page. Strokes are
// stored in page points (zoom 1), so they stay aligned with text at any zoom.
import { memo, useRef, useState, type PointerEvent } from "react";
import type { InkStroke, Page } from "../../model/types.ts";
import * as ops from "../../model/ops.ts";
import { newId } from "../../lib/id.ts";
import { store, useStore } from "../../store/store.ts";
import { currentZoom } from "../canvasApi.ts";

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

function Stroke({ s, hidden }: { s: InkStroke; hidden?: boolean }) {
  return (
    <path
      d={strokePath(s.points)}
      fill="none"
      stroke={s.color}
      strokeWidth={s.width}
      strokeLinecap={s.tool === "highlighter" ? "square" : "round"}
      strokeLinejoin="round"
      className={s.tool === "highlighter" ? "ink-highlighter" : undefined}
      opacity={hidden ? 0.15 : undefined}
    />
  );
}

export const InkLayer = memo(function InkLayer({ page, readOnly }: { page: Page; readOnly: boolean }) {
  const draw = useStore((s) => s.ui.draw);
  const active = !readOnly && draw.tool !== "type";
  const svg = useRef<SVGSVGElement>(null);
  // The gesture lives in refs (pointer events can outrun React renders);
  // state only mirrors it for drawing.
  const [live, setLive] = useState<InkStroke | null>(null);
  const [erasing, setErasing] = useState<Set<string>>(new Set());
  const liveRef = useRef<InkStroke | null>(null);
  const erasingRef = useRef<Set<string>>(new Set());
  const points = useRef<number[]>([]);

  const toPage = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const z = currentZoom();
    return [(e.clientX - r.left) / z, (e.clientY - r.top) / z] as const;
  };

  const eraseAt = (x: number, y: number, acc: Set<string>) => {
    const radius = 8 / currentZoom();
    for (const s of page.ink ?? []) if (!acc.has(s.id) && distanceToStroke(x, y, s.points) <= radius + s.width / 2) acc.add(s.id);
    return acc;
  };

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!active || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = toPage(e);
    if (draw.tool === "eraser") {
      erasingRef.current = eraseAt(x, y, new Set());
      setErasing(new Set(erasingRef.current));
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
    if (!liveRef.current) return;
    const p = points.current;
    const min = 0.8 / currentZoom();
    if (Math.hypot(x - p[p.length - 2]!, y - p[p.length - 1]!) < min) return;
    points.current = [...p, round(x), round(y)];
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
    const stroke = liveRef.current;
    liveRef.current = null;
    setLive(null);
    if (stroke) store.edit((d) => ops.addInkStroke(d, page.id, { ...stroke, points: points.current }));
  };

  return (
    <svg
      ref={svg}
      className={`ink-layer${active ? " is-drawing" : ""} tool-${draw.tool}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      aria-hidden={!page.ink?.length}
    >
      {page.ink?.map((s) => <Stroke key={s.id} s={s} hidden={erasing.has(s.id)} />)}
      {live && <Stroke s={live} />}
    </svg>
  );
});

const round = (v: number) => Math.round(v * 10) / 10;
