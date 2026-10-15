// Shared handle to the page canvas plus a tiny store for the live zoom value,
// so the toolbar can show zoom without re-rendering the page on every frame.
import { useSyncExternalStore } from "react";
import type { OneNoteCanvasHandle } from "@re/canvas/OneNoteCanvas.tsx";
import type { ViewportState } from "@re/canvas/viewport.ts";

export const canvasApi: { current: OneNoteCanvasHandle | null; region: HTMLElement | null } = { current: null, region: null };

let view: ViewportState = { zoom: 1, origin: { x: 0, y: 0 } };
const listeners = new Set<() => void>();

export function publishView(v: ViewportState) {
  if (v.zoom === view.zoom && v.origin.x === view.origin.x && v.origin.y === view.origin.y) return;
  view = v;
  listeners.forEach((l) => l());
}

export function useZoom(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => view.zoom,
  );
}

export function currentZoom(): number {
  return canvasApi.current?.getState().zoom ?? 1;
}

/**
 * Keep an element visible by moving the canvas origin (the region itself never
 * scrolls natively; the transform does all the scrolling).
 */
export function revealRect(rect: DOMRect, margin = 48) {
  const region = canvasApi.region;
  const api = canvasApi.current;
  if (!region || !api) return;
  const box = region.getBoundingClientRect();
  const { origin } = api.getState();
  let dx = 0;
  let dy = 0;
  if (rect.bottom > box.bottom - margin) dy = rect.bottom - (box.bottom - margin);
  else if (rect.top < box.top + margin) dy = rect.top - (box.top + margin);
  if (rect.right > box.right - margin) dx = Math.min(rect.right - (box.right - margin), rect.left - box.left - margin);
  else if (rect.left < box.left + margin) dx = rect.left - (box.left + margin);
  if (dx || dy) api.scrollTo({ x: origin.x + dx, y: origin.y + dy });
}

/** Track a pointer drag in screen pixels, converted to page points at the current zoom. */
export function dragPointer(
  e: { clientX: number; clientY: number; pointerId: number; currentTarget: EventTarget },
  onMove: (dx: number, dy: number) => void,
  onEnd: (dx: number, dy: number, moved: boolean) => void,
) {
  const zoom = currentZoom();
  const x0 = e.clientX;
  const y0 = e.clientY;
  let last = { dx: 0, dy: 0 };
  let moved = false;
  const move = (ev: PointerEvent) => {
    last = { dx: (ev.clientX - x0) / zoom, dy: (ev.clientY - y0) / zoom };
    if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 2) moved = true;
    onMove(last.dx, last.dy);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    document.body.classList.remove("is-dragging");
    onEnd(last.dx, last.dy, moved);
  };
  document.body.classList.add("is-dragging");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
