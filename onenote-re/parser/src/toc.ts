// The notebook table of contents (.onetoc2, [MS-ONE] §2.1.15, §2.2.93–96).
// A notebook folder holds one .onetoc2 plus its .one sections; each section
// group is a subfolder with its own .onetoc2. The TOC gives the order of the
// entries and the notebook's color; it does not say whether an entry is a
// section or a group — that is decided on disk (file vs folder).
import { OneStore, RootRole, egKey, type ExtendedGuid, type ObjectDeclaration, type Revision, type ObjectSpace } from "./onestore.ts";
import { Jcid, Prop, jcidName } from "./schema.ts";
import { formatGuid, utf16le } from "./reader.ts";

export interface TocEntry {
  /** File or folder name, unescaped. A section is "<name>.one"; a group is a folder name. */
  name: string;
  /** NotebookElementOrderingID: smaller comes first. */
  order?: number;
  color?: string;
  /** FileIdentityGuid: the section file's Header.guidFile. */
  guidFile?: string;
}

export interface NotebookToc {
  format: "onenote-toc";
  guidFile: string;
  color?: string;
  /** In display order. */
  entries: TocEntry[];
  warnings: string[];
}

/** NotebookColor: COLORREF with an inverted alpha in the top byte; 0xFFFFFFFF means none. */
function tocColor(v: number | undefined): string | undefined {
  if (v === undefined || v === 0xffffffff || v >>> 24 === 0xff) return undefined;
  return `#${[v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** FolderChildFilename escapes "+" as "^M" and "," as "^J". */
export function unescapeTocName(s: string): string {
  return s.replace(/\^M/g, "+").replace(/\^J/g, ",");
}

interface RawEntry extends TocEntry {
  index: number;
}

/**
 * Later references to a name are authoritative (onenote.rs); then sort by
 * ordering id, keeping file order for ties.
 */
export function orderTocEntries(raw: RawEntry[]): TocEntry[] {
  const byName = new Map<string, RawEntry>();
  for (const e of raw) byName.set(e.name.toLowerCase(), e);
  return [...byName.values()]
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ index: _i, ...e }) => e);
}

export function parseNotebookToc(buf: Uint8Array): NotebookToc {
  return notebookToc(new OneStore(buf));
}

export function notebookToc(store: OneStore): NotebookToc {
  const out: NotebookToc = { format: "onenote-toc", guidFile: store.header.guidFile, entries: [], warnings: store.warnings };
  if (store.header.fileKind !== "toc") out.warnings.push(`file kind is ${store.header.fileKind}, not a .onetoc2`);
  const space: ObjectSpace | undefined = store.rootGosid ? store.objectSpaces.get(egKey(store.rootGosid)) : undefined;
  const rev: Revision | undefined = space && store.currentRevision(space, RootRole.DefaultContent);
  const rootOid = space && rev ? store.rootObject(space, rev, RootRole.DefaultContent) : undefined;
  const root = space && rev && rootOid ? store.findObject(rev, rootOid, space) : undefined;
  if (!space || !rev || !root) {
    out.warnings.push("no root table-of-contents object");
    return out;
  }
  if (root.jcid.raw !== Jcid.PersistablePropertyContainerForTOC) out.warnings.push(`root object is ${jcidName(root.jcid.raw)}`);

  const props = (d: ObjectDeclaration) => {
    const m = new Map((store.propertySet(d)?.properties ?? []).map((p) => [p.id, p]));
    const bytes = (id: number) => {
      const v = m.get(id)?.value;
      return v?.kind === "bytes" ? v.value : undefined;
    };
    const u32 = (id: number) => {
      const b = bytes(id);
      return b && b.length >= 4 ? new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) : undefined;
    };
    const oids = (id: number): ExtendedGuid[] => {
      const v = m.get(id)?.value;
      return v?.kind === "oids" ? v.value.filter((x): x is ExtendedGuid => x !== null) : [];
    };
    return { bytes, u32, oids };
  };

  const rp = props(root);
  out.color = tocColor(rp.u32(Prop.NotebookColor!));
  const raw: RawEntry[] = [];
  const walk = (d: ObjectDeclaration, depth: number) => {
    if (depth > 32) return;
    const p = props(d);
    const name = p.bytes(Prop.FolderChildFilename!);
    if (name) {
      const guid = p.bytes(Prop.FileIdentityGuid!);
      raw.push({
        index: raw.length,
        name: unescapeTocName(utf16le(name)),
        order: p.u32(Prop.NotebookElementOrderingID!),
        color: tocColor(p.u32(Prop.NotebookColor!)),
        guidFile: guid && guid.length === 16 ? formatGuid(guid) : undefined,
      });
      return;
    }
    for (const o of p.oids(Prop.TOCEntryIndex_OidIndex!)) {
      const child = store.findObject(rev, o, space);
      if (child) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  out.entries = orderTocEntries(raw).map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as unknown as TocEntry);
  return out;
}

