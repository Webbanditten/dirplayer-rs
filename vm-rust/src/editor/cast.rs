//! A cast as editable members: names, texts, bitmaps, palettes, and members added, copied or removed.
//!
//! Chunks involved (all payloads big-endian except `KEY*`, which follows the file):
//!
//! - `CAS*`: u32 per member slot (slot n = entry n-1), the member's `CASt` resource id, 0 = empty slot.
//! - `CASt`: u32 type, u32 infoLen, u32 specificLen, info, specific data. Info = u32 dataOffset, u32, u32, u32 flags,
//!   u32 scriptId, then at dataOffset u16 count, (count + 1) u32 offsets and the items: 0 = script text, 1 = name
//!   (Pascal string), 2 = directory, 3 = file name, ...
//! - `KEY*`: u16 entry size, u16 entry size, u32 allocated, u32 used, then (u32 resource id, u32 CASt id, tag) per
//!   media chunk of a member: `BITD` (pixels), `ALFA` (alpha plane), `ediM` (JPEG), `STXT` (text), `CLUT` (palette).
//! - Bitmap specific data (D6+): u16 pitch (| 0x8000 colour), i16 top, left, bottom, right, u8 alphaThreshold, u8,
//!   u16 editVersion, 4 bytes scroll point, i16 regY, i16 regX (both in the rect's space), u8 flags (0x10 useAlpha),
//!   u8 bitsPerPixel, i16 clutCastLib, i16 clutId (a member number; built-ins are stored as their id + 1).
//! - `STXT`: u32 12, u32 text length, u32 style length, text (Mac line breaks), style runs.
//! - `CLUT`: 256 x (r, r, g, g, b, b).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde::Serialize;

use super::container::{ContainerFile, Endian, Tag};
use crate::director::enums::BitmapInfo;
use crate::director::utils::human_version;
use crate::player::bitmap::bitmap::{decode_jpeg_bitmap, decompress_bitmap, resolve_palette_table, Bitmap, PaletteRef};
use crate::player::bitmap::palette_map::PaletteMap;
use crate::player::cast_member::PaletteMember;
use crate::player::sprite::ColorRef;

pub const TYPE_BITMAP: u32 = 1;
pub const TYPE_FIELD: u32 = 3;
pub const TYPE_PALETTE: u32 = 4;
pub const TYPE_TEXT: u32 = 12;

/// The cast library number members are decoded under (palette refs are resolved against it).
pub const CAST_LIB: u32 = 1;

pub fn type_name(t: u32) -> &'static str {
    match t {
        1 => "bitmap",
        2 => "filmLoop",
        3 => "field",
        4 => "palette",
        5 => "picture",
        6 => "sound",
        7 => "button",
        8 => "shape",
        9 => "movie",
        10 => "digitalVideo",
        11 => "script",
        12 => "text",
        13 => "ole",
        14 => "transition",
        15 => "xtra",
        _ => "unknown",
    }
}

fn be16(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}
fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn put_be16(b: &mut [u8], at: usize, v: u16) {
    b[at..at + 2].copy_from_slice(&v.to_be_bytes());
}

pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&c| c as char).collect()
}
pub fn to_latin1(s: &str) -> Vec<u8> {
    s.chars().map(|c| if (c as u32) < 256 { c as u32 as u8 } else { b'?' }).collect()
}

// --- CASt -----------------------------------------------------------------------------------------------------------

/// A member's info block: header bytes up to the item list, then the items.
#[derive(Clone, Debug)]
pub struct MemberInfo {
    pub header: Vec<u8>,
    pub items: Vec<Vec<u8>>,
}

impl MemberInfo {
    fn parse(b: &[u8]) -> Option<MemberInfo> {
        if b.len() < 20 {
            return None;
        }
        let data_offset = be32(b, 0) as usize;
        if data_offset + 2 > b.len() {
            return Some(MemberInfo { header: b.to_vec(), items: vec![] });
        }
        let count = be16(b, data_offset) as usize;
        let table = data_offset + 2;
        let items_start = table + (count + 1) * 4;
        if items_start > b.len() {
            return None;
        }
        let mut items = Vec::with_capacity(count);
        for i in 0..count {
            let a = items_start + be32(b, table + i * 4) as usize;
            let z = items_start + be32(b, table + (i + 1) * 4) as usize;
            items.push(b.get(a..z.min(b.len())).map(|s| s.to_vec()).unwrap_or_default());
        }
        Some(MemberInfo { header: b[..data_offset].to_vec(), items })
    }

    fn write(&self) -> Vec<u8> {
        let mut out = self.header.clone();
        out.extend_from_slice(&(self.items.len() as u16).to_be_bytes());
        let mut off = 0u32;
        out.extend_from_slice(&off.to_be_bytes());
        for it in &self.items {
            off += it.len() as u32;
            out.extend_from_slice(&off.to_be_bytes());
        }
        for it in &self.items {
            out.extend_from_slice(it);
        }
        out
    }

    /// A fresh info block: no script, the given name.
    pub fn new_named(name: &str) -> MemberInfo {
        let mut header = vec![0u8; 20];
        header[3] = 20;
        let mut info = MemberInfo { header, items: vec![vec![], vec![]] };
        info.set_name(name);
        info
    }

    pub fn name(&self) -> String {
        match self.items.get(1) {
            Some(n) if !n.is_empty() => {
                let len = (n[0] as usize).min(n.len() - 1);
                latin1(&n[1..1 + len])
            }
            _ => String::new(),
        }
    }

    pub fn set_name(&mut self, name: &str) {
        let mut bytes = to_latin1(name);
        bytes.truncate(255);
        while self.items.len() < 2 {
            self.items.push(vec![]);
        }
        let mut item = vec![bytes.len() as u8];
        item.extend_from_slice(&bytes);
        self.items[1] = item;
    }
}

#[derive(Clone, Debug)]
pub struct CastMemberRec {
    pub kind: u32,
    pub info: Option<MemberInfo>,
    pub specific: Vec<u8>,
}

impl CastMemberRec {
    pub fn parse(b: &[u8]) -> Result<CastMemberRec, String> {
        if b.len() < 12 {
            return Err("CASt too short".into());
        }
        let kind = be32(b, 0);
        let info_len = be32(b, 4) as usize;
        let spec_len = be32(b, 8) as usize;
        let info_bytes = b.get(12..12 + info_len).ok_or("CASt info past end")?;
        let specific = b.get(12 + info_len..12 + info_len + spec_len).ok_or("CASt data past end")?.to_vec();
        let info = if info_len == 0 { None } else { MemberInfo::parse(info_bytes) };
        Ok(CastMemberRec { kind, info, specific })
    }

    pub fn write(&self) -> Vec<u8> {
        let info = self.info.as_ref().map(|i| i.write()).unwrap_or_default();
        let mut out = Vec::with_capacity(12 + info.len() + self.specific.len());
        out.extend_from_slice(&self.kind.to_be_bytes());
        out.extend_from_slice(&(info.len() as u32).to_be_bytes());
        out.extend_from_slice(&(self.specific.len() as u32).to_be_bytes());
        out.extend_from_slice(&info);
        out.extend_from_slice(&self.specific);
        out
    }

    pub fn name(&self) -> String {
        self.info.as_ref().map(|i| i.name()).unwrap_or_default()
    }

    pub fn set_name(&mut self, name: &str) {
        match &mut self.info {
            Some(i) => i.set_name(name),
            None => self.info = Some(MemberInfo::new_named(name)),
        }
    }
}

// --- bitmap header --------------------------------------------------------------------------------------------------

/// The fields of a bitmap member's specific data the editor reads and writes.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitmapHeader {
    pub width: i32,
    pub height: i32,
    /// Registration point relative to the bitmap's top left.
    pub reg_x: i32,
    pub reg_y: i32,
    pub depth: u8,
    /// Palette: a member number of this cast (> 0), or a built-in palette (< 0: -1 systemMac, -3 grayscale,
    /// -102 systemWin...), as DirPlayer's BitmapInfo has it.
    pub palette_id: i16,
    pub clut_cast_lib: i16,
    pub use_alpha: bool,
}

/// Bitmap specific data of at least 28 bytes (a 1-bit member's shorter header is padded when it is rewritten).
fn bitmap_spec_min(spec: &[u8]) -> Vec<u8> {
    let mut s = spec.to_vec();
    if s.len() < 28 {
        s.resize(28, 0);
    }
    s
}

pub fn read_bitmap_header(spec: &[u8], dir_version: u16) -> BitmapHeader {
    let info = BitmapInfo::from_versioned(spec, dir_version);
    BitmapHeader {
        width: info.width as i32,
        height: info.height as i32,
        reg_x: info.reg_x as i32,
        reg_y: info.reg_y as i32,
        depth: info.bit_depth,
        palette_id: info.palette_id,
        clut_cast_lib: info.clut_cast_lib,
        use_alpha: info.use_alpha,
    }
}

/// Rewrite size, depth, palette and registration point; everything else in the header stays.
fn write_bitmap_header(spec: &[u8], width: i32, height: i32, reg_x: i32, reg_y: i32, depth: u8, clut_id: Option<i16>, clut_cast_lib: Option<i16>, use_alpha: bool) -> Vec<u8> {
    let mut s = bitmap_spec_min(spec);
    let top = i16::from_be_bytes([s[2], s[3]]) as i32;
    let left = i16::from_be_bytes([s[4], s[5]]) as i32;
    let pitch = if depth == 32 { width * 4 } else { ((width * depth as i32 + 15) / 16) * 2 };
    let flag = if depth > 1 { 0x8000 } else { 0 };
    put_be16(&mut s, 0, (pitch as u16 & 0x3fff) | flag);
    put_be16(&mut s, 6, (top + height) as i16 as u16);
    put_be16(&mut s, 8, (left + width) as i16 as u16);
    put_be16(&mut s, 18, (top + reg_y) as i16 as u16);
    put_be16(&mut s, 20, (left + reg_x) as i16 as u16);
    s[22] = if use_alpha { s[22] | 0x10 } else { s[22] & !0x10 };
    s[23] = depth;
    if let Some(id) = clut_id {
        put_be16(&mut s, 26, id as u16);
    }
    if let Some(lib) = clut_cast_lib {
        put_be16(&mut s, 24, lib as u16);
    }
    s
}

/// A `CLUT` payload: 256 entries of (r, r, g, g, b, b); missing entries are black.
fn clut_bytes(colors: &[(u8, u8, u8)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(256 * 6);
    for i in 0..256 {
        let (r, g, b) = colors.get(i).copied().unwrap_or((0, 0, 0));
        out.extend_from_slice(&[r, r, g, g, b, b]);
    }
    out
}

/// Only the registration point.
fn write_reg_point(spec: &[u8], reg_x: i32, reg_y: i32) -> Vec<u8> {
    let mut s = spec.to_vec();
    if s.len() < 22 {
        s.resize(22, 0);
    }
    let top = i16::from_be_bytes([s[2], s[3]]) as i32;
    let left = i16::from_be_bytes([s[4], s[5]]) as i32;
    put_be16(&mut s, 18, (top + reg_y) as i16 as u16);
    put_be16(&mut s, 20, (left + reg_x) as i16 as u16);
    s
}

/// A built-in palette's 256 colours (palette ids < 0 as DirPlayer's BitmapInfo has them; 0 = the system default).
pub fn builtin_palette_colors(palette_id: i16) -> Option<Vec<(u8, u8, u8)>> {
    if palette_id > 0 {
        return None;
    }
    let pref = PaletteRef::from(palette_id, -1, CAST_LIB);
    Some(resolve_palette_table(&PaletteMap::new(), &pref, 8))
}

/// The stored clutId for a palette id as DirPlayer reads it (built-ins are stored one higher).
pub fn stored_clut_id(palette_id: i16) -> i16 {
    if palette_id < 0 { palette_id + 1 } else { palette_id }
}

// --- STXT -----------------------------------------------------------------------------------------------------------

pub fn read_stxt(b: &[u8]) -> Option<(String, Vec<u8>)> {
    if b.len() < 12 {
        return None;
    }
    let header = be32(b, 0) as usize;
    let text_len = be32(b, 4) as usize;
    let text = b.get(header..header + text_len)?;
    let styles = b.get(header + text_len..).map(|s| s.to_vec()).unwrap_or_default();
    Some((latin1(text).replace('\r', "\n"), styles))
}

/// STXT for `text` with the old style runs; runs that would start past the new end are dropped.
pub fn write_stxt(text: &str, old_styles: &[u8]) -> Vec<u8> {
    let bytes = to_latin1(&text.replace("\r\n", "\r").replace('\n', "\r"));
    let mut styles = Vec::new();
    if old_styles.len() >= 2 {
        let count = be16(old_styles, 0) as usize;
        let mut kept: Vec<&[u8]> = Vec::new();
        for i in 0..count {
            let at = 2 + i * 20;
            let Some(run) = old_styles.get(at..at + 20) else { break };
            if i == 0 || (be32(run, 0) as usize) < bytes.len() {
                kept.push(run);
            }
        }
        if !kept.is_empty() {
            styles.extend_from_slice(&(kept.len() as u16).to_be_bytes());
            for r in kept {
                styles.extend_from_slice(r);
            }
        }
    }
    let mut out = Vec::with_capacity(12 + bytes.len() + styles.len());
    out.extend_from_slice(&12u32.to_be_bytes());
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(&(styles.len() as u32).to_be_bytes());
    out.extend_from_slice(&bytes);
    out.extend_from_slice(&styles);
    out
}

// --- document -------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct KeyEntry {
    pub section: u32,
    pub cast: u32,
    pub tag: Tag,
}

#[derive(Serialize)]
pub struct MemberSummary {
    pub slot: u32,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitmap: Option<BitmapHeader>,
    /// Media chunks the member owns, by tag.
    pub media: Vec<String>,
}

pub struct CastDoc {
    pub file: ContainerFile,
    pub dir_version: u16,
    cas_id: u32,
    key_id: u32,
    key_sizes: (u16, u16),
    pub keys: Vec<KeyEntry>,
    /// CASt resource id per slot (index = slot - 1), 0 = empty.
    pub slots: Vec<u32>,
    dirty_index: bool,
    bitmaps: RefCell<HashMap<u32, Rc<RefCell<Bitmap>>>>,
}

impl CastDoc {
    pub fn open(data: &[u8]) -> Result<CastDoc, String> {
        let file = ContainerFile::read(data)?;
        let cas_ids = file.ids_with_tag(b"CAS*");
        let cas_id = *cas_ids.first().ok_or("No cast (CAS*) in this file")?;
        if cas_ids.len() > 1 {
            return Err("This file has several casts; only single casts (.cct/.cst) can be edited".into());
        }
        let key_id = file.first_with_tag(b"KEY*").ok_or("No key table (KEY*) in this file")?;
        let cas = &file.resources[&cas_id].data;
        let slots = (0..cas.len() / 4).map(|i| be32(cas, i * 4)).collect();
        let kd = &file.resources[&key_id].data;
        let e = file.endian;
        let key_sizes = (e.u16(kd, 0), e.u16(kd, 2));
        let used = e.u32(kd, 8) as usize;
        let mut keys = Vec::with_capacity(used);
        for i in 0..used {
            let at = 12 + i * 12;
            if at + 12 > kd.len() {
                break;
            }
            let section = e.u32(kd, at);
            if section == 0 || section == 0xFFFF_FFFF {
                continue;
            }
            keys.push(KeyEntry { section, cast: e.u32(kd, at + 4), tag: e.tag(kd, at + 8) });
        }
        let dir_version = human_version(file.meta.director_version as u16);
        Ok(CastDoc {
            file,
            dir_version,
            cas_id,
            key_id,
            key_sizes,
            keys,
            slots,
            dirty_index: false,
            bitmaps: RefCell::new(HashMap::new()),
        })
    }

    pub fn endian(&self) -> Endian {
        self.file.endian
    }

    pub fn cast_id(&self, slot: u32) -> Option<u32> {
        let id = *self.slots.get(slot.checked_sub(1)? as usize)?;
        if id == 0 || !self.file.resources.contains_key(&id) { None } else { Some(id) }
    }

    pub fn member(&self, slot: u32) -> Result<CastMemberRec, String> {
        let id = self.cast_id(slot).ok_or_else(|| format!("No member in slot {}", slot))?;
        CastMemberRec::parse(&self.file.resources[&id].data)
    }

    fn put_member(&mut self, slot: u32, rec: &CastMemberRec) -> Result<(), String> {
        let id = self.cast_id(slot).ok_or_else(|| format!("No member in slot {}", slot))?;
        self.file.set(id, *b"CASt", rec.write());
        Ok(())
    }

    pub fn media(&self, cast_id: u32, tag: &Tag) -> Option<u32> {
        self.keys
            .iter()
            .find(|k| k.cast == cast_id && &k.tag == tag && self.file.resources.contains_key(&k.section))
            .map(|k| k.section)
    }

    pub fn slot_by_name(&self, name: &str) -> Option<u32> {
        let lower = name.to_ascii_lowercase();
        (1..=self.slots.len() as u32).rev().find(|&s| self.member(s).map(|m| m.name().to_ascii_lowercase() == lower).unwrap_or(false))
    }

    pub fn summaries(&self) -> Vec<MemberSummary> {
        let mut out = Vec::new();
        for slot in 1..=self.slots.len() as u32 {
            let Some(id) = self.cast_id(slot) else { continue };
            let Ok(rec) = CastMemberRec::parse(&self.file.resources[&id].data) else { continue };
            let bitmap = (rec.kind == TYPE_BITMAP).then(|| read_bitmap_header(&rec.specific, self.dir_version));
            let media = self
                .keys
                .iter()
                .filter(|k| k.cast == id && self.file.resources.contains_key(&k.section))
                .map(|k| super::container::tag_str(&k.tag))
                .collect();
            out.push(MemberSummary { slot, kind: type_name(rec.kind), name: rec.name(), bitmap, media });
        }
        out
    }

    // --- names and texts --------------------------------------------------------------------------------------------

    pub fn set_name(&mut self, slot: u32, name: &str) -> Result<(), String> {
        let mut rec = self.member(slot)?;
        rec.set_name(name);
        self.put_member(slot, &rec)
    }

    pub fn text(&self, slot: u32) -> Option<String> {
        let id = self.cast_id(slot)?;
        let sec = self.media(id, b"STXT")?;
        read_stxt(&self.file.resources[&sec].data).map(|(t, _)| t)
    }

    pub fn set_text(&mut self, slot: u32, text: &str) -> Result<(), String> {
        let id = self.cast_id(slot).ok_or("No such member")?;
        match self.media(id, b"STXT") {
            Some(sec) => {
                let old = read_stxt(&self.file.resources[&sec].data).map(|(_, s)| s).unwrap_or_default();
                self.file.set(sec, *b"STXT", write_stxt(text, &old));
            }
            None => {
                let sec = self.file.next_id();
                self.file.set(sec, *b"STXT", write_stxt(text, &[]));
                self.keys.push(KeyEntry { section: sec, cast: id, tag: *b"STXT" });
                self.dirty_index = true;
            }
        }
        Ok(())
    }

    // --- palettes and bitmaps ---------------------------------------------------------------------------------------

    pub fn palette_colors(&self, slot: u32) -> Option<Vec<(u8, u8, u8)>> {
        let id = self.cast_id(slot)?;
        let sec = self.media(id, b"CLUT")?;
        let d = &self.file.resources[&sec].data;
        Some((0..d.len() / 6).map(|i| (d[i * 6], d[i * 6 + 2], d[i * 6 + 4])).collect())
    }

    /// The cast's palettes, numbered as the player numbers them for cast library [`CAST_LIB`].
    pub fn palette_map(&self) -> PaletteMap {
        let mut map = PaletteMap::new();
        for slot in 1..=self.slots.len() as u32 {
            if let Ok(rec) = self.member(slot) {
                if rec.kind == TYPE_PALETTE {
                    if let Some(colors) = self.palette_colors(slot) {
                        map.insert(((CAST_LIB - 1) << 16) | slot, PaletteMember { colors });
                    }
                }
            }
        }
        map
    }

    pub fn bitmap_header(&self, slot: u32) -> Result<BitmapHeader, String> {
        let rec = self.member(slot)?;
        if rec.kind != TYPE_BITMAP {
            return Err(format!("Slot {} is not a bitmap", slot));
        }
        Ok(read_bitmap_header(&rec.specific, self.dir_version))
    }

    /// The member decoded by DirPlayer's own decoder (cached until the member changes).
    pub fn bitmap(&self, slot: u32) -> Result<Rc<RefCell<Bitmap>>, String> {
        if let Some(b) = self.bitmaps.borrow().get(&slot) {
            return Ok(b.clone());
        }
        let rec = self.member(slot)?;
        if rec.kind != TYPE_BITMAP {
            return Err(format!("Slot {} is not a bitmap", slot));
        }
        let id = self.cast_id(slot).unwrap();
        let info = BitmapInfo::from_versioned(&rec.specific, self.dir_version);
        let alfa = self.media(id, b"ALFA").map(|s| self.file.resources[&s].data.clone());
        let bitmap = if let Some(sec) = self.media(id, b"BITD") {
            let data = &self.file.resources[&sec].data;
            let jpeg = data.len() >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF;
            if jpeg && alfa.is_some() {
                decode_jpeg_bitmap(data, &info, alfa.as_ref())?
            } else {
                decompress_bitmap(data, &info, CAST_LIB, self.dir_version)?
            }
        } else if let Some(sec) = self.media(id, b"ediM") {
            decode_jpeg_bitmap(&self.file.resources[&sec].data, &info, alfa.as_ref())?
        } else {
            Bitmap::new(info.width.max(1), info.height.max(1), 8, 8, 0, PaletteRef::from(-1, -1, CAST_LIB))
        };
        let rc = Rc::new(RefCell::new(bitmap));
        self.bitmaps.borrow_mut().insert(slot, rc.clone());
        Ok(rc)
    }

    pub fn forget_bitmap(&self, slot: u32) {
        self.bitmaps.borrow_mut().remove(&slot);
    }

    /// RGBA pixels of a member, palette applied (alpha only from a 32-bit member that uses it).
    pub fn rgba(&self, slot: u32) -> Result<(u32, u32, Vec<u8>), String> {
        let b = self.bitmap(slot)?;
        let b = b.borrow();
        let palettes = self.palette_map();
        let (w, h) = (b.width as u32, b.height as u32);
        let mut out = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                if b.bit_depth == 32 {
                    out[i..i + 4].copy_from_slice(&b.data[i..i + 4]);
                    if !b.use_alpha {
                        out[i + 3] = 255;
                    }
                } else {
                    let (r, g, bl) = b.get_pixel_color(&palettes, x as u16, y as u16);
                    out[i] = r;
                    out[i + 1] = g;
                    out[i + 2] = bl;
                    out[i + 3] = 255;
                }
            }
        }
        Ok((w, h, out))
    }

    /// Palette indices of an indexed (8-bit or less) member, one byte per pixel.
    pub fn indices(&self, slot: u32) -> Result<(u32, u32, Vec<u8>), String> {
        let b = self.bitmap(slot)?;
        let b = b.borrow();
        if b.bit_depth > 8 {
            return Err(format!("Slot {} is {}-bit, not indexed", slot, b.bit_depth));
        }
        let (w, h) = (b.width as u32, b.height as u32);
        let mut out = vec![0u8; (w * h) as usize];
        for y in 0..h {
            for x in 0..w {
                if let ColorRef::PaletteIndex(i) = b.get_pixel_color_ref(x as u16, y as u16) {
                    out[(y * w + x) as usize] = i;
                }
            }
        }
        Ok((w, h, out))
    }

    /// Store palette indices as the member's 8-bit pixels. `palette_id` as in [`BitmapHeader`] (a palette member's
    /// slot, or a built-in below 0); 0 keeps the member's palette. Switching to a member palette from a built-in also
    /// sets clutCastLib the way the cast's other bitmaps have it (else -1: the bitmap's own cast).
    pub fn put_indexed(&mut self, slot: u32, indices: &[u8], width: u32, height: u32, reg_x: i32, reg_y: i32, palette_id: i16) -> Result<(), String> {
        let header = self.bitmap_header(slot)?;
        let pal = if palette_id == 0 { header.palette_id } else { palette_id };
        if pal > 0 && self.member(pal as u32).map(|m| m.kind != TYPE_PALETTE).unwrap_or(true) {
            return Err(format!("Slot {} is not a palette", pal));
        }
        let mut enc = super::bitmap::encode_indices(indices, width, height, stored_clut_id(pal))?;
        if pal > 0 && header.palette_id <= 0 {
            let lib = self
                .summaries()
                .iter()
                .filter_map(|m| m.bitmap.as_ref())
                .find(|b| b.palette_id > 0)
                .map(|b| b.clut_cast_lib)
                .unwrap_or(-1);
            enc.clut_cast_lib = Some(lib);
        }
        self.put_bitmap(slot, &enc, reg_x, reg_y)
    }

    /// Change a palette member's colours (every bitmap on it changes with it).
    pub fn set_palette_colors(&mut self, slot: u32, colors: &[(u8, u8, u8)]) -> Result<(), String> {
        let rec = self.member(slot)?;
        if rec.kind != TYPE_PALETTE {
            return Err(format!("Slot {} is not a palette", slot));
        }
        let id = self.cast_id(slot).unwrap();
        let data = clut_bytes(colors);
        match self.media(id, b"CLUT") {
            Some(sec) => self.file.set(sec, *b"CLUT", data),
            None => {
                let sec = self.file.next_id();
                self.file.set(sec, *b"CLUT", data);
                self.keys.push(KeyEntry { section: sec, cast: id, tag: *b"CLUT" });
                self.dirty_index = true;
            }
        }
        self.bitmaps.borrow_mut().clear();
        Ok(())
    }

    /// A new palette member (Director's layout: a named CASt of type 4 without specific data, and its CLUT).
    pub fn add_palette(&mut self, name: &str, colors: &[(u8, u8, u8)]) -> Result<u32, String> {
        let rec = CastMemberRec { kind: TYPE_PALETTE, info: Some(MemberInfo::new_named(name)), specific: vec![] };
        let id = self.file.next_id();
        self.file.set(id, *b"CASt", rec.write());
        let slot = self.free_slot();
        self.slots[slot as usize - 1] = id;
        self.dirty_index = true;
        self.set_palette_colors(slot, colors)?;
        Ok(slot)
    }

    pub fn set_reg_point(&mut self, slot: u32, reg_x: i32, reg_y: i32) -> Result<(), String> {
        let mut rec = self.member(slot)?;
        if rec.kind != TYPE_BITMAP {
            return Err("Not a bitmap".into());
        }
        rec.specific = write_reg_point(&rec.specific, reg_x, reg_y);
        self.put_member(slot, &rec)?;
        self.forget_bitmap(slot);
        Ok(())
    }

    /// Replace a bitmap member's pixels with already encoded BITD data.
    pub fn put_bitmap(&mut self, slot: u32, enc: &super::bitmap::Encoded, reg_x: i32, reg_y: i32) -> Result<(), String> {
        let mut rec = self.member(slot)?;
        if rec.kind != TYPE_BITMAP {
            return Err("Not a bitmap".into());
        }
        let id = self.cast_id(slot).unwrap();
        rec.specific = write_bitmap_header(&rec.specific, enc.width as i32, enc.height as i32, reg_x, reg_y, enc.depth, enc.clut_id, enc.clut_cast_lib, enc.use_alpha);
        self.put_member(slot, &rec)?;
        // The new pixels replace any JPEG and alpha plane the member had.
        let stale: Vec<u32> = self
            .keys
            .iter()
            .filter(|k| k.cast == id && matches!(&k.tag, b"ALFA" | b"ediM"))
            .map(|k| k.section)
            .collect();
        if !stale.is_empty() {
            for s in &stale {
                self.file.remove(*s);
            }
            self.keys.retain(|k| !(k.cast == id && stale.contains(&k.section)));
            self.dirty_index = true;
        }
        match self.media(id, b"BITD") {
            Some(sec) => self.file.set(sec, *b"BITD", enc.bitd.clone()),
            None => {
                let sec = self.file.next_id();
                self.file.set(sec, *b"BITD", enc.bitd.clone());
                self.keys.push(KeyEntry { section: sec, cast: id, tag: *b"BITD" });
                self.dirty_index = true;
            }
        }
        self.forget_bitmap(slot);
        Ok(())
    }

    // --- adding and removing members --------------------------------------------------------------------------------

    fn free_slot(&mut self) -> u32 {
        if let Some(i) = self.slots.iter().position(|&id| id == 0) {
            return i as u32 + 1;
        }
        self.slots.push(0);
        self.slots.len() as u32
    }

    /// Copy a member (its CASt and media chunks) into a new slot under a new name. Returns the new slot.
    pub fn duplicate(&mut self, slot: u32, name: &str) -> Result<u32, String> {
        let src = self.cast_id(slot).ok_or("No such member")?;
        let mut rec = self.member(slot)?;
        rec.set_name(name);
        let new_id = self.file.next_id();
        self.file.set(new_id, *b"CASt", rec.write());
        let media: Vec<KeyEntry> = self.keys.iter().filter(|k| k.cast == src).cloned().collect();
        for k in media {
            let Some(r) = self.file.resources.get(&k.section).cloned() else { continue };
            let sec = self.file.next_id();
            self.file.resources.insert(sec, r);
            self.keys.push(KeyEntry { section: sec, cast: new_id, tag: k.tag });
        }
        let new_slot = self.free_slot();
        self.slots[new_slot as usize - 1] = new_id;
        self.dirty_index = true;
        Ok(new_slot)
    }

    pub fn delete(&mut self, slot: u32) -> Result<(), String> {
        let id = self.cast_id(slot).ok_or("No such member")?;
        let media: Vec<u32> = self.keys.iter().filter(|k| k.cast == id).map(|k| k.section).collect();
        for s in &media {
            self.file.remove(*s);
        }
        self.keys.retain(|k| k.cast != id);
        self.file.remove(id);
        self.slots[slot as usize - 1] = 0;
        while self.slots.last() == Some(&0) {
            self.slots.pop();
        }
        self.forget_bitmap(slot);
        self.dirty_index = true;
        Ok(())
    }

    // --- writing ----------------------------------------------------------------------------------------------------

    fn flush_index(&mut self) {
        if !self.dirty_index {
            return;
        }
        let mut cas = Vec::with_capacity(self.slots.len() * 4);
        for id in &self.slots {
            cas.extend_from_slice(&id.to_be_bytes());
        }
        self.file.set(self.cas_id, *b"CAS*", cas);
        let e = self.file.endian;
        let mut kd = Vec::with_capacity(12 + self.keys.len() * 12);
        e.put_u16(&mut kd, self.key_sizes.0);
        e.put_u16(&mut kd, self.key_sizes.1);
        e.put_u32(&mut kd, self.keys.len() as u32);
        e.put_u32(&mut kd, self.keys.len() as u32);
        for k in &self.keys {
            e.put_u32(&mut kd, k.section);
            e.put_u32(&mut kd, k.cast);
            e.put_tag(&mut kd, &k.tag);
        }
        self.file.set(self.key_id, *b"KEY*", kd);
        self.dirty_index = false;
    }

    /// The cast as an afterburned `.cct`.
    pub fn save(&mut self) -> Vec<u8> {
        self.flush_index();
        self.file.write_afterburned()
    }
}
