# Notecraft

A local-first, free-form notebook for macOS, Windows, Linux and the web. Its
behaviour comes from the static analysis of OneNote for Mac 16.114 in
[`../onenote-re`](../onenote-re). See **[docs/PARITY.md](docs/PARITY.md)** for
the feature-by-feature OneNote checklist.

## Download

Installers are attached to each [GitHub Release](https://github.com/joshmaster2165/Notecraft/releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Notecraft-<version>-mac-arm64.dmg` |
| macOS (Intel) | `Notecraft-<version>-mac-x64.dmg` |
| Windows | `Notecraft-<version>-win-x64.exe` |
| Linux | `.AppImage` or `.deb` |

The macOS app is ad-hoc signed, not notarized. The first time, right-click
Notecraft in Applications and choose **Open**, or run
`xattr -dr com.apple.quarantine /Applications/Notecraft.app`.

In the desktop app, **File › Import from OneNote on This Computer** finds the
notebooks OneNote keeps on your machine and imports each one, with its page
history and any pictures in OneNote's cache. macOS asks once whether
Notecraft may read another app's data.

Notecraft reuses the research workspace's code directly:

- **`@re/parser`** is the reverse-engineered `.one` revision-store parser. It
  runs in the browser to import sections; nothing is uploaded.
- **`@re/canvas`** is `<OneNoteCanvas>`, the reconstructed pan/zoom surface
  every page sits on.

## Develop

```bash
npm install
npm run dev          # web app at http://127.0.0.1:5190
npm run desktop      # build and open the desktop app
npm run desktop:dev  # desktop shell around the running dev server
npm test             # editing-model and version-history tests
npm run dist:mac     # installers in release/ (also dist:win, dist:linux)
```

Push a tag like `v0.2.0` and the [release workflow](../.github/workflows/release.yml)
builds the installers for every platform and publishes a Release.

The library is saved in the browser's IndexedDB on every change. Use
**Export** to download a notebook as `.notecraft.json`.

Notecraft was called Onecraft at first. On the first run after the rename it
copies an existing Onecraft library into its own storage, and it still imports
`.onecraft.json` exports.

## Features, and where each comes from

The references point into [`file-format.md`](../onenote-re/docs/file-format.md) (FF) and
[`canvas.md`](../onenote-re/docs/canvas.md) (CV). The evidence behind each
Evidence ID stays on the analysis machine and isn't part of the repository.

| Notecraft feature | OneNote structure or behaviour it follows | Reference |
|---|---|---|
| Notebooks → sections → pages | `.onetoc2` → `SectionNode 0x60007` → `PageSeriesNode 0x60008` → one object space per page | FF §5, §8 |
| Subpages (levels 1–3; drag to reorder, → / ← to nest) | `PageMetaData.PageLevel 0x14001DFF`; page order is the `ChildGraphSpaceElementNodes` order | FF §8 |
| Title with date and time under it | `TitleNode 0x6002C` holding `titleText`, `titleDate` and `titleTime` outlines | FF §8, parser output |
| Click anywhere to start a container; drag its top bar; drag its edge for width | `OutlineNode` `OffsetFromParentHoriz/Vert`, `LayoutMaxWidth`, `IsLayoutSizeSetByUser` | FF §8 |
| Default positions: title at 36pt, first body note at (54, 90)pt | Observed in OneNote's files: x = 54pt (0.75″), y ≈ 90.56pt | FF §8 |
| Empty containers disappear when you leave them | OneNote outline lifecycle | (behavioural) |
| Paragraphs with bold, italic, underline, strike, highlight, links | `RichTextOENode`: `RichEditTextUnicode`, `TextRunIndex` + `TextRunFormatting` → run model | FF §8 |
| Links | Stored as a `U+FDDF HYPERLINK "url"` field code, which the importer turns into `href` runs | FF §8 |
| Headings 1–6, Quote, Code; Enter after a heading gives Normal | `ParagraphStyleId` values (`h1`…); `NextStyle 0x1C00348A` | FF §8, schema |
| Tab / Shift+Tab move an item with its children | `ElementChildNodes` nesting; Notecraft stores it flat with `depth` | FF §8 |
| Bullets cycle • ◦ ▪; numbering cycles 1. a. i. by level | `NumberListFormat` (length-prefixed, `U+FFFD` + MSONFC scheme) | FF §8 |
| All 29 default tags (⌘1–⌘9), several per paragraph, checkable | `NoteTagStates` (on `RichTextOENode` in Mac files), `ActionItemStatus` (bit 0 = done) | FF §8, §10 |
| Custom tags, created in Notecraft or imported from OneNote | `NoteTagSharedDefinitionContainer 0x120043`: label, shape, colors; `ActionItemType` present → checkable | FF §10 |
| Tables: Tab walks cells and adds a row at the end; drag column edges | `TableNode`/`RowNode`/`CellNode 0x60022–24`, `TableColumnWidths` | FF §8 |
| Images inline or floating; paste or drop to add | `ImageNode 0x60011` in an outline or directly on the page | FF §7–8 |
| Imported pictures without data show a placeholder with their recognized text | `<invfdo>` file-data references; OCR text in `RichEditTextUnicode` on the image node | FF §7 |
| Two-finger scroll pans | `ONPageView scrollWheel:` without Control → NSScrollView → `contentBoundsOrigin` | CV §1 |
| Pinch / ⌃-scroll zoom: +magnification ÷ 1.5, +deltaY ÷ 15, ±0.1 from menu or ⌘=/⌘−, clamped to 25–500% | `pinchZoom:`, `mouseWheelZoom:`, `zoomIn`/`zoomOut`, block `0x1003f12d4` | CV §2 |
| Zoom keeps the top-left corner fixed (pointer anchoring is an option) | `setBoundsOrigin: origin × z′/z` | CV §2 |
| Page width zoom | `zoomToPageWidth` → visible width ÷ content width | CV §2 |
| The page grows as you write beyond it | `setCanvasExtent:` → `max(extent × zoom, visible)` | CV §4 |
| Each page reopens at its last scroll position and zoom | `ONWorkspace getCachedScrollOffset:withZoomScale:` | CV §1 |
| Screen readers hear the zoom level | Accessibility announcement of `round(z × 100)%` | CV §2 |
| Import `.one` (button or drag and drop) | the parser: header → transaction log → FileNodeLists → revisions → property sets | FF §1–6 |
| ⌘E search across notebooks, including table cells and OCR text | OneNote's search scope | (behavioural) |
| **Page versions** (clock button): Notecraft saves a version before your first edit, after a minute without edits, and when you leave a page. Preview any version read-only, then restore it as one undoable step. Keeps the latest 50 per page | OneNote's page history: each version is a full page revision in its own context | FF §12 |
| Importing a `.one` brings OneNote's own page history (badged "OneNote", with its original author and time) | `PageManifestNode.VersionHistoryGraphSpaceContextNodes` → `VersionHistoryContent 0x6003C` → `VersionProxy 0x6003D` → historical revision | FF §12 |

## Structure

```
src/
  model/types.ts      document model and its OneNote mapping (read this first)
  model/ops.ts        editing operations (Enter, Tab, Backspace, lists, tags, tables, pages)
  model/lists.ts      bullet glyphs and numbering schemes
  model/importOne.ts  NotebookJson (parser output) → Notecraft sections
  model/seed.ts       welcome notebook
  store/store.ts      state + undo/redo (typing in one paragraph coalesces into one step)
  store/persist.ts    IndexedDB library, localStorage selection + per-page view cache
  store/actions.ts    selection, CRUD, import/export
  model/versions.ts   snapshot timing (VersionTracker), signatures, pruning, restore
  store/versionStore.ts   IndexedDB versions + shared image blobs
  store/versionService.ts watches edits and page switches, feeds the tracker
  ui/PageCanvas.tsx   page surface on <OneNoteCanvas>
  ui/editor/*         paragraphs, outlines, tables, images
  ui/VersionsPanel.tsx    version list, read-only preview banner, restore
  ui/TagsPanel.tsx        Find Tags (Tags Summary)
  ui/Dialogs.tsx          Move or Copy, Page Templates, Deleted Notes, Import from OneNote
  ui/editor/InkLayer.tsx  pen, highlighter, shapes, eraser, lasso select
  model/tags.ts           OneNote's tag catalog
  model/templates.ts      built-in page templates
  store/links.ts          page, section and paragraph links; [[wiki]] links
  store/recorder.ts       Insert › Record audio
  lib/paste.ts            paste with formatting (clipboard HTML → paragraphs)
  ui/prompt.ts            in-app text prompt (Electron has no window.prompt)
  electron/main.ts        desktop window, native menus, OneNote discovery and parsing (with cache pictures)
  electron/preload.ts     the bridge between the page and the main process
  ui/Sidebar.tsx, PageList.tsx, Toolbar.tsx, SearchPanel.tsx
```

## Known limits

- **No nested tables.** Tables inside table cells aren't supported, and
  imported nested tables are flattened.
- **Some imported pictures are placeholders.** OneNote's Mac backups don't
  store picture bytes; the desktop importer recovers them from OneNote's local
  cache when it has them. The rest import as placeholders with their
  recognized text.
- **Versions are local.** They live in this browser's IndexedDB and are not
  part of **Export**. Images are stored once and shared between versions; an
  image no longer used by any version is not cleaned up yet.
- **Desktop browsers only.** There's a compact layout below 760px, but no
  touch editing.

## Roadmap the analysis already supports

The remaining gaps are listed in [docs/PARITY.md](docs/PARITY.md). These ones
already have the groundwork mapped in the format analysis:

| Next feature | What to build on |
|---|---|
| Author attribution per paragraph | `AuthorOriginal 0x20001D78`, `AuthorMostRecent 0x20001D79` → `ReadOnlyPersistablePropertyContainerForAuthor 0x120001` |
| Reading `.onetoc2` directly (section order, groups, colors) | The `.onetoc2` table of contents. The parser reads its container; its semantics still need mapping (FF §10) |
| Background images | `ImageNode.IsBackground 0x08001D13`, page margins `0x14001C4C–4F` |
| Importing OneNote ink | `InkContainer 0x60047`, `InkStrokeNode 0x60048`; the strokes are not decoded yet (Notecraft's own ink works) |
| Password-protected sections | `ObjectDataEncryptionKeyV2FNDX`, detected by the parser today |
| Write `.one` files | The writer routines are mapped: fragment create/finalize `FUN_100d32b74`/`FUN_100d32d8c`, FileDataStoreObject writer `FUN_100d1be84` (FF §9) |
