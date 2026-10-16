//! Native menus. Each custom item sends its id to the web app as a
//! `notecraft:command` event, the same commands the toolbar uses.

use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{App, Emitter, Wry};

pub fn install(app: &App<Wry>) -> tauri::Result<()> {
    let h = app.handle();
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, label);
        match accel {
            Some(a) => b.accelerator(a).build(h),
            None => b.build(h),
        }
    };

    let file = SubmenuBuilder::new(h, "File")
        .item(&item("newPage", "New Page", Some("CmdOrCtrl+N"))?)
        .item(&item("newSubpage", "New Subpage", Some("CmdOrCtrl+Shift+Alt+N"))?)
        .item(&item("newSection", "New Section", Some("CmdOrCtrl+T"))?)
        .item(&item("newSectionGroup", "New Section Group", None)?)
        .item(&item("newNotebook", "New Notebook", None)?)
        .separator()
        .item(&item("importFromOneNote", "Import from OneNote on This Computer…", None)?)
        .item(&item("importFolder", "Open OneNote Notebook Folder…", Some("CmdOrCtrl+Shift+O"))?)
        .item(&item("importFiles", "Import .one Files…", Some("CmdOrCtrl+O"))?)
        .item(&item("exportNotebook", "Export Notebook…", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item("exportMarkdown", "Export Page as Markdown…", None)?)
        .item(&item("exportWordPage", "Export Page as Word Document…", None)?)
        .item(&item("exportWordSection", "Export Section as Word Document…", None)?)
        .item(&item("exportOneSection", "Export Section as OneNote Section (.one)…", None)?)
        .item(&item("exportOneNotebook", "Export Notebook as OneNote Notebook…", None)?)
        .separator()
        .item(&item("lockAll", "Lock All Protected Sections", Some("CmdOrCtrl+Alt+L"))?)
        .separator()
        .item(&item("revealLibrary", "Show Library Folder", None)?)
        .item(&item("chooseLibrary", "Change Library Folder…", None)?)
        .separator()
        .item(&item("print", "Print…", Some("CmdOrCtrl+P"))?);
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().quit();

    let edit = SubmenuBuilder::new(h, "Edit")
        .item(&item("undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item("redo", "Redo", Some(if cfg!(target_os = "macos") { "Cmd+Shift+Z" } else { "Ctrl+Y" }))?)
        .separator()
        .cut()
        .copy()
        .paste()
        .item(&item("pastePlain", "Paste and Match Style", Some("CmdOrCtrl+Alt+Shift+V"))?)
        .select_all()
        .separator()
        .item(&item("find", "Find on Page", Some("CmdOrCtrl+F"))?)
        .item(&item("search", "Search All Notebooks", Some("CmdOrCtrl+E"))?)
        .item(&item("tags", "Find Tags", Some("CmdOrCtrl+Shift+T"))?)
        .separator()
        .item(&item("deletedNotes", "Deleted Notes", None)?);

    let view = SubmenuBuilder::new(h, "View")
        .item(&item("zoomIn", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item("zoomOut", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom100", "Actual Size", Some("CmdOrCtrl+0"))?)
        .item(&item("pageWidth", "Zoom to Page Width", None)?)
        .separator()
        .item(&item("fullPage", "Full Page View", Some("CmdOrCtrl+Shift+F"))?)
        // ⌃⌘S is the Mac sidebar shortcut; ⌘⌥1–6 belong to the paragraph styles.
        .item(&item("toggleNav", "Show or Hide Notebooks", Some(if cfg!(target_os = "macos") { "Ctrl+Cmd+S" } else { "Ctrl+Alt+S" }))?)
        .item(&item("togglePages", "Show or Hide Page List", Some(if cfg!(target_os = "macos") { "Ctrl+Cmd+Shift+S" } else { "Ctrl+Alt+Shift+S" }))?)
        .item(&item("versions", "Page Versions", Some("CmdOrCtrl+Shift+H"))?)
        .item(&item("templates", "Page Templates…", None)?)
        .separator()
        .fullscreen();

    let window = SubmenuBuilder::new(h, "Window").minimize().maximize().separator().close_window();
    let help = SubmenuBuilder::new(h, "Help").item(&item("help:github", "Notecraft on GitHub", None)?).item(&item("help:agents", "Connect AI Agents (CLI and MCP)…", None)?);

    let mut menu = MenuBuilder::new(h);
    #[cfg(target_os = "macos")]
    {
        let about = AboutMetadataBuilder::new().name(Some("Notecraft")).version(Some(env!("CARGO_PKG_VERSION"))).website(Some("https://github.com/joshmaster2165/Notecraft")).build();
        let app_menu = SubmenuBuilder::new(h, "Notecraft")
            .item(&PredefinedMenuItem::about(h, Some("About Notecraft"), Some(about))?)
            .separator()
            .item(&item("settings", "Settings…", Some("Cmd+,"))?)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = AboutMetadataBuilder::new();
    let menu = menu.item(&file.build()?).item(&edit.build()?).item(&view.build()?).item(&window.build()?).item(&help.build()?).build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        match id {
            "help:github" => {
                use tauri_plugin_opener::OpenerExt;
                let _ = app.opener().open_url("https://github.com/joshmaster2165/Notecraft", None::<&str>);
            }
            _ => {
                let _ = app.emit("notecraft:command", id);
            }
        }
    });
    Ok(())
}
