//! Notecraft desktop: the web app in the system WebView, with a Rust backend
//! for the library folder, native menus, OneNote import and agent access.

mod ai;
mod engine;
mod files;
mod library;
mod menu;
mod onenote;

use tauri::Manager;

/// Where the bundled `notecraft` CLI is, and the MCP client config that runs it.
#[tauri::command]
fn agent_setup(state: tauri::State<'_, library::LibraryState>) -> serde_json::Value {
    let exe = std::env::current_exe().ok();
    let name = if cfg!(windows) { "notecraft.exe" } else { "notecraft" };
    let cli = exe.as_ref().and_then(|e| e.parent()).map(|d| d.join(name)).filter(|p| p.is_file());
    let cli_path = cli.map(|p| p.display().to_string()).unwrap_or_else(|| "notecraft".into());
    let library = state.root().display().to_string();
    serde_json::json!({
        "cli": cli_path,
        "library": library,
        "mcp": { "mcpServers": { "notecraft": { "command": cli_path, "args": ["mcp", "--library", library] } } },
    })
}

/// Test automation for development builds: with NOTECRAFT_AUTOMATION=<file.js>,
/// the script runs in the window and reports through this command (printed as
/// `AUTOMATION <json>`). Release builds ignore it.
#[tauri::command]
fn automation_report(app: tauri::AppHandle, value: serde_json::Value) {
    if cfg!(debug_assertions) && std::env::var_os("NOTECRAFT_AUTOMATION").is_some() {
        println!("AUTOMATION {value}");
        if value.get("exit").and_then(|v| v.as_bool()) == Some(true) {
            app.exit(0);
        }
    }
}

#[cfg(debug_assertions)]
fn run_automation(app: &tauri::App) {
    let Some(path) = std::env::var_os("NOTECRAFT_AUTOMATION") else { return };
    let Ok(script) = std::fs::read_to_string(path) else { return };
    let Some(window) = app.get_webview_window("main") else { return };
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        let _ = window.eval(script);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(onenote::AllowedFolders::default())
        .manage(onenote::Caches::default())
        .setup(|app| {
            let state = library::LibraryState::new(app.handle())?;
            app.manage(state);
            library::watch(app.handle());
            menu::install(app)?;
            #[cfg(debug_assertions)]
            run_automation(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library::library_info,
            library::library_load,
            library::library_save,
            library::library_set_location,
            library::blob_get,
            library::versions_list,
            library::versions_get,
            library::versions_commit,
            library::library_prune_blobs,
            files::save_file,
            files::open_external,
            files::reveal_library,
            files::pick_folder,
            files::print_page,
            onenote::onenote_scan,
            onenote::onenote_scan_folder,
            onenote::onenote_parse,
            onenote::onenote_toc,
            ai::ai_key_set,
            ai::ai_key_status,
            ai::ai_http,
            agent_setup,
            automation_report,
            engine::engine_crop,
            engine::engine_render_pdf,
            engine::engine_recognize_shape,
            engine::engine_mathml,
            engine::engine_export_docx,
            engine::engine_export_one,
            engine::engine_protect,
            engine::engine_unlock,
            engine::engine_reseal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Notecraft");
}
