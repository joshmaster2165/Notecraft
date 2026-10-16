// The two side panes, the notebook pane (sections) and the page list: each
// can be resized by dragging its edge or collapsed to a narrow rail. Kept
// per device in localStorage, like the zoom anchor.
import { useSyncExternalStore } from "react";

export type Pane = "nav" | "pages";
export interface PaneState {
  width: number;
  collapsed: boolean;
}
export type Layout = Record<Pane, PaneState>;

export const PANE_LIMITS: Record<Pane, { min: number; max: number; initial: number }> = {
  nav: { min: 180, max: 420, initial: 236 },
  pages: { min: 190, max: 480, initial: 268 },
};
/** Dragging a pane's edge narrower than this collapses it. */
export const COLLAPSE_BELOW = 130;

const KEY = "notecraft.layout";
const clamp = (pane: Pane, w: number) => Math.round(Math.min(PANE_LIMITS[pane].max, Math.max(PANE_LIMITS[pane].min, w)));
const initial = (pane: Pane): PaneState => ({ width: PANE_LIMITS[pane].initial, collapsed: false });

function read(): Layout {
  const out: Layout = { nav: initial("nav"), pages: initial("pages") };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Record<Pane, Partial<PaneState>>> | null;
    for (const pane of ["nav", "pages"] as const) {
      const s = saved?.[pane];
      if (typeof s?.width === "number" && Number.isFinite(s.width)) out[pane].width = clamp(pane, s.width);
      if (typeof s?.collapsed === "boolean") out[pane].collapsed = s.collapsed;
    }
  } catch {
    /* storage unavailable or damaged: start from the defaults */
  }
  return out;
}

let layout = read();
const listeners = new Set<() => void>();

export function getLayout(): Layout {
  return layout;
}

/** Change a pane. `save: false` while a drag is in progress; the drop saves. */
export function setPane(pane: Pane, patch: Partial<PaneState>, save = true): void {
  const next = { ...layout[pane], ...patch };
  if (patch.width !== undefined) next.width = clamp(pane, patch.width);
  layout = { ...layout, [pane]: next };
  listeners.forEach((l) => l());
  if (!save) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* storage unavailable: the layout just doesn't persist */
  }
}

export const togglePane = (pane: Pane) => setPane(pane, { collapsed: !layout[pane].collapsed });
export const resetPane = (pane: Pane) => setPane(pane, initial(pane));

export function useLayout(): Layout {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => layout,
  );
}
