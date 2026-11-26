/**
 * A furni's shadow (`<class>_sd`, or `<class>_sd_<direction>`): the client draws it under everything at blend 20.
 * Sulake's are flat dark shapes on the furni's tiles, close to the tiles' own outline: bar_polyfon's is the 62 x 32
 * diamond, throne's 64 x 32, sofa_silo's 96 x 48 over its two tiles, chair_norja's a slightly smaller 51 x 29.
 *
 * "Make shadow" draws that: the rhombus of the furni's tiles, pulled in a few pixels. A furni whose tiles are square
 * gets one member for every direction (`<class>_sd`); another gets `_sd_0` (directions 0 and 4) and `_sd_2` (2 and 6),
 * with memberalias.index names for the directions it has. Paint can shape it further.
 */
import type { CastDocument } from '../../../vm-rust/pkg/vm_rust.js';
import { ALIAS_INDEX, isWallItem, ownDirections, parseMemberName, type Furni } from './furni';
import { tileBox } from './tiles';

export interface ShadowPicture {
  rgba: Uint8Array;
  width: number;
  height: number;
  regX: number;
  regY: number;
}

/** The tiles' rhombus, `inset` pixels smaller all round, black on transparent. */
export function shadowPicture(dims: [number, number], direction: number, tile = 64, inset = 3): ShadowPicture {
  const t = tileBox(dims, direction, tile);
  const width = t.right - t.left, height = t.bottom - t.top;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([255, 255, 255, 0], i * 4);
  const [back, right, front, left] = t.corners.map(([x, y]) => [x - t.left, y - t.top]);
  // Inside the rhombus = on the inner side of its four edges, each a line with slope 1/2 (or -1/2).
  const edges: [number[], number[]][] = [[left, back], [back, right], [right, front], [front, left]];
  const inside = (x: number, y: number) =>
    edges.every(([a, b]) => {
      const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      // distance to the edge in pixels: an edge is sqrt(5)/2 long per pixel of x
      return cross / Math.hypot(b[0] - a[0], b[1] - a[1]) >= inset;
    });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inside(x + 0.5, y + 0.5)) rgba.set([0, 0, 0, 255], (y * width + x) * 4);
    }
  }
  return { rgba, width, height, regX: -t.left, regY: -t.top };
}

/** The shadow members a furni should have: name, the direction its tiles are taken from, and alias lines. */
export function shadowPlan(cls: string, dims: [number, number], directions: number[]) {
  const square = dims[0] === dims[1];
  if (square) return { members: [{ name: `${cls}_sd`, direction: directions[0] ?? 2 }], aliases: [] as string[] };
  const members: { name: string; direction: number }[] = [];
  const aliases: string[] = [];
  for (const [own, twin] of [[0, 4], [2, 6]]) {
    const has = directions.filter((d) => d === own || d === twin);
    if (!has.length) continue;
    members.push({ name: `${cls}_sd_${own}`, direction: own });
    if (has.includes(twin)) aliases.push(`${cls}_sd_${twin}=${cls}_sd_${own}`);
  }
  return { members, aliases };
}

/** Make (or remake) the furni's shadow in `doc`. Returns what it did. */
export function makeShadow(doc: CastDocument, furni: Furni, inset = 3): string {
  if (isWallItem(furni)) throw new Error('A wall item has no shadow');
  const small = furni.isSmallCast();
  const cls = (small ? 's_' : '') + furni.className();
  const tile = small ? 32 : 64;
  const directions = ownDirections(furni, small);
  let dims: [number, number] | null = null;
  for (const n of furni.names.keys()) {
    const p = parseMemberName(n);
    if (p && p.cls === cls.toLowerCase() && p.letter === 'a') {
      dims = [p.width, p.length];
      break;
    }
  }
  if (!dims || !directions.length) throw new Error('The furni has no layer a to make a shadow for');
  const plan = shadowPlan(cls, dims, directions);
  // Old shadow members that aren't part of the new set go, after the new ones are made (one of them may be the
  // bitmap the new ones are copied from).
  const sdName = new RegExp(`^${cls.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_sd(_\\d)?$`);
  const keep = new Map<string, number>();
  const old: number[] = [];
  for (const m of furni.members) {
    if (m.type !== 'bitmap' || !sdName.test(m.name.toLowerCase())) continue;
    if (plan.members.some((p) => p.name.toLowerCase() === m.name.toLowerCase())) keep.set(m.name.toLowerCase(), m.slot);
    else old.push(m.slot);
  }
  const template = (furni.members.find((m) => m.type === 'bitmap' && !old.includes(m.slot)) ?? furni.members.find((m) => m.type === 'bitmap'))?.slot;
  if (!template) throw new Error('The cast has no bitmap to base the shadow on');
  for (const p of plan.members) {
    const pic = shadowPicture(dims, p.direction, tile, Math.round((inset * tile) / 64));
    const slot = keep.get(p.name.toLowerCase());
    if (slot) doc.setBitmap(slot, pic.rgba, pic.width, pic.height, pic.regX, pic.regY, 'rgba', 0);
    else doc.addBitmap(template, p.name, pic.rgba, pic.width, pic.height, pic.regX, pic.regY, 'rgba');
  }
  for (const slot of old) doc.delete(slot);
  const aliasSlot = furni.fieldSlot(ALIAS_INDEX);
  const lines = aliasSlot ? (doc.text(aliasSlot) ?? '').split(/\r?\n|\r/) : [];
  const kept = lines.filter((l) => l.trim() && !sdName.test(l.split('=')[0].trim().toLowerCase()));
  if (plan.aliases.length || kept.length !== lines.filter((l) => l.trim()).length) {
    const text = [...kept, ...plan.aliases].join('\n');
    if (aliasSlot) doc.setText(aliasSlot, text);
    else {
      const fieldTpl = furni.members.find((m) => m.type === 'field' || m.type === 'text')?.slot;
      if (!fieldTpl) throw new Error('The cast has no field to copy for memberalias.index');
      doc.addField(fieldTpl, ALIAS_INDEX, text);
    }
  }
  return `Made the shadow ${plan.members.map((m) => m.name).join(' and ')}${plan.aliases.length ? ` (+${plan.aliases.length} alias${plan.aliases.length > 1 ? 'es' : ''})` : ''}: the furni's tiles, ${inset} px in`;
}
