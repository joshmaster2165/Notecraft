// Notecraft's document model. It follows the object graph recovered from
// OneNote for Mac 16.114 (see ../../onenote-re/docs/file-format.md §5, §8),
// simplified where an editor benefits:
//
//   OneNote                                      Notecraft
//   ───────────────────────────────────────────  ─────────────────────────
//   .onetoc2 notebook                            Notebook
//   SectionNode 0x60007 (one .one file)          Section
//   PageSeriesNode 0x60008 + page object spaces  Section.pages (ordered)
//   PageMetaData.PageLevel 0x14001DFF            Page.level (subpages)
//   PageNode 0x6000B ─ TitleNode 0x6002C         Page.title + createdAt line
//   OutlineNode 0x6000C (OffsetFromParent*,      Outline {x, y, width}
//     LayoutMaxWidth, IsLayoutSizeSetByUser)
//   OutlineElementNode 0x6000D, nested via       Element with `depth` (flat list;
//     ElementChildNodes                            children follow their parent)
//   RichTextOENode 0x6000E + TextRunIndex /      ParagraphEl.runs
//     TextRunFormatting (style objects 0x12004D)
//   ParagraphStyleId ("p", "h1"…)               ParagraphEl.style
//   NumberListNode 0x60012 (NumberListFormat)    Element.list
//   NoteTagStates / ActionItemStatus             Element.tag
//   TableNode/RowNode/CellNode 0x60022-24        TableEl
//   ImageNode 0x60011 (+ PictureContainer)       ImageEl (inline) / FloatingImage
//   EmbeddedFileNode 0x60035                     FileEl
//
// All coordinates are OneNote points at zoom 1 (1pt = 1 CSS px), the unit the
// parser emits after converting from half-inches.

export type Id = string;

export interface Library {
  version: 1;
  notebooks: Notebook[];
  /** "Save as Template" pages, offered when adding a page. */
  templates?: PageTemplate[];
  /** Customize Tags: user-defined tags, including ones imported from OneNote. */
  customTags?: CustomTagDef[];
}

export interface CustomTagDef {
  /** "custom:<lowercased label>", so the same tag from different imports merges. */
  id: string;
  label: string;
  shape: "checkbox" | "star" | "question" | "highlight" | "person" | "house" | "phone" | "globe" | "bulb" | "key" | "alert" | "letter" | "film" | "book" | "music" | "doc" | "pen" | "envelope" | "calendar";
  color: string;
  check?: boolean;
  highlight?: string;
}

export interface Notebook {
  id: Id;
  name: string;
  color: string;
  createdAt: string;
  sections: Section[];
  /** Section groups ("New Section Group"); sections point at them with groupId. */
  groups?: SectionGroup[];
  /** "Deleted Notes": deleted pages and sections, restorable for 60 days. */
  trash?: TrashItem[];
}

export interface SectionGroup {
  id: Id;
  name: string;
  /** Groups nest inside other groups. */
  parentId?: Id;
  collapsed?: boolean;
}

export type TrashItem =
  | { kind: "page"; page: Page; sectionId: Id; sectionName: string; deletedAt: string }
  | { kind: "section"; section: Section; deletedAt: string };

export interface PageTemplate {
  id: Id;
  name: string;
  page: Page;
}

export interface Section {
  id: Id;
  name: string;
  color: string;
  createdAt: string;
  pages: Page[];
  groupId?: Id;
  /** Set when the section came from a .one file. */
  source?: { file: string; guidFile?: string; importedAt: string };
  /**
   * Password Protect This Section: the pages, sealed (AES-256-GCM, key from
   * the password). While the section is locked `pages` is empty.
   */
  locked?: { sealed: SealedPages; hint?: string };
}

export interface SealedPages {
  version: number;
  kdf: string;
  iterations: number;
  salt: string;
  nonce: string;
  data: string;
}

export type PageLevel = 1 | 2 | 3;

export interface Page {
  id: Id;
  title: string;
  level: PageLevel;
  createdAt: string;
  modifiedAt: string;
  author?: string;
  outlines: Outline[];
  images: FloatingImage[];
  /** Pen and highlighter strokes (Draw tab; OneNote's InkContainer 0x60047). */
  ink?: InkStroke[];
  /** View > Paper Style: page color and rule/grid lines. */
  paper?: PaperStyle;
  /** View > Hide Page Title. */
  hideTitle?: boolean;
}

export type RuleLines = "none" | "narrow" | "standard" | "college" | "grid-small" | "grid-medium" | "grid-large";

export interface PaperStyle {
  color?: string;
  rule?: RuleLines;
  ruleColor?: string;
}

export interface InkStroke {
  id: Id;
  tool: "pen" | "highlighter";
  color: string;
  /** Points at zoom 1. */
  width: number;
  /** Flat [x0, y0, x1, y1, …] in page points. */
  points: number[];
  /** Drawn with a shape tool or converted by Ink to Shape: straight segments, no smoothing. */
  shape?: boolean;
  /** What Ink to Shape recognized (OneNote's InkShape2DInfo / InkLineShapeInfo). */
  shapeKind?: string;
}

export interface Outline {
  id: Id;
  x: number;
  y: number;
  width: number;
  /** IsLayoutSizeSetByUser: false lets the container shrink-wrap up to `width`. */
  widthSetByUser: boolean;
  elements: Element[];
}

export interface Run {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  sup?: boolean;
  sub?: boolean;
  highlight?: string;
  color?: string;
  font?: string;
  /** Points. */
  size?: number;
  href?: string;
}

export type ParagraphStyle = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote" | "code" | "cite";

/** MSONFC numbering schemes decoded from NumberListFormat. */
export type NumberScheme = "decimal" | "upperRoman" | "lowerRoman" | "upperLetter" | "lowerLetter";

export type ListStyle =
  | { kind: "bullet"; glyph: string }
  | { kind: "numbered"; scheme: NumberScheme; prefix?: string; suffix: string; start?: number };

/** A tag id from the catalog in tags.ts ("todo", "important", "idea", …) or "custom". */
export type TagKind = string;

export interface NoteTag {
  kind: TagKind;
  label?: string;
  done?: boolean;
}

interface ElementBase {
  id: Id;
  /** OutlineElementChildLevel - 1; 0 is the top level of the outline. */
  depth: number;
  list?: ListStyle;
  /** NoteTagStates: a paragraph can carry several tags. */
  tags?: NoteTag[];
}

export type Alignment = "left" | "center" | "right";

export interface ParagraphEl extends ElementBase {
  kind: "text";
  style: ParagraphStyle;
  runs: Run[];
  /** ParagraphAlignment 0x0C003477. */
  align?: Alignment;
  /** ParagraphSpaceBefore / ParagraphSpaceAfter, points. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** ParagraphLineSpacingExact: "line spacing at least", points. */
  lineSpacing?: number;
}

export interface TableCell {
  id: Id;
  shading?: string;
  elements: Element[];
}

export interface TableRow {
  id: Id;
  cells: TableCell[];
}

export interface TableEl extends ElementBase {
  kind: "table";
  /** Column widths in points (TableColumnWidths). */
  columns: number[];
  borders: boolean;
  rows: TableRow[];
}

export interface ImageData {
  /** Data URL, or undefined when the source file did not embed the bytes (<invfdo>). */
  src?: string;
  width: number;
  height: number;
  alt?: string;
  filename?: string;
  /** Text OneNote recognised in the picture. */
  ocrText?: string;
  /**
   * Picture › Crop, in OneNote's terms (ImageCroppedTopLeftX/YPercentage,
   * ImageCroppedWidth/HeightPercentage). `src` holds the cropped pixels;
   * `original` keeps the uncropped picture so the crop can be changed.
   */
  crop?: CropRect;
  original?: { src: string; width: number; height: number };
  /** One page of a File Printout (OneNote's IsPrintoutPage). */
  printout?: { file: string; page: number; pages: number };
}

export interface CropRect {
  topLeftXPercentage: number;
  topLeftYPercentage: number;
  widthPercentage: number;
  heightPercentage: number;
}

export interface ImageEl extends ElementBase {
  kind: "image";
  image: ImageData;
}

export interface FileEl extends ElementBase {
  kind: "file";
  name: string;
  size?: number;
  src?: string;
}

/** Insert › Equation: UnicodeMath linear format, built up to MathML by the Rust engine. */
export interface MathEl extends ElementBase {
  kind: "math";
  linear: string;
}

export type Element = ParagraphEl | TableEl | ImageEl | FileEl | MathEl;

export interface FloatingImage extends ImageData {
  id: Id;
  x: number;
  y: number;
}

/**
 * A saved state of one page. OneNote keeps these as revisions reached through
 * VersionHistoryContent → VersionProxy (file-format.md §8); Notecraft stores
 * them outside the Library so the library record stays small.
 */
export type VersionReason = "before-edit" | "idle" | "leave" | "before-restore" | "import";

export interface PageVersion {
  id: Id;
  pageId: Id;
  /** When this state was current (OneNote: VersionProxy.LastModifiedTimeStamp). */
  at: string;
  author?: string;
  source: "notecraft" | "onenote";
  reason: VersionReason;
  page: Page;
}

/** Where an element list lives: an outline, or a table cell inside one. */
export type ListRef =
  | { pageId: Id; outlineId: Id }
  | { pageId: Id; outlineId: Id; tableId: Id; rowId: Id; cellId: Id };

// Layout constants observed in OneNote's files (parser output, docs §8).
export const LAYOUT = {
  /** Title outline position. */
  titleX: 36,
  titleY: 24,
  /** First body outline in a new OneNote page: x = 54pt (0.75in), y ≈ 90.56pt. */
  bodyX: 54,
  bodyY: 90,
  /** Default LayoutMaxWidth of a new outline. */
  outlineWidth: 520,
  /** Indent per outline level (0.375in). */
  indent: 27,
} as const;
