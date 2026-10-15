//! JSON text exactly as `JSON.stringify(value, null, 2)` writes it: two-space
//! indent, numbers in JavaScript's shortest form (`36`, not `36.0`; `1e+21`),
//! NaN and infinities as `null`.

use std::io;

use serde::Serialize;
use serde_json::ser::{Formatter, PrettyFormatter, Serializer};

use crate::js::number_to_string;

/// serde_json's pretty printer with JavaScript number formatting.
pub struct JsFormatter {
    inner: PrettyFormatter<'static>,
}

impl Default for JsFormatter {
    fn default() -> Self {
        JsFormatter {
            inner: PrettyFormatter::with_indent(b"  "),
        }
    }
}

impl Formatter for JsFormatter {
    fn write_f64<W: ?Sized + io::Write>(&mut self, w: &mut W, value: f64) -> io::Result<()> {
        w.write_all(number_to_string(value).as_bytes())
    }

    fn write_f32<W: ?Sized + io::Write>(&mut self, w: &mut W, value: f32) -> io::Result<()> {
        self.write_f64(w, f64::from(value))
    }

    fn begin_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.begin_array(w)
    }

    fn end_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.end_array(w)
    }

    fn begin_array_value<W: ?Sized + io::Write>(
        &mut self,
        w: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.inner.begin_array_value(w, first)
    }

    fn end_array_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.end_array_value(w)
    }

    fn begin_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.begin_object(w)
    }

    fn end_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.end_object(w)
    }

    fn begin_object_key<W: ?Sized + io::Write>(
        &mut self,
        w: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.inner.begin_object_key(w, first)
    }

    fn begin_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.begin_object_value(w)
    }

    fn end_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.end_object_value(w)
    }
}

/// Write `value` as `JSON.stringify(value, null, 2)` would.
pub fn to_writer_pretty<W: io::Write, T: Serialize + ?Sized>(
    writer: W,
    value: &T,
) -> serde_json::Result<()> {
    let mut ser = Serializer::with_formatter(writer, JsFormatter::default());
    value.serialize(&mut ser)
}

/// `JSON.stringify(value, null, 2)`.
pub fn to_string_pretty<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    let mut out = Vec::with_capacity(1 << 16);
    to_writer_pretty(&mut out, value)?;
    // serde_json only writes valid UTF-8.
    Ok(String::from_utf8(out).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_json_stringify() {
        #[derive(Serialize)]
        struct T {
            a: f64,
            b: Vec<f64>,
            c: Vec<u8>,
            d: std::collections::BTreeMap<String, u8>,
            e: &'static str,
        }
        let t = T {
            a: 36.0,
            b: vec![0.5, f64::NAN, -0.0, 1e21],
            c: vec![],
            d: Default::default(),
            e: "\u{1}\"\u{2028}",
        };
        assert_eq!(
            to_string_pretty(&t).unwrap(),
            "{\n  \"a\": 36,\n  \"b\": [\n    0.5,\n    null,\n    0,\n    1e+21\n  ],\n  \"c\": [],\n  \"d\": {},\n  \"e\": \"\\u0001\\\"\u{2028}\"\n}"
        );
    }
}
