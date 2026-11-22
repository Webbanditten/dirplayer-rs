//! Habbo room depth (Habbo fork; on with the external param `habbo_room_depth=1`, guest rooms only).
//!
//! The Habbo client gives every room sprite `locZ = 1000 * (x + y + 1) + zshift`: the diagonal of the object's
//! origin tile plus a per-layer offset from the furni's `.props`. That is right for things that share a tile (an
//! avatar sits between a chair's back, zshift -30, and its arms, +30) but wrong between neighbours: a furni's size
//! doesn't count, so a chair behind the second tile of a 2-tile shelf has the shelf's depth, and the layers of two
//! furni on the same diagonal interleave (a chair's arm over a gate's post, the gate over the chair's seat).
//!
//! This pass re-orders the sprites of the room's furni (`pActiveObjList` of "Room Component Class") and avatars/pets
//! (`pUserObjList`) when drawing, from the objects' floor footprints:
//! - sprites of objects on separate tiles at the same height: the object behind (by footprint) first; side by side on
//!   the same diagonal, the one further right in front;
//! - sprites of objects that share a tile: as the client ordered them (`locZ`), so sitting and lying stay as they are;
//!   a furni standing higher on the same tiles (drinks on a table) after the one below it;
//! - objects on separate tiles at different heights (stacked builds), and light and shadow effects (additive and
//!   subtractive inks, nearly transparent layers) against other objects, as the client ordered them;
//! - an object's own layers keep their order; floor layers (shadows, carpets: far below their object) stay first.
//! The sorted sprites take the depth values they had, in the new order, so walls, wall items and the interface keep
//! their places; sprites the client keeps right next to an object's sprite (matte, shadow, sign) follow it.
//! Lingo still sees its own `locZ`: only the draw and click order changes. Public rooms are left alone (their masks
//! have fixed depths).

use std::cell::RefCell;
use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap};
use std::rc::Rc;

use crate::director::lingo::datum::Datum;
use crate::player::allocator::{DatumAllocatorTrait, ScriptInstanceAllocatorTrait};
use crate::player::geometry::IntRect;
use crate::player::score::get_concrete_sprite_rect;
use crate::player::script::ScriptInstance;
use crate::player::script_ref::ScriptInstanceRef;
use crate::player::symbols::symbol::Symbol;
use crate::player::DirPlayer;

/// Sort key scale: a depth value times this, plus the position in the new order, plus a slot for attached sprites.
const KEY_SCALE: i64 = 1 << 20;
const ATTACH_SLOT: i64 = 16;
/// Sprites at most this far from an object's sprite, and not in any object, follow it (matte +1, shadow -3, ...).
const ATTACH_RANGE: i32 = 4;
/// A furni layer this far below its object's base depth is a floor layer (shadow -4000, carpet -32001).
const FLOOR_OFFSET: i64 = -1500;
/// Objects on separate tiles are ordered by footprint only when they stand at the same height.
const SAME_LEVEL: f64 = 0.05;
/// Light and shadow effects keep the client's order against other objects: additive and subtractive inks (a lamp's
/// halo, a rainbow's light; they reach far beyond their furni and Sulake placed them with zshift) and nearly
/// transparent layers.
const EFFECT_INKS: [i32; 4] = [33, 34, 35, 38];
const EFFECT_BLEND_BELOW: i32 = 40;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Furni,
    User,
}

/// A room object: its floor footprint (tiles x0..=x1, y0..=y1) and height.
#[derive(Clone, Debug)]
pub struct Obj {
    pub kind: Kind,
    pub x0: i32,
    pub x1: i32,
    pub y0: i32,
    pub y1: i32,
    pub h: f64,
}

/// One of an object's sprites.
#[derive(Clone, Debug)]
pub struct Spr {
    pub channel: usize,
    pub obj: usize,
    pub z: i32,
    pub rect: IntRect,
    pub floor: bool,
    /// A light or shadow effect layer (see EFFECT_INKS).
    pub effect: bool,
}

impl Obj {
    fn shares_tiles(&self, o: &Obj) -> bool {
        self.x0 <= o.x1 && o.x0 <= self.x1 && self.y0 <= o.y1 && o.y0 <= self.y1
    }
}

/// Which of two objects on separate tiles is drawn first (Less = `a` first).
pub fn footprint_order(a: &Obj, b: &Obj) -> Ordering {
    let x_overlap = a.x0 <= b.x1 && b.x0 <= a.x1;
    let y_overlap = a.y0 <= b.y1 && b.y0 <= a.y1;
    // Behind along x or y, where they face each other.
    if (a.x1 < b.x0 && y_overlap) || (a.y1 < b.y0 && x_overlap) {
        return Ordering::Less;
    }
    if (b.x1 < a.x0 && y_overlap) || (b.y1 < a.y0 && x_overlap) {
        return Ordering::Greater;
    }
    // Diagonal neighbours: behind on both axes.
    if a.x1 < b.x0 && a.y1 < b.y0 {
        return Ordering::Less;
    }
    if b.x1 < a.x0 && b.y1 < a.y0 {
        return Ordering::Greater;
    }
    // Side by side (one left-front, the other right-back): by their centres' diagonal, then the right one in front.
    let sa = a.x0 + a.x1 + a.y0 + a.y1;
    let sb = b.x0 + b.x1 + b.y0 + b.y1;
    if sa != sb {
        return sa.cmp(&sb);
    }
    (a.x0 + a.x1 - a.y0 - a.y1).cmp(&(b.x0 + b.x1 - b.y0 - b.y1))
}

fn overlaps(a: &IntRect, b: &IntRect) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/// The draw order of the objects' sprites: (channel, sort key) for each, keys built from their own depth values.
pub fn order(objs: &[Obj], sprs: &[Spr]) -> Vec<(usize, i64)> {
    let n = sprs.len();
    // Floor layers first, as the client has them.
    let mut floor: Vec<usize> = (0..n).filter(|&i| sprs[i].floor).collect();
    floor.sort_by_key(|&i| (sprs[i].z, sprs[i].channel));
    let rest: Vec<usize> = (0..n).filter(|&i| !sprs[i].floor).collect();

    // Constraints between overlapping sprites of different objects, and each object's own layer order.
    let mut succ: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut indeg = vec![0usize; n];
    let mut add = |from: usize, to: usize, succ: &mut Vec<Vec<usize>>, indeg: &mut Vec<usize>| {
        succ[from].push(to);
        indeg[to] += 1;
    };
    let by_z = |i: usize, j: usize| (sprs[i].z, sprs[i].channel).cmp(&(sprs[j].z, sprs[j].channel));

    let mut per_obj: HashMap<usize, Vec<usize>> = HashMap::new();
    for &i in &rest {
        per_obj.entry(sprs[i].obj).or_default().push(i);
    }
    for list in per_obj.values_mut() {
        list.sort_by(|&a, &b| by_z(a, b));
        for w in list.windows(2) {
            add(w[0], w[1], &mut succ, &mut indeg);
        }
    }

    // Sweep by left edge so only horizontally overlapping sprites are compared.
    let mut by_left = rest.clone();
    by_left.sort_by_key(|&i| sprs[i].rect.left);
    for (k, &i) in by_left.iter().enumerate() {
        for &j in &by_left[k + 1..] {
            if sprs[j].rect.left >= sprs[i].rect.right {
                break;
            }
            let (a, b) = (&sprs[i], &sprs[j]);
            if a.obj == b.obj || !overlaps(&a.rect, &b.rect) {
                continue;
            }
            let (oa, ob) = (&objs[a.obj], &objs[b.obj]);
            let ord = if oa.shares_tiles(ob) {
                if oa.kind == Kind::Furni && ob.kind == Kind::Furni && (oa.h - ob.h).abs() > 0.05 {
                    oa.h.partial_cmp(&ob.h).unwrap_or(Ordering::Equal)
                } else {
                    by_z(i, j)
                }
            } else if (oa.h - ob.h).abs() < SAME_LEVEL && !a.effect && !b.effect {
                footprint_order(oa, ob)
            } else {
                // At different heights the client's depth (diagonal plus height in big rooms) decides, so stacked
                // builds look as they were built; light and shadow effects stay where the client put them.
                by_z(i, j)
            };
            match ord {
                Ordering::Less => add(i, j, &mut succ, &mut indeg),
                Ordering::Greater => add(j, i, &mut succ, &mut indeg),
                Ordering::Equal => {}
            }
        }
    }

    // Topological order, the client's depth deciding among free sprites; a cycle is broken at its lowest sprite.
    let mut heap: BinaryHeap<Reverse<(i32, usize, usize)>> = BinaryHeap::new();
    for &i in &rest {
        if indeg[i] == 0 {
            heap.push(Reverse((sprs[i].z, sprs[i].channel, i)));
        }
    }
    let mut done = vec![false; n];
    let mut sorted: Vec<usize> = Vec::with_capacity(rest.len());
    while sorted.len() < rest.len() {
        let next = match heap.pop() {
            Some(Reverse((_, _, i))) if !done[i] => i,
            Some(_) => continue,
            None => *rest.iter().filter(|&&i| !done[i]).min_by(|&&a, &&b| by_z(a, b)).unwrap(),
        };
        done[next] = true;
        sorted.push(next);
        for &s in &succ[next] {
            indeg[s] = indeg[s].saturating_sub(1);
            if indeg[s] == 0 && !done[s] {
                heap.push(Reverse((sprs[s].z, sprs[s].channel, s)));
            }
        }
    }

    // Their own depth values, ascending, in the new order.
    let mut pool: Vec<i32> = sprs.iter().map(|s| s.z).collect();
    pool.sort();
    floor
        .iter()
        .chain(sorted.iter())
        .enumerate()
        .map(|(rank, &i)| (sprs[i].channel, pool[rank] as i64 * KEY_SCALE + rank as i64 * 32 + ATTACH_SLOT))
        .collect()
}

// --- reading the room from the client ------------------------------------------------------------------------------

#[derive(Default)]
struct Found {
    component: Option<u32>,
    geometry: Option<u32>,
    /// Frames to wait before looking for the instances again when they aren't there (not in a room yet).
    retry_in: u32,
}

thread_local! {
    static FOUND: RefCell<Found> = RefCell::new(Found::default());
}

fn script_name<'a>(player: &'a DirPlayer, inst: &ScriptInstance) -> Option<&'a str> {
    player.movie.cast_manager.find_member_by_ref(&inst.script).map(|m| m.name.as_str())
}

fn instance_named(player: &DirPlayer, id: Option<u32>, name: &str) -> Option<u32> {
    if let Some(id) = id {
        if let Some(entry) = player.allocator.script_instances.get(id as usize) {
            if script_name(player, &entry.script_instance) == Some(name) {
                return Some(id);
            }
        }
    }
    None
}

fn find_instances(player: &DirPlayer) -> Option<(u32, u32)> {
    FOUND.with(|f| {
        let mut f = f.borrow_mut();
        let c = instance_named(player, f.component, "Room Component Class");
        let g = instance_named(player, f.geometry, "Room Geometry Class");
        if let (Some(c), Some(g)) = (c, g) {
            return Some((c, g));
        }
        if f.retry_in > 0 {
            f.retry_in -= 1;
            return None;
        }
        let (mut c, mut g) = (c, g);
        for (id, entry) in player.allocator.script_instances.iter() {
            match script_name(player, &entry.script_instance) {
                Some("Room Component Class") if c.is_none() => c = Some(id as u32),
                Some("Room Geometry Class") if g.is_none() => g = Some(id as u32),
                _ => {}
            }
        }
        f.component = c;
        f.geometry = g;
        if c.is_none() || g.is_none() {
            f.retry_in = 30;
        }
        Some((c?, g?))
    })
}

/// A property of an instance or its ancestors.
fn prop<'a>(player: &'a DirPlayer, inst: &'a ScriptInstance, name: &str) -> Option<&'a Datum> {
    let sym = Symbol::from_str(name);
    let mut cur = inst;
    loop {
        if let Some(r) = cur.properties.get(&sym) {
            return Some(player.allocator.get_datum(r));
        }
        let anc: &ScriptInstanceRef = cur.ancestor.as_ref()?;
        cur = player.allocator.get_script_instance_opt(anc)?;
    }
}

fn num(d: Option<&Datum>) -> Option<f64> {
    match d? {
        Datum::Int(i) => Some(*i as f64),
        Datum::Float(f) => Some(*f),
        _ => None,
    }
}

fn list<'a>(player: &'a DirPlayer, d: Option<&'a Datum>) -> Vec<&'a Datum> {
    match d {
        Some(Datum::List(_, items, _)) => items.iter().map(|r| player.allocator.get_datum(r)).collect(),
        _ => Vec::new(),
    }
}

fn instances<'a>(player: &'a DirPlayer, d: Option<&'a Datum>) -> Vec<&'a ScriptInstance> {
    let values: Vec<&Datum> = match d {
        Some(Datum::PropList(pairs, _)) => pairs.iter().map(|(_, v)| player.allocator.get_datum(v)).collect(),
        Some(Datum::List(_, items, _)) => items.iter().map(|r| player.allocator.get_datum(r)).collect(),
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(|v| match v {
            Datum::ScriptInstanceRef(r) => player.allocator.get_script_instance_opt(r),
            _ => None,
        })
        .collect()
}

fn sprite_ref(d: Option<&Datum>) -> Option<usize> {
    match d? {
        Datum::SpriteRef(n) if *n > 0 => Some(*n as usize),
        _ => None,
    }
}

/// The room's objects and their visible sprites, or None outside guest rooms.
fn collect(player: &DirPlayer) -> Option<(Vec<Obj>, Vec<Spr>)> {
    let (component_id, geometry_id) = find_instances(player)?;
    let component = &player.allocator.script_instances.get(component_id as usize)?.script_instance;
    let geometry = &player.allocator.script_instances.get(geometry_id as usize)?.script_instance;
    match prop(player, component, "pRoomId") {
        Some(Datum::String(s)) if s == "private" => {}
        _ => return None,
    }
    let z_offset = num(prop(player, geometry, "pZOffset")).unwrap_or(0.0);

    let mut objs = Vec::new();
    let mut sprs = Vec::new();
    let mut push_sprite = |player: &DirPlayer, channel: usize, obj: usize, base: Option<f64>, sprs: &mut Vec<Spr>| {
        let Some(sprite) = player.movie.score.get_sprite(channel as i16) else { return };
        if !sprite.visible || sprite.member.is_none() {
            return;
        }
        let rect = get_concrete_sprite_rect(player, sprite);
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return;
        }
        let floor = base.is_some_and(|b| (sprite.loc_z as f64 - b) < FLOOR_OFFSET as f64);
        let effect = base.is_some() && (EFFECT_INKS.contains(&sprite.ink) || sprite.blend < EFFECT_BLEND_BELOW);
        sprs.push(Spr { channel, obj, z: sprite.loc_z, rect, floor, effect });
    };

    for furni in instances(player, prop(player, component, "pActiveObjList")) {
        let (Some(x), Some(y)) = (num(prop(player, furni, "pLocX")), num(prop(player, furni, "pLocY"))) else { continue };
        let h = num(prop(player, furni, "pLocH")).unwrap_or(0.0);
        let dims: Vec<i32> = list(player, prop(player, furni, "pDimensions")).into_iter().filter_map(|d| num(Some(d))).map(|v| v as i32).collect();
        let dir = list(player, prop(player, furni, "pDirection")).first().and_then(|d| num(Some(d))).unwrap_or(0.0) as i32;
        let (len, wid) = (dims.first().copied().unwrap_or(1).max(1), dims.get(1).copied().unwrap_or(1).max(1));
        let (w, l) = if dir.rem_euclid(4) == 0 { (len, wid) } else { (wid, len) };
        let (x, y) = (x.round() as i32, y.round() as i32);
        let corrected = matches!(prop(player, furni, "pCorrectLocZ"), Some(Datum::Int(1)));
        let base = 1000.0 * (x + y + 1) as f64 + z_offset + if corrected { h * 1000.0 } else { 0.0 };
        let index = objs.len();
        objs.push(Obj { kind: Kind::Furni, x0: x, x1: x + w - 1, y0: y, y1: y + l - 1, h });
        for d in list(player, prop(player, furni, "pSprList")) {
            if let Some(ch) = sprite_ref(Some(d)) {
                push_sprite(player, ch, index, Some(base), &mut sprs);
            }
        }
    }
    for user in instances(player, prop(player, component, "pUserObjList")) {
        // In the door the client puts avatars at the wall's depth (pBaseLocZ): leave them there.
        if num(prop(player, user, "pBaseLocZ")).is_some_and(|z| z != 0.0) {
            continue;
        }
        let (Some(x), Some(y)) = (num(prop(player, user, "pLocX")), num(prop(player, user, "pLocY"))) else { continue };
        let h = num(prop(player, user, "pLocH")).unwrap_or(0.0);
        let (x, y) = (x.round() as i32, y.round() as i32);
        let index = objs.len();
        objs.push(Obj { kind: Kind::User, x0: x, x1: x, y0: y, y1: y, h });
        for name in ["pSprite", "pMatteSpr", "pShadowSpr"] {
            if let Some(ch) = sprite_ref(prop(player, user, name)) {
                push_sprite(player, ch, index, None, &mut sprs);
            }
        }
    }
    if sprs.is_empty() {
        return None;
    }
    Some((objs, sprs))
}

/// Sort keys for the room's sprites (and the sprites right next to them), or None to draw by `locZ` alone.
fn compute(player: &DirPlayer) -> Option<HashMap<usize, i64>> {
    let (objs, sprs) = collect(player)?;
    let keys = order(&objs, &sprs);
    let mut map: HashMap<usize, i64> = keys.iter().copied().collect();
    // Sprites the client keeps next to an object's sprite follow it.
    let mut by_z: Vec<(i32, i64)> = sprs.iter().map(|s| (s.z, map[&s.channel])).collect();
    by_z.sort();
    let (lo, hi) = (by_z.first()?.0 - ATTACH_RANGE, by_z.last()?.0 + ATTACH_RANGE);
    for channel in player.movie.score.channels.iter() {
        let n = channel.number;
        if n == 0 || map.contains_key(&n) || !channel.sprite.visible || channel.sprite.member.is_none() {
            continue;
        }
        let z = channel.sprite.loc_z;
        if z < lo || z > hi {
            continue;
        }
        let at = by_z.partition_point(|(sz, _)| *sz < z - ATTACH_RANGE);
        let near = by_z[at..].iter().take_while(|(sz, _)| *sz <= z + ATTACH_RANGE).min_by_key(|(sz, _)| (sz - z).abs());
        if let Some((sz, key)) = near {
            map.insert(n, key + (z - sz) as i64);
        }
    }
    Some(map)
}

/// Before drawing: work out the room order (when switched on) and hand it to the score's sort.
pub fn refresh(player: &DirPlayer) {
    let on = matches!(player.external_params.get("habbo_room_depth").map(|s| s.as_str()), Some("1") | Some("true"));
    let next = if on { compute(player).map(Rc::new) } else { None };
    let score = &player.movie.score;
    let same = match (&*score.habbo_depth.borrow(), &next) {
        (None, None) => true,
        (Some(a), Some(b)) => **a == **b,
        _ => false,
    };
    if !same {
        *score.habbo_depth.borrow_mut() = next;
        score.habbo_depth_version.set(score.habbo_depth_version.get().wrapping_add(1));
    }
}

/// Sort key of a channel: the room order's when it has one, else its `locZ`.
#[inline]
pub fn key(keys: &HashMap<usize, i64>, channel: usize, loc_z: i32) -> i64 {
    keys.get(&channel).copied().unwrap_or(loc_z as i64 * KEY_SCALE + ATTACH_SLOT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn furni(x: i32, y: i32, w: i32, l: i32) -> Obj {
        Obj { kind: Kind::Furni, x0: x, x1: x + w - 1, y0: y, y1: y + l - 1, h: 0.0 }
    }
    fn user(x: i32, y: i32) -> Obj {
        Obj { kind: Kind::User, x0: x, x1: x, y0: y, y1: y, h: 0.0 }
    }
    fn spr(channel: usize, obj: usize, z: i32) -> Spr {
        Spr { channel, obj, z, rect: IntRect { left: 0, top: 0, right: 100, bottom: 100 }, floor: false, effect: false }
    }
    /// Channels in draw order.
    fn drawn(objs: &[Obj], sprs: &[Spr]) -> Vec<usize> {
        let mut keys = order(objs, sprs);
        keys.sort_by_key(|&(c, k)| (k, c));
        keys.into_iter().map(|(c, _)| c).collect()
    }
    fn before(order: &[usize], a: usize, b: usize) -> bool {
        order.iter().position(|&c| c == a) < order.iter().position(|&c| c == b)
    }
    /// The client's depth: 1000 per diagonal from the origin tile, plus an offset.
    fn z(x: i32, y: i32, off: i32) -> i32 {
        1000 * (x + y + 1) - 20_000_000 + off
    }

    #[test]
    fn chair_behind_the_second_tile_of_a_shelf() {
        // Biblioteket: sofachair_silo at (9,14) and shelves_silo (2x1 along x) at (8,15), same diagonal 23. The
        // chair's arm (+29) was over the shelf (-6, -5), its seat (-35) under it.
        let objs = [furni(9, 14, 1, 1), furni(8, 15, 2, 1)];
        let sprs = [spr(1, 0, z(9, 14, 29)), spr(2, 0, z(9, 14, -35)), spr(3, 1, z(8, 15, -6)), spr(4, 1, z(8, 15, -5))];
        let o = drawn(&objs, &sprs);
        for chair in [1, 2] {
            for shelf in [3, 4] {
                assert!(before(&o, chair, shelf), "{o:?}");
            }
        }
    }

    #[test]
    fn sofa_front_behind_a_divider_in_front_of_it() {
        // sofa_silo (1x2 along y) at (18,25), layers a/g zshift 1030; divider_silo2 (1x2) at (19,25) in front.
        let objs = [furni(18, 25, 1, 2), furni(19, 25, 1, 2)];
        let sprs = [spr(1, 0, z(18, 25, 1029)), spr(2, 0, z(18, 25, -2)), spr(3, 1, z(19, 25, -1)), spr(4, 1, z(19, 25, 0))];
        let o = drawn(&objs, &sprs);
        assert!(before(&o, 1, 3) && before(&o, 1, 4) && before(&o, 2, 3), "{o:?}");
    }

    #[test]
    fn side_by_side_on_a_diagonal_do_not_interleave() {
        // divider_silo3 (gate) at (22,22) and sofachair_silo at (21,23): the chair's arm (+29) went over the gate's
        // posts, the gate over the chair's seat (-35). Now one whole object over the other (the right one in front).
        let objs = [furni(21, 23, 1, 1), furni(22, 22, 1, 1)];
        let sprs = [spr(1, 0, z(21, 23, 29)), spr(2, 0, z(21, 23, -35)), spr(3, 1, z(22, 22, -1)), spr(4, 1, z(22, 22, 32))];
        let o = drawn(&objs, &sprs);
        assert!(before(&o, 1, 3) && before(&o, 2, 3) && before(&o, 1, 4), "{o:?}");
    }

    #[test]
    fn sitting_keeps_the_clients_layers() {
        // An avatar (+2) on a chair: behind the arm (+29), in front of the back (-35); on the second seat of a sofa
        // along x (front layer +1029 from the origin) behind that layer.
        let objs = [furni(5, 5, 1, 1), user(5, 5), furni(10, 5, 2, 1), user(11, 5)];
        let sprs = [
            spr(1, 0, z(5, 5, 29)),
            spr(2, 0, z(5, 5, -35)),
            spr(3, 1, z(5, 5, 2)),
            spr(4, 2, z(10, 5, 1029)),
            spr(5, 2, z(10, 5, -1)),
            spr(6, 3, z(11, 5, 2)),
        ];
        let o = drawn(&objs, &sprs);
        assert!(before(&o, 2, 3) && before(&o, 3, 1), "{o:?}");
        assert!(before(&o, 5, 6) && before(&o, 6, 4), "{o:?}");
    }

    #[test]
    fn stacked_furni_over_the_one_below() {
        // Small rooms give stacked furni no height in their depth: drinks (h 1) on a table whose layers are +1000.
        let mut drinks = furni(10, 19, 1, 1);
        drinks.h = 1.0;
        let objs = [furni(10, 19, 2, 2), drinks];
        let sprs = [spr(1, 0, z(10, 19, 999)), spr(2, 0, z(10, 19, 1000)), spr(3, 1, z(10, 19, -6))];
        let o = drawn(&objs, &sprs);
        assert!(before(&o, 1, 3) && before(&o, 2, 3), "{o:?}");
    }

    #[test]
    fn floor_layers_stay_under_everything() {
        let objs = [furni(3, 3, 2, 2), furni(1, 1, 1, 1)];
        let mut carpet = spr(1, 0, z(3, 3, -32001));
        carpet.floor = true;
        let sprs = [carpet, spr(2, 1, z(1, 1, 0))];
        let o = drawn(&objs, &sprs);
        assert!(before(&o, 1, 2), "{o:?}");
    }

    #[test]
    fn stacks_at_other_heights_keep_the_clients_order() {
        // The Vault: a money bag at height 2.6 on (9,1) behind a rainbow at 1.5 on (9,2). In big rooms the client
        // adds 1000 per height unit, so the bag (behind but higher) is drawn over the rainbow; that stays.
        let mut bag = furni(9, 1, 1, 1);
        bag.h = 2.6;
        let mut rainbow = furni(9, 2, 1, 1);
        rainbow.h = 1.5;
        let objs = [bag, rainbow];
        let sprs = [spr(1, 0, z(9, 1, 2600 - 6)), spr(2, 1, z(9, 2, 1500 - 4)), spr(3, 1, z(9, 2, 1500 - 6))];
        let o = drawn(&objs, &sprs);
        assert!(before(&o, 2, 1) && before(&o, 3, 1), "{o:?}");
    }

    #[test]
    fn a_glow_keeps_the_clients_order() {
        // A lamp's halo (additive) on the same level as a shelf in front of the lamp: the halo stays over the shelf as
        // the client drew it, the lamp's body goes behind the shelf.
        let objs = [furni(9, 13, 1, 1), furni(8, 15, 2, 1)];
        let mut halo = spr(1, 0, z(9, 13, 1100));
        halo.effect = true;
        let sprs = [halo, spr(2, 0, z(9, 13, -6)), spr(3, 1, z(8, 15, -6))];
        let o = drawn(&objs, &sprs);
        assert!(before(&o, 3, 1) && before(&o, 2, 3), "{o:?}");
    }

    #[test]
    fn keys_reuse_the_sprites_own_depths() {
        let objs = [furni(9, 14, 1, 1), furni(8, 15, 2, 1)];
        let sprs = [spr(1, 0, z(9, 14, 29)), spr(3, 1, z(8, 15, -6))];
        let mut zs: Vec<i64> = order(&objs, &sprs).iter().map(|(_, k)| k.div_euclid(KEY_SCALE)).collect();
        zs.sort();
        let mut own: Vec<i64> = sprs.iter().map(|s| s.z as i64).collect();
        own.sort();
        assert_eq!(zs, own);
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// `cargo test --release --lib habbo_depth::bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn a_busy_room() {
        let mut objs = Vec::new();
        let mut sprs = Vec::new();
        let mut seed = 7u32;
        let mut rnd = |m: i32| {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
            ((seed >> 8) % m as u32) as i32
        };
        for i in 0..195 {
            let (x, y) = (rnd(28), rnd(28));
            let user = i >= 170;
            let (w, l) = if user { (1, 1) } else { (1 + rnd(2), 1 + rnd(2)) };
            objs.push(Obj { kind: if user { Kind::User } else { Kind::Furni }, x0: x, x1: x + w - 1, y0: y, y1: y + l - 1, h: 0.0 });
            let (sx, sy) = ((x - y) * 16 + 400, (x + y) * 8 + 40);
            for k in 0..if user { 3 } else { 4 } {
                let z = 1000 * (x + y + 1) + rnd(80) - 40 + k;
                sprs.push(Spr { channel: sprs.len() + 1, obj: i, z, rect: IntRect { left: sx - 10, top: sy - 40, right: sx + 30, bottom: sy + 8 }, floor: false, effect: false });
            }
        }
        let t = std::time::Instant::now();
        let runs = 200;
        for _ in 0..runs {
            std::hint::black_box(order(&objs, &sprs));
        }
        println!("{} sprites: {:.3} ms per order()", sprs.len(), t.elapsed().as_secs_f64() * 1000.0 / runs as f64);
    }
}
