//! Drawing members like score sprites, through the player's own sprite code path (matte for the matte inks, then
//! `copy_pixels_with_params` with the sprite's ink, blend, colours and flips), so a preview shows what the web
//! client shows. Mirrors the bitmap branch of `rendering.rs`.

use serde::Deserialize;

use super::cast::CastDoc;
use crate::player::bitmap::bitmap::{Bitmap, BuiltInPalette, PaletteRef};
use crate::player::bitmap::drawing::{should_matte_sprite, CopyPixelsParams};
use crate::player::geometry::IntRect;
use crate::player::sprite::{ColorRef, Sprite};

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpriteSpec {
    pub slot: u32,
    /// Top left of the sprite's rect on the canvas.
    pub left: i32,
    pub top: i32,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    #[serde(default)]
    pub ink: u32,
    #[serde(default = "full_blend")]
    pub blend: i32,
    /// foreColor / bgColor as RGB, when the sprite sets them.
    #[serde(default)]
    pub color: Option<[u8; 3]>,
    #[serde(default)]
    pub bg_color: Option<[u8; 3]>,
}

fn full_blend() -> i32 {
    100
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenderSpec {
    pub width: u32,
    pub height: u32,
    pub sprites: Vec<SpriteSpec>,
}

/// Draw `spec.sprites` in order onto `background` (RGBA, width x height; white when absent). Returns RGBA.
pub fn render(doc: &CastDoc, spec: &RenderSpec, background: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let (w, h) = (spec.width as usize, spec.height as usize);
    if w == 0 || h == 0 || w > 4096 || h > 4096 {
        return Err("Canvas size must be 1..4096".into());
    }
    let mut canvas = Bitmap::new(spec.width as u16, spec.height as u16, 32, 32, 0, PaletteRef::BuiltIn(BuiltInPalette::SystemWin));
    if let Some(bg) = background {
        if bg.len() != w * h * 4 {
            return Err("Background has the wrong size".into());
        }
        canvas.data.copy_from_slice(bg);
    }
    let palettes = doc.palette_map();
    for s in &spec.sprites {
        let Ok(rc) = doc.bitmap(s.slot) else { continue };
        let mut src = rc.borrow_mut();
        if src.width == 0 || src.height == 0 {
            continue;
        }
        if should_matte_sprite(s.ink) && src.matte.is_none() {
            src.create_matte(&palettes);
        }
        let mut sprite = Sprite::new(1);
        sprite.ink = s.ink as i32;
        sprite.blend = s.blend;
        sprite.flip_h = s.flip_h;
        sprite.flip_v = s.flip_v;
        if let Some([r, g, b]) = s.color {
            sprite.color = ColorRef::Rgb(r, g, b);
            sprite.has_fore_color = true;
        }
        if let Some([r, g, b]) = s.bg_color {
            sprite.bg_color = ColorRef::Rgb(r, g, b);
            sprite.has_back_color = true;
        }
        let (sw, sh) = (src.width as i32, src.height as i32);
        let logical = IntRect::from(s.left, s.top, s.left + sw, s.top + sh);
        let dst = IntRect::from(
            if s.flip_h { logical.right } else { logical.left },
            if s.flip_v { logical.bottom } else { logical.top },
            if s.flip_h { logical.left } else { logical.right },
            if s.flip_v { logical.top } else { logical.bottom },
        );
        let mut params = CopyPixelsParams {
            blend: s.blend,
            ink: s.ink,
            color: sprite.color.clone(),
            bg_color: sprite.bg_color.clone(),
            bg_color_explicit: false,
            fore_color_explicit: false,
            mask_image: None,
            mask_offset: (0, 0),
            is_text_rendering: false,
            rotation: 0.0,
            skew: 0.0,
            sprite: Some(&sprite),
            original_dst_rect: Some(logical),
            ink9_mask_bitmap: None,
            ink9_mask_offset: (0, 0),
            floor_rule: true,
        };
        let matte = if should_matte_sprite(s.ink) { src.matte.clone() } else { None };
        if let Some(m) = matte.as_ref() {
            params.mask_image = Some(m.as_ref());
        }
        canvas.copy_pixels_with_params(&palettes, &src, dst, IntRect::from(0, 0, sw, sh), &params);
    }
    let mut out = canvas.data;
    for a in out.iter_mut().skip(3).step_by(4) {
        *a = 255;
    }
    Ok(out)
}
