/**
 * Half size for pixel art, the way Sulake's artists made a furni's small (32 px) pictures from the large ones.
 *
 * Every 2x2 block becomes one of its own four pixels (so colours stay exactly the picture's, and an 8-bit picture
 * stays on its palette), or nothing. Which one is picked by a small network (`downscale-model.ts`) trained on the
 * hotel's own furni: the large and small layer pictures of every furni that has both (1,366 furni, 8,295 pictures),
 * where two thirds of the small pixels Sulake drew are one of the four pixels of the block they stand for. For each
 * block it looks at the block and two pixels around it (6 x 6): what is see-through, how light, which colours, how
 * alike the four candidates are and how common each one's colour is around it. That keeps what a rule like "the
 * darkest pixel wins" swallows: eyes, highlights, thin lines next to an outline. The network is asked twice, about
 * the window and about its mirror image, and candidates of one colour share their votes: a picture and its mirror
 * image come out as each other's mirror image.
 *
 * Four rules sit on top of the network:
 * - a block of four identical pixels with only solid pixels around it stays that pixel (no network needed);
 * - no holes: a block with only solid pixels around it never becomes nothing;
 * - the outer outline stays closed: a pixel on the edge of the shape takes its block's darkest pixel when the block
 *   has an outline-dark one;
 * - texture is averaged (32-bit pictures only): where nearly every pixel differs from its neighbours (a halftone, a
 *   photograph, a gradient) there is nothing to pick, and one pixel out of four turns it into blotches.
 *
 * A 32-bit picture can hold any colour, so there the picked pixel only says which colour the block stands for: the
 * block's pixels close to that colour are averaged with it. Dithered shading comes out smooth, outlines and details
 * stay as sharp as picked. An 8-bit picture keeps the picked pixel as it is.
 *
 * All pictures of a furni are halved on one grid, counted from the tile point (the registration point), so layers
 * and animation frames that fit together at 64 px still do at 32 px: a picture whose registration point is odd
 * starts its blocks one pixel before its first column. Measured against Sulake's small pictures, that grid fits best.
 *
 * A 32-bit picture with soft see-through (a glow, a smooth shadow) is not pixel art: it is averaged as a whole.
 */
import { MODEL } from './downscale-model';
import type { PaintImage } from './paint';

const WIN = 6;
/** the block inside its 6 x 6 window, as window positions (y * 6 + x): top left, top right, bottom left, bottom right */
const CAND = [14, 15, 20, 21];
/** an outline-dark pixel: lighter than this (0..255) and a pixel isn't part of an outline */
const DARK = 72;
const SOLID = 128;
/** texture: at least this share of the neighbouring pixel pairs in a block's window differ */
const TEXTURE = 0.85;
/** 32-bit pictures: a block's pixels within this colour distance (0..441) of the picked one are averaged with it */
const BLEND = 64;

interface Layer {
  w: Float32Array;
  b: Float32Array;
  inputs: number;
  outputs: number;
}

let net: Layer[] | null = null;

/** 16-bit little-endian numbers in base64, times `scale`. */
function decode(base64: string, scale: number): Float32Array {
  const bin = atob(base64);
  const out = new Float32Array(bin.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = (v > 32767 ? v - 65536 : v) * scale;
  }
  return out;
}

function load(): Layer[] {
  if (net) return net;
  const t = (name: string) => decode(MODEL.tensors[name].data, MODEL.tensors[name].scale);
  net = MODEL.sizes.slice(1).map((outputs, i) => ({ w: t(`W${i}`), b: t(`B${i}`), inputs: MODEL.sizes[i], outputs }));
  return net;
}

/** A picture as the room shows it: RGBA, a pixel is there when its alpha is 128 or more. */
export interface Seen {
  w: number;
  h: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

/**
 * An 8-bit picture as the room shows it. Palette index 0 is the background: where it reaches the picture's edge it
 * is dropped (Director's matte ink), enclosed it is a colour like any other (the white of an eye).
 */
export function seenIndexed(img: PaintImage & { kind: 'indexed' }, palette: number[]): Seen {
  const { w, h, px } = img;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (px[i] === 0 && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < (h - 1) * w) push(i + w);
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = palette[px[i]] ?? 0;
    rgba[i * 4] = (c >> 16) & 255;
    rgba[i * 4 + 1] = (c >> 8) & 255;
    rgba[i * 4 + 2] = c & 255;
    rgba[i * 4 + 3] = outside[i] ? 0 : 255;
  }
  return { w, h, rgba };
}

export interface Picks {
  /** the small picture's size */
  w: number;
  h: number;
  /** per small pixel: the source pixel it takes (y * w + x of the source picture), or -1 for nothing */
  from: Int32Array;
  /** per small pixel: 1 where the block is texture (better averaged than picked, when the picture can hold any colour) */
  texture: Uint8Array;
}

// Pictures picked before, by what they look like: the small cast is made again after every change to the large one,
// and only the changed picture needs the network again.
const picked = new Map<string, Picks>();
const REMEMBER = 3000;

function keyOf(src: Seen, ox: number, oy: number): string {
  let a = 0x811c9dc5, b = 0x9e3779b1;
  const d = src.rgba;
  for (let i = 0; i < d.length; i++) {
    a = Math.imul(a ^ d[i], 0x01000193);
    b = (Math.imul(b, 31) + d[i] + (b >>> 27)) | 0;
  }
  return `${src.w}x${src.h}:${ox}${oy}:${a >>> 0}:${b >>> 0}`;
}

/** What the network looks at for one window (`a`: there or not, `l`: how light, `rgb`), in the order it was trained on. */
function describe(a: Float32Array, l: Float32Array, rgb: Float32Array, features: Float32Array) {
  let f = 0;
  for (let k = 0; k < 36; k++) features[f++] = a[k];
  for (let k = 0; k < 36; k++) features[f++] = l[k];
  for (let k = 0; k < 108; k++) features[f++] = rgb[k];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const p = CAND[i] * 3, q = CAND[j] * 3;
      const d = Math.sqrt((rgb[p] - rgb[q]) ** 2 + (rgb[p + 1] - rgb[q + 1]) ** 2 + (rgb[p + 2] - rgb[q + 2]) ** 2) / 1.732;
      features[f++] = d;
      features[f++] = d < 1e-4 && a[CAND[i]] === a[CAND[j]] ? 1 : 0;
    }
  }
  for (let i = 0; i < 4; i++) {
    const p = CAND[i] * 3;
    let same = 0, sameInner = 0, near = 0;
    for (let k = 0; k < 36; k++) {
      if (a[k] !== a[CAND[i]]) continue;
      const d = Math.abs(rgb[k * 3] - rgb[p]) + Math.abs(rgb[k * 3 + 1] - rgb[p + 1]) + Math.abs(rgb[k * 3 + 2] - rgb[p + 2]);
      if (d < 0.12) near++;
      if (d < 1e-4) {
        same++;
        const y = (k / WIN) | 0, x = k % WIN;
        if (y >= 1 && y <= 4 && x >= 1 && x <= 4) sameInner++;
      }
    }
    features[f++] = same / 36;
    features[f++] = sameInner / 16;
    features[f++] = near / 36;
  }
  let all = 0, top = 0, bottom = 0, left = 0, right = 0;
  for (let k = 0; k < 36; k++) {
    const y = (k / WIN) | 0, x = k % WIN;
    all += a[k];
    if (y < 2) top += a[k];
    if (y >= 4) bottom += a[k];
    if (x < 2) left += a[k];
    if (x >= 4) right += a[k];
  }
  features[f++] = all / 36;
  features[f++] = top / 12;
  features[f++] = bottom / 12;
  features[f++] = left / 12;
  features[f++] = right / 12;
}

/** The network's five numbers for a window: one per candidate (top left, top right, bottom left, bottom right) and one for nothing. */
function ask(layers: Layer[], acts: Float32Array[], features: Float32Array): Float32Array {
  let input = features;
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li], out = acts[li];
    out.set(layer.b);
    for (let i = 0; i < layer.inputs; i++) {
      const v = input[i];
      if (v === 0) continue;
      const row = i * layer.outputs;
      for (let j = 0; j < layer.outputs; j++) out[j] += v * layer.w[row + j];
    }
    if (li < layers.length - 1) for (let j = 0; j < layer.outputs; j++) if (out[j] < 0) out[j] = 0;
    input = out;
  }
  return input;
}

/** in the mirror image the left candidates are the right ones */
const MIRROR = [1, 0, 3, 2, 4];

/**
 * Which source pixel every block takes. `ox`, `oy` (0 or 1): the blocks start that many pixels before the picture's
 * first column and row, so the first block has only its second column (row) inside the picture.
 */
export function pickPixels(src: Seen, ox = 0, oy = 0): Picks {
  const key = keyOf(src, ox, oy);
  const known = picked.get(key);
  if (known) return known;
  const layers = load();
  const w = Math.ceil((src.w + ox) / 2), h = Math.ceil((src.h + oy) / 2);
  const from = new Int32Array(w * h).fill(-1);
  const texture = new Uint8Array(w * h);
  const features = new Float32Array(layers[0].inputs);
  // the window's pixels: there or not, how light, colour (0..1; nothing for a pixel that isn't there), where from
  const a = new Float32Array(36), l = new Float32Array(36), rgb = new Float32Array(108), at = new Int32Array(36);
  // and its mirror image
  const am = new Float32Array(36), lm = new Float32Array(36), rgbm = new Float32Array(108);
  const candSolid = new Uint8Array(w * h * 4), candLum = new Float32Array(w * h * 4), candAt = new Int32Array(w * h * 4);
  const acts = layers.map((layer) => new Float32Array(layer.outputs));
  const votes = new Float64Array(5);
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      for (let wy = 0; wy < WIN; wy++) {
        for (let wx = 0; wx < WIN; wx++) {
          const k = wy * WIN + wx;
          const sx = 2 * bx + wx - 2 - ox, sy = 2 * by + wy - 2 - oy;
          const inside = sx >= 0 && sy >= 0 && sx < src.w && sy < src.h;
          const i = inside ? (sy * src.w + sx) * 4 : -1;
          const there = inside && src.rgba[i + 3] >= SOLID;
          at[k] = there ? sy * src.w + sx : -1;
          a[k] = there ? 1 : 0;
          rgb[k * 3] = there ? src.rgba[i] / 255 : 0;
          rgb[k * 3 + 1] = there ? src.rgba[i + 1] / 255 : 0;
          rgb[k * 3 + 2] = there ? src.rgba[i + 2] / 255 : 0;
          l[k] = 0.299 * rgb[k * 3] + 0.587 * rgb[k * 3 + 1] + 0.114 * rgb[k * 3 + 2];
        }
      }
      const o = (by * w + bx) * 4;
      let solid = 0;
      for (let c = 0; c < 4; c++) {
        const k = CAND[c];
        candSolid[o + c] = a[k];
        candLum[o + c] = a[k] ? l[k] * 255 : 999;
        candAt[o + c] = at[k];
        solid += a[k];
      }
      if (!solid) continue;
      // only solid pixels around the block (the 4 x 4 in the middle of the window)
      let ring = true;
      for (let y = 1; y <= 4 && ring; y++) for (let x = 1; x <= 4; x++) if (!a[y * WIN + x]) { ring = false; break; }
      const sameColour = (p: number, q: number) => rgb[p * 3] === rgb[q * 3] && rgb[p * 3 + 1] === rgb[q * 3 + 1] && rgb[p * 3 + 2] === rgb[q * 3 + 2];
      if (ring) {
        // texture: nearly every pair of neighbours in the window differs
        let pairs = 0, differ = 0;
        for (let y = 0; y < WIN; y++) {
          for (let x = 0; x < WIN; x++) {
            const k = y * WIN + x;
            if (!a[k]) continue;
            if (x < WIN - 1 && a[k + 1]) { pairs++; if (!sameColour(k, k + 1)) differ++; }
            if (y < WIN - 1 && a[k + WIN]) { pairs++; if (!sameColour(k, k + WIN)) differ++; }
          }
        }
        if (differ >= TEXTURE * pairs) texture[by * w + bx] = 1;
        if (sameColour(CAND[0], CAND[1]) && sameColour(CAND[0], CAND[2]) && sameColour(CAND[0], CAND[3])) {
          from[by * w + bx] = candAt[o];
          continue;
        }
      }
      // --- the network, asked about the window and about its mirror image ---
      votes.fill(0);
      for (let side = 0; side < 2; side++) {
        if (side === 0) describe(a, l, rgb, features);
        else {
          for (let y = 0; y < WIN; y++) {
            for (let x = 0; x < WIN; x++) {
              const k = y * WIN + x, m = y * WIN + (WIN - 1 - x);
              am[k] = a[m];
              lm[k] = l[m];
              rgbm[k * 3] = rgb[m * 3];
              rgbm[k * 3 + 1] = rgb[m * 3 + 1];
              rgbm[k * 3 + 2] = rgb[m * 3 + 2];
            }
          }
          describe(am, lm, rgbm, features);
        }
        const z = ask(layers, acts, features);
        // a pixel that isn't there can't be picked; nothing can't be where everything around is solid
        const allowed = (c: number) => (c < 4 ? candSolid[o + c] === 1 : !ring);
        let max = -Infinity;
        for (let c = 0; c < 5; c++) if (allowed(c)) max = Math.max(max, z[side ? MIRROR[c] : c]);
        let sum = 0;
        for (let c = 0; c < 5; c++) if (allowed(c)) sum += Math.exp(z[side ? MIRROR[c] : c] - max);
        for (let c = 0; c < 5; c++) if (allowed(c)) votes[c] += Math.exp(z[side ? MIRROR[c] : c] - max) / sum;
      }
      // candidates of one colour share their votes
      let best = ring ? -1 : 4, bestVotes = ring ? -1 : votes[4];
      for (let c = 3; c >= 0; c--) {
        if (!candSolid[o + c]) continue;
        let v = 0;
        for (let j = 0; j < 4; j++) if (candSolid[o + j] && sameColour(CAND[c], CAND[j])) v += votes[j];
        if (v >= bestVotes) {
          best = c;
          bestVotes = v;
        }
      }
      if (best < 4) from[by * w + bx] = candAt[o + best];
    }
  }
  // --- the outer outline stays closed ---
  const on = (map: Uint8Array, x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && map[y * w + x] === 1;
  const kept = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) kept[i] = from[i] >= 0 ? 1 : 0;
  const hasDark = (i: number) => candLum[i * 4] < DARK || candLum[i * 4 + 1] < DARK || candLum[i * 4 + 2] < DARK || candLum[i * 4 + 3] < DARK;
  // a block the network left empty that holds an outline pixel next to the shape is part of the outline
  const shape = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (kept[i]) shape[i] = 1;
      else if (hasDark(i) && candSolid[i * 4] + candSolid[i * 4 + 1] + candSolid[i * 4 + 2] + candSolid[i * 4 + 3] >= 2 && (on(kept, x, y - 1) || on(kept, x, y + 1) || on(kept, x - 1, y) || on(kept, x + 1, y))) shape[i] = 1;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!shape[i] || !hasDark(i)) continue;
      if (on(shape, x, y - 1) && on(shape, x, y + 1) && on(shape, x - 1, y) && on(shape, x + 1, y)) continue;
      let darkest = 0;
      for (let c = 1; c < 4; c++) if (candLum[i * 4 + c] < candLum[i * 4 + darkest]) darkest = c;
      from[i] = candAt[i * 4 + darkest];
    }
  }
  const picks = { w, h, from, texture };
  if (picked.size >= REMEMBER) picked.delete(picked.keys().next().value!);
  picked.set(key, picks);
  return picks;
}

const mod2 = (v: number) => ((v % 2) + 2) % 2;

/** Whether a picture is pixel art: hard edges, not a soft glow or a smooth shadow's see-through. */
export function isPixelArt(img: PaintImage): boolean {
  if (img.kind === 'indexed') return true;
  let soft = 0, seen = 0;
  for (let i = 3; i < img.px.length; i += 4) {
    const a = img.px[i];
    if (a > 8) seen++;
    if (a > 8 && a < 247) soft++;
  }
  return soft <= seen * 0.15;
}

/** A soft 32-bit picture at half size: every block's average, see-through weighed in. */
function average(img: PaintImage & { kind: 'rgba' }, ox: number, oy: number): PaintImage {
  const w = Math.ceil((img.w + ox) / 2), h = Math.ceil((img.h + oy) / 2);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = 2 * x + dx - ox, sy = 2 * y + dy - oy;
          if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
          const i = (sy * img.w + sx) * 4, al = img.px[i + 3];
          r += img.px[i] * al;
          g += img.px[i + 1] * al;
          b += img.px[i + 2] * al;
          a += al;
        }
      }
      const o = (y * w + x) * 4;
      if (a < 4) px.set([255, 255, 255, 0], o);
      else px.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / 4)], o);
    }
  }
  return { kind: 'rgba', w, h, px };
}

export interface Halved {
  img: PaintImage;
  regX: number;
  regY: number;
}

/**
 * A picture at half size with its registration point, on the grid counted from that point: every picture of a furni
 * halved this way is sampled on the same grid in the room.
 */
export function halveOnGrid(img: PaintImage, palette: number[], regX = 0, regY = 0): Halved {
  const ox = mod2(regX), oy = mod2(regY);
  const reg = { regX: (regX + ox) / 2, regY: (regY + oy) / 2 };
  if (img.kind === 'rgba' && !isPixelArt(img)) return { img: average(img, ox, oy), ...reg };
  const { w, h, from, texture } = pickPixels(img.kind === 'indexed' ? seenIndexed(img, palette) : { w: img.w, h: img.h, rgba: img.px }, ox, oy);
  if (img.kind === 'indexed') {
    const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = from[i] >= 0 ? img.px[from[i]] : 0;
    return { img: { kind: 'indexed', w, h, px }, ...reg };
  }
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (from[i] < 0) px.set([255, 255, 255, 0], i * 4);
    else if (texture[i]) {
      // the block's four pixels (all there: texture is only found among solid pixels)
      const x0 = 2 * (i % w) - ox, y0 = 2 * Math.floor(i / w) - oy;
      for (let ch = 0; ch < 4; ch++) {
        let sum = 0;
        for (let d = 0; d < 4; d++) sum += img.px[((y0 + (d >> 1)) * img.w + x0 + (d & 1)) * 4 + ch];
        px[i * 4 + ch] = Math.floor(sum / 4 + 0.5);
      }
    } else {
      // the picked pixel says which colour the block stands for; the block's pixels close to it are averaged in
      const p = from[i] * 4;
      const x0 = 2 * (i % w) - ox, y0 = 2 * Math.floor(i / w) - oy;
      let r = 0, g = 0, b = 0, n = 0;
      for (let d = 0; d < 4; d++) {
        const x = x0 + (d & 1), y = y0 + (d >> 1);
        if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
        const q = (y * img.w + x) * 4;
        if (img.px[q + 3] < SOLID) continue;
        const dr = img.px[q] - img.px[p], dg = img.px[q + 1] - img.px[p + 1], db = img.px[q + 2] - img.px[p + 2];
        if (dr * dr + dg * dg + db * db > BLEND * BLEND) continue;
        r += img.px[q];
        g += img.px[q + 1];
        b += img.px[q + 2];
        n++;
      }
      px.set([Math.floor(r / n + 0.5), Math.floor(g / n + 0.5), Math.floor(b / n + 0.5), img.px[p + 3]], i * 4);
    }
  }
  return { img: { kind: 'rgba', w, h, px }, ...reg };
}
