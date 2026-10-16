//! Timestamps: ISO 8601 strings from Notecraft to the two clocks [MS-ONE]
//! uses, Time32 (seconds since 1980-01-01 UTC, §2.3.1) and FILETIME (100 ns
//! ticks since 1601-01-01 UTC), plus the page title's date and time lines.

/// Milliseconds since 1970-01-01T00:00:00Z.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Timestamp(pub i64);

const MS_1601_TO_1970: i64 = 11_644_473_600_000;
const S_1970_TO_1980: i64 = 315_532_800;

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

impl Timestamp {
    /// `YYYY-MM-DD[THH:MM[:SS[.fff…]]][Z|±HH:MM]`; a missing offset means UTC.
    pub fn parse_iso(s: &str) -> Option<Timestamp> {
        let s = s.trim();
        let b = s.as_bytes();
        let n = |from: usize, len: usize| -> Option<i64> {
            let t = s.get(from..from + len)?;
            t.bytes()
                .all(|c| c.is_ascii_digit())
                .then(|| t.parse().ok())?
        };
        let year = n(0, 4)?;
        if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
            return None;
        }
        let (month, day) = (n(5, 2)?, n(8, 2)?);
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        let mut ms = days_from_civil(year, month, day) * 86_400_000;
        let mut i = 10;
        if matches!(b.get(i), Some(b'T' | b't' | b' ')) {
            let (hh, mm) = (n(i + 1, 2)?, n(i + 4, 2)?);
            if b.get(i + 3) != Some(&b':') || hh > 24 || mm > 59 {
                return None;
            }
            ms += (hh * 3600 + mm * 60) * 1000;
            i += 6;
            if b.get(i) == Some(&b':') {
                let ss = n(i + 1, 2)?;
                if ss > 60 {
                    return None;
                }
                ms += ss * 1000;
                i += 3;
                if b.get(i) == Some(&b'.') {
                    i += 1;
                    let start = i;
                    while b.get(i).is_some_and(u8::is_ascii_digit) {
                        i += 1;
                    }
                    let frac = &s[start..i];
                    let digits: String = frac.chars().chain("000".chars()).take(3).collect();
                    ms += digits.parse::<i64>().ok()?;
                }
            }
        }
        match b.get(i) {
            None | Some(b'Z' | b'z') => {}
            Some(b'+' | b'-') => {
                let sign = if b[i] == b'+' { 1 } else { -1 };
                let oh = n(i + 1, 2)?;
                let om = if b.get(i + 3) == Some(&b':') {
                    n(i + 4, 2)?
                } else {
                    n(i + 3, 2).unwrap_or(0)
                };
                ms -= sign * (oh * 3600 + om * 60) * 1000;
            }
            _ => return None,
        }
        Some(Timestamp(ms))
    }

    /// Time32, clamped to 1980-01-01 … 2116 (0 is reserved for "none").
    pub fn time32(self) -> u32 {
        (self.0.div_euclid(1000) - S_1970_TO_1980).clamp(1, i64::from(u32::MAX)) as u32
    }

    /// FILETIME.
    pub fn filetime(self) -> u64 {
        (self.0 + MS_1601_TO_1970).max(0) as u64 * 10_000
    }

    /// "Friday, January 01, 2010" (UTC), as OneNote writes a title's date.
    pub fn title_date(self) -> String {
        const WEEKDAYS: [&str; 7] = [
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
        ];
        const MONTHS: [&str; 12] = [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ];
        let days = self.0.div_euclid(86_400_000);
        let (y, m, d) = civil_from_days(days);
        let weekday = WEEKDAYS[days.rem_euclid(7) as usize];
        format!("{weekday}, {} {d:02}, {y}", MONTHS[(m - 1) as usize])
    }

    /// "12:00 PM" (UTC).
    pub fn title_time(self) -> String {
        let secs = self.0.div_euclid(1000).rem_euclid(86_400);
        let (h, m) = (secs / 3600, secs / 60 % 60);
        let h12 = if h % 12 == 0 { 12 } else { h % 12 };
        format!("{h12}:{m:02} {}", if h < 12 { "AM" } else { "PM" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_8601() {
        let t = Timestamp::parse_iso("2010-01-01T12:00:00.000Z").unwrap();
        assert_eq!(t.0, 1_262_347_200_000);
        assert_eq!(Timestamp::parse_iso("2010-01-01T13:00:00+01:00"), Some(t));
        assert_eq!(
            Timestamp::parse_iso("2010-01-01T12:00:00.5Z").unwrap().0,
            t.0 + 500
        );
        assert_eq!(
            Timestamp::parse_iso("2010-01-01").unwrap().0,
            1_262_304_000_000
        );
        assert_eq!(Timestamp::parse_iso("yesterday"), None);
        assert_eq!(t.title_date(), "Friday, January 01, 2010");
        assert_eq!(t.title_time(), "12:00 PM");
        assert_eq!(Timestamp(0).title_time(), "12:00 AM");
    }

    #[test]
    fn clocks() {
        let t = Timestamp::parse_iso("1980-01-01T00:00:10Z").unwrap();
        assert_eq!(t.time32(), 10);
        // 1601 → 1980 is 11644473600 + 315532800 seconds.
        assert_eq!(
            t.filetime(),
            (11_644_473_600 + 315_532_800 + 10) * 10_000_000
        );
        assert_eq!(Timestamp(0).time32(), 1);
    }
}
