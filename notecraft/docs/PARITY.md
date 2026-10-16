# OneNote → Notecraft parity

The checklist was drawn from OneNote for Mac 16.114 itself. Feature names
come from its English UI strings (`en.lproj`). Behaviour and data shapes come
from the binary and file-format analysis in [`../../onenote-re`](../../onenote-re).

✅ done · 🟡 partial · ⬜ not yet · — not applicable to a local-first app

**61 of 67 done**, 2 partial, 3 not yet, 1 not applicable.

## Organize

| OneNote | Notecraft | Notes |
|---|---|---|
| Notebooks: create, rename, switch | ✅ | |
| Sections: create, rename, color, reorder | ✅ | Drag to reorder |
| Section Groups (nested) | ✅ | Drag a section onto a group; "Ungroup" keeps sections |
| Pages, subpages (3 levels), reorder | ✅ | `PageLevel`; drag to reorder |
| Move or Copy Pages | ✅ | Subpages travel with their page |
| Move Section / Section Group | ✅ | Groups move with their subgroups and sections |
| Deleted Notes (60 days) | ✅ | Restore, delete permanently, empty |
| Page Templates (built-in + Save as Template) | ✅ | 7 built-ins plus your own |
| Page Versions | ✅ | Notecraft snapshots plus OneNote's own history on import |
| Password Protected Section | ✅ | AES-256-GCM, key from the password (PBKDF2-SHA256, 600,000 rounds). Lock now, Lock All (⌘⌥L), locks after 10 minutes away. Locked pages never reach disk unencrypted. OneNote's own locked sections are detected on import, not opened: unlock them in OneNote first |
| Sync, sharing, co-authoring | — | Local-first: the library is a folder you can sync with any service |

## Write

| OneNote | Notecraft | Notes |
|---|---|---|
| Click anywhere to type; move and resize containers | ✅ | `OutlineNode` positions and widths |
| Bold, italic, underline, strikethrough, sub/superscript | ✅ | |
| Font, font size, font color, highlight color | ✅ | OneNote's size list and highlight palette |
| Clear formatting | ✅ | |
| Styles: Heading 1–6, Quote, Code, Normal | ✅ | Next paragraph after a heading reverts to Normal (`NextStyle`) |
| Citation, Page Title style | ✅ | Citation style; the page title is its own field |
| Alignment | ✅ | `ParagraphAlignment` |
| Line spacing, paragraph spacing | ✅ | Space before/after and line spacing; imported values are applied |
| Bullets and numbering (level schemes) | ✅ | • ◦ ▪ and 1. a. i. by level, as OneNote does |
| Bullet/numbering library, restart numbering | ✅ | Restart, set value, continue numbering |
| Indent / outdent with children | ✅ | |
| Tags: full catalog, ⌘1–⌘9, ⌘0 | ✅ | All 29 default tags; several per paragraph |
| Custom tags | ✅ | Create, edit and delete; OneNote's own custom tags come in on import |
| Find Tags (Tags Summary) | ✅ | Section / notebook / all; "only unchecked" filter |
| Create Summary Page from tags | ✅ | Tagged notes grouped by tag, each linked back to its paragraph |
| Links: web, auto-detect, Copy Link to Page, `[[Page]]` | ✅ | `[[Title]]` creates the page if missing |
| Links to sections or paragraphs | ✅ | Copy link to section / paragraph |
| Tables: insert, rows/columns above/below/left/right, delete | ✅ | |
| Table borders, shading, sort, column widths, Tab navigation | ✅ | |
| Pictures: insert, paste, drop, resize, inline or floating | ✅ | |
| Picture alt text, rotate, crop | ✅ | Crop keeps OneNote's four percentages (`ImageCropped*Percentage`), so it can be changed or undone |
| Text in pictures (OCR) searchable | ✅ | Imported OCR text, and **Text** on any picture (AI vision) |
| File attachments | ✅ | Up to 25 MB |
| File printouts | ✅ | Insert › File Printout: each PDF page as a picture (`IsPrintoutPage`), rendered by the Rust engine; the PDF stays attached |
| Insert Date / Time / Date and Time | ✅ | ⌥⇧D, ⌥⇧T, ⌥⇧F |
| Equations, Ink to Math | 🟡 | Insert › Equation in UnicodeMath (OneNote's linear format) or LaTeX, built up to MathML; Word export writes real Office Math. No Ink to Math |
| Audio and video recording | ✅ | Microphone and camera; AI transcription for audio |
| Spell check | ✅ | Operating-system spellchecker |
| Undo / redo | ✅ | App-wide, typing coalesced |
| Paste with formatting | ✅ | Keeps emphasis, links, colors, headings and lists; ⌥⇧⌘V pastes plain text |

## Draw

| OneNote | Notecraft | Notes |
|---|---|---|
| Pen, highlighter (colors, thickness) | ✅ | Stored in page points, so ink stays on its text at every zoom |
| Stroke eraser | ✅ | |
| Lasso select, move ink | ✅ | Drag to move, Delete to remove |
| Shapes, Ink to Shape, Ink to Text | ✅ | Ink to Shape as you draw or on lassoed ink: lines, arrows, triangles, rectangles, diamonds, polygons, ellipses. Ink to Text (AI vision) |
| Pressure sensitivity | ⬜ | |

## View

| OneNote | Notecraft | Notes |
|---|---|---|
| Pinch / ⌃-scroll zoom, ⌘= ⌘− (±10%), 25–500%, Page Width | ✅ | Reconstructed from `ONPageViewController` |
| Two-finger pan; per-page scroll/zoom memory | ✅ | `ONWorkspace` scroll-and-zoom cache |
| Full Page View | ✅ | ⌘⇧F |
| Hide Page Title | ✅ | |
| Paper Style: page color | ✅ | OneNote's 13 page colors |
| Rule lines: narrow / standard / college ruled; small / medium / large grid; rule color | ✅ | |
| Dark mode | ✅ | Follows the system |

## Find

| OneNote | Notecraft | Notes |
|---|---|---|
| Search all notebooks | ✅ | ⌘E: titles, text, table cells, OCR text |
| Search scope (this section / notebook) | ✅ | This section / this notebook / all notebooks |
| Find on page | ✅ | ⌘F, with match highlighting |

## Import, export, print

| OneNote | Notecraft | Notes |
|---|---|---|
| Open `.one` sections | ✅ | In the browser or desktop app; includes page history and ink |
| Import OneNote notebooks on this computer | ✅ | Desktop. Pictures come from OneNote's cache when it has them |
| Open `.onetoc2` notebooks | ✅ | Section order, colors and section groups; open a notebook folder or drop it on the window |
| Export notebook | ✅ | `.notecraft.json` |
| Export page | ✅ | Markdown |
| Print / save as PDF | ✅ | |
| Export `.one`, `.docx` | 🟡 | Word for a page or section, with real Word equations. OneNote section (`.one`) from the section menu, written by [`onenote-re/writer-rs`](../../onenote-re/writer-rs) and checked with an independent reader; not yet opened in OneNote itself |

## Desktop app

| | Notecraft | Notes |
|---|---|---|
| macOS, Windows, Linux builds | ✅ | GitHub Actions on every `v*` tag |
| Native menus and shortcuts | ✅ | |
| Code signing / notarization | ⬜ | Builds are ad-hoc signed |
| Auto-update | ⬜ | |

## Beyond OneNote

| | Notecraft | Notes |
|---|---|---|
| Notes as plain files on disk | ✅ | One JSON file per page; pictures as files |
| AI writing assistant | ✅ | Local models or your own keys; selection, page, section or notebook |
| Transcribe recordings | ✅ | Timestamped transcript under the recording |
| Generate pictures and video | ✅ | OpenAI-compatible image APIs; OpenAI video |
| Agents: CLI, JSON, MCP | ✅ | `notecraft` command and `notecraft mcp` |
| Small native app | ✅ | Tauri 2 (Rust) with the system web view; the `.one` parser is Rust |
