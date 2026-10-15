//! AI providers: API keys live in the OS keychain (Keychain, Windows
//! Credential Manager, Secret Service) and never reach the web view. The web
//! app builds provider requests; this module adds the key and sends them, so
//! local servers (Ollama, LM Studio) and cloud APIs work without CORS.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "app.notecraft.desktop";

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    if provider.is_empty() || !provider.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad provider id".into());
    }
    keyring::Entry::new(SERVICE, &format!("ai-{provider}")).map_err(|e| e.to_string())
}

fn get_key(provider: &str) -> Option<String> {
    entry(provider).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

#[tauri::command]
pub fn ai_key_set(provider: String, key: String) -> Result<(), String> {
    let e = entry(&provider)?;
    if key.trim().is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        };
    }
    e.set_password(key.trim()).map_err(|e| e.to_string())
}

/// Which providers have a key saved (the keys themselves are never returned).
#[tauri::command]
pub fn ai_key_status(providers: Vec<String>) -> HashMap<String, bool> {
    providers.into_iter().map(|p| (p.clone(), get_key(&p).is_some())).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    name: String,
    value: Option<String>,
    filename: Option<String>,
    /// A data: URL for file parts.
    data_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    /// Whose key to use.
    provider: String,
    url: String,
    #[serde(default = "post")]
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    json: Option<serde_json::Value>,
    multipart: Option<Vec<Part>>,
    /// "bearer", "x-api-key", "x-goog-api-key" or "none".
    #[serde(default)]
    auth: String,
    /// Return the body as a data: URL (images, video).
    #[serde(default)]
    binary: bool,
    timeout_secs: Option<u64>,
}

fn post() -> String {
    "POST".into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    content_type: String,
    body: String,
}

fn decode_data_url(url: &str) -> Option<(String, Vec<u8>)> {
    let (meta, data) = url.strip_prefix("data:")?.split_once(',')?;
    let mime = meta.split(';').next().unwrap_or("application/octet-stream").to_string();
    Some((mime, base64::engine::general_purpose::STANDARD.decode(data).ok()?))
}

#[tauri::command]
pub async fn ai_http(req: HttpRequest) -> Result<HttpResponse, String> {
    let lower = req.url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://localhost") || lower.starts_with("http://127.0.0.1") || lower.starts_with("http://[::1]")) {
        return Err("AI requests must use https (or a server on this computer)".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(req.timeout_secs.unwrap_or(300)))
        .user_agent(concat!("Notecraft/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = client.request(method, &req.url);
    for (k, v) in &req.headers {
        rb = rb.header(k, v);
    }
    if req.auth != "none" && !req.auth.is_empty() {
        let key = get_key(&req.provider).ok_or_else(|| format!("No API key saved for {}. Add one in Settings › AI.", req.provider))?;
        rb = match req.auth.as_str() {
            "x-api-key" => rb.header("x-api-key", key),
            "x-goog-api-key" => rb.header("x-goog-api-key", key),
            _ => rb.bearer_auth(key),
        };
    }
    if let Some(parts) = req.multipart {
        let mut form = reqwest::multipart::Form::new();
        for p in parts {
            form = match (p.value, p.data_url) {
                (Some(v), _) => form.text(p.name, v),
                (None, Some(url)) => {
                    let (mime, bytes) = decode_data_url(&url).ok_or("bad file data")?;
                    let part = reqwest::multipart::Part::bytes(bytes).file_name(p.filename.unwrap_or_else(|| "file".into())).mime_str(&mime).map_err(|e| e.to_string())?;
                    form.part(p.name, part)
                }
                _ => form,
            };
        }
        rb = rb.multipart(form);
    } else if let Some(json) = req.json {
        rb = rb.json(&json);
    }
    let res = rb.send().await.map_err(|e| if e.is_connect() { format!("Couldn't reach {} — is the server running?", req.url) } else { e.to_string() })?;
    let status = res.status().as_u16();
    let content_type = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = if req.binary && status < 400 {
        let bytes = res.bytes().await.map_err(|e| e.to_string())?;
        let mime = content_type.split(';').next().filter(|m| !m.is_empty()).unwrap_or("application/octet-stream");
        format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes))
    } else {
        res.text().await.map_err(|e| e.to_string())?
    };
    Ok(HttpResponse { status, content_type, body })
}
