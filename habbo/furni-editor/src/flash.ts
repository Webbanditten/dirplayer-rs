/**
 * Flash furni (`<sprite>.swf`, the 2010-era Flash client's furni libraries) to a Shockwave furni cast.
 *
 * A Flash furni SWF holds XML (`<sprite>_assets`, `_logic`, `_visualization`, `_index`) and one bitmap per picture,
 * exported as `<sprite>_<asset name>`. The mapping to the Shockwave client's conventions (the same ones the hotel's
 * Sulake casts follow; cf. Quackster's Elias, which does this conversion with JPEXS, swfmill and a Director projector):
 *
 * - Floor layer `<sprite>_64_<layer>_<dir>_<frame>` -> `<sprite>_<layer>_0_<x>_<y>_<dir>_<frame>` (x, y = logic.xml
 *   dimensions), registration point (asset x - 32, asset y); the 32 px size -> `s_<sprite>_...`, (x - 16, y).
 * - Shadow `<sprite>_64_sd_<dir>_0` -> `<sprite>_sd_<dir>`; icon `<sprite>_icon_a` -> `<sprite>_small` (further icon
 *   layers `_small_<letter>`).
 * - An asset with `source` reuses that picture: with the source's offsets it becomes a memberalias.index line
 *   (`name=source`, `*` when flipH: the client mirrors around the registration point and moves the sprite one tile),
 *   with other offsets a member of its own (mirrored copy, registration x = width - x - 32).
 * - visualization.xml (size 64): layer `z` -> `#zshift: [z]`, per-direction `z` -> an 8-entry `#zshift` (direction d
 *   and d + 1), `alpha` -> `#blend` (alpha / 255 * 100), ink ADD -> 33 (SUBTRACT 35, LIGHTEN 37, DARKEN 39),
 *   `ignoreMouse` -> `#transparent: 1`, layers in `<colors>` -> ink 41 (tinted with the part colour like Sulake's casts).
 * - `<animations>`: animation n = state n + 1; per layer `frames` (the frame sequences), `loop` (loopCount), `delay`
 *   (frameRepeat), `random`. Layers without one show frame 0.
 * - `<colors>` -> items_definitions.colour strings ("#RRGGBB" per layer, "#FFFFFF" where a layer has none).
 * - Every layer and direction gets a frame 0 (a 1x1 placeholder if the Flash file has none), which the client's layer
 *   detection needs.
 */
import type { CastDocument, SwfDocument } from '../../../vm-rust/pkg/vm_rust.js';

interface SwfSummary {
  version: number;
  binary: { id: number; size: number; names: string[] }[];
  images: { id: number; width: number; height: number; names: string[] }[];
  skipped: { tag: number; id: number; reason: string }[];
}

interface FlashAsset {
  name: string;
  source?: string;
  flipH: boolean;
  x: number;
  y: number;
}

export interface PlannedBitmap {
  name: string;
  imageId: number;
  width: number;
  height: number;
  flip: boolean;
  regX: number;
  regY: number;
  /** a 1x1 transparent placeholder */
  empty?: boolean;
}

export interface FlashPlan {
  sprite: string;
  dims: [number, number];
  bitmaps: PlannedBitmap[];
  fields: { name: string; text: string }[];
  /** part colour variants, items_definitions.colour, by the Flash colour id */
  colors: { id: number; colour: string }[];
  warnings: string[];
}

export interface FlashOptions {
  /** also convert the 32 px pictures (s_ members) */
  small: boolean;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const INKS: Record<string, number> = { ADD: 33, SUBTRACT: 35, LIGHTEN: 37, DARKEN: 39, COPY: 0 };

function xml(text: string | undefined): Document | null {
  if (!text) return null;
  const doc = new DOMParser().parseFromString(text.replace(/^\s+/, ''), 'text/xml');
  return doc.querySelector('parsererror') ? null : doc;
}

const num = (el: Element | null | undefined, attr: string) => {
  const v = el?.getAttribute(attr);
  return v === null || v === undefined || v === '' ? undefined : Number(v);
};

/** Read the SWF's XML and work out every member and text of the Shockwave cast. */
export function planFlash(swf: SwfDocument, fileName: string, options: FlashOptions): FlashPlan {
  const summary: SwfSummary = JSON.parse(swf.summaryJson());
  const warnings: string[] = summary.skipped.map((s) => `Picture ${s.id} not read: ${s.reason}`);
  const byKind = (kind: string) => {
    const b = summary.binary.find((x) => x.names.some((n) => n.endsWith('_' + kind)));
    return b ? xml(swf.binaryText(b.id) ?? undefined) : null;
  };
  const assetsXml = byKind('assets');
  const logicXml = byKind('logic');
  const visXml = byKind('visualization');
  const indexXml = byKind('index');
  if (!assetsXml || !visXml) throw new Error('No assets or visualization XML: not a Habbo Flash furni file');

  const sprite =
    indexXml?.querySelector('object')?.getAttribute('type') ??
    logicXml?.querySelector('objectData')?.getAttribute('type') ??
    visXml.querySelector('visualizationData')?.getAttribute('type') ??
    fileName.replace(/\.swf$/i, '');
  const dimsEl = logicXml?.querySelector('model > dimensions');
  const dims: [number, number] = [num(dimsEl, 'x') ?? 1, num(dimsEl, 'y') ?? 1];

  // Pictures by asset name: their exported class is "<library>_<asset name>"; the library is usually the sprite.
  const images = new Map<string, SwfSummary['images'][number]>();
  for (const img of summary.images) {
    for (const n of img.names) {
      const i = n.indexOf('_' + sprite + '_');
      images.set(i >= 0 ? n.slice(i + 1) : n.startsWith(sprite + '_') ? n.slice(sprite.length + 1) : n, img);
    }
  }

  const assets = new Map<string, FlashAsset>();
  for (const el of Array.from(assetsXml.querySelectorAll('asset'))) {
    const name = el.getAttribute('name');
    if (!name) continue;
    assets.set(name, {
      name,
      source: el.getAttribute('source') ?? undefined,
      flipH: el.getAttribute('flipH') === '1',
      x: num(el, 'x') ?? 0,
      y: num(el, 'y') ?? 0,
    });
  }

  interface Parsed {
    kind: 'layer' | 'shadow' | 'icon';
    size: 64 | 32;
    letter: string;
    dir: number;
    frame: number;
  }
  const parse = (name: string): Parsed | null => {
    const icon = new RegExp(`^${escape(sprite)}_icon_([a-z])$`).exec(name);
    if (icon) return { kind: 'icon', size: 64, letter: icon[1], dir: 0, frame: 0 };
    const m = new RegExp(`^${escape(sprite)}_(64|32)_([a-z]+)_(\\d+)_(\\d+)$`).exec(name);
    if (!m) return null;
    return { kind: m[2] === 'sd' ? 'shadow' : 'layer', size: Number(m[1]) as 64 | 32, letter: m[2], dir: +m[3], frame: +m[4] };
  };
  const shockwaveName = (p: Parsed) => {
    const pre = p.size === 32 ? 's_' : '';
    if (p.kind === 'icon') return p.letter === 'a' ? `${sprite}_small` : `${sprite}_small_${p.letter}`;
    if (p.kind === 'shadow') return `${pre}${sprite}_sd_${p.dir}`;
    return `${pre}${sprite}_${p.letter}_0_${dims[0]}_${dims[1]}_${p.dir}_${p.frame}`;
  };
  const centre = (p: Parsed) => (p.kind === 'icon' ? 32 : p.size === 32 ? 16 : 32);

  // The picture an asset shows: its own, or its source's (following source chains). Only the asset's own flipH counts:
  // a source's flag is about how the source itself is shown.
  const owner = (a: FlashAsset): { asset: FlashAsset; flip: boolean } | null => {
    let cur = a;
    for (let guard = 0; guard < 8; guard++) {
      if (images.has(cur.name)) return { asset: cur, flip: a.flipH };
      if (!cur.source) return null;
      const next = assets.get(cur.source);
      if (!next) return images.has(cur.source) ? { asset: { name: cur.source, flipH: false, x: a.x, y: a.y }, flip: a.flipH } : null;
      cur = next;
    }
    return null;
  };

  const bitmaps: PlannedBitmap[] = [];
  const aliases: string[] = [];
  const memberNames = new Set<string>();
  /** members whose pixels are stored mirrored */
  const storedFlipped = new Set<string>();
  const wanted = [...assets.values()].filter((a) => {
    const p = parse(a.name);
    return p && (p.size === 64 || options.small);
  });
  // Pictures first (members), then the assets that reuse them.
  const ordered = [...wanted.filter((a) => images.has(a.name)), ...wanted.filter((a) => !images.has(a.name))];
  for (const a of ordered) {
    const p = parse(a.name)!;
    const name = shockwaveName(p);
    const own = owner(a);
    if (!own) {
      warnings.push(`${a.name}: no picture`);
      continue;
    }
    const img = images.get(own.asset.name)!;
    const flip = own.flip;
    const c = centre(p);
    const srcParsed = parse(own.asset.name);
    const srcName = srcParsed ? shockwaveName(srcParsed) : undefined;
    const sameOffsets = own.asset.x === a.x && own.asset.y === a.y;
    if (own.asset !== a && srcName && memberNames.has(srcName) && sameOffsets && p.kind !== 'icon') {
      // The alias mirrors relative to the member as stored.
      const star = flip !== storedFlipped.has(srcName);
      aliases.push(`${name}=${srcName}${star ? '*' : ''}`);
      continue;
    }
    bitmaps.push({
      name,
      imageId: img.id,
      width: img.width,
      height: img.height,
      flip,
      regX: (flip ? img.width - a.x : a.x) - c,
      regY: a.y,
    });
    memberNames.add(name);
    if (flip) storedFlipped.add(name);
  }

  // Every layer and direction needs a frame 0 (Active Object Class takes base layers from frame 0).
  const groups = new Map<string, Set<number>>();
  for (const n of [...memberNames, ...aliases.map((l) => l.split('=')[0])]) {
    const m = /^(.*_[a-z]_0_\d+_\d+_\d+)_(\d+)$/.exec(n);
    if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], new Set());
    groups.get(m[1])!.add(+m[2]);
  }
  for (const [base, frames] of groups) {
    if (!frames.has(0)) bitmaps.push({ name: `${base}_0`, imageId: -1, width: 1, height: 1, flip: false, regX: 0, regY: 0, empty: true });
  }

  const fields: { name: string; text: string }[] = [];
  const colors: FlashPlan['colors'] = [];
  for (const size of options.small ? [64, 32] : [64]) {
    const vis = visXml.querySelector(`visualization[size="${size}"]`);
    if (!vis) {
      if (size === 64) warnings.push('No 64 px visualization');
      continue;
    }
    const pre = size === 32 ? 's_' : '';
    const layerCount = num(vis, 'layerCount') ?? 0;
    const usedLetters = [...new Set([...memberNames, ...aliases.map((l) => l.split('=')[0])].map((n) => {
      const m = new RegExp(`^${pre}${escape(sprite)}_([a-z])_0_`).exec(n);
      return m?.[1];
    }).filter((x): x is string => !!x))].sort();

    // Colours: layers that take a part colour, and the variants.
    const colorLayers = new Set<number>();
    for (const cl of Array.from(vis.querySelectorAll('colors > color > colorLayer'))) colorLayers.add(num(cl, 'id') ?? -1);
    if (size === 64) {
      for (const col of Array.from(vis.querySelectorAll('colors > color'))) {
        const parts: string[] = [];
        for (let i = 0; i < Math.max(layerCount, ...[...colorLayers].map((x) => x + 1)); i++) {
          const cl = col.querySelector(`colorLayer[id="${i}"]`);
          parts.push('#' + (cl?.getAttribute('color') ?? 'FFFFFF').toUpperCase());
        }
        colors.push({ id: num(col, 'id') ?? 0, colour: parts.join(',') });
      }
      colors.sort((a, b) => a.id - b.id);
    }

    // .props
    const props: string[] = [];
    for (const letter of usedLetters) {
      const id = LETTERS.indexOf(letter);
      const layer = vis.querySelector(`layers > layer[id="${id}"]`);
      const entries: string[] = [];
      const ink = layer?.getAttribute('ink')?.toUpperCase();
      if (ink && INKS[ink] !== undefined) entries.push(`#ink: ${INKS[ink]}`);
      else if (ink) warnings.push(`Layer ${letter}: ink ${ink} has no Shockwave equivalent`);
      else if (colorLayers.has(id)) entries.push('#ink: 41');
      const alpha = num(layer, 'alpha');
      if (alpha !== undefined && !ink) entries.push(`#blend: ${Math.round((alpha / 255) * 100)}`);
      const perDir = Array.from(vis.querySelectorAll(`directions > direction > layer[id="${id}"]`));
      if (perDir.length) {
        const z = [0, 0, 0, 0, 0, 0, 0, 0];
        for (const dl of perDir) {
          const d = num(dl.parentElement, 'id') ?? 0;
          const v = num(dl, 'z') ?? 0;
          if (d >= 0 && d < 8) z[d] = v;
          if (d + 1 < 8) z[d + 1] = v;
        }
        entries.push(`#zshift: [${z.join(', ')}]`);
      } else if (num(layer, 'z') !== undefined) {
        entries.push(`#zshift: [${num(layer, 'z')}]`);
      }
      if (layer?.getAttribute('ignoreMouse') === '1') entries.push('#transparent: 1');
      props.push(`"${letter}": [${entries.length ? entries.join(', ') : ':'}]`);
    }
    fields.push({ name: `${pre}${sprite}.props`, text: `[${props.join(', ')}]` });

    // .data
    const anims = Array.from(vis.querySelectorAll('animations > animation'))
      .map((a) => ({ el: a, id: num(a, 'id') ?? 0 }))
      .filter((a) => {
        if (a.id >= 100) warnings.push(`Animation ${a.id} (a transition) left out`);
        return a.id < 100;
      });
    if (anims.length) {
      const states = Math.max(...anims.map((a) => a.id)) + 1;
      const lines: string[] = [];
      for (const letter of usedLetters) {
        const id = LETTERS.indexOf(letter);
        const perState: string[] = [];
        for (let s = 0; s < states; s++) {
          const al = anims.find((a) => a.id === s)?.el.querySelector(`animationLayer[id="${id}"]`);
          const seqs = al ? Array.from(al.querySelectorAll('frameSequence')) : [];
          const frames = seqs.flatMap((seq) => Array.from(seq.querySelectorAll('frame')).map((f) => num(f, 'id') ?? 0));
          const parts: string[] = [];
          const loop = num(al, 'loopCount');
          const delay = num(al, 'frameRepeat');
          if (loop !== undefined) parts.push(`loop:${loop}`);
          if (delay !== undefined && delay > 1) parts.push(`delay:${delay}`);
          if (seqs.some((seq) => seq.getAttribute('random') === '1')) parts.push('random:1');
          parts.push(`frames:[ ${(frames.length ? frames : [0]).join(',')} ]`);
          perState.push(`[ ${parts.join(', ')} ]`);
        }
        lines.push(`${letter}:[ ${perState.join(', ')} ]`);
      }
      const stateList = Array.from({ length: states }, (_, i) => i + 1).join(',');
      fields.push({ name: `${pre}${sprite}.data`, text: `[\nstates:[${stateList}],\nlayers:[ \n${lines.join(',\n')}\n]\n]` });
    }
  }

  fields.push({ name: 'asset.index', text: `[#id: "${sprite}", #classes: ["Active Object Class",  "Active Object Extension Class"]]` });
  if (aliases.length) fields.push({ name: 'memberalias.index', text: aliases.join('\n') });
  return { sprite, dims, bitmaps, fields, colors, warnings };
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mirrored(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (y * w + (w - 1 - x)) * 4);
  return out;
}

/**
 * Build the cast: `template` is any furni cast (a Director-written one, so the result has its container and chunk
 * layout); its members are replaced by the plan's. Pictures are stored 32-bit with their alpha.
 */
export function buildCast(doc: CastDocument, swf: SwfDocument, plan: FlashPlan) {
  const members: { slot: number; type: string; bitmap?: { width: number } }[] = JSON.parse(doc.membersJson());
  const bitmapTpl = members.find((m) => m.type === 'bitmap' && (m.bitmap?.width ?? 0) > 1) ?? members.find((m) => m.type === 'bitmap');
  const fieldTpl = members.find((m) => m.type === 'field');
  if (!bitmapTpl || !fieldTpl) throw new Error('The template cast needs a bitmap and a field member');
  for (const m of members) if (m.slot !== bitmapTpl.slot && m.slot !== fieldTpl.slot) doc.delete(m.slot);

  const pixels = (b: PlannedBitmap) => {
    if (b.empty) return new Uint8Array(4);
    const raw = swf.imageRgba(b.imageId);
    return b.flip ? mirrored(raw, b.width, b.height) : raw;
  };
  plan.bitmaps.forEach((b, i) => {
    if (i === 0) {
      doc.setName(bitmapTpl.slot, b.name);
      doc.setBitmap(bitmapTpl.slot, pixels(b), b.width, b.height, b.regX, b.regY, 'rgba', 0);
    } else {
      doc.addBitmap(bitmapTpl.slot, b.name, pixels(b), b.width, b.height, b.regX, b.regY, 'rgba');
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
  if (!plan.bitmaps.length) doc.delete(bitmapTpl.slot);
}
