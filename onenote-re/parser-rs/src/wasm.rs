//! WebAssembly bindings (`--features wasm`). Built with wasm-bindgen
//! `--target web`; see notecraft's `build:wasm` script.
//!
//! ```js
//! import init, { parse_one_note, parse_notebook_toc } from "./onenote_re/onenote_re.js";
//! await init();
//! const { json, assets } = parse_one_note(new Uint8Array(buf), "Section", true);
//! // json: the NotebookJson object (as the TypeScript parseOneNote returns, with
//! //       asset.ref set to the asset id); assets: [{ id, mediaType, extension?, bytes }]
//! ```

use js_sys::{Array, Object, Reflect, Uint8Array};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::notebook::{Asset, ConvertOptions};

struct OwnedAsset {
    id: String,
    media_type: String,
    extension: Option<String>,
    bytes: Vec<u8>,
}

fn serializer() -> serde_wasm_bindgen::Serializer {
    // Plain objects (not Map) for maps, and null (not undefined) for None.
    serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_missing_as_null(true)
}

fn set(target: &Object, key: &str, value: &JsValue) -> Result<(), JsError> {
    Reflect::set(target, &JsValue::from_str(key), value)
        .map(|_| ())
        .map_err(|_| JsError::new("could not build the result object"))
}

/// Parse a `.one` section. Returns `{ json, assets }`: `json` is the notebook
/// JSON as a plain object; every embedded image or attachment is in `assets`
/// once (keyed by the `id` that `asset.ref` holds), with its bytes as a Uint8Array.
#[wasm_bindgen]
pub fn parse_one_note(
    bytes: &[u8],
    section_name: Option<String>,
    include_versions: bool,
) -> Result<JsValue, JsError> {
    let mut assets: Vec<OwnedAsset> = Vec::new();
    let json = {
        let on_asset = |a: Asset<'_>| {
            if !assets.iter().any(|x| x.id == a.id) {
                assets.push(OwnedAsset {
                    id: a.id.to_string(),
                    media_type: a.media_type.to_string(),
                    extension: a.extension.map(str::to_string),
                    bytes: a.bytes.to_vec(),
                });
            }
            Some(a.id.to_string())
        };
        let opts = ConvertOptions {
            section_name,
            include_versions,
            on_asset: Some(Box::new(on_asset)),
            resolve_file_data: None,
        };
        crate::parse_one_note(bytes, opts).map_err(|e| JsError::new(e.message()))?
    };
    let out = Object::new();
    let json = json
        .serialize(&serializer())
        .map_err(|e| JsError::new(&e.to_string()))?;
    set(&out, "json", &json)?;
    let list = Array::new();
    for a in assets {
        let o = Object::new();
        set(&o, "id", &JsValue::from_str(&a.id))?;
        set(&o, "mediaType", &JsValue::from_str(&a.media_type))?;
        if let Some(ext) = &a.extension {
            set(&o, "extension", &JsValue::from_str(ext))?;
        }
        set(&o, "bytes", &Uint8Array::from(a.bytes.as_slice()).into())?;
        list.push(&o);
    }
    set(&out, "assets", &list)?;
    Ok(out.into())
}

/// Parse a `.onetoc2` notebook table of contents into a plain object.
#[wasm_bindgen]
pub fn parse_notebook_toc(bytes: &[u8]) -> Result<JsValue, JsError> {
    let toc = crate::toc::parse_notebook_toc(bytes).map_err(|e| JsError::new(e.message()))?;
    toc.serialize(&serializer())
        .map_err(|e| JsError::new(&e.to_string()))
}
