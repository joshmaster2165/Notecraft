# onenote-re

Pieces rebuilt from OneNote for Mac 16.114, located with REA + Ghidra on
the shipped arm64 binary:

1. **`parser-rs/`**: the `.one` / `.onetoc2` parser in Rust: sections, pages,
   rich text, tables, pictures, ink, note tags, page history and notebook
   tables of contents, as JSON. Notecraft's desktop app runs it natively and
   its web build as WebAssembly (`--features wasm`). No unsafe code; every read
   is bounds-checked.
2. **`parser/`**: the TypeScript reference parser it was ported from. Both
   produce byte-identical JSON; `parser-rs/tests/differential.mjs` checks this
   on real files, fuzzed copies and generated files with ink, attachments and
   `.onetoc2`. [docs/file-format.md](docs/file-format.md) describes the format
   and maps each part to the OneNote functions that read or write it.
3. **`writer-rs/`**: the other direction. It writes a Notecraft section as a
   OneNote 2010+ `.one` file, or a whole notebook as the folder OneNote opens
   (an `Open Notebook.onetoc2` per folder, a `.one` per section, subfolders for
   section groups). Equations are written as OneNote's own math objects, and
   paper colour, rule lines and hidden titles carry over. Notecraft's
   **Export as OneNote section / notebook** uses it. Its tests read every
   file back with this parser and with an independent one (`onenote_parser`),
   and check every checksum and reference count.
4. **`canvas/`**: `<OneNoteCanvas>`, an isolated React pan/zoom surface that
   reproduces OneNote's trackpad scroll and pinch handling with one CSS
   transform. The recovered algorithm is in [docs/canvas.md](docs/canvas.md).

Requires Node ≥ 23.6, which runs `.ts` directly.

```bash
npm install
```

## Writer

```bash
cargo test -p onenote-writer
```

## Parser

```bash
cargo run -p onenote-re --release --bin onenote-parse -- "path/to/Section.one" > section.json
cargo test -p onenote-re
node parser-rs/tests/differential.mjs "<folder of .one files>" --wasm   # Rust vs TypeScript

npm run parse -- "path/to/Section.one" --out section.json             # the TypeScript reference
```

Options:
- `--raw` dumps the full revision-store object graph: header, fragments, object
  spaces, revisions and every property. Use it to explore unmapped data.
- `--assets <dir>` writes embedded images and attachments to `<dir>` and
  references them from the JSON.
- `--cache <dir>` takes picture bytes that a section leaves out (`<invfdo>`)
  from OneNote's local cache folder. By default the parser uses the `cache`
  sibling of a `…/OneNote/15.0/Backup` tree; `--no-cache` turns this off.
  OneNote for Mac downloads pictures on demand, so the cache only has the ones
  it has fetched. See [docs/file-format.md §11](docs/file-format.md).

From code:

```ts
import { parseOneNote } from "./parser/src/notebook.ts";
const json = parseOneNote(new Uint8Array(bytes), { onAsset: ({ bytes, mediaType }) => storeSomewhere(bytes) });

// Fill in pictures the section left out, from OneNote's cache folder (Node only):
import { OneNoteCache } from "./parser/src/cache.ts";
const cache = new OneNoteCache(OneNoteCache.findFor(sectionPath)!);
parseOneNote(new Uint8Array(bytes), { resolveFileData: cache.resolver() });
```

The output is roughly:

```jsonc
{
  "format": "onenote-revision-store",
  "source": { "fileKind": "section", "fileFormatVersion": { "lastWriter": "0x2a" }, ... },
  "section": {
    "pages": [{
      "title": "…", "level": 1, "createdAt": "…", "lastModified": "…", "author": "…",
      "size": { "width": 754, "height": 783 },                         // points
      "titleBlocks": [ /* outlines with role titleText / titleDate */ ],
      "blocks": [{
        "type": "outline", "layout": { "x": 54, "y": 90.6, "width": 522 },
        "children": [{
          "type": "outlineElement", "list": { "kind": "numbered", "scheme": "decimal", "suffix": "." },
          "content": [{ "type": "richText", "text": "…", "runs": [{ "text": "…", "style": { "bold": true }, "href": "https://…" }],
                        "paragraph": { "styleId": "h2", "font": "Calibri", "fontSize": 14 } },
                      { "type": "table", "rows": [{ "cells": [{ "children": [ /* outline elements */ ] }] }] },
                      { "type": "image", "layout": {}, "ocrText": "…", "unverifiedHash": "…", "assetStatus": "notEmbedded", "asset": null }],
          "children": [ /* nested outline elements */ ]
        }]
      }]
    }]
  },
  "diagnostics": { "warnings": [], "encryptedObjectSpaces": [] }
}
```

Check a whole folder (exits non-zero on any warning):

```bash
npm run smoke -- "$HOME/Library/Containers/com.microsoft.onenote.mac/Data/Library/Application Support/Microsoft User Data/OneNote/15.0/Backup"
```

## Canvas

```tsx
import { OneNoteCanvas, type OneNoteCanvasHandle } from "./canvas/OneNoteCanvas.tsx";

const ref = useRef<OneNoteCanvasHandle>(null);
<OneNoteCanvas ref={ref} contentExtent={{ x: 0, y: 0, width: 816, height: 1056 }} style={{ height: "100vh" }}>
  <MyPage />   {/* laid out at zoom 1, in px */}
</OneNoteCanvas>
// ref.current.zoomIn() / zoomOut() / zoomToPageWidth() / setZoom(1.5) / scrollTo({ x, y })
```

| Prop | Default | |
|---|---|---|
| `contentExtent` | required | Page bounds at zoom 1. They set the scroll limits. |
| `zoomAnchor` | `"viewportOrigin"` | Matches OneNote. Use `"pointer"` to zoom around the cursor. |
| `limits` | `{ min: 0.25, max: 5 }` | OneNote's clamp. |
| `initialZoom` / `initialOrigin` | `1` / `{0,0}` | |
| `showScrollIndicators` | `true` | Overlay thumbs that fade like macOS overlay scrollers. |
| `onViewportChange` | | Called with `{ zoom, origin }`. |

Run the demo, which can also load any JSON from the parser:

```bash
npm run demo
```

Then open http://127.0.0.1:5180.

Tests and typecheck:

```bash
npm test && npm run typecheck
```
