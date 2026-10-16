# Notecraft

A local-first, free-form notebook for macOS, Windows, Linux and the web. Its
behaviour comes from the static analysis of OneNote for Mac 16.114 in
[`../onenote-re`](../onenote-re). See **[docs/PARITY.md](docs/PARITY.md)** for
the feature-by-feature OneNote checklist.

| Part | What it is |
|---|---|
| `src/` | The app: React 19 + Vite. Runs in the browser and inside the desktop app. |
| [`src-tauri/`](src-tauri) | The desktop app (Tauri 2, Rust): window and menus, the library folder, OneNote import, keychain and AI requests. |
| [`crates/core/`](crates/core) | `notecraft-core`: the library-folder format, search and editing, shared by the app, the CLI and the MCP server. |
| [`crates/cli/`](crates/cli) | `notecraft`: the command line and MCP server for scripts and AI agents. |
| [`../onenote-re/parser-rs`](../onenote-re/parser-rs) | The `.one` / `.onetoc2` parser in Rust; the desktop app runs it natively, the browser as WebAssembly. |

## Download

Installers are attached to each [GitHub Release](https://github.com/joshmaster2165/Notecraft/releases):
`.dmg` for macOS (Apple Silicon and Intel), `.msi` / `-setup.exe` for Windows,
`.AppImage`, `.deb` and `.rpm` for Linux, plus `notecraft-cli-<platform>`, the
command-line tool on its own.

The macOS app is ad-hoc signed, not notarized. The first time, right-click
Notecraft in Applications and choose **Open**, or run
`xattr -dr com.apple.quarantine /Applications/Notecraft.app`.

In the desktop app, **File › Import from OneNote on This Computer** finds the
notebooks OneNote keeps on your machine and imports each one, with its page
history and any pictures in OneNote's cache. **File › Open OneNote Notebook
Folder…** imports a notebook folder with its section groups and `.onetoc2`
order. macOS asks once whether Notecraft may read another app's data.

## Your library is a folder

The desktop app keeps your notes as ordinary files, in `~/Documents/Notecraft`
unless you choose another folder (**File › Change Library Folder…**):

```
library.json                 notebook order, page templates, custom tags
notebooks/<id>.json          a notebook: sections, section groups, Deleted Notes
pages/<id>.json              one page: notes, pictures, ink
assets/<key>.<ext>           pictures, attachments and recordings as normal files
versions/<page>/<id>.json    page versions
```

Back it up, sync it with any service, or point an agent at it. When something
else changes the folder (the CLI, an agent, a sync tool), the app reloads the
changed notes within a second. In the browser the library lives in IndexedDB;
use **Export** to move a notebook between the two as `.notecraft.json`.

## AI, with your own keys or local models

Settings › AI picks a provider for each job; nothing is sent until you use an
AI feature, and then only to that provider.

| Feature | Where |
|---|---|
| Writing assistant: summarize, find action items, improve, shorten, expand, outline, translate, continue, ask questions about a selection, page, section or notebook | ✨ in the toolbar |
| Ink to Text: handwriting becomes typed notes in place | Draw tab |
| Text in pictures (searchable afterwards) | **Text** on a selected picture |
| Transcription of recordings, with timestamps | **Transcribe** on a recording |
| Picture and video generation | Insert tab |

Providers: Ollama and LM Studio (local, no key), OpenAI, Anthropic, Groq,
Google Gemini, and any OpenAI-compatible service. The desktop app keeps keys in
the system keychain (macOS Keychain, Windows Credential Manager, Secret
Service) and sends requests from Rust, so keys never reach the page.

## Agents: CLI and MCP

The desktop app ships the `notecraft` command (Settings › Agents shows where):

```bash
notecraft list                                   # notebooks › sections › pages
notecraft search "launch plan"                   # titles, notes, tables, picture text
notecraft show <page-id>                         # a page as Markdown
notecraft new-page "Work/Meetings" "Standup" "- [ ] Ship it"
notecraft append <page-id> "## Notes\n- Decided to ship Friday"
notecraft todos --json                           # every open to-do, as JSON
notecraft open <page-id>                         # show it in the running app
notecraft mcp                                    # Model Context Protocol server on stdio
```

`notecraft mcp` gives agents (Claude, Cursor and other MCP clients) tools to
list, search, read, create, append, check off to-dos, rename and delete pages,
and to open a page or a search in the Notecraft window. For Claude Code:
`claude mcp add notecraft -- notecraft mcp`. Agent edits go to the library
folder and show up in the app straight away; deleted pages go to Deleted Notes.

## Develop

Requires Node 24 and a Rust toolchain (`rustup`). On Linux, Tauri also needs
`libwebkit2gtk-4.1-dev`.

```bash
npm install
npm run dev          # web app at http://127.0.0.1:5190
npm run desktop      # the desktop app, reloading as you edit (tauri dev)
npm run dist         # installers in ../target/release/bundle (tauri build)
npm run build:wasm   # the Rust parser as WebAssembly for the web app
npm test             # editing model, versions, notebook import, disk sync
npm run test:rust    # parser, library core, CLI and MCP server
```

Push a tag like `v0.3.0` and the [release workflow](../.github/workflows/release.yml)
builds the installers and the CLI for every platform and publishes a Release.

Notecraft was called Onecraft at first; it still imports `.onecraft.json`
exports.

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
| Imported ink: page drawings become editable strokes; handwriting inside notes becomes an inline drawing | `InkContainer 0x60014` → `InkDataNode` → `InkStrokeNode`; `InkPath` multi-byte deltas in HIMETRIC | FF §13 |
| Open a OneNote notebook folder: section order, colors and section groups | `.onetoc2` `TOCEntryIndex_OidIndex`, `FolderChildFilename`, `NotebookElementOrderingID`, `NotebookColor`; subfolders are groups | FF §14 |
| Picture › Crop: drag the edges; Reset brings the whole picture back | `ImageCropped{TopLeftX,TopLeftY,Width,Height}Percentage` 0x140012F5–F8, fractions of the whole picture; the uncropped picture is kept | FF §15.1 |
| Insert › File Printout: each page of a PDF as a picture under the attachment | `IsPrintoutPage 0x08001D85` and `OriginalPageNumber` on each picture; OneNote renders pages with `CPdfToPrintout::RenderPageAsPng` | FF §15.2 |
| Draw › Ink to Shape, as you draw or on lassoed ink | `InkShape2DInfo 0x1C001DAA` / `InkLineShapeInfo 0x1C001DAC` next to the ink; Notecraft's recognizer is its own (the Mac build ships an empty one) | FF §15.3 |
| Insert › Equation: type UnicodeMath (OneNote's linear format) or LaTeX, Enter builds it up | RichEdit math: `MathFormatting 0x08003401` runs, U+FDD0/U+FDEE/U+FDEF object marks, `MathData_*` per object; imported equations come back as UnicodeMath | FF §15.4 |
| Password Protect This Section: AES-256-GCM with a PBKDF2 key, locks after 10 minutes | OneNote's own: `IsEncrypted 0x08001DC6`, `ObjectDataEncryptionKeyV2FNDX`; detected on import, not decrypted | FF §15.5 |
| Insert › Record video; recordings and video files import as playable attachments | `IRecordMedia 0x14001D24`, `AudioRecording*`; media types sniffed from the bytes | FF §15.6 |
| File › Export › Word document, with Word equations | WordprocessingML; equations as Office Math (OMML) | — |
| Section › Export as OneNote section (.one) | The revision store written from scratch by [`onenote-re/writer-rs`](../onenote-re/writer-rs): header, transaction log, FileNodeList fragments, object spaces, property sets, file data | FF §1–8 |

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
  ui/prompt.ts            in-app text prompt (desktop web views have no window.prompt)
  desktop.ts              the bridge to the desktop app's Rust commands (src-tauri)
  store/diskSync.ts       saves only what changed to the library folder
  ai/                     providers and keys, requests, and the AI features
  ui/AssistantPanel.tsx   the writing assistant
  ui/SettingsDialog.tsx   AI, Agents and Library settings; Generate picture / video
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
| Background images | `ImageNode.IsBackground 0x08001D13`, page margins `0x14001C4C–4F` |
| Handwriting inside text and OneNote's handwriting recognition | `TextRunDataObject` → InkDataNode; `RecognizedText*` 0x20054–57 (FF §13) |
| Equations OneNote can edit after a `.one` export | Exported equations are their linear text in `MathFormatting` runs; writing OneNote's own math objects needs the U+FDD0/`MathData_*` layout of FF §15.4 in reverse |
| Ink to Shape that survives a `.one` round trip | `InkShape2DInfo` / `InkLineShapeInfo` are serialized objects whose layout isn't decoded yet (FF §15.3) |
