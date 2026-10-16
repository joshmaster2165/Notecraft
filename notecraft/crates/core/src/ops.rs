//! What agents and the CLI can do with a library: list, search, read and
//! edit notes. Every change is written straight to the library folder; a
//! running Notecraft app picks it up from there.

use serde_json::{json, Value};

use crate::markdown::{markdown_elements, page_markdown, page_text, runs_text};
use crate::store::{page_stub, Error, LibraryStore, Result};
use crate::util::{new_id, now_iso};

const SECTION_COLORS: [&str; 8] = ["#4f7cac", "#c46a2f", "#5b8c5a", "#9a5fb0", "#c2464f", "#3c9a9a", "#b08a2e", "#6b6f80"];
const TRASH_LIMIT_DAYS: i64 = 60;

/// Notebooks, sections and page titles (no page content).
pub fn outline(store: &LibraryStore) -> Result<Value> {
    let mut notebooks = Vec::new();
    for id in store.notebook_ids()? {
        let Some(nb) = store.read_notebook(&id)? else { continue };
        let groups = nb["groups"].clone();
        let group_name = |gid: &str| groups.as_array().into_iter().flatten().find(|g| g["id"] == gid).and_then(|g| g["name"].as_str()).map(String::from);
        let sections: Vec<Value> = nb["sections"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| {
                let mut out = json!({
                    "id": s["id"], "name": s["name"],
                    "pages": s["pages"].as_array().into_iter().flatten().map(|p| json!({ "id": p["id"], "title": p["title"], "level": p["level"], "modifiedAt": p["modifiedAt"] })).collect::<Vec<_>>(),
                });
                if let Some(g) = s["groupId"].as_str().and_then(group_name) {
                    out["group"] = json!(g);
                }
                if !s["locked"].is_null() {
                    out["locked"] = json!(true);
                }
                out
            })
            .collect();
        notebooks.push(json!({ "id": nb["id"], "name": nb["name"], "sections": sections }));
    }
    Ok(json!({ "library": store.root().display().to_string(), "notebooks": notebooks }))
}

struct PageLoc {
    notebook: Value,
    section: usize,
    index: usize,
}

fn locate_page(store: &LibraryStore, page_id: &str) -> Result<PageLoc> {
    for id in store.notebook_ids()? {
        let Some(nb) = store.read_notebook(&id)? else { continue };
        for (si, s) in nb["sections"].as_array().into_iter().flatten().enumerate() {
            if let Some(pi) = s["pages"].as_array().into_iter().flatten().position(|p| p["id"] == page_id) {
                return Ok(PageLoc { notebook: nb.clone(), section: si, index: pi });
            }
        }
    }
    Err(Error::NotFound(format!("page {page_id}")))
}

fn locate_section(store: &LibraryStore, section_id: &str) -> Result<(Value, usize)> {
    for id in store.notebook_ids()? {
        let Some(nb) = store.read_notebook(&id)? else { continue };
        if let Some(si) = nb["sections"].as_array().into_iter().flatten().position(|s| s["id"] == section_id) {
            return Ok((nb, si));
        }
    }
    Err(Error::NotFound(format!("section {section_id}")))
}

/// Resolve a section by id, or by name ("Notebook/Section" or just "Section").
pub fn find_section(store: &LibraryStore, id_or_name: &str) -> Result<String> {
    if locate_section(store, id_or_name).is_ok() {
        return Ok(id_or_name.to_string());
    }
    let (nb_name, sec_name) = id_or_name.split_once('/').map(|(a, b)| (Some(a), b)).unwrap_or((None, id_or_name));
    for id in store.notebook_ids()? {
        let Some(nb) = store.read_notebook(&id)? else { continue };
        if nb_name.is_some_and(|n| !nb["name"].as_str().unwrap_or("").eq_ignore_ascii_case(n)) {
            continue;
        }
        if let Some(s) = nb["sections"].as_array().into_iter().flatten().find(|s| s["name"].as_str().unwrap_or("").eq_ignore_ascii_case(sec_name)) {
            return Ok(s["id"].as_str().unwrap_or_default().to_string());
        }
    }
    Err(Error::NotFound(format!("section {id_or_name}")))
}

pub fn read_page(store: &LibraryStore, page_id: &str) -> Result<Value> {
    store.read_page(page_id)?.ok_or_else(|| Error::NotFound(format!("page {page_id}")))
}

/// A page as Markdown with its location, for agents.
pub fn read_page_markdown(store: &LibraryStore, page_id: &str) -> Result<Value> {
    let page = read_page(store, page_id)?;
    let loc = locate_page(store, page_id)?;
    let section = &loc.notebook["sections"][loc.section];
    Ok(json!({
        "id": page_id,
        "title": page["title"],
        "notebook": loc.notebook["name"],
        "section": section["name"],
        "modifiedAt": page["modifiedAt"],
        "markdown": page_markdown(&page),
    }))
}

/// Case-insensitive search over titles, notes, table cells and picture text.
pub fn search(store: &LibraryStore, query: &str, notebook: Option<&str>, limit: usize) -> Result<Vec<Value>> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut hits = Vec::new();
    for id in store.notebook_ids()? {
        let Some(nb) = store.read_notebook(&id)? else { continue };
        if notebook.is_some_and(|n| nb["id"] != n && !nb["name"].as_str().unwrap_or("").eq_ignore_ascii_case(n)) {
            continue;
        }
        for s in nb["sections"].as_array().into_iter().flatten() {
            for stub in s["pages"].as_array().into_iter().flatten() {
                let Some(pid) = stub["id"].as_str() else { continue };
                let Some(page) = store.read_page(pid)? else { continue };
                let text = page_text(&page);
                let lower = text.to_lowercase();
                let Some(at) = lower.find(&q) else { continue };
                let start = lower[..at].char_indices().rev().nth(50).map(|(i, _)| i).unwrap_or(0);
                let end = lower[at..].char_indices().nth(q.chars().count() + 80).map(|(i, _)| at + i).unwrap_or(text.len());
                let snippet = text.get(start..end).unwrap_or("").replace('\n', " ");
                hits.push(json!({ "pageId": pid, "title": page["title"], "notebook": nb["name"], "section": s["name"], "snippet": snippet }));
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

/// Open to-dos (or all checkable tags) across the library.
pub fn todos(store: &LibraryStore, include_done: bool) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for id in store.notebook_ids()? {
        let Some(nb) = store.read_notebook(&id)? else { continue };
        for s in nb["sections"].as_array().into_iter().flatten() {
            for stub in s["pages"].as_array().into_iter().flatten() {
                let Some(pid) = stub["id"].as_str() else { continue };
                let Some(page) = store.read_page(pid)? else { continue };
                for o in page["outlines"].as_array().into_iter().flatten() {
                    for el in o["elements"].as_array().into_iter().flatten() {
                        for t in el["tags"].as_array().into_iter().flatten() {
                            let Some(done) = t["done"].as_bool() else { continue };
                            if done && !include_done {
                                continue;
                            }
                            out.push(json!({ "pageId": pid, "elementId": el["id"], "page": page["title"], "section": s["name"], "text": runs_text(&el["runs"]), "done": done, "tag": t["label"].as_str().or(t["kind"].as_str()) }));
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

fn update_library_index(store: &LibraryStore, add_notebook: Option<&str>) -> Result<()> {
    let mut lib = store.read_library_file()?;
    if let Some(id) = add_notebook {
        let list = lib["notebooks"].as_array_mut();
        match list {
            Some(a) if !a.iter().any(|v| v == id) => a.push(json!(id)),
            Some(_) => {}
            None => lib["notebooks"] = json!([id]),
        }
    }
    store.write_library_file(&lib)
}

pub fn create_notebook(store: &LibraryStore, name: &str) -> Result<String> {
    let now = now_iso();
    let page = new_page("", &now, vec![]);
    let section = json!({ "id": new_id("s"), "name": "New Section", "color": SECTION_COLORS[0], "createdAt": now, "pages": [page_stub(&page)] });
    let nb = json!({ "id": new_id("n"), "name": name, "color": "#1f3a5f", "createdAt": now, "sections": [section] });
    store.write_page(&page)?;
    store.write_notebook(&nb)?;
    let id = nb["id"].as_str().unwrap_or_default().to_string();
    update_library_index(store, Some(&id))?;
    Ok(id)
}

pub fn create_section(store: &LibraryStore, notebook_id: &str, name: &str) -> Result<String> {
    let mut nb = store.read_notebook(notebook_id)?.ok_or_else(|| Error::NotFound(format!("notebook {notebook_id}")))?;
    let count = nb["sections"].as_array().map(Vec::len).unwrap_or(0);
    let now = now_iso();
    let page = new_page("", &now, vec![]);
    let id = new_id("s");
    let section = json!({ "id": id, "name": name, "color": SECTION_COLORS[count % SECTION_COLORS.len()], "createdAt": now, "pages": [page_stub(&page)] });
    store.write_page(&page)?;
    match nb["sections"].as_array_mut() {
        Some(a) => a.push(section),
        None => nb["sections"] = json!([section]),
    }
    store.write_notebook(&nb)?;
    Ok(id)
}

fn new_page(title: &str, now: &str, elements: Vec<Value>) -> Value {
    let outlines = if elements.is_empty() {
        json!([])
    } else {
        json!([{ "id": new_id("o"), "x": 54, "y": 90, "width": 520, "widthSetByUser": false, "elements": elements }])
    };
    json!({ "id": new_id("p"), "title": title, "level": 1, "createdAt": now, "modifiedAt": now, "outlines": outlines, "images": [] })
}

/// A new page at the end of a section, with Markdown as its notes.
pub fn create_page(store: &LibraryStore, section: &str, title: &str, markdown: &str) -> Result<String> {
    let section_id = find_section(store, section)?;
    let (mut nb, si) = locate_section(store, &section_id)?;
    if !nb["sections"][si]["locked"].is_null() {
        // Its pages are sealed inside the notebook file; a plain page added here would be lost on unlock.
        return Err(Error::Invalid(format!("section {section_id} is password protected: unlock it in Notecraft first")));
    }
    let page = new_page(title, &now_iso(), markdown_elements(markdown));
    store.write_page(&page)?;
    if let Some(pages) = nb["sections"][si]["pages"].as_array_mut() {
        pages.push(page_stub(&page));
    }
    store.write_notebook(&nb)?;
    Ok(page["id"].as_str().unwrap_or_default().to_string())
}

fn touch(store: &LibraryStore, page: &mut Value, loc: &mut PageLoc) -> Result<()> {
    page["modifiedAt"] = json!(now_iso());
    store.write_page(page)?;
    loc.notebook["sections"][loc.section]["pages"][loc.index] = page_stub(page);
    store.write_notebook(&loc.notebook)
}

/// Add Markdown notes to the end of a page's last note container.
pub fn append_markdown(store: &LibraryStore, page_id: &str, markdown: &str) -> Result<usize> {
    let mut loc = locate_page(store, page_id)?;
    let mut page = read_page(store, page_id)?;
    let elements = markdown_elements(markdown);
    let n = elements.len();
    let outlines = page["outlines"].as_array_mut().ok_or_else(|| Error::Invalid("page has no outlines".into()))?;
    // The lowest container on the page is where writing continues.
    let target = outlines.iter_mut().max_by(|a, b| a["y"].as_f64().unwrap_or(0.0).partial_cmp(&b["y"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    match target {
        Some(o) => o["elements"].as_array_mut().into_iter().for_each(|els| els.extend(elements.clone())),
        None => outlines.push(json!({ "id": new_id("o"), "x": 54, "y": 90, "width": 520, "widthSetByUser": false, "elements": elements })),
    }
    touch(store, &mut page, &mut loc)?;
    Ok(n)
}

pub fn rename_page(store: &LibraryStore, page_id: &str, title: &str) -> Result<()> {
    let mut loc = locate_page(store, page_id)?;
    let mut page = read_page(store, page_id)?;
    page["title"] = json!(title);
    touch(store, &mut page, &mut loc)
}

/// Check or uncheck a to-do (any checkable tag) on a paragraph.
pub fn set_todo(store: &LibraryStore, page_id: &str, element_id: &str, done: bool) -> Result<()> {
    let mut loc = locate_page(store, page_id)?;
    let mut page = read_page(store, page_id)?;
    let mut found = false;
    fn walk(els: &mut Value, id: &str, done: bool, found: &mut bool) {
        for el in els.as_array_mut().into_iter().flatten() {
            if el["id"] == id {
                match el["tags"].as_array_mut() {
                    Some(tags) if tags.iter().any(|t| t.get("done").is_some()) => {
                        tags.iter_mut().filter(|t| t.get("done").is_some()).for_each(|t| t["done"] = json!(done));
                    }
                    Some(tags) => tags.push(json!({ "kind": "todo", "done": done })),
                    None => el["tags"] = json!([{ "kind": "todo", "done": done }]),
                }
                *found = true;
            }
            for row in el["rows"].as_array_mut().into_iter().flatten() {
                for cell in row["cells"].as_array_mut().into_iter().flatten() {
                    walk(&mut cell["elements"], id, done, found);
                }
            }
        }
    }
    for o in page["outlines"].as_array_mut().into_iter().flatten() {
        walk(&mut o["elements"], element_id, done, &mut found);
    }
    if !found {
        return Err(Error::NotFound(format!("paragraph {element_id}")));
    }
    touch(store, &mut page, &mut loc)
}

/// Move a page to its notebook's Deleted Notes (restorable for 60 days in the app).
pub fn delete_page(store: &LibraryStore, page_id: &str) -> Result<()> {
    let mut loc = locate_page(store, page_id)?;
    let page = read_page(store, page_id)?;
    let section = loc.notebook["sections"][loc.section].clone();
    if let Some(pages) = loc.notebook["sections"][loc.section]["pages"].as_array_mut() {
        pages.remove(loc.index);
    }
    let item = json!({ "kind": "page", "page": page, "sectionId": section["id"], "sectionName": section["name"], "deletedAt": now_iso() });
    match loc.notebook["trash"].as_array_mut() {
        Some(t) => t.push(item),
        None => loc.notebook["trash"] = json!([item]),
    }
    store.write_notebook(&loc.notebook)?;
    store.save(crate::SaveChanges { deleted_pages: vec![page_id.to_string()], ..Default::default() })?;
    let _ = TRASH_LIMIT_DAYS;
    Ok(())
}

/// A notebook as a portable `.notecraft.json` export (pictures inlined).
pub fn export_notebook(store: &LibraryStore, notebook_id: &str) -> Result<Value> {
    let lib = store.load(true)?.ok_or_else(|| Error::NotFound("library".into()))?;
    let nb = lib["notebooks"].as_array().into_iter().flatten().find(|n| n["id"] == notebook_id || n["name"].as_str().is_some_and(|x| x.eq_ignore_ascii_case(notebook_id))).cloned();
    let nb = nb.ok_or_else(|| Error::NotFound(format!("notebook {notebook_id}")))?;
    Ok(json!({ "notecraft": 1, "notebook": nb }))
}

/// Ask a running Notecraft app to show something (open a page, run a search).
/// Requests are small files in the library's `control/` folder; the app
/// handles and removes them; one left over is handled when the app next starts.
pub fn request_ui(store: &LibraryStore, request: Value) -> Result<std::path::PathBuf> {
    let action = request["action"].as_str().unwrap_or("");
    if !matches!(action, "openPage" | "search" | "openSection") {
        return Err(Error::Invalid(format!("unknown UI action {action:?}")));
    }
    let name = format!("{}-{}.json", now_iso().replace([':', '.'], "-"), new_id("r"));
    let path = store.root().join("control").join(name);
    crate::util::atomic_write(&path, serde_json::to_string(&request)?.as_bytes())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_workflow() {
        let dir = tempfile::tempdir().unwrap();
        let store = LibraryStore::open(dir.path()).unwrap();
        let nb = create_notebook(&store, "Work").unwrap();
        let sec = create_section(&store, &nb, "Meetings").unwrap();
        assert_eq!(find_section(&store, "work/meetings").unwrap(), sec);
        let page = create_page(&store, "Meetings", "Standup", "## Notes\n- [ ] Ship the release\n- Shipped **v2**").unwrap();
        append_markdown(&store, &page, "- [ ] Write the changelog").unwrap();

        let open = todos(&store, false).unwrap();
        assert_eq!(open.iter().map(|t| t["text"].as_str().unwrap()).collect::<Vec<_>>(), ["Ship the release", "Write the changelog"]);
        set_todo(&store, &page, open[0]["elementId"].as_str().unwrap(), true).unwrap();
        assert_eq!(todos(&store, false).unwrap().len(), 1);

        let hits = search(&store, "changelog", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["section"], "Meetings");
        let md = read_page_markdown(&store, &page).unwrap();
        assert!(md["markdown"].as_str().unwrap().contains("- [x] Ship the release"));

        rename_page(&store, &page, "Daily standup").unwrap();
        let tree = outline(&store).unwrap();
        let titles: Vec<_> = tree["notebooks"][0]["sections"][1]["pages"].as_array().unwrap().iter().map(|p| p["title"].as_str().unwrap().to_string()).collect();
        assert_eq!(titles, ["", "Daily standup"]);

        // The app's view of the same folder.
        let lib = store.load(false).unwrap().unwrap();
        assert_eq!(lib["notebooks"][0]["sections"][1]["pages"][1]["outlines"][0]["elements"].as_array().unwrap().len(), 4);

        delete_page(&store, &page).unwrap();
        assert!(store.read_page(&page).unwrap().is_none());
        assert_eq!(store.read_notebook(&nb).unwrap().unwrap()["trash"][0]["page"]["title"], "Daily standup");
        assert_eq!(export_notebook(&store, "work").unwrap()["notecraft"], 1);
    }
}
