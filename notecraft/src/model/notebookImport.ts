// Assemble a whole OneNote notebook folder: sections from its .one files,
// section groups from its subfolders, and order and colors from the
// .onetoc2 table of contents in each folder (file-format.md §14).
import type { NotebookToc } from "@re/parser/src/toc.ts";
import type { Section, SectionGroup } from "./types.ts";
import { newId } from "../lib/id.ts";

export interface FolderSection {
  /** Folder of the .one file relative to the notebook folder, "/"-separated; "" for the top. */
  dir: string;
  fileName: string;
  section: Section;
  /** The section file carried its own color (otherwise the TOC's applies). */
  colorFromFile?: boolean;
}

export interface FolderToc {
  dir: string;
  toc: NotebookToc;
}

export interface AssembledNotebook {
  sections: Section[];
  groups: SectionGroup[];
  color?: string;
}

const RECYCLE_BIN = /^OneNote_RecycleBin$/i;
/** Backups are named "Section (On 2026-10-14).one"; the TOC knows them as "Section.one". */
const baseName = (fileName: string) => fileName.replace(/\.one$/i, "").replace(/\s*\(On \d{4}-\d{2}-\d{2}\)$/, "").toLowerCase();

export function assembleNotebook(files: FolderSection[], tocs: FolderToc[]): AssembledNotebook {
  const tocByDir = new Map(tocs.map((t) => [t.dir, t.toc]));
  const live = files.filter((f) => !f.dir.split("/").some((part) => RECYCLE_BIN.test(part)));

  // Every folder that (directly or below) holds a section.
  const dirs = new Set<string>([""]);
  for (const f of live) {
    const parts = f.dir ? f.dir.split("/") : [];
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const childDirs = (dir: string) =>
    [...dirs].filter((d) => d !== dir && (dir ? d.startsWith(dir + "/") : true) && d.slice(dir ? dir.length + 1 : 0).split("/").length === 1 && d !== "");

  const sections: Section[] = [];
  const groups: SectionGroup[] = [];

  const visit = (dir: string, groupId: string | undefined) => {
    const toc = tocByDir.get(dir);
    const here = live.filter((f) => f.dir === dir);
    type Item = { kind: "section"; f: FolderSection; key: string } | { kind: "group"; dir: string; key: string };
    const items: Item[] = [
      ...here.map((f) => ({ kind: "section" as const, f, key: baseName(f.fileName) })),
      ...childDirs(dir).map((d) => ({ kind: "group" as const, dir: d, key: d.split("/").pop()!.toLowerCase() })),
    ];
    // TOC order first (entries name "X.one" for sections, "X" for folders), then the rest by name.
    const rank = new Map<string, number>();
    toc?.entries.forEach((e, i) => rank.set(e.name.replace(/\.one$/i, "").toLowerCase(), i));
    items.sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity) || a.key.localeCompare(b.key));
    for (const item of items) {
      if (item.kind === "section") {
        const s = item.f.section;
        const entry = toc?.entries.find((e) => e.name.replace(/\.one$/i, "").toLowerCase() === item.key);
        // A color stored in the section file wins; the TOC's applies otherwise.
        if (entry?.color && !item.f.colorFromFile) s.color = entry.color;
        if (groupId) s.groupId = groupId;
        else delete s.groupId;
        sections.push(s);
      } else {
        const g: SectionGroup = { id: newId("g"), name: item.dir.split("/").pop()!, ...(groupId ? { parentId: groupId } : {}) };
        groups.push(g);
        visit(item.dir, g.id);
      }
    }
  };
  visit("", undefined);
  const color = tocByDir.get("")?.color;
  return { sections, groups, ...(color ? { color } : {}) };
}

