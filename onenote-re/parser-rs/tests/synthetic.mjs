// Seeded generator of synthetic revision-store files (.one sections and
// .onetoc2 tables of contents) for the differential test. It writes every
// structure the parsers read: header, transaction log, FileNodeList fragments
// (64- and legacy 32-bit, chained, terminated, with uncommitted tails), object
// spaces, revisions with dependencies and contexts, 2007- and 2010-style
// declarations and global id tables, property sets with every value type, and
// file data store objects. Content covers every converter path: pages with
// metadata and versions, outlines, rich text with runs/hyperlinks/styles, lists,
// note tags, tables, images and attachments with bytes, ink, unknown objects.
//
// Values are random and often hostile (NaN, odd byte counts, lone surrogates,
// out-of-range run offsets...): the output is only meant to be read, by both
// parsers, identically.

import { Prop } from "../../parser/src/schema.ts";

// --- randomness -----------------------------------------------------------------

export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const rng = {
    next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    pick: (a) => a[Math.floor(next() * a.length)],
    bytes: (n) => Uint8Array.from({ length: n }, () => Math.floor(next() * 256)),
  };
  return rng;
}

// --- primitives -----------------------------------------------------------------

class Bytes {
  constructor() {
    this.a = [];
  }
  u8(v) {
    this.a.push(v & 0xff);
    return this;
  }
  u16(v) {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v) {
    v >>>= 0;
    return this.u8(v).u8(v >>> 8).u8(v >>> 16).u8(v >>> 24);
  }
  u64(v) {
    v = BigInt.asUintN(64, BigInt(v));
    for (let i = 0n; i < 8n; i++) this.u8(Number((v >> (8n * i)) & 0xffn));
    return this;
  }
  f32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    return this.raw(b);
  }
  raw(b) {
    for (const x of b) this.a.push(x);
    return this;
  }
  eg(e) {
    return this.raw(e.guid).u32(e.n);
  }
  get length() {
    return this.a.length;
  }
  done() {
    return Uint8Array.from(this.a);
  }
}

const hex2 = (x) => x.toString(16).padStart(2, "0");
export function guidString(b) {
  const h = (i) => hex2(b[i]);
  return `{${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}}`.toUpperCase();
}
function guidBytes(s) {
  const h = s.replace(/[{}-]/g, "");
  const b = Uint8Array.from({ length: 16 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
  return Uint8Array.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.subarray(8)]);
}
const NIL = { guid: new Uint8Array(16), n: 0 };
const egKey = (e) => `${guidString(e.guid)}#${e.n}`;

function utf16(s, { bom = false, nul = false, odd = false } = {}) {
  const b = new Bytes();
  if (bom) b.u16(0xfeff);
  for (let i = 0; i < s.length; i++) b.u16(s.charCodeAt(i));
  if (nul) b.u16(0);
  if (odd) b.u8(0x41);
  return b.done();
}

// --- property values ------------------------------------------------------------

// Each value: { id (low 26 bits), type, ... }. Builders:
const V = {
  none: (id) => ({ id, type: 0x1 }),
  bool: (id, v) => ({ id, type: 0x2, v }),
  u8: (id, v) => ({ id, type: 0x3, bytes: new Bytes().u8(v).done() }),
  u16: (id, v) => ({ id, type: 0x4, bytes: new Bytes().u16(v).done() }),
  u32: (id, v) => ({ id, type: 0x5, bytes: new Bytes().u32(v).done() }),
  f32: (id, v) => ({ id, type: 0x5, bytes: new Bytes().f32(v).done() }),
  u64: (id, v) => ({ id, type: 0x6, bytes: new Bytes().u64(v).done() }),
  bytes: (id, bytes) => ({ id, type: 0x7, bytes }),
  str: (id, s, o) => ({ id, type: 0x7, bytes: utf16(s, o) }),
  oid: (id, e) => ({ id, type: 0x8, ids: [e] }),
  oids: (id, es) => ({ id, type: 0x9, ids: es }),
  osid: (id, e) => ({ id, type: 0xa, ids: [e] }),
  osids: (id, es) => ({ id, type: 0xb, ids: es }),
  ctx: (id, e) => ({ id, type: 0xc, ids: [e] }),
  ctxs: (id, es) => ({ id, type: 0xd, ids: es }),
  sets: (id, sets, innerType = 0x11) => ({ id, type: 0x10, sets, innerType }),
  set: (id, props) => ({ id, type: 0x11, props }),
};
const UNRESOLVED = { unresolved: true };

// --- store builder ----------------------------------------------------------------

const MAGIC = 0xa4567ab1f5f7f4c4n;
const FOOTER = 0x8bc215c38233ba4bn;
const MAGIC32 = 0x6d814fd0a242b102n;
const FOOTER32 = 0x45a9ba65a7954cc2n;
const GUID_ONE = "{7B5C52E4-D88C-4DA7-AEB1-5378D02996D3}";
const GUID_TOC = "{43FF2FA1-EFD9-4C76-9EE2-10EA5722765F}";
const GUID_FORMAT = "{109ADD3F-911B-49F5-A5D0-1791EDC8AED8}";
const FDSO_HEADER = "{BDE316E7-2665-4511-A4C4-8D4D0B7A9EAC}";
const FDSO_FOOTER = "{71FBA722-0F79-4A0B-BB13-899256426B24}";

export class StoreBuilder {
  constructor(rng, kind) {
    this.rng = rng;
    this.kind = kind;
    this.out = new Bytes().raw(new Uint8Array(1024));
    this.spaces = [];
    this.fileData = [];
    this.nextListId = 0x10;
    this.txCounts = [];
  }

  eg() {
    return { guid: this.rng.bytes(16), n: this.rng.int(4) };
  }

  /** Append a chunk, 8-byte aligned; returns its reference. */
  chunk(bytes) {
    while (this.out.length % 8) this.out.u8(0);
    const stp = this.out.length;
    this.out.raw(bytes);
    return { stp, cb: bytes.length };
  }

  space(opts = {}) {
    const s = { gosid: this.eg(), revisions: [], roleDecls: [], encrypted: !!opts.encrypted };
    this.spaces.push(s);
    return s;
  }

  revision(space, { role = 1, context = null, dependent = null } = {}) {
    const r = { rid: this.eg(), dependent, role, context, objects: [], roots: [], redeclare: [] };
    space.revisions.push(r);
    return r;
  }

  object(rev, jcid, props, oid) {
    const o = { oid: oid ?? this.eg(), jcid, props };
    rev.objects.push(o);
    return o.oid;
  }

  fileObject(rev, jcid, reference, extension) {
    const o = { oid: this.eg(), jcid, file: { reference, extension } };
    rev.objects.push(o);
    return o.oid;
  }

  addFileData(bytes) {
    const guid = guidString(this.rng.bytes(16));
    this.fileData.push({ guid, bytes });
    return guid;
  }

  // FileNode: header u32, optional 12-byte reference, body.
  node(id, body = new Uint8Array(0), ref = null, baseType = ref ? 1 : 0) {
    const size = 4 + (ref ? 12 : 0) + body.length;
    const b = new Bytes().u32(id | (size << 10) | (0 << 23) | (0 << 25) | (baseType << 27));
    if (ref) b.u64(ref.stp).u32(ref.cb);
    return b.raw(body).done();
  }

  /** Write a FileNodeList (maybe split, legacy, terminated, with an uncommitted tail). */
  list(nodes, extra = []) {
    const rng = this.rng;
    const listId = this.nextListId++;
    const all = [...nodes];
    if (extra.length && rng.chance(0.5)) {
      this.txCounts.push([listId, nodes.length]);
      all.push(...extra);
    }
    const split = all.length > 2 && rng.chance(0.3) ? 1 + rng.int(all.length - 1) : all.length;
    const parts = [all.slice(0, split), all.slice(split)].filter((p, i) => i === 0 || p.length);
    let next = { stp: 0, cb: 0 };
    for (let seq = parts.length - 1; seq >= 0; seq--) {
      const legacy = rng.chance(0.15);
      const b = new Bytes().u64(legacy ? MAGIC32 : MAGIC).u32(listId).u32(seq);
      for (const n of parts[seq]) b.raw(n);
      if (rng.chance(0.2)) b.raw(this.node(0x0ff)).raw(this.node(0x01c)); // terminator, then ignored garbage
      else if (rng.chance(0.2)) b.u32(0).u32(0); // zero padding
      if (legacy) b.u32(next.stp).u32(next.cb).u64(FOOTER32);
      else b.u64(next.stp).u32(next.cb).u64(FOOTER);
      next = this.chunk(b.done());
    }
    return next;
  }

  /** Encode a property set blob for an object; `table` maps guid string -> index. */
  propSet(props, table) {
    const streams = { oid: [], osid: [], ctx: [] };
    const body = new Bytes();
    const compact = (e) => {
      if (e === null || e === UNRESOLVED) return 0xfffff << 8;
      if (e.n === 0 && e.guid.every((x) => x === 0)) return 0;
      const index = table.get(guidString(e.guid));
      return (e.n & 0xff) | (index << 8);
    };
    const encodeSet = (ps) => {
      body.u16(ps.length);
      for (const p of ps) body.u32((p.id & 0x3ffffff) | (p.type << 26) | (p.type === 0x2 && p.v ? 0x80000000 : 0));
      for (const p of ps) encodeValue(p);
    };
    const encodeValue = (p) => {
      switch (p.type) {
        case 0x3:
        case 0x4:
        case 0x5:
        case 0x6:
          body.raw(p.bytes);
          break;
        case 0x7:
          body.u32(p.bytes.length).raw(p.bytes);
          break;
        case 0x8:
          streams.oid.push(p.ids[0]);
          break;
        case 0x9:
          body.u32(p.ids.length);
          streams.oid.push(...p.ids);
          break;
        case 0xa:
          streams.osid.push(p.ids[0]);
          break;
        case 0xb:
          body.u32(p.ids.length);
          streams.osid.push(...p.ids);
          break;
        case 0xc:
          streams.ctx.push(p.ids[0]);
          break;
        case 0xd:
          body.u32(p.ids.length);
          streams.ctx.push(...p.ids);
          break;
        case 0x10:
          body.u32(p.sets.length);
          if (p.sets.length) body.u32((p.innerType << 26) | (p.id & 0xffff));
          for (const s of p.sets) {
            if (p.innerType === 0x11) encodeSet(s);
            else if (p.innerType === 0x2) body.u8(s ? 1 : 0);
            else encodeValue({ ...s, type: p.innerType });
          }
          break;
        case 0x11:
          encodeSet(p.props);
          break;
      }
    };
    encodeSet(props);
    const b = new Bytes();
    const hasSide = streams.osid.length || streams.ctx.length || this.rng.chance(0.3);
    b.u32(streams.oid.length | (hasSide ? 0 : 0x80000000));
    for (const e of streams.oid) b.u32(compact(e));
    if (hasSide) {
      b.u32(streams.osid.length | (streams.ctx.length ? 0x40000000 : 0));
      for (const e of streams.osid) b.u32(compact(e));
      if (streams.ctx.length) {
        b.u32(streams.ctx.length);
        for (const e of streams.ctx) b.u32(compact(e));
      }
    }
    return b.raw(body.done()).done();
  }

  /** Every ExtendedGuid an object refers to, to put in a global id table. */
  static refs(o) {
    const out = [o.oid];
    const walk = (ps) => {
      for (const p of ps ?? []) {
        if (p.ids) out.push(...p.ids.filter((e) => e && e !== UNRESOLVED));
        if (p.sets && p.innerType === 0x11) p.sets.forEach(walk);
        if (p.props) walk(p.props);
      }
    };
    walk(o.props);
    return out;
  }

  declare(o, table) {
    const rng = this.rng;
    const oidCompact = (o.oid.n & 0xff) | (table.get(guidString(o.oid.guid)) << 8);
    if (o.file) {
      const id = rng.chance(0.5) ? 0x072 : 0x073;
      const b = new Bytes().u32(oidCompact).u32(o.jcid);
      if (id === 0x072) b.u8(1);
      else b.u32(1);
      const ref = utf16(o.file.reference);
      const ext = utf16(o.file.extension);
      b.u32(ref.length / 2).raw(ref).u32(ext.length / 2).raw(ext);
      return this.node(id, b.done());
    }
    const blob = this.chunk(this.propSet(o.props, table));
    const kind = rng.int(4);
    const id = [0x0a4, 0x0a5, 0x0c4, 0x0c5][kind];
    const b = new Bytes().u32(oidCompact).u32(o.jcid).u8(rng.int(4));
    if (id === 0x0a4 || id === 0x0c4) b.u8(1);
    else b.u32(1);
    if (id === 0x0c4 || id === 0x0c5) b.raw(rng.bytes(16));
    return this.node(id, b.done(), blob);
  }

  writeRevisionNodes(space, rev, revTables) {
    const rng = this.rng;
    const nodes = [];
    const start7 = rev.context || rng.chance(0.3);
    const body = new Bytes().eg(rev.rid).eg(rev.dependent ?? NIL).u32(rev.role).u16(0);
    if (start7) body.eg(rev.context ?? NIL);
    nodes.push(this.node(start7 ? 0x01f : 0x01e, body.done()));

    // Every GUID the revision's objects use.
    const guids = [];
    for (const o of rev.objects) for (const e of StoreBuilder.refs(o)) guids.push(guidString(e.guid));
    const unique = [...new Set(guids)];

    // Revision-level (2007-style) table, sometimes, so object groups can map from it.
    const revLevel = rng.chance(0.4);
    const revTable = new Map();
    if (revLevel) {
      nodes.push(this.node(rng.chance(0.5) ? 0x021 : 0x022));
      unique.forEach((g, i) => revTable.set(g, i + 1));
      for (const [g, i] of revTable) nodes.push(this.node(0x024, new Bytes().u32(i).raw(guidBytes(g)).done()));
      nodes.push(this.node(0x028));
    }
    revTables.set(egKey(rev.rid), revTable);

    // Some objects declared 2007-style straight in the manifest (jcid index only).
    const inManifest = revLevel ? rev.objects.filter((o) => !o.file && (o.jcid & 0xfffffc00) === 0x20000 && rng.chance(0.5)) : [];
    for (const o of inManifest) {
      const blob = this.chunk(this.propSet(o.props, revTable));
      const id = rng.chance(0.5) ? 0x02d : 0x02e;
      const b = new Bytes().u32((o.oid.n & 0xff) | (revTable.get(guidString(o.oid.guid)) << 8)).u16(o.jcid & 0x3ff).u32(0);
      if (id === 0x02d) b.u8(1);
      else b.u32(1);
      nodes.push(this.node(id, b.done(), blob));
    }

    // Object group: its own table, built directly or mapped from the revision's.
    const groupObjects = rev.objects.filter((o) => !inManifest.includes(o));
    if (groupObjects.length || rev.redeclare.length) {
      const g = [];
      const groupId = this.eg();
      g.push(this.node(0x0b4, new Bytes().eg(groupId).done()));
      g.push(this.node(0x022));
      const table = new Map();
      unique.forEach((x, i) => table.set(x, 100 + i));
      const mode = revLevel ? rng.int(3) : 0;
      if (mode === 0) {
        for (const [x, i] of table) g.push(this.node(0x024, new Bytes().u32(i).raw(guidBytes(x)).done()));
      } else if (mode === 1) {
        for (const [x, i] of table) g.push(this.node(0x025, new Bytes().u32(revTable.get(x)).u32(i).done()));
      } else {
        // GlobalIdTableEntry3: copy the whole revision table in one range.
        g.push(this.node(0x026, new Bytes().u32(1).u32(unique.length).u32(100).done()));
      }
      g.push(this.node(0x028));
      for (const o of groupObjects) g.push(this.declare(o, table));
      for (const o of rev.redeclare) {
        // ObjectRevisionWithRefCount: new data for an object from the dependency chain.
        for (const e of StoreBuilder.refs(o)) if (!table.has(guidString(e.guid))) table.set(guidString(e.guid), 100 + table.size);
        for (const [x, i] of table) if (i >= 100 + unique.length) g.push(this.node(0x024, new Bytes().u32(i).raw(guidBytes(x)).done()));
        const blob = this.chunk(this.propSet(o.props, table));
        const oid = (o.oid.n & 0xff) | (table.get(guidString(o.oid.guid)) << 8);
        if (rng.chance(0.5)) g.push(this.node(0x041, new Bytes().u32(oid).u8(1 << 2).done(), blob));
        else g.push(this.node(0x042, new Bytes().u32(oid).u32(0).u32(1).done(), blob));
      }
      g.push(this.node(0x0b8));
      const ref = this.list(g, [this.node(0x0b8)]);
      nodes.push(this.node(0x0b0, new Bytes().eg(groupId).done(), ref, 2));
    }

    for (const [role, oid] of rev.roots) {
      if (revLevel && rng.chance(0.5) && revTable.has(guidString(oid.guid))) {
        nodes.push(this.node(0x059, new Bytes().u32((oid.n & 0xff) | (revTable.get(guidString(oid.guid)) << 8)).u32(role).done()));
      } else {
        nodes.push(this.node(0x05a, new Bytes().eg(oid).u32(role).done()));
      }
    }
    if (space.encrypted) nodes.push(this.node(0x07c, new Uint8Array(0), this.chunk(this.rng.bytes(32))));
    nodes.push(this.node(0x01c));
    return nodes;
  }

  build() {
    const rng = this.rng;
    const rootNodes = [];
    // File data store.
    if (this.fileData.length) {
      const fds = [];
      for (const { guid, bytes } of this.fileData) {
        const b = new Bytes()
          .raw(guidBytes(rng.chance(0.03) ? guidString(rng.bytes(16)) : FDSO_HEADER))
          .u64(bytes.length)
          .u32(0)
          .u64(0)
          .raw(bytes);
        while (b.length % 8) b.u8(0);
        b.raw(guidBytes(rng.chance(0.03) ? guidString(rng.bytes(16)) : FDSO_FOOTER));
        fds.push(this.node(0x094, guidBytes(guid), this.chunk(b.done())));
      }
      rootNodes.push(this.node(0x090, new Uint8Array(0), this.list(fds), 2));
    }
    for (const s of this.spaces) {
      const revTables = new Map();
      const revNodes = [this.node(0x014, new Bytes().eg(s.gosid).u32(0).done())];
      for (const r of s.revisions) revNodes.push(...this.writeRevisionNodes(s, r, revTables));
      for (const d of s.roleDecls) {
        const b = new Bytes().eg(d.rid).u32(d.role);
        if (d.context) b.eg(d.context);
        revNodes.push(this.node(d.context ? 0x05d : 0x05c, b.done()));
      }
      const revList = this.list(revNodes, [this.node(0x05a, new Bytes().eg(this.eg()).u32(1).done())]);
      const osList = this.list([this.node(0x00c, new Bytes().eg(s.gosid).done()), this.node(0x010, new Uint8Array(0), revList, 2)]);
      rootNodes.push(this.node(0x008, new Bytes().eg(s.gosid).done(), osList, 2));
    }
    if (this.spaces.length) rootNodes.unshift(this.node(0x004, new Bytes().eg(this.spaces[0].gosid).done()));
    const root = this.list(rootNodes);

    // Transaction log: committed node counts for lists with uncommitted tails.
    let log = { stp: 0, cb: 0 };
    let cTransactions = 0;
    if (this.txCounts.length) {
      const b = new Bytes();
      for (const [id, count] of this.txCounts) b.u32(id).u32(count);
      b.u32(1).u32(0);
      b.u64(0).u32(0);
      log = this.chunk(b.done());
      cTransactions = 1;
    }

    const h = new Bytes()
      .raw(guidBytes(this.kind === "toc" ? GUID_TOC : GUID_ONE))
      .raw(rng.bytes(16))
      .raw(new Uint8Array(16))
      .raw(guidBytes(GUID_FORMAT))
      .u32(0x2a)
      .u32(0x2a)
      .u32(0x2b)
      .u32(0x2a)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(cTransactions)
      .u32(0)
      .u64(0)
      .u32(0)
      .u32(0)
      .u32(0)
      .u32(0)
      .raw(new Uint8Array(16))
      .u32(0)
      .u64(0)
      .u32(0)
      .u64(log.stp)
      .u32(log.cb)
      .u64(root.stp)
      .u32(root.cb)
      .u64(0)
      .u32(0)
      .u64(this.out.length)
      .u64(0)
      .raw(rng.bytes(16))
      .u64(1)
      .raw(new Uint8Array(16))
      .u32(0)
      .u64(0)
      .u32(0)
      .u64(0)
      .u32(0)
      .u32(1)
      .u32(2)
      .u32(3)
      .u32(4)
      .done();
    const out = this.out.done();
    out.set(h, 0);
    return out;
  }
}

// --- content ----------------------------------------------------------------------

const P = Prop;
const J = {
  TOC: 0x00020001,
  SectionNode: 0x00060007,
  PageSeriesNode: 0x00060008,
  PageNode: 0x0006000b,
  OutlineNode: 0x0006000c,
  OutlineElementNode: 0x0006000d,
  RichTextOENode: 0x0006000e,
  ImageNode: 0x00060011,
  NumberListNode: 0x00060012,
  OutlineGroup: 0x00060019,
  TableNode: 0x00060022,
  TableRowNode: 0x00060023,
  TableCellNode: 0x00060024,
  TitleNode: 0x0006002c,
  PageMetaData: 0x00020030,
  SectionMetaData: 0x00020031,
  EmbeddedFileContainer: 0x00080036,
  EmbeddedFileNode: 0x00060035,
  PageManifestNode: 0x00060037,
  PictureContainer14: 0x00080039,
  VersionHistoryContent: 0x0006003c,
  VersionProxy: 0x0006003d,
  NoteTagSharedDefinitionContainer: 0x00120043,
  ParagraphStyleObject: 0x0012004d,
  Author: 0x00120001,
  InkContainer: 0x00060014,
  InkDataNode: 0x0002003b,
  InkStrokeNode: 0x00020047,
  StrokePropertiesNode: 0x00120048,
  MathNode: 0x00060050,
};

const WORDS = ["alpha", "Beta", "γάμμα", "дельта", "εψιλον", "שלום", "مرحبا", "日本語", "😀", "a\u0301", "\t", " ", "x"];

function text(rng, n = 1 + rng.int(6)) {
  let s = "";
  for (let i = 0; i < n; i++) s += (i ? " " : "") + rng.pick(WORDS);
  if (rng.chance(0.05)) s += "\ud800"; // lone surrogate (decodes to U+FFFD)
  if (rng.chance(0.05)) s = "\ufeff" + s; // BOM
  if (rng.chance(0.05)) s = " \u3000" + s + "\u00a0\n";
  return s;
}

const strOpts = (rng) => ({ nul: rng.chance(0.3), bom: rng.chance(0.05), odd: rng.chance(0.03) });

function float(rng) {
  const r = rng.next();
  if (r < 0.03) return NaN;
  if (r < 0.05) return Infinity;
  if (r < 0.07) return -0;
  if (r < 0.1) return 1e30;
  if (r < 0.15) return 0.005 + rng.int(3) * 0.01; // rounding boundaries
  return (rng.next() - 0.2) * 40;
}

function color(rng) {
  const r = rng.next();
  if (r < 0.1) return 0xffffffff;
  if (r < 0.15) return 0xff000000 | rng.int(0xffffff);
  return rng.int(0x1000000);
}

const time32 = (rng) => (rng.chance(0.1) ? 0 : 1_200_000_000 + rng.int(300_000_000));
const fileTime = (rng) => (rng.chance(0.05) ? 0n : 130_000_000_000_000_000n + BigInt(rng.int(2 ** 31)) * 10_000_000n);

function maybe(rng, p, f) {
  return rng.chance(p) ? [f()] : [];
}

function layout(rng) {
  return [
    ...maybe(rng, 0.8, () => V.f32(P.OffsetFromParentHoriz, float(rng))),
    ...maybe(rng, 0.8, () => V.f32(P.OffsetFromParentVert, float(rng))),
    ...maybe(rng, 0.6, () => V.f32(P.LayoutMaxWidth, float(rng))),
    ...maybe(rng, 0.4, () => V.f32(P.LayoutMaxHeight, float(rng))),
  ];
}

function styleProps(rng) {
  return [
    ...maybe(rng, 0.5, () => V.str(P.Font, rng.pick(["Calibri", "Arial", "Symbol", ""]), strOpts(rng))),
    ...maybe(rng, 0.5, () => (rng.chance(0.7) ? V.u16(P.FontSize, rng.int(80)) : V.u32(P.FontSize, rng.int(80)))),
    ...maybe(rng, 0.3, () => V.u32(P.FontColor, color(rng))),
    ...maybe(rng, 0.2, () => V.u32(P.Highlight, color(rng))),
    ...["Bold", "Italic", "Underline", "Strikethrough", "Superscript", "Subscript", "Hidden", "MathFormatting"].flatMap((n) =>
      maybe(rng, 0.15, () => V.bool(P[n], rng.chance(0.7))),
    ),
    ...maybe(rng, 0.3, () => (rng.chance(0.8) ? V.u16(P.LanguageID, rng.int(0x10000)) : V.u8(P.LanguageID, rng.int(256)))),
    ...maybe(rng, 0.2, () => V.str(P.ParagraphStyleId, rng.pick(["p", "h1", "h2", "code"]))),
    ...maybe(rng, 0.2, () => V.bool(P.Hyperlink, rng.chance(0.8))),
  ];
}

class Section {
  constructor(rng, b) {
    this.rng = rng;
    this.b = b;
  }

  /** A rich text object with runs, hyperlink field codes and styles. */
  richText(rev, tagDefs) {
    const { rng, b } = this;
    let s = "";
    const ends = [];
    const nRuns = 1 + rng.int(4);
    for (let i = 0; i < nRuns; i++) {
      if (rng.chance(0.25)) s += `\ufddfHYPERLINK "${rng.pick(["https://example.com/", "mailto:x@example.com", "onenote:#p", ""])}${rng.chance(0.1) ? "" : '"'}`;
      s += text(rng, 1 + rng.int(3));
      ends.push(rng.chance(0.1) ? rng.int(s.length + 5) : s.length);
    }
    if (rng.chance(0.1)) ends.reverse();
    const runIndex = new Bytes();
    for (const e of ends) runIndex.u32(e);
    const styles = ends.slice(0, rng.chance(0.2) ? rng.int(ends.length) : ends.length).map(() =>
      rng.chance(0.05) ? UNRESOLVED : b.object(rev, J.ParagraphStyleObject, styleProps(rng)),
    );
    const props = [];
    if (rng.chance(0.9)) props.push(V.str(P.RichEditTextUnicode, s, { nul: rng.chance(0.5) }));
    if (rng.chance(0.15)) props.push(V.bytes(P.TextExtendedAscii, Uint8Array.from({ length: 1 + rng.int(20) }, () => rng.int(256))));
    if (rng.chance(0.9)) props.push(V.bytes(P.TextRunIndex, runIndex.done()));
    props.push(V.oids(P.TextRunFormatting, styles));
    if (rng.chance(0.6)) props.push(V.oid(P.ParagraphStyle, b.object(rev, J.ParagraphStyleObject, [...styleProps(rng), ...maybe(rng, 0.3, () => V.u8(P.ParagraphAlignment, rng.int(4))), ...maybe(rng, 0.3, () => V.f32(P.ParagraphSpaceBefore, float(rng)))])));
    if (rng.chance(0.3)) props.push(V.u8(P.ParagraphAlignment, rng.int(4)));
    for (const n of ["ParagraphSpaceBefore", "ParagraphSpaceAfter", "ParagraphLineSpacingExact"]) if (rng.chance(0.2)) props.push(V.f32(P[n], float(rng)));
    if (rng.chance(0.1)) props.push(V.bool(P.ReadingOrderRTL, rng.chance(0.5)));
    if (rng.chance(0.3)) props.push(this.noteTags(tagDefs));
    return b.object(rev, J.RichTextOENode, props);
  }

  noteTags(tagDefs) {
    const { rng } = this;
    return V.sets(
      P.NoteTagStates,
      Array.from({ length: 1 + rng.int(2) }, () => [
        ...maybe(rng, 0.9, () => V.oid(P.NoteTagDefinitionOid, rng.chance(0.1) ? NIL : rng.pick(tagDefs))),
        ...maybe(rng, 0.6, () => V.u16(P.ActionItemStatus, rng.int(4))),
        ...maybe(rng, 0.5, () => V.u32(P.NoteTagCreated, time32(rng))),
        ...maybe(rng, 0.3, () => V.u32(P.NoteTagCompleted, time32(rng))),
      ]),
    );
  }

  fileContainer(rev, jcid) {
    const { rng, b } = this;
    const r = rng.next();
    const ext = rng.pick([".png", ".pdf", "", "bin", ".JPG"]);
    if (r < 0.55) {
      const sigs = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x42, 0x4d], [0x25, 0x50, 0x44, 0x46], [0x50, 0x4b, 0x03, 0x04], [0x49, 0x49, 0x2a, 0x00], [0xd7, 0xcd, 0xc6, 0x9a], [1, 2, 3]];
      const bytes = Uint8Array.from([...rng.pick(sigs), ...rng.bytes(rng.int(64))]);
      if (bytes.length >= 10 && rng.chance(0.1)) bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45], 0);
      if (bytes.length >= 42 && rng.chance(0.1)) bytes.set([1, 0, 0, 0], 0), bytes.set([0x20, 0x45], 40);
      const guid = b.addFileData(bytes);
      const ref = `<ifndf>${rng.chance(0.3) ? guid.toLowerCase() : guid}`;
      return b.fileObject(rev, jcid, ref, ext);
    }
    if (r < 0.8) return b.fileObject(rev, jcid, "<invfdo>", ext);
    if (r < 0.9) return b.fileObject(rev, jcid, "<file>sidecar.bin", ext);
    return b.fileObject(rev, jcid, rng.chance(0.5) ? "" : "<ifndf>{not-a-guid}", ext);
  }

  image(rev) {
    const { rng, b } = this;
    return b.object(rev, J.ImageNode, [
      ...layout(rng),
      ...maybe(rng, 0.9, () => V.oids(P.PictureContainer, [this.fileContainer(rev, J.PictureContainer14)])),
      ...maybe(rng, 0.5, () => V.f32(P.PictureWidth, float(rng))),
      ...maybe(rng, 0.5, () => V.f32(P.PictureHeight, float(rng))),
      ...maybe(rng, 0.6, () => V.bytes(P.UnverifiedHash, rng.bytes(rng.chance(0.9) ? 20 : 16))),
      ...maybe(rng, 0.3, () => V.str(P.ImageAltText, text(rng), strOpts(rng))),
      ...maybe(rng, 0.3, () => V.str(P.ImageFilename, "image.png")),
      ...maybe(rng, 0.2, () => V.str(P.WzHyperlinkUrl, "https://example.com/img")),
      ...maybe(rng, 0.2, () => V.bool(P.IsBackground, rng.chance(0.5))),
      ...maybe(rng, 0.3, () => V.str(P.RichEditTextUnicode, rng.chance(0.3) ? "" : text(rng))),
    ]);
  }

  embeddedFile(rev) {
    const { rng, b } = this;
    return b.object(rev, J.EmbeddedFileNode, [
      ...layout(rng),
      ...maybe(rng, 0.9, () => V.oids(P.EmbeddedFileContainer, [this.fileContainer(rev, J.EmbeddedFileContainer)])),
      ...maybe(rng, 0.7, () => V.str(P.EmbeddedFileName, "report.pdf", strOpts(rng))),
      ...maybe(rng, 0.5, () => V.str(P.SourceFilepath, "C:\\files\\report.pdf")),
      ...maybe(rng, 0.3, () => V.bytes(P.UnverifiedHash, rng.bytes(20))),
    ]);
  }

  inkPath(n, dims) {
    const { rng } = this;
    const values = [];
    for (let d = 0; d < dims * n; d++) values.push(rng.chance(0.02) ? 2 ** (40 + rng.int(25)) : Math.round((rng.next() - 0.5) * 4000));
    const bytes = [];
    const put = (v) => {
      do {
        let byte = v % 128;
        v = Math.floor(v / 128);
        if (v > 0) byte |= 0x80;
        bytes.push(byte);
      } while (v > 0);
    };
    put(values.length * 2);
    for (const v of values) put(Math.abs(v) * 2 + (v < 0 ? 1 : 0));
    if (rng.chance(0.1)) bytes.length = rng.int(bytes.length); // truncated
    return Uint8Array.from(bytes);
  }

  ink(rev, depth = 0) {
    const { rng, b } = this;
    const X = "{598A6A8F-52C0-4BA0-93AF-AF357411A561}";
    const Y = "{B53F9F75-04E0-4498-A7EE-C30DBB5A9011}";
    const Z = "{7307502D-F9F4-4E18-B3F2-2CE1B1A3610C}";
    const strokes = Array.from({ length: rng.int(4) }, () => {
      const dimList = rng.pick([[X, Y], [Y, X, Z], [X, Y, Z], [Z], []]);
      const dims = new Bytes();
      for (const g of dimList) dims.raw(guidBytes(g)).raw(new Uint8Array(16));
      const sp = b.object(rev, J.StrokePropertiesNode, [
        ...maybe(rng, 0.9, () => V.bytes(P.InkDimensions, dims.done())),
        ...maybe(rng, 0.8, () => V.f32(P.InkWidth, rng.chance(0.05) ? NaN : rng.next() * 100)),
        ...maybe(rng, 0.8, () => V.f32(P.InkHeight, rng.next() * 100)),
        ...maybe(rng, 0.7, () => V.u32(P.InkColor, color(rng))),
        ...maybe(rng, 0.4, () => V.u8(P.InkStrokeTransparency, rng.pick([0, 32, 64, 128, 255]))),
        ...maybe(rng, 0.3, () => V.u8(P.InkRasterOperation, rng.pick([9, 13]))),
        ...maybe(rng, 0.3, () => V.u8(P.InkPenTipShape, rng.int(2))),
      ]);
      return b.object(rev, J.InkStrokeNode, [
        ...maybe(rng, 0.95, () => V.bytes(P.InkPath, this.inkPath(1 + rng.int(6), Math.max(2, dimList.length)))),
        ...maybe(rng, 0.9, () => V.oids(P.InkStrokeProperties, [sp])),
        ...maybe(rng, 0.5, () => V.u8(P.InkBias, rng.int(4))),
      ]);
    });
    const box = new Bytes();
    for (let i = 0; i < 4; i++) box.u32((rng.next() - 0.3) * 20000);
    const dataProps = [
      ...maybe(rng, 0.7, () => V.bytes(P.InkBoundingBox, box.done())),
      V.oids(P.InkStrokes, strokes),
    ];
    const inline = rng.chance(0.2);
    const data = inline ? null : b.object(rev, J.InkDataNode, dataProps);
    const children = depth < 2 && rng.chance(0.3) ? [this.ink(rev, depth + 1)] : [];
    return b.object(rev, rng.chance(0.85) ? J.InkContainer : J.MathNode, [
      ...layout(rng),
      ...maybe(rng, 0.5, () => V.f32(P.InkScalingX, rng.chance(0.05) ? NaN : 0.5 + rng.next())),
      ...maybe(rng, 0.5, () => V.f32(P.InkScalingY, 0.5 + rng.next())),
      ...(inline ? dataProps : [V.oids(P.InkData, [data])]),
      ...maybe(rng, children.length ? 1 : 0, () => V.oids(P.ContentChildNodes, children)),
    ]);
  }

  unknown(rev) {
    const { rng, b } = this;
    const props = [
      V.none(0x1234),
      V.bool(0x1c04, true),
      V.u8(0x2001, rng.int(256)),
      V.u16(0x2002, rng.int(65536)),
      V.f32(0x2003, float(rng)),
      V.u32(0x2004, rng.pick([0, 50_000_000, 7, 0x3f800000])),
      V.u64(0x2005, fileTime(rng)),
      V.bytes(0x2006, rng.bytes(rng.int(100))),
      V.str(P.Author, text(rng)),
      V.oid(0x2007, rng.chance(0.5) ? UNRESOLVED : b.object(rev, J.ParagraphStyleObject, [])),
      V.oids(0x2008, [UNRESOLVED, NIL]),
      V.osids(0x2009, [b.eg()]),
      V.ctx(0x200a, b.eg()),
      V.set(0x200b, [V.u8(0x2001, 1), V.set(0x200c, [])]),
      V.sets(0x200d, [[V.bool(0x2e, false)], []]),
      V.sets(0x200e, [true, false, true], 0x2),
      V.sets(0x200f, [V.u32(0, 5), V.u32(0, 6)], 0x5),
      V.sets(0x2010, []),
      V.u32(P.PageWidth, 1),
      V.u32(P.PageWidth, 2),
    ].filter(() => rng.chance(0.7));
    return b.object(rev, rng.pick([J.MathNode, 0x00060099, J.TitleNode]), props);
  }

  table(rev, tagDefs, depth) {
    const { rng, b } = this;
    const rows = Array.from({ length: rng.int(3) }, () =>
      b.object(rev, J.TableRowNode, [
        V.oids(
          P.ElementChildNodes,
          Array.from({ length: rng.int(3) }, () =>
            b.object(rev, rng.chance(0.95) ? J.TableCellNode : J.OutlineNode, [
              ...maybe(rng, 0.3, () => V.u32(P.CellShadingColor, color(rng))),
              V.oids(P.ElementChildNodes, this.elements(rev, tagDefs, depth + 1, 2)),
            ]),
          ),
        ),
      ]),
    );
    const widths = new Bytes().u8(rng.int(5));
    for (let i = 0; i < rng.int(5); i++) widths.f32(float(rng));
    return b.object(rev, J.TableNode, [
      ...maybe(rng, 0.8, () => V.u32(P.RowCount, rows.length)),
      ...maybe(rng, 0.8, () => V.u32(P.ColumnCount, rng.int(4))),
      ...maybe(rng, 0.8, () => V.bytes(P.TableColumnWidths, widths.done())),
      ...maybe(rng, 0.6, () => V.bool(P.TableBordersVisible, rng.chance(0.5))),
      V.oids(P.ElementChildNodes, rows),
    ]);
  }

  list(rev) {
    const { rng, b } = this;
    let fmt;
    if (rng.chance(0.5)) fmt = rng.pick(["•", "o", "\uf0a7", "-", ""]);
    else fmt = `${rng.pick(["", "(", "Step "])}\ufffd${String.fromCharCode(rng.int(10))}${rng.pick([".", ")", ""])}`;
    if (rng.chance(0.5)) fmt = String.fromCharCode([...fmt].length) + fmt;
    return b.object(rev, J.NumberListNode, [
      V.str(P.NumberListFormat, fmt, { nul: rng.chance(0.5) }),
      ...maybe(rng, 0.5, () => V.str(P.ListFont, rng.pick(["Symbol", "Wingdings", "Calibri"]))),
      ...maybe(rng, 0.3, () => V.str(P.Font, "Arial")),
      ...maybe(rng, 0.3, () => V.u32(P.ListRestart, rng.int(10))),
    ]);
  }

  element(rev, tagDefs, depth) {
    const { rng, b } = this;
    const content = [];
    for (let i = 0; i < 1 + rng.int(2); i++) {
      const r = rng.next();
      if (r < 0.65) content.push(this.richText(rev, tagDefs));
      else if (r < 0.73) content.push(this.image(rev));
      else if (r < 0.79 && depth < 4) content.push(this.table(rev, tagDefs, depth));
      else if (r < 0.85) content.push(this.embeddedFile(rev));
      else if (r < 0.93) content.push(this.ink(rev));
      else if (r < 0.97) content.push(this.unknown(rev));
      else content.push(rng.chance(0.5) ? NIL : UNRESOLVED);
    }
    return b.object(rev, J.OutlineElementNode, [
      ...maybe(rng, 0.7, () => V.u8(P.OutlineElementChildLevel, rng.int(4))),
      ...maybe(rng, 0.5, () => V.u32(P.CreationTimeStamp, time32(rng))),
      ...maybe(rng, 0.5, () => V.u32(P.LastModifiedTime, time32(rng))),
      V.oids(P.ContentChildNodes, content),
      ...maybe(rng, 0.3, () => V.oids(P.ListNodes, [this.list(rev)])),
      ...maybe(rng, 0.1, () => this.noteTags(tagDefs)),
      ...maybe(rng, depth < 4 ? 0.3 : 0, () => V.oids(P.ElementChildNodes, this.elements(rev, tagDefs, depth + 1, 3))),
    ]);
  }

  elements(rev, tagDefs, depth, max) {
    const { rng, b } = this;
    return Array.from({ length: rng.int(max + 1) }, () =>
      rng.chance(0.15) && depth < 4
        ? b.object(rev, J.OutlineGroup, [V.oids(P.ElementChildNodes, this.elements(rev, tagDefs, depth + 1, 2))])
        : this.element(rev, tagDefs, depth),
    );
  }

  outline(rev, tagDefs, role) {
    const { rng, b } = this;
    return b.object(rev, J.OutlineNode, [
      ...layout(rng),
      ...(role ? [V.bool(P[role], true)] : maybe(rng, 0.1, () => V.bool(P.IsTitleDate, rng.chance(0.5)))),
      V.oids(P.ElementChildNodes, this.elements(rev, tagDefs, 0, 4)),
    ]);
  }

  /** PageManifestNode → PageNode for one revision; returns the manifest oid. */
  pageContent(rev, versionsCtx) {
    const { rng, b } = this;
    const tagDefs = Array.from({ length: 2 }, () =>
      b.object(rev, J.NoteTagSharedDefinitionContainer, [
        ...maybe(rng, 0.9, () => V.str(P.NoteTagLabel, rng.pick(["To Do", "Important", "Question", ""]), strOpts(rng))),
        ...maybe(rng, 0.8, () => V.u16(P.NoteTagShape, rng.int(100))),
        ...maybe(rng, 0.4, () => V.u16(P.ActionItemType, rng.int(100))),
        ...maybe(rng, 0.5, () => V.u32(P.NoteTagHighlightColor, color(rng))),
        ...maybe(rng, 0.5, () => V.u32(P.NoteTagTextColor, color(rng))),
      ]),
    );
    const author = b.object(rev, J.Author, [V.str(P.Author, rng.pick(["A. Author", "B", ""]), strOpts(rng))]);
    const titles = [];
    if (rng.chance(0.8)) {
      titles.push(
        b.object(rev, J.TitleNode, [
          V.oids(P.ElementChildNodes, [this.outline(rev, tagDefs, "IsTitleText"), ...maybe(rng, 0.5, () => this.outline(rev, tagDefs, "IsTitleDate")), ...maybe(rng, 0.2, () => this.image(rev))]),
        ]),
      );
    }
    if (rng.chance(0.1)) titles.push(this.outline(rev, tagDefs)); // not a TitleNode: skipped
    const blocks = [];
    for (let i = 0; i < rng.int(4); i++) {
      const r = rng.next();
      if (r < 0.55) blocks.push(this.outline(rev, tagDefs));
      else if (r < 0.7) blocks.push(this.image(rev));
      else if (r < 0.78) blocks.push(this.embeddedFile(rev));
      else if (r < 0.9) blocks.push(this.ink(rev));
      else if (r < 0.96) blocks.push(this.unknown(rev));
      else blocks.push(UNRESOLVED);
    }
    const page = b.object(rev, J.PageNode, [
      ...maybe(rng, 0.7, () => V.f32(P.PageWidth, float(rng))),
      ...maybe(rng, 0.7, () => V.f32(P.PageHeight, float(rng))),
      ...maybe(rng, 0.2, () => V.str(P.CachedTitleString, rng.chance(0.3) ? "" : text(rng))),
      ...maybe(rng, 0.5, () => V.u32(P.CreationTimeStamp, time32(rng))),
      ...maybe(rng, 0.5, () => V.u32(P.LastModifiedTime, time32(rng))),
      ...maybe(rng, 0.3, () => V.u64(P.LastModifiedTimeStamp, fileTime(rng))),
      ...(rng.chance(0.3) ? [V.str(P.Author, "Direct Author")] : maybe(rng, 0.7, () => V.oid(P.AuthorOriginal, author))),
      V.oids(P.StructureElementChildNodes, titles),
      V.oids(P.ElementChildNodes, blocks),
    ]);
    const manifestChildren = [page];
    if (rng.chance(0.1)) manifestChildren.unshift(b.object(rev, J.TitleNode, []));
    return b.object(rev, J.PageManifestNode, [
      V.oids(P.ContentChildNodes, manifestChildren),
      ...(versionsCtx ? [V.ctxs(P.VersionHistoryGraphSpaceContextNodes, versionsCtx)] : []),
    ]);
  }

  page() {
    const { rng, b } = this;
    const space = b.space({ encrypted: rng.chance(0.05) });
    // Historical versions live in context-tagged revisions of the same space.
    const versionCtxs = rng.chance(0.4) ? Array.from({ length: 1 + rng.int(3) }, () => b.eg()) : [];
    for (const ctx of versionCtxs) {
      const vrev = b.revision(space, { role: 1, context: ctx });
      vrev.roots.push([1, this.pageContent(vrev, null)]);
    }
    let historyCtx = null;
    if (versionCtxs.length) {
      historyCtx = b.eg();
      const hrev = b.revision(space, { role: 1, context: historyCtx });
      const author = b.object(hrev, J.Author, [V.str(P.Author, "Editor")]);
      const proxies = versionCtxs.map((ctx) =>
        b.object(hrev, J.VersionProxy, [
          V.ctxs(P.VersionHistoryGraphSpaceContextNodes, rng.chance(0.2) ? [ctx, ctx] : [ctx]),
          ...maybe(rng, 0.6, () => V.u32(P.CreationTimeStamp, time32(rng))),
          ...maybe(rng, 0.6, () => V.u64(P.LastModifiedTimeStamp, fileTime(rng))),
          ...maybe(rng, 0.6, () => V.oid(P.AuthorMostRecent, author)),
        ]),
      );
      hrev.roots.push([1, b.object(hrev, J.VersionHistoryContent, [V.oids(P.ElementChildNodes, proxies)])]);
    }
    const rev = b.revision(space, { role: 1 });
    const manifest = this.pageContent(rev, historyCtx ? [historyCtx, ...maybe(rng, 0.2, () => b.eg())] : null);
    rev.roots.push([1, manifest]);
    // A dependent revision that inherits everything and re-declares the manifest.
    if (rng.chance(0.3)) {
      const rev2 = b.revision(space, { role: 1, dependent: rev.rid });
      rev2.redeclare.push({ oid: manifest, props: rev.objects.find((o) => o.oid === manifest).props });
      if (rng.chance(0.5)) rev2.roots.push([1, manifest]);
    }
    if (rng.chance(0.6)) {
      const meta = b.revision(space, { role: 2 });
      meta.roots.push([2, b.object(meta, J.PageMetaData, [
        ...maybe(rng, 0.8, () => V.str(P.CachedTitleString, rng.chance(0.2) ? "" : text(rng), strOpts(rng))),
        ...maybe(rng, 0.6, () => V.u8(P.PageLevel, rng.int(4))),
        ...maybe(rng, 0.5, () => V.u64(P.TopologyCreationTimeStamp, fileTime(rng))),
      ])]);
    }
    if (rng.chance(0.1)) space.roleDecls.push({ rid: rev.rid, role: 1, context: null });
    return space.gosid;
  }

  section() {
    const { rng, b } = this;
    const root = b.space();
    const pages = Array.from({ length: 1 + rng.int(3) }, () => this.page());
    if (rng.chance(0.05)) pages.push(b.eg()); // missing page space
    const rev = b.revision(root, { role: 1 });
    const metas = pages.map(() =>
      b.object(rev, J.PageMetaData, [
        ...maybe(rng, 0.7, () => V.str(P.CachedTitleString, text(rng))),
        ...maybe(rng, 0.5, () => V.u16(P.PageLevel, 1 + rng.int(3))),
      ]),
    );
    const series = b.object(rev, J.PageSeriesNode, [
      V.osids(P.ChildGraphSpaceElementNodes, pages),
      V.oids(P.MetaDataObjectsAboveGraphSpace, metas.slice(0, rng.chance(0.2) ? rng.int(metas.length) : metas.length)),
    ]);
    const section = b.object(rev, rng.chance(0.03) ? J.PageSeriesNode : J.SectionNode, [
      ...maybe(rng, 0.7, () => V.str(P.NotebookManagementEntityGuid, guidString(rng.bytes(16)))),
      ...maybe(rng, 0.7, () => V.u64(P.TopologyCreationTimeStamp, fileTime(rng))),
      ...maybe(rng, 0.7, () => V.u32(P.NotebookColor, color(rng))),
      V.oids(P.ElementChildNodes, [series, ...maybe(rng, 0.2, () => UNRESOLVED)]),
    ]);
    rev.roots.push([1, section]);
    if (rng.chance(0.6)) {
      const meta = b.revision(root, { role: 2 });
      meta.roots.push([2, b.object(meta, J.SectionMetaData, [V.str(P.SectionDisplayName, rng.chance(0.2) ? "" : text(rng), strOpts(rng))])]);
    }
  }
}

/** A random .one section. */
export function generateSection(seed) {
  const rng = makeRng(seed);
  const b = new StoreBuilder(rng, "one");
  new Section(rng, b).section();
  return b.build();
}

/** A random .onetoc2 notebook table of contents. */
export function generateToc(seed) {
  const rng = makeRng(seed);
  const b = new StoreBuilder(rng, "toc");
  const space = b.space();
  const rev = b.revision(space, { role: 1 });
  const names = ["Inbox.one", "inbox.one", "Projects", "Q1^M Q2^J notes.one", "Ideas.one", "Σοφία.one", ""];
  const entry = (depth) =>
    depth < 3 && rng.chance(0.2)
      ? b.object(rev, J.TOC, [V.oids(P.TOCEntryIndex_OidIndex, Array.from({ length: rng.int(3) }, () => entry(depth + 1)))])
      : b.object(rev, J.TOC, [
          ...maybe(rng, 0.9, () => V.str(P.FolderChildFilename, rng.pick(names), strOpts(rng))),
          ...maybe(rng, 0.7, () => (rng.chance(0.9) ? V.u32(P.NotebookElementOrderingID, rng.int(5)) : V.u16(P.NotebookElementOrderingID, 1))),
          ...maybe(rng, 0.4, () => V.u32(P.NotebookColor, color(rng))),
          ...maybe(rng, 0.6, () => V.bytes(P.FileIdentityGuid, rng.bytes(rng.chance(0.9) ? 16 : 8))),
        ]);
  const root = b.object(rev, rng.chance(0.95) ? J.TOC : J.SectionNode, [
    ...maybe(rng, 0.7, () => V.u32(P.NotebookColor, color(rng))),
    V.oids(P.TOCEntryIndex_OidIndex, Array.from({ length: rng.int(6) }, () => entry(0))),
  ]);
  if (rng.chance(0.95)) rev.roots.push([1, root]);
  return b.build();
}

/**
 * Stress shapes: a section whose one page holds an unknown object with
 * property sets nested `depth` deep ("props"), or outline elements nested
 * `depth` deep ("outline").
 */
export function generateDeep(kind, depth, seed = 1) {
  const rng = makeRng(seed);
  const b = new StoreBuilder(rng, "one");
  const root = b.space();
  const space = b.space();
  const rev = b.revision(space, { role: 1 });
  let block;
  if (kind === "props") {
    let inner = [V.u8(0x2001, 7)];
    for (let i = 0; i < depth; i++) inner = [i % 2 ? V.set(0x200b, inner) : V.sets(0x200d, [inner])];
    block = b.object(rev, J.MathNode, inner);
  } else {
    let children = [];
    for (let i = 0; i < depth; i++) {
      const text = b.object(rev, J.RichTextOENode, [V.str(P.RichEditTextUnicode, `level ${i}`)]);
      children = [b.object(rev, J.OutlineElementNode, [V.oids(P.ContentChildNodes, [text]), V.oids(P.ElementChildNodes, children)])];
    }
    block = b.object(rev, J.OutlineNode, [V.oids(P.ElementChildNodes, children)]);
  }
  const page = b.object(rev, J.PageNode, [V.oids(P.ElementChildNodes, [block])]);
  rev.roots.push([1, b.object(rev, J.PageManifestNode, [V.oids(P.ContentChildNodes, [page])])]);
  const srev = b.revision(root, { role: 1 });
  const series = b.object(srev, J.PageSeriesNode, [V.osids(P.ChildGraphSpaceElementNodes, [space.gosid])]);
  srev.roots.push([1, b.object(srev, J.SectionNode, [V.oids(P.ElementChildNodes, [series])])]);
  return b.build();
}
