//! The [MS-ONE] vocabulary the writer uses: JCIDs (object types) and full
//! 32-bit PropertyIDs, whose top bits carry the storage type
//! ([MS-ONESTORE] §2.6.6) the encoder must honour.
//!
//! Names and values are [MS-ONE] §2.1.12/§2.1.13. Ink follows onenote.rs and
//! `onenote-re/docs/file-format.md` §13. The picture crop and printout IDs come
//! from OneNote for Mac's property-name table and code (file-format.md §11.6,
//! §15): the live `ImageCropped*` family (0x12F5–0x12F8), not the unreferenced
//! `Deprecated_ImageCropped*` one.

/// JCIDs ([MS-ONE] §2.2, [MS-ONESTORE] §2.6.14). Bit 0x20000 marks a property
/// set, 0x40000 a graph node, 0x80000 file data, 0x100000 read-only.
pub mod jcid {
    pub const AUTHOR: u32 = 0x0012_0001;
    pub const SECTION_NODE: u32 = 0x0006_0007;
    pub const PAGE_SERIES_NODE: u32 = 0x0006_0008;
    pub const PAGE_NODE: u32 = 0x0006_000b;
    pub const OUTLINE_NODE: u32 = 0x0006_000c;
    pub const OUTLINE_ELEMENT_NODE: u32 = 0x0006_000d;
    pub const RICH_TEXT_OE_NODE: u32 = 0x0006_000e;
    pub const IMAGE_NODE: u32 = 0x0006_0011;
    pub const NUMBER_LIST_NODE: u32 = 0x0006_0012;
    pub const INK_CONTAINER: u32 = 0x0006_0014;
    pub const TABLE_NODE: u32 = 0x0006_0022;
    pub const TABLE_ROW_NODE: u32 = 0x0006_0023;
    pub const TABLE_CELL_NODE: u32 = 0x0006_0024;
    pub const TITLE_NODE: u32 = 0x0006_002c;
    pub const PAGE_META_DATA: u32 = 0x0002_0030;
    pub const SECTION_META_DATA: u32 = 0x0002_0031;
    pub const EMBEDDED_FILE_NODE: u32 = 0x0006_0035;
    pub const EMBEDDED_FILE_CONTAINER: u32 = 0x0008_0036;
    pub const PAGE_MANIFEST_NODE: u32 = 0x0006_0037;
    pub const PICTURE_CONTAINER14: u32 = 0x0008_0039;
    pub const INK_DATA_NODE: u32 = 0x0002_003b;
    pub const NOTE_TAG_SHARED_DEFINITION_CONTAINER: u32 = 0x0012_0043;
    pub const REVISION_META_DATA: u32 = 0x0002_0044;
    pub const INK_STROKE_NODE: u32 = 0x0002_0047;
    pub const STROKE_PROPERTIES_NODE: u32 = 0x0012_0048;
    pub const PARAGRAPH_STYLE_OBJECT: u32 = 0x0012_004d;

    pub const IS_READ_ONLY: u32 = 0x0010_0000;
}

/// Full PropertyIDs: `id | type << 26` ([MS-ONESTORE] §2.6.6).
pub mod prop {
    pub const LAYOUT_TIGHT_LAYOUT: u32 = 0x0800_1c00;
    pub const PAGE_WIDTH: u32 = 0x1400_1c01;
    pub const PAGE_HEIGHT: u32 = 0x1400_1c02;
    pub const OUTLINE_ELEMENT_CHILD_LEVEL: u32 = 0x0c00_1c03;
    pub const BOLD: u32 = 0x0800_1c04;
    pub const ITALIC: u32 = 0x0800_1c05;
    pub const UNDERLINE: u32 = 0x0800_1c06;
    pub const STRIKETHROUGH: u32 = 0x0800_1c07;
    pub const SUPERSCRIPT: u32 = 0x0800_1c08;
    pub const SUBSCRIPT: u32 = 0x0800_1c09;
    pub const FONT: u32 = 0x1c00_1c0a;
    pub const FONT_SIZE: u32 = 0x1000_1c0b;
    pub const FONT_COLOR: u32 = 0x1400_1c0c;
    pub const HIGHLIGHT: u32 = 0x1400_1c0d;
    pub const RG_OUTLINE_INDENT_DISTANCE: u32 = 0x1c00_1c12;
    pub const OFFSET_FROM_PARENT_HORIZ: u32 = 0x1400_1c14;
    pub const OFFSET_FROM_PARENT_VERT: u32 = 0x1400_1c15;
    pub const NUMBER_LIST_FORMAT: u32 = 0x1c00_1c1a;
    pub const LAYOUT_MAX_WIDTH: u32 = 0x1400_1c1b;
    pub const LAYOUT_MAX_HEIGHT: u32 = 0x1400_1c1c;
    pub const CONTENT_CHILD_NODES: u32 = 0x2400_1c1f;
    pub const ELEMENT_CHILD_NODES: u32 = 0x2400_1c20;
    pub const RICH_EDIT_TEXT_UNICODE: u32 = 0x1c00_1c22;
    pub const LIST_NODES: u32 = 0x2400_1c26;
    pub const NOTEBOOK_MANAGEMENT_ENTITY_GUID: u32 = 0x1c00_1c30;
    pub const LANGUAGE_ID: u32 = 0x1400_1c3b;
    pub const LAYOUT_ALIGNMENT_IN_PARENT: u32 = 0x1400_1c3e;
    pub const PICTURE_CONTAINER: u32 = 0x2000_1c3f;
    pub const PAGE_MARGIN_TOP: u32 = 0x1400_1c4c;
    pub const PAGE_MARGIN_BOTTOM: u32 = 0x1400_1c4d;
    pub const PAGE_MARGIN_LEFT: u32 = 0x1400_1c4e;
    pub const PAGE_MARGIN_RIGHT: u32 = 0x1400_1c4f;
    pub const LIST_FONT: u32 = 0x1c00_1c52;
    pub const TOPOLOGY_CREATION_TIME_STAMP: u32 = 0x1800_1c65;
    pub const LAYOUT_ALIGNMENT_SELF: u32 = 0x1400_1c84;
    pub const IS_TITLE_TIME: u32 = 0x0800_1c87;
    pub const IS_BOILER_TEXT: u32 = 0x0800_1c88;
    pub const PORTRAIT_PAGE: u32 = 0x0800_1c8e;
    pub const ENFORCE_OUTLINE_STRUCTURE: u32 = 0x0800_1c91;
    pub const EDIT_ROOT_RTL: u32 = 0x0800_1c92;
    pub const CANNOT_BE_SELECTED: u32 = 0x0800_1cb2;
    pub const IS_TITLE_TEXT: u32 = 0x0800_1cb4;
    pub const IS_TITLE_DATE: u32 = 0x0800_1cb5;
    pub const LIST_RESTART: u32 = 0x1400_1cb7;
    pub const IS_LAYOUT_SIZE_SET_BY_USER: u32 = 0x0800_1cbd;
    pub const NOTEBOOK_COLOR: u32 = 0x1400_1cbe;
    pub const LAYOUT_RESOLVE_CHILD_COLLISIONS: u32 = 0x0800_1cdc;
    pub const IS_READ_ONLY: u32 = 0x0800_1cde;
    pub const LAYOUT_MINIMUM_OUTLINE_WIDTH: u32 = 0x1400_1cec;
    pub const LAYOUT_COLLISION_PRIORITY: u32 = 0x1400_1cf1;
    pub const CACHED_TITLE_STRING: u32 = 0x1c00_1cf3;
    pub const DESCENDANTS_CANNOT_BE_MOVED: u32 = 0x0800_1cf9;
    pub const RICH_EDIT_TEXT_LANG_ID: u32 = 0x1000_1cfe;
    pub const LAYOUT_TIGHT_ALIGNMENT: u32 = 0x0800_1cff;
    pub const CHARSET: u32 = 0x0c00_1d01;
    pub const CREATION_TIME_STAMP: u32 = 0x1400_1d09;
    pub const DELETABLE: u32 = 0x0800_1d0c;
    pub const PAGE_MARGIN_ORIGIN_X: u32 = 0x1400_1d0f;
    pub const PAGE_MARGIN_ORIGIN_Y: u32 = 0x1400_1d10;
    pub const ROW_COUNT: u32 = 0x1400_1d57;
    pub const COLUMN_COUNT: u32 = 0x1400_1d58;
    pub const TABLE_BORDERS_VISIBLE: u32 = 0x0800_1d5e;
    pub const STRUCTURE_ELEMENT_CHILD_NODES: u32 = 0x2400_1d5f;
    pub const CHILD_GRAPH_SPACE_ELEMENT_NODES: u32 = 0x2c00_1d63;
    pub const TABLE_COLUMN_WIDTHS: u32 = 0x1c00_1d66;
    pub const AUTHOR: u32 = 0x1c00_1d75;
    pub const LAST_MODIFIED_TIME_STAMP: u32 = 0x1800_1d77;
    pub const AUTHOR_ORIGINAL: u32 = 0x2000_1d78;
    pub const AUTHOR_MOST_RECENT: u32 = 0x2000_1d79;
    pub const LAST_MODIFIED_TIME: u32 = 0x1400_1d7a;
    pub const TABLE_COLUMNS_LOCKED: u32 = 0x1c00_1d7d;
    pub const SCHEMA_REVISION_IN_ORDER_TO_READ: u32 = 0x1400_1d82;
    /// `IsPrintoutPage`: the picture is one page of a File Printout.
    pub const IS_PRINTOUT_PAGE: u32 = 0x0800_1d85;
    /// `OriginalPageNumber`: the printed file's page (1-based) a printout picture shows.
    pub const ORIGINAL_PAGE_NUMBER: u32 = 0x1400_1df9;
    pub const EMBEDDED_FILE_CONTAINER: u32 = 0x2000_1d9b;
    pub const EMBEDDED_FILE_NAME: u32 = 0x1c00_1d9c;
    pub const IMAGE_FILENAME: u32 = 0x1c00_1dd7;
    pub const PAGE_LEVEL: u32 = 0x1400_1dff;
    pub const TEXT_RUN_INDEX: u32 = 0x1c00_1e12;
    pub const TEXT_RUN_FORMATTING: u32 = 0x2400_1e13;
    pub const HYPERLINK: u32 = 0x0800_1e14;
    pub const HIDDEN: u32 = 0x0800_1e16;
    pub const HYPERLINK_PROTECTED: u32 = 0x0800_1e19;
    pub const CELL_SHADING_COLOR: u32 = 0x1400_1e26;
    pub const IMAGE_ALT_TEXT: u32 = 0x1c00_1e58;
    pub const MATH_FORMATTING: u32 = 0x0800_3401;
    pub const INK_STROKE_PROPERTIES: u32 = 0x2000_3409;
    pub const INK_DIMENSIONS: u32 = 0x1c00_340a;
    pub const INK_PATH: u32 = 0x1c00_340b;
    pub const INK_HEIGHT: u32 = 0x1400_340c;
    pub const INK_WIDTH: u32 = 0x1400_340d;
    pub const INK_COLOR: u32 = 0x1400_340f;
    pub const INK_PEN_TIP_SHAPE: u32 = 0x0c00_3412;
    pub const INK_RASTER_OPERATION: u32 = 0x0c00_3413;
    pub const INK_DATA: u32 = 0x2000_3415;
    pub const INK_STROKES: u32 = 0x2400_3416;
    pub const INK_BOUNDING_BOX: u32 = 0x1c00_3418;
    pub const INK_BIAS: u32 = 0x0c00_341c;
    pub const PARAGRAPH_STYLE: u32 = 0x2000_342c;
    pub const PARAGRAPH_SPACE_BEFORE: u32 = 0x1400_342e;
    pub const PARAGRAPH_SPACE_AFTER: u32 = 0x1400_342f;
    pub const PARAGRAPH_LINE_SPACING_EXACT: u32 = 0x1400_3430;
    pub const META_DATA_OBJECTS_ABOVE_GRAPH_SPACE: u32 = 0x2400_3442;
    pub const PARAGRAPH_STYLE_ID: u32 = 0x1c00_345a;
    pub const ACTION_ITEM_TYPE: u32 = 0x1000_3463;
    pub const NOTE_TAG_SHAPE: u32 = 0x1000_3464;
    pub const NOTE_TAG_HIGHLIGHT_COLOR: u32 = 0x1400_3465;
    pub const NOTE_TAG_TEXT_COLOR: u32 = 0x1400_3466;
    pub const NOTE_TAG_PROPERTY_STATUS: u32 = 0x1400_3467;
    pub const NOTE_TAG_LABEL: u32 = 0x1c00_3468;
    pub const NOTE_TAG_CREATED: u32 = 0x1400_346e;
    pub const NOTE_TAG_COMPLETED: u32 = 0x1400_346f;
    pub const ACTION_ITEM_STATUS: u32 = 0x1000_3470;
    pub const ACTION_ITEM_SCHEMA_VERSION: u32 = 0x0c00_3473;
    pub const PARAGRAPH_ALIGNMENT: u32 = 0x0c00_3477;
    pub const NOTE_TAG_DEFINITION_OID: u32 = 0x2000_3488;
    pub const NOTE_TAG_STATES: u32 = 0x4000_3489;
    /// The element PropertyID of a NoteTagStates array, as OneNote writes it.
    pub const NOTE_TAG_STATE: u32 = 0x4400_0811;
    pub const SCHEMA_REVISION_IN_ORDER_TO_WRITE: u32 = 0x1400_348b;
    pub const SECTION_DISPLAY_NAME: u32 = 0x1c00_349b;
    pub const PICTURE_WIDTH: u32 = 0x1400_34cd;
    pub const PICTURE_HEIGHT: u32 = 0x1400_34ce;
    /// `ImageCroppedWidthPercentage`: despite the name, a float32 fraction (0–1)
    /// of the uncropped picture, like the three below.
    pub const IMAGE_CROPPED_WIDTH: u32 = 0x1400_12f5;
    pub const IMAGE_CROPPED_HEIGHT: u32 = 0x1400_12f6;
    pub const IMAGE_CROPPED_TOP_LEFT_X: u32 = 0x1400_12f7;
    pub const IMAGE_CROPPED_TOP_LEFT_Y: u32 = 0x1400_12f8;
}

/// `SchemaRevisionInOrderToRead` / `…ToWrite` ([MS-ONE] §2.3.69, §2.3.97).
pub const SCHEMA_REVISION: u32 = 0x28;

/// LCID for en-US: the language of text, pictures and list numbers.
pub const LCID_EN_US: u32 = 1033;

/// `COLORREF` "automatic" ([MS-ONE] §2.2.8).
pub const COLOR_AUTO: u32 = 0xff00_0000;

/// The salt XORed with a page's object space id to name its PageMetaData
/// copy in the section ([MS-ONE] §2.2.81).
pub const METADATA_SALT: &str = "{22A8C031-3600-42EE-B714-D7ACDA2435E8}";

/// Ink packet dimensions ([MS-ISF] GUID_X / GUID_Y).
pub const INK_DIMENSION_X: &str = "{598A6A8F-52C0-4BA0-93AF-AF357411A561}";
pub const INK_DIMENSION_Y: &str = "{B53F9F75-04E0-4498-A7EE-C30DBB5A9011}";
