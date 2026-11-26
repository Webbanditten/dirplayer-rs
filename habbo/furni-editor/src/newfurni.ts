/**
 * A new furni from your own pictures (or from nothing, to paint here): the cast the hotel needs, built the way its own
 * furni are.
 *
 * - Floor furni: layer a as `<class>_a_0_<length>_<width>_<direction>_0`, stood on its tiles like the hotel's furni
 *   (tiles.ts `standOnTiles`: visible pixels centred on the tiles, lowest pixel just above their front corner).
 *   How it turns decides the directions, as the hotel's furni have them: not at all = direction 0 only (plant_bonsai,
 *   table_plasto_4leg); two sides = 2, and 4 as its mirror image (bar_polyfon, shelves_norja); four sides = pictures
 *   for 2 and 0, with 4 and 6 as their mirror images (chair_norja's layout, where 4 and 6 are drawn by hand).
 * - Wall item: `leftwall <class>_a_0`, the right wall as its mirror image, `<class>.data` listing the layer and the
 *   Item Object classes in asset.index (Item Object Extension Class builds its member names from .data).
 * - A shadow on its tiles (shadow.ts), the icon `<class>_small` from the furni as the room draws it, and the 32 px
 *   cast (small.ts), so nothing is missing when it is published.
 *
 * Like a Flash import the cast is built on a template cast from the hotel, whose members are replaced, so its
 * container and chunk layout are Director's.
 */
import { CastDocument } from './wasm';
import { ALIAS_INDEX, ASSET_INDEX, Furni } from './furni';
import { renderIcon } from './icon';
import { halve } from './paint';
import { shadowPicture, shadowPlan } from './shadow';
import { makeSmall } from './small';
import { opaqueBox, standOnTiles, tileBox } from './tiles';

export interface Picture {
  rgba: Uint8Array;
  width: number;
  height: number;
}

export type Turns = 'none' | 'mirror' | 'four';

export interface NewFurniOptions {
  name: string;
  kind: 'floor' | 'wall';
  /** [length, width] in tiles, as the member names and items_definitions have them */
  dims: [number, number];
  turns: Turns;
  /** the picture per direction it is drawn for (a wall item: 2 = the left wall); missing = an empty canvas to paint */
  pictures: Partial<Record<number, Picture>>;
  shadow: boolean;
}

/** The directions a new furni is drawn for, and the ones shown as their mirror image. */
export function directionsFor(kind: 'floor' | 'wall', turns: Turns): { own: number[]; mirrored: [number, number][] } {
  if (kind === 'wall') return { own: [2], mirrored: [[4, 2]] };
  if (turns === 'none') return { own: [0], mirrored: [] };
  if (turns === 'mirror') return { own: [2], mirrored: [[4, 2]] };
  return { own: [2, 0], mirrored: [[4, 2], [6, 0]] };
}

/**
 * A picture without transparency (a screenshot, a JPEG, a drawing on a plain background) gets its background removed:
 * every pixel connected to the border in the colour of the corners becomes transparent. `tolerance` is how far a
 * colour may be from the corner's (per channel) and still count. Returns the number of pixels cleared.
 */
export function removeBackground(p: Picture, tolerance = 12): number {
  const { rgba, width: w, height: h } = p;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return 0; // it has transparency of its own
  const corners = [0, w - 1, (h - 1) * w, h * w - 1].map((i) => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
  // The background is the colour most corners share.
  const key = corners.map((c) => corners.filter((o) => Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) + Math.abs(o[2] - c[2]) <= tolerance).length);
  const bg = corners[key.indexOf(Math.max(...key))];
  if (Math.max(...key) < 2) return 0;
  const match = (i: number) => Math.abs(rgba[i * 4] - bg[0]) <= tolerance && Math.abs(rgba[i * 4 + 1] - bg[1]) <= tolerance && Math.abs(rgba[i * 4 + 2] - bg[2]) <= tolerance;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (seen[i] || !match(i)) return;
    seen[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  let cleared = 0;
  while (stack.length) {
    const i = stack.pop()!;
    rgba.set([255, 255, 255, 0], i * 4);
    cleared++;
    const x = i % w, y = (i - x) / w;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return cleared;
}

/** A picture cut to its visible pixels (a 1x1 transparent picture when it has none). */
export function trim(p: Picture): Picture {
  const box = opaqueBox(p.rgba, p.width, p.height);
  if (!box) return { rgba: new Uint8Array([255, 255, 255, 0]), width: 1, height: 1 };
  const w = box.right - box.left, h = box.bottom - box.top;
  if (w === p.width && h === p.height) return p;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(p.rgba.subarray(((y + box.top) * p.width + box.left) * 4, ((y + box.top) * p.width + box.right) * 4), y * w * 4);
  return { rgba, width: w, height: h };
}

/** An empty canvas over the furni's tiles with room above them, to paint the furni on. */
function blankCanvas(dims: [number, number], direction: number) {
  const t = tileBox(dims, direction);
  const width = t.right - t.left, above = 64;
  const height = t.bottom - t.top + above;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([255, 255, 255, 0], i * 4);
  return { rgba, width, height, regX: -t.left, regY: above - t.top };
}

interface Planned {
  name: string;
  rgba: Uint8Array;
  width: number;
  height: number;
  regX: number;
  regY: number;
}

/** The members and fields of the new furni's large cast. */
export function planNewFurni(o: NewFurniOptions): { bitmaps: Planned[]; fields: { name: string; text: string }[]; blank: boolean } {
  const { own, mirrored } = directionsFor(o.kind, o.turns);
  const bitmaps: Planned[] = [];
  const aliases: string[] = [];
  const fields: { name: string; text: string }[] = [];
  let blank = false;
  if (o.kind === 'wall') {
    const src = o.pictures[2];
    let pic: Planned;
    if (src) {
      const t = trim(src);
      // A wall item hangs from its registration point, the wall point the player picks: the picture's middle.
      pic = { name: `leftwall ${o.name}_a_0`, ...t, regX: Math.floor(t.width / 2), regY: Math.floor(t.height / 2) };
    } else {
      blank = true;
      const w = 48, h = 64;
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.set([255, 255, 255, 0], i * 4);
      pic = { name: `leftwall ${o.name}_a_0`, rgba, width: w, height: h, regX: w / 2, regY: h / 2 };
    }
    bitmaps.push(pic);
    aliases.push(`rightwall ${o.name}_a_0=leftwall ${o.name}_a_0*`);
    fields.push({ name: `${o.name}.data`, text: '[\nstates:[1],\nlayers:[ \na:[ [ frames:[ 0 ] ] ]\n]\n]' });
    fields.push({ name: ASSET_INDEX, text: `[#id: "${o.name}", #classes: ["Item Object Class", "Item Object Extension Class"]]` });
  } else {
    const member = (d: number) => `${o.name}_a_0_${o.dims[0]}_${o.dims[1]}_${d}_0`;
    for (const d of own) {
      const src = o.pictures[d];
      if (src) {
        const t = trim(src);
        const box = opaqueBox(t.rgba, t.width, t.height) ?? { left: 0, right: t.width, bottom: t.height };
        bitmaps.push({ name: member(d), ...t, ...standOnTiles(box, o.dims, d) });
      } else {
        blank = true;
        bitmaps.push({ name: member(d), ...blankCanvas(o.dims, d) });
      }
    }
    for (const [to, from] of mirrored) aliases.push(`${member(to)}=${member(from)}*`);
    if (o.shadow) {
      const plan = shadowPlan(o.name, o.dims, [...own, ...mirrored.map((m) => m[0])]);
      for (const m of plan.members) {
        const s = shadowPicture(o.dims, m.direction);
        bitmaps.push({ name: m.name, rgba: s.rgba, width: s.width, height: s.height, regX: s.regX, regY: s.regY });
      }
      aliases.push(...plan.aliases);
    }
    fields.push({ name: ASSET_INDEX, text: `[#id: "${o.name}", #classes: ["Active Object Class",  "Active Object Extension Class"]]` });
  }
  if (aliases.length) fields.push({ name: ALIAS_INDEX, text: aliases.join('\n') });
  return { bitmaps, fields, blank };
}

/**
 * Build the new furni on `templateBytes` (any furni cast written by Director): the large cast with its icon, and the
 * small cast made from it.
 */
export function createFurni(templateBytes: Uint8Array, o: NewFurniOptions): { large: CastDocument; small: CastDocument; blank: boolean } {
  const plan = planNewFurni(o);
  const doc = new CastDocument(templateBytes);
  try {
    const members: { slot: number; type: string; bitmap?: { width: number } }[] = JSON.parse(doc.membersJson());
    const bitmapTpl = members.find((m) => m.type === 'bitmap' && (m.bitmap?.width ?? 0) > 1) ?? members.find((m) => m.type === 'bitmap');
    const fieldTpl = members.find((m) => m.type === 'field');
    if (!bitmapTpl || !fieldTpl) throw new Error('The template cast needs a bitmap and a field member');
    for (const m of members) if (m.slot !== bitmapTpl.slot && m.slot !== fieldTpl.slot) doc.delete(m.slot);
    plan.bitmaps.forEach((b, i) => {
      if (i === 0) {
        doc.setName(bitmapTpl.slot, b.name);
        doc.setBitmap(bitmapTpl.slot, b.rgba, b.width, b.height, b.regX, b.regY, 'rgba', 0);
      } else {
        doc.addBitmap(bitmapTpl.slot, b.name, b.rgba, b.width, b.height, b.regX, b.regY, 'rgba');
      }
    });
    plan.fields.forEach((f, i) => {
      if (i === 0) {
        doc.setName(fieldTpl.slot, f.name);
        doc.setText(fieldTpl.slot, f.text);
      } else {
        doc.addField(fieldTpl.slot, f.name, f.text);
      }
    });
    // The icon: the furni as the room draws it (a wall item: its picture), at the 32 px scale. An empty canvas gets
    // its icon later ("Make icon"), once something is painted.
    if (!plan.blank) {
      const icon = iconFor(doc, o, plan.bitmaps[0]);
      if (icon) doc.addBitmap(bitmapTpl.slot, `${o.name}_small`, icon.rgba, icon.width, icon.height, Math.floor(icon.width / 2), Math.floor(icon.height / 2), 'rgba');
    }
    const small = makeSmall(doc, o.name);
    return { large: doc, small, blank: plan.blank };
  } catch (e) {
    doc.free();
    throw e;
  }
}

function iconFor(doc: CastDocument, o: NewFurniOptions, first: Planned): Picture | null {
  if (o.kind === 'wall') {
    const half = halve({ kind: 'rgba', w: first.width, h: first.height, px: first.rgba }, []);
    return { rgba: half.px, width: half.w, height: half.h };
  }
  const direction = directionsFor(o.kind, o.turns).own[0];
  const img = renderIcon(doc, new Furni(doc), { direction, state: 0, colors: '' }, false);
  return img ? { rgba: img.rgba, width: img.width, height: img.height } : null;
}
