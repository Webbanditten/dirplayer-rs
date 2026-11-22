//! Encoding RGBA pixels into a bitmap member's `BITD`.
//!
//! `BITD` is the member's rows, `pitch` bytes each, PackBits-compressed row by row (a payload at or above the raw
//! size is read as uncompressed, so incompressible pixels are stored raw). 8-bit rows are palette indices padded to
//! an even width; 32-bit rows are channel-planar: the row's alpha bytes, then red, green and blue. Runs are capped
//! at 127 bytes, as Director writes them (see `compress_bitmap`).
//!
//! Habbo's white-keyed inks (8 matte, 36 background transparent, ...) drop the background colour connected to the
//! image's edges: palette index 0 in an 8-bit member, white in a 32-bit one. Transparent pixels are written that
//! way, so an imported picture keeps its shape under those inks as well as under alpha.

use serde::Serialize;

use crate::player::bitmap::bitmap::compress_bitmap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportMode {
    /// 8-bit on the member's palette when every colour is in it, else 32-bit.
    Auto,
    /// 8-bit on the given palette; colours that aren't in it take the nearest entry.
    Indexed,
    /// 32-bit with alpha.
    Rgba32,
}

impl ImportMode {
    pub fn parse(s: &str) -> ImportMode {
        match s {
            "indexed" | "8" => ImportMode::Indexed,
            "rgba" | "32" => ImportMode::Rgba32,
            _ => ImportMode::Auto,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ImportReport {
    pub depth: u8,
    /// Opaque pixels whose colour wasn't in the palette (indexed import; they took the nearest colour).
    pub approximated: u32,
    /// Pixels made transparent (alpha below 128 in an indexed import, alpha 0 in a 32-bit one).
    pub transparent: u32,
    /// Pixels with partial alpha (only kept by a 32-bit import).
    pub partial_alpha: u32,
    pub bytes: usize,
}

pub struct Encoded {
    pub width: u32,
    pub height: u32,
    pub depth: u8,
    pub bitd: Vec<u8>,
    /// Stored clutId to write, when the depth uses a palette.
    pub clut_id: Option<i16>,
    pub use_alpha: bool,
    pub report: ImportReport,
}

fn pack_rows(raw: &[u8], pitch: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() / 2);
    for row in raw.chunks(pitch) {
        out.extend_from_slice(&compress_bitmap(row));
    }
    if out.len() >= raw.len() { raw.to_vec() } else { out }
}

fn nearest(palette: &[(u8, u8, u8)], r: u8, g: u8, b: u8) -> u8 {
    let mut best = 0usize;
    let mut best_d = u32::MAX;
    for (i, &(pr, pg, pb)) in palette.iter().enumerate() {
        let d = (pr as i32 - r as i32).pow(2) as u32 + (pg as i32 - g as i32).pow(2) as u32 + (pb as i32 - b as i32).pow(2) as u32;
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    best as u8
}

/// Encode `rgba` (width x height x 4). `palette` = the target palette's colours and its stored clutId, needed for an
/// indexed (or auto) import.
pub fn encode(rgba: &[u8], width: u32, height: u32, mode: ImportMode, palette: Option<(&[(u8, u8, u8)], i16)>) -> Result<Encoded, String> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || rgba.len() != w * h * 4 {
        return Err(format!("Expected {}x{} RGBA pixels, got {} bytes", width, height, rgba.len()));
    }
    let mut report = ImportReport::default();
    let px = |i: usize| (rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]);

    let indexed = match (mode, palette) {
        (ImportMode::Rgba32, _) | (_, None) => false,
        (ImportMode::Indexed, Some(_)) => true,
        (ImportMode::Auto, Some((pal, _))) => (0..w * h).all(|i| {
            let (r, g, b, a) = px(i);
            a == 0 || (a == 255 && pal.iter().any(|&c| c == (r, g, b)))
        }),
    };
    if mode == ImportMode::Indexed && palette.is_none() {
        return Err("An indexed import needs a palette".into());
    }

    if indexed {
        let (pal, clut) = palette.unwrap();
        let mut exact = std::collections::HashMap::new();
        for (i, &c) in pal.iter().enumerate().rev() {
            exact.insert(c, i as u8);
        }
        let pitch = w + (w & 1);
        let mut raw = vec![0u8; pitch * h];
        for y in 0..h {
            for x in 0..w {
                let (r, g, b, a) = px(y * w + x);
                raw[y * pitch + x] = if a < 128 {
                    report.transparent += 1;
                    0
                } else if let Some(&i) = exact.get(&(r, g, b)) {
                    i
                } else {
                    report.approximated += 1;
                    nearest(pal, r, g, b)
                };
            }
        }
        let bitd = pack_rows(&raw, pitch);
        report.depth = 8;
        report.bytes = bitd.len();
        return Ok(Encoded { width, height, depth: 8, bitd, clut_id: Some(clut), use_alpha: false, report });
    }

    let pitch = w * 4;
    let mut raw = vec![0u8; pitch * h];
    let mut use_alpha = false;
    for y in 0..h {
        let row = &mut raw[y * pitch..(y + 1) * pitch];
        for x in 0..w {
            let (mut r, mut g, mut b, a) = px(y * w + x);
            if a == 0 {
                report.transparent += 1;
                r = 255;
                g = 255;
                b = 255;
            } else if a < 255 {
                report.partial_alpha += 1;
            }
            if a < 255 {
                use_alpha = true;
            }
            row[x] = a;
            row[w + x] = r;
            row[w * 2 + x] = g;
            row[w * 3 + x] = b;
        }
    }
    let bitd = pack_rows(&raw, pitch);
    report.depth = 32;
    report.bytes = bitd.len();
    Ok(Encoded { width, height, depth: 32, bitd, clut_id: None, use_alpha, report })
}
