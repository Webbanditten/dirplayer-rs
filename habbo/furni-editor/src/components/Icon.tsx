/**
 * The editor's icons (16 px line icons, currentColor) and its pixel-art logo: an isometric block drawn the way Habbo
 * furni are, with 2:1 pixel stairs and a dark outline.
 */
import type { CSSProperties } from 'react';

const PATHS: Record<string, string> = {
  folder: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z',
  download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
  upload: 'M8 13.5v-8M4.5 9 8 5.5 11.5 9M3 2.5h10',
  save: 'M3.5 2.5h7.5l2.5 2.5v8a.5.5 0 0 1-.5.5h-9.5a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5zM5.5 2.5V6h4.5V2.5M5 13.5v-4h6v4',
  bolt: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5 14 14',
  sliders: 'M2.5 4.5h3m3 0h5M2.5 11.5h7m3 0h1M7 3v3M11 10v3',
  rotate: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3',
  play: 'M5 3.2v9.6L12.5 8z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  camera: 'M2.5 5.5A1 1 0 0 1 3.5 4.5h2l1-1.5h3l1 1.5h2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM8 11a2.3 2.3 0 1 0 0-4.6A2.3 2.3 0 0 0 8 11z',
  brush: 'M10.5 2.5 13.5 5.5 8 11 5 8zM5 8l-1.5 1.5c-1 1-1 2.5-1 4 1.5 0 3 0 4-1L8 11',
  sun: 'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1',
  moon: 'M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z',
  layers: 'M8 2 14 5 8 8 2 5zM2 8l6 3 6-3M2 11l6 3 6-3',
  room: 'M8 3.5 14 6.5 8 9.5 2 6.5zM2 6.5v3L8 12.5l6-3v-3',
  inspect: 'M2.5 3.5h11v9h-11zM2.5 6h11M5 8.5h3M5 10.5h5',
  mirror: 'M8 2v12M6 4.5 2.5 8 6 11.5zM10 4.5 13.5 8 10 11.5z',
  plus: 'M8 3v10M3 8h10',
  close: 'M4 4l8 8M12 4l-8 8',
  check: 'M3 8.5 6.5 12 13 4.5',
  undo: 'M5.5 3 2.5 6l3 3M2.5 6H10a3.5 3.5 0 0 1 0 7H7',
  redo: 'M10.5 3l3 3-3 3M13.5 6H6a3.5 3.5 0 0 0 0 7h3',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6.5a1 1 0 1 0 0-.01',
  export: 'M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3',
};

const FILLED = new Set(['play', 'bolt']);

export function Icon({ name, size = 16, className, style }: { name: keyof typeof PATHS | string; size?: number; className?: string; style?: CSSProperties }) {
  const d = PATHS[name];
  if (!d) return null;
  const filled = FILLED.has(name);
  return (
    <svg className={`icon-svg${className ? ' ' + className : ''}`} style={style} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 1 : 1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

// --- the logo ---------------------------------------------------------------------------------------------------

type Pt = [number, number];
const inside = (p: Pt, poly: Pt[]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/** The block as rows of coloured runs on a 20 x 19 pixel grid (top, left and right face, outline). */
function logoRuns(): { x: number; y: number; w: number; c: string }[] {
  const W = 20, H = 19;
  const top: Pt[] = [[10, 0.5], [19.5, 5.25], [10, 10], [0.5, 5.25]];
  const left: Pt[] = [[0.5, 5.25], [10, 10], [10, 18.5], [0.5, 13.75]];
  const right: Pt[] = [[10, 10], [19.5, 5.25], [19.5, 13.75], [10, 18.5]];
  const face = (x: number, y: number) => {
    const p: Pt = [x + 0.5, y + 0.5];
    return inside(p, top) ? 1 : inside(p, left) ? 2 : inside(p, right) ? 3 : 0;
  };
  const colours = ['', 'var(--logo-top)', 'var(--logo-left)', 'var(--logo-right)', 'var(--logo-line)', 'var(--logo-shine)'];
  const grid: number[][] = [];
  for (let y = 0; y < H; y++) {
    grid.push([]);
    for (let x = 0; x < W; x++) grid[y].push(face(x, y));
  }
  // Outline: face pixels next to the outside; a shine along the top face's two upper edges.
  const out = grid.map((row) => row.slice());
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!grid[y][x]) continue;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !(grid[y + dy]?.[x + dx]));
      if (edge) out[y][x] = 4;
      else if (grid[y][x] === 1 && [[0, -1], [0, -2]].some(([dx, dy]) => out[y + dy]?.[x + dx] === 4) && y < 5) out[y][x] = 5;
    }
  }
  const runs: { x: number; y: number; w: number; c: string }[] = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      const v = out[y][x];
      let w = 1;
      while (x + w < W && out[y][x + w] === v) w++;
      if (v) runs.push({ x, y, w, c: colours[v] });
      x += w;
    }
  }
  return runs;
}

const RUNS = logoRuns();

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={(size * 19) / 20} viewBox="0 0 20 19" shapeRendering="crispEdges" aria-hidden="true">
      {RUNS.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />)}
    </svg>
  );
}

/** The logo as a standalone SVG (the favicon): fixed colours instead of the theme's. */
export function logoSvg(): string {
  const fixed: Record<string, string> = {
    'var(--logo-top)': '#ffd36b', 'var(--logo-left)': '#ffb224', 'var(--logo-right)': '#e0841a', 'var(--logo-line)': '#3b2306', 'var(--logo-shine)': '#fff1c4',
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 19" shape-rendering="crispEdges">${RUNS.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${fixed[r.c]}"/>`).join('')}</svg>`;
}
