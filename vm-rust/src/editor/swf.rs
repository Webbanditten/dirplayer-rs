//! Reading the parts of a Flash (SWF) file an asset converter needs: embedded binary data (`DefineBinaryData`, e.g.
//! XML), the class names exported for characters (`SymbolClass`) and bitmaps (`DefineBitsLossless`/`2`,
//! `DefineBitsJPEG2`/`3`/`4`). Habbo's Flash furni are such files: their XML describes the furni and every picture is
//! a bitmap exported under `<sprite>_<asset name>`.
//!
//! ```text
//! "FWS" | "CWS" (zlib after byte 8) | "ZWS" (LZMA, not read), u8 version, u32 LE file length
//! RECT (5-bit nbits + 4 x nbits), u16 frame rate (8.8), u16 frame count, then tags:
//!   u16 LE (code << 6 | length), length 0x3f -> u32 LE length follows
//! ```

use std::io::Read;

use flate2::read::ZlibDecoder;

pub struct SwfImage {
    pub id: u16,
    pub width: u32,
    pub height: u32,
    /// Straight (not premultiplied) RGBA.
    pub rgba: Vec<u8>,
}

#[derive(Default)]
pub struct SwfFile {
    pub version: u8,
    pub binary: Vec<(u16, Vec<u8>)>,
    pub images: Vec<SwfImage>,
    /// (character id, exported class name), in file order; one character can have several names.
    pub symbols: Vec<(u16, String)>,
    /// Bitmaps that couldn't be read: (tag code, character id, reason).
    pub skipped: Vec<(u16, u16, String)>,
}

fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    ZlibDecoder::new(data).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn u16le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn unpremultiply(c: u8, a: u8) -> u8 {
    if a == 0 { 0 } else { ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8 }
}

/// DefineBitsLossless (alpha = false) / DefineBitsLossless2 (alpha = true), after the character id.
fn lossless(b: &[u8], alpha: bool) -> Result<(u32, u32, Vec<u8>), String> {
    if b.len() < 5 {
        return Err("too short".into());
    }
    let format = b[0];
    let (w, h) = (u16le(b, 1) as usize, u16le(b, 3) as usize);
    let mut rgba = vec![0u8; w * h * 4];
    match format {
        3 => {
            let colors = b.get(5).copied().ok_or("no colour table size")? as usize + 1;
            let data = inflate(&b[6..])?;
            let entry = if alpha { 4 } else { 3 };
            let table = colors * entry;
            let pitch = (w + 3) & !3;
            for y in 0..h {
                for x in 0..w {
                    let i = *data.get(table + y * pitch + x).ok_or("pixels past end")? as usize;
                    let o = (y * w + x) * 4;
                    if i < colors {
                        let c = &data[i * entry..i * entry + entry];
                        let a = if alpha { c[3] } else { 255 };
                        rgba[o..o + 4].copy_from_slice(&[c[0], c[1], c[2], a]);
                        if alpha {
                            for k in 0..3 {
                                rgba[o + k] = unpremultiply(rgba[o + k], a);
                            }
                        }
                    }
                }
            }
        }
        4 => {
            let data = inflate(&b[5..])?;
            let pitch = (w * 2 + 3) & !3;
            for y in 0..h {
                for x in 0..w {
                    let at = y * pitch + x * 2;
                    let v = u16::from_be_bytes([*data.get(at).ok_or("pixels past end")?, data[at + 1]]);
                    let (r, g, bl) = (((v >> 10) & 31) as u8, ((v >> 5) & 31) as u8, (v & 31) as u8);
                    let o = (y * w + x) * 4;
                    rgba[o..o + 4].copy_from_slice(&[r << 3 | r >> 2, g << 3 | g >> 2, bl << 3 | bl >> 2, 255]);
                }
            }
        }
        5 => {
            let data = inflate(&b[5..])?;
            if data.len() < w * h * 4 {
                return Err("pixels past end".into());
            }
            for i in 0..w * h {
                let (a, r, g, bl) = (data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]);
                let o = i * 4;
                if alpha {
                    rgba[o..o + 4].copy_from_slice(&[unpremultiply(r, a), unpremultiply(g, a), unpremultiply(bl, a), a]);
                } else {
                    rgba[o..o + 4].copy_from_slice(&[r, g, bl, 255]);
                }
            }
        }
        f => return Err(format!("bitmap format {}", f)),
    }
    Ok((w as u32, h as u32, rgba))
}

/// DefineBitsJPEG2/3/4 image data: JPEG (maybe with the old erroneous FFD9FFD8 prefix), PNG or GIF.
fn decode_embedded(data: &[u8], alpha_zlib: Option<&[u8]>) -> Result<(u32, u32, Vec<u8>), String> {
    let data = if data.starts_with(&[0xFF, 0xD9, 0xFF, 0xD8]) { &data[4..] } else { data };
    let img = image::load_from_memory(data).map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    let mut rgba = img.into_raw();
    if let Some(z) = alpha_zlib {
        if let Ok(alpha) = inflate(z) {
            if alpha.len() >= (w * h) as usize {
                for i in 0..(w * h) as usize {
                    let a = alpha[i];
                    rgba[i * 4 + 3] = a;
                    for k in 0..3 {
                        rgba[i * 4 + k] = unpremultiply(rgba[i * 4 + k], a);
                    }
                }
            }
        }
    }
    Ok((w, h, rgba))
}

impl SwfFile {
    pub fn read(file: &[u8]) -> Result<SwfFile, String> {
        if file.len() < 8 {
            return Err("Not a SWF file".into());
        }
        let version = file[3];
        let body = match &file[0..3] {
            b"FWS" => file[8..].to_vec(),
            b"CWS" => inflate(&file[8..]).map_err(|e| format!("Couldn't decompress the SWF: {}", e))?,
            b"ZWS" => return Err("LZMA-compressed SWF files (ZWS) aren't supported yet".into()),
            _ => return Err("Not a SWF file".into()),
        };
        if body.is_empty() {
            return Err("Empty SWF".into());
        }
        // RECT: 5 bits of nbits, then four nbits-bit fields, padded to a byte.
        let nbits = (body[0] >> 3) as usize;
        let rect_bytes = (5 + nbits * 4 + 7) / 8;
        let mut p = rect_bytes + 4;
        let mut swf = SwfFile { version, ..Default::default() };
        while p + 2 <= body.len() {
            let head = u16le(&body, p);
            p += 2;
            let code = head >> 6;
            let mut len = (head & 0x3f) as usize;
            if len == 0x3f {
                if p + 4 > body.len() {
                    break;
                }
                len = u32le(&body, p) as usize;
                p += 4;
            }
            if p + len > body.len() {
                break;
            }
            let t = &body[p..p + len];
            p += len;
            match code {
                0 => break,
                87 if t.len() >= 6 => swf.binary.push((u16le(t, 0), t[6..].to_vec())),
                76 if t.len() >= 2 => {
                    let n = u16le(t, 0) as usize;
                    let mut q = 2;
                    for _ in 0..n {
                        if q + 2 > t.len() {
                            break;
                        }
                        let id = u16le(t, q);
                        q += 2;
                        let end = t[q..].iter().position(|&c| c == 0).map(|e| q + e).unwrap_or(t.len());
                        swf.symbols.push((id, String::from_utf8_lossy(&t[q..end]).into_owned()));
                        q = end + 1;
                    }
                }
                20 | 36 if t.len() >= 2 => {
                    let id = u16le(t, 0);
                    match lossless(&t[2..], code == 36) {
                        Ok((width, height, rgba)) => swf.images.push(SwfImage { id, width, height, rgba }),
                        Err(e) => swf.skipped.push((code, id, e)),
                    }
                }
                21 | 35 | 90 if t.len() >= 2 => {
                    let id = u16le(t, 0);
                    let res = if code == 21 {
                        decode_embedded(&t[2..], None)
                    } else if t.len() >= 6 {
                        let off = u32le(t, 2) as usize;
                        let start = if code == 90 { 8 } else { 6 };
                        let img = t.get(start..start + off).unwrap_or(&[]);
                        decode_embedded(img, t.get(start + off..))
                    } else {
                        Err("too short".into())
                    };
                    match res {
                        Ok((width, height, rgba)) => swf.images.push(SwfImage { id, width, height, rgba }),
                        Err(e) => swf.skipped.push((code, id, e)),
                    }
                }
                6 if t.len() >= 2 => swf.skipped.push((code, u16le(t, 0), "DefineBits with shared JPEG tables".into())),
                _ => {}
            }
        }
        Ok(swf)
    }

    pub fn names_of(&self, id: u16) -> Vec<String> {
        self.symbols.iter().filter(|(i, _)| *i == id).map(|(_, n)| n.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpremultiplies() {
        assert_eq!(unpremultiply(64, 128), 128);
        assert_eq!(unpremultiply(10, 0), 0);
        assert_eq!(unpremultiply(255, 255), 255);
    }

    /// EDITOR_SWF=<dir of .swf>: every file reads, with binary data and bitmaps whose names match.
    #[test]
    fn corpus_swfs() {
        let Ok(dir) = std::env::var("EDITOR_SWF") else { return };
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("swf") {
                continue;
            }
            let swf = SwfFile::read(&std::fs::read(&p).unwrap()).unwrap_or_else(|e| panic!("{:?}: {}", p, e));
            let named = swf.images.iter().filter(|i| !swf.names_of(i.id).is_empty()).count();
            eprintln!(
                "{:?}: v{}, {} binary, {} images ({} named), {} skipped {:?}",
                p.file_name().unwrap(),
                swf.version,
                swf.binary.len(),
                swf.images.len(),
                named,
                swf.skipped.len(),
                swf.skipped.first().map(|s| &s.2)
            );
            assert!(!swf.binary.is_empty() && !swf.images.is_empty(), "{:?}", p);
        }
    }
}
