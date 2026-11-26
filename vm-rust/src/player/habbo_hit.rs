//! Habbo room clicks (Habbo fork; off with the external param `habbo_room_hit=0`).
//!
//! Director finds the sprite under the mouse by its rectangle (only Matte ink goes by the picture), and Habbo's room
//! code mends that for one case: a click on a white pixel of a furni drawn with Background Transparent ink is handed
//! to the sprite behind it (`validateEvent` of "Room Interface Class"). Everything else keeps the rectangle:
//!
//! - a light layer (Add ink: a lamp's glow, 90 x 117 around cn_lamp) takes every click in its rectangle unless the
//!   furni's `.props` marks it `#transparent`, which Sulake left out on a good many furni;
//! - hovering goes by the rectangle altogether, so the room bar names the furni whose rectangle is in front rather
//!   than the one the mouse is on.
//!
//! Here a furni's sprite is only under the mouse where its picture shows something:
//!
//! | ink | not there |
//! |---|---|
//! | 36 Background Transparent | white (the same test as `validateEvent`) |
//! | 33 / 34 Add, 35 / 38 Subtract | white (the background these inks drop when drawing) and anything dim (every channel under 96: the faint outskirts of a glow, which reach far past the lamp) |
//! | any, 32-bit picture with alpha | alpha 0 |
//!
//! It holds for the room's furni only: floor furni (`pActiveObjList` of "Room Component Class") and wall items
//! (`pItemObjList`). Windows, the room itself and Habbos keep Director's rule: a dialog's white is not a hole.
//! The furni's sprite numbers are read once a frame, next to the room's draw order (`habbo_depth`).

use std::cell::RefCell;
use std::collections::HashSet;

use crate::player::geometry::IntRect;
use crate::player::habbo_depth::{find_instances, instances, list, prop, sprite_ref};
use crate::player::sprite::Sprite;
use crate::player::DirPlayer;

/// A light's pixel counts from this brightness (of 255) in any channel.
const DIM: u8 = 96;

thread_local! {
    static FURNI: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
}

fn on(player: &DirPlayer) -> bool {
    !matches!(player.external_params.get("habbo_room_hit").map(|s| s.as_str()), Some("0") | Some("false"))
}

/// Once a frame: the sprites of the room's furni.
pub fn refresh(player: &DirPlayer) {
    let mut set = HashSet::new();
    if on(player) {
        if let Some((component_id, _)) = find_instances(player) {
            if let Some(entry) = player.allocator.script_instances.get(component_id as usize) {
                let component = &entry.script_instance;
                for name in ["pActiveObjList", "pItemObjList"] {
                    for furni in instances(player, prop(player, component, name)) {
                        for d in list(player, prop(player, furni, "pSprList")) {
                            if let Some(n) = sprite_ref(Some(d)) {
                                set.insert(n);
                            }
                        }
                    }
                }
            }
        }
    }
    FURNI.with(|f| *f.borrow_mut() = set);
}

/// Whether a furni's sprite shows nothing at the stage point (`x`, `y`). `rect` is the sprite's rectangle before any
/// mirroring, `x`, `y` the point brought back into it (as `score::concrete_sprite_hit_test` has them).
pub fn see_through(player: &DirPlayer, sprite: &Sprite, rect: &IntRect, x: i32, y: i32) -> bool {
    if !FURNI.with(|f| f.borrow().contains(&(sprite.number as usize))) {
        return false;
    }
    let Some(member) = sprite.member.as_ref().and_then(|r| player.movie.cast_manager.find_member_by_ref(r)) else { return false };
    let Some(bmp_member) = member.member_type.as_bitmap() else { return false };
    let Some(bitmap) = player.bitmap_manager.get_bitmap(bmp_member.image_ref) else { return false };
    let (w, h) = ((rect.right - rect.left).max(1), (rect.bottom - rect.top).max(1));
    if x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom || bitmap.width == 0 || bitmap.height == 0 {
        return false;
    }
    let mut bx = ((x - rect.left) as u32 * bitmap.width as u32 / w as u32).min(bitmap.width as u32 - 1) as u16;
    let by = ((y - rect.top) as u32 * bitmap.height as u32 / h as u32).min(bitmap.height as u32 - 1) as u16;
    if sprite.flip_h {
        bx = bitmap.width as u16 - 1 - bx;
    }
    let palettes = player.movie.cast_manager.palettes();
    let (r, g, b, a) = bitmap.get_pixel_color_with_alpha(&palettes, bx, by);
    if bitmap.bit_depth == 32 && bitmap.use_alpha && a == 0 {
        return true;
    }
    match sprite.ink {
        36 => r == 255 && g == 255 && b == 255,
        // a light or a shade: its white background is dropped when it is drawn, and the dim part of a glow adds
        // next to nothing (cn_lamp's reaches 30 px past its lantern on either side)
        33 | 34 | 35 | 38 => (r == 255 && g == 255 && b == 255) || (r < DIM && g < DIM && b < DIM),
        _ => false,
    }
}
