//! The document engine (notecraft-engine) as native commands: picture crop,
//! PDF printouts, Ink to Shape, equations, Word and OneNote export and
//! section locks.

use base64::Engine;
use notecraft_engine::{crop, docx, lock, math, one, pdf, shapes};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn from_data_url(url: &str) -> Result<Vec<u8>, String> {
    let (_, data) = url.strip_prefix("data:").and_then(|r| r.split_once(',')).ok_or("not a data: URL")?;
    b64().decode(data).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropOut {
    src: String,
    width: u32,
    height: u32,
}

#[tauri::command]
pub async fn engine_crop(src: String, rect: crop::CropRect) -> Result<CropOut, String> {
    let out = crop::crop(&from_data_url(&src)?, rect).map_err(|e| e.0)?;
    Ok(CropOut { src: format!("data:{};base64,{}", out.media_type, b64().encode(&out.bytes)), width: out.width, height: out.height })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOut {
    src: String,
    width_pt: f32,
    height_pt: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintoutOut {
    page_count: usize,
    pages: Vec<PageOut>,
}

#[tauri::command]
pub async fn engine_render_pdf(src: String, scale: f32, max_pages: usize) -> Result<PrintoutOut, String> {
    let out = pdf::render_pdf(&from_data_url(&src)?, scale, max_pages)?;
    Ok(PrintoutOut {
        page_count: out.page_count,
        pages: out.pages.into_iter().map(|p| PageOut { src: format!("data:image/png;base64,{}", b64().encode(&p.png)), width_pt: p.width_pt, height_pt: p.height_pt }).collect(),
    })
}

#[tauri::command]
pub fn engine_recognize_shape(points: Vec<f32>) -> Option<shapes::Shape> {
    shapes::recognize(&points)
}

#[tauri::command]
pub fn engine_mathml(linear: String, block: bool) -> String {
    math::to_mathml(&linear, block)
}

/// Export pages as .docx through a save dialog. Returns the saved path, or None if cancelled.
#[tauri::command]
pub async fn engine_export_docx(app: AppHandle, pages: Vec<Value>, default_name: String) -> Result<Option<String>, String> {
    let bytes = docx::export_docx(&pages);
    let Some(path) = app.dialog().file().set_file_name(&default_name).add_filter("Word document", &["docx"]).blocking_save_file() else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// Export a section as a OneNote .one file through a save dialog. The file is
/// written for the name chosen (OneNote keeps a checksum of it). Returns the
/// path and any warnings, or None if cancelled.
#[tauri::command]
pub async fn engine_export_one(app: AppHandle, section: Value) -> Result<Option<(String, Vec<String>)>, String> {
    let Some(path) = app.dialog().file().set_file_name(one::suggested_file_name(&section)).add_filter("OneNote section", &["one"]).blocking_save_file() else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).map(str::to_string);
    let out = one::export_one(&section, name.as_deref())?;
    std::fs::write(&path, out.bytes).map_err(|e| e.to_string())?;
    Ok(Some((path.display().to_string(), out.warnings)))
}

/// Export a notebook as a OneNote notebook folder (.onetoc2 + .one files)
/// inside a folder the user picks. A folder of that name already there gets
/// " (2)", " (3)"… instead of being overwritten. Returns the notebook folder
/// and any warnings, or None if cancelled.
#[tauri::command]
pub async fn engine_export_one_notebook(app: AppHandle, notebook: Value) -> Result<Option<(String, Vec<String>)>, String> {
    let out = one::export_notebook(&notebook)?;
    let Some(parent) = app.dialog().file().set_title("Choose where to save the OneNote notebook").blocking_pick_folder() else { return Ok(None) };
    let parent = parent.into_path().map_err(|e| e.to_string())?;
    let folder = out.files.first().and_then(|f| f.path.split('/').next()).unwrap_or("Notebook").to_string();
    let mut root = parent.join(&folder);
    for n in 2.. {
        if !root.exists() {
            break;
        }
        root = parent.join(format!("{folder} ({n})"));
    }
    for f in &out.files {
        // Paths come from the writer: "<folder>/<sub>/<file>"; never let one leave the notebook folder.
        let mut rest = f.path.split('/').skip(1).peekable();
        if rest.peek().is_none() || f.path.split('/').any(|c| c.is_empty() || c == "." || c == "..") {
            return Err(format!("unsafe export path {:?}", f.path));
        }
        let path = rest.fold(root.clone(), |p, c| p.join(c));
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, &f.bytes).map_err(|e| e.to_string())?;
    }
    Ok(Some((root.display().to_string(), out.warnings)))
}

/// Password protect: seal under a new password, returning the key for re-sealing while unlocked.
#[tauri::command]
pub async fn engine_protect(plaintext: String, password: String) -> lock::Keyed {
    lock::protect(plaintext.as_bytes(), &password)
}

#[derive(Serialize)]
pub struct UnlockOut {
    plaintext: String,
    key: String,
}

#[tauri::command]
pub async fn engine_unlock(sealed: lock::Sealed, password: String) -> Result<UnlockOut, String> {
    let u = lock::unlock(&sealed, &password).map_err(|e| e.to_string())?;
    Ok(UnlockOut { plaintext: String::from_utf8(u.plaintext).map_err(|e| e.to_string())?, key: u.key })
}

#[tauri::command]
pub async fn engine_reseal(plaintext: String, key: String, like: lock::Sealed) -> Result<lock::Sealed, String> {
    lock::reseal(plaintext.as_bytes(), &key, &like).map_err(|e| e.to_string())
}
