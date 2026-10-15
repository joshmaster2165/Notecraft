//! Import from OneNote: find the notebooks OneNote keeps on this machine (or
//! in a folder the user picks) and parse them natively with onenote-re.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use onenote_re::cache::OneNoteCache;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FoundSection {
    path: String,
    name: String,
    /// Folder inside the notebook ("" for the top); subfolders are section groups.
    dir: String,
    modified: String,
    bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FoundToc {
    dir: String,
    path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FoundNotebook {
    name: String,
    sections: Vec<FoundSection>,
    tocs: Vec<FoundToc>,
}

/// Folders the user picked in a dialog; the importer may read inside them.
#[derive(Default)]
pub struct AllowedFolders(Mutex<Vec<PathBuf>>);

impl AllowedFolders {
    pub fn allow(&self, p: PathBuf) {
        if let Ok(mut v) = self.0.lock() {
            v.push(p);
        }
    }
    fn contains(&self, p: &Path) -> bool {
        self.0.lock().map(|v| v.iter().any(|root| p.starts_with(root))).unwrap_or(false)
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

/// Where OneNote keeps notebooks on this machine.
fn onenote_roots() -> Vec<PathBuf> {
    let h = home();
    [
        // OneNote for Mac: local backups of every synced notebook.
        h.join("Library/Containers/com.microsoft.onenote.mac/Data/Library/Application Support/Microsoft User Data/OneNote/15.0/Backup"),
        // OneNote 2016 / Windows: local notebooks and backups.
        h.join("Documents/OneNote Notebooks"),
        h.join("AppData/Local/Microsoft/OneNote/16.0/Backup"),
    ]
    .into_iter()
    .filter(|p| p.is_dir())
    .collect()
}

fn iso(t: std::time::SystemTime) -> String {
    let ms = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    notecraft_core::iso_from_millis(ms)
}

/// Backups are named "Section (On 2026-10-14).one"; keep the newest copy of each section.
fn section_name(file: &str) -> String {
    let base = file.strip_suffix(".one").or_else(|| file.strip_suffix(".ONE")).unwrap_or(file);
    match base.rfind(" (On ") {
        Some(i) if base.ends_with(')') && base.len() - i == " (On 2026-10-14)".len() => base[..i].to_string(),
        _ => base.to_string(),
    }
}

struct NotebookAcc {
    sections: HashMap<String, FoundSection>,
    tocs: HashMap<String, String>,
}

fn walk(dir: &Path, notebook: Option<&str>, rel: &[String], depth: usize, out: &mut HashMap<String, NotebookAcc>, fallback_name: &str) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            if name.eq_ignore_ascii_case("OneNote_RecycleBin") {
                continue;
            }
            match notebook {
                None => walk(&path, Some(&name), &[], depth + 1, out, fallback_name),
                Some(nb) => {
                    let mut r = rel.to_vec();
                    r.push(name);
                    walk(&path, Some(nb), &r, depth + 1, out, fallback_name);
                }
            }
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".one") && !lower.ends_with(".onetoc2") {
            continue;
        }
        let nb = notebook.unwrap_or(fallback_name).to_string();
        let acc = out.entry(nb).or_insert_with(|| NotebookAcc { sections: HashMap::new(), tocs: HashMap::new() });
        let rel_dir = rel.join("/");
        if lower.ends_with(".onetoc2") {
            acc.tocs.insert(rel_dir, path.display().to_string());
        } else {
            let section = section_name(&name);
            let found = FoundSection { path: path.display().to_string(), name: section.clone(), dir: rel_dir.clone(), modified: meta.modified().map(iso).unwrap_or_default(), bytes: meta.len() };
            let key = format!("{rel_dir}/{section}");
            if acc.sections.get(&key).is_none_or(|prev| prev.modified < found.modified) {
                acc.sections.insert(key, found);
            }
        }
    }
}

fn finish(out: HashMap<String, NotebookAcc>) -> Vec<FoundNotebook> {
    let mut v: Vec<FoundNotebook> = out
        .into_iter()
        .filter(|(_, a)| !a.sections.is_empty())
        .map(|(name, a)| {
            let mut sections: Vec<FoundSection> = a.sections.into_values().collect();
            sections.sort_by(|x, y| x.dir.cmp(&y.dir).then(x.name.to_lowercase().cmp(&y.name.to_lowercase())));
            FoundNotebook { name, sections, tocs: a.tocs.into_iter().map(|(dir, path)| FoundToc { dir, path }).collect() }
        })
        .collect();
    v.sort_by_key(|n| n.name.to_lowercase());
    v
}

#[tauri::command]
pub fn onenote_scan() -> Value {
    let roots = onenote_roots();
    let mut acc = HashMap::new();
    for r in &roots {
        walk(r, None, &[], 0, &mut acc, "Notebook");
    }
    json!({ "roots": roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>(), "notebooks": finish(acc) })
}

/// A folder the user picked: a notebook (it holds sections or a .onetoc2) or a
/// folder of notebooks.
#[tauri::command]
pub fn onenote_scan_folder(allowed: State<'_, AllowedFolders>, path: String) -> Result<Vec<FoundNotebook>, String> {
    let root = PathBuf::from(&path);
    if !allowed.contains(&root) {
        return Err("Pick the folder first".into());
    }
    let holds_sections = fs::read_dir(&root).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).any(|e| {
        let n = e.file_name().to_string_lossy().to_ascii_lowercase();
        n.ends_with(".one") || n.ends_with(".onetoc2")
    });
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Notebook".into());
    let mut acc = HashMap::new();
    if holds_sections {
        walk(&root, Some(&name), &[], 0, &mut acc, &name);
    } else {
        walk(&root, None, &[], 0, &mut acc, &name);
    }
    Ok(finish(acc))
}

fn check_path(allowed: &AllowedFolders, path: &str, ext: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ok_ext = p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext));
    if !ok_ext || !(onenote_roots().iter().any(|r| p.starts_with(r)) || allowed.contains(&p)) {
        return Err(format!("Not a .{ext} file in a OneNote folder"));
    }
    Ok(p)
}

#[derive(Default)]
pub struct Caches(Mutex<HashMap<PathBuf, Option<OneNoteCache>>>);

/// Parse one section with its page history; pictures OneNote left out of the
/// file come from its local cache when it has them.
#[tauri::command]
pub async fn onenote_parse(allowed: State<'_, AllowedFolders>, caches: State<'_, Caches>, path: String) -> Result<Value, String> {
    let p = check_path(&allowed, &path, "one")?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    let file_name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let cache_dir = OneNoteCache::find_for(&p);
    let mut guard = caches.0.lock().map_err(|e| e.to_string())?;
    let cache = cache_dir.and_then(|d| guard.entry(d.clone()).or_insert_with(|| OneNoteCache::new(&d).ok()).as_ref());
    let mut assets = serde_json::Map::new();
    let json = {
        let opts = onenote_re::ConvertOptions {
            section_name: Some(file_name.clone()),
            include_versions: true,
            on_asset: Some(Box::new(|asset: onenote_re::Asset<'_>| {
                let media = if asset.media_type.is_empty() { onenote_re::notebook::sniff_media_type(asset.bytes, asset.extension) } else { asset.media_type.to_string() };
                let url = format!("data:{media};base64,{}", base64::engine::general_purpose::STANDARD.encode(asset.bytes));
                assets.insert(asset.id.to_string(), json!(url));
                Some(asset.id.to_string())
            })),
            resolve_file_data: cache.map(|c| Box::new(c.resolver()) as onenote_re::FileDataResolver<'_>),
        };
        let parsed = onenote_re::parse_one_note(&bytes, opts).map_err(|e| format!("{file_name}: {e}"))?;
        serde_json::to_value(parsed).map_err(|e| e.to_string())?
    };
    Ok(json!({ "json": json, "assets": assets, "fileName": file_name }))
}

#[tauri::command]
pub fn onenote_toc(allowed: State<'_, AllowedFolders>, path: String) -> Result<Value, String> {
    let p = check_path(&allowed, &path, "onetoc2")?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    let toc = onenote_re::parse_notebook_toc(&bytes).map_err(|e| e.to_string())?;
    serde_json::to_value(toc).map_err(|e| e.to_string())
}
