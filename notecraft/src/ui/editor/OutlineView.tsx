// A free-form note container (OutlineNode). Positioned by OffsetFromParent*,
// width from LayoutMaxWidth; shrink-wraps until the user sets a width.
import { memo, useState, type FocusEvent, type PointerEvent } from "react";
import type { Outline } from "../../model/types.ts";
import * as ops from "../../model/ops.ts";
import { store } from "../../store/store.ts";
import { dragPointer } from "../canvasApi.ts";
import { Icon } from "../icons.tsx";
import { ElementList } from "./ElementList.tsx";
import { useReadOnly } from "./readOnly.ts";

export const OutlineView = memo(function OutlineView({ pageId, outline }: { pageId: string; outline: Outline }) {
  const readOnly = useReadOnly();
  const [live, setLive] = useState<{ dx: number; dy: number; w: number | null } | null>(null);
  const width = live?.w ?? outline.width;

  const startMove = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragPointer(
      e,
      (dx, dy) => setLive({ dx, dy, w: null }),
      (dx, dy, moved) => {
        setLive(null);
        if (moved) store.edit((d) => ops.moveOutline(d, pageId, outline.id, outline.x + dx, outline.y + dy));
      },
    );
  };

  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = (e.currentTarget as HTMLElement).parentElement!;
    const start = el.offsetWidth;
    dragPointer(
      e,
      (dx) => setLive({ dx: 0, dy: 0, w: Math.max(80, start + dx) }),
      (dx, _dy, moved) => {
        setLive(null);
        if (moved) store.edit((d) => ops.resizeOutline(d, pageId, outline.id, start + dx));
      },
    );
  };

  // OneNote discards a container you leave empty.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const node = e.currentTarget;
    if (node.contains(e.relatedTarget as Node | null)) return;
    setTimeout(() => {
      const fresh = ops.findOutline(store.getState().lib, pageId, outline.id);
      if (fresh && ops.outlineIsEmpty(fresh) && !node.contains(document.activeElement)) {
        store.edit((d) => ops.deleteOutline(d, pageId, outline.id));
      }
    }, 0);
  };

  return (
    <div
      className={`outline${live ? " is-live" : ""}`}
      style={{
        left: outline.x + (live?.dx ?? 0),
        top: outline.y + (live?.dy ?? 0),
        ...(outline.widthSetByUser || live?.w ? { width } : { maxWidth: width, minWidth: 120 }),
      }}
      onBlur={readOnly ? undefined : onBlur}
      data-outline={outline.id}
    >
      {!readOnly && (
        <div className="outline-grip" onPointerDown={startMove} title="Drag to move">
          <Icon.grip width={14} height={14} />
        </div>
      )}
      <ElementList elements={outline.elements} listRef={{ pageId, outlineId: outline.id }} placeholder="Type here…" />
      {!readOnly && <div className="outline-resize" onPointerDown={startResize} title="Drag to set width" />}
    </div>
  );
});
