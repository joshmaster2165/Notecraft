//! Saving exports and attachments, opening links, and folder pickers. The
//! system WebView has no download manager, so the web app hands files to
//! these commands instead of using `<a download>`.

use std::fs;
use std::path::PathBuf;

use base64::Engine;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::library::LibraryState;
use crate::onenote::AllowedFolders;

/// Ask where to save, then write `data` (text, or a `data:` URL for binary files).
/// Returns the chosen path, or None when the user cancels.
#[tauri::command]
pub async fn save_file(app: AppHandle, default_name: String, data: String) -> Result<Option<String>, String> {
    let Some(path) = app.dialog().file().set_file_name(&default_name).blocking_save_file() else { return Ok(None) };
    let path: PathBuf = path.into_path().map_err(|e| e.to_string())?;
    let bytes = match data.strip_prefix("data:").and_then(|rest| rest.split_once(',')) {
        Some((meta, body)) if meta.ends_with(";base64") => base64::engine::general_purpose::STANDARD.decode(body).map_err(|e| e.to_string())?,
        Some((_, body)) => body.as_bytes().to_vec(),
        None => data.into_bytes(),
    };
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// Web and mail links open in the user's browser or mail app.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err("only web and mail links open outside Notecraft".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_library(app: AppHandle, state: State<'_, LibraryState>) -> Result<(), String> {
    let root = state.root();
    let target = if root.join("library.json").is_file() { root.join("library.json") } else { root };
    app.opener().reveal_item_in_dir(target).map_err(|e| e.to_string())
}

/// A folder picker. Folders picked here may be read by the OneNote importer.
#[tauri::command]
pub async fn pick_folder(app: AppHandle, allowed: State<'_, AllowedFolders>, title: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(t) = title {
        dialog = dialog.set_title(t);
    }
    let Some(path) = dialog.blocking_pick_folder() else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    allowed.allow(path.clone());
    Ok(Some(path.display().to_string()))
}

/// File › Print: the system print dialog for the page (also "Save as PDF").
#[tauri::command]
pub fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}
