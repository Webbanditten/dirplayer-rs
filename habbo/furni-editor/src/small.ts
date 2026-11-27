/**
 * The small (32 px) version of a furni. The hotel keeps it in a cast of its own, hh_furni_xx_s_<class>.cct, laid out
 * like the large one with `s_` in front: members `s_<class>_<layer>_0_<l>_<w>_<dir>_<frame>`, `s_<class>.props`,
 * `s_<class>.data`, `s_` palettes, memberalias.index with `s_` names; the icons (`<class>_small...`) are in both, at
 * the same size. A furni without one gets it made from the large cast: pictures at half size, each picked pixel by
 * pixel on the furni's shared grid (downscale.ts), registration points and locshift points halved, names prefixed.
 * A wall item's `leftwall <class>_...` / `rightwall <class>_...` become `s_leftwall <class>_...` (as the hotel's
 * hh_furni_xx_s_arabian_swords.cct has them).
 */
import { CastDocument } from './wasm';
import { ALIAS_INDEX, ASSET_INDEX, type Member } from './furni';
import { halveOnGrid } from './downscale';
import { fromRgbBytes, halveEarlier, type PaintImage } from './paint';

/** How the pictures are halved: picked by the network (downscale.ts), or as the editor did it before that. */
export type Halving = 'picked' | 'earlier';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const smallFileName = (cls: string) => `hh_furni_xx_s_${cls}.cct`;
export const largeFileName = (cls: string) => `hh_furni_xx_${cls}.cct`;
export const isSmallFile = (name: string) => /^hh_furni_xx_s_/i.test(name);

/** Which members are the furni's own (they get `s_` in front) and which are its icon (they stay as they are). */
function naming(cls: string) {
  const own = new RegExp(`^(?:(?:left|right)wall )?${esc(cls)}(?=[_.]|$)`, 'i');
  const icon = new RegExp(`^${esc(cls)}_small(_[a-z])?$`, 'i');
  return { own, icon, rename: (name: string) => (own.test(name) && !icon.test(name) ? 's_' + name : name) };
}

const odd = (v: number) => ((v % 2) + 2) % 2;

/** The size and registration point a picture has at half size. */
function halfBox(b: { width: number; height: number; regX: number; regY: number }, how: Halving) {
  if (b.width <= 1 && b.height <= 1) return { w: b.width, h: b.height, regX: b.regX, regY: b.regY };
  if (how === 'earlier') return { w: Math.max(1, Math.ceil(b.width / 2)), h: Math.max(1, Math.ceil(b.height / 2)), regX: Math.round(b.regX / 2), regY: Math.round(b.regY / 2) };
  // on the grid counted from the registration point (downscale.ts `halveOnGrid`)
  const ox = odd(b.regX), oy = odd(b.regY);
  return { w: Math.ceil((b.width + ox) / 2), h: Math.ceil((b.height + oy) / 2), regX: (b.regX + ox) / 2, regY: (b.regY + oy) / 2 };
}

/** A small cast made from the large one. */
export function makeSmall(large: CastDocument, cls: string, how: Halving = 'picked'): CastDocument {
  const doc = new CastDocument(large.save());
  const members: Member[] = JSON.parse(doc.membersJson());
  const { own, icon, rename } = naming(cls);
  const paletteOf = (m: Member) => {
    const id = m.bitmap!.paletteId;
    return fromRgbBytes(id > 0 ? doc.paletteColors(id) : CastDocument.builtinPalette(id));
  };
  for (const m of members) {
    if (m.type === 'palette') {
      doc.setName(m.slot, 's_' + m.name);
      continue;
    }
    if (m.type === 'bitmap' && m.bitmap) {
      if (icon.test(m.name)) continue;
      const b = m.bitmap;
      if (b.width > 1 || b.height > 1) {
        const img: PaintImage = b.depth <= 8
          ? { kind: 'indexed', w: b.width, h: b.height, px: doc.bitmapIndices(m.slot) }
          : { kind: 'rgba', w: b.width, h: b.height, px: doc.rgba(m.slot) };
        const palette = b.depth <= 8 ? paletteOf(m) : [];
        const box = halfBox(b, how);
        const half = how === 'earlier' ? halveEarlier(img, palette) : halveOnGrid(img, palette, b.regX, b.regY).img;
        const rx = box.regX, ry = box.regY;
        if (half.kind === 'indexed') doc.setBitmapIndexed(m.slot, half.px, half.w, half.h, rx, ry, 0);
        else doc.setBitmap(m.slot, half.px, half.w, half.h, rx, ry, 'rgba', 0);
      }
      if (rename(m.name) !== m.name) doc.setName(m.slot, rename(m.name));
      continue;
    }
    if (m.type === 'field' || m.type === 'text') {
      const text = doc.text(m.slot) ?? '';
      if (m.name.toLowerCase() === ALIAS_INDEX) {
        doc.setText(m.slot, text.split('\n').map((l) => {
          const eq = l.indexOf('=');
          if (eq <= 0) return l;
          const target = l.slice(eq + 1).trim();
          const star = target.endsWith('*');
          return `${rename(l.slice(0, eq).trim())}=${rename(star ? target.slice(0, -1) : target)}${star ? '*' : ''}`;
        }).join('\n'));
      } else if (m.name.toLowerCase() === ASSET_INDEX) {
        doc.setText(m.slot, text.replace(new RegExp(`"${esc(cls)}"`, 'i'), `"s_${cls}"`));
      } else if (own.test(m.name)) {
        doc.setName(m.slot, 's_' + m.name);
        // locshift points are in pixels: half of them.
        doc.setText(m.slot, text.replace(/point\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/g, (_s, x, y) => `point(${Math.round(+x / 2)}, ${Math.round(+y / 2)})`));
      }
    }
  }
  return doc;
}

/** Whether two small casts hold the same members: names, pictures as they look, registration points, texts. */
function sameCast(made: CastDocument, small: CastDocument): boolean {
  const a: Member[] = JSON.parse(made.membersJson());
  const b: Member[] = JSON.parse(small.membersJson());
  if (a.length !== b.length) return false;
  const byName = new Map(b.map((m) => [m.name.toLowerCase(), m]));
  for (const m of a) {
    const o = byName.get(m.name.toLowerCase());
    if (!o || o.type !== m.type) return false;
    if (m.type === 'bitmap' && m.bitmap && o.bitmap) {
      const x = m.bitmap, y = o.bitmap;
      if (x.width !== y.width || x.height !== y.height || x.regX !== y.regX || x.regY !== y.regY) return false;
      const p = made.rgba(m.slot), q = small.rgba(o.slot);
      if (p.length !== q.length) return false;
      // a transparent pixel is the same whatever colour it carries
      for (let i = 0; i < p.length; i += 4) {
        if (p[i + 3] !== q[i + 3]) return false;
        if (p[i + 3] && (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2])) return false;
      }
    } else if (m.type === 'field' || m.type === 'text') {
      if ((made.text(m.slot) ?? '').trim() !== (small.text(o.slot) ?? '').trim()) return false;
    }
  }
  return true;
}

/**
 * Whether `small` is exactly what `makeSmall` makes from `large`: then it was never touched by hand and can keep
 * following the large cast (the editor makes it again after every change to the large pictures). `'earlier'`: it is
 * what the editor made before its pictures were picked by the network; it follows too, and is due to be made again.
 */
export function madeFromLarge(large: CastDocument, small: CastDocument, cls: string): Halving | false {
  let largeMembers: Member[], smallMembers: Member[];
  try {
    largeMembers = JSON.parse(large.membersJson());
    smallMembers = JSON.parse(small.membersJson());
  } catch {
    return false;
  }
  if (largeMembers.length !== smallMembers.length) return false;
  const { icon, rename } = naming(cls);
  const byName = new Map(smallMembers.map((m) => [m.name.toLowerCase(), m]));
  for (const how of ['picked', 'earlier'] as const) {
    // The cheap look first (names, sizes, registration points): a small cast drawn by hand, as the hotel's are,
    // rarely gets past it, so opening one doesn't halve every picture just to find that out.
    const fits = largeMembers.every((m) => {
      if (m.type !== 'bitmap' || !m.bitmap || icon.test(m.name)) return true;
      const o = byName.get(rename(m.name).toLowerCase())?.bitmap;
      const box = halfBox(m.bitmap, how);
      return !!o && o.width === box.w && o.height === box.h && o.regX === box.regX && o.regY === box.regY;
    });
    if (!fits) continue;
    let made: CastDocument | null = null;
    try {
      made = makeSmall(large, cls, how);
      if (sameCast(made, small)) return how;
    } catch {
      // not a cast the editor made
    } finally {
      made?.free();
    }
  }
  return false;
}
