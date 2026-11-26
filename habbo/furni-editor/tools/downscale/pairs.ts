// node pairs.cjs <out dir> <file with class names>: the large (64 px) and small (32 px) layer pictures of hotel furni as
// PNGs, as the room shows them (matte applied), with their registration points (meta.json per furni). The pictures are
// Sulake's: keep them out of the repo. Built with esbuild against a checkout of shockwave-imager (see README.md).
import { loadCast, decode, fieldText } from 'shockwave-imager/src/render';
import { lingoValue, prop } from 'shockwave-imager/src/lingo-value';
import { PNG } from 'pngjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HOST = process.env.FURNI_HOST ?? 'https://images.habbo-danmark.com/hof_furni/';
const out = process.argv[2];
const classes: string[] = fs.readFileSync(process.argv[3], 'utf8').split(/\s+/).filter(Boolean);

async function get(file: string): Promise<Uint8Array | null> {
  const res = await fetch(HOST + file);
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

/** RGBA as the room draws the member under `ink`: 8 drops the white connected to the edges, 36 all white. */
function seen(dec: NonNullable<ReturnType<typeof decode>>, ink: number): Uint8Array {
  const b = dec.bitmap as any;
  const w = b.width, h = b.height;
  const rgba = new Uint8Array(w * h * 4);
  const white = (i: number) => (b.argb[i] & 0xffffff) === 0xffffff;
  const clear = new Uint8Array(w * h);
  if (!b.nativeAlpha) {
    if (ink === 36) for (let i = 0; i < w * h; i++) clear[i] = white(i) ? 1 : 0;
    else {
      const stack: number[] = [];
      const push = (x: number, y: number) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = y * w + x; if (clear[i] || !white(i)) return; clear[i] = 1; stack.push(i); };
      for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
      for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
      while (stack.length) { const i = stack.pop()!; const x = i % w, y = (i - x) / w; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); }
    }
  }
  for (let i = 0; i < w * h; i++) {
    const c = b.argb[i];
    const a = b.nativeAlpha ? (c >>> 24) & 255 : clear[i] ? 0 : 255;
    rgba[i * 4] = (c >> 16) & 255; rgba[i * 4 + 1] = (c >> 8) & 255; rgba[i * 4 + 2] = c & 255; rgba[i * 4 + 3] = a;
  }
  return rgba;
}

function save(file: string, rgba: Uint8Array, w: number, h: number) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(rgba);
  fs.writeFileSync(file, PNG.sync.write(png));
}

async function one(cls: string) {
  const [lb, sb] = await Promise.all([get(`hh_furni_xx_${cls}.cct`), get(`hh_furni_xx_s_${cls}.cct`)]);
  if (!lb || !sb) return 'no pair';
  const large = loadCast(lb), small = loadCast(sb);
  const props = lingoValue(fieldText(large, `${cls}.props`) ?? '[:]');
  const meta: any[] = [];
  const dir = path.join(out, cls);
  for (const [name, entry] of large.names) {
    const m = /^(.+)_([a-z])_0_(\d+)_(\d+)_(\d+)_(\d+)$/.exec(name);
    if (!m || m[1] !== cls.toLowerCase() || entry.flip) continue;
    if ((entry.slot.member.name ?? '').toLowerCase() !== name) continue; // own members only, not alias names
    const s = small.names.get('s_' + name);
    if (!s || s.flip || (s.slot.member.name ?? '').toLowerCase() !== 's_' + name) continue;
    const ink = Number(prop(prop(props, m[2]), 'ink') ?? 8);
    if (![8, 36, 41, 0].includes(ink)) continue;
    const dl = decode(large, entry.slot), dsm = decode(small, s.slot);
    if (!dl || !dsm) continue;
    fs.mkdirSync(dir, { recursive: true });
    const bl = dl.bitmap as any, bs = dsm.bitmap as any;
    save(path.join(dir, `L_${name}.png`), seen(dl, ink === 41 ? 8 : ink), bl.width, bl.height);
    save(path.join(dir, `S_${name}.png`), seen(dsm, ink === 41 ? 8 : ink), bs.width, bs.height);
    meta.push({ name, ink, depth: bl.bitDepth, sdepth: bs.bitDepth, w: bl.width, h: bl.height, reg: [dl.regX, dl.regY], sw: bs.width, sh: bs.height, sreg: [dsm.regX, dsm.regY] });
  }
  if (meta.length) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return `${meta.length} pairs`;
}

(async () => {
  let done = 0, ok = 0;
  const queue = [...classes];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (;;) {
      const cls = queue.shift();
      if (!cls) return;
      try { const r = await one(cls); if (/^[1-9]/.test(r)) ok++; } catch (e) { /* skip */ }
      if (++done % 50 === 0) console.log(done, 'of', classes.length, ok, 'with pairs');
    }
  }));
  console.log('done', ok, 'furni with pairs');
})();
