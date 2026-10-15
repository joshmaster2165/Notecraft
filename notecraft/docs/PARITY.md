# OneNote → Notecraft parity

The checklist was drawn from OneNote for Mac 16.114 itself. Feature names
come from its English UI strings (`en.lproj`). Behaviour and data shapes come
from the binary and file-format analysis in [`../../onenote-re`](../../onenote-re).

✅ done · 🟡 partial · ⬜ not yet · — not applicable to a local-first app

## Organize

| OneNote | Notecraft | Notes |
|---|---|---|
| Notebooks: create, rename, switch | ✅ | |
| Sections: create, rename, color, reorder | ✅ | Drag to reorder |
| Section Groups (nested) | ✅ | Drag a section onto a group; "Ungroup" keeps sections |
| Pages, subpages (3 levels), reorder | ✅ | `PageLevel`; drag to reorder |
| Move or Copy Pages | ✅ | Subpages travel with their page |
| Move Section / Section Group | 🟡 | Sections move between notebooks and groups; groups can't be moved yet |
| Deleted Notes (60 days) | ✅ | Restore, delete permanently, empty |
| Page Templates (built-in + Save as Template) | ✅ | 7 built-ins plus your own |
| Page Versions | ✅ | Notecraft snapshots plus OneNote's own history on import |
| Password Protected Section | ⬜ | Detected in imports; not decrypted or created |
| Sync, sharing, co-authoring | — | Local-first; export/import notebooks as JSON |

## Write

| OneNote | Notecraft | Notes |
|---|---|---|
| Click anywhere to type; move and resize containers | ✅ | `OutlineNode` positions and widths |
| Bold, italic, underline, strikethrough, sub/superscript | ✅ | |
| Font, font size, font color, highlight color | ✅ | OneNote's size list and highlight palette |
| Clear formatting | ✅ | |
| Styles: Heading 1–6, Quote, Code, Normal | ✅ | Next paragraph after a heading reverts to Normal (`NextStyle`) |
| Citation, Page Title style | 🟡 | The page title is its own field; no Citation style |
| Alignment | ✅ | `ParagraphAlignment` |
| Line spacing, paragraph spacing | ⬜ | Imported spacing isn't applied |
| Bullets and numbering (level schemes) | ✅ | • ◦ ▪ and 1. a. i. by level, as OneNote does |
| Bullet/numbering library, restart numbering | 🟡 | Imported formats render; no picker yet |
| Indent / outdent with children | ✅ | |
| Tags: full catalog, ⌘1–⌘9, ⌘0 | ✅ | All 29 default tags; several per paragraph |
| Custom tags | 🟡 | Imported custom tags show their label; can't create new ones yet |
| Find Tags (Tags Summary) | ✅ | Section / notebook / all; "only unchecked" filter |
| Create Summary Page from tags | ⬜ | |
| Links: web, auto-detect, Copy Link to Page, `[[Page]]` | ✅ | `[[Title]]` creates the page if missing |
| Links to sections or paragraphs | ⬜ | |
| Tables: insert, rows/columns above/below/left/right, delete | ✅ | |
| Table borders, shading, sort, column widths, Tab navigation | ✅ | |
| Pictures: insert, paste, drop, resize, inline or floating | ✅ | |
| Picture alt text, rotate, crop | ⬜ | Imported alt text is kept |
| Text in pictures (OCR) searchable | 🟡 | Imported OCR text is searchable; new pictures aren't OCR'd |
| File attachments | ✅ | Up to 25 MB |
| File printouts | ⬜ | |
| Insert Date / Time / Date and Time | ✅ | ⌥⇧D, ⌥⇧T, ⌥⇧F |
| Equations, Ink to Math | ⬜ | |
| Audio and video recording | ⬜ | |
| Spell check | ✅ | Operating-system spellchecker |
| Undo / redo | ✅ | App-wide, typing coalesced |
| Paste with formatting | 🟡 | Plain-text paste, one paragraph per line |

## Draw

| OneNote | Notecraft | Notes |
|---|---|---|
| Pen, highlighter (colors, thickness) | ✅ | Stored in page points, so ink stays on its text at every zoom |
| Stroke eraser | ✅ | |
| Lasso select, move ink | ⬜ | |
| Shapes, Ink to Shape, Ink to Text | ⬜ | Imported ink isn't decoded yet (`InkContainer 0x60047`) |
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
| Search scope (this section / notebook) | 🟡 | Always searches everything |
| Find on page | ✅ | ⌘F, with match highlighting |

## Import, export, print

| OneNote | Notecraft | Notes |
|---|---|---|
| Open `.one` sections | ✅ | In the browser or desktop app; includes page history |
| Import OneNote notebooks on this computer | ✅ | Desktop. Pictures come from OneNote's cache when it has them |
| Open `.onetoc2` notebooks | 🟡 | The desktop importer groups sections by notebook folder; `.onetoc2` itself isn't read |
| Export notebook | ✅ | `.notecraft.json` |
| Export page | ✅ | Markdown |
| Print / save as PDF | ✅ | |
| Export `.one`, `.docx` | ⬜ | The `.one` writer routines are mapped (file-format.md §9) |

## Desktop app

| | Notecraft | Notes |
|---|---|---|
| macOS, Windows, Linux builds | ✅ | GitHub Actions on every `v*` tag |
| Native menus and shortcuts | ✅ | |
| Code signing / notarization | ⬜ | Builds are ad-hoc signed |
| Auto-update | ⬜ | |
