//! File › Export › OneNote section (.one), through the writer in
//! `onenote-re/writer-rs` ([MS-ONESTORE] revision store, [MS-ONE] objects).

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
