// esbuild parity.ts --bundle --platform=node --format=cjs --outfile=parity.cjs && node parity.cjs vectors.json
// src/downscale.ts against reference.py, pixel by pixel, with the time it takes.
import { readFileSync } from 'node:fs';
import { halveOnGrid } from '../../src/downscale';
const vec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let px = 0, diff = 0, blocks = 0;
const t0 = performance.now();
for (const v of vec) {
  const rgba = new Uint8Array(Buffer.from(v.rgba, 'base64'));
  const want = new Uint8Array(Buffer.from(v.small, 'base64'));
  const p = halveOnGrid({ kind: 'rgba', w: v.w, h: v.h, px: rgba }, [], v.ox, v.oy).img;
  if (p.w !== v.sw || p.h !== v.sh) { console.log('size differs', p.w, p.h, v.sw, v.sh); diff += v.sw * v.sh; continue; }
  for (let i = 0; i < p.w * p.h; i++) {
    px++;
    const there = p.px[i * 4 + 3] >= 128;
    const got = there ? [p.px[i * 4], p.px[i * 4 + 1], p.px[i * 4 + 2], 255] : [255, 255, 255, 0];
    if (got[0] !== want[i * 4] || got[1] !== want[i * 4 + 1] || got[2] !== want[i * 4 + 2] || got[3] !== want[i * 4 + 3]) diff++;
  }
  blocks += p.w * p.h;
}
const ms = performance.now() - t0;
console.log(`${vec.length} pictures, ${px} pixels, ${diff} differ from the reference; ${ms.toFixed(0)} ms (${(ms / blocks * 1000).toFixed(1)} µs a pixel)`);
