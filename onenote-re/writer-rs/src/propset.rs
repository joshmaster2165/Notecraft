//! Property sets: the `ObjectSpaceObjectPropSet` blob behind every object
//! declaration ([MS-ONESTORE] §2.6.1–§2.6.9).
//!
//! ```text
//!   OIDs stream    u32 header {count:24, ExtendedStreamsPresent:1 @30, OsidStreamNotPresent:1 @31} + CompactID[count]
//!   OSIDs stream   (only when an object space is referenced)
//!   PropertySet    u16 cProperties, u32 rgPrids[], rgData   (values in prid order)
//!   padding        zeros up to a multiple of 8
//! ```
//!
//! References to objects and object spaces do not sit in the property data:
//! they are CompactIDs appended to the OID/OSID streams in property order,
//! nested `ArrayOfPropertyValues` included. Strings are `WzInAtom`s, UTF-16
//! with a terminating NUL, as OneNote writes them.

use crate::guid::{ExGuid, Guid};
use crate::WriteError;

/// Index of an object in its object space (see [`crate::space::Space`]).
pub(crate) type ObjIdx = usize;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Value {
    Bool(bool),
    U8(u8),
    U16(u16),
    U32(u32),
    F32(f32),
    U64(u64),
    Bytes(Vec<u8>),
    Oid(ObjIdx),
    Oids(Vec<ObjIdx>),
    Osids(Vec<ExGuid>),
    /// `prtArrayOfPropertyValues`: the element PropertyID and its sets.
    Sets(u32, Vec<PropSet>),
}

impl Value {
    /// The PropertyID type this value is stored as.
    fn ty(&self) -> u32 {
        match self {
            Value::Bool(_) => 0x2,
            Value::U8(_) => 0x3,
            Value::U16(_) => 0x4,
            Value::U32(_) | Value::F32(_) => 0x5,
            Value::U64(_) => 0x6,
            Value::Bytes(_) => 0x7,
            Value::Oid(_) => 0x8,
            Value::Oids(_) => 0x9,
            Value::Osids(_) => 0xb,
            Value::Sets(..) => 0x10,
        }
    }
}

/// An ordered property set. Each PropertyID appears at most once
/// ([MS-ONE] §2.1.12); `set` replaces an existing value.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PropSet(pub Vec<(u32, Value)>);

impl PropSet {
    pub fn new() -> PropSet {
        PropSet(Vec::new())
    }

    pub fn set(&mut self, prid: u32, value: Value) -> &mut PropSet {
        match self.0.iter_mut().find(|(p, _)| *p == prid) {
            Some(slot) => slot.1 = value,
            None => self.0.push((prid, value)),
        }
        self
    }

    pub fn bool(&mut self, prid: u32, v: bool) -> &mut PropSet {
        self.set(prid, Value::Bool(v))
    }
    pub fn u8(&mut self, prid: u32, v: u8) -> &mut PropSet {
        self.set(prid, Value::U8(v))
    }
    pub fn u16(&mut self, prid: u32, v: u16) -> &mut PropSet {
        self.set(prid, Value::U16(v))
    }
    pub fn u32(&mut self, prid: u32, v: u32) -> &mut PropSet {
        self.set(prid, Value::U32(v))
    }
    pub fn f32(&mut self, prid: u32, v: f32) -> &mut PropSet {
        self.set(prid, Value::F32(v))
    }
    pub fn u64(&mut self, prid: u32, v: u64) -> &mut PropSet {
        self.set(prid, Value::U64(v))
    }
    pub fn bytes(&mut self, prid: u32, v: Vec<u8>) -> &mut PropSet {
        self.set(prid, Value::Bytes(v))
    }
    /// A `WzInAtom`: UTF-16LE with a terminating NUL.
    pub fn wz(&mut self, prid: u32, s: &str) -> &mut PropSet {
        self.set(prid, Value::Bytes(wz(s)))
    }
    pub fn guid(&mut self, prid: u32, g: Guid) -> &mut PropSet {
        self.set(prid, Value::Bytes(g.0.to_vec()))
    }
    pub fn oid(&mut self, prid: u32, o: ObjIdx) -> &mut PropSet {
        self.set(prid, Value::Oid(o))
    }
    pub fn oids(&mut self, prid: u32, o: Vec<ObjIdx>) -> &mut PropSet {
        self.set(prid, Value::Oids(o))
    }
    pub fn osids(&mut self, prid: u32, o: Vec<ExGuid>) -> &mut PropSet {
        self.set(prid, Value::Osids(o))
    }

    /// Every object reference, in stream order.
    pub fn oid_refs(&self, out: &mut Vec<ObjIdx>) {
        for (_, v) in &self.0 {
            match v {
                Value::Oid(o) => out.push(*o),
                Value::Oids(os) => out.extend_from_slice(os),
                Value::Sets(_, sets) => sets.iter().for_each(|s| s.oid_refs(out)),
                _ => {}
            }
        }
    }

    /// Every object space reference, in stream order.
    pub fn osid_refs(&self, out: &mut Vec<ExGuid>) {
        for (_, v) in &self.0 {
            match v {
                Value::Osids(os) => out.extend_from_slice(os),
                Value::Sets(_, sets) => sets.iter().for_each(|s| s.osid_refs(out)),
                _ => {}
            }
        }
    }

    /// The PropertySet body alone, with references left out: a content key
    /// for de-duplicating read-only objects that hold no references.
    pub fn content_key(&self) -> Vec<u8> {
        let mut body = Vec::new();
        let mut sink = Streams::default();
        // Content keys are only taken of sets without references.
        let _ = encode_set(self, &mut body, &mut sink, &|_| ExGuid::NIL, &|_| 0);
        body
    }
}

/// UTF-16LE with a terminating NUL.
pub(crate) fn wz(s: &str) -> Vec<u8> {
    let mut out: Vec<u8> = s.encode_utf16().flat_map(u16::to_le_bytes).collect();
    out.extend_from_slice(&[0, 0]);
    out
}

#[derive(Default)]
struct Streams {
    oids: Vec<u32>,
    osids: Vec<u32>,
}

/// An encoded `ObjectSpaceObjectPropSet`, padded to a multiple of 8.
pub(crate) struct Encoded {
    pub bytes: Vec<u8>,
    pub has_oid_refs: bool,
    pub has_osid_refs: bool,
}

fn compact_id(id: ExGuid, index: u32) -> Result<u32, WriteError> {
    if id.n > 0xff || index > 0x00ff_ffff {
        return Err(WriteError::internal("CompactID out of range"));
    }
    Ok(id.n | index << 8)
}

fn encode_set(
    set: &PropSet,
    body: &mut Vec<u8>,
    streams: &mut Streams,
    oid_of: &dyn Fn(ObjIdx) -> ExGuid,
    index_of: &dyn Fn(Guid) -> u32,
) -> Result<(), WriteError> {
    let count = u16::try_from(set.0.len())
        .map_err(|_| WriteError::internal("more than 65535 properties in a set"))?;
    body.extend_from_slice(&count.to_le_bytes());
    for (prid, v) in &set.0 {
        if (prid >> 26) & 0x1f != v.ty() {
            return Err(WriteError::internal(format!(
                "property 0x{prid:08x} holds a value of type 0x{:x}",
                v.ty()
            )));
        }
        let bit = matches!(v, Value::Bool(true)) as u32;
        body.extend_from_slice(&(prid & 0x7fff_ffff | bit << 31).to_le_bytes());
    }
    for (_, v) in &set.0 {
        match v {
            Value::Bool(_) => {}
            Value::U8(x) => body.push(*x),
            Value::U16(x) => body.extend_from_slice(&x.to_le_bytes()),
            Value::U32(x) => body.extend_from_slice(&x.to_le_bytes()),
            Value::F32(x) => body.extend_from_slice(&x.to_le_bytes()),
            Value::U64(x) => body.extend_from_slice(&x.to_le_bytes()),
            Value::Bytes(b) => {
                let n = u32::try_from(b.len())
                    .map_err(|_| WriteError::TooLarge("property value over 4 GiB".into()))?;
                body.extend_from_slice(&n.to_le_bytes());
                body.extend_from_slice(b);
            }
            Value::Oid(o) => {
                let id = oid_of(*o);
                streams.oids.push(compact_id(id, index_of(id.guid))?);
            }
            Value::Oids(os) => {
                body.extend_from_slice(&(os.len() as u32).to_le_bytes());
                for o in os {
                    let id = oid_of(*o);
                    streams.oids.push(compact_id(id, index_of(id.guid))?);
                }
            }
            Value::Osids(os) => {
                body.extend_from_slice(&(os.len() as u32).to_le_bytes());
                for id in os {
                    streams.osids.push(compact_id(*id, index_of(id.guid))?);
                }
            }
            Value::Sets(inner, sets) => {
                // An empty array carries no element PropertyID ([MS-ONESTORE]
                // §2.6.9); readers disagree on it, so callers never write one.
                if sets.is_empty() {
                    return Err(WriteError::internal("empty ArrayOfPropertyValues"));
                }
                body.extend_from_slice(&(sets.len() as u32).to_le_bytes());
                body.extend_from_slice(&(inner & 0x7fff_ffff).to_le_bytes());
                for s in sets {
                    encode_set(s, body, streams, oid_of, index_of)?;
                }
            }
        }
    }
    Ok(())
}

/// Encode a property set, resolving object references with `oid_of` and
/// GUIDs to global id table indices with `index_of`.
pub(crate) fn encode(
    set: &PropSet,
    oid_of: &dyn Fn(ObjIdx) -> ExGuid,
    index_of: &dyn Fn(Guid) -> u32,
) -> Result<Encoded, WriteError> {
    let mut body = Vec::new();
    let mut streams = Streams::default();
    encode_set(set, &mut body, &mut streams, oid_of, index_of)?;
    let too_many = |n: usize| n > 0x00ff_ffff;
    if too_many(streams.oids.len()) || too_many(streams.osids.len()) {
        return Err(WriteError::TooLarge(
            "more than 2^24 references in one object".into(),
        ));
    }
    let has_osids = !streams.osids.is_empty();
    let mut out =
        Vec::with_capacity(body.len() + 8 + 4 * (streams.oids.len() + streams.osids.len()));
    let oid_header = streams.oids.len() as u32 | if has_osids { 0 } else { 1 << 31 };
    out.extend_from_slice(&oid_header.to_le_bytes());
    for c in &streams.oids {
        out.extend_from_slice(&c.to_le_bytes());
    }
    if has_osids {
        out.extend_from_slice(&(streams.osids.len() as u32).to_le_bytes());
        for c in &streams.osids {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
    out.extend_from_slice(&body);
    while !out.len().is_multiple_of(8) {
        out.push(0);
    }
    Ok(Encoded {
        bytes: out,
        has_oid_refs: !streams.oids.is_empty(),
        has_osid_refs: has_osids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_streams_types_and_padding() {
        let g = Guid::parse("{11111111-2222-3333-4444-555555555555}");
        let mut s = PropSet::new();
        s.bool(0x0800_1c04, true)
            .u8(0x0c00_1c03, 1)
            .wz(0x1c00_1c0a, "A")
            .oids(0x2400_1c20, vec![0, 1]);
        let e = encode(&s, &|i| ExGuid::new(g, i as u32 + 1), &|_| 7).unwrap();
        assert_eq!(e.bytes.len() % 8, 0);
        // OIDs header: two ids, no OSID stream.
        assert_eq!(&e.bytes[..4], &(2u32 | 1 << 31).to_le_bytes());
        assert_eq!(&e.bytes[4..8], &(1u32 | 7 << 8).to_le_bytes());
        assert_eq!(&e.bytes[8..12], &(2u32 | 7 << 8).to_le_bytes());
        // cProperties, then the Bold prid with its value bit.
        assert_eq!(&e.bytes[12..14], &4u16.to_le_bytes());
        assert_eq!(&e.bytes[14..18], &0x8800_1c04u32.to_le_bytes());
        assert!(e.has_oid_refs && !e.has_osid_refs);
    }

    #[test]
    fn rejects_mismatched_types() {
        let mut s = PropSet::new();
        s.set(0x0c00_1c03, Value::U32(1));
        assert!(encode(&s, &|_| ExGuid::NIL, &|_| 0).is_err());
    }
}
