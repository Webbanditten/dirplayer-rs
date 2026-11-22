/**
 * Pixel drawing on a member's own pixels: palette indices for an 8-bit member (a colour is an index into its palette,
 * as Director stores it), RGBA for a 32-bit one. The tools are Windows XP Paint's: pencil, brush, eraser, fill, colour
 * picker, airbrush, line, rectangle, ellipse.
 */

export type PaintImage =
  | { kind: 'indexed'; w: number; h: number; px: Uint8Array }
  | { kind: 'rgba'; w: number; h: number; px: Uint8Array };

/** A palette index (indexed) or 0xAARRGGBB as an unsigned number (rgba). */
export type Ink = number;

export const BUILTIN_PALETTES: { id: number; name: string }[] = [
  { id: -1, name: 'System Mac' },
  { id: -102, name: 'System Win' },
  { id: -101, name: 'System Win (Director 4)' },
  { id: -3, name: 'Grayscale' },
  { id: -2, name: 'Rainbow' },
  { id: -4, name: 'Pastels' },
  { id: -5, name: 'Vivid' },
  { id: -6, name: 'NTSC' },
  { id: -7, name: 'Metallic' },
  { id: -8, name: 'Web 216' },
  { id: -9, name: 'VGA' },
];

/** Windows XP Paint's colour box. */
export const XP_COLORS = [
  0x000000, 0x808080, 0x800000, 0x808000, 0x008000, 0x008080, 0x000080, 0x800080, 0x808040, 0x004040, 0x0080ff, 0x004080, 0x8000ff, 0x804000,
  0xffffff, 0xc0c0c0, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffff80, 0x00ff80, 0x80ffff, 0x8080ff, 0xff0080, 0xff8040,
];

export function clone(img: PaintImage): PaintImage {
  return { ...img, px: img.px.slice() } as PaintImage;
}

export function getPixel(img: PaintImage, x: number, y: number): Ink {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return -1;
  const i = y * img.w + x;
  if (img.kind === 'indexed') return img.px[i];
  const p = img.px;
  return ((p[i * 4 + 3] << 24) | (p[i * 4] << 16) | (p[i * 4 + 1] << 8) | p[i * 4 + 2]) >>> 0;
}

export function setPixel(img: PaintImage, x: number, y: number, c: Ink) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = y * img.w + x;
  if (img.kind === 'indexed') {
    img.px[i] = c & 255;
    return;
  }
  img.px[i * 4] = (c >>> 16) & 255;
  img.px[i * 4 + 1] = (c >>> 8) & 255;
  img.px[i * 4 + 2] = c & 255;
  img.px[i * 4 + 3] = (c >>> 24) & 255;
}

/** A square stamp of `size` pixels centred on (x, y) (round for sizes above 2, like Paint's brush). */
export function stamp(img: PaintImage, x: number, y: number, c: Ink, size: number) {
  if (size <= 1) return setPixel(img, x, y, c);
  const r = (size - 1) / 2;
  for (let dy = -Math.floor(r); dy <= Math.ceil(r); dy++) {
    for (let dx = -Math.floor(r); dx <= Math.ceil(r); dx++) {
      if (size > 2 && dx * dx + dy * dy > r * r + r) continue;
      setPixel(img, x + dx, y + dy, c);
    }
  }
}

/** Bresenham, stamping each point. */
export function line(img: PaintImage, x0: number, y0: number, x1: number, y1: number, c: Ink, size = 1) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stamp(img, x0, y0, c, size);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export type ShapeFill = 'outline' | 'both' | 'fill';

/** Paint's rectangle: outline in `stroke`, inside in `fill` (the other colour), or both. */
export function rect(img: PaintImage, x0: number, y0: number, x1: number, y1: number, stroke: Ink, fill: Ink, mode: ShapeFill, size = 1) {
  const [l, r] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [t, b] = [Math.min(y0, y1), Math.max(y0, y1)];
  if (mode !== 'outline') {
    const inner = mode === 'fill' ? stroke : fill;
    for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) setPixel(img, x, y, inner);
  }
  if (mode !== 'fill') {
    for (let k = 0; k < size; k++) {
      for (let x = l; x <= r; x++) {
        setPixel(img, x, t + k, stroke);
        setPixel(img, x, b - k, stroke);
      }
      for (let y = t; y <= b; y++) {
        setPixel(img, l + k, y, stroke);
        setPixel(img, r - k, y, stroke);
      }
    }
  }
}

/** An ellipse inside the box (x0, y0)-(x1, y1), drawn row by row so its outline has no gaps. */
export function ellipse(img: PaintImage, x0: number, y0: number, x1: number, y1: number, stroke: Ink, fill: Ink, mode: ShapeFill, size = 1) {
  const [l, r] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [t, b] = [Math.min(y0, y1), Math.max(y0, y1)];
  const cx = (l + r) / 2, cy = (t + b) / 2;
  const rx = (r - l) / 2 + 0.5, ry = (b - t) / 2 + 0.5;
  const inside = (x: number, y: number, shrink: number) => {
    const ax = rx - shrink, ay = ry - shrink;
    if (ax <= 0 || ay <= 0) return false;
    const nx = (x - cx) / ax, ny = (y - cy) / ay;
    return nx * nx + ny * ny <= 1;
  };
  for (let y = t; y <= b; y++) {
    for (let x = l; x <= r; x++) {
      if (!inside(x, y, 0)) continue;
      const edge = !inside(x, y, size);
      if (edge && mode !== 'fill') setPixel(img, x, y, stroke);
      else if (!edge && mode === 'both') setPixel(img, x, y, fill);
      else if (mode === 'fill') setPixel(img, x, y, stroke);
    }
  }
}

/** Fill the 4-connected area of (x, y)'s colour. */
export function floodFill(img: PaintImage, x: number, y: number, c: Ink) {
  const target = getPixel(img, x, y);
  if (target < 0 || target === c) return;
  const stack = [y * img.w + x];
  const seen = new Uint8Array(img.w * img.h);
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i]) continue;
    seen[i] = 1;
    const px = i % img.w, py = (i - px) / img.w;
    if (getPixel(img, px, py) !== target) continue;
    setPixel(img, px, py, c);
    if (px > 0) stack.push(i - 1);
    if (px < img.w - 1) stack.push(i + 1);
    if (py > 0) stack.push(i - img.w);
    if (py < img.h - 1) stack.push(i + img.w);
  }
}

/** One puff of Paint's airbrush: a few random dots inside a circle. */
export function spray(img: PaintImage, x: number, y: number, c: Ink, radius: number) {
  for (let k = 0; k < Math.max(3, radius); k++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * radius;
    setPixel(img, Math.round(x + Math.cos(a) * d), Math.round(y + Math.sin(a) * d), c);
  }
}

export function flip(img: PaintImage, horizontal: boolean): PaintImage {
  const out = clone(img);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) setPixel(out, horizontal ? img.w - 1 - x : x, horizontal ? y : img.h - 1 - y, getPixel(img, x, y));
  return out;
}

/** A new canvas size; `ax`, `ay` (0, 0.5, 1) say where the old picture sits. Returns the image and its offset. */
export function resize(img: PaintImage, w: number, h: number, ax: number, ay: number, background: Ink) {
  const dx = Math.round((w - img.w) * ax), dy = Math.round((h - img.h) * ay);
  const out: PaintImage = img.kind === 'indexed' ? { kind: 'indexed', w, h, px: new Uint8Array(w * h) } : { kind: 'rgba', w, h, px: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(out, x, y, background);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) setPixel(out, x + dx, y + dy, getPixel(img, x, y));
  return { img: out, dx, dy };
}

/** RGBA pixels for display: indices through the palette (0xRRGGBB), index 0 see-through when asked. */
export function toRgba(img: PaintImage, palette: number[], zeroTransparent: boolean): Uint8ClampedArray {
  if (img.kind === 'rgba') return new Uint8ClampedArray(img.px);
  const out = new Uint8ClampedArray(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i++) {
    const v = img.px[i];
    const c = palette[v] ?? 0;
    out[i * 4] = (c >> 16) & 255;
    out[i * 4 + 1] = (c >> 8) & 255;
    out[i * 4 + 2] = c & 255;
    out[i * 4 + 3] = zeroTransparent && v === 0 ? 0 : 255;
  }
  return out;
}

export function nearestIndex(palette: number[], c: number, skipZero = false): number {
  let best = 0, bestD = Infinity;
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  for (let i = skipZero ? 1 : 0; i < palette.length; i++) {
    const p = palette[i];
    const d = (((p >> 16) & 255) - r) ** 2 + (((p >> 8) & 255) - g) ** 2 + ((p & 255) - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Indices -> other palette, each to the nearest colour (index 0, the background, stays 0). */
export function remap(img: PaintImage & { kind: 'indexed' }, from: number[], to: number[]): PaintImage {
  const cache = new Map<number, number>();
  const out = clone(img);
  for (let i = 0; i < img.px.length; i++) {
    const v = img.px[i];
    if (v === 0) continue;
    if (!cache.has(v)) cache.set(v, nearestIndex(to, from[v] ?? 0, true));
    out.px[i] = cache.get(v)!;
  }
  return out;
}

/** RGBA -> indices on a palette: alpha below 128 = index 0 (the background the white-keyed inks drop). */
export function toIndexed(rgba: Uint8Array, w: number, h: number, palette: number[]): PaintImage {
  const out = new Uint8Array(w * h);
  const cache = new Map<number, number>();
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] < 128) continue;
    const c = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    let v = cache.get(c);
    if (v === undefined) {
      v = nearestIndex(palette, c, true);
      cache.set(c, v);
    }
    out[i] = v;
  }
  return { kind: 'indexed', w, h, px: out };
}

export function toRgbaImage(img: PaintImage, palette: number[]): PaintImage {
  if (img.kind === 'rgba') return img;
  return { kind: 'rgba', w: img.w, h: img.h, px: new Uint8Array(toRgba(img, palette, false)) };
}

/** A palette from pictures' colours (median cut), white at 0 and black at 255 like Director's palettes. */
export function paletteFromColors(rgba: Uint8Array[], size = 256): number[] {
  const counts = new Map<number, number>();
  for (const px of rgba) {
    for (let i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const c = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  counts.delete(0xffffff);
  counts.delete(0x000000);
  const room = size - 2;
  let colors: number[];
  if (counts.size <= room) {
    colors = [...counts.keys()];
  } else {
    type Box = number[];
    const boxes: Box[] = [[...counts.keys()]];
    const ch = (c: number, k: number) => (c >> (16 - k * 8)) & 255;
    while (boxes.length < room) {
      boxes.sort((a, b) => b.length - a.length);
      const box = boxes.shift()!;
      if (box.length < 2) {
        boxes.push(box);
        break;
      }
      const ranges = [0, 1, 2].map((k) => Math.max(...box.map((c) => ch(c, k))) - Math.min(...box.map((c) => ch(c, k))));
      const k = ranges.indexOf(Math.max(...ranges));
      box.sort((a, b) => ch(a, k) - ch(b, k));
      const mid = box.length >> 1;
      boxes.push(box.slice(0, mid), box.slice(mid));
    }
    colors = boxes.map((box) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const c of box) {
        const w = counts.get(c) ?? 1;
        r += ch(c, 0) * w;
        g += ch(c, 1) * w;
        b += ch(c, 2) * w;
        n += w;
      }
      return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
    });
  }
  const out = [0xffffff, ...colors.slice(0, room)];
  while (out.length < size - 1) out.push(0x000000);
  out.push(0x000000);
  return out;
}

/** White at 0 down to black at 255: for layers the client tints with a part colour (ink 41). */
export function greyRamp(): number[] {
  return Array.from({ length: 256 }, (_, i) => {
    const v = 255 - i;
    return (v << 16) | (v << 8) | v;
  });
}

export const hex = (c: number) => '#' + (c & 0xffffff).toString(16).padStart(6, '0');
export const fromHex = (s: string) => parseInt(s.replace('#', ''), 16) & 0xffffff;
export const toRgbBytes = (palette: number[]) => new Uint8Array(palette.flatMap((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]));
export const fromRgbBytes = (rgb: Uint8Array) => {
  const out: number[] = [];
  for (let i = 0; i + 2 < rgb.length; i += 3) out.push((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2]);
  return out;
};
