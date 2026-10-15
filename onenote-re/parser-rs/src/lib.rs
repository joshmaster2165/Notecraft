//! Reader for OneNote revision-store files: `.one` sections and `.onetoc2`
//! notebook tables of contents ([MS-ONESTORE] container, [MS-ONE] schema).
//!
//! A Rust port of the TypeScript parser in `onenote-re/parser/src`; both
//! produce the same JSON (see `tests/differential.mjs`). `docs/file-format.md`
//! describes the format.
//!
//! ```no_run
//! let bytes = std::fs::read("Section.one").unwrap();
//! let json = onenote_re::parse_one_note(&bytes, onenote_re::ConvertOptions::default()).unwrap();
//! println!("{}", onenote_re::json::to_string_pretty(&json).unwrap());
//! ```
//!
//! Modules mirror the TypeScript files: [`reader`] (byte cursor, string
//! decoding), [`onestore`] (revision store), [`schema`] (JCIDs, PropertyIDs),
//! [`notebook`] (section → pages → blocks), [`ink`], [`toc`] (.onetoc2) and,
//! off-wasm, `cache` (OneNote for Mac's cache folder).

#[cfg(not(target_arch = "wasm32"))]
pub mod cache;
pub mod ink;
pub mod js;
pub mod json;
pub mod notebook;
pub mod onestore;
pub mod reader;
pub mod schema;
pub mod toc;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use ink::{InkBlock, InkStroke};
pub use notebook::{
    dump_object_graph, Asset, AssetHook, ConvertOptions, FileDataQuery, FileDataResolver,
    NotebookConverter, NotebookJson, ResolvedFileData,
};
pub use onestore::OneStore;
pub use reader::ParseError;
pub use toc::{notebook_toc, parse_notebook_toc, NotebookToc, TocEntry};

/// Parse a `.one` section into notebook JSON. Fails only when the revision
/// store structure is unreadable (bad header, broken FileNodeList chain...);
/// damage inside individual objects ends up in `diagnostics.warnings`.
pub fn parse_one_note(bytes: &[u8], opts: ConvertOptions<'_>) -> Result<NotebookJson, ParseError> {
    let store = OneStore::new(bytes)?;
    Ok(NotebookConverter::new(&store, opts).convert())
}
