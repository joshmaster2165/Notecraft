# Notecraft

A local-first, free-form notebook with OneNote-style pages, built on a
clean-room reverse engineering of how OneNote for Mac stores notebooks and
handles its page canvas.

| Folder | What it is |
|---|---|
| [`notecraft/`](notecraft/) | The app: React + Vite, also packaged as a desktop app. See its README for features and the OneNote parity checklist. |
| [`onenote-re/`](onenote-re/) | The research it's built on: a TypeScript `.one` parser, the reconstructed pan/zoom canvas, and format and behaviour notes. |

**Download:** installers for macOS, Windows and Linux are on the
[Releases page](https://github.com/joshmaster2165/Notecraft/releases).

```bash
cd notecraft
npm install
npm run dev       # web
npm run desktop   # desktop app
```

## About the reverse engineering

`onenote-re` documents OneNote's on-disk format and canvas behaviour for
interoperability: reading your own notebooks in another app. Its code is
written from scratch, guided by Microsoft's published [MS-ONESTORE] and
[MS-ONE] specifications and by static analysis of OneNote for Mac 16.114.

This repository contains no Microsoft code. The raw analysis evidence
(decompiler output) stays on the analysis machine and is excluded from git;
the docs cite it by Evidence ID.

[MS-ONESTORE]: https://learn.microsoft.com/openspecs/office_file_formats/ms-onestore/
[MS-ONE]: https://learn.microsoft.com/openspecs/office_file_formats/ms-one/
