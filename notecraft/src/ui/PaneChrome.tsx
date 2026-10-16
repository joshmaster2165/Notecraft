// Side pane controls: the drag handle on a pane's edge, the collapse button,
// and the rail a collapsed pane leaves behind.
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { COLLAPSE_BELOW, PANE_LIMITS, getLayout, resetPane, setPane, togglePane, useLayout, type Pane } from "./layout.ts";
import { Icon } from "./icons.tsx";
import { desktop } from "../desktop.ts";

const NAMES: Record<Pane, string> = { nav: "notebooks", pages: "pages" };

/** Drag to resize, double-click to reset; dragging very narrow collapses the pane. Arrow keys resize too. */
export function PaneResizer({ pane }: { pane: Pane }) {
  const { width } = useLayout()[pane];
  const drag = useRef<{ x: number; from: number; raw: number } | null>(null);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Start from the width on screen: narrow windows cap the pane below its saved width.
    const shown = Math.round(e.currentTarget.parentElement?.getBoundingClientRect().width ?? getLayout()[pane].width);
    drag.current = { x: e.clientX, from: shown, raw: shown };
    document.body.classList.add("is-resizing-pane");
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.raw = d.from + e.clientX - d.x;
    setPane(pane, { width: d.raw }, false);
  };
  const onUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove("is-resizing-pane");
    // Dropped very narrow: collapse, keeping the width it had for when it opens again.
    if (d.raw < COLLAPSE_BELOW) setPane(pane, { collapsed: true, width: d.from });
    else setPane(pane, {});
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") (e.preventDefault(), setPane(pane, { width: width - step }));
    else if (e.key === "ArrowRight") (e.preventDefault(), setPane(pane, { width: width + step }));
    else if (e.key === "Enter") (e.preventDefault(), togglePane(pane));
  };

  return (
    <div
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${NAMES[pane]}`}
      aria-valuemin={PANE_LIMITS[pane].min}
      aria-valuemax={PANE_LIMITS[pane].max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => resetPane(pane)}
      onKeyDown={onKey}
    />
  );
}

export function CollapseButton({ pane }: { pane: Pane }) {
  return (
    <button className="icon-btn pane-collapse" title={`Hide ${NAMES[pane]}`} aria-label={`Hide ${NAMES[pane]}`} onClick={() => togglePane(pane)}>
      <Icon.collapse />
    </button>
  );
}

/** What a collapsed pane shows: a button to bring it back, and its name running down the rail. */
export function PaneRail({ pane, label, color }: { pane: Pane; label: string; color?: string }) {
  return (
    <div className="pane-rail">
      {desktop && <div className="drag-strip" data-tauri-drag-region />}
      <button className="icon-btn pane-expand" title={`Show ${NAMES[pane]}`} aria-label={`Show ${NAMES[pane]}`} onClick={() => togglePane(pane)}>
        <Icon.expand />
      </button>
      <button className="pane-rail-label" onClick={() => togglePane(pane)} tabIndex={-1} aria-hidden>
        {color && <span className="section-tab" style={{ background: color }} />}
        <span>{label}</span>
      </button>
    </div>
  );
}
