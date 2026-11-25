/**
 * "Check furni": what would stop the furni from working in the hotel, or make it look wrong, before it is saved or
 * published. The name and content rules are Housekeeping's (OdinCMS FurniCastValidator, which refuses a cast that breaks
 * them); the drawing rules follow the client's furni classes as ported in furni.ts.
 */
import { ALIAS_INDEX, ASSET_INDEX, floorSetup, layerData, parseMemberName, wallSetup, type Furni } from './furni';
import { parseLingo, prop, type LingoValue } from './lingo';
import { gridModel } from './components/FurniGrid';
import type { SideKey } from './history';

export type Level = 'error' | 'warning' | 'info';
export type Fix = 'icon' | 'small' | 'rename';

export interface Issue {
  level: Level;
  side: SideKey;
  text: string;
  /** the member to select */
  slot?: number;
  /** what the editor can do about it */
  fix?: Fix;
}

const SPRITE = /^[a-z0-9_]{1,64}$/;
const SHARED = new Set(['memberalias.index', 'asset.index', 'copyright']);
/** The client's furni classes that asset.index may name (the same list as Housekeeping's). */
const FURNI_CLASSES = new Set(
  [
    'Active Object Class', 'Active Object Extension Class', 'Birdie Class', 'Credit Furni Class', 'Crossfade Furni Class',
    'E-Dice Class', 'FadeAnimation Furni Class', 'Fortune Class', 'Furniture Barrier Class', 'Furniture Bottle Class',
    'Furniture Club TV Class', 'Furniture Divider Class', 'Furniture Edicehc Class', 'Furniture Food Class',
    'Furniture Fridge Class', 'Furniture Hockeylight Class', 'Furniture Holo Class', 'Furniture IcecreamMachine Class',
    'Furniture Luxus TV Class', 'Furniture OneWayDoor Class', 'Furniture PartyBeamer Class', 'Furniture Present Class',
    'Furniture Red TV Class', 'Furniture Samovar Class', 'Furniture Scifidoor Class', 'Furniture Scifiport Class',
    'Furniture Scifirocket Class', 'Furniture Score Class', 'Furniture Sink Class', 'Furniture Solarium Class',
    'Furniture StudyDesk Class', 'Furniture Teleport Class', 'Furniture Toilet Class', 'Furniture TP Class',
    'Furniture Traffic Light Class', 'Furniture Waterbowl Class', 'Habbo Wheel Class', 'Item Object Class',
    'Item Object Extension Class', 'Move Blocker Class', 'Package Card Class', 'Passive Object Class', 'Pet Toy Class',
    'Plate Class', 'PostIt Item Class', 'Queue Class', 'Queue Public Class',
    'State Change Animated Active Object Extension Class', 'Trophy Class', 'Valentine Randomizer Class',
    'Watermatic Class', 'Furniture Roomdimmer Class', 'Furniture Sound Machine Class', 'Furniture Song Disk Class',
    'Furniture Jukebox Class', 'Window Class', 'Window ZShift Class',
  ].map((c) => c.toLowerCase()),
);
/** At most this many issues of one kind are listed one by one. */
const LIST = 6;

/** Whether a member name belongs to furni `sprite` (Housekeeping's OwnName). */
export function ownName(name: string, sprite: string): boolean {
  if (!name || SHARED.has(name.toLowerCase())) return true;
  const n = name.toLowerCase();
  for (const prefix of ['', 's_']) {
    const cls = prefix + sprite.toLowerCase();
    if (n === cls || n.startsWith(cls + '_') || n.startsWith(cls + '.')) return true;
    for (const wall of ['leftwall ', 'rightwall ']) {
      const w = prefix + wall + sprite.toLowerCase();
      if (n === w || n.startsWith(w + '_')) return true;
    }
  }
  return false;
}

function framesOf(entry: LingoValue): number[] {
  const out: number[] = [];
  const add = (v: LingoValue) => {
    if (Array.isArray(v)) for (const f of v) if (typeof f === 'number') out.push(f);
  };
  add(prop(entry, 'frames'));
  const seqs = prop(entry, 'sequences');
  if (Array.isArray(seqs)) for (const s of seqs) add(Array.isArray(s) ? s : prop(s, 'frames'));
  return out;
}

function checkSide(side: SideKey, furni: Furni, out: Issue[]) {
  const push = (level: Level, text: string, slot?: number, fix?: Fix) => out.push({ level, side, text, slot, fix });
  const cls = furni.className();
  const small = side === 'small';
  const own = (small ? 's_' : '') + cls;
  if (!cls) {
    push('error', 'No furni class: no layer pictures (<class>_a_0_...) and no asset.index');
    return;
  }
  if (!small && !SPRITE.test(cls)) push('error', `The class "${cls}" must be lower-case letters, digits and _ (at most 64), as the hotel takes it`);

  // Members: types, names.
  const seen = new Map<string, number>();
  const foreign: { slot: number; name: string }[] = [];
  for (const m of furni.members) {
    if (m.type === 'script') push('error', `${m.name || `Member ${m.slot}`} is a Lingo script: the hotel refuses casts with scripts`, m.slot);
    else if (m.type === 'text') push('error', `${m.name || `Member ${m.slot}`} is a text member: the hotel takes fields only (make it a field)`, m.slot);
    else if (!['bitmap', 'field', 'palette'].includes(m.type)) push('error', `${m.name || `Member ${m.slot}`} is a ${m.type} member: a furni cast has bitmaps, fields and palettes only`, m.slot);
    if (m.type === 'palette') continue;
    if (!m.name) {
      push('info', `Member ${m.slot} (${m.type}) has no name: nothing uses it`, m.slot);
      continue;
    }
    const key = m.name.toLowerCase();
    if (seen.has(key)) push('error', `Two members are named ${m.name} (${seen.get(key)} and ${m.slot}): the client only ever finds the first`, m.slot);
    else seen.set(key, m.slot);
    if (!ownName(m.name, cls)) foreign.push({ slot: m.slot, name: m.name });
  }
  if (foreign.length) {
    const list = foreign.slice(0, LIST).map((f) => f.name).join(', ') + (foreign.length > LIST ? ` and ${foreign.length - LIST} more` : '');
    push('error', `${foreign.length} member${foreign.length > 1 ? 's are' : ' is'} not named after ${cls}: ${list}. Housekeeping only takes the furni's own members ("New from this…" renames them)`, foreign[0].slot, 'rename');
  }

  // Fields read as Lingo values.
  for (const m of furni.members) {
    if (m.type !== 'field' && m.type !== 'text') continue;
    const n = m.name.toLowerCase();
    if (!(n.endsWith('.props') || n.endsWith('.data') || n === ASSET_INDEX)) continue;
    const text = furni.doc.text(m.slot) ?? '';
    if (!text.trim()) continue;
    try {
      parseLingo(text);
    } catch (e) {
      push('error', `${m.name} doesn't read as a Lingo value (${(e as Error).message}): the client ignores it`, m.slot);
    }
  }

  // asset.index
  const assetSlot = furni.fieldSlot(ASSET_INDEX);
  if (assetSlot) {
    let asset: LingoValue;
    try {
      asset = parseLingo(furni.doc.text(assetSlot) ?? '');
    } catch {
      asset = undefined;
    }
    const id = prop(asset, 'id');
    if (typeof id === 'string' && id !== cls && id !== 's_' + cls) push('error', `asset.index names "${id}", not ${cls}`, assetSlot);
    const classes = prop(asset, 'classes');
    if (Array.isArray(classes)) {
      for (const c of classes) if (!FURNI_CLASSES.has(String(c).toLowerCase())) push('error', `asset.index names the class "${c}", which isn't one of the client's furni classes`, assetSlot);
    }
  } else if (!small) {
    push('info', 'No asset.index: the client treats it as plain furni (Active Object Class), without a class of its own');
  }

  // memberalias.index: every line names a member that is there, and only the furni's own.
  const aliasSlot = furni.fieldSlot(ALIAS_INDEX);
  if (aliasSlot) {
    const missing: string[] = [];
    const notOwn: string[] = [];
    const exists = new Set(furni.members.map((m) => m.name.toLowerCase()));
    for (const raw of (furni.doc.text(aliasSlot) ?? '').split(/\r\n?|\n/)) {
      const line = raw.trim();
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const from = line.slice(0, eq).trim();
      const to = line.slice(eq + 1).trim().replace(/\*$/, '');
      if (!exists.has(to.toLowerCase())) missing.push(`${from} → ${to}`);
      if (!ownName(from, cls) || !ownName(to, cls)) notOwn.push(line);
    }
    if (missing.length) push('warning', `memberalias.index points at ${missing.length} member${missing.length > 1 ? 's' : ''} the cast doesn't have (the client skips those lines): ${missing.slice(0, LIST).join(', ')}${missing.length > LIST ? '…' : ''}`, aliasSlot);
    if (notOwn.length) push('error', `memberalias.index names another furni's members: ${notOwn.slice(0, 3).join(', ')}${notOwn.length > 3 ? '…' : ''}`, aliasSlot);
  }

  // Bitmaps whose palette member isn't a palette draw in the wrong colours.
  for (const m of furni.members) {
    const b = m.bitmap;
    if (!b || b.depth > 8 || b.paletteId <= 0 || b.clutCastLib > 0) continue;
    const pal = furni.bySlot.get(b.paletteId);
    if (pal?.type !== 'palette') push('warning', `${m.name} uses palette member ${b.paletteId}, which ${pal ? `is a ${pal.type}` : "isn't there"}: it may draw in the wrong colours`, m.slot);
  }

  // Layers, directions, frames.
  const wall = furni.members.some((m) => /^(s_)?(left|right)wall /i.test(m.name));
  const g = gridModel(furni, small);
  if (wall) {
    if (!g.rows.length) return;
  } else if (!g.rows.length) {
    push('error', `No layer pictures: the client draws ${own}_<layer>_0_<length>_<width>_<direction>_<frame>`);
    return;
  }
  const dims = new Set<string>();
  for (const m of furni.members) {
    const p = parseMemberName(m.name);
    if (p && p.cls.toLowerCase() === own.toLowerCase()) dims.add(`${p.width}×${p.length}`);
  }
  if (dims.size > 1) push('warning', `The layer pictures have different sizes in their names (${[...dims].join(', ')}): the client uses the first it finds`);
  if (!g.rows.some((r) => r.letter === 'a')) push('error', `No layer a: the client starts from ${own}_a_… and draws nothing without it`);

  const dirs = [...new Set(g.rows.flatMap((r) => [...r.dirs.keys()]))].sort((a, b) => a - b);
  const odd = dirs.filter((d) => d % 2);
  if (odd.length) push('warning', `Direction${odd.length > 1 ? 's' : ''} ${odd.join(', ')}: the client turns furni to 0, 2, 4 and 6 only`);

  // Layers the client never draws, in any direction or state.
  const data = (() => {
    try {
      return parseLingo((furni.text(own + '.data') ?? '').replace(/[\r\n]/g, '')) ?? undefined;
    } catch {
      return undefined;
    }
  })();
  const stateCount = Math.max(1, (() => {
    const s = prop(data, 'states');
    return Array.isArray(s) ? s.length : 1;
  })());
  const drawn = new Set<string>();
  for (const d of dirs) for (let s = 0; s < stateCount; s++) (wall ? wallSetup : floorSetup)(furni, { direction: d, state: s, small, shadow: false })?.letters.forEach((l) => drawn.add(l));
  for (const r of g.rows) {
    if (!drawn.has(r.letter)) {
      const first = [...r.dirs.values()][0]?.values().next().value;
      push('warning', wall
        ? `Layer ${r.letter} is never drawn: a wall item draws only the layers its ${own}.data lists`
        : `Layer ${r.letter} is never drawn: the client stops at the first missing layer letter, and .data doesn't list it`, first?.slot);
    }
  }

  // A layer missing a direction the furni has; frame gaps.
  const aDirs = [...(g.rows.find((r) => r.letter === 'a')?.dirs.keys() ?? [])];
  for (const r of g.rows) {
    const lacks = aDirs.filter((d) => !r.dirs.has(d));
    if (r.letter !== 'a' && lacks.length && lacks.length < aDirs.length) {
      const first = [...r.dirs.values()][0]?.values().next().value;
      push('warning', wall
        ? `Layer ${r.letter} has no picture for the ${lacks.map((d) => (d === 4 ? 'right' : 'left')).join(' and ')} wall (layer a has): it's missing there`
        : `Layer ${r.letter} has no picture for direction ${lacks.join(', ')} (layer a has): ${r.dirs.has(0) ? 'the client shows its direction 0 picture there' : "it's missing there"}`, first?.slot);
    }
    for (const [d, frames] of r.dirs) {
      const nums = [...frames.keys()].sort((a, b) => a - b);
      const gaps = nums.length ? Array.from({ length: nums[nums.length - 1] + 1 }, (_, i) => i).filter((i) => !frames.has(i)) : [];
      if (gaps.length) push('info', `Layer ${r.letter}, direction ${d}: no frame ${gaps.slice(0, LIST).join(', ')}${gaps.length > LIST ? '…' : ''} between ${nums[0]} and ${nums[nums.length - 1]}`, frames.get(nums[0])?.slot);
    }
  }

  // Frames .data asks for that a direction doesn't have.
  const wanted: string[] = [];
  for (const r of g.rows) {
    const states = layerData(data, r.letter);
    if (!Array.isArray(states)) continue;
    const frames = [...new Set(states.flatMap((e) => framesOf(e)))];
    for (const [d, have] of r.dirs) for (const f of frames) if (!have.has(f)) wanted.push(`${r.letter} ${d}/${f}`);
  }
  if (wanted.length) push('warning', `.data shows ${wanted.length} frame${wanted.length > 1 ? 's' : ''} that ${wanted.length > 1 ? "aren't" : "isn't"} there (layer direction/frame): ${wanted.slice(0, LIST).join(', ')}${wanted.length > LIST ? '…' : ''}`, furni.fieldSlot(own + '.data'));

  // Icon and shadow.
  const base = cls.toLowerCase();
  if (!furni.members.some((m) => m.type === 'bitmap' && m.name.toLowerCase() === base + '_small')) {
    push('warning', `No icon (${cls}_small): the hand, trades and the catalogue show a blank square`, undefined, 'icon');
  }
  if (!wall && !furni.members.some((m) => m.name.toLowerCase().startsWith(own.toLowerCase() + '_sd')) && ![...furni.names.keys()].some((n) => n.startsWith(own.toLowerCase() + '_sd'))) {
    push('info', `No shadow (${own}_sd_…): the furni stands without one`);
  }
}

/** Compare the two sizes: every large picture should have its 32 px one. */
function checkPair(large: Furni, small: Furni, out: Issue[]) {
  const a = gridModel(large, false), b = gridModel(small, true);
  const missing: string[] = [];
  for (const r of a.rows) {
    const other = b.rows.find((x) => x.letter === r.letter);
    for (const [d, frames] of r.dirs) for (const f of frames.keys()) if (!other?.dirs.get(d)?.has(f)) missing.push(`${r.letter} ${d}/${f}`);
  }
  if (missing.length) {
    out.push({ level: 'warning', side: 'small', text: `The 32 px cast lacks ${missing.length} of the large pictures (layer direction/frame): ${missing.slice(0, LIST).join(', ')}${missing.length > LIST ? '…' : ''}. In small rooms those show the direction 0 picture or nothing` });
  }
  if (a.cls && b.cls && a.cls.toLowerCase() !== b.cls.replace(/^s_/, '').toLowerCase()) {
    out.push({ level: 'error', side: 'small', text: `The two casts are different furni: ${a.cls} and ${b.cls}` });
  }
}

const ORDER: Record<Level, number> = { error: 0, warning: 1, info: 2 };

export function checkFurni(sides: Partial<Record<SideKey, Furni>>): Issue[] {
  const out: Issue[] = [];
  if (sides.large) checkSide('large', sides.large, out);
  if (sides.small) checkSide('small', sides.small, out);
  if (sides.large && sides.small) checkPair(sides.large, sides.small, out);
  else if (sides.large && !sides.large.members.some((m) => /^(left|right)wall /i.test(m.name))) {
    const cls = sides.large.className();
    if (cls && !sides.large.members.some((m) => parseMemberName(m.name)?.cls.toLowerCase() === 's_' + cls.toLowerCase())) {
      out.push({ level: 'warning', side: 'large', text: `No 32 px cast open: small rooms (models i–r) draw the furni from hh_furni_xx_s_${cls}.cct`, fix: 'small' });
    }
  }
  return out.sort((x, y) => ORDER[x.level] - ORDER[y.level]);
}
