import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  cssTransform,
  documentRect,
  fitWidthZoom,
  interpretWheel,
  pan,
  pinchIncrementFromScale,
  viewportToContent,
  zoomBy,
  type ViewportState,
} from "./viewport.ts";

const extent = { x: 0, y: 0, width: 800, height: 2000 };
const visible = { width: 600, height: 400 };
const at = (zoom: number, x = 0, y = 0): ViewportState => ({ zoom, origin: { x, y } });
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("zoom steps are additive and clamped to [0.25, 5]", () => {
  close(zoomBy(at(1), ZOOM_STEP, extent, visible).zoom, 1.1);
  close(zoomBy(at(1), -ZOOM_STEP, extent, visible).zoom, 0.9);
  assert.equal(zoomBy(at(4.95), 1, extent, visible).zoom, MAX_ZOOM);
  assert.equal(zoomBy(at(0.3), -1, extent, visible).zoom, MIN_ZOOM);
});

test("zoom anchors at the viewport's top-left: origin scales by z'/z", () => {
  const s = zoomBy(at(1, 100, 300), 1, extent, visible); // 1 -> 2
  assert.deepEqual(s.origin, { x: 200, y: 600 });
  // The content point under the top-left corner is unchanged.
  assert.deepEqual(viewportToContent(at(1, 100, 300), { x: 0, y: 0 }), viewportToContent(s, { x: 0, y: 0 }));
});

test("pointer anchor keeps the point under the cursor fixed", () => {
  const before = at(1, 100, 300);
  const p = { x: 250, y: 120 };
  const after = zoomBy(before, 0.5, extent, visible, { anchor: "pointer", pointer: p });
  const a = viewportToContent(before, p), b = viewportToContent(after, p);
  close(a.x, b.x);
  close(a.y, b.y);
});

test("document is at least the visible size and drops a stray 1px overflow", () => {
  assert.deepEqual(documentRect({ x: 0, y: 0, width: 300, height: 100 }, 1, visible), { x: 0, y: 0, width: 600, height: 400 });
  assert.equal(documentRect({ x: 0, y: 0, width: 601, height: 2000 }, 1, visible).width, 600);
});

test("pan is clamped to the scaled extent", () => {
  assert.deepEqual(pan(at(1), -50, -50, extent, visible).origin, { x: 0, y: 0 });
  assert.deepEqual(pan(at(1), 10_000, 10_000, extent, visible).origin, { x: 200, y: 1600 });
  assert.deepEqual(pan(at(2), 10_000, 10_000, extent, visible).origin, { x: 1000, y: 3600 });
});

test("zooming out re-clamps the origin into the smaller document", () => {
  const s = zoomBy(at(2, 1000, 3600), -1, extent, visible); // 2 -> 1, origin would be (500, 1800)
  assert.deepEqual(s.origin, { x: 200, y: 1600 });
});

test("fit page width ignores zoom limits, as zoomToPageWidth does", () => {
  close(fitWidthZoom({ x: 0, y: 0, width: 100, height: 10 }, visible), 6);
});

test("wheel routing mirrors ONPageView::scrollWheel:", () => {
  assert.deepEqual(interpretWheel({ deltaX: 3, deltaY: 40, deltaMode: 0, ctrlKey: false }, visible), { kind: "pan", dx: 3, dy: 40 });
  assert.deepEqual(interpretWheel({ deltaX: 0, deltaY: 2, deltaMode: 1, ctrlKey: false }, visible), { kind: "pan", dx: 0, dy: 32 });
  // Trackpad pinch-out in Chromium: ctrlKey wheel with small negative deltaY.
  const pinch = interpretWheel({ deltaX: 0, deltaY: -3, deltaMode: 0, ctrlKey: true }, visible);
  assert.equal(pinch.kind, "zoom");
  if (pinch.kind === "zoom") {
    assert.equal(pinch.source, "pinch");
    close(pinch.increment, 0.03 / 1.5);
  }
  // Control + mouse-wheel notch up: one line -> +1/15.
  const notch = interpretWheel({ deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true }, visible);
  assert.equal(notch.kind, "zoom");
  if (notch.kind === "zoom") {
    assert.equal(notch.source, "wheel");
    close(notch.increment, 1 / 15);
  }
});

test("Safari gesture scale deltas feed pinchZoom", () => {
  close(pinchIncrementFromScale(1.15, 1.0), 0.1);
});

test("CSS transform equals translate(-origin) scale(zoom)", () => {
  assert.equal(cssTransform(at(1.5, 10, 20)), "translate3d(-10px, -20px, 0) scale(1.5)");
});
