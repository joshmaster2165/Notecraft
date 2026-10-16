//! WebAssembly exports for the browser build (`--features wasm`). The desktop
//! app calls the same functions natively through Tauri commands.

use serde::Serialize;
use wasm_bindgen::prelude::*;

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true)).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn crop_image(bytes: &[u8], x: f64, y: f64, width: f64, height: f64) -> Result<JsValue, JsError> {
    let rect = crate::crop::CropRect { top_left_x_percentage: x, top_left_y_percentage: y, width_percentage: width, height_percentage: height };
    let out = crate::crop::crop(bytes, rect).map_err(|e| JsError::new(&e.0))?;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Out {
        #[serde(with = "serde_bytes_compat")]
        bytes: Vec<u8>,
        media_type: &'static str,
        width: u32,
        height: u32,
    }
    to_js(&Out { bytes: out.bytes, media_type: out.media_type, width: out.width, height: out.height })
}

#[wasm_bindgen]
pub fn render_pdf(bytes: &[u8], scale: f32, max_pages: usize) -> Result<JsValue, JsError> {
    let out = crate::pdf::render_pdf(bytes, scale, max_pages).map_err(|e| JsError::new(&e))?;
    let pages = js_sys::Array::new();
    for p in out.pages {
        let o = js_sys::Object::new();
        js_sys::Reflect::set(&o, &"png".into(), &js_sys::Uint8Array::from(p.png.as_slice()).into()).ok();
        js_sys::Reflect::set(&o, &"widthPt".into(), &p.width_pt.into()).ok();
        js_sys::Reflect::set(&o, &"heightPt".into(), &p.height_pt.into()).ok();
        pages.push(&o);
    }
    let o = js_sys::Object::new();
    js_sys::Reflect::set(&o, &"pageCount".into(), &(out.page_count as u32).into()).ok();
    js_sys::Reflect::set(&o, &"pages".into(), &pages).ok();
    Ok(o.into())
}

#[wasm_bindgen]
pub fn recognize_shape(points: &[f32]) -> Result<JsValue, JsError> {
    to_js(&crate::shapes::recognize(points))
}

#[wasm_bindgen]
pub fn to_mathml(linear: &str, block: bool) -> String {
    crate::math::to_mathml(linear, block)
}

#[wasm_bindgen]
pub fn export_docx(pages_json: &str) -> Result<Vec<u8>, JsError> {
    let pages: Vec<serde_json::Value> = serde_json::from_str(pages_json).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(crate::docx::export_docx(&pages))
}

/// `{bytes: Uint8Array, fileName, warnings}` for File › Export › OneNote section.
#[wasm_bindgen]
pub fn export_one(section_json: &str, file_name: Option<String>) -> Result<JsValue, JsError> {
    let section: serde_json::Value = serde_json::from_str(section_json).map_err(|e| JsError::new(&e.to_string()))?;
    let out = crate::one::export_one(&section, file_name.as_deref()).map_err(|e| JsError::new(&e))?;
    let o = js_sys::Object::new();
    js_sys::Reflect::set(&o, &"bytes".into(), &js_sys::Uint8Array::from(out.bytes.as_slice()).into()).ok();
    js_sys::Reflect::set(&o, &"fileName".into(), &out.file_name.into()).ok();
    let warnings = js_sys::Array::new();
    for w in out.warnings {
        warnings.push(&w.into());
    }
    js_sys::Reflect::set(&o, &"warnings".into(), &warnings).ok();
    Ok(o.into())
}

/// `{bytes: Uint8Array (zip), fileName, warnings}` for Export › OneNote notebook in the browser.
#[wasm_bindgen]
pub fn export_one_notebook(notebook_json: &str) -> Result<JsValue, JsError> {
    let notebook: serde_json::Value = serde_json::from_str(notebook_json).map_err(|e| JsError::new(&e.to_string()))?;
    let out = crate::one::export_notebook_zip(&notebook).map_err(|e| JsError::new(&e))?;
    let o = js_sys::Object::new();
    js_sys::Reflect::set(&o, &"bytes".into(), &js_sys::Uint8Array::from(out.bytes.as_slice()).into()).ok();
    js_sys::Reflect::set(&o, &"fileName".into(), &out.file_name.into()).ok();
    let warnings = js_sys::Array::new();
    for w in out.warnings {
        warnings.push(&w.into());
    }
    js_sys::Reflect::set(&o, &"warnings".into(), &warnings).ok();
    Ok(o.into())
}

fn sealed_from(json: &str) -> Result<crate::lock::Sealed, JsError> {
    serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))
}

/// Returns `{"sealed": …, "key": "<base64>"}` as JSON.
#[wasm_bindgen]
pub fn protect(plaintext: &str, password: &str) -> Result<String, JsError> {
    serde_json::to_string(&crate::lock::protect(plaintext.as_bytes(), password)).map_err(|e| JsError::new(&e.to_string()))
}

/// Returns `{"plaintext": "<utf-8>", "key": "<base64>"}` as JSON.
#[wasm_bindgen]
pub fn unlock(sealed_json: &str, password: &str) -> Result<String, JsError> {
    let u = crate::lock::unlock(&sealed_from(sealed_json)?, password).map_err(|e| JsError::new(&e.to_string()))?;
    let text = String::from_utf8(u.plaintext).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(serde_json::json!({ "plaintext": text, "key": u.key }).to_string())
}

#[wasm_bindgen]
pub fn reseal(plaintext: &str, key: &str, like_json: &str) -> Result<String, JsError> {
    let sealed = crate::lock::reseal(plaintext.as_bytes(), key, &sealed_from(like_json)?).map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&sealed).map_err(|e| JsError::new(&e.to_string()))
}

/// Serialize Vec<u8> as a Uint8Array rather than an array of numbers.
mod serde_bytes_compat {
    use serde::Serializer;
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(v)
    }
}
