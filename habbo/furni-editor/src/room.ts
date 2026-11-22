/**
 * The preview room: a floor of tiles drawn like a Habbo private room, and furni placed on it, composited by the Rust
 * side (DirPlayer's sprite drawing) so inks, blends and part colours come out as in the web client.
 *
 * Geometry is the client's (hh_room "Room Geometry Class"): tile (x, y) has the screen location
 * ((x - y) * 32 + xOffset, (x + y) * 16 + yOffset), which is the tile's left corner at its vertical centre (the
 * 64 x 32 diamond spans locH .. locH + 64 and locV - 16 .. locV + 16). A furni's sprites are placed from that point.
 */
import type { CastDocument } from '../../../vm-rust/pkg/vm_rust.js';
import { spriteRect, type Layer } from './furni';

export interface RoomSize {
  cols: number;
  rows: number;
}

export interface RoomLayout extends RoomSize {
  /** tile width: 64, or 32 for the small room zoom (s_ members) */
  tile: number;
  width: number;
  height: number;
  xOffset: number;
  yOffset: number;
}

const HEADROOM = 24;
const THICKNESS = 8;

export function roomLayout(size: RoomSize, tile = 64): RoomLayout {
  const margin = 24, hw = tile / 2, hh = tile / 4;
  const xOffset = margin + (size.rows - 1) * hw;
  const yOffset = HEADROOM + hh;
  const width = xOffset + (size.cols - 1) * hw + tile + margin;
  const height = yOffset + (size.cols + size.rows - 2) * hh + hh + (THICKNESS * tile) / 64 + margin;
  return { ...size, tile, width, height, xOffset, yOffset };
}

/** Grow the canvas so every sprite of `placements` (plus a margin) fits, moving the floor along. */
export function fitRoom(room: RoomLayout, placements: Placement[], margin = 16): RoomLayout {
  let minL = 0, minT = 0, maxR = room.width, maxB = room.height;
  for (const p of placements) {
    const { locH, locV } = tileLoc(room, p.x, p.y);
    for (const l of p.layers) {
      const r = spriteRect(l, locH, locV);
      minL = Math.min(minL, r.left - margin);
      minT = Math.min(minT, r.top - margin);
      maxR = Math.max(maxR, r.left + l.width + margin);
      maxB = Math.max(maxB, r.top + l.height + margin);
    }
  }
  return { ...room, xOffset: room.xOffset - minL, yOffset: room.yOffset - minT, width: maxR - minL, height: maxB - minT };
}

export function tileLoc(room: RoomLayout, x: number, y: number) {
  return { locH: ((x - y) * room.tile) / 2 + room.xOffset, locV: ((x + y) * room.tile) / 4 + room.yOffset };
}

function hex(c: string): [number, number, number] {
  const v = parseInt(c.replace('#', ''), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function shade([r, g, b]: [number, number, number], f: number): [number, number, number] {
  return [Math.round(r * f), Math.round(g * f), Math.round(b * f)];
}

export interface FloorStyle {
  floor: string;
  background: string;
  grid: boolean;
  /** tiles to highlight (a furni's footprint) */
  highlight?: Set<string>;
}

/** The floor as RGBA pixels. */
export function drawFloor(room: RoomLayout, style: FloorStyle): Uint8Array {
  const { width: w, height: h } = room;
  const px = new Uint8Array(w * h * 4);
  const bg = hex(style.background);
  for (let i = 0; i < w * h; i++) px.set([bg[0], bg[1], bg[2], 255], i * 4);
  const put = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    px.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  };
  const top = hex(style.floor);
  const edge = shade(top, 0.9);
  const left = shade(top, 0.85);
  const right = shade(top, 0.7);
  const lit: [number, number, number] = [Math.min(255, top[0] + 40), Math.min(255, top[1] + 40), Math.min(255, top[2] + 40)];
  const T = room.tile, hw = T / 2, hh = T / 4, thick = (THICKNESS * T) / 64;
  for (let ty = 0; ty < room.rows; ty++) {
    for (let tx = 0; tx < room.cols; tx++) {
      const { locH, locV } = tileLoc(room, tx, ty);
      const fill = style.highlight?.has(`${tx},${ty}`) ? lit : top;
      // The diamond, row by row: half widths 2, 4, ... hw, hw, ... 2.
      for (let r = 0; r < hw; r++) {
        const half = r < hh ? (r + 1) * 2 : (hw - r) * 2;
        const y = locV - hh + r;
        for (let x = locH + hw - half; x < locH + hw + half; x++) {
          const onEdge = style.grid && (x < locH + hw - half + 2 || x >= locH + hw + half - 2);
          put(x, y, onEdge ? edge : fill);
        }
      }
      if (ty === room.rows - 1) {
        for (let x = locH; x < locH + hw; x++) {
          const y0 = locV + Math.floor((x - locH) / 2) + 1;
          for (let y = y0; y < y0 + thick; y++) put(x, y, left);
        }
      }
      if (tx === room.cols - 1) {
        for (let x = locH + hw; x < locH + T; x++) {
          const y0 = locV + hh - Math.floor((x - locH - hw) / 2);
          for (let y = y0; y < y0 + thick; y++) put(x, y, right);
        }
      }
    }
  }
  return px;
}

export interface Placement {
  x: number;
  y: number;
  layers: Layer[];
  /** layers to leave out, by letter */
  hidden?: Set<string>;
}

export interface SpriteSpec {
  slot: number;
  left: number;
  top: number;
  flipH: boolean;
  ink: number;
  blend: number;
  bgColor?: [number, number, number];
}

export function sprites(room: RoomLayout, placements: Placement[]): SpriteSpec[] {
  // Furni further back first (the client's locZ is 1000 * (x + y + 1) plus the layer's z).
  const sorted = [...placements].sort((a, b) => a.x + a.y - (b.x + b.y));
  const out: SpriteSpec[] = [];
  for (const p of sorted) {
    const { locH, locV } = tileLoc(room, p.x, p.y);
    for (const l of p.layers) {
      if (p.hidden?.has(l.letter)) continue;
      const r = spriteRect(l, locH, locV);
      out.push({
        slot: l.slot,
        left: r.left,
        top: r.top,
        flipH: l.flip,
        ink: l.ink,
        blend: l.blend,
        bgColor: l.bgColor === undefined ? undefined : [(l.bgColor >> 16) & 255, (l.bgColor >> 8) & 255, l.bgColor & 255],
      });
    }
  }
  return out;
}

/** Draw the placements on `floor`. With `floorOnWhite` (the same floor on a white background instead of black) the
 *  background comes out transparent: the room is drawn on both, and each pixel's alpha is what the two renders tell
 *  apart (where they agree it's opaque, where black shows through as black and white as white it's see-through). */
export function composite(doc: CastDocument, room: RoomLayout, floor: Uint8Array, placements: Placement[], floorOnWhite?: Uint8Array): ImageData {
  const spec = JSON.stringify({ width: room.width, height: room.height, sprites: sprites(room, placements) });
  const a = doc.render(spec, floor);
  if (floorOnWhite) {
    const b = doc.render(spec, floorOnWhite);
    for (let i = 0; i < a.length; i += 4) {
      const alpha = 255 - Math.max(b[i] - a[i], b[i + 1] - a[i + 1], b[i + 2] - a[i + 2], 0);
      if (alpha <= 0) {
        a[i] = a[i + 1] = a[i + 2] = a[i + 3] = 0;
        continue;
      }
      for (let k = 0; k < 3; k++) a[i + k] = Math.min(255, Math.round((a[i + k] * 255) / alpha));
      a[i + 3] = alpha;
    }
  }
  return new ImageData(new Uint8ClampedArray(a.buffer, a.byteOffset, a.byteLength), room.width, room.height);
}

/** The tiles a furni covers from (x, y), as Odin counts them (AffectedTile): `dims` = [length, width] from the member
 *  names (`<class>_a_0_<length>_<width>_...`, as items_definitions has them); width tiles along x and length along y,
 *  turned for directions 0 and 4. */
export function footprint(x: number, y: number, dims: [number, number], direction: number): string[] {
  const [length, width] = dims;
  const [w, l] = direction % 4 === 0 ? [length, width] : [width, length];
  const out: string[] = [];
  for (let i = 0; i < w; i++) for (let j = 0; j < l; j++) out.push(`${x + i},${y + j}`);
  return out;
}
