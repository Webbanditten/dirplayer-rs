//! Director containers as a flat resource table, for editing.
//!
//! The player reads files through views into the original bytes ([`crate::director::file`]); an editor needs every
//! resource as owned data it can replace, plus everything required to write the file back. Two containers exist:
//!
//! ```text
//! RIFX/XFIR + MC95/MV93   uncompressed  (.cst / .dir)  imap + mmap + chunks
//! RIFX/XFIR + FGDC/FGDM   afterburned   (.cct / .dcr)  Fver + Fcdr + ABMP + FGEI + ILS + resources
//! ```
//!
//! Afterburned layout (all offsets in the ABMP are relative to the start of the ILS body; `0xFFFFFFFF` = inside it):
//!
//! ```text
//! XFIR <fileSize:u32> FGDC
//!   Fver <varint len> <payload>                 varint fileVersion, imapVersion, directorVersion, pstring "10.1#11"
//!   Fcdr <varint len> <zlib>                    u16 codecCount, codecCount x 16-byte MoaID, NUL-terminated names
//!   ABMP <varint len> <varint 0> <varint rawLen> <zlib>
//!                                               varint 1, varint highest id, varint count,
//!                                               per resource: varint id, offset, compressedLen, uncompressedLen,
//!                                               codecIndex, fourCC
//!   FGEI <varint 0>
//!   <ILS body>                                  resource 2: zlib of [varint id][raw data] for every load-time chunk
//!   <remaining resources>                       media (BITD, CLUT, STXT, snd ...), each deflated on its own
//! ```
//!
//! Resource ids are the mmap slot indices of the uncompressed form, so `KEY*`, `CAS*` and `LctX` references stay
//! valid whichever container a file is written as. Resources stored with a codec we can't decode (SWA sound, the
//! null codec) are carried through byte for byte. Ported from habbo-vibe-playground's cast editor
//! (`tools/director-cast-editor/src/afterburner.ts`), which round-trips every cast in the Habbo client.

use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;

pub type Tag = [u8; 4];

/// Resource id of the Initial Load Segment (always 2).
const ILS_ID: u32 = 2;
/// ABMP offset meaning "stored inside the ILS".
const OFFSET_IN_ILS: u32 = 0xFFFF_FFFF;
/// MoaID of Director's zlib codec, canonical hex.
const MOA_ZLIB: &str = "ac99e90400700b360000080007377a34";
/// Tags written outside the ILS when a resource has no known placement (bulk media).
const MEDIA_TAGS: &[&[u8; 4]] = &[
    b"BITD", b"ALFA", b"CLUT", b"STXT", b"snd ", b"ediM", b"XMED", b"Thum", b"VERS", b"FXmp", b"SCVW", b"RTE0",
    b"RTE1", b"RTE2", b"SND ", b"CFTC",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endian {
    Big,
    Little,
}

impl Endian {
    pub fn u16(self, b: &[u8], at: usize) -> u16 {
        let v = [b[at], b[at + 1]];
        match self {
            Endian::Big => u16::from_be_bytes(v),
            Endian::Little => u16::from_le_bytes(v),
        }
    }
    pub fn u32(self, b: &[u8], at: usize) -> u32 {
        let v = [b[at], b[at + 1], b[at + 2], b[at + 3]];
        match self {
            Endian::Big => u32::from_be_bytes(v),
            Endian::Little => u32::from_le_bytes(v),
        }
    }
    pub fn put_u16(self, out: &mut Vec<u8>, v: u16) {
        out.extend_from_slice(&match self {
            Endian::Big => v.to_be_bytes(),
            Endian::Little => v.to_le_bytes(),
        });
    }
    pub fn put_u32(self, out: &mut Vec<u8>, v: u32) {
        out.extend_from_slice(&match self {
            Endian::Big => v.to_be_bytes(),
            Endian::Little => v.to_le_bytes(),
        });
    }
    /// A tag as stored: byte-reversed in little-endian files.
    pub fn tag(self, b: &[u8], at: usize) -> Tag {
        match self {
            Endian::Big => [b[at], b[at + 1], b[at + 2], b[at + 3]],
            Endian::Little => [b[at + 3], b[at + 2], b[at + 1], b[at]],
        }
    }
    pub fn put_tag(self, out: &mut Vec<u8>, t: &Tag) {
        match self {
            Endian::Big => out.extend_from_slice(t),
            Endian::Little => out.extend_from_slice(&[t[3], t[2], t[1], t[0]]),
        }
    }
}

pub fn tag_str(t: &Tag) -> String {
    t.iter().map(|&c| c as char).collect()
}

/// A resource whose codec we don't decode, replayed as stored.
#[derive(Clone, Debug)]
pub struct Passthrough {
    pub codec_index: u32,
    pub uncompressed_len: u32,
    pub stored: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct Resource {
    pub tag: Tag,
    /// Decoded payload (the stored bytes for a passthrough resource).
    pub data: Vec<u8>,
    pub passthrough: Option<Passthrough>,
}

/// What an afterburned file needs to be written back like the original.
#[derive(Clone, Debug, Default)]
pub struct AfterburnerMeta {
    pub fver_payload: Vec<u8>,
    pub director_version: u32,
    /// 16-byte MoaIDs as stored.
    pub compression_ids: Vec<[u8; 16]>,
    pub compression_descs: Vec<String>,
    pub abmp_unknown1: u32,
    pub fgei_unknown: u32,
    /// Ids stored in the ILS, in stream order.
    pub ils_ids: Vec<u32>,
    /// Ids stored after the ILS.
    pub outside_ids: Vec<u32>,
    /// Empty slots (null tag, no data), kept so ids line up.
    pub placeholder_ids: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct ContainerFile {
    pub endian: Endian,
    /// FGDM/MV93 (movie) rather than FGDC/MC95 (cast).
    pub movie: bool,
    pub afterburned: bool,
    pub meta: AfterburnerMeta,
    pub resources: BTreeMap<u32, Resource>,
}

// --- byte helpers -------------------------------------------------------------------------------------------------

fn read_varint(b: &[u8], p: &mut usize) -> u32 {
    let mut value: u32 = 0;
    loop {
        if *p >= b.len() {
            return value;
        }
        let c = b[*p];
        *p += 1;
        value = (value << 7) | (c & 0x7f) as u32;
        if c & 0x80 == 0 {
            return value;
        }
    }
}

pub fn put_varint(out: &mut Vec<u8>, value: u32) {
    let mut bytes = vec![(value & 0x7f) as u8];
    let mut rest = value >> 7;
    while rest > 0 {
        bytes.push(((rest & 0x7f) as u8) | 0x80);
        rest >>= 7;
    }
    bytes.reverse();
    out.extend_from_slice(&bytes);
}

fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    ZlibDecoder::new(data).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::best());
    enc.write_all(data).unwrap();
    enc.finish().unwrap()
}

fn moa_hex(raw: &[u8; 16], endian: Endian) -> String {
    let d1 = endian.u32(raw, 0);
    let d2 = endian.u16(raw, 4);
    let d3 = endian.u16(raw, 6);
    let mut s = format!("{:08x}{:04x}{:04x}", d1, d2, d3);
    for b in &raw[8..] {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn moa_from_hex(hex: &str, endian: Endian) -> [u8; 16] {
    let n = |a: usize, b: usize| u32::from_str_radix(&hex[a..b], 16).unwrap();
    let mut v = Vec::new();
    endian.put_u32(&mut v, n(0, 8));
    endian.put_u16(&mut v, n(8, 12) as u16);
    endian.put_u16(&mut v, n(12, 16) as u16);
    for i in 0..8 {
        v.push(n(16 + i * 2, 18 + i * 2) as u8);
    }
    v.try_into().unwrap()
}

// --- reading ------------------------------------------------------------------------------------------------------

impl ContainerFile {
    pub fn read(data: &[u8]) -> Result<ContainerFile, String> {
        if data.len() < 12 {
            return Err("File too short".into());
        }
        let endian = match &data[0..4] {
            b"RIFX" => Endian::Big,
            b"XFIR" => Endian::Little,
            _ => return Err("Not a Director file (no RIFX/XFIR header)".into()),
        };
        let codec = endian.tag(data, 8);
        match &codec {
            b"FGDC" | b"FGDM" => Self::read_afterburned(data, endian, &codec == b"FGDM"),
            b"MC95" | b"MV93" => Self::read_uncompressed(data, endian, &codec == b"MV93"),
            _ => Err(format!("Unknown Director container '{}'", tag_str(&codec))),
        }
    }

    fn read_afterburned(data: &[u8], endian: Endian, movie: bool) -> Result<ContainerFile, String> {
        let mut p = 12;
        let expect = |p: &mut usize, want: &[u8; 4]| -> Result<(), String> {
            let t = endian.tag(data, *p);
            *p += 4;
            if &t != want {
                return Err(format!("Expected {}, found {}", tag_str(want), tag_str(&t)));
            }
            Ok(())
        };

        expect(&mut p, b"Fver")?;
        let fver_len = read_varint(data, &mut p) as usize;
        let fver_payload = data[p..p + fver_len].to_vec();
        p += fver_len;
        let director_version = {
            let mut q = 0;
            read_varint(&fver_payload, &mut q);
            if q < fver_payload.len() {
                read_varint(&fver_payload, &mut q);
            }
            if q < fver_payload.len() { read_varint(&fver_payload, &mut q) } else { 0x744 }
        };

        expect(&mut p, b"Fcdr")?;
        let fcdr_len = read_varint(data, &mut p) as usize;
        let fcdr = inflate(&data[p..p + fcdr_len]).map_err(|e| format!("Fcdr: {}", e))?;
        p += fcdr_len;
        let codec_count = endian.u16(&fcdr, 0) as usize;
        let mut compression_ids = Vec::new();
        for i in 0..codec_count {
            compression_ids.push(fcdr[2 + i * 16..18 + i * 16].try_into().unwrap());
        }
        let compression_descs: Vec<String> = fcdr[2 + codec_count * 16..]
            .split(|&c| c == 0)
            .take(codec_count)
            .map(|s| s.iter().map(|&c| c as char).collect())
            .collect();

        expect(&mut p, b"ABMP")?;
        let abmp_len = read_varint(data, &mut p) as usize;
        let abmp_end = p + abmp_len;
        read_varint(data, &mut p);
        read_varint(data, &mut p);
        let abmp = inflate(&data[p..abmp_end]).map_err(|e| format!("ABMP: {}", e))?;
        p = abmp_end;

        struct Entry {
            id: u32,
            offset: u32,
            comp: u32,
            uncomp: u32,
            codec: u32,
            tag: Tag,
        }
        let mut ap = 0;
        let abmp_unknown1 = read_varint(&abmp, &mut ap);
        read_varint(&abmp, &mut ap);
        let count = read_varint(&abmp, &mut ap);
        let mut entries = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let id = read_varint(&abmp, &mut ap);
            let offset = read_varint(&abmp, &mut ap);
            let comp = read_varint(&abmp, &mut ap);
            let uncomp = read_varint(&abmp, &mut ap);
            let codec = read_varint(&abmp, &mut ap);
            let tag = endian.tag(&abmp, ap);
            ap += 4;
            entries.push(Entry { id, offset, comp, uncomp, codec, tag });
        }

        expect(&mut p, b"FGEI")?;
        let fgei_unknown = read_varint(data, &mut p);
        let ils_body = p;

        let ils = entries.iter().find(|e| e.id == ILS_ID).ok_or("No ILS resource")?;
        let by_id: BTreeMap<u32, &Entry> = entries.iter().map(|e| (e.id, e)).collect();
        let ils_data = inflate(&data[ils_body..ils_body + ils.comp as usize]).map_err(|e| format!("ILS: {}", e))?;
        let mut in_ils: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
        let mut ils_ids = Vec::new();
        let mut ip = 0;
        while ip < ils_data.len() {
            let id = read_varint(&ils_data, &mut ip);
            let Some(e) = by_id.get(&id) else { break };
            let end = (ip + e.comp as usize).min(ils_data.len());
            in_ils.insert(id, ils_data[ip..end].to_vec());
            ils_ids.push(id);
            ip = end;
        }

        let zlib_index = compression_ids.iter().position(|id| moa_hex(id, endian) == MOA_ZLIB);
        let mut resources = BTreeMap::new();
        let mut outside_ids = Vec::new();
        let mut placeholder_ids = Vec::new();
        for e in &entries {
            if e.id == ILS_ID {
                continue;
            }
            if let Some(d) = in_ils.remove(&e.id) {
                resources.insert(e.id, Resource { tag: e.tag, data: d, passthrough: None });
                continue;
            }
            if e.tag[0] == 0 {
                placeholder_ids.push(e.id);
                continue;
            }
            outside_ids.push(e.id);
            let start = ils_body + e.offset as usize;
            let stored = data.get(start..start + e.comp as usize).ok_or("Resource past end of file")?.to_vec();
            if Some(e.codec as usize) == zlib_index {
                // Director stores a few resources verbatim when deflating would not shrink them.
                let d = if e.comp == 0 { Vec::new() } else { inflate(&stored).unwrap_or(stored) };
                resources.insert(e.id, Resource { tag: e.tag, data: d, passthrough: None });
            } else {
                resources.insert(
                    e.id,
                    Resource {
                        tag: e.tag,
                        data: stored.clone(),
                        passthrough: Some(Passthrough { codec_index: e.codec, uncompressed_len: e.uncomp, stored }),
                    },
                );
            }
        }

        Ok(ContainerFile {
            endian,
            movie,
            afterburned: true,
            meta: AfterburnerMeta {
                fver_payload,
                director_version,
                compression_ids,
                compression_descs,
                abmp_unknown1,
                fgei_unknown,
                ils_ids,
                outside_ids,
                placeholder_ids,
            },
            resources,
        })
    }

    fn read_uncompressed(data: &[u8], endian: Endian, movie: bool) -> Result<ContainerFile, String> {
        // imap at 12: tag, len, version, mmapOffset, directorVersion
        if &endian.tag(data, 12) != b"imap" {
            return Err("Expected imap".into());
        }
        let mmap_offset = endian.u32(data, 24) as usize;
        let director_version = endian.u32(data, 28);
        if &endian.tag(data, mmap_offset) != b"mmap" {
            return Err("Expected mmap".into());
        }
        let m = mmap_offset + 8;
        let header_len = endian.u16(data, m) as usize;
        let entry_len = endian.u16(data, m + 2) as usize;
        let used = endian.u32(data, m + 8) as usize;
        let mut resources = BTreeMap::new();
        for i in 0..used {
            let at = m + header_len + i * entry_len;
            let tag = endian.tag(data, at);
            let len = endian.u32(data, at + 4) as usize;
            let offset = endian.u32(data, at + 8) as usize;
            if matches!(&tag, b"RIFX" | b"XFIR" | b"imap" | b"mmap" | b"free" | b"junk") || i <= ILS_ID as usize {
                continue;
            }
            let d = data.get(offset + 8..offset + 8 + len).ok_or("Chunk past end of file")?.to_vec();
            resources.insert(i as u32, Resource { tag, data: d, passthrough: None });
        }
        Ok(ContainerFile {
            endian,
            movie,
            afterburned: false,
            meta: AfterburnerMeta { director_version, abmp_unknown1: 1, ..Default::default() },
            resources,
        })
    }

    // --- resources ------------------------------------------------------------------------------------------------

    pub fn ids_with_tag(&self, tag: &Tag) -> Vec<u32> {
        self.resources.iter().filter(|(_, r)| &r.tag == tag).map(|(&id, _)| id).collect()
    }

    pub fn first_with_tag(&self, tag: &Tag) -> Option<u32> {
        self.resources.iter().find(|(_, r)| &r.tag == tag).map(|(&id, _)| id)
    }

    /// A free resource id (never 0-2, never a placeholder slot).
    pub fn next_id(&self) -> u32 {
        let max_res = self.resources.keys().max().copied().unwrap_or(ILS_ID);
        let max_ph = self.meta.placeholder_ids.iter().max().copied().unwrap_or(ILS_ID);
        max_res.max(max_ph).max(ILS_ID) + 1
    }

    pub fn set(&mut self, id: u32, tag: Tag, data: Vec<u8>) {
        self.resources.insert(id, Resource { tag, data, passthrough: None });
    }

    pub fn remove(&mut self, id: u32) {
        self.resources.remove(&id);
    }

    // --- writing --------------------------------------------------------------------------------------------------

    /// Write as an afterburned (compressed) file: `.cct` for a cast, `.dcr` for a movie.
    pub fn write_afterburned(&self) -> Vec<u8> {
        let endian = self.endian;
        let meta = &self.meta;

        let mut compression_ids = meta.compression_ids.clone();
        let mut descs = meta.compression_descs.clone();
        let zlib_index = match compression_ids.iter().position(|id| moa_hex(id, endian) == MOA_ZLIB) {
            Some(i) => i as u32,
            None => {
                compression_ids.push(moa_from_hex(MOA_ZLIB, endian));
                descs.push("Macromedia ziplib compression, contact Macromedia, Inc., San Francisco, CA".into());
                (compression_ids.len() - 1) as u32
            }
        };

        // Resources keep the placement the source gave them; new ones go by tag.
        let ils_set: HashSet<u32> = meta.ils_ids.iter().copied().collect();
        let known: HashSet<u32> = meta.ils_ids.iter().chain(meta.outside_ids.iter()).copied().collect();
        let goes_in_ils = |id: u32, r: &Resource| -> bool {
            if r.passthrough.is_some() {
                return false;
            }
            if known.contains(&id) {
                return ils_set.contains(&id);
            }
            !MEDIA_TAGS.iter().any(|t| **t == r.tag)
        };

        struct Entry {
            id: u32,
            tag: Tag,
            offset: u32,
            comp: u32,
            uncomp: u32,
            codec: u32,
        }
        let mut entries: Vec<Entry> = Vec::new();

        let rank: BTreeMap<u32, usize> = meta.ils_ids.iter().enumerate().map(|(i, &id)| (id, i)).collect();
        let mut ils_list: Vec<(u32, &Resource)> =
            self.resources.iter().filter(|(id, r)| goes_in_ils(**id, r)).map(|(id, r)| (*id, r)).collect();
        ils_list.sort_by_key(|(id, _)| (rank.get(id).copied().unwrap_or(usize::MAX), *id));
        let mut ils_raw = Vec::new();
        for (id, r) in &ils_list {
            put_varint(&mut ils_raw, *id);
            ils_raw.extend_from_slice(&r.data);
            entries.push(Entry {
                id: *id,
                tag: r.tag,
                offset: OFFSET_IN_ILS,
                comp: r.data.len() as u32,
                uncomp: r.data.len() as u32,
                codec: zlib_index,
            });
        }
        let ils_comp = deflate(&ils_raw);
        entries.push(Entry {
            id: ILS_ID,
            tag: *b"ILS ",
            offset: 0,
            comp: ils_comp.len() as u32,
            uncomp: ils_raw.len() as u32,
            codec: zlib_index,
        });

        let mut body = ils_comp;
        for (&id, r) in &self.resources {
            if goes_in_ils(id, r) {
                continue;
            }
            let (stored, uncomp, codec) = match &r.passthrough {
                Some(pt) => (pt.stored.clone(), pt.uncompressed_len, pt.codec_index),
                None => (deflate(&r.data), r.data.len() as u32, zlib_index),
            };
            entries.push(Entry { id, tag: r.tag, offset: body.len() as u32, comp: stored.len() as u32, uncomp, codec });
            body.extend_from_slice(&stored);
        }
        let used: HashSet<u32> = entries.iter().map(|e| e.id).collect();
        for &id in &meta.placeholder_ids {
            if !used.contains(&id) {
                entries.push(Entry { id, tag: [0; 4], offset: OFFSET_IN_ILS, comp: 0, uncomp: 0, codec: 0 });
            }
        }
        entries.sort_by_key(|e| e.id);
        let max_id = entries.iter().map(|e| e.id).max().unwrap_or(0);

        let mut abmp_raw = Vec::new();
        put_varint(&mut abmp_raw, if meta.abmp_unknown1 == 0 { 1 } else { meta.abmp_unknown1 });
        put_varint(&mut abmp_raw, max_id);
        put_varint(&mut abmp_raw, entries.len() as u32);
        for e in &entries {
            put_varint(&mut abmp_raw, e.id);
            put_varint(&mut abmp_raw, e.offset);
            put_varint(&mut abmp_raw, e.comp);
            put_varint(&mut abmp_raw, e.uncomp);
            put_varint(&mut abmp_raw, e.codec);
            endian.put_tag(&mut abmp_raw, &e.tag);
        }
        let mut abmp = Vec::new();
        put_varint(&mut abmp, 0);
        put_varint(&mut abmp, abmp_raw.len() as u32);
        abmp.extend_from_slice(&deflate(&abmp_raw));

        let mut fcdr_raw = Vec::new();
        endian.put_u16(&mut fcdr_raw, compression_ids.len() as u16);
        for id in &compression_ids {
            fcdr_raw.extend_from_slice(id);
        }
        for d in &descs {
            fcdr_raw.extend(d.chars().map(|c| c as u8));
            fcdr_raw.push(0);
        }
        let fcdr = deflate(&fcdr_raw);

        let fver = if meta.fver_payload.is_empty() {
            let mut f = Vec::new();
            put_varint(&mut f, 0x501);
            put_varint(&mut f, 1);
            put_varint(&mut f, if meta.director_version == 0 { 0x744 } else { meta.director_version });
            let v = b"10.1#11";
            f.push(v.len() as u8);
            f.extend_from_slice(v);
            f
        } else {
            meta.fver_payload.clone()
        };

        let mut sections = Vec::new();
        endian.put_tag(&mut sections, b"Fver");
        put_varint(&mut sections, fver.len() as u32);
        sections.extend_from_slice(&fver);
        endian.put_tag(&mut sections, b"Fcdr");
        put_varint(&mut sections, fcdr.len() as u32);
        sections.extend_from_slice(&fcdr);
        endian.put_tag(&mut sections, b"ABMP");
        put_varint(&mut sections, abmp.len() as u32);
        sections.extend_from_slice(&abmp);
        endian.put_tag(&mut sections, b"FGEI");
        put_varint(&mut sections, meta.fgei_unknown);

        let mut out = Vec::with_capacity(12 + sections.len() + body.len());
        out.extend_from_slice(if endian == Endian::Little { b"XFIR" } else { b"RIFX" });
        endian.put_u32(&mut out, (4 + sections.len() + body.len()) as u32);
        endian.put_tag(&mut out, if self.movie { b"FGDM" } else { b"FGDC" });
        out.extend_from_slice(&sections);
        out.extend_from_slice(&body);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_round_trip() {
        for v in [0u32, 1, 127, 128, 300, 16383, 16384, 0xFFFF_FFFF] {
            let mut b = Vec::new();
            put_varint(&mut b, v);
            let mut p = 0;
            assert_eq!(read_varint(&b, &mut p), v);
            assert_eq!(p, b.len());
        }
    }
}
