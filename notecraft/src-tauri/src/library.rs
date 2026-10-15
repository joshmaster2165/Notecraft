//! The library folder on disk (see notecraft-core), the commands the web app
//! saves and loads through, and a watcher that tells the app when the CLI, an
//! agent or a sync tool changes the folder.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notecraft_core::{LibraryStore, SaveChanges, VersionChanges};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct LibraryState {
    store: Mutex<LibraryStore>,
    /// Content hashes of files this app wrote, so the watcher skips our own saves.
    written: Arc<Mutex<HashMap<PathBuf, u64>>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn read_settings(app: &AppHandle) -> Value {
    settings_path(app).and_then(|p| fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({}))
}

pub fn write_settings(app: &AppHandle, patch: Value) -> CmdResult<Value> {
    let mut s = read_settings(app);
    if let (Some(dst), Some(src)) = (s.as_object_mut(), patch.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    let path = settings_path(app).ok_or("no settings folder")?;
    fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(err)?;
    fs::write(&path, serde_json::to_vec_pretty(&s).map_err(err)?).map_err(err)?;
    Ok(s)
}

fn hash_bytes(b: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    b.hash(&mut h);
    h.finish()
}

impl LibraryState {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let root = read_settings(app)["libraryPath"].as_str().map(PathBuf::from).unwrap_or_else(LibraryStore::default_root);
        Ok(Self { store: Mutex::new(LibraryStore::open(root)?), written: Arc::new(Mutex::new(HashMap::new())), watcher: Mutex::new(None) })
    }

    pub fn root(&self) -> PathBuf {
        self.store.lock().map(|s| s.root().to_path_buf()).unwrap_or_default()
    }

    /// Remember what we just wrote so the watcher can tell our saves from others'.
    fn remember_writes(&self, root: &Path, changes: &SaveChanges) {
        let mut paths: Vec<PathBuf> = changes.pages.iter().filter_map(|p| p["id"].as_str()).map(|id| root.join("pages").join(format!("{id}.json"))).collect();
        paths.extend(changes.notebooks.iter().filter_map(|n| n["id"].as_str()).map(|id| root.join("notebooks").join(format!("{id}.json"))));
        if changes.library.is_some() {
            paths.push(root.join("library.json"));
        }
        if let Ok(mut w) = self.written.lock() {
            for p in paths {
                if let Ok(bytes) = fs::read(&p) {
                    w.insert(p, hash_bytes(&bytes));
                }
            }
        }
    }
}

// --- commands ------------------------------------------------------------------------------

#[tauri::command]
pub fn library_info(state: State<'_, LibraryState>) -> Value {
    let root = state.root();
    json!({ "path": root.display().to_string(), "exists": root.join("library.json").is_file() })
}

/// The whole library with pictures inlined, or null for a new library.
#[tauri::command]
pub fn library_load(state: State<'_, LibraryState>) -> CmdResult<Option<Value>> {
    state.store.lock().map_err(err)?.load(true).map_err(err)
}

#[tauri::command]
pub fn library_save(state: State<'_, LibraryState>, changes: SaveChanges) -> CmdResult<()> {
    let store = state.store.lock().map_err(err)?;
    let root = store.root().to_path_buf();
    let snapshot = SaveChanges {
        library: changes.library.clone(),
        notebooks: changes.notebooks.iter().map(|n| json!({ "id": n["id"] })).collect(),
        pages: changes.pages.iter().map(|p| json!({ "id": p["id"] })).collect(),
        ..Default::default()
    };
    store.save(changes).map_err(err)?;
    drop(store);
    state.remember_writes(&root, &snapshot);
    Ok(())
}

#[tauri::command]
pub fn blob_get(state: State<'_, LibraryState>, key: String) -> CmdResult<Option<String>> {
    state.store.lock().map_err(err)?.get_blob(&key).map_err(err)
}

#[tauri::command]
pub fn versions_list(state: State<'_, LibraryState>, page_id: String) -> CmdResult<Vec<Value>> {
    state.store.lock().map_err(err)?.list_versions(&page_id).map_err(err)
}

/// One version with its pictures inlined, ready to preview.
#[tauri::command]
pub fn versions_get(state: State<'_, LibraryState>, id: String) -> CmdResult<Option<Value>> {
    let store = state.store.lock().map_err(err)?;
    let mut v = store.get_version(&id).map_err(err)?;
    if let Some(v) = v.as_mut() {
        store.inline_blobs(v);
    }
    Ok(v)
}

#[tauri::command]
pub fn versions_commit(state: State<'_, LibraryState>, changes: VersionChanges) -> CmdResult<()> {
    state.store.lock().map_err(err)?.commit_versions(changes).map_err(err)
}

/// Point the app at another library folder (it is created if missing).
#[tauri::command]
pub fn library_set_location(app: AppHandle, state: State<'_, LibraryState>, path: String) -> CmdResult<Value> {
    let store = LibraryStore::open(&path).map_err(err)?;
    *state.store.lock().map_err(err)? = store;
    write_settings(&app, json!({ "libraryPath": path }))?;
    watch(&app);
    Ok(library_info(state))
}

// --- watching -----------------------------------------------------------------------------

/// (Re)start watching the library folder. Changes we didn't make are reported
/// to the web app as `library-changed` with the ids of changed pages and notebooks.
pub fn watch(app: &AppHandle) {
    let state = app.state::<LibraryState>();
    let root = state.root();
    let written = state.written.clone();
    let pending: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(Vec::new()));
    let timer = Arc::new(Mutex::new(0u64));
    let handle = app.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !(event.kind.is_create() || event.kind.is_modify() || event.kind.is_remove()) {
            return;
        }
        let relevant: Vec<PathBuf> = event
            .paths
            .into_iter()
            .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".json") && !n.contains(".tmp-")))
            .collect();
        // Requests from agents (`notecraft open`, MCP notecraft_open_page) to show something.
        let (control, relevant): (Vec<PathBuf>, Vec<PathBuf>) = relevant.into_iter().partition(|p| p.parent().and_then(|d| d.file_name()).is_some_and(|n| n == "control"));
        for path in control {
            run_control(&handle, &path);
        }
        if relevant.is_empty() {
            return;
        }
        pending.lock().unwrap_or_else(|e| e.into_inner()).extend(relevant);
        let tick = {
            let mut t = timer.lock().unwrap_or_else(|e| e.into_inner());
            *t += 1;
            *t
        };
        let (timer, pending, written, handle) = (timer.clone(), pending.clone(), written.clone(), handle.clone());
        // Debounce, then drop our own writes (by now their hashes are recorded).
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(350));
            if *timer.lock().unwrap_or_else(|e| e.into_inner()) != tick {
                return;
            }
            let paths = std::mem::take(&mut *pending.lock().unwrap_or_else(|e| e.into_inner()));
            let w = written.lock().unwrap_or_else(|e| e.into_inner());
            let (mut pages, mut notebooks, mut library) = (Vec::<String>::new(), Vec::<String>::new(), false);
            for path in paths {
                if let Ok(bytes) = fs::read(&path) {
                    if w.get(&path) == Some(&hash_bytes(&bytes)) {
                        continue;
                    }
                }
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                let id = name.trim_end_matches(".json").to_string();
                match path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) {
                    Some("pages") if !pages.contains(&id) => pages.push(id),
                    Some("notebooks") if !notebooks.contains(&id) => notebooks.push(id),
                    _ if name == "library.json" => library = true,
                    _ => {}
                }
            }
            drop(w);
            if !pages.is_empty() || !notebooks.is_empty() || library {
                let _ = handle.emit("library-changed", json!({ "pages": pages, "notebooks": notebooks, "library": library }));
            }
        });
    });
    // Requests left while the app was closed.
    if let Ok(entries) = fs::read_dir(root.join("control")) {
        for e in entries.filter_map(|e| e.ok()) {
            run_control(app, &e.path());
        }
    }
    match watcher {
        Ok(mut w) => {
            let _ = w.watch(&root, RecursiveMode::Recursive);
            if let Ok(mut slot) = state.watcher.lock() {
                *slot = Some(w);
            }
        }
        Err(e) => eprintln!("Notecraft: can't watch {}: {e}", root.display()),
    }
}

/// Hand a control request to the window and remove the file.
fn run_control(app: &AppHandle, path: &Path) {
    let Ok(bytes) = fs::read(path) else { return };
    let _ = fs::remove_file(path);
    if let Ok(request) = serde_json::from_slice::<Value>(&bytes) {
        let _ = app.emit("notecraft:control", request);
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
    }
}
