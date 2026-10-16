//! A whole notebook as the folder OneNote keeps it in ([MS-ONE] §1.3.4,
//! §2.1.15):
//!
//! ```text
//!   Work/                       the notebook (folder name = notebook name)
//!     Open Notebook.onetoc2     table of contents: order, colors, file identities
//!     Meetings.one              a section
//!     Projects/                 a section group
//!       Open Notebook.onetoc2   the group's own table of contents
//!       Plan.one
//! ```
//!
//! Each `.one` names the table of contents beside it in `guidAncestor`, and
//! each group's table of contents names its parent's ([MS-ONESTORE] §2.3.1).
//! Sections come first in a folder, in the notebook's order, then its
//! section groups (OneNote lists groups after sections). Names are made safe
//! for Windows, OneDrive and macOS and unique within their folder ignoring
//! case; a section keeps its exact name in SectionDisplayName.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::guid::Guid;
use crate::model::parse_color;
use crate::names::{safe_component, FolderNames, NAME_LIMIT};
use crate::toc::{write_toc, Toc, TocEntry, TOC_FILE_NAME};
use crate::{section_file, NotebookFile, NotebookOutput, WriteError, NAMESPACE};

/// What OneNote calls its recycle bin folder; readers skip it.
const RECYCLE_BIN: &str = "OneNote_RecycleBin";
/// OneDrive's limit on a path.
const PATH_LIMIT: usize = 400;

struct Group {
    id: String,
    name: String,
    parent: Option<usize>,
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn write_notebook(notebook: &Value) -> Result<NotebookOutput, WriteError> {
    if !notebook.is_object() {
        return Err(WriteError::InvalidInput("expected a JSON object".into()));
    }
    let mut warnings = Vec::new();
    let name = text(notebook, "name");
    let id = text(notebook, "id");
    let ns = Guid::name_based(
        NAMESPACE,
        &if id.is_empty() {
            format!("notebook:name:{name}")
        } else {
            format!("notebook:{id}")
        },
    );
    let folder = safe_component(name, "Notebook", NAME_LIMIT);
    if folder != name {
        warnings.push(format!(
            "the notebook “{name}” is saved as the folder “{folder}”"
        ));
    }
    let color = parse_color(text(notebook, "color")).map(|c| c.colorref());

    let groups = read_groups(notebook, &mut warnings);
    let by_id: HashMap<&str, usize> = groups
        .iter()
        .enumerate()
        .map(|(i, g)| (g.id.as_str(), i))
        .collect();

    // Sections by folder (None = the notebook's), in the notebook's order.
    let mut sections: HashMap<Option<usize>, Vec<&Value>> = HashMap::new();
    let empty = Vec::new();
    for s in notebook
        .get("sections")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
    {
        if !s.is_object() {
            warnings.push("a section that is not an object was left out".into());
            continue;
        }
        let name = text(s, "name");
        let locked = s.get("locked").is_some_and(Value::is_object);
        let no_pages = s
            .get("pages")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty);
        if locked && no_pages {
            warnings.push(format!(
                "the section “{name}” is locked, so it was left out (unlock it to export it)"
            ));
            continue;
        }
        let group = match s.get("groupId").and_then(Value::as_str) {
            None | Some("") => None,
            Some(g) => match by_id.get(g) {
                Some(&i) => Some(i),
                None => {
                    warnings.push(format!(
                        "the section “{name}” belongs to a missing section group, so it was put at the top of the notebook"
                    ));
                    None
                }
            },
        };
        sections.entry(group).or_default().push(s);
    }
    let mut children: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
    for (i, g) in groups.iter().enumerate() {
        children.entry(g.parent).or_default().push(i);
    }

    let toc_guid = |group: Option<usize>| match group {
        None => Guid::name_based(ns, "toc"),
        Some(g) => Guid::name_based(ns, &format!("toc:group:{}", groups[g].id)),
    };

    let mut files: Vec<NotebookFile> = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();
    // Depth first, without recursion: (group, folder path, parent TOC).
    let mut stack: Vec<(Option<usize>, String, Guid)> = vec![(None, folder, Guid::NIL)];
    while let Some((group, dir, ancestor)) = stack.pop() {
        let guid_file = toc_guid(group);
        let toc_at = files.len();
        files.push(NotebookFile {
            path: format!("{dir}/{TOC_FILE_NAME}"),
            bytes: Vec::new(),
        });
        let mut names = FolderNames::default();
        names.reserve(RECYCLE_BIN);
        names.reserve(TOC_FILE_NAME);
        let mut entries = Vec::new();

        for s in sections.get(&group).map_or(&[][..], Vec::as_slice) {
            let name = text(s, "name");
            let stem = names.unique(&safe_component(name, "Untitled Section", NAME_LIMIT));
            let file_name = format!("{stem}.one");
            let rel = relative(&dir, &file_name);
            if stem != name {
                warnings.push(format!("the section “{name}” is saved as “{rel}”"));
            }
            // A section's identity is its id; a repeated id gets its own.
            let id = text(s, "id");
            let mut key = if id.is_empty() {
                format!("name:{name}")
            } else {
                id.to_string()
            };
            if !seen_keys.insert(key.clone()) {
                if !id.is_empty() {
                    warnings.push(format!(
                        "two sections have the id “{id}”; “{rel}” was given a new identity"
                    ));
                }
                let base = key.clone();
                let mut n = 2;
                while !seen_keys.insert(format!("{base}#{n}")) {
                    n += 1;
                }
                key = format!("{base}#{n}");
            }
            let out = section_file(s, Some(&key), &file_name, guid_file)?;
            warnings.extend(out.warnings.into_iter().map(|w| format!("{rel}: {w}")));
            entries.push(TocEntry {
                file_name: file_name.clone(),
                guid: out.guid_file,
                color: Some(parse_color(text(s, "color")).map_or(u32::MAX, |c| c.colorref())),
            });
            files.push(NotebookFile {
                path: format!("{dir}/{file_name}"),
                bytes: out.bytes,
            });
        }

        let mut subfolders = Vec::new();
        for &g in children.get(&group).map_or(&[][..], Vec::as_slice) {
            let name = &groups[g].name;
            let mut safe = safe_component(name, "Section Group", NAME_LIMIT);
            // A folder called "X.one" would pass for a section file.
            let lower = safe.to_lowercase();
            if lower.ends_with(".one") || lower.ends_with(".onetoc2") {
                if let Some(dot) = safe.rfind('.') {
                    safe.replace_range(dot..=dot, "_");
                }
            }
            let folder_name = names.unique(&safe);
            if &folder_name != name {
                warnings.push(format!(
                    "the section group “{name}” is saved as the folder “{}”",
                    relative(&dir, &folder_name)
                ));
            }
            entries.push(TocEntry {
                file_name: folder_name.clone(),
                guid: toc_guid(Some(g)),
                color: None,
            });
            subfolders.push((Some(g), format!("{dir}/{folder_name}"), guid_file));
        }
        stack.extend(subfolders.into_iter().rev());

        files[toc_at].bytes = write_toc(&Toc {
            guid_file,
            guid_ancestor: ancestor,
            color: if group.is_none() { color } else { None },
            entries,
        })?;
    }

    if let Some(long) = files.iter().find(|f| f.path.chars().count() > PATH_LIMIT) {
        warnings.push(format!(
            "“{}” is longer than the {PATH_LIMIT} characters OneDrive accepts in a path",
            long.path
        ));
    }
    Ok(NotebookOutput { files, warnings })
}

/// A path inside the notebook folder, for warnings ("Projects/Plan.one").
fn relative(dir: &str, name: &str) -> String {
    match dir.split_once('/') {
        Some((_, rest)) => format!("{rest}/{name}"),
        None => name.to_string(),
    }
}

/// Section groups with their parents resolved: unknown parents and cycles
/// put a group at the top of the notebook.
fn read_groups(notebook: &Value, warnings: &mut Vec<String>) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    let mut parent_ids: Vec<String> = Vec::new();
    let mut ids: HashSet<String> = HashSet::new();
    let empty = Vec::new();
    for (i, g) in notebook
        .get("groups")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .enumerate()
    {
        if !g.is_object() {
            warnings.push("a section group that is not an object was left out".into());
            continue;
        }
        let name = text(g, "name");
        let mut id = text(g, "id").to_string();
        if id.is_empty() {
            id = format!("#{i}");
        }
        if !ids.insert(id.clone()) {
            warnings.push(format!(
                "two section groups have the id “{id}”; the second, “{name}”, was left out"
            ));
            continue;
        }
        groups.push(Group {
            id,
            name: name.to_string(),
            parent: None,
        });
        parent_ids.push(text(g, "parentId").to_string());
    }
    let index: HashMap<String, usize> = groups
        .iter()
        .enumerate()
        .map(|(i, g)| (g.id.clone(), i))
        .collect();
    for (i, p) in parent_ids.iter().enumerate() {
        if p.is_empty() {
            continue;
        }
        match index.get(p) {
            Some(&j) if j != i => groups[i].parent = Some(j),
            _ => warnings.push(format!(
                "the section group “{}” has a missing parent, so it was put at the top of the notebook",
                groups[i].name
            )),
        }
    }
    // Break cycles: a group whose ancestors lead back to it moves to the top.
    let n = groups.len();
    for i in 0..n {
        let mut cur = groups[i].parent;
        let mut steps = 0;
        while let Some(p) = cur {
            if p == i {
                warnings.push(format!(
                    "the section group “{}” was inside itself, so it was put at the top of the notebook",
                    groups[i].name
                ));
                groups[i].parent = None;
                break;
            }
            steps += 1;
            if steps > n {
                break;
            }
            cur = groups[p].parent;
        }
    }
    groups
}
