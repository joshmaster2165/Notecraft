//! Reading and writing the library folder.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::util::{atomic_write, decode_data_url, encode_data_url, ext_for_mime, mime_for_ext, safe_name};
use crate::BLOB_PREFIX;

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    Json(serde_json::Error),
    NotFound(String),
    Invalid(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::Json(e) => write!(f, "bad JSON: {e}"),
            Error::NotFound(what) => write!(f, "not found: {what}"),
            Error::Invalid(why) => write!(f, "{why}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Json(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// What the app changed since its last save. Blobs are written first and
/// `library.json` last, so an interrupted save never leaves dangling references.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SaveChanges {
    /// The new `library.json` content (notebook order, templates, custom tags).
    pub library: Option<Value>,
    /// Notebook manifests: notebooks whose sections hold page stubs.
    pub notebooks: Vec<Value>,
    pub deleted_notebooks: Vec<String>,
    /// Full pages that changed.
    pub pages: Vec<Value>,
    pub deleted_pages: Vec<String>,
    /// New pictures and files: blob key → data URL.
    pub blobs: HashMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VersionChanges {
    /// Version records (`{ id, pageId, at, page, … }`).
    pub put: Vec<Value>,
    pub delete: Vec<String>,
    pub blobs: HashMap<String, String>,
}

pub struct LibraryStore {
    root: PathBuf,
}

const LIBRARY_FILE: &str = "library.json";

fn read_json(path: &Path) -> Result<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)?;
    Ok(())
}

fn id_of(v: &Value) -> Result<&str> {
    let id = v.get("id").and_then(Value::as_str).ok_or_else(|| Error::Invalid("object without an id".into()))?;
    if !safe_name(id) {
        return Err(Error::Invalid(format!("unsafe id {id:?}")));
    }
    Ok(id)
}

impl LibraryStore {
    /// The library the app and CLI use unless told otherwise:
    /// `$NOTECRAFT_LIBRARY`, else `~/Documents/Notecraft`.
    pub fn default_root() -> PathBuf {
        if let Some(dir) = std::env::var_os("NOTECRAFT_LIBRARY") {
            return PathBuf::from(dir);
        }
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
        home.join("Documents").join("Notecraft")
    }

    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// True once the app (or the CLI) has written a library here.
    pub fn exists(&self) -> bool {
        self.root.join(LIBRARY_FILE).is_file()
    }

    fn notebook_path(&self, id: &str) -> PathBuf {
        self.root.join("notebooks").join(format!("{id}.json"))
    }

    pub(crate) fn page_path(&self, id: &str) -> PathBuf {
        self.root.join("pages").join(format!("{id}.json"))
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.root.join("assets")
    }

    // --- whole library ---------------------------------------------------------------

    /// `library.json` as stored (notebook ids, templates, custom tags).
    pub fn read_library_file(&self) -> Result<Value> {
        Ok(read_json(&self.root.join(LIBRARY_FILE))?.unwrap_or_else(|| json!({ "format": "notecraft-library", "version": 1, "notebooks": [] })))
    }

    pub fn write_library_file(&self, value: &Value) -> Result<()> {
        let mut v = value.clone();
        if let Some(o) = v.as_object_mut() {
            o.insert("format".into(), json!("notecraft-library"));
            o.entry("version").or_insert(json!(1));
        }
        write_json(&self.root.join(LIBRARY_FILE), &v)
    }

    /// Notebook ids in display order, including notebook files the index doesn't list.
    pub fn notebook_ids(&self) -> Result<Vec<String>> {
        let lib = self.read_library_file()?;
        let mut ids: Vec<String> = lib["notebooks"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        if let Ok(entries) = fs::read_dir(self.root.join("notebooks")) {
            let mut extra: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json")).map(String::from))
                .filter(|id| safe_name(id) && !ids.contains(id))
                .collect();
            extra.sort();
            ids.extend(extra);
        }
        Ok(ids)
    }

    pub fn read_notebook(&self, id: &str) -> Result<Option<Value>> {
        if !safe_name(id) {
            return Err(Error::Invalid(format!("unsafe id {id:?}")));
        }
        read_json(&self.notebook_path(id))
    }

    pub fn write_notebook(&self, manifest: &Value) -> Result<()> {
        let id = id_of(manifest)?;
        write_json(&self.notebook_path(id), manifest)
    }

    pub fn read_page(&self, id: &str) -> Result<Option<Value>> {
        if !safe_name(id) {
            return Err(Error::Invalid(format!("unsafe id {id:?}")));
        }
        read_json(&self.page_path(id))
    }

    pub fn write_page(&self, page: &Value) -> Result<()> {
        let id = id_of(page)?;
        write_json(&self.page_path(id), page)
    }

    /// The whole library in the web app's `Library` shape. With `inline_blobs`,
    /// picture references become data URLs the app can display directly.
    pub fn load(&self, inline_blobs: bool) -> Result<Option<Value>> {
        if !self.exists() {
            return Ok(None);
        }
        let lib = self.read_library_file()?;
        let mut notebooks = Vec::new();
        for id in self.notebook_ids()? {
            let Some(mut nb) = self.read_notebook(&id)? else { continue };
            if let Some(sections) = nb.get_mut("sections").and_then(Value::as_array_mut) {
                for section in sections {
                    if let Some(pages) = section.get_mut("pages").and_then(Value::as_array_mut) {
                        for stub in pages.iter_mut() {
                            let Some(pid) = stub.get("id").and_then(Value::as_str).map(String::from) else { continue };
                            *stub = match self.read_page(&pid)? {
                                Some(page) => page,
                                None => page_from_stub(stub),
                            };
                        }
                    }
                }
            }
            notebooks.push(nb);
        }
        let mut out = json!({ "version": 1, "notebooks": notebooks });
        for key in ["templates", "customTags"] {
            if let Some(v) = lib.get(key) {
                out[key] = v.clone();
            }
        }
        if inline_blobs {
            self.inline_blobs(&mut out);
        }
        Ok(Some(out))
    }

    pub fn save(&self, changes: SaveChanges) -> Result<()> {
        self.put_blobs(&changes.blobs)?;
        for page in &changes.pages {
            self.write_page(page)?;
        }
        for nb in &changes.notebooks {
            self.write_notebook(nb)?;
        }
        if let Some(lib) = &changes.library {
            self.write_library_file(lib)?;
        }
        for id in &changes.deleted_pages {
            if safe_name(id) {
                remove_if_exists(&self.page_path(id))?;
            }
        }
        for id in &changes.deleted_notebooks {
            if safe_name(id) {
                remove_if_exists(&self.notebook_path(id))?;
            }
        }
        Ok(())
    }

    // --- blobs (pictures, attachments, recordings) -------------------------------------------

    fn find_blob(&self, key: &str) -> Option<PathBuf> {
        if !safe_name(key) {
            return None;
        }
        let dir = self.assets_dir();
        for ext in ["png", "jpg", "gif", "webp", "svg", "pdf", "webm", "m4a", "bin"] {
            let p = dir.join(format!("{key}.{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
        fs::read_dir(&dir).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(key))
    }

    pub fn has_blob(&self, key: &str) -> bool {
        self.find_blob(key).is_some()
    }

    /// The asset file for a blob key, if stored.
    pub fn blob_path(&self, key: &str) -> Option<PathBuf> {
        self.find_blob(key)
    }

    pub fn get_blob(&self, key: &str) -> Result<Option<String>> {
        let Some(path) = self.find_blob(key) else { return Ok(None) };
        let bytes = fs::read(&path)?;
        let mime = mime_for_ext(path.extension().and_then(|e| e.to_str()).unwrap_or(""));
        Ok(Some(encode_data_url(mime, &bytes)))
    }

    pub fn put_blobs(&self, blobs: &HashMap<String, String>) -> Result<()> {
        for (key, url) in blobs {
            if !safe_name(key) || self.has_blob(key) {
                continue;
            }
            let Some((mime, bytes)) = decode_data_url(url) else { continue };
            atomic_write(&self.assets_dir().join(format!("{key}.{}", ext_for_mime(&mime))), &bytes)?;
        }
        Ok(())
    }

    /// Store raw bytes (e.g. from the CLI) and return the blob key.
    pub fn put_blob_bytes(&self, bytes: &[u8], mime: &str) -> Result<String> {
        let key = format!("f{}-{}", fnv64(bytes), radix36(bytes.len() as u64));
        if !self.has_blob(&key) {
            atomic_write(&self.assets_dir().join(format!("{key}.{}", ext_for_mime(mime))), bytes)?;
        }
        Ok(key)
    }

    /// Delete asset files nothing refers to any more: no page, notebook,
    /// library index or page version. Run after a section is password
    /// protected so its pictures don't stay readable in `assets/`. Returns
    /// the deleted keys (the app forgets it stored them).
    pub fn prune_blobs(&self) -> Result<Vec<String>> {
        let mut used: HashSet<String> = HashSet::new();
        let mut collect = |v: &mut Value| {
            walk_strings(v, &mut |s| {
                if let Some(key) = s.strip_prefix(BLOB_PREFIX) {
                    used.insert(key.to_string());
                }
                None
            })
        };
        if let Some(mut v) = read_json(&self.root.join(LIBRARY_FILE))? {
            collect(&mut v);
        }
        let mut files = Vec::new();
        for dir in ["notebooks", "pages"] {
            files.extend(fs::read_dir(self.root.join(dir)).into_iter().flatten().filter_map(|e| e.ok()).map(|e| e.path()));
        }
        for d in fs::read_dir(self.root.join("versions")).into_iter().flatten().filter_map(|e| e.ok()) {
            files.extend(fs::read_dir(d.path()).into_iter().flatten().filter_map(|e| e.ok()).map(|e| e.path()));
        }
        for p in files.iter().filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json")) {
            if let Some(mut v) = read_json(p)? {
                collect(&mut v);
            }
        }
        let mut removed = Vec::new();
        for e in fs::read_dir(self.assets_dir()).into_iter().flatten().filter_map(|e| e.ok()) {
            let path = e.path();
            let Some(key) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
            if path.is_file() && safe_name(&key) && !used.contains(&key) {
                remove_if_exists(&path)?;
                removed.push(key);
            }
        }
        Ok(removed)
    }

    /// Replace every `notecraft-blob:<key>` string with the blob's data URL.
    pub fn inline_blobs(&self, value: &mut Value) {
        let mut cache: HashMap<String, Option<String>> = HashMap::new();
        walk_strings(value, &mut |s| {
            let key = s.strip_prefix(BLOB_PREFIX)?;
            cache.entry(key.to_string()).or_insert_with(|| self.get_blob(key).ok().flatten()).clone()
        });
    }

    // --- versions ---------------------------------------------------------------------------

    fn versions_dir(&self, page_id: &str) -> PathBuf {
        self.root.join("versions").join(page_id)
    }

    /// Version records for a page, newest first. Pictures stay as references.
    pub fn list_versions(&self, page_id: &str) -> Result<Vec<Value>> {
        if !safe_name(page_id) {
            return Err(Error::Invalid(format!("unsafe id {page_id:?}")));
        }
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(self.versions_dir(page_id)) else { return Ok(out) };
        for e in entries.filter_map(|e| e.ok()) {
            if e.path().extension().and_then(|x| x.to_str()) == Some("json") {
                if let Some(v) = read_json(&e.path())? {
                    out.push(v);
                }
            }
        }
        out.sort_by(|a, b| b["at"].as_str().unwrap_or("").cmp(a["at"].as_str().unwrap_or("")));
        Ok(out)
    }

    pub fn get_version(&self, id: &str) -> Result<Option<Value>> {
        if !safe_name(id) {
            return Err(Error::Invalid(format!("unsafe id {id:?}")));
        }
        let Ok(dirs) = fs::read_dir(self.root.join("versions")) else { return Ok(None) };
        for d in dirs.filter_map(|e| e.ok()) {
            let p = d.path().join(format!("{id}.json"));
            if p.is_file() {
                return read_json(&p);
            }
        }
        Ok(None)
    }

    pub fn commit_versions(&self, changes: VersionChanges) -> Result<()> {
        self.put_blobs(&changes.blobs)?;
        for v in &changes.put {
            let id = id_of(v)?;
            let page = v.get("pageId").and_then(Value::as_str).filter(|p| safe_name(p)).ok_or_else(|| Error::Invalid("version without a pageId".into()))?;
            write_json(&self.versions_dir(page).join(format!("{id}.json")), v)?;
        }
        if !changes.delete.is_empty() {
            if let Ok(dirs) = fs::read_dir(self.root.join("versions")) {
                for d in dirs.filter_map(|e| e.ok()) {
                    for id in changes.delete.iter().filter(|id| safe_name(id)) {
                        remove_if_exists(&d.path().join(format!("{id}.json")))?;
                    }
                }
            }
        }
        Ok(())
    }
}

/// Stand-in for a page whose file is missing, so the library still opens.
fn page_from_stub(stub: &Value) -> Value {
    let mut page = Map::new();
    for key in ["id", "title", "level", "createdAt", "modifiedAt"] {
        if let Some(v) = stub.get(key) {
            page.insert(key.into(), v.clone());
        }
    }
    page.entry("title").or_insert(json!(""));
    page.entry("level").or_insert(json!(1));
    page.insert("outlines".into(), json!([]));
    page.insert("images".into(), json!([]));
    Value::Object(page)
}

/// The page fields kept in a notebook manifest.
pub fn page_stub(page: &Value) -> Value {
    let mut stub = Map::new();
    for key in ["id", "title", "level", "createdAt", "modifiedAt"] {
        if let Some(v) = page.get(key) {
            stub.insert(key.into(), v.clone());
        }
    }
    Value::Object(stub)
}

fn walk_strings(v: &mut Value, f: &mut impl FnMut(&str) -> Option<String>) {
    match v {
        Value::String(s) => {
            if let Some(new) = f(s) {
                *s = new;
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| walk_strings(x, f)),
        Value::Object(o) => o.values_mut().for_each(|x| walk_strings(x, f)),
        _ => {}
    }
}

fn remove_if_exists(p: &Path) -> io::Result<()> {
    match fs::remove_file(p) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn fnv64(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn radix36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut s = Vec::new();
    loop {
        s.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, LibraryStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = LibraryStore::open(dir.path()).unwrap();
        (dir, s)
    }

    #[test]
    fn save_and_load_round_trip_with_blobs() {
        let (_d, s) = store();
        assert!(s.load(true).unwrap().is_none());
        let png = crate::util::encode_data_url("image/png", &[137, 80, 78, 71]);
        let page = json!({ "id": "p1", "title": "Hello", "level": 1, "createdAt": "x", "modifiedAt": "y", "outlines": [],
            "images": [{ "id": "i1", "x": 0, "y": 0, "width": 4, "height": 4, "src": "notecraft-blob:k1" }] });
        let nb = json!({ "id": "n1", "name": "NB", "color": "#000", "createdAt": "x",
            "sections": [{ "id": "s1", "name": "S", "color": "#111", "createdAt": "x", "pages": [page_stub(&page)] }] });
        s.save(SaveChanges {
            library: Some(json!({ "notebooks": ["n1"], "customTags": [] })),
            notebooks: vec![nb],
            pages: vec![page],
            blobs: HashMap::from([("k1".to_string(), png.clone())]),
            ..Default::default()
        })
        .unwrap();
        assert!(s.assets_dir().join("k1.png").is_file());
        let lib = s.load(true).unwrap().unwrap();
        assert_eq!(lib["notebooks"][0]["sections"][0]["pages"][0]["title"], "Hello");
        assert_eq!(lib["notebooks"][0]["sections"][0]["pages"][0]["images"][0]["src"], json!(png));
        let raw = s.load(false).unwrap().unwrap();
        assert_eq!(raw["notebooks"][0]["sections"][0]["pages"][0]["images"][0]["src"], "notecraft-blob:k1");

        s.save(SaveChanges { deleted_pages: vec!["p1".into()], ..Default::default() }).unwrap();
        let lib = s.load(false).unwrap().unwrap();
        assert_eq!(lib["notebooks"][0]["sections"][0]["pages"][0]["outlines"], json!([]), "missing page file falls back to its stub");
    }

    #[test]
    fn rejects_unsafe_ids() {
        let (_d, s) = store();
        assert!(s.write_page(&json!({ "id": "../../evil" })).is_err());
        assert!(s.read_page("a/b").is_err());
        s.put_blobs(&HashMap::from([("../x".to_string(), "data:text/plain,hi".to_string())])).unwrap();
        assert!(!s.root().join("x.txt").exists());
    }

    #[test]
    fn versions() {
        let (_d, s) = store();
        s.commit_versions(VersionChanges {
            put: vec![json!({ "id": "v1", "pageId": "p1", "at": "2026-01-01" }), json!({ "id": "v2", "pageId": "p1", "at": "2026-02-01" })],
            ..Default::default()
        })
        .unwrap();
        let list = s.list_versions("p1").unwrap();
        assert_eq!(list.iter().map(|v| v["id"].as_str().unwrap()).collect::<Vec<_>>(), ["v2", "v1"]);
        assert_eq!(s.get_version("v1").unwrap().unwrap()["at"], "2026-01-01");
        s.commit_versions(VersionChanges { delete: vec!["v2".into()], ..Default::default() }).unwrap();
        assert_eq!(s.list_versions("p1").unwrap().len(), 1);
    }

    #[test]
    fn prune_blobs_keeps_only_referenced_assets() {
        let (_d, s) = store();
        let url = |b: u8| crate::util::encode_data_url("image/png", &[137, 80, 78, b]);
        let page = json!({ "id": "p1", "title": "", "level": 1, "outlines": [], "images": [{ "id": "i", "src": "notecraft-blob:kpage" }] });
        s.save(SaveChanges {
            library: Some(json!({ "notebooks": ["n1"], "templates": [{ "page": { "images": [{ "src": "notecraft-blob:ktpl" }] } }] })),
            notebooks: vec![json!({ "id": "n1", "sections": [{ "id": "s1", "pages": [page_stub(&page)] }] })],
            pages: vec![page],
            blobs: HashMap::from([("kpage".into(), url(1)), ("ktpl".into(), url(2)), ("kgone".into(), url(3)), ("kver".into(), url(4))]),
            ..Default::default()
        })
        .unwrap();
        s.commit_versions(VersionChanges { put: vec![json!({ "id": "v1", "pageId": "p1", "at": "x", "page": { "images": [{ "src": "notecraft-blob:kver" }] } })], ..Default::default() }).unwrap();
        assert_eq!(s.prune_blobs().unwrap(), ["kgone"]);
        assert!(s.has_blob("kpage") && s.has_blob("ktpl") && s.has_blob("kver") && !s.has_blob("kgone"));
        // Once the version goes, so does its picture.
        s.commit_versions(VersionChanges { delete: vec!["v1".into()], ..Default::default() }).unwrap();
        assert_eq!(s.prune_blobs().unwrap(), ["kver"]);
    }
}
