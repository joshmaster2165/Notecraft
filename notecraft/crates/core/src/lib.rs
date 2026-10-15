//! Notecraft's library on disk, shared by the desktop app, the `notecraft`
//! CLI and its MCP server.
//!
//! A library is an ordinary folder the user owns:
//!
//! ```text
//! library.json                 notebook order, page templates, custom tags
//! notebooks/<id>.json          a notebook: sections, groups, deleted notes, page stubs
//! pages/<id>.json              one page: outlines, pictures, ink
//! assets/<key>.<ext>           pictures, attachments and recordings, as plain files
//! versions/<page>/<id>.json    page versions
//! ```
//!
//! Pages and notebooks use the same JSON shape as the web app's model
//! (`notecraft/src/model/types.ts`); pictures are referenced as
//! `notecraft-blob:<key>` and stored once under `assets/`.

pub mod markdown;
pub mod ops;
pub mod store;
mod util;

pub use store::{Error, LibraryStore, SaveChanges, VersionChanges};
pub use util::{iso_from_millis, new_id, now_iso};

/// Prefix of a picture or attachment reference stored in `assets/`.
pub const BLOB_PREFIX: &str = "notecraft-blob:";
