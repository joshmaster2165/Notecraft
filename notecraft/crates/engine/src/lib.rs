//! Notecraft's document engine: the features of OneNote that need real
//! computation, in Rust so the desktop app runs them natively and the browser
//! build runs the same code as WebAssembly (`--features wasm`).
//!
//! Each module's documentation names the OneNote structures it follows, as
//! found in OneNote for Mac 16.114 with REA (see onenote-re/docs/file-format.md).

pub mod crop;
pub mod docx;
pub mod lock;
pub mod math;
pub mod one;
pub mod pdf;
pub mod shapes;
mod zipw;
#[cfg(feature = "wasm")]
pub mod wasm;
