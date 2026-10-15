// Viewport math for a OneNote-style canvas, reconstructed from OneNote for Mac
// 16.114 (arm64). Addresses refer to that build; see docs/canvas.md.
//
// Model: the canvas is a virtual surface. A scroll "origin" (the clip view's
// bounds origin, in zoomed pixels) and a zoom scale fully describe the view;
// content is drawn through  translate(-origin) scale(zoom)  with a top-left
// transform origin (ONPageView::updateAffineTransform, 0x10026dd58).

/** ONPageViewController zoom limits: FUN_1003c497c -> 0.25f, FUN_1003c4974 -> 5.0f. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
/** pinchZoom: divides NSEvent.magnification by 1.5 (0x1003f1740). */
export const PINCH_DIVISOR = 1.5;
/** mouseWheelZoom: divides NSEvent.deltaY by 15 (0x1003f1724). */
export const WHEEL_ZOOM_DIVISOR = 15;
/** zoomIn / zoomOut pass +-0.1f as the increment (0x1003f148c / 0x1003f150c). */
export const ZOOM_STEP = 0.1;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ViewportState {
  zoom: number;
  /** Clip-view bounds origin in zoomed pixels (what NSScrollView scrolls). */
  origin: Point;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

export const DEFAULT_LIMITS: ZoomLimits = { min: MIN_ZOOM, max: MAX_ZOOM };

/**
 * Scrollable document rect at a zoom (ONPageViewController::setCanvasExtent:,
 * 0x100273bc8): the page render extent scaled by zoom, grown to at least the
 * visible size, minus a stray 1px overflow so scrollbars don't flicker.
 */
export function documentRect(extent: Rect, zoom: number, visible: Size): Rect {
  const scaled = { x: extent.x * zoom, y: extent.y * zoom, width: extent.width * zoom, height: extent.height * zoom };
  let width = Math.max(scaled.width, visible.width);
  let height = Math.max(scaled.height, visible.height);
  if (width - visible.width === 1) width -= 1;
  else if (height - visible.height === 1) height -= 1;
  return { x: scaled.x, y: scaled.y, width, height };
}

/** NSClipView-style constraint: keep the visible rect inside the document rect. */
export function clampOrigin(origin: Point, doc: Rect, visible: Size): Point {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: clamp(origin.x, doc.x, doc.x + doc.width - visible.width),
    y: clamp(origin.y, doc.y, doc.y + doc.height - visible.height),
  };
}

/** Two-finger scroll without Control: NSScrollView pans the clip origin. */
export function pan(state: ViewportState, dx: number, dy: number, extent: Rect, visible: Size): ViewportState {
  const doc = documentRect(extent, state.zoom, visible);
  return { zoom: state.zoom, origin: clampOrigin({ x: state.origin.x + dx, y: state.origin.y + dy }, doc, visible) };
}

export type ZoomAnchor = "viewportOrigin" | "pointer";

/**
 * Additive zoom step, as in the main-thread block FUN_1003f12d4:
 *   z' = clamp(z + increment, min, max)
 *   origin' = origin * z'/z            (anchored at the viewport's top-left)
 * "pointer" is an opt-in alternative that keeps the point under the cursor fixed;
 * OneNote itself always uses the viewport origin.
 */
export function zoomBy(
  state: ViewportState,
  increment: number,
  extent: Rect,
  visible: Size,
  opts: { limits?: ZoomLimits; anchor?: ZoomAnchor; pointer?: Point } = {},
): ViewportState {
  const { min, max } = opts.limits ?? DEFAULT_LIMITS;
  let z = state.zoom + increment;
  z = z > min ? z : min;
  z = z < max ? z : max;
  return zoomTo(state, z, extent, visible, opts);
}

/** Set an absolute zoom (updateZoomScaleToAbsoluteSynchronously: computes target - current). */
export function zoomTo(
  state: ViewportState,
  zoom: number,
  extent: Rect,
  visible: Size,
  opts: { anchor?: ZoomAnchor; pointer?: Point } = {},
): ViewportState {
  if (zoom === state.zoom || !(zoom > 0)) return state;
  const ratio = zoom / state.zoom;
  const p = opts.anchor === "pointer" && opts.pointer ? opts.pointer : { x: 0, y: 0 };
  const origin = { x: (state.origin.x + p.x) * ratio - p.x, y: (state.origin.y + p.y) * ratio - p.y };
  const doc = documentRect(extent, zoom, visible);
  return { zoom, origin: clampOrigin(origin, doc, visible) };
}

/** zoomToPageWidth (usePageWidth = YES): z = visible width / page content width. Not clamped, as in OneNote. */
export function fitWidthZoom(contentExtent: Rect, visible: Size): number {
  return contentExtent.width > 0 ? visible.width / contentExtent.width : 1;
}

/** CSS transform equivalent of ONPageView::updateAffineTransform (points == CSS px). */
export function cssTransform(state: ViewportState): string {
  return `translate3d(${-state.origin.x}px, ${-state.origin.y}px, 0) scale(${state.zoom})`;
}

/** Map a viewport-relative point to content (zoom = 1) coordinates. */
export function viewportToContent(state: ViewportState, p: Point): Point {
  return { x: (p.x + state.origin.x) / state.zoom, y: (p.y + state.origin.y) / state.zoom };
}

// --- browser input normalisation ---------------------------------------------------

export type GestureIntent =
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "zoom"; increment: number; source: "pinch" | "wheel" };

const LINE_PX = 16;

/**
 * Translate a DOM WheelEvent into OneNote's two paths (ONPageView::scrollWheel:,
 * 0x10032c9e8): without Control it is a pan; with Control it is a zoom.
 *
 * Browsers deliver a trackpad pinch as a ctrlKey wheel whose deltaY is roughly
 * -100 x NSEvent.magnification, so it is routed to pinchZoom (m / 1.5). A real
 * Control+mouse-wheel notch arrives as a large integral delta (or line mode) and
 * is routed to mouseWheelZoom (deltaY / 15, with one notch ~ one NSEvent line).
 */
export function interpretWheel(
  e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey">,
  visible: Size,
): GestureIntent {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? visible.height : 1;
  if (!e.ctrlKey) return { kind: "pan", dx: e.deltaX * unit, dy: e.deltaY * unit };

  const notch = e.deltaMode === 1 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
  if (notch) {
    // NSEvent.deltaY is positive for wheel-up; DOM deltaY is positive for wheel-down.
    const lines = e.deltaMode === 1 ? -e.deltaY : -e.deltaY / 100;
    return { kind: "zoom", increment: lines / WHEEL_ZOOM_DIVISOR, source: "wheel" };
  }
  const magnification = -e.deltaY / 100;
  return { kind: "zoom", increment: magnification / PINCH_DIVISOR, source: "pinch" };
}

/** Safari GestureEvent: scale is cumulative, NSEvent.magnification is the per-event delta. */
export function pinchIncrementFromScale(scale: number, previousScale: number): number {
  return (scale - previousScale) / PINCH_DIVISOR;
}
