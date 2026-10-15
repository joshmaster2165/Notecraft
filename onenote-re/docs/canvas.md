# OneNote for Mac canvas mechanics

**Target:** the same binary as [file-format.md](file-format.md) (OneNote 16.114 arm64).
The canvas code is Objective-C, so Ghidra recovered real method names. The
`objc_msgSend` stubs were resolved to their selectors from the
`__objc_stubs` → `__objc_selrefs` → `__objc_methname` chain. Evidence IDs
refer to the REA evidence bundle `evidence/rea-onenote-16.114-arm64.json`, which
stays on the analysis machine (it holds decompiler output) and isn't published.

This is static analysis only: no OneNote process was run or traced. AppKit's
own behaviour (scroll momentum, rubber-banding) lives in the OS, not in
OneNote, and is described here as such.

## 1. Event flow

```
trackpad two-finger scroll ─► ONPageView scrollWheel:                     0x10032c9e8
                               ├─ modifierFlags & NSEventModifierFlagControl == 0
                               │    └─► [super scrollWheel:]  → NSScrollView (ONPageScrollView) pans
                               │         └─► NSClipView bounds change
                               │              └─► ONPageViewController scrollViewContentBoundsDidChange: 0x100274940
                               │                   cachedContentOffset ← clip origin
                               │                   [canvasView setContentBoundsOrigin: origin] 0x100273ffc
                               │                        └─► updateAffineTransform           0x10026dd58
                               └─ Control held
                                    └─► [pageViewDelegate mouseWheelZoom: event.deltaY]    0x1003f1724
                                         (one-time telemetry "FirstZoomViaScrollWheel")

trackpad pinch ─────────────► ONPageView magnifyWithEvent:                  0x1003bf62c
                                    └─► [pageViewDelegate pinchZoom: event.magnification]  0x1003f1740

menu / ⌘+ ⌘−  ──────────────► ONPageViewController zoomIn / zoomOut         0x1003f148c / 0x1003f150c
"Zoom to Page Width" ───────► zoomToPageWidth                               0x1003f1620

all zoom paths ─► updateZoomScaleIfNeeded:(increment) usePageWidth:(BOOL)  0x1003f105c
                   └─(app-host thread) pageRenderExtentAndColorAsync…
                      └─► updateZoomScaleIfNeededFinishedWithIncrement:…     0x1003f1208
                           └─(main queue) block                              0x1003f12d4  ← the math
```

No `smartMagnifyWithEvent:` override exists, and NSScrollView's built-in
magnification is not used. Zoom is implemented entirely by OneNote.

## 2. Zoom math (block `0x1003f12d4`, read at the assembly level)

| Input | Increment passed on |
|---|---|
| pinch | `magnification / 1.5` |
| Control + wheel | `deltaY / 15` |
| zoom in / out | `±0.1f` (0x3FB99999A0000000) |
| page width | special case: `usePageWidth = YES` |

```text
if usePageWidth:
    z' = clipView.bounds.width / pageContentExtent.width      // not clamped
else:
    z' = canvas.zoomScale + increment
    z' = z' > 0.25 ? z' : 0.25        // FUN_1003c497c: fmov s0, #0.25
    z' = z' < 5.0  ? z' : 5.0         // FUN_1003c4974: fmov s0, #5.0
if z' != z and pageRenderExtent != CGRectZero:
    [self changeCanvasViewZoomScale: z']   // onBeforeZoom, setZoomScale:, onAfterZoom, ONMPageViewDidZoomNotification
    [self setCachedZoomScale: z']
    [self setCanvasExtent: pageRenderExtent]
    [clipView setBoundsOrigin: origin · (z'/z)]
    [canvas setNeedsDisplay: YES]
accessibility announcement: round(z' · 100) %
```

Two consequences:
- **Zoom is additive**, not multiplicative. A pinch accumulates
  `Σ magnification / 1.5` onto the scale.
- **The zoom anchor is the viewport's top-left corner.** The clip origin is
  scaled by the zoom ratio, so the content point at the top-left of the window
  stays put. The cursor and pinch centroid are ignored.

## 3. Transform (`ONPageView::updateAffineTransform`)

```text
toInkView = Scale(zoom · 72/2540) · Translate(−contentBoundsOrigin / zoom)
```

72/2540 = 0.0283464567 converts HIMETRIC (the model unit, 0.01 mm) to points.
In CSS, with content laid out in points at zoom 1, this becomes:

```css
transform-origin: 0 0;
transform: translate(-originX px, -originY px) scale(zoom);
```

The canvas never moves as an NSView. Scrolling only changes
`contentBoundsOrigin`, which feeds the transform. That is why one CSS
transform on one element reproduces it faithfully.

## 4. Scroll bounds (`ONPageViewController::setCanvasExtent:`, 0x100273bc8)

```text
doc = pageRenderExtent × zoom
doc.size = max(doc.size, clipView.bounds.size)
if doc.width − visible.width == 1: doc.width −= 1   (else the same for height)  // avoid a 1px scrollbar
if inMouseDrag: doc = union(doc, canvas.bounds)                                  // never shrink mid-drag
canvas.bounds = doc; containerView.frame = doc
```

NSClipView then keeps the origin inside
`[doc.min, doc.max − visible]`.

## 5. Browser mapping (design choices, not observations)

| OneNote input | Browser input | `viewport.ts` |
|---|---|---|
| `scrollWheel:` without Control | `wheel`, `ctrlKey = false` | pan by `deltaX/deltaY` (line and page modes converted) |
| `magnifyWithEvent:` | Chromium/Firefox: `wheel` with `ctrlKey` and a small fractional `deltaY`; Safari: `gesturechange` | `magnification ≈ −deltaY/100` in Chromium, `Δscale` in Safari, then `/1.5` |
| Control + `scrollWheel:` | `wheel` with `ctrlKey` and a large integral or line-mode `deltaY` | one notch ≈ one NSEvent line, so `+1/15` per notch |
| `zoomIn` / `zoomOut` | imperative handle (`⌘=` / `⌘−` in the demo) | `±0.1` |
| `zoomToPageWidth` | imperative handle | `visibleWidth / contentWidth` |
| accessibility announcement | `aria-live` region | `"125%"` |

Deliberate differences:
- **Pointer-anchored zoom is opt-in.** `zoomAnchor="pointer"` keeps the point
  under the cursor fixed. The default `"viewportOrigin"` matches OneNote.
- **No rubber-band overscroll.** The pan is hard-clamped. Momentum still comes
  from the OS, because macOS browsers deliver inertial wheel events just as
  AppKit does.
- **The zoom step is synchronous.** OneNote hops to an app-host thread to
  fetch the page render extent; React already knows the extent.
- **Pinch and Control+wheel are told apart heuristically.** Chromium reports
  both as `ctrlKey` wheel events, so the delta shape decides which path
  applies.

## 6. Function map

| Method | Address | Evidence |
|---|---|---|
| `ONPageView::scrollWheel:` | 0x10032c9e8 | `ev_b7a9f2e6662b09f0…` |
| `ONPageView::magnifyWithEvent:` | 0x1003bf62c | `ev_94d7da48cb1ab869…` |
| `ONPageViewController::pinchZoom:` | 0x1003f1740 | `ev_fb1cf968705069f4…` |
| `ONPageViewController::mouseWheelZoom:` | 0x1003f1724 | `ev_e2bd656424c4df38…` |
| `ONPageViewController::zoomIn` / `zoomOut` | 0x1003f148c / 0x1003f150c | `ev_7f0533a605491856…` / `ev_40c881466a4f023b…` |
| `ONPageViewController::zoomToPageWidth` | 0x1003f1620 | `ev_0bc47affe09a6eda…` |
| `updateZoomScaleIfNeeded:usePageWidth:` | 0x1003f105c | `ev_32c2dadcdb6f23aa…` |
| `…FinishedWithIncrement:usePageWidth:pageRenderExtent:preferredOrigin:` | 0x1003f1208 | `ev_d824296b24a8e594…` |
| zoom-apply block (assembly) | 0x1003f12d4 | `ev_0797d847ea1282b4…` |
| `ONPageViewController::changeCanvasViewZoomScale:` | 0x100272ba4 | `ev_96466041095650f7…` |
| `ONPageView::setZoomScale:` | 0x10026dcc0 | `ev_ebc60c545e3ec4d2…` |
| `ONPageView::updateAffineTransform` | 0x10026dd58 | `ev_e4ee55a1d7f24fc0…` |
| `ONPageViewController::setCanvasExtent:` | 0x100273bc8 | `ev_1859d6a09fce0a58…` |
| `ONPageViewController::scrollViewContentBoundsDidChange:` | 0x100274940 | `ev_17ac43e801cda1fe…` |
| `ONPageView::setContentBoundsOrigin:` | 0x100273ffc | `ev_0aea9f52ea360859…` |
