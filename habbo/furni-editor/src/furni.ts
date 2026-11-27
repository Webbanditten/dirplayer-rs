/**
 * A Habbo furni cast as the client sees it, on top of the Rust `CastDocument`.
 *
 * The rules are the client's (hh_furni_classes: Active Object Class, Active Object Extension Class), as ported in
 * habbo-vibe-playground's furni renderer (tools/furni-renderer/render.mts, live on prod for the CMS's furni pictures):
 *
 * - Layers a, b, c, ... are bitmaps named `<class>_<layer>_0_<width>_<length>_<direction>_<frame>`, taken until one is
 *   missing. A missing direction falls back to direction 0's member; `memberalias.index` lines `name=target` add names,
 *   `*` = mirrored (the client turns the sprite and moves it one tile, 64 px, right).
 * - `<class>.props`: per layer ink (default 8), blend (100), zshift per direction, locshift per direction.
 * - `<class>.data`: states, and per layer and state the frame list (`frames`, `sequences`, `delay`, `loop`, `random`,
 *   `blend`). With data, sprite slot i shows the i-th data layer (keys sorted, "ab" counts for a and b).
 * - Layer i is tinted with part colour i (items_definitions.colour: "#RRGGBB" or a palette index): the bgColor.
 * - The shadow `<class>_sd[_<direction>]` sits below everything at blend 20.
 * - 1x1 members are "nothing in this frame" placeholders.
 *
 * Wall items ("Item Object Extension Class", the hotel's arabian_swords, exe_map, hc_wall_lamp...): `leftwall <class>`
 * or, with `<class>.data` layers, `leftwall <class>_<layer>_<frame>` (`rightwall` for the right wall, `s_leftwall` in
 * the 32 px cast). Direction 2 is the left wall, 4 the right one; the registration point is the wall point the item
 * hangs from; a mirrored alias turns the sprite around that point (rotation and skew 180) without moving it.
 */
import type { CastDocument } from '../../../vm-rust/pkg/vm_rust.js';
import { lingoValue, numberList, prop, type LingoValue } from './lingo';

export interface BitmapHeader {
  width: number;
  height: number;
  regX: number;
  regY: number;
  depth: number;
  paletteId: number;
  clutCastLib: number;
  useAlpha: boolean;
}

export interface Member {
  slot: number;
  type: string;
  name: string;
  bitmap?: BitmapHeader;
  media: string[];
}

export interface NameEntry {
  slot: number;
  flip: boolean;
  /** the alias line's target, when the name comes from memberalias.index */
  aliasOf?: string;
}

export interface Layer {
  name: string;
  letter: string;
  slot: number;
  flip: boolean;
  ink: number;
  blend: number;
  /** 0xRRGGBB part colour, when the layer is tinted */
  bgColor?: number;
  z: number;
  order: number;
  shiftX: number;
  shiftY: number;
  xFactor: number;
  width: number;
  height: number;
  regX: number;
  regY: number;
}

export interface FrameChoice {
  (letter: string): { frame: number; blend?: number } | undefined;
}

export interface FloorOptions {
  direction: number;
  /** 0-based index into the .data states */
  state: number;
  colors?: string;
  shadow?: boolean;
  small?: boolean;
}

export interface FloorSetup {
  cls: string;
  props: LingoValue;
  data: LingoValue;
  /** the direction actually shown (a wanted direction without layer a moves on) */
  direction: number;
  /** footprint from the member names */
  dims: [number, number];
  letters: string[];
  layersAt: (choice?: FrameChoice) => Layer[];
}

export const ALIAS_INDEX = 'memberalias.index';
export const ASSET_INDEX = 'asset.index';

const MEMBER_RE = /^(.+)_([a-z])_0_(\d+)_(\d+)_(\d+)_(\d+)$/;

/** Parse a layer member name: class, layer, width, length, direction, frame. */
export function parseMemberName(name: string) {
  const m = MEMBER_RE.exec(name);
  if (!m) return null;
  return { cls: m[1], letter: m[2], width: +m[3], length: +m[4], direction: +m[5], frame: +m[6] };
}

export class Furni {
  members: Member[] = [];
  bySlot = new Map<number, Member>();
  names = new Map<string, NameEntry>();
  private palettes = new Map<number, number[]>();
  private cached: { cls?: string; small?: boolean } = {};

  constructor(readonly doc: CastDocument) {
    this.reload();
  }

  /** Re-read the members after the document changed. */
  reload() {
    this.members = JSON.parse(this.doc.membersJson());
    this.bySlot = new Map(this.members.map((m) => [m.slot, m]));
    this.palettes.clear();
    this.cached = {};
    const names = new Map<string, NameEntry>();
    for (const m of this.members) if (m.name) names.set(m.name.toLowerCase(), { slot: m.slot, flip: false });
    // The Resource Manager: memberalias.index line by line; a line copies its target's current entry (mirrored with
    // *), later lines overwrite earlier ones, a target that is itself mirrored is skipped.
    for (const line of (this.textOf(names, ALIAS_INDEX) ?? '').split(/[\r\n]+/)) {
      const eq = line.indexOf('=');
      if (eq <= 0 || line.length <= 2) continue;
      let target = line.slice(eq + 1).trim();
      const flip = target.endsWith('*');
      if (flip) target = target.slice(0, -1);
      const entry = names.get(target.toLowerCase());
      if (!entry || entry.flip) continue;
      names.set(line.slice(0, eq).trim().toLowerCase(), { slot: entry.slot, flip, aliasOf: target });
    }
    this.names = names;
  }

  private textOf(names: Map<string, NameEntry>, name: string): string | undefined {
    const e = names.get(name.toLowerCase());
    if (!e) return undefined;
    const m = this.bySlot.get(e.slot);
    if (!m || (m.type !== 'field' && m.type !== 'text')) return undefined;
    return this.doc.text(e.slot) ?? undefined;
  }

  text(name: string): string | undefined {
    return this.textOf(this.names, name);
  }

  fieldSlot(name: string): number | undefined {
    const e = this.names.get(name.toLowerCase());
    const m = e && this.bySlot.get(e.slot);
    return m && (m.type === 'field' || m.type === 'text') && !e!.aliasOf ? m.slot : undefined;
  }

  /** A bitmap by name: a member or an alias (mirrored = the client's negative member number). */
  bitmap(name: string): (NameEntry & { member: Member }) | undefined {
    const e = this.names.get(name.toLowerCase());
    const m = e && this.bySlot.get(e.slot);
    return m && m.type === 'bitmap' && m.bitmap ? { ...e!, member: m } : undefined;
  }

  /** A small (32 px) cast of its own, hh_furni_xx_s_<class>.cct: s_<class> layer members and no <class> ones (casts
   *  borrow single members of other furni, so only the furni's own class counts). */
  isSmallCast(): boolean {
    return (this.cached.small ??= this.findSmall());
  }

  private findSmall(): boolean {
    const cls = this.className().toLowerCase();
    if (!cls) return false;
    let small = false;
    for (const m of this.members) {
      const p = parseMemberName(m.name);
      if (!p) continue;
      const c = p.cls.toLowerCase();
      if (c === cls) return false;
      if (c === 's_' + cls) small = true;
    }
    return small || this.members.some((m) => m.name.toLowerCase() === `s_${cls}.props`);
  }

  /** The furni's class: asset.index's #id, else the commonest class of the layer members, both sizes counted together
   *  without s_ (a small cast of chair_norja has the class chair_norja). */
  className(): string {
    return (this.cached.cls ??= this.findClass());
  }

  private findClass(): string {
    // A cast can hold both sizes, each with its own asset.index (doorD: "doorD" and "s_doorD"); the class is the 64 px one.
    const asset = lingoValue(this.text(ASSET_INDEX) ?? '');
    const id = prop(asset, 'id');
    if (typeof id === 'string' && id) return id.replace(/^s_/, '');
    const count = new Map<string, number>();
    for (const m of this.members) {
      const p = parseMemberName(m.name);
      if (p) count.set(p.cls.replace(/^s_/, ''), (count.get(p.cls.replace(/^s_/, '')) ?? 0) + 1);
    }
    const best = [...count].sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0];
    const props = this.members.find((m) => m.name.endsWith('.props'));
    if (props) return props.name.slice(0, -6).replace(/^s_/, '');
    // Wall items and posters: the picture is <class> itself, the icon <class>_small.
    const icon = this.members.find((m) => m.type === 'bitmap' && /_small$/i.test(m.name));
    return icon ? icon.name.slice(0, -6).replace(/^s_/, '') : '';
  }

  classes(): string[] {
    const v = prop(lingoValue(this.text(ASSET_INDEX) ?? ''), 'classes');
    return Array.isArray(v) ? v.map(String) : [];
  }

  /** Colours of a palette member as 0xRRGGBB. */
  paletteColors(slot: number): number[] | undefined {
    if (slot <= 0) return undefined;
    let c = this.palettes.get(slot);
    if (!c) {
      const raw = this.doc.paletteColors(slot);
      c = [];
      for (let i = 0; i + 2 < raw.length; i += 3) c.push((raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2]);
      this.palettes.set(slot, c);
    }
    return c.length ? c : undefined;
  }
}

/** Part colour -> 0xRRGGBB: "#RRGGBB", or an index into the member's palette ("0" = white). */
export function partColor(spec: string | undefined, palette: number[] | undefined): number | undefined {
  if (spec === undefined) return undefined;
  const s = spec.trim();
  if (s.startsWith('#')) {
    const v = parseInt(s.slice(1), 16);
    return Number.isNaN(v) ? 0xffffff : v & 0xffffff;
  }
  const n = /^\d+$/.test(s) ? Number(s) : 0;
  return palette ? palette[n & 255] : n === 0 ? 0xffffff : 0;
}

export function parseColors(colors: string | undefined): string[] {
  const list = (colors && colors.trim() ? colors : '0,0,0').split(',').map((c) => c.trim());
  while (list.length <= 4) list.push('*ffffff');
  return list;
}

export function layerData(data: LingoValue, letter: string): LingoValue {
  const layers = prop(data, 'layers');
  if (!(layers instanceof Map)) return undefined;
  for (const [key, value] of layers) if (key.toLowerCase().includes(letter)) return value;
  return undefined;
}

/** The first frame layer `letter` shows in state `state` (0 without .data). */
export function frameFor(data: LingoValue, letter: string, state: number): number {
  const states = layerData(data, letter);
  if (!Array.isArray(states) || states.length === 0) return 0;
  const entry = states[state < states.length ? state : 0];
  const seqs = prop(entry, 'sequences');
  const frames = prop(entry, 'frames') ?? (Array.isArray(seqs) ? seqs[0] : undefined);
  if (Array.isArray(frames) && typeof frames[0] === 'number') return Math.max(0, frames[0]);
  return 0;
}

/** The state names from .data (statestrings, else the state numbers). */
export function stateNames(data: LingoValue): string[] {
  const strings = prop(data, 'statestrings');
  const states = prop(data, 'states');
  if (Array.isArray(strings) && strings.length) return strings.map(String);
  if (Array.isArray(states) && states.length) return states.map((s) => `state ${s}`);
  return ['default'];
}

export function floorSetup(furni: Furni, options: FloorOptions): FloorSetup | null {
  const small = options.small ?? furni.isSmallCast();
  const cls = (small ? 's_' : '') + furni.className();
  const xFactor = small ? 32 : 64;
  const props = lingoValue(furni.text(cls + '.props') ?? '[:]');
  const data = lingoValue((furni.text(cls + '.data') ?? '').replace(/[\r\n]/g, ''));
  const state = options.state;
  const prefix = (cls + '_a_0_').toLowerCase();
  let dims: [number, number] = [1, 1];
  for (const n of furni.names.keys()) {
    const m = n.startsWith(prefix) ? /^(\d+)_(\d+)_\d+_\d+$/.exec(n.slice(prefix.length)) : null;
    if (m) {
      dims = [+m[1], +m[2]];
      break;
    }
  }
  const base = (letter: string) => `${cls}_${letter}_0_${dims[0]}_${dims[1]}`;
  const memberFor = (letter: string, dir: number, frame = frameFor(data, letter, state)) =>
    furni.bitmap(`${base(letter)}_${dir}_${frame}`) ?? furni.bitmap(`${base(letter)}_0_${frame}`);

  let direction = -1;
  for (const frame0 of [true, false]) {
    for (let k = 0; k < 8 && direction < 0; k++) {
      const d = (options.direction + k) % 8;
      if (frame0 ? memberFor('a', d, 0) : memberFor('a', d)) direction = d;
    }
    if (direction >= 0) break;
  }
  if (direction < 0) return null;
  const baseLetters: string[] = [];
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(97 + i);
    if (!memberFor(letter, direction, 0) && !(i === 0 && memberFor(letter, direction))) break;
    baseLetters.push(letter);
  }
  const dataLayers = prop(data, 'layers');
  const dataKeys = dataLayers instanceof Map ? [...new Set([...dataLayers.keys()].flatMap((k) => k.toLowerCase().split('')))].sort() : [];
  const slots: { letter: string; base: string; data: boolean }[] = [];
  for (let i = 0; i < Math.max(baseLetters.length, dataKeys.length); i++) {
    if (i < dataKeys.length) slots.push({ letter: dataKeys[i], base: baseLetters[i] ?? dataKeys[i], data: true });
    else slots.push({ letter: baseLetters[i], base: baseLetters[i], data: false });
  }
  const colors = parseColors(options.colors);

  const layersAt = (choice?: FrameChoice): Layer[] => {
    const layers: Layer[] = [];
    slots.forEach((slot, i) => {
      const letter = slot.letter;
      const chosen = slot.data ? choice?.(letter) : undefined;
      const found = chosen ? memberFor(letter, direction, chosen.frame) : slot.data ? memberFor(letter, direction) : memberFor(letter, direction, 0);
      const b = found?.member.bitmap;
      if (!found || !b || (b.width <= 1 && b.height <= 1)) return;
      const lp = prop(props, letter);
      const bp = prop(props, slot.base);
      const zshift = numberList(prop(bp, 'zshift'));
      const z = (zshift ? zshift[zshift.length > direction ? direction : 0] : 0) - 5 + i;
      const shift = prop(bp, 'locshift');
      const shiftValue = Array.isArray(shift) ? shift[direction] : undefined;
      const point = typeof shiftValue === 'string' ? lingoValue(shiftValue) : shiftValue;
      const [sx, sy] = point && typeof point === 'object' && 'point' in point ? point.point : [0, 0];
      layers.push({
        name: found.member.name,
        letter,
        slot: found.slot,
        flip: found.flip,
        ink: Number(prop(lp, 'ink') ?? 8),
        blend: chosen?.blend ?? Number(prop(lp, 'blend') ?? 100),
        bgColor: partColor(colors[i], furni.paletteColors(b.paletteId)),
        z,
        order: i,
        shiftX: sx,
        shiftY: sy,
        xFactor,
        width: b.width,
        height: b.height,
        regX: b.regX,
        regY: b.regY,
      });
    });
    if (options.shadow) {
      const sd = furni.bitmap(`${cls}_sd_${direction}`) ?? furni.bitmap(`${cls}_sd`);
      const b = sd?.member.bitmap;
      if (sd && b && !(b.width <= 1 && b.height <= 1)) {
        const lp = prop(props, 'sd');
        let blend = Number(prop(lp, 'blend') ?? 100);
        if (blend === 100) blend = 20;
        layers.push({
          name: sd.member.name, letter: 'sd', slot: sd.slot, flip: sd.flip, ink: Number(prop(lp, 'ink') ?? 8), blend,
          z: -4000, order: -1, shiftX: 0, shiftY: 0, xFactor, width: b.width, height: b.height, regX: b.regX, regY: b.regY,
        });
      }
    }
    return layers.sort((a, b) => a.z - b.z || a.order - b.order);
  };
  return { cls, props, data, direction, dims, letters: slots.map((s) => s.letter), layersAt };
}

const WALL_RE = /^(?:s_)?(left|right)wall (.+?)(?:_[a-z]_\d+)?$/;
const wallOf = (direction: number) => (direction === 4 ? 'rightwall' : 'leftwall');

/** A wall item: asset.index names an Item Object class, or the furni has leftwall / rightwall members of its own. */
export function isWallItem(furni: Furni): boolean {
  if (furni.classes().some((c) => /^item object/i.test(c))) return true;
  const cls = furni.className().toLowerCase();
  if (!cls) return false;
  for (const n of furni.names.keys()) if (WALL_RE.exec(n)?.[2] === cls) return true;
  return false;
}

/** A wall item's layers on the wanted wall (direction 4 = right wall, anything else the left one; a wall it has no
 *  members for falls back to the other), in the same shape as floorSetup's so the room draws both alike. */
export function wallSetup(furni: Furni, options: FloorOptions): FloorSetup | null {
  const small = options.small ?? furni.isSmallCast();
  const cls = furni.className();
  if (!cls) return null;
  const pre = small ? 's_' : '';
  const base = pre + cls;
  const props = lingoValue(furni.text(base + '.props') ?? '[:]');
  const data = lingoValue((furni.text(base + '.data') ?? '').replace(/[\r\n]/g, ''));
  const layerList = prop(data, 'layers');
  const hasLayers = layerList instanceof Map && layerList.size > 0;
  const letters = hasLayers ? [...(layerList as Map<string, LingoValue>).keys()] : ['a'];
  const memberFor = (wall: string, letter: string, frame?: number) =>
    furni.bitmap(hasLayers ? `${pre}${wall} ${cls}_${letter}_${frame ?? frameFor(data, letter, options.state)}` : `${pre}${wall} ${cls}`);
  const wanted = options.direction === 4 ? 4 : 2;
  const direction = [wanted, 6 - wanted].find((d) => memberFor(wallOf(d), letters[0]));
  if (direction === undefined) return null;
  const wall = wallOf(direction);
  const colors = parseColors(options.colors);
  const layersAt = (choice?: FrameChoice): Layer[] => {
    const layers: Layer[] = [];
    letters.forEach((letter, i) => {
      const chosen = hasLayers ? choice?.(letter) : undefined;
      const found = memberFor(wall, letter, chosen?.frame);
      const b = found?.member.bitmap;
      if (!found || !b || (b.width <= 1 && b.height <= 1)) return;
      const lp = prop(props, letter);
      const zshift = numberList(prop(lp, 'zshift'));
      const shift = prop(lp, 'locshift');
      const shiftValue = Array.isArray(shift) ? shift[0] : shift;
      const point = typeof shiftValue === 'string' ? lingoValue(shiftValue) : shiftValue;
      const [sx, sy] = point && typeof point === 'object' && 'point' in point ? point.point : [0, 0];
      layers.push({
        name: found.member.name,
        letter,
        slot: found.slot,
        flip: found.flip,
        ink: Number(prop(lp, 'ink') ?? 8),
        blend: chosen?.blend ?? Number(prop(lp, 'blend') ?? 100),
        bgColor: partColor(colors[i], furni.paletteColors(b.paletteId)),
        z: (zshift ? zshift[0] : 0) + i,
        order: i,
        shiftX: sx,
        shiftY: sy,
        xFactor: 0,
        width: b.width,
        height: b.height,
        regX: b.regX,
        regY: b.regY,
      });
    });
    return layers.sort((a, b) => a.z - b.z || a.order - b.order);
  };
  return { cls: base, props, data, direction, dims: [1, 1], letters, layersAt };
}

/** floorSetup or wallSetup, whichever the furni is. */
export function furniSetup(furni: Furni, options: FloorOptions): FloorSetup | null {
  return isWallItem(furni) ? wallSetup(furni, options) : floorSetup(furni, options);
}

/** The directions the furni can be turned to: those with a layer a member or memberalias.index name of their own (the
 *  client's rotate only moves to a direction whose member exists; a direction without one would draw direction 0's
 *  members, which never happens in a room). */
export function ownDirections(furni: Furni, small = furni.isSmallCast()): number[] {
  if (isWallItem(furni)) {
    const pre = (small ? 's_' : '') ;
    const cls = furni.className().toLowerCase();
    const has = (wall: string) => [...furni.names.keys()].some((n) => n === `${pre}${wall} ${cls}` || n.startsWith(`${pre}${wall} ${cls}_`));
    return [2, 4].filter((d) => has(wallOf(d)));
  }
  const cls = (small ? 's_' : '') + furni.className();
  const out = new Set<number>();
  const prefix = `${cls}_a_0_`.toLowerCase();
  for (const n of furni.names.keys()) {
    if (!n.startsWith(prefix)) continue;
    const p = parseMemberName(n);
    if (p) out.add(p.direction);
  }
  return [...out].sort((a, b) => a - b);
}

/** The next direction after `from`, as the client's rotate (Active Object Class) picks it: (d + 2 + j) mod 8 for
 *  j = 0..3, the first that exists. */
export function rotateDirection(from: number, available: number[]): number {
  let d = from;
  for (let j = 0; j < 4; j++) {
    d = (d + 2 + j) % 8;
    if (available.includes(d)) return d;
  }
  return from;
}

/** Where a layer's sprite goes: its rect's top left for a furni whose tile is at (locH, locV). */
export function spriteRect(l: Layer, locH: number, locV: number) {
  const locX = locH + l.shiftX + (l.flip ? l.xFactor : 0);
  const locY = locV + l.shiftY;
  const left = l.flip ? locX - (l.width - l.regX) : locX - l.regX;
  return { left, top: locY - l.regY };
}
