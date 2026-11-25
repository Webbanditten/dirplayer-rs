/**
 * The small (32 px) version of a furni. The hotel keeps it in a cast of its own, hh_furni_xx_s_<class>.cct, laid out
 * like the large one with `s_` in front: members `s_<class>_<layer>_0_<l>_<w>_<dir>_<frame>`, `s_<class>.props`,
 * `s_<class>.data`, `s_` palettes, memberalias.index with `s_` names; the icons (`<class>_small...`) are in both, at
 * the same size. A furni without one gets it made from the large cast: pictures halved (paint.ts `halve`),
 * registration points and locshift points halved, names prefixed. A wall item's `leftwall <class>_...` /
 * `rightwall <class>_...` become `s_leftwall <class>_...` (as the hotel's hh_furni_xx_s_arabian_swords.cct has them).
 */
import { CastDocument } from './wasm';
import { ALIAS_INDEX, ASSET_INDEX, type Member } from './furni';
import { fromRgbBytes, halve, type PaintImage } from './paint';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const smallFileName = (cls: string) => `hh_furni_xx_s_${cls}.cct`;
export const largeFileName = (cls: string) => `hh_furni_xx_${cls}.cct`;
export const isSmallFile = (name: string) => /^hh_furni_xx_s_/i.test(name);

/** A small cast made from the large one. */
export function makeSmall(large: CastDocument, cls: string): CastDocument {
  const doc = new CastDocument(large.save());
  const members: Member[] = JSON.parse(doc.membersJson());
  const own = new RegExp(`^(?:(?:left|right)wall )?${esc(cls)}(?=[_.]|$)`, 'i');
  const icon = new RegExp(`^${esc(cls)}_small(_[a-z])?$`, 'i');
  const rename = (name: string) => (own.test(name) && !icon.test(name) ? 's_' + name : name);
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
        const half = halve(img, b.depth <= 8 ? paletteOf(m) : []);
        const rx = Math.round(b.regX / 2), ry = Math.round(b.regY / 2);
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
