//! JavaScript semantics the TypeScript parser gets for free and this port has
//! to reproduce so both produce the same JSON: `Math.round`, `Math.min/max`
//! with NaN and signed zero, `Number.prototype.toString`, `String.prototype.trim`
//! and `Date.prototype.toISOString`.

/// `Math.round`: nearest integer, ties toward +∞, keeps -0.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let r = x.ceil();
    if r - 0.5 > x {
        r - 1.0
    } else {
        r
    }
}

/// `Math.round(x * 100) / 100`, the rounding used for every coordinate.
pub fn round2(x: f64) -> f64 {
    math_round(x * 100.0) / 100.0
}

/// `Math.min(a, b)`: NaN wins, and -0 is smaller than +0.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a.is_sign_negative() { a } else { b };
    }
    if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: NaN wins, and +0 is larger than -0.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a.is_sign_negative() { b } else { a };
    }
    if a > b {
        a
    } else {
        b
    }
}

/// `Number.prototype.toString()` (radix 10), e.g. `36`, `0.5`, `1e+21`.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    if x.fract() == 0.0 && x < 9_007_199_254_740_992.0 {
        return (x as u64).to_string();
    }
    // Rust's `{:e}` prints the shortest digits that round-trip, like
    // ECMAScript's Number::toString.
    let e = prefer_even_tie(x, format!("{x:e}"));
    let (mantissa, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e1 = n - 1;
        let sign = if e1 >= 0 { '+' } else { '-' };
        if k == 1 {
            format!("{digits}e{sign}{}", e1.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e1.abs())
        }
    }
}

/// When two shortest k-digit strings are equally close to x, V8 takes the
/// even one (as ECMA-262 recommends) where Rust's shortest mode rounds up;
/// the correctly rounded k-digit form (ties to even) is V8's answer whenever
/// it still round-trips. Such a tie needs two k-digit decimals inside one ulp,
/// so k >= 16.
///
/// Compiled out of the wasm build to keep the exact formatter and the float
/// parser out of the binary: there, numbers reach JavaScript as numbers and
/// this function only formats integer offsets below 2^54 in error messages,
/// which have no ties.
#[cfg(not(target_arch = "wasm32"))]
fn prefer_even_tie(x: f64, shortest: String) -> String {
    let k = shortest
        .split('e')
        .next()
        .map_or(1, |m| m.chars().filter(char::is_ascii_digit).count());
    if k < 16 {
        return shortest;
    }
    let exact = format!("{:.*e}", k - 1, x);
    if exact.parse::<f64>().ok() == Some(x) {
        exact
    } else {
        shortest
    }
}

#[cfg(target_arch = "wasm32")]
fn prefer_even_tie(_x: f64, shortest: String) -> String {
    shortest
}

/// `n.toString(16)` for an integer that may be negative.
pub fn hex_signed(v: i64) -> String {
    if v < 0 {
        format!("-{:x}", v.unsigned_abs())
    } else {
        format!("{v:x}")
    }
}

/// ECMAScript WhiteSpace and LineTerminator code points (what `trim` removes).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `String.prototype.trim`. Differs from `str::trim` on U+0085 and U+FEFF.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

const MS_PER_DAY: i64 = 86_400_000;

/// `new Date(ms).toISOString()` for a valid time value (|ms| ≤ 8.64e15).
pub fn iso_string(ms: i64) -> String {
    let days = ms.div_euclid(MS_PER_DAY);
    let rem = ms.rem_euclid(MS_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    };
    format!(
        "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// Proleptic Gregorian date of a day count since 1970-01-01 (H. Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_matches_math_round() {
        assert_eq!(math_round(0.5), 1.0);
        assert_eq!(math_round(-0.5), 0.0);
        assert!(math_round(-0.5).is_sign_negative());
        assert_eq!(math_round(-1.5), -1.0);
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(0.49999999999999994), 0.0);
        assert_eq!(round2(1.005), 1.0); // 1.005 * 100 = 100.49999999999999
        assert_eq!(round2(0.125), 0.13);
    }

    #[test]
    #[allow(clippy::excessive_precision)]
    fn numbers_print_like_javascript() {
        let cases = [
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (-0.0, "0"),
            (1.5e-10, "1.5e-10"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (0.1 + 0.2, "0.30000000000000004"),
            (100.0, "100"),
            (36.5, "36.5"),
            (-12.25, "-12.25"),
            (9007199254740994.0, "9007199254740994"),
            // Exactly between two 17-digit strings: the even one, like V8.
            (228137592231777.625, "228137592231777.62"),
            (127661091799478.625, "127661091799478.62"),
        ];
        for (x, s) in cases {
            assert_eq!(number_to_string(x), s);
        }
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso_string(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(315_532_800_000), "1980-01-01T00:00:00.000Z");
        assert_eq!(iso_string(-11_644_473_600_000), "1601-01-01T00:00:00.000Z");
        assert_eq!(iso_string(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(
            iso_string(253_402_300_800_000),
            "+010000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            iso_string(-62_198_755_200_000),
            "-000001-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn trim_uses_ecmascript_whitespace() {
        assert_eq!(
            trim(" \u{feff}\u{85}a\u{180e}\u{200b} "),
            "\u{85}a\u{180e}\u{200b}"
        );
    }
}
