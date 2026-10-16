//! File › Export › OneNote section (.one) or a whole notebook (a folder with
//! `.onetoc2` tables of contents and a `.one` per section), through the
//! writer in `onenote-re/writer-rs` ([MS-ONESTORE] revision store, [MS-ONE]
//! objects).

use serde::Serialize;
use serde_json::Value;

pub use onenote_writer::suggested_file_name;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneExport {
    pub bytes: Vec<u8>,
    pub file_name: String,
    /// What was left out or approximated.
    pub warnings: Vec<String>,
}

/// Write a section (Notecraft's model, pictures as data: URLs) as a `.one`
/// file to be saved as `file_name` (OneNote checks the name it was written
/// for; default: the section's name).
pub fn export_one(section: &Value, file_name: Option<&str>) -> Result<OneExport, String> {
    let file_name = file_name.map(str::to_string).unwrap_or_else(|| suggested_file_name(section));
    let out = onenote_writer::write_section_with(section, &onenote_writer::WriteOptions { file_name: Some(file_name.clone()) }).map_err(|e| e.to_string())?;
    Ok(OneExport { bytes: out.bytes, file_name, warnings: out.warnings })
}

/// A notebook as OneNote's folder of files: paths relative and '/'-separated,
/// starting with the notebook's folder name.
pub fn export_notebook(notebook: &Value) -> Result<onenote_writer::NotebookOutput, String> {
    onenote_writer::write_notebook(notebook).map_err(|e| e.to_string())
}

/// The notebook folder zipped, for the browser to download.
pub fn export_notebook_zip(notebook: &Value) -> Result<OneExport, String> {
    let out = export_notebook(notebook)?;
    let mut zip = crate::zipw::ZipWriter::default();
    for f in &out.files {
        zip.add(&f.path, &f.bytes);
    }
    let folder = out.files.first().and_then(|f| f.path.split('/').next()).unwrap_or("Notebook");
    Ok(OneExport { bytes: zip.finish(), file_name: format!("{folder}.zip"), warnings: out.warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_a_section_onenote_re_can_read() {
        let section = serde_json::json!({ "id": "s1", "name": "Plans: Q3", "color": "#4f7cac", "createdAt": "2026-10-01T09:00:00Z",
            "pages": [{ "id": "p1", "title": "Kickoff", "level": 1, "createdAt": "2026-10-01T09:00:00Z", "modifiedAt": "2026-10-01T09:00:00Z",
                "outlines": [{ "id": "o1", "x": 54, "y": 90, "width": 400, "elements": [{ "id": "e1", "kind": "text", "depth": 0, "style": "p", "runs": [{ "text": "Ship it" }] }] }], "images": [] }] });
        let out = export_one(&section, None).unwrap();
        assert_eq!(out.file_name, "Plans_ Q3.one");
        assert_eq!(&out.bytes[0x30..0x34], &[0x3f, 0xdd, 0x9a, 0x10]);
        assert!(export_one(&serde_json::json!("nope"), None).is_err());
    }
}
