/**
 * Placing a wall item the way the client does, to see where it can go and why.
 *
 * While you carry a wall item (hh_room_utils Object Mover Class `moveItem`), every one of its sprites sits at the
 * mouse: the picture's registration point is the point of the hand. Whether it can be put down there is two tests on
 * the room's walls (fuse_client Visualizer Part Wrapper Class `fitRectToWall`):
 *
 * 1. the rectangle of the item's first picture (from its registration point, width and height; a mirrored picture's
 *    rectangle is taken unmirrored) has to be inside one wall: its upper corner on the wall's rising side under the
 *    wall's top edge, its opposite lower corner above the wall's bottom edge;
 * 2. then the registration point itself has to be on a wall (posters, post-its and photos skip this one and go by
 *    their rectangle). The wall part under that point and the point's place in it are what the client sends:
 *    `:w=<part x>,<part y> l=<x in the part>,<y in the part> l|r`, and the wall under the point decides whether the
 *    left wall or the right wall picture is shown.
 *
 * A placed item's sprites then sit at that same point (hh_furni_classes Item Object Class `updateLocation`).
 *
 * A guest room's wall is a row of parts, one per tile along it: 32 px wide and 132 high at 64 px (hh_room_private's
 * `left_wallpart` / `right_wallpart`), the wall itself a 116 px band that climbs 1 px every 2 across each part.
 * The preview's walls (room.ts) are the same shape, so the parts here are its wall columns.
 */
import { roomLayout, tileLoc, wallHeightFor, type RoomLayout } from './room';

export type Wall = 'left' | 'right';

export interface WallPart {
  wall: Wall;
  /** the part's place along the walls (the room's tile it stands behind): what `:w=` names */
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The room's wall parts as the client has them: the left wall's first (as hh_room_private's layouts list them). */
export function wallParts(room: RoomLayout): WallPart[] {
  const hw = room.tile / 2, hh = room.tile / 4;
  const out: WallPart[] = [];
  for (let ty = room.rows - 1; ty >= 0; ty--) {
    const { locH, locV } = tileLoc(room, 0, ty);
    out.push({ wall: 'left', x: 0, y: ty, left: locH, top: locV - hh - room.wallHeight, width: hw, height: room.wallHeight + hh });
  }
  for (let tx = 0; tx < room.cols; tx++) {
    const { locH, locV } = tileLoc(room, tx, 0);
    out.push({ wall: 'right', x: tx, y: 0, left: locH + hw, top: locV - hh - room.wallHeight, width: hw, height: room.wallHeight + hh });
  }
  return out;
}

/** The corners of a part's wall band (a parallelogram inside the part's rectangle), clockwise from its upper left. */
export function partOutline(p: WallPart): [number, number][] {
  const rise = p.width / 2;
  return p.wall === 'left'
    ? [[p.left, p.top + rise], [p.left + p.width, p.top], [p.left + p.width, p.top + p.height - rise], [p.left, p.top + p.height]]
    : [[p.left, p.top], [p.left + p.width, p.top + rise], [p.left + p.width, p.top + p.height], [p.left, p.top + p.height - rise]];
}

export interface Fit {
  wall: Wall;
  inside: boolean;
  /** the two corners the client looks at, and whether each is on the wall */
  upper: [number, number];
  upperOk: boolean;
  lower: [number, number];
  lowerOk: boolean;
  /** the part the place is counted from, and the rectangle's upper left corner in it */
  part?: WallPart;
  local?: [number, number];
}

const within = (p: [number, number], part: WallPart) => p[0] >= part.left && p[0] < part.left + part.width && p[1] >= part.top && p[1] < part.top + part.height;

/** `fitRectToWall`: is the rectangle inside this wall, and where. */
export function fitToWall(parts: WallPart[], wall: Wall, r: Box): Fit {
  const mine = parts.filter((p) => p.wall === wall);
  const slope = wall === 'left' ? -0.5 : 0.5;
  // the wall's top edge is highest at the rectangle's right on the left wall, at its left on the right wall
  const upper: [number, number] = wall === 'left' ? [r.right, r.top] : [r.left, r.top];
  const lower: [number, number] = wall === 'left' ? [r.left, r.bottom] : [r.right, r.bottom];
  const fit: Fit = { wall, inside: false, upper, upperOk: false, lower, lowerOk: false };
  if (!mine.length) return fit;
  const bounds = { left: Math.min(...mine.map((p) => p.left)), top: Math.min(...mine.map((p) => p.top)), right: Math.max(...mine.map((p) => p.left + p.width)), bottom: Math.max(...mine.map((p) => p.top + p.height)) };
  const inBounds = !(bounds.left > r.left || bounds.top > r.top || bounds.right < r.right || bounds.bottom < r.bottom);
  const forUpper = mine.find((p) => within(upper, p) && p.top + (wall === 'left' ? Math.abs(p.width * slope) : 0) + (upper[0] - p.left) * slope < upper[1]);
  const forLower = mine.find((p) => within(lower, p) && p.top + p.height - (wall === 'left' ? 0 : Math.abs(p.width * slope)) + (lower[0] - p.left) * slope > lower[1]);
  fit.upperOk = !!forUpper;
  fit.lowerOk = !!forLower;
  fit.inside = inBounds && !!forUpper && !!forLower;
  const part = wall === 'left' ? forLower : forUpper;
  if (fit.inside && part) {
    fit.part = part;
    fit.local = [r.left - part.left, r.top - part.top];
  }
  return fit;
}

export interface PlaceTry {
  ok: boolean;
  /** the picture's rectangle against the walls: the wall it is inside, else the wall it is nearest to */
  rect: Fit;
  /** the registration point against the walls (only asked when the rectangle is inside one) */
  point: Fit | null;
  /** where it lands: the wall, the part and the registration point's place in it; and what the client sends */
  wall?: Wall;
  part?: WallPart;
  local?: [number, number];
  location?: string;
  /** why not, in words */
  reason?: string;
}

/**
 * The client's answer for a wall item carried with its registration point at `at`. `box` is the rectangle of its
 * first picture there. `byRectangle`: a poster, post-it or photo, which goes by its rectangle alone.
 */
export function tryPlace(room: RoomLayout, box: Box, at: { x: number; y: number }, byRectangle = false, parts = wallParts(room)): PlaceTry {
  const walls: Wall[] = ['left', 'right'];
  const fits = walls.map((w) => fitToWall(parts, w, box));
  const rect = fits.find((f) => f.inside);
  if (!rect) {
    // explain it by the wall the hand is over: left of the corner where the walls meet, or right of it
    const corner = tileLoc(room, 0, 0).locH + room.tile / 2;
    const near = fits[at.x < corner ? 0 : 1];
    const side = near.wall === 'left' ? ['right', 'left'] : ['left', 'right'];
    const reason = !near.upperOk && !near.lowerOk
      ? `The picture isn't on the ${near.wall} wall: its upper ${side[0]} and lower ${side[1]} corner both have to be on it`
      : !near.upperOk
        ? `The picture's upper ${side[0]} corner is off the ${near.wall} wall (above its top edge, or past its end)`
        : `The picture's lower ${side[1]} corner is off the ${near.wall} wall (below its bottom edge, or past its end)`;
    return { ok: false, rect: near, point: null, reason: `${reason}. The whole picture has to be inside one wall.` };
  }
  if (byRectangle) {
    const local: [number, number] = [at.x - rect.part!.left, at.y - rect.part!.top];
    return { ok: true, rect, point: null, wall: rect.wall, part: rect.part, local, location: `:w=${rect.part!.x},${rect.part!.y} l=${local[0]},${local[1]} ${rect.wall[0]}` };
  }
  const dot = { left: at.x, top: at.y, right: at.x, bottom: at.y };
  const points = walls.map((w) => fitToWall(parts, w, dot));
  const point = points.find((f) => f.inside);
  if (!point) {
    return { ok: false, rect, point: points[rect.wall === 'left' ? 0 : 1], reason: 'The picture is inside the wall, but its registration point (the hand) is not on a wall: the client places a wall item by that point.' };
  }
  return { ok: true, rect, point, wall: point.wall, part: point.part, local: point.local, location: `:w=${point.part!.x},${point.part!.y} l=${point.local![0]},${point.local![1]} ${point.wall[0]}` };
}

/**
 * Whether the client finds any spot at all for a wall picture on a guest room's wall (`wall`: the wall this picture
 * is for). `first`: the item's first picture. A picture that is too tall for the wall band, or whose registration
 * point is too far from it, has none: nobody can hang it.
 */
export function canPlaceAnywhere(tile: number, first: { width: number; height: number; regX: number; regY: number }, wall: Wall, byRectangle = false): boolean {
  const room = roomLayout({ cols: 8, rows: 8 }, tile, wallHeightFor(tile));
  const parts = wallParts(room);
  const mine = parts.filter((p) => p.wall === wall);
  const reach = byRectangle ? Math.max(first.width, first.height) + Math.abs(first.regX) + Math.abs(first.regY) : 0;
  const x0 = Math.min(...mine.map((p) => p.left)) - reach, x1 = Math.max(...mine.map((p) => p.left + p.width)) + reach;
  const y0 = Math.min(...mine.map((p) => p.top)) - reach, y1 = Math.max(...mine.map((p) => p.top + p.height)) + reach;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const box = { left: x - first.regX, top: y - first.regY, right: x - first.regX + first.width, bottom: y - first.regY + first.height };
      const t = tryPlace(room, box, { x, y }, byRectangle, parts);
      if (t.ok && t.wall === wall) return true;
    }
  }
  return false;
}
