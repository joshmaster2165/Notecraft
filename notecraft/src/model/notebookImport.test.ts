import { test } from "node:test";
import assert from "node:assert/strict";
import type { NotebookToc } from "@re/parser/src/toc.ts";
import type { Section } from "./types.ts";
import { assembleNotebook, type FolderSection } from "./notebookImport.ts";

const section = (name: string, color = "#4f7cac"): Section => ({ id: `s-${name}`, name, color, createdAt: "", pages: [] });
const file = (dir: string, fileName: string, colorFromFile = false): FolderSection => ({ dir, fileName, section: section(fileName.replace(/\.one$/, "")), colorFromFile });
const toc = (entries: NotebookToc["entries"], color?: string): NotebookToc => ({ format: "onenote-toc", guidFile: "", entries, warnings: [], ...(color ? { color } : {}) });

test("TOC order, colors and section groups from subfolders", () => {
  const out = assembleNotebook(
    [
      file("", "Inbox.one"),
      file("", "Archive.one", true),
      file("", "Zebra.one"),
      file("Projects", "Alpha.one"),
      file("Projects", "Beta.one"),
      file("Projects/2026", "Q4.one"),
      file("OneNote_RecycleBin", "Deleted.one"),
    ],
    [
      {
        dir: "",
        toc: toc(
          [
            { name: "Projects", order: 0 },
            { name: "Inbox.one", order: 1, color: "#ff8800" },
            { name: "Archive.one", order: 2, color: "#00ff00" },
          ],
          "#123456",
        ),
      },
      { dir: "Projects", toc: toc([{ name: "Beta.one", order: 0 }, { name: "2026", order: 1 }, { name: "Alpha.one", order: 2 }]) },
    ],
  );
  assert.deepEqual(out.sections.map((s) => s.name), ["Beta", "Q4", "Alpha", "Inbox", "Archive", "Zebra"]);
  assert.deepEqual(out.groups.map((g) => g.name), ["Projects", "2026"]);
  const [projects, year] = out.groups;
  assert.equal(year!.parentId, projects!.id);
  assert.equal(out.sections.find((s) => s.name === "Q4")!.groupId, year!.id);
  assert.equal(out.sections.find((s) => s.name === "Beta")!.groupId, projects!.id);
  assert.equal(out.sections.find((s) => s.name === "Inbox")!.groupId, undefined);
  // The TOC color applies unless the section file had its own.
  assert.equal(out.sections.find((s) => s.name === "Inbox")!.color, "#ff8800");
  assert.equal(out.sections.find((s) => s.name === "Archive")!.color, "#4f7cac");
  assert.equal(out.color, "#123456");
  assert.ok(!out.sections.some((s) => s.name === "Deleted"));
});

test("without a TOC: backups are matched by base name and sorted alphabetically", () => {
  const out = assembleNotebook([file("", "b (On 2026-10-14).one"), file("", "A (On 2026-10-14).one"), file("Group", "c.one")], []);
  assert.deepEqual(out.sections.map((s) => s.name), ["A (On 2026-10-14)", "b (On 2026-10-14)", "c"]);
  assert.deepEqual(out.groups.map((g) => g.name), ["Group"]);
});
