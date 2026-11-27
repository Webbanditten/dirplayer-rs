/**
 * A furni's `.props` (how each layer is drawn) and `.data` (what each layer shows in each state) as values to change,
 * for the Layers and States tabs. Both are read with lingo.ts and written back with its `propsText` / `dataText`, in
 * the layout Sulake's fields have; properties the tabs don't know (sequences, blend lists, locshift) are kept.
 *
 * `.props`: `["a": [#ink: 36, #blend: 80, #zshift: [30], #transparent: 1], ...]`. Ink 8 (matte) and blend 100 are the
 * client's defaults; `#zshift` has one value for every direction or eight (one per direction).
 * `.data`: `[states: [1, 2], statestrings: ["off", "on"], layers: [a: [[frames: [0]], [frames: [1, 2], delay: 4,
 * loop: 0]], ...]]`: per layer one entry per state. With a `.data` the client draws exactly the layers it lists, so
 * every layer is listed (animation.ts has the stepping rules: `loop: 0` forever, `loop: n` n times, none = once).
 */
import type { CastDocument } from '../../../vm-rust/pkg/vm_rust.js';
import { ALIAS_INDEX, isWallItem, parseMemberName, wallSetup, type Furni, type Layer } from './furni';
import { wallHeightFor } from './room';
import { canPlaceAnywhere, type Wall } from './wallplace';
import { dataText, lingoValue, numberList, prop, propsText, type LingoValue } from './lingo';

type PropList = Map<string, LingoValue>;

export const INKS: { ink: number; name: string; hint: string }[] = [
  { ink: 8, name: 'Normal', hint: 'Matte: the white around the picture is dropped (the default)' },
  { ink: 36, name: 'White see-through', hint: 'Background transparent: every white pixel is dropped, holes included' },
  { ink: 41, name: 'Tinted', hint: 'Coloured with its part colour: white becomes the colour, black stays (draw it in greys)' },
  { ink: 33, name: 'Light (add)', hint: 'Adds its colours to what is behind: glows and lamps (black adds nothing)' },
  { ink: 35, name: 'Shade (subtract)', hint: 'Subtracts its colours from what is behind: darkens' },
  { ink: 37, name: 'Lightest', hint: 'Keeps the lighter of the picture and what is behind' },
  { ink: 39, name: 'Darkest', hint: 'Keeps the darker of the picture and what is behind' },
  { ink: 0, name: 'Copy', hint: 'The whole rectangle, white included' },
];

/** The prefix of the open size's own members and fields: `<class>` or `s_<class>`. */
export const ownName = (furni: Furni) => (furni.isSmallCast() ? 's_' : '') + furni.className();

function fieldTemplate(furni: Furni): number {
  const t = furni.members.find((m) => m.type === 'field' || m.type === 'text');
  if (!t) throw new Error('The cast has no field member to copy');
  return t.slot;
}

function writeField(doc: CastDocument, furni: Furni, name: string, text: string) {
  const slot = furni.fieldSlot(name);
  if (slot) doc.setText(slot, text);
  else doc.addField(fieldTemplate(furni), name, text);
}

// ---------------------------------------------------------------- .props

export function readProps(furni: Furni): PropList {
  const v = lingoValue(furni.text(`${ownName(furni)}.props`) ?? '[:]');
  return v instanceof Map ? v : new Map();
}

export interface LayerProps {
  ink: number;
  blend: number;
  /** clicks go through (`#transparent: 1`) */
  clickThrough: boolean;
  /** `#zshift`: one value for every direction, or one per direction */
  zshift: number[];
}

export function layerProps(props: PropList, letter: string): LayerProps {
  const p = prop(props, letter);
  return {
    ink: Number(prop(p, 'ink') ?? 8),
    blend: Number(prop(p, 'blend') ?? 100),
    clickThrough: Number(prop(p, 'transparent') ?? 0) === 1,
    zshift: numberList(prop(p, 'zshift')) ?? [],
  };
}

/** The depth a layer has in a direction (the client takes the first value when the list is shorter). */
export const depthAt = (zshift: number[], direction: number) => (zshift.length ? zshift[zshift.length > direction ? direction : 0] : 0);

/** Change a layer's properties and write `.props`; values at their defaults are left out. */
export function setLayerProps(doc: CastDocument, furni: Furni, letter: string, change: Partial<LayerProps>) {
  const props = readProps(furni);
  const key = [...props.keys()].find((k) => k.toLowerCase() === letter) ?? letter;
  const old = props.get(key);
  const entry: PropList = old instanceof Map ? old : new Map();
  const put = (name: string, value: LingoValue, isDefault: boolean) => {
    const k = [...entry.keys()].find((x) => x.toLowerCase() === name) ?? name;
    if (isDefault) entry.delete(k);
    else entry.set(k, value);
  };
  if (change.ink !== undefined) put('ink', change.ink, change.ink === 8);
  if (change.blend !== undefined) put('blend', change.blend, change.blend >= 100);
  if (change.clickThrough !== undefined) put('transparent', 1, !change.clickThrough);
  if (change.zshift !== undefined) put('zshift', change.zshift, change.zshift.length === 0 || change.zshift.every((z) => z === 0));
  if (entry.size) props.set(key, entry);
  else props.delete(key);
  writeField(doc, furni, `${ownName(furni)}.props`, props.size ? propsText(props) : '[:]');
}

// ---------------------------------------------------------------- .data

export function readData(furni: Furni): PropList | null {
  const v = lingoValue((furni.text(`${ownName(furni)}.data`) ?? '').replace(/[\r\n]/g, ''));
  return v instanceof Map ? v : null;
}

export function stateCount(data: PropList | null): number {
  const states = data ? prop(data, 'states') : undefined;
  return Array.isArray(states) && states.length ? states.length : 1;
}

const frames0 = (): PropList => new Map<string, LingoValue>([['frames', [0]]]);

function layersOf(data: PropList): PropList {
  let layers = prop(data, 'layers');
  if (!(layers instanceof Map)) {
    layers = new Map();
    data.set('layers', layers);
  }
  return layers as PropList;
}

/** The `.data` to change: the furni's own, or a new one with one state that lists every layer in frame 0. Every
 *  layer in `letters` gets an entry per state (a layer added later has none yet). */
export function dataFor(furni: Furni, letters: string[]): PropList {
  const data = readData(furni) ?? new Map<string, LingoValue>([['states', [1]], ['layers', new Map<string, LingoValue>()]]);
  const layers = layersOf(data);
  const n = stateCount(data);
  for (const letter of letters) {
    const key = [...layers.keys()].find((k) => k.toLowerCase().includes(letter));
    const list = key ? layers.get(key) : undefined;
    if (!Array.isArray(list)) layers.set(key ?? letter, Array.from({ length: n }, frames0));
    else while (list.length < n) list.push(frames0());
  }
  return data;
}

export interface StateEntry {
  frames: number[];
  /** updates per frame (the client updates 24 times a second) */
  delay: number;
  /** null = play once and stay on the last frame, 0 = forever, n = n times */
  loop: number | null;
  random: boolean;
  /** it has `sequences` (several frame lists picked at random), which this editor shows but doesn't edit */
  sequences: boolean;
}

function entryOf(data: PropList, letter: string, state: number): PropList | null {
  const layers = layersOf(data);
  const key = [...layers.keys()].find((k) => k.toLowerCase().includes(letter));
  const list = key ? layers.get(key) : undefined;
  const e = Array.isArray(list) ? list[state < list.length ? state : 0] : undefined;
  return e instanceof Map ? e : null;
}

export function stateEntry(data: PropList | null, letter: string, state: number): StateEntry {
  const e = data ? entryOf(data, letter, state) : null;
  const seqs = e ? prop(e, 'sequences') : undefined;
  const frames = (e && numberList(prop(e, 'frames'))) ?? (Array.isArray(seqs) ? numberList(seqs[0]) : undefined) ?? [0];
  const loop = e ? prop(e, 'loop') : undefined;
  const delay = Number((e && prop(e, 'delay')) ?? 1);
  return { frames, delay: delay >= 1 ? Math.floor(delay) : 1, loop: loop === undefined ? null : Number(loop), random: !!e && prop(e, 'random') !== undefined, sequences: Array.isArray(seqs) };
}

function setKey(e: PropList, name: string, value: LingoValue | null) {
  const k = [...e.keys()].find((x) => x.toLowerCase() === name) ?? name;
  if (value === null) e.delete(k);
  else e.set(k, value);
}

/** Change what a layer shows in a state, and write `.data`. */
export function setStateEntry(doc: CastDocument, furni: Furni, letters: string[], letter: string, state: number, change: Partial<Omit<StateEntry, 'sequences'>>) {
  const data = dataFor(furni, letters);
  const e = entryOf(data, letter, state);
  if (!e) throw new Error(`Layer ${letter} has no entry for state ${state + 1}`);
  if (change.frames !== undefined) {
    setKey(e, 'frames', change.frames.length ? change.frames : [0]);
    setKey(e, 'sequences', null);
  }
  const frames = numberList(prop(e, 'frames')) ?? [0];
  if (change.delay !== undefined) setKey(e, 'delay', change.delay > 1 ? change.delay : null);
  if (change.loop !== undefined) setKey(e, 'loop', change.loop);
  if (change.random !== undefined) setKey(e, 'random', change.random ? 1 : null);
  // A still layer needs none of them.
  if (frames.length <= 1 && !prop(e, 'sequences')) for (const k of ['delay', 'loop', 'random']) setKey(e, k, null);
  writeField(doc, furni, `${ownName(furni)}.data`, dataText(data));
}

/** Add a state after the last one: a copy of state `from`'s entries. */
export function addState(doc: CastDocument, furni: Furni, letters: string[], from: number, name?: string) {
  const data = dataFor(furni, letters);
  const n = stateCount(data);
  data.set([...data.keys()].find((k) => k.toLowerCase() === 'states') ?? 'states', Array.from({ length: n + 1 }, (_, i) => i + 1));
  const clone = (v: LingoValue): LingoValue => (v instanceof Map ? new Map([...v].map(([k, x]) => [k, clone(x)])) : Array.isArray(v) ? v.map(clone) : v);
  for (const [key, list] of layersOf(data)) {
    if (!Array.isArray(list)) continue;
    while (list.length < n) list.push(frames0());
    list.push(clone(list[Math.min(from, list.length - 1)]));
    layersOf(data).set(key, list);
  }
  const names = prop(data, 'statestrings');
  if (Array.isArray(names) || name) {
    // the first extra state of a lamp: "off" and "on"
    const list = Array.isArray(names) ? names.map(String) : Array.from({ length: n }, (_, i) => (n === 1 && name === 'on' ? 'off' : `state ${i + 1}`));
    while (list.length < n) list.push(`state ${list.length + 1}`);
    list.push(name ?? `state ${n + 1}`);
    setKey(data, 'statestrings', list);
  }
  writeField(doc, furni, `${ownName(furni)}.data`, dataText(data));
}

export function removeState(doc: CastDocument, furni: Furni, letters: string[], state: number) {
  const data = dataFor(furni, letters);
  const n = stateCount(data);
  if (n <= 1) throw new Error('A furni has at least one state');
  setKey(data, 'states', Array.from({ length: n - 1 }, (_, i) => i + 1));
  for (const list of layersOf(data).values()) if (Array.isArray(list) && list.length > state) list.splice(state, 1);
  const names = prop(data, 'statestrings');
  if (Array.isArray(names) && names.length > state) names.splice(state, 1);
  writeField(doc, furni, `${ownName(furni)}.data`, dataText(data));
}

export function renameState(doc: CastDocument, furni: Furni, letters: string[], state: number, name: string) {
  const data = dataFor(furni, letters);
  const n = stateCount(data);
  const names = prop(data, 'statestrings');
  const list = Array.isArray(names) ? names.map(String) : [];
  while (list.length < n) list.push(`state ${list.length + 1}`);
  list[state] = name.replace(/["\r\n]/g, '').trim() || `state ${state + 1}`;
  setKey(data, 'statestrings', list);
  writeField(doc, furni, `${ownName(furni)}.data`, dataText(data));
}

// ---------------------------------------------------------------- whole layers

/** The frames a layer has pictures (or alias names) for in a direction, sorted. */
export function framesOf(furni: Furni, letter: string, direction: number): number[] {
  const cls = ownName(furni).toLowerCase();
  const out = new Set<number>();
  if (isWallItem(furni)) {
    const pre = furni.isSmallCast() ? 's_' : '';
    const re = new RegExp(`^${pre}(left|right)wall ${furni.className().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_${letter}_(\\d+)$`);
    for (const n of furni.names.keys()) {
      const m = re.exec(n);
      if (m && (m[1] === 'right') === (direction === 4)) out.add(+m[2]);
    }
    return [...out].sort((a, b) => a - b);
  }
  for (const n of furni.names.keys()) {
    const p = parseMemberName(n);
    if (p && p.cls === cls && p.letter === letter && p.direction === direction) out.add(p.frame);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Delete a layer: its pictures, its alias names and its entries in `.props` and `.data`. The layers after it move up
 * a letter (c becomes b...), because the client takes layers a, b, c... until one is missing.
 */
export function deleteLayer(doc: CastDocument, furni: Furni, letter: string, letters: string[]): string {
  if (isWallItem(furni)) throw new Error('Deleting a layer of a wall item isn\'t supported yet: delete its pictures and its line in .data');
  const cls = ownName(furni);
  const lower = cls.toLowerCase();
  const after = letters.filter((l) => l > letter).sort();
  const move = new Map(after.map((l) => [l, String.fromCharCode(l.charCodeAt(0) - 1)]));
  const rename = (name: string): string | null | undefined => {
    const p = parseMemberName(name.toLowerCase());
    if (!p || p.cls !== lower) return undefined;
    if (p.letter === letter) return null;
    const to = move.get(p.letter);
    return to ? `${cls}_${to}_0_${p.width}_${p.length}_${p.direction}_${p.frame}` : undefined;
  };
  let deleted = 0;
  // Members: delete the layer's, then move the later layers down in order (b before c), so no two share a name.
  for (const m of furni.members) if (m.type === 'bitmap' && rename(m.name) === null) (doc.delete(m.slot), deleted++);
  for (const l of after) {
    for (const m of furni.members) {
      const p = parseMemberName(m.name.toLowerCase());
      if (m.type === 'bitmap' && p && p.cls === lower && p.letter === l) doc.setName(m.slot, rename(m.name)!);
    }
  }
  const aliasSlot = furni.fieldSlot(ALIAS_INDEX);
  if (aliasSlot) {
    const lines: string[] = [];
    for (const line of (doc.text(aliasSlot) ?? '').split(/\r?\n|\r/)) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const name = line.slice(0, eq).trim();
      let target = line.slice(eq + 1).trim();
      const star = target.endsWith('*') ? '*' : '';
      if (star) target = target.slice(0, -1);
      const a = rename(name), b = rename(target);
      if (a === null || b === null) continue;
      lines.push(`${a ?? name}=${b ?? target}${star}`);
    }
    doc.setText(aliasSlot, lines.join('\n'));
  }
  const reletter = (map: PropList) => {
    const out: PropList = new Map();
    for (const [k, v] of map) {
      const key = k.toLowerCase();
      if (key === letter) continue;
      out.set(key.length === 1 ? move.get(key) ?? k : k, v);
    }
    return out;
  };
  const props = readProps(furni);
  if (props.size) writeField(doc, furni, `${cls}.props`, propsText(reletter(props)));
  const data = readData(furni);
  if (data) {
    data.set([...data.keys()].find((k) => k.toLowerCase() === 'layers') ?? 'layers', reletter(layersOf(data)));
    writeField(doc, furni, `${cls}.data`, dataText(data));
  }
  return `Deleted layer ${letter} (${deleted} picture${deleted === 1 ? '' : 's'})${after.length ? `; ${after.map((l) => `${l} is now ${move.get(l)}`).join(', ')}` : ''}`;
}

/** List a layer in `.data` (frame 0 in every state), when the furni has a `.data` or needs one (`always`: a wall item
 *  draws only the layers its `.data` lists). */
export function listLayer(doc: CastDocument, furni: Furni, letter: string, always: boolean) {
  if (!always && !readData(furni)) return false;
  writeField(doc, furni, `${ownName(furni)}.data`, dataText(dataFor(furni, [letter])));
  return true;
}

// ---------------------------------------------------------------- a wall item the hotel can hang

const WALL_MEMBER = /^(s_)?(left|right)wall (.+)_([a-z])_(\d+)$/i;

/** The picture the client tests while a wall item is carried: the first layer's, per wall the furni has pictures for. */
function hangPictures(furni: Furni): { wall: Wall; first: Layer }[] {
  const small = furni.isSmallCast();
  const out: { wall: Wall; first: Layer }[] = [];
  for (const d of [2, 4]) {
    const setup = wallSetup(furni, { direction: d, state: 0, small, shadow: false });
    const layers = setup?.direction === d ? setup.layersAt() : [];
    if (layers.length) out.push({ wall: d === 4 ? 'right' : 'left', first: layers.reduce((a, b) => (b.order < a.order ? b : a)) });
  }
  return out;
}

/** A wall item nobody can hang: its first picture has no spot on a guest room's wall (wallplace.ts). */
export function needsHangLayer(furni: Furni): boolean {
  if (!isWallItem(furni)) return false;
  const tile = furni.isSmallCast() ? 32 : 64;
  return hangPictures(furni).some((p) => !canPlaceAnywhere(tile, p.first, p.wall));
}

/**
 * Give a wall item a first layer the hotel can hang it by, the way Sulake's own tall wall items have one
 * (arabian_wall: layer a is 62 x 135 and fits the wall, the 69 x 181 picture you see is layer b).
 *
 * The client tests only the first layer's picture against the wall: all of its rectangle has to be inside one wall,
 * which takes 116 px of height plus half the picture's width (at 64 px). A taller first picture has no spot at all.
 * So the layers move up a letter (a becomes b, ...: their pictures, alias lines, `.props` and `.data` entries), and
 * the new layer a is an unseen picture as wide as the old first one and no higher than the wall, around the
 * registration point: where that fits, the item hangs, with the rest of it over the wall's edges as it may be.
 */
export function addHangLayer(doc: CastDocument, furni: Furni): string {
  if (!isWallItem(furni)) throw new Error('Only a wall item is hung on a wall');
  const small = furni.isSmallCast();
  const cls = furni.className(), lower = cls.toLowerCase(), pre = small ? 's_' : '';
  const tile = small ? 32 : 64;
  const parse = (name: string) => {
    const m = WALL_MEMBER.exec(name);
    return m && m[3].toLowerCase() === lower && !!m[1] === small ? { wall: m[2].toLowerCase(), letter: m[4].toLowerCase(), frame: m[5] } : null;
  };
  const pictures = hangPictures(furni);
  const letters = new Set<string>();
  for (const m of furni.members) {
    const p = m.type === 'bitmap' ? parse(m.name) : null;
    if (p) letters.add(p.letter);
  }
  if (!pictures.length || !letters.size) throw new Error(`The wall item has no layer pictures (leftwall ${cls}_a_0, with a ${cls}.data that lists its layers)`);
  if (letters.has('z')) throw new Error('The wall item already uses every layer letter');
  const up = (l: string) => String.fromCharCode(l.charCodeAt(0) + 1);
  const rename = (name: string) => {
    const p = parse(name.trim());
    return p ? `${pre}${p.wall}wall ${cls}_${up(p.letter)}_${p.frame}` : undefined;
  };
  // Pictures: the last letter first, so no two share a name on the way.
  for (const l of [...letters].sort().reverse()) {
    for (const m of furni.members) {
      const p = m.type === 'bitmap' ? parse(m.name) : null;
      if (p && p.letter === l) doc.setName(m.slot, rename(m.name)!);
    }
  }
  // The new first layer: unseen, as wide as the old first picture, no higher than a wall, around the hand.
  const most = Math.max(8, wallHeightFor(tile) - tile / 4);
  const aliases: string[] = [];
  const made: string[] = [];
  for (const p of pictures) {
    const name = `${pre}${p.wall}wall ${cls}_a_0`;
    if (p.first.flip) {
      // this wall shows the other wall's pictures mirrored
      aliases.push(`${name}=${pre}${p.wall === 'left' ? 'right' : 'left'}wall ${cls}_a_0*`);
      continue;
    }
    const w = p.first.width, h = Math.min(p.first.height, most);
    const top = Math.max(0, Math.min(p.first.regY - Math.round(h / 2), p.first.height - h));
    let regX = p.first.regX, regY = p.first.regY - top;
    // a registration point too far outside its picture: the unseen layer sits around the hand instead
    if (!canPlaceAnywhere(tile, { width: w, height: h, regX, regY }, p.wall)) [regX, regY] = [Math.floor(w / 2), Math.floor(h / 2)];
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([255, 255, 255, 0], i * 4);
    doc.addBitmap(p.first.slot, name, rgba, w, h, regX, regY, 'rgba');
    made.push(`${name} (${w} x ${h})`);
  }
  // Alias lines: both names move up, and the mirrored wall gets a line for the new layer.
  const aliasSlot = furni.fieldSlot(ALIAS_INDEX);
  const lines: string[] = [];
  for (const line of aliasSlot ? (doc.text(aliasSlot) ?? '').split(/\r?\n|\r/) : []) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const from = line.slice(0, eq).trim();
    let target = line.slice(eq + 1).trim();
    const star = target.endsWith('*') ? '*' : '';
    if (star) target = target.slice(0, -1);
    lines.push(`${rename(from) ?? from}=${rename(target) ?? target}${star}`);
  }
  if (aliases.length || lines.length) writeField(doc, furni, ALIAS_INDEX, [...aliases, ...lines].join('\n'));
  // .props and .data: every layer a letter up; the new a is behind them all and lets clicks through.
  const reletter = (map: PropList, first: LingoValue) => {
    const out: PropList = new Map([['a', first]]);
    for (const [k, v] of map) out.set(k.length === 1 && /[a-y]/i.test(k) ? up(k.toLowerCase()) : k, v);
    return out;
  };
  const props = readProps(furni);
  const oldA = prop(props, 'a');
  const mine: PropList = new Map<string, LingoValue>();
  const z = numberList(oldA instanceof Map ? prop(oldA, 'zshift') : undefined);
  if (z?.length) mine.set('zshift', z);
  mine.set('transparent', 1);
  writeField(doc, furni, `${pre}${cls}.props`, propsText(reletter(props, mine)));
  const data = readData(furni);
  if (data) {
    const key = [...data.keys()].find((k) => k.toLowerCase() === 'layers') ?? 'layers';
    data.set(key, reletter(layersOf(data), Array.from({ length: stateCount(data) }, () => frames0())));
    writeField(doc, furni, `${pre}${cls}.data`, dataText(data));
  }
  return `Added a first layer the hotel hangs it by: ${made.join(', ') || aliases.length + ' mirrored'}; the picture${letters.size > 1 ? 's' : ''} moved up a letter (a is now b${letters.size > 1 ? ', ...' : ''})`;
}

// ---------------------------------------------------------------- which wall a wall item keeps its pictures for

const WALL_SIDE = /^(s_)?(left|right)wall (.+)$/i;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The right wall pictures the left wall only shows mirrored (`leftwall x=rightwall x*`), with the left wall name each
 *  would have as a picture of its own. */
function rightWallOnly(furni: Furni): { slot: number; name: string; left: string }[] {
  const aliasSlot = furni.fieldSlot(ALIAS_INDEX);
  if (!aliasSlot) return [];
  const own = new Map(furni.members.filter((m) => m.type === 'bitmap').map((m) => [m.name.toLowerCase(), m]));
  const out: { slot: number; name: string; left: string }[] = [];
  for (const line of (furni.text(ALIAS_INDEX) ?? '').split(/\r?\n|\r/)) {
    const eq = line.indexOf('=');
    if (eq <= 0 || !line.trim().endsWith('*')) continue;
    const from = line.slice(0, eq).trim(), to = line.slice(eq + 1).trim().slice(0, -1);
    const a = WALL_SIDE.exec(from), b = WALL_SIDE.exec(to);
    if (!a || !b || a[2].toLowerCase() !== 'left' || b[2].toLowerCase() !== 'right' || !sameName(a[3], b[3])) continue;
    const m = own.get(to.toLowerCase());
    if (m && !own.has(from.toLowerCase()) && !out.some((o) => o.slot === m.slot)) out.push({ slot: m.slot, name: m.name, left: from });
  }
  return out;
}

/** A wall item that keeps its pictures for the right wall and shows them mirrored on the left one. */
export function needsLeftWallPictures(furni: Furni): boolean {
  return isWallItem(furni) && rightWallOnly(furni).length > 0;
}

/**
 * Keep a wall item's pictures for the left wall and mirror them for the right one, as every wall item of the hotel
 * does that isn't drawn for both (68 of 123; none keeps the right wall's only).
 *
 * The client counts on it while the item is carried: the mover copies the sprites of the item as it comes out of the
 * hand, which is its left wall look, and from then on only switches `flipH` when the wall changes (hh_room_utils
 * Object Mover Class). When the left wall look is itself a mirror image (the client makes that with rotation and skew
 * 180), the two add up: the item shows the right wall's picture over the left wall and the other way about, and only
 * looks right once it hangs.
 *
 * So each such picture is mirrored where it is stored (its registration point with it: width - x), takes the left
 * wall's name, and the alias lines turn round: `rightwall x=leftwall x*`. It looks the same on both walls as before.
 */
export function keepLeftWallPictures(doc: CastDocument, furni: Furni): string {
  const turn = rightWallOnly(furni);
  if (!turn.length) return 'Nothing to turn round: the left wall has its own pictures';
  const leftOf = new Map(turn.map((t) => [t.name.toLowerCase(), t.left]));
  for (const t of turn) {
    const b = furni.bySlot.get(t.slot)?.bitmap;
    if (!b) continue;
    const { width: w, height: h } = b;
    if (b.depth <= 8) {
      const px = doc.bitmapIndices(t.slot), out = new Uint8Array(px.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = px[y * w + (w - 1 - x)];
      doc.setBitmapIndexed(t.slot, out, w, h, w - b.regX, b.regY, 0);
    } else {
      const px = doc.rgba(t.slot), out = new Uint8Array(px.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(px.subarray((y * w + (w - 1 - x)) * 4, (y * w + (w - 1 - x)) * 4 + 4), (y * w + x) * 4);
      doc.setBitmap(t.slot, out, w, h, w - b.regX, b.regY, 'rgba', 0);
    }
    doc.setName(t.slot, t.left);
  }
  // Alias lines: what pointed at a turned picture points at its left wall name, mirrored the other way; the picture's
  // own old name becomes the mirrored one.
  const lines: string[] = turn.map((t) => `${t.name}=${t.left}*`);
  for (const line of (furni.text(ALIAS_INDEX) ?? '').split(/\r?\n|\r/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const from = line.slice(0, eq).trim();
    let to = line.slice(eq + 1).trim();
    const star = to.endsWith('*');
    if (star) to = to.slice(0, -1);
    const left = leftOf.get(to.toLowerCase());
    if (!left) lines.push(`${from}=${to}${star ? '*' : ''}`);
    else if (!sameName(from, left)) lines.push(`${from}=${left}${star ? '' : '*'}`);
  }
  writeField(doc, furni, ALIAS_INDEX, lines.join('\n'));
  return `The item keeps its pictures for the left wall now (${turn.length} mirrored where they are stored) and the right wall shows them mirrored, as the hotel's own wall items do`;
}
