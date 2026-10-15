// Isolated React pan/zoom surface that reproduces OneNote for Mac's canvas
// mechanics with a single CSS transform. See viewport.ts for the recovered
// algorithm and docs/canvas.md for the binary evidence.
//
//   <OneNoteCanvas contentExtent={{ x: 0, y: 0, width: 816, height: 1056 }}>
//     <Page />                       // laid out at zoom 1, top-left at (0, 0)
//   </OneNoteCanvas>

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DEFAULT_LIMITS,
  ZOOM_STEP,
  cssTransform,
  documentRect,
  clampOrigin,
  fitWidthZoom,
  interpretWheel,
  pan,
  pinchIncrementFromScale,
  zoomBy,
  zoomTo,
  type Point,
  type Rect,
  type Size,
  type ViewportState,
  type ZoomAnchor,
  type ZoomLimits,
} from "./viewport.ts";

export interface OneNoteCanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  /** Fit the page content width to the viewport (OneNote "Zoom to Page Width"). */
  zoomToPageWidth(): void;
  setZoom(zoom: number): void;
  scrollTo(origin: Point): void;
  getState(): ViewportState;
}

export interface OneNoteCanvasProps {
  children?: ReactNode;
  /** Page render extent at zoom 1, in CSS px (OneNote points). */
  contentExtent: Rect;
  initialZoom?: number;
  initialOrigin?: Point;
  limits?: ZoomLimits;
  /** "viewportOrigin" matches OneNote; "pointer" keeps the point under the cursor fixed. */
  zoomAnchor?: ZoomAnchor;
  showScrollIndicators?: boolean;
  onViewportChange?: (state: ViewportState) => void;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

// Safari's non-standard GestureEvent.
interface GestureLikeEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

const INDICATOR_HIDE_MS = 900;

export const OneNoteCanvas = forwardRef<OneNoteCanvasHandle, OneNoteCanvasProps>(function OneNoteCanvas(
  {
    children,
    contentExtent,
    initialZoom = 1,
    initialOrigin = { x: 0, y: 0 },
    limits = DEFAULT_LIMITS,
    zoomAnchor = "viewportOrigin",
    showScrollIndicators = true,
    onViewportChange,
    className,
    style,
    "aria-label": ariaLabel = "Page canvas",
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hThumbRef = useRef<HTMLDivElement>(null);
  const vThumbRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef<ViewportState>({ zoom: initialZoom, origin: initialOrigin });
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const extentRef = useRef(contentExtent);
  const optsRef = useRef({ limits, zoomAnchor, onViewportChange });
  optsRef.current = { limits, zoomAnchor, onViewportChange };
  extentRef.current = contentExtent;

  const frameRef = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [zoomPercent, setZoomPercent] = useState(Math.round(initialZoom * 100));
  const [indicatorsVisible, setIndicatorsVisible] = useState(false);

  // Write the transform and scroll indicators outside React's render cycle;
  // gesture streams arrive at display rate and should not re-render children.
  const paint = useCallback(() => {
    frameRef.current = 0;
    const s = stateRef.current;
    if (contentRef.current) contentRef.current.style.transform = cssTransform(s);
    const vis = sizeRef.current;
    const doc = documentRect(extentRef.current, s.zoom, vis);
    const place = (el: HTMLDivElement | null, along: "x" | "y") => {
      if (!el) return;
      const track = along === "x" ? vis.width : vis.height;
      const span = along === "x" ? doc.width : doc.height;
      const start = along === "x" ? doc.x : doc.y;
      const pos = along === "x" ? s.origin.x : s.origin.y;
      const thumb = Math.max(24, (track / span) * track);
      const travel = span - track;
      const offset = travel > 0 ? ((pos - start) / travel) * (track - thumb) : 0;
      el.style.display = travel > 0.5 ? "block" : "none";
      el.style[along === "x" ? "width" : "height"] = `${thumb}px`;
      el.style.transform = along === "x" ? `translateX(${offset}px)` : `translateY(${offset}px)`;
    };
    place(hThumbRef.current, "x");
    place(vThumbRef.current, "y");
  }, []);

  const commit = useCallback(
    (next: ViewportState, reason: "pan" | "zoom" | "layout") => {
      const prev = stateRef.current;
      stateRef.current = next;
      if (!frameRef.current) frameRef.current = requestAnimationFrame(paint);
      if (next.zoom !== prev.zoom) setZoomPercent(Math.round(next.zoom * 100));
      if (reason !== "layout" && (next.origin.x !== prev.origin.x || next.origin.y !== prev.origin.y || next.zoom !== prev.zoom)) {
        setIndicatorsVisible(true);
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => setIndicatorsVisible(false), INDICATOR_HIDE_MS);
      }
      optsRef.current.onViewportChange?.(next);
    },
    [paint],
  );

  const pointerIn = (clientX: number, clientY: number): Point => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const applyZoom = useCallback(
    (increment: number, pointer?: Point) => {
      const { limits: lim, zoomAnchor: anchor } = optsRef.current;
      commit(zoomBy(stateRef.current, increment, extentRef.current, sizeRef.current, { limits: lim, anchor, pointer }), "zoom");
    },
    [commit],
  );

  // Gesture input. React's onWheel is passive, so listeners are attached manually.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let gestureScale: number | null = null;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (gestureScale !== null && e.ctrlKey) return; // Safari already reports the pinch as a gesture
      const intent = interpretWheel(e, sizeRef.current);
      if (intent.kind === "pan") {
        commit(pan(stateRef.current, intent.dx, intent.dy, extentRef.current, sizeRef.current), "pan");
      } else {
        applyZoom(intent.increment, pointerIn(e.clientX, e.clientY));
      }
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = (e as GestureLikeEvent).scale ?? 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureLikeEvent;
      const prev = gestureScale ?? 1;
      gestureScale = g.scale;
      applyZoom(pinchIncrementFromScale(g.scale, prev), pointerIn(g.clientX, g.clientY));
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gestureScale = null;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [applyZoom, commit]);

  // Viewport resizes and extent changes re-run the setCanvasExtent: constraint.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const relayout = () => {
      sizeRef.current = { width: el.clientWidth, height: el.clientHeight };
      const s = stateRef.current;
      const doc = documentRect(extentRef.current, s.zoom, sizeRef.current);
      commit({ zoom: s.zoom, origin: clampOrigin(s.origin, doc, sizeRef.current) }, "layout");
    };
    relayout();
    const ro = new ResizeObserver(relayout);
    ro.observe(el);
    return () => ro.disconnect();
  }, [commit, contentExtent.x, contentExtent.y, contentExtent.width, contentExtent.height]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frameRef.current);
      clearTimeout(hideTimerRef.current);
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => applyZoom(ZOOM_STEP),
      zoomOut: () => applyZoom(-ZOOM_STEP),
      zoomToPageWidth: () =>
        commit(zoomTo(stateRef.current, fitWidthZoom(extentRef.current, sizeRef.current), extentRef.current, sizeRef.current), "zoom"),
      setZoom: (z: number) => {
        const { min, max } = optsRef.current.limits;
        commit(zoomTo(stateRef.current, Math.min(max, Math.max(min, z)), extentRef.current, sizeRef.current), "zoom");
      },
      scrollTo: (origin: Point) => {
        const s = stateRef.current;
        const doc = documentRect(extentRef.current, s.zoom, sizeRef.current);
        commit({ zoom: s.zoom, origin: clampOrigin(origin, doc, sizeRef.current) }, "pan");
      },
      getState: () => stateRef.current,
    }),
    [applyZoom, commit],
  );

  const thumbBase: CSSProperties = {
    position: "absolute",
    borderRadius: 4,
    background: "rgba(0, 0, 0, 0.35)",
    opacity: indicatorsVisible ? 1 : 0,
    transition: indicatorsVisible ? "opacity 80ms" : "opacity 400ms",
    pointerEvents: "none",
  };

  return (
    <div
      ref={containerRef}
      className={className}
      role="region"
      aria-label={ariaLabel}
      style={{
        position: "relative",
        overflow: "hidden",
        touchAction: "none",
        overscrollBehavior: "none",
        ...style,
      }}
    >
      {/* Children are laid out in model coordinates (zoom 1): view = model * zoom - origin. */}
      <div
        ref={contentRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: contentExtent.x + contentExtent.width,
          height: contentExtent.y + contentExtent.height,
          transformOrigin: "0 0",
          transform: cssTransform(stateRef.current),
          willChange: "transform",
        }}
      >
        {children}
      </div>
      {showScrollIndicators && (
        <>
          <div ref={hThumbRef} style={{ ...thumbBase, left: 0, bottom: 2, height: 7 }} />
          <div ref={vThumbRef} style={{ ...thumbBase, top: 0, right: 2, width: 7 }} />
        </>
      )}
      <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>
        {`${zoomPercent}%`}
      </div>
    </div>
  );
});
