/**
 * Lights the way Sulake's lamps have them (rare_dragonlamp's halo, hc2_biglamp's pool of light, hc_lmp's glow): an
 * extra layer drawn with ink 33 (Add Pin), which adds its colours to what's below. Its picture is dark at the edge and
 * bright in the middle, so black adds nothing and the centre lights up the furni and the floor; `#transparent: 1`
 * lets clicks through. A lamp shows it in its "on" state only (frame 0 is a 1x1 "nothing").
 *
 * The picture is 8-bit on a light palette (`lightRamp`: index = brightness, black to the light's colour), so the
 * light's colour is one palette to change. Other directions get memberalias.index names for the same member,
 * mirrored (`*`) where the furni itself is, which mirrors the light around the tile like the furni.
 */
import type { CastDocument } from '../../../vm-rust/pkg/vm_rust.js';
import { ALIAS_INDEX, floorSetup, ownDirections, spriteRect, type Furni } from './furni';
import { lingoValue, prop, propsText, dataText, type LingoValue } from './lingo';
import { falloff, lightRamp, toRgbBytes } from './paint';

export interface LightOptions {
  kind: 'halo' | 'floor';
  color: number;
  /** radius in pixels */
  size: number;
  /** 0..1, the brightest step of the ramp */
  strength: number;
  /** centre, relative to the furni's tile point (its sprite location) */
  x: number;
  y: number;
  /** show it only in this state (0-based); null = always */
  state: number | null;
}

/** Where a light would go by default: a halo at the top of the furni, a floor light on its tiles. */
export function lightDefaults(furni: Furni, kind: LightOptions['kind']): Pick<LightOptions, 'x' | 'y' | 'size'> {
  const own = ownDirections(furni);
  const setup = floorSetup(furni, { direction: own.includes(2) ? 2 : own[0] ?? 2, state: 0 });
  const layers = setup?.layersAt() ?? [];
  let l = 0, t = 0, r = 64, b = 0;
  for (const layer of layers) {
    if (layer.letter === 'sd') continue;
    const s = spriteRect(layer, 0, 0);
    l = Math.min(l, s.left);
    t = Math.min(t, s.top);
    r = Math.max(r, s.left + layer.width);
    b = Math.max(b, s.top + layer.height);
  }
  const [len, wid] = setup?.dims ?? [1, 1];
  if (kind === 'floor') {
    // The middle of the tiles the furni covers (direction 2: width along x, length along y).
    const cx = 32 + (wid - 1) * 16 - (len - 1) * 16;
    const cy = (wid - 1) * 8 + (len - 1) * 8;
    return { x: Math.round(cx), y: Math.round(cy), size: 40 * Math.max(len, wid) };
  }
  return { x: Math.round((l + r) / 2), y: Math.round(t + (b - t) * 0.3), size: Math.max(16, Math.round(Math.max(r - l, b - t) * 0.55)) };
}

/** The picture: palette indices of the ramp, 1 (black) outside, brighter towards the centre. */
function lightPixels(o: LightOptions) {
  const rx = o.size, ry = o.kind === 'floor' ? Math.max(1, Math.round(o.size / 2)) : o.size;
  const w = rx * 2 + 1, h = ry * 2 + 1;
  const px = new Uint8Array(w * h).fill(1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = Math.hypot((x - rx) / rx, (y - ry) / ry);
      if (t < 1) px[y * w + x] = 1 + Math.round(falloff(t) * 254);
    }
  }
  return { px, w, h, cx: rx, cy: ry };
}

function nextLetter(furni: Furni, cls: string, data: LingoValue): string {
  const used = new Set<string>();
  const prefix = `${cls}_`.toLowerCase();
  for (const n of furni.names.keys()) {
    const m = n.startsWith(prefix) ? /^([a-z])_0_\d+_\d+_\d+_\d+$/.exec(n.slice(prefix.length)) : null;
    if (m) used.add(m[1]);
  }
  const layers = prop(data, 'layers');
  if (layers instanceof Map) for (const k of layers.keys()) for (const c of k.toLowerCase()) used.add(c);
  for (const c of 'abcdefghijklmnopqrstuvwxyz') if (!used.has(c)) return c;
  throw new Error('No free layer letter');
}

/** Add a light layer to the furni. Returns a one-line summary. */
export function addLight(doc: CastDocument, furni: Furni, o: LightOptions): string {
  const cls = (furni.isSmallCast() ? 's_' : '') + furni.className();
  const own = ownDirections(furni);
  if (!own.length) throw new Error('The furni has no layer a to put a light on');
  const dir0 = own.includes(2) ? 2 : own[0];
  const setup = floorSetup(furni, { direction: dir0, state: 0 });
  const [len, wid] = setup?.dims ?? [1, 1];
  const dataField = furni.fieldSlot(`${cls}.data`);
  const data = lingoValue((furni.text(`${cls}.data`) ?? '').replace(/[\r\n]/g, ''));
  const letter = nextLetter(furni, cls, data);
  const name = (d: number, f: number) => `${cls}_${letter}_0_${len}_${wid}_${d}_${f}`;
  const bitmapTpl = furni.members.find((m) => m.type === 'bitmap' && (m.bitmap?.width ?? 0) > 1)?.slot;
  const fieldTpl = furni.members.find((m) => m.type === 'field' || m.type === 'text')?.slot;
  if (!bitmapTpl || !fieldTpl) throw new Error('The cast needs a bitmap and a field to copy');

  // Palette and picture.
  const pal = doc.addPalette(`${cls} light ${letter}`, toRgbBytes(lightRamp(o.color, o.strength)));
  const pic = lightPixels(o);
  const lit = o.state === null ? 0 : 1;
  const place = (slot: number, px: Uint8Array, w: number, h: number, rx: number, ry: number) => doc.setBitmapIndexed(slot, px, w, h, rx, ry, pal);
  const litSlot = doc.addBitmap(bitmapTpl, name(dir0, lit), new Uint8Array(4), 1, 1, 0, 0, 'rgba');
  place(litSlot, pic.px, pic.w, pic.h, pic.cx - o.x, pic.cy - o.y);
  if (lit === 1) {
    const off = doc.addBitmap(bitmapTpl, name(dir0, 0), new Uint8Array(4), 1, 1, 0, 0, 'rgba');
    place(off, new Uint8Array([1]), 1, 1, 0, 0);
  }

  // The other directions: the same member, mirrored where the furni's layer a is.
  const lines: string[] = [];
  for (const d of own) {
    if (d === dir0) continue;
    const a = furni.names.get(`${cls}_a_0_${len}_${wid}_${d}_0`.toLowerCase());
    for (const f of lit === 1 ? [0, 1] : [0]) lines.push(`${name(d, f)}=${name(dir0, f)}${a?.flip ? '*' : ''}`);
  }
  if (lines.length) {
    let slot = furni.fieldSlot(ALIAS_INDEX);
    if (!slot) slot = doc.addField(fieldTpl, ALIAS_INDEX, '');
    const text = (doc.text(slot) ?? '').replace(/\s+$/, '');
    doc.setText(slot, [text, ...lines].filter((l) => l.trim()).join('\n'));
  }

  // .props: ink 33, clicks go through; a floor light below the furni (above its shadow).
  const props = lingoValue(furni.text(`${cls}.props`) ?? '[:]');
  const map = props instanceof Map ? props : new Map<string, LingoValue>();
  const entry = new Map<string, LingoValue>([['ink', 33], ['transparent', 1]]);
  if (o.kind === 'floor') entry.set('zshift', [-1000]);
  map.set(letter, entry);
  const propsSlot = furni.fieldSlot(`${cls}.props`) ?? doc.addField(fieldTpl, `${cls}.props`, '');
  doc.setText(propsSlot, propsText(map));

  // .data: the light's frame per state (with .data, every layer is listed, so a new one is too).
  if (data instanceof Map || o.state !== null) {
    const d: Map<string, LingoValue> =
      data instanceof Map ? data : new Map<string, LingoValue>([['states', [1, 2]], ['statestrings', ['off', 'on']], ['layers', new Map<string, LingoValue>()]]);
    const states = prop(d, 'states');
    const count = Array.isArray(states) && states.length ? states.length : 1;
    let layers = prop(d, 'layers');
    if (!(layers instanceof Map)) {
      layers = new Map();
      d.set('layers', layers);
    }
    const layerMap = layers as Map<string, LingoValue>;
    if (!(data instanceof Map)) {
      // A new .data has to list the existing layers too, each in its frame 0.
      for (const l of setup?.letters ?? []) layerMap.set(l, Array.from({ length: count }, () => new Map<string, LingoValue>([['frames', [0]]])));
    }
    layerMap.set(letter, Array.from({ length: count }, (_, s) => new Map<string, LingoValue>([['frames', [o.state === null || o.state === s ? lit : 0]]])));
    const text = dataText(d);
    if (dataField) doc.setText(dataField, text);
    else doc.addField(fieldTpl, `${cls}.data`, text);
  }
  return `Light ${letter}: ${o.kind}, ${pic.w}×${pic.h}, palette "${cls} light ${letter}"${o.state === null ? ', always on' : `, in state ${o.state}`}${lines.length ? `, ${lines.length} aliases` : ''}`;
}
