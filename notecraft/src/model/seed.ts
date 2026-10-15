import type { Element, Library, Outline, Page, ParagraphEl, Run } from "./types.ts";
import { LAYOUT } from "./types.ts";
import { newId, nowIso } from "../lib/id.ts";
import { defaultList } from "./lists.ts";
import { newTable, paragraph, SECTION_COLORS } from "./ops.ts";

const t = (text: string, style: Partial<Run> = {}): Run => ({ text, ...style });
const p = (runs: Run[] | string, extra: Partial<ParagraphEl> = {}) =>
  paragraph(typeof runs === "string" ? [t(runs)] : runs, extra);

function outline(x: number, y: number, width: number, elements: Element[]): Outline {
  return { id: newId("o"), x, y, width, widthSetByUser: true, elements };
}

function page(title: string, outlines: Outline[], level: Page["level"] = 1): Page {
  const now = nowIso();
  return { id: newId("p"), title, level, createdAt: now, modifiedAt: now, outlines, images: [] };
}

function shortcutTable() {
  const rows: [string, string][] = [
    ["Shortcut", "Action"],
    ["⌘ .  /  ⌘ /", "Bullets / numbering"],
    ["Tab  /  ⇧ Tab", "Indent / outdent (children move too)"],
    ["⌘ 1  ⌘ 2  ⌘ 3", "To Do / Important / Question tag"],
    ["⌘ ⌥ 1–3", "Heading 1–3 (⌘ ⇧ N: Normal)"],
    ["⌘ K", "Link"],
    ["⌘ =  /  ⌘ −  /  ⌘ 0", "Zoom in / out (±10%) / 100%"],
    ["⌘ E", "Search all notebooks"],
    ["⌘ Z  /  ⌘ ⇧ Z", "Undo / redo"],
  ];
  const table = newTable(rows.length, 2, 380);
  table.columns = [140, 240];
  rows.forEach(([a, b], i) => {
    const bold = i === 0 ? { b: true } : {};
    table.rows[i]!.cells[0]!.elements = [p([t(a, bold)])];
    table.rows[i]!.cells[1]!.elements = [p([t(b, bold)])];
  });
  return table;
}

export function seedLibrary(): Library {
  const bullet = defaultList("bullet", 0);
  const bullet1 = defaultList("bullet", 1);
  const numbered = defaultList("numbered", 0);

  const welcome = page("Welcome to Notecraft", [
    outline(LAYOUT.bodyX, LAYOUT.bodyY, 470, [
      p([t("Notecraft is a free-form notebook. ", { b: true }), t("Click anywhere on the page to start a new note container, drag its top bar to move it, and drag its right edge to set its width.")]),
      p(""),
      p("Getting around", { style: "h2" }),
      p("Two-finger scroll pans the page.", { list: bullet }),
      p("Pinch, or hold ⌃ while scrolling, to zoom. Zoom is clamped to 25%–500%.", { list: bullet }),
      p("Each page remembers where you were scrolled and zoomed.", { list: bullet }),
      p("Writing", { style: "h2" }),
      p("Press Enter for a new paragraph and Tab to indent it.", { list: numbered }),
      p("Indented items carry their children along.", { list: defaultList("numbered", 1), depth: 1 }),
      p("Backspace at the start of a line removes its bullet, then outdents it.", { list: numbered }),
      p("Use the toolbar or shortcuts for headings, lists, tags, tables and images.", { list: numbered }),
    ]),
    outline(560, LAYOUT.bodyY, 400, [
      p("Try it", { style: "h3" }),
      p("Import a .one section from the sidebar", { tags: [{ kind: "todo", done: false }] }),
      p("Create a subpage with the → button in the page list", { tags: [{ kind: "todo", done: false }] }),
      p("Pinch to zoom out and see the whole page", { tags: [{ kind: "todo", done: true }] }),
      p("Links work: https://learn.microsoft.com/openspecs/office_file_formats/ms-one", {}),
    ]),
    outline(560, 300, 400, [p("Keyboard", { style: "h3" }), shortcutTable()]),
  ]);

  const craft = page("How Notecraft relates to OneNote", [
    outline(LAYOUT.bodyX, LAYOUT.bodyY, 560, [
      p("Notecraft's behaviour comes from a static analysis of OneNote for Mac 16.114."),
      p("Pages, outlines and paragraphs follow OneNote's object graph: SectionNode → page object spaces → PageNode → OutlineNode → OutlineElementNode.", { list: bullet }),
      p("Outlines keep OneNote's absolute positions (OffsetFromParentHoriz/Vert) and widths (LayoutMaxWidth).", { list: bullet }),
      p("Zooming reproduces ONPageViewController: pinch adds magnification ÷ 1.5, ⌃-scroll adds deltaY ÷ 15, menu zoom adds ±0.1.", { list: bullet }),
      p("Zoom anchors at the top-left of the window, as OneNote does; toggle pointer anchoring from the zoom menu.", { list: bullet1, depth: 1 }),
      p("Importing a .one file runs the reverse-engineered revision-store parser in your browser. Nothing is uploaded.", { list: bullet }),
    ]),
  ], 2);

  return {
    version: 1,
    notebooks: [
      {
        id: newId("n"),
        name: "My Notebook",
        color: SECTION_COLORS[0]!,
        createdAt: nowIso(),
        sections: [
          { id: newId("s"), name: "Quick Notes", color: SECTION_COLORS[0]!, createdAt: nowIso(), pages: [welcome, craft] },
          { id: newId("s"), name: "Ideas", color: SECTION_COLORS[2]!, createdAt: nowIso(), pages: [page("", [])] },
        ],
      },
    ],
  };
}
