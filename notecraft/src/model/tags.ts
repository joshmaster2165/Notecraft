// OneNote's default tag catalog, in its menu order. Labels come from the tag
// names in OneNote for Mac's en.lproj strings; ⌘1–⌘9 match OneNote's Ctrl+1–9
// and ⌘0 removes all tags. Checkable tags behave like To Do (ActionItemStatus).
import type { NoteTag } from "./types.ts";

export type TagShape =
  | "checkbox" | "star" | "question" | "highlight" | "person" | "house" | "phone" | "globe" | "bulb" | "key"
  | "alert" | "letter" | "film" | "book" | "music" | "doc" | "pen" | "envelope" | "calendar";

export interface TagDef {
  id: string;
  label: string;
  shape: TagShape;
  color: string;
  /** Has a checkbox that can be ticked off. */
  check?: boolean;
  /** Highlight-type tags color the paragraph instead of showing an icon. */
  highlight?: string;
  /** Small text drawn on the icon (priority number, project letter, person). */
  badge?: string;
  /** ⌘ + digit. */
  shortcut?: number;
}

export const TAGS: TagDef[] = [
  { id: "todo", label: "To Do", shape: "checkbox", color: "#3a6db0", check: true, shortcut: 1 },
  { id: "important", label: "Important", shape: "star", color: "#e3a008", shortcut: 2 },
  { id: "question", label: "Question", shape: "question", color: "#7a4fbf", shortcut: 3 },
  { id: "remember", label: "Remember for later", shape: "highlight", color: "#c9a400", highlight: "#fff3a3", shortcut: 4 },
  { id: "definition", label: "Definition", shape: "highlight", color: "#3a9a3a", highlight: "#c8f2c0", shortcut: 5 },
  { id: "highlight", label: "Highlight", shape: "highlight", color: "#d08a00", highlight: "#ffe08a", shortcut: 6 },
  { id: "contact", label: "Contact", shape: "person", color: "#3a6db0", shortcut: 7 },
  { id: "address", label: "Address", shape: "house", color: "#3a6db0", shortcut: 8 },
  { id: "phone", label: "Phone number", shape: "phone", color: "#3a6db0", shortcut: 9 },
  { id: "website", label: "Web site to visit", shape: "globe", color: "#2b7bb9" },
  { id: "idea", label: "Idea", shape: "bulb", color: "#e3a008" },
  { id: "password", label: "Password", shape: "key", color: "#b8860b" },
  { id: "critical", label: "Critical", shape: "alert", color: "#c2272d" },
  { id: "projectA", label: "Project A", shape: "letter", color: "#c2272d", badge: "A" },
  { id: "projectB", label: "Project B", shape: "letter", color: "#e07b00", badge: "B" },
  { id: "movie", label: "Movie to see", shape: "film", color: "#555b66" },
  { id: "book", label: "Book to read", shape: "book", color: "#7a4a1d" },
  { id: "music", label: "Music to listen to", shape: "music", color: "#7a4fbf" },
  { id: "source", label: "Source for article", shape: "doc", color: "#3a6db0" },
  { id: "blog", label: "Remember for blog", shape: "pen", color: "#c2272d" },
  { id: "discussA", label: "Discuss with Person A", shape: "checkbox", color: "#c2272d", check: true, badge: "A" },
  { id: "discussB", label: "Discuss with Person B", shape: "checkbox", color: "#2b7bb9", check: true, badge: "B" },
  { id: "manager", label: "Discuss with manager", shape: "checkbox", color: "#3a9a3a", check: true, badge: "M" },
  { id: "email", label: "Send in email", shape: "envelope", color: "#2b7bb9" },
  { id: "meeting", label: "Schedule meeting", shape: "calendar", color: "#3a6db0", check: true },
  { id: "callback", label: "Call back", shape: "phone", color: "#3a9a3a", check: true },
  { id: "priority1", label: "To Do priority 1", shape: "checkbox", color: "#c2272d", check: true, badge: "1" },
  { id: "priority2", label: "To Do priority 2", shape: "checkbox", color: "#e3a008", check: true, badge: "2" },
  { id: "client", label: "Client request", shape: "checkbox", color: "#7a4fbf", check: true, badge: "C" },
];

const BY_ID = new Map(TAGS.map((t) => [t.id, t]));
const BY_LABEL = new Map(TAGS.map((t) => [t.label.toLowerCase(), t]));

export function tagDefById(id: string): TagDef | undefined {
  return BY_ID.get(id);
}

export function tagDef(tag: NoteTag): TagDef {
  return BY_ID.get(tag.kind) ?? { id: "custom", label: tag.label ?? "Tag", shape: "letter", color: "#6b6f80", badge: (tag.label ?? "•").slice(0, 1).toUpperCase() };
}

export function tagLabel(tag: NoteTag): string {
  return BY_ID.get(tag.kind)?.label ?? tag.label ?? "Tag";
}

/** Map an imported OneNote tag label (NoteTagLabel) onto the catalog. */
export function tagFromLabel(label: string | undefined, done?: boolean): NoteTag {
  const key = (label ?? "").toLowerCase().replace(/<[^>]*>/g, (m) => m.toLowerCase());
  const def = BY_LABEL.get(key) ?? (key.startsWith("discuss with") ? BY_ID.get(key.includes("manager") ? "manager" : "discussA") : undefined);
  if (def) return { kind: def.id, ...(def.check ? { done: !!done } : {}) };
  return { kind: "custom", ...(label ? { label } : {}), ...(done !== undefined ? { done } : {}) };
}

export function tagByShortcut(digit: number): TagDef | undefined {
  return TAGS.find((t) => t.shortcut === digit);
}

/** Background for highlight-type tags on a paragraph, if any. */
export function tagHighlight(tags: NoteTag[] | undefined): string | undefined {
  for (const t of tags ?? []) {
    const h = BY_ID.get(t.kind)?.highlight;
    if (h) return h;
  }
  return undefined;
}
