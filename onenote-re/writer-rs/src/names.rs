//! File and folder names that Windows, OneDrive and macOS all accept, unique
//! within their folder.

use std::collections::HashSet;

/// Longest file or folder name (without `.one`), in characters. Notebook
/// paths nest, and OneDrive takes paths of up to 400 characters.
pub(crate) const NAME_LIMIT: usize = 100;

/// Device names Windows reserves, with or without an extension.
const RESERVED: [&str; 30] = [
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
    "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
];

/// `name` as one path component: characters Windows or OneDrive refuse
/// (`\ / : * ? " < > |` and control characters) become "_", tabs and line
/// breaks spaces, leading and
/// trailing spaces and trailing dots go, reserved device names (CON, NUL,
/// COM1…), a leading "~$", "_vti_" and the "^M" / "^J" sequences a table of
/// contents uses as escapes are defused, and the result is cut to `limit`
/// characters. Empty results become `fallback`.
pub(crate) fn safe_component(name: &str, fallback: &str, limit: usize) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if c.is_whitespace() {
                ' '
            } else if c.is_control() || "\\/:*?\"<>|".contains(c) || is_noncharacter(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    s = s.replace("^M", "_M").replace("^J", "_J");
    s = s.replace("_vti_", "_vti-");
    s = trim(&s).chars().take(limit).collect();
    s = trim(&s).to_string();
    if s.starts_with("~$") {
        s.replace_range(..1, "_");
    }
    if s.is_empty() {
        return fallback.to_string();
    }
    let stem_end = s.find('.').unwrap_or(s.len());
    let stem = s[..stem_end].trim_end();
    if RESERVED
        .iter()
        .any(|r| r.to_uppercase() == stem.to_uppercase())
    {
        s.insert(stem.len(), '_');
    }
    if s.eq_ignore_ascii_case("desktop.ini") || s.eq_ignore_ascii_case(".lock") {
        s = s.replace('.', "_");
    }
    s
}

/// Leading and trailing whitespace, and trailing dots (Windows drops them).
fn trim(s: &str) -> &str {
    let mut t = s.trim();
    loop {
        let next = t.trim_end_matches('.').trim_end();
        if next.len() == t.len() {
            return t;
        }
        t = next;
    }
}

fn is_noncharacter(c: char) -> bool {
    let v = c as u32;
    (0xfdd0..=0xfdef).contains(&v) || v & 0xfffe == 0xfffe
}

/// Hands out names unique within one folder, ignoring case (Windows,
/// macOS and OneDrive all do): "Notes", "Notes (2)", "Notes (3)"…
#[derive(Default)]
pub(crate) struct FolderNames {
    used: HashSet<String>,
}

impl FolderNames {
    /// Keep `name` (a section's name without `.one`, or a folder's name)
    /// from being handed out.
    pub fn reserve(&mut self, name: &str) {
        self.used.insert(key(name));
    }

    /// `base` if it is free, else the first free "base (n)".
    pub fn unique(&mut self, base: &str) -> String {
        if self.used.insert(key(base)) {
            return base.to_string();
        }
        for n in 2.. {
            let suffix = format!(" ({n})");
            let room = NAME_LIMIT.saturating_sub(suffix.chars().count());
            let head: String = base.chars().take(room).collect();
            let candidate = format!("{}{suffix}", head.trim_end());
            if self.used.insert(key(&candidate)) {
                return candidate;
            }
        }
        unreachable!("an unbounded range ends only by returning")
    }
}

fn key(name: &str) -> String {
    name.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_names_are_fixed() {
        let s = |n: &str| safe_component(n, "Section", NAME_LIMIT);
        assert_eq!(s("a/b:c?"), "a_b_c_");
        assert_eq!(s("  Trailing...  "), "Trailing");
        assert_eq!(s("dots . . ."), "dots");
        assert_eq!(s("CON"), "CON_");
        assert_eq!(s("con.notes"), "con_.notes");
        assert_eq!(s("Lpt1 "), "Lpt1_");
        assert_eq!(s("Console"), "Console");
        assert_eq!(s("~$temp"), "_$temp");
        assert_eq!(s("my_vti_files"), "my_vti-files");
        assert_eq!(s("a^Mb"), "a_Mb");
        assert_eq!(s("C++, notes"), "C++, notes");
        assert_eq!(s("\t\n"), "Section");
        assert_eq!(s("..."), "Section");
        assert_eq!(s("desktop.ini"), "desktop_ini");
        assert_eq!(s(&"x".repeat(300)).chars().count(), NAME_LIMIT);
        assert_eq!(s(&format!("{} .", "y".repeat(99))), "y".repeat(99));
    }

    #[test]
    fn names_are_unique_ignoring_case() {
        let mut f = FolderNames::default();
        f.reserve("OneNote_RecycleBin");
        assert_eq!(f.unique("Notes"), "Notes");
        assert_eq!(f.unique("notes"), "notes (2)");
        assert_eq!(f.unique("NOTES"), "NOTES (3)");
        assert_eq!(f.unique("onenote_recyclebin"), "onenote_recyclebin (2)");
        let long = "z".repeat(NAME_LIMIT);
        assert_eq!(f.unique(&long), long);
        let second = f.unique(&long);
        assert_eq!(second.chars().count(), NAME_LIMIT);
        assert!(second.ends_with(" (2)"));
    }
}
