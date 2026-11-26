/**
 * Where a furni's tiles are, relative to its tile point (the point its sprites hang from: the left corner of its first
 * tile at that tile's vertical centre, see room.ts). Used to put a new picture on its tiles, to make a shadow and to
 * draw the tiles under a picture while it is positioned or painted.
 *
 * `dims` is [length, width] as the member names carry them (`<class>_a_0_<length>_<width>_...`); a furni covers
 * `width` tiles along x and `length` along y, turned for directions 0 and 4 (Odin's AffectedTile, room.ts footprint).
 */
import { parseMemberName, type Furni } from './furni';

/** Tiles along x and along y for a direction. */
export function tileSpan(dims: [number, number], direction: number): [number, number] {
  const [length, width] = dims;
  return direction % 4 === 0 ? [length, width] : [width, length];
}

export interface TileBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** the four corners of the rhombus the tiles make together: back, right, front, left */
  corners: [number, number][];
}

/** The rhombus a furni's tiles make, in pixels from its tile point (`tile` = 64, or 32 for the small zoom). */
export function tileBox(dims: [number, number], direction: number, tile = 64): TileBox {
  const [w, l] = tileSpan(dims, direction);
  const hw = tile / 2, hh = tile / 4;
  // tile (i, j) has its left corner at ((i - j) * hw, (i + j) * hh)
  const back: [number, number] = [hw, -hh];
  const right: [number, number] = [(w - 1) * hw + tile, (w - 1) * hh];
  const front: [number, number] = [(w - l) * hw + hw, (w + l - 2) * hh + hh];
  const left: [number, number] = [-(l - 1) * hw, (l - 1) * hh];
  return { left: left[0], right: right[0], top: back[1], bottom: front[1], corners: [back, right, front, left] };
}

/** The outline of every tile of the footprint (each a 4-corner diamond), for drawing a guide. */
export function tileDiamonds(dims: [number, number], direction: number, tile = 64): [number, number][][] {
  const [w, l] = tileSpan(dims, direction);
  const hw = tile / 2, hh = tile / 4;
  const out: [number, number][][] = [];
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < l; j++) {
      const x = (i - j) * hw, y = (i + j) * hh;
      out.push([[x, y], [x + hw, y - hh], [x + tile, y], [x + hw, y + hh]]);
    }
  }
  return out;
}

/** The bounding box of a picture's visible pixels (alpha above 8), or null when it has none. `right` and `bottom` are
 *  one past the last pixel. */
export function opaqueBox(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { left: x0, top: y0, right: x1 + 1, bottom: y1 + 1 };
}

/** How far the hotel's furni stand above the front corner of their tiles (chair_norja 13 of 16, bar_polyfon 11,
 *  sofa_silo 35 of 32...): the picture's lowest pixel goes this many pixels above the corner. */
const FRONT_GAP = 3;

/**
 * The registration point that stands a picture on its tiles like the hotel's furni: its visible pixels centred on the
 * tiles, its lowest pixel just above their front corner.
 */
export function standOnTiles(box: { left: number; right: number; bottom: number }, dims: [number, number], direction: number, tile = 64) {
  const t = tileBox(dims, direction, tile);
  const gap = Math.round((FRONT_GAP * tile) / 64);
  return {
    regX: Math.round((box.left + box.right) / 2 - (t.left + t.right) / 2),
    regY: box.bottom - (t.bottom - gap),
  };
}

/** What a member name says about its tiles: [length, width], direction and the tile size (32 for an `s_` member). */
export function tilesOfMember(furni: Furni, name: string): { dims: [number, number]; direction: number; tile: number } | null {
  const lower = name.toLowerCase();
  const p = parseMemberName(lower);
  const cls = furni.className().toLowerCase();
  if (p && p.cls.replace(/^s_/, '') === cls) return { dims: [p.width, p.length], direction: p.direction, tile: p.cls.startsWith('s_') ? 32 : 64 };
  // The shadow: <class>_sd or <class>_sd_<direction>, with the size of layer a.
  const sd = new RegExp(`^(s_)?${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_sd(?:_(\\d))?$`).exec(lower);
  if (!sd) return null;
  for (const n of furni.names.keys()) {
    const a = parseMemberName(n);
    if (a && a.cls === (sd[1] ?? '') + cls) return { dims: [a.width, a.length], direction: sd[2] ? +sd[2] : a.direction, tile: sd[1] ? 32 : 64 };
  }
  return null;
}
