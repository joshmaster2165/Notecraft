//! OneNote object schema on top of the revision store: JCIDs (object types)
//! and PropertyIDs. Property names are keyed by the low 26 bits of the
//! PropertyID; the top bits only encode the storage type, which the property
//! set already carries.

/// JCIDs of the OneNote object types the converter knows ([MS-ONE] §2.2).
pub mod jcid {
    pub const PERSISTABLE_PROPERTY_CONTAINER_FOR_TOC: u32 = 0x0002_0001;
    pub const PERSISTABLE_PROPERTY_CONTAINER_FOR_TOC_SECTION: u32 = 0x0002_0001;
    pub const SECTION_NODE: u32 = 0x0006_0007;
    pub const PAGE_SERIES_NODE: u32 = 0x0006_0008;
    pub const PAGE_NODE: u32 = 0x0006_000b;
    pub const OUTLINE_NODE: u32 = 0x0006_000c;
    pub const OUTLINE_ELEMENT_NODE: u32 = 0x0006_000d;
    pub const RICH_TEXT_OE_NODE: u32 = 0x0006_000e;
    pub const IMAGE_NODE: u32 = 0x0006_0011;
    pub const NUMBER_LIST_NODE: u32 = 0x0006_0012;
    pub const OUTLINE_GROUP: u32 = 0x0006_0019;
    pub const TABLE_NODE: u32 = 0x0006_0022;
    pub const TABLE_ROW_NODE: u32 = 0x0006_0023;
    pub const TABLE_CELL_NODE: u32 = 0x0006_0024;
    pub const TITLE_NODE: u32 = 0x0006_002c;
    pub const PAGE_META_DATA: u32 = 0x0002_0030;
    pub const SECTION_META_DATA: u32 = 0x0002_0031;
    pub const EMBEDDED_FILE_CONTAINER: u32 = 0x0008_0036;
    pub const EMBEDDED_FILE_NODE: u32 = 0x0006_0035;
    pub const PAGE_MANIFEST_NODE: u32 = 0x0006_0037;
    pub const CONFLICT_PAGE_META_DATA: u32 = 0x0002_0038;
    pub const PICTURE_CONTAINER14: u32 = 0x0008_0039;
    pub const VERSION_HISTORY_CONTENT: u32 = 0x0006_003c;
    pub const VERSION_PROXY: u32 = 0x0006_003d;
    pub const NOTE_TAG_SHARED_DEFINITION_CONTAINER: u32 = 0x0012_0043;
    pub const REVISION_META_DATA: u32 = 0x0002_0044;
    pub const VERSION_HISTORY_META_DATA: u32 = 0x0002_0046;
    pub const PARAGRAPH_STYLE_OBJECT: u32 = 0x0012_004d;
    pub const READ_ONLY_PERSISTABLE_PROPERTY_CONTAINER_FOR_AUTHOR: u32 = 0x0012_0001;
    // Ink is undocumented in [MS-ONE]; these follow onenote.rs (file-format.md §13).
    pub const INK_CONTAINER: u32 = 0x0006_0014;
    pub const INK_DATA_NODE: u32 = 0x0002_003b;
    pub const INK_STROKE_NODE: u32 = 0x0002_0047;
    pub const STROKE_PROPERTIES_NODE: u32 = 0x0012_0048;
    pub const INK_ANALYSIS_CONTAINER: u32 = 0x0002_004f;
    pub const MATH_NODE: u32 = 0x0006_0050;
}

/// Display name of a JCID, or `jcid_0x…` for unknown ones.
pub fn jcid_name(raw: u32) -> String {
    let name = match raw {
        0x0002_0001 => "PersistablePropertyContainerForTOC",
        0x0006_0007 => "SectionNode",
        0x0006_0008 => "PageSeriesNode",
        0x0006_000b => "PageNode",
        0x0006_000c => "OutlineNode",
        0x0006_000d => "OutlineElementNode",
        0x0006_000e => "RichTextOENode",
        0x0006_0011 => "ImageNode",
        0x0006_0012 => "NumberListNode",
        0x0006_0019 => "OutlineGroup",
        0x0006_0022 => "TableNode",
        0x0006_0023 => "TableRowNode",
        0x0006_0024 => "TableCellNode",
        0x0006_002c => "TitleNode",
        0x0002_0030 => "PageMetaData",
        0x0002_0031 => "SectionMetaData",
        0x0008_0036 => "EmbeddedFileContainer",
        0x0006_0035 => "EmbeddedFileNode",
        0x0006_0037 => "PageManifestNode",
        0x0002_0038 => "ConflictPageMetaData",
        0x0008_0039 => "PictureContainer14",
        0x0006_003c => "VersionHistoryContent",
        0x0006_003d => "VersionProxy",
        0x0012_0043 => "NoteTagSharedDefinitionContainer",
        0x0002_0044 => "RevisionMetaData",
        0x0002_0046 => "VersionHistoryMetaData",
        0x0012_004d => "ParagraphStyleObject",
        0x0012_0001 => "ReadOnlyPersistablePropertyContainerForAuthor",
        0x0006_0014 => "InkContainer",
        0x0002_003b => "InkDataNode",
        0x0002_0047 => "InkStrokeNode",
        0x0012_0048 => "StrokePropertiesNode",
        0x0002_004f => "InkAnalysisContainer",
        0x0006_0050 => "MathNode",
        _ => return format!("jcid_0x{raw:x}"),
    };
    name.to_string()
}

macro_rules! properties {
    ($( $(#[$doc:meta])* $konst:ident = $name:literal : $id:literal, )*) => {
        /// PropertyIDs by name, as their low 26 bits (what [`crate::onestore::Property::id`] holds).
        pub mod prop {
            $( $(#[$doc])* pub const $konst: u32 = $id & 0x03ff_ffff; )*
        }
        /// Every known property as (name, full 32-bit PropertyID).
        pub const PROPS: &[(&str, u32)] = &[ $( ($name, $id), )* ];
    };
}

// Full 32-bit PropertyIDs; `prop` indexes them by low 26 bits.
properties! {
    LAYOUT_TIGHT_LAYOUT = "LayoutTightLayout": 0x0800_1c00,
    PAGE_WIDTH = "PageWidth": 0x1400_1c01,
    PAGE_HEIGHT = "PageHeight": 0x1400_1c02,
    OUTLINE_ELEMENT_CHILD_LEVEL = "OutlineElementChildLevel": 0x0c00_1c03,
    BOLD = "Bold": 0x0800_1c04,
    ITALIC = "Italic": 0x0800_1c05,
    UNDERLINE = "Underline": 0x0800_1c06,
    STRIKETHROUGH = "Strikethrough": 0x0800_1c07,
    SUPERSCRIPT = "Superscript": 0x0800_1c08,
    SUBSCRIPT = "Subscript": 0x0800_1c09,
    FONT = "Font": 0x1c00_1c0a,
    FONT_SIZE = "FontSize": 0x1000_1c0b,
    FONT_COLOR = "FontColor": 0x1400_1c0c,
    HIGHLIGHT = "Highlight": 0x1400_1c0d,
    RG_OUTLINE_INDENT_DISTANCE = "RgOutlineIndentDistance": 0x1c00_1c12,
    BODY_TEXT_ALIGNMENT = "BodyTextAlignment": 0x0c00_1c13,
    OFFSET_FROM_PARENT_HORIZ = "OffsetFromParentHoriz": 0x1400_1c14,
    OFFSET_FROM_PARENT_VERT = "OffsetFromParentVert": 0x1400_1c15,
    NUMBER_LIST_FORMAT = "NumberListFormat": 0x1c00_1c1a,
    LAYOUT_MAX_WIDTH = "LayoutMaxWidth": 0x1400_1c1b,
    LAYOUT_MAX_HEIGHT = "LayoutMaxHeight": 0x1400_1c1c,
    CONTENT_CHILD_NODES = "ContentChildNodes": 0x2400_1c1f,
    ELEMENT_CHILD_NODES = "ElementChildNodes": 0x2400_1c20,
    ENABLE_HISTORY = "EnableHistory": 0x0800_1e1e,
    RICH_EDIT_TEXT_UNICODE = "RichEditTextUnicode": 0x1c00_1c22,
    LIST_NODES = "ListNodes": 0x2400_1c26,
    NOTEBOOK_MANAGEMENT_ENTITY_GUID = "NotebookManagementEntityGuid": 0x1c00_1c30,
    OUTLINE_ELEMENT_RTL = "OutlineElementRTL": 0x0800_1c34,
    LANGUAGE_ID = "LanguageID": 0x1400_1c3b,
    LAYOUT_ALIGNMENT_IN_PARENT = "LayoutAlignmentInParent": 0x1400_1c3e,
    PICTURE_CONTAINER = "PictureContainer": 0x2000_1c3f,
    PAGE_MARGIN_TOP = "PageMarginTop": 0x1400_1c4c,
    PAGE_MARGIN_BOTTOM = "PageMarginBottom": 0x1400_1c4d,
    PAGE_MARGIN_LEFT = "PageMarginLeft": 0x1400_1c4e,
    PAGE_MARGIN_RIGHT = "PageMarginRight": 0x1400_1c4f,
    LIST_FONT = "ListFont": 0x1c00_1c52,
    TOPOLOGY_CREATION_TIME_STAMP = "TopologyCreationTimeStamp": 0x1800_1c65,
    LAYOUT_ALIGNMENT_SELF = "LayoutAlignmentSelf": 0x1400_1c84,
    IS_TITLE_TIME = "IsTitleTime": 0x0800_1c87,
    IS_BOILER_TEXT = "IsBoilerText": 0x0800_1c88,
    PAGE_SIZE = "PageSize": 0x1400_1c8b,
    PORTRAIT_PAGE = "PortraitPage": 0x0800_1c8e,
    ENFORCE_OUTLINE_STRUCTURE = "EnforceOutlineStructure": 0x0800_1c91,
    EDIT_ROOT_RTL = "EditRootRTL": 0x0800_1c92,
    CANNOT_BE_SELECTED = "CannotBeSelected": 0x0800_1cb2,
    IS_TITLE_TEXT = "IsTitleText": 0x0800_1cb4,
    IS_TITLE_DATE = "IsTitleDate": 0x0800_1cb5,
    LIST_RESTART = "ListRestart": 0x1400_1cb7,
    IS_LAYOUT_SIZE_SET_BY_USER = "IsLayoutSizeSetByUser": 0x0800_1cbd,
    NOTEBOOK_COLOR = "NotebookColor": 0x1400_1cbe,
    LIST_SPACING_MU = "ListSpacingMu": 0x1400_1ccb,
    LAYOUT_OUTLINE_RESERVED_WIDTH = "LayoutOutlineReservedWidth": 0x1400_1cdb,
    LAYOUT_RESOLVE_CHILD_COLLISIONS = "LayoutResolveChildCollisions": 0x0800_1cdc,
    IS_READ_ONLY = "IsReadOnly": 0x0800_1cde,
    LAYOUT_MINIMUM_OUTLINE_WIDTH = "LayoutMinimumOutlineWidth": 0x1400_1cec,
    LAYOUT_COLLISION_PRIORITY = "LayoutCollisionPriority": 0x1400_1cf1,
    CACHED_TITLE_STRING = "CachedTitleString": 0x1c00_1cf3,
    DESCENDANTS_CANNOT_BE_MOVED = "DescendantsCannotBeMoved": 0x0800_1cf9,
    RICH_EDIT_TEXT_LANG_ID = "RichEditTextLangID": 0x1000_1cfe,
    LAYOUT_TIGHT_ALIGNMENT = "LayoutTightAlignment": 0x0800_1cff,
    CHARSET = "Charset": 0x0c00_1d01,
    CREATION_TIME_STAMP = "CreationTimeStamp": 0x1400_1d09,
    DELETABLE = "Deletable": 0x0800_1d0c,
    LIST_MSAA_INDEX = "ListMSAAIndex": 0x1000_1d0e,
    PAGE_MARGIN_ORIGIN_X = "PageMarginOriginX": 0x1400_1d0f,
    PAGE_MARGIN_ORIGIN_Y = "PageMarginOriginY": 0x1400_1d10,
    IS_BACKGROUND = "IsBackground": 0x0800_1d13,
    I_RECORD_MEDIA = "IRecordMedia": 0x1400_1d24,
    CACHED_TITLE_STRING_FROM_PAGE = "CachedTitleStringFromPage": 0x1c00_1d3c,
    ROW_COUNT = "RowCount": 0x1400_1d57,
    COLUMN_COUNT = "ColumnCount": 0x1400_1d58,
    TABLE_BORDERS_VISIBLE = "TableBordersVisible": 0x0800_1d5e,
    STRUCTURE_ELEMENT_CHILD_NODES = "StructureElementChildNodes": 0x2400_1d5f,
    CHILD_GRAPH_SPACE_ELEMENT_NODES = "ChildGraphSpaceElementNodes": 0x2c00_1d63,
    TABLE_COLUMN_WIDTHS = "TableColumnWidths": 0x1c00_1d66,
    AUTHOR = "Author": 0x1c00_1d75,
    LAST_MODIFIED_TIME_STAMP = "LastModifiedTimeStamp": 0x1800_1d77,
    AUTHOR_ORIGINAL = "AuthorOriginal": 0x2000_1d78,
    AUTHOR_MOST_RECENT = "AuthorMostRecent": 0x2000_1d79,
    LAST_MODIFIED_TIME = "LastModifiedTime": 0x1400_1d7a,
    IS_CONFLICT_PAGE = "IsConflictPage": 0x0800_1d7c,
    TABLE_COLUMNS_LOCKED = "TableColumnsLocked": 0x1c00_1d7d,
    SCHEMA_REVISION_IN_ORDER_TO_READ = "SchemaRevisionInOrderToRead": 0x1400_1d82,
    IS_CONFLICT_OBJECT_FOR_RENDER = "IsConflictObjectForRender": 0x0800_1d96,
    EMBEDDED_FILE_CONTAINER = "EmbeddedFileContainer": 0x2000_1d9b,
    EMBEDDED_FILE_NAME = "EmbeddedFileName": 0x1c00_1d9c,
    SOURCE_FILEPATH = "SourceFilepath": 0x1c00_1d9d,
    CONFLICTING_USER_NAME = "ConflictingUserName": 0x1c00_1d9e,
    IMAGE_FILENAME = "ImageFilename": 0x1c00_1dd7,
    IS_CONFLICT_OBJECT_FOR_SELECTION = "IsConflictObjectForSelection": 0x0800_1ddb,
    PAGE_LEVEL = "PageLevel": 0x1400_1dff,
    TEXT_RUN_INDEX = "TextRunIndex": 0x1c00_1e12,
    TEXT_RUN_FORMATTING = "TextRunFormatting": 0x2400_1e13,
    HYPERLINK = "Hyperlink": 0x0800_1e14,
    UNDERLINE_TYPE = "UnderlineType": 0x0c00_1e15,
    HIDDEN = "Hidden": 0x0800_1e16,
    HYPERLINK_PROTECTED = "HyperlinkProtected": 0x0800_1e19,
    WZ_HYPERLINK_URL = "WzHyperlinkUrl": 0x1c00_1e20,
    TEXT_RUN_IS_EMBEDDED_OBJECT = "TextRunIsEmbeddedObject": 0x0800_1e22,
    CELL_SHADING_COLOR = "CellShadingColor": 0x1400_1e26,
    IMAGE_ALT_TEXT = "ImageAltText": 0x1c00_1e58,
    MATH_FORMATTING = "MathFormatting": 0x0800_3401,
    PARAGRAPH_STYLE = "ParagraphStyle": 0x2000_342c,
    PARAGRAPH_SPACE_BEFORE = "ParagraphSpaceBefore": 0x1400_342e,
    PARAGRAPH_SPACE_AFTER = "ParagraphSpaceAfter": 0x1400_342f,
    PARAGRAPH_LINE_SPACING_EXACT = "ParagraphLineSpacingExact": 0x1400_3430,
    META_DATA_OBJECTS_ABOVE_GRAPH_SPACE = "MetaDataObjectsAboveGraphSpace": 0x2400_3442,
    TEXT_RUN_DATA_OBJECT = "TextRunDataObject": 0x2400_3458,
    TEXT_RUN_DATA = "TextRunData": 0x4000_3499,
    PARAGRAPH_STYLE_ID = "ParagraphStyleId": 0x1c00_345a,
    HAS_VERSION_PAGES = "HasVersionPages": 0x0800_3462,
    ACTION_ITEM_TYPE = "ActionItemType": 0x1000_3463,
    NOTE_TAG_SHAPE = "NoteTagShape": 0x1000_3464,
    NOTE_TAG_HIGHLIGHT_COLOR = "NoteTagHighlightColor": 0x1400_3465,
    NOTE_TAG_TEXT_COLOR = "NoteTagTextColor": 0x1400_3466,
    NOTE_TAG_PROPERTY_STATUS = "NoteTagPropertyStatus": 0x1400_3467,
    NOTE_TAG_LABEL = "NoteTagLabel": 0x1c00_3468,
    NOTE_TAG_CREATED = "NoteTagCreated": 0x1400_346e,
    NOTE_TAG_COMPLETED = "NoteTagCompleted": 0x1400_346f,
    NOTE_TAG_DEFINITION_OID = "NoteTagDefinitionOid": 0x2000_3488,
    NOTE_TAG_STATES = "NoteTagStates": 0x4000_3489,
    ACTION_ITEM_STATUS = "ActionItemStatus": 0x1000_3470,
    ACTION_ITEM_SCHEMA_VERSION = "ActionItemSchemaVersion": 0x0c00_3473,
    READING_ORDER_RTL = "ReadingOrderRTL": 0x0800_3476,
    PARAGRAPH_ALIGNMENT = "ParagraphAlignment": 0x0c00_3477,
    VERSION_HISTORY_GRAPH_SPACE_CONTEXT_NODES = "VersionHistoryGraphSpaceContextNodes": 0x3400_347b,
    DISPLAYED_PAGE_NUMBER = "DisplayedPageNumber": 0x1400_3480,
    SECTION_DISPLAY_NAME = "SectionDisplayName": 0x1c00_349b,
    NEXT_STYLE = "NextStyle": 0x1c00_348a,
    WEB_PICTURE_CONTAINER14 = "WebPictureContainer14": 0x2000_34c8,
    IMAGE_UPLOAD_STATE = "ImageUploadState": 0x1400_34cb,
    TEXT_EXTENDED_ASCII = "TextExtendedAscii": 0x1c00_3498,
    PICTURE_WIDTH = "PictureWidth": 0x1400_34cd,
    PICTURE_HEIGHT = "PictureHeight": 0x1400_34ce,
    TASK_TAG_DUE_DATE = "TaskTagDueDate": 0x1400_346b,
    // Ink and the notebook table of contents. Ink IDs are undocumented in
    // [MS-ONE] and follow onenote.rs; TOC names are [MS-ONE] §2.2.93–96.
    INK_SCALING_X = "InkScalingX": 0x1400_1c46,
    INK_SCALING_Y = "InkScalingY": 0x1400_1c47,
    INK_STROKE_PROPERTIES = "InkStrokeProperties": 0x2000_3409,
    INK_DIMENSIONS = "InkDimensions": 0x1c00_340a,
    INK_PATH = "InkPath": 0x1c00_340b,
    INK_HEIGHT = "InkHeight": 0x1400_340c,
    INK_WIDTH = "InkWidth": 0x1400_340d,
    INK_ANTIALIASED = "InkAntialiased": 0x0800_340e,
    INK_COLOR = "InkColor": 0x1400_340f,
    INK_FIT_TO_CURVE = "InkFitToCurve": 0x0800_3410,
    INK_IGNORE_PRESSURE = "InkIgnorePressure": 0x0800_3411,
    INK_PEN_TIP_SHAPE = "InkPenTipShape": 0x0c00_3412,
    INK_RASTER_OPERATION = "InkRasterOperation": 0x0c00_3413,
    INK_STROKE_TRANSPARENCY = "InkStrokeTransparency": 0x0c00_3414,
    INK_DATA = "InkData": 0x2000_3415,
    INK_STROKES = "InkStrokes": 0x2400_3416,
    INK_BOUNDING_BOX = "InkBoundingBox": 0x1c00_3418,
    INK_BIAS = "InkBias": 0x0c00_341c,
    EMBEDDED_OBJECT_TYPE = "EmbeddedObjectType": 0x1400_3457,
    PAGE_RECOGNIZED_TEXT_CONTAINER = "PageRecognizedTextContainer": 0x2000_35d7,
    TOC_ENTRY_INDEX_OID_INDEX = "TOCEntryIndex_OidIndex": 0x2400_1cf6,
    NOTEBOOK_ELEMENT_ORDERING_ID = "NotebookElementOrderingID": 0x1400_1cb9,
    FOLDER_CHILD_FILENAME = "FolderChildFilename": 0x1c00_1d6b,
    FILE_IDENTITY_GUID = "FileIdentityGuid": 0x1c00_1d94,
    // Names below come from the property table shipped in the Mac binary
    // (docs/file-format.md §11.6), not from [MS-ONE].
    TEXT_CONTENT_METADATA = "TextContentMetadata": 0x1c00_1d61,
    IS_SCREEN_CLIPPING = "IsScreenClipping": 0x0800_1d8d,
    NEEDS_OCR = "NeedsOCR": 0x0800_1dce,
    ORIGINAL_PAGE_NUMBER = "OriginalPageNumber": 0x1400_1df9,
    ENCRYPTED_HASH = "EncryptedHash": 0x1c00_1dfb,
    UNVERIFIED_HASH = "UnverifiedHash": 0x1c00_1dfc,
    FILE_DATA_OBJECT_LAST_MODIFIED_TIME = "FileDataObject_LastModifiedTime": 0x1800_3422,
    FILE_DATA_OBJECT_FILE_REFERENCE = "FileDataObject_FileReference": 0x1c00_3423,
    FILE_DATA_OBJECT_EXTENSION = "FileDataObject_Extension": 0x1c00_3424,
    FILE_DATA_OBJECT_INVALID_DATA = "FileDataObject_InvalidData": 0x0800_343d,
    FILE_DATA_OBJECT_GUID = "FileDataObject_GUID": 0x1c00_343e,
    OCR_ENGINE_VERSION = "OcrEngineVersion": 0x1400_35d1,
    OCR_ACCURACY_INDEX = "OcrAccuracyIndex": 0x1400_35d2,
    FILE_DATA_OBJECT_IS_UNTRUSTED = "FileDataObject_IsUntrusted": 0x0800_35d4,
    DEFER_FDO_DOWNLOAD_ON_NOTEBOOK = "DeferFDODownloadOnNotebook": 0x0800_35d5,
    MAY_HAVE_FDOS_PENDING_DOWNLOAD = "MayHaveFdosPendingDownload": 0x0800_3614,
    MAY_HAVE_CHILDREN_WITH_FDOS_PENDING_DOWNLOAD = "MayHaveChildrenWithFdosPendingDownload": 0x0800_3615,
    FILE_DATA_OBJECT_FILE_CHECKSUM = "FileDataObject_FileChecksum": 0x1400_3638,
}

/// Name of a property (by low 26 bits), or `0x…` for unknown ones.
pub fn prop_name(id: u32) -> String {
    static BY_ID: std::sync::OnceLock<std::collections::HashMap<u32, &'static str>> =
        std::sync::OnceLock::new();
    // Later entries win, as in the TypeScript Map built from the same table.
    let by_id = BY_ID.get_or_init(|| {
        PROPS
            .iter()
            .map(|&(name, v)| (v & 0x03ff_ffff, name))
            .collect()
    });
    match by_id.get(&id) {
        Some(name) => (*name).to_string(),
        None => format!("0x{id:x}"),
    }
}
