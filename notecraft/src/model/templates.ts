// Built-in page templates (Insert > Page Templates). Users add their own with
// "Save current page as a template"; those live in Library.templates.
import type { Element, Outline, Page, PaperStyle, Run } from "./types.ts";
import { LAYOUT } from "./types.ts";
import { defaultList } from "./lists.ts";
import { emptyPage, newTable, paragraph } from "./ops.ts";
import { newId } from "../lib/id.ts";

const t = (text: string, s: Partial<Run> = {}): Run => ({ text, ...s });
const p = (text: string, extra: Parameters<typeof paragraph>[1] = {}) => paragraph(text ? [t(text)] : [], extra);
const h = (text: string, level: 2 | 3 = 2) => paragraph([t(text)], { style: `h${level}` });
const todo = (text: string) => p(text, { tags: [{ kind: "todo", done: false }] });
const bullet = (text: string) => p(text, { list: defaultList("bullet", 0) });

function outline(elements: Element[], x: number = LAYOUT.bodyX, y: number = LAYOUT.bodyY, width = 560): Outline {
  return { id: newId("o"), x, y, width, widthSetByUser: true, elements };
}

function page(title: string, outlines: Outline[], paper?: PaperStyle): Page {
  return { ...emptyPage(title), outlines, ...(paper ? { paper } : {}) };
}

function table(rows: string[][], widths: number[]) {
  const tb = newTable(rows.length, widths.length);
  tb.columns = widths;
  rows.forEach((r, i) => r.forEach((text, j) => (tb.rows[i]!.cells[j]!.elements = [paragraph(text ? [t(text, i === 0 ? { b: true } : {})] : [])])));
  return tb;
}

export interface BuiltinTemplate {
  id: string;
  name: string;
  category: "Business" | "Planners" | "Academic" | "Blank";
  build: () => Page;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  { id: "blank-ruled", name: "Ruled page", category: "Blank", build: () => page("", [], { rule: "standard" }) },
  { id: "blank-grid", name: "Grid page", category: "Blank", build: () => page("", [], { rule: "grid-small" }) },
  {
    id: "meeting",
    name: "Meeting notes",
    category: "Business",
    build: () =>
      page("Meeting notes", [
        outline([h("Details"), p("Date and time: "), p("Location: "), p("Attendees: "), h("Agenda"), bullet(""), h("Notes"), bullet(""), h("Action items"), todo(""), todo("")]),
      ]),
  },
  {
    id: "project",
    name: "Project overview",
    category: "Business",
    build: () =>
      page("Project overview", [
        outline([h("Goal"), p(""), h("Milestones")], LAYOUT.bodyX, LAYOUT.bodyY, 600),
        outline([table([["Milestone", "Owner", "Due", "Status"], ["", "", "", ""], ["", "", "", ""], ["", "", "", ""]], [200, 120, 100, 120])], LAYOUT.bodyX, 230, 600),
        outline([h("Risks"), bullet(""), h("Next steps"), todo("")], LAYOUT.bodyX, 400, 600),
      ]),
  },
  {
    id: "todo",
    name: "To-do list",
    category: "Planners",
    build: () =>
      page("To-do list", [
        outline([h("Today"), todo(""), todo(""), todo("")], LAYOUT.bodyX, LAYOUT.bodyY, 300),
        outline([h("This week"), todo(""), todo(""), todo("")], 400, LAYOUT.bodyY, 300),
        outline([h("Later"), todo(""), todo("")], LAYOUT.bodyX, 300, 300),
      ]),
  },
  {
    id: "journal",
    name: "Daily journal",
    category: "Planners",
    build: () =>
      page(new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }), [
        outline([h("Grateful for"), bullet(""), h("Top priorities"), todo(""), todo(""), todo(""), h("Notes"), p("")]),
      ], { rule: "standard" }),
  },
  {
    id: "lecture",
    name: "Lecture notes",
    category: "Academic",
    build: () =>
      page("Lecture notes", [
        outline([p("Course: "), p("Topic: "), h("Key ideas"), bullet(""), h("Questions"), p("", { tags: [{ kind: "question" }] }), h("Summary"), p("")], LAYOUT.bodyX, LAYOUT.bodyY, 560),
      ], { rule: "college" }),
  },
];
