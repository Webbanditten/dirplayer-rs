import type React from 'react';
import { Icon } from './Icon';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import { Animator, FPS } from '../animation';
import { floorSetup, ownDirections, rotateDirection, stateNames, type FloorSetup, type Furni, type Layer } from '../furni';
import { composite, drawFloor, fitRoom, footprint, roomLayout, tileLoc, type Placement, type RoomLayout } from '../room';
import { spriteRect } from '../furni';
import { download, encodePng } from '../wasm';

/** The CMS furni API through the dev server's proxy (vite.config.js); a static build (GitHub Pages) has no proxy. */
const HOTEL_API = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ? '/hotel-api' : null;

function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem('furniEditor.' + key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem('furniEditor.' + key, value);
  } catch {
    /* private mode */
  }
}

interface Props {
  doc: CastDocument;
  furni: Furni;
  rev: number;
  selected: number | null;
  onPick: (slot: number) => void;
  /** part colour variants from elsewhere (an imported Flash file), used when the hotel has none for the class */
  extraColors?: { label: string; colour: string }[];
}

interface HotelFurni {
  id: number;
  sprite: string;
  name: string;
  colour: string;
}

interface Placed {
  setup: FloorSetup;
  x: number;
  y: number;
  animator: Animator;
}

export function Preview({ doc, furni, rev, selected, onPick, extraColors = [] }: Props) {
  const [direction, setDirection] = useState(2);
  const [state, setState] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [shadow, setShadow] = useState(true);
  const [colors, setColors] = useState('');
  const [allDirections, setAllDirections] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [stageWidth, setStageWidth] = useState(600);
  const stage = useRef<HTMLDivElement>(null);
  const [floor, setFloorState] = useState(() => stored('floor', '#989865'));
  const [background, setBackgroundState] = useState(() => stored('background', '#2e3a40'));
  const [transparent, setTransparentState] = useState(() => stored('transparent', '1') === '1');
  const setFloor = (v: string) => (store('floor', v), setFloorState(v));
  const setBackground = (v: string) => (store('background', v), setBackgroundState(v));
  const setTransparent = (v: boolean) => (store('transparent', v ? '1' : '0'), setTransparentState(v));
  const [grid, setGrid] = useState(true);
  const [showFootprint, setShowFootprint] = useState(false);
  const [small, setSmall] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hotel, setHotel] = useState<HotelFurni[]>([]);
  const cls = furni.className();

  // The hotel's definitions of this class (the sprite and its *n colour variants): their part colours.
  useEffect(() => {
    let live = true;
    setHotel([]);
    setColors(extraColors[0]?.colour ?? '');
    if (!cls || !HOTEL_API) return;
    fetch(`${HOTEL_API}/furni/search?query=${encodeURIComponent(cls)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: HotelFurni[]) => {
        if (!live || !Array.isArray(list)) return;
        const mine = list.filter((f) => f.sprite?.split('*')[0].toLowerCase() === cls.toLowerCase());
        mine.sort((a, b) => (a.sprite.includes('*') ? 1 : 0) - (b.sprite.includes('*') ? 1 : 0) || a.sprite.localeCompare(b.sprite, undefined, { numeric: true }));
        setHotel(mine);
        if (mine[0]?.colour) setColors(mine[0].colour);
        else if (extraColors[0]) setColors(extraColors[0].colour);
      })
      .catch(() => live && extraColors[0] && setColors(extraColors[0].colour));
    return () => {
      live = false;
    };
  }, [cls]);
  const variants = [...hotel.map((f) => ({ label: `${f.sprite}: ${f.name}`, colour: f.colour })), ...extraColors];
  const [tick, setTick] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);

  // A small cast of its own (hh_furni_xx_s_...) always shows small; a cast with both sizes has the checkbox.
  const smallCast = useMemo(() => furni.isSmallCast(), [furni]);
  const hasSmall = useMemo(() => furni.members.some((m) => m.name.toLowerCase().startsWith('s_' + furni.className().toLowerCase() + '_')), [furni]);
  const useSmall = smallCast || (small && hasSmall);
  const probe = useMemo(() => floorSetup(furni, { direction, state, colors, shadow, small: useSmall }), [furni, direction, state, colors, shadow, useSmall]);
  const states = probe ? stateNames(probe.data) : ['default'];
  const own = useMemo(() => ownDirections(furni, useSmall), [furni, useSmall]);
  // Stay on directions the furni has: 2 when it has it, else its first.
  useEffect(() => {
    if (own.length && !own.includes(direction)) setDirection(own.includes(2) ? 2 : own[0]);
  }, [own, direction]);

  // Where furni go: one in the middle, or every direction it has side by side.
  const { room, placed } = useMemo(() => {
    const dims = probe?.dims ?? [1, 1];
    const span = Math.max(dims[0], dims[1]) + 1;
    const dirs = allDirections ? (own.length ? own : [direction]) : [direction];
    const cols = allDirections ? Math.max(1, dirs.length) * span + 1 : span + 1;
    const rows = span + 1;
    const placed: Placed[] = [];
    dirs.forEach((d, i) => {
      const setup = floorSetup(furni, { direction: d, state, colors, shadow, small: useSmall });
      if (!setup) return;
      placed.push({ setup, x: 1 + (allDirections ? i * span : 0), y: 1, animator: new Animator(setup.data, setup.letters, state) });
    });
    const room = fitRoom(roomLayout({ cols, rows }, useSmall ? 32 : 64), placed.map((p) => ({ x: p.x, y: p.y, layers: p.setup.layersAt() })));
    return { room, placed };
  }, [furni, direction, state, colors, shadow, allDirections, useSmall, probe, own]);

  const floorPixels = useMemo(() => {
    const highlight = new Set<string>();
    if (showFootprint) for (const p of placed) footprint(p.x, p.y, p.setup.dims, p.setup.direction).forEach((t) => highlight.add(t));
    const style = { floor, grid, highlight };
    return transparent
      ? { black: drawFloor(room, { ...style, background: '#000000' }), white: drawFloor(room, { ...style, background: '#ffffff' }) }
      : { black: drawFloor(room, { ...style, background }), white: undefined };
  }, [room, placed, floor, background, grid, showFootprint, transparent]);

  const moves = placed.some((p) => p.animator.moves);
  const layersNow = useRef<{ room: RoomLayout; layers: { layer: Layer; x: number; y: number }[] }>({ room, layers: [] });

  // Draw now, and every 1/24 s while animating.
  useEffect(() => {
    const draw = () => {
      const placements: Placement[] = placed.map((p) => ({ x: p.x, y: p.y, layers: p.setup.layersAt(p.animator.choice()), hidden }));
      layersNow.current = { room, layers: placements.flatMap((p) => p.layers.map((layer) => ({ layer, x: p.x, y: p.y }))) };
      const c = canvas.current;
      if (!c) return;
      c.width = room.width;
      c.height = room.height;
      try {
        c.getContext('2d')!.putImageData(composite(doc, room, floorPixels.black, placements, floorPixels.white), 0, 0);
      } catch (e) {
        console.error(e);
      }
    };
    draw();
    if (!playing || !moves) return;
    let last = performance.now();
    let acc = 0;
    let raf = 0;
    const loop = (now: number) => {
      acc += now - last;
      last = now;
      let stepped = false;
      while (acc >= 1000 / FPS) {
        acc -= 1000 / FPS;
        placed.forEach((p) => p.animator.step());
        stepped = true;
      }
      if (stepped) {
        draw();
        setTick(placed[0]?.animator.tick ?? 0);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [doc, rev, placed, floorPixels, room, playing, moves, hidden]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * room.width;
    const y = ((e.clientY - r.top) / r.height) * room.height;
    const { layers } = layersNow.current;
    for (let i = layers.length - 1; i >= 0; i--) {
      const { layer, x: tx, y: ty } = layers[i];
      const { locH, locV } = tileLoc(room, tx, ty);
      const s = spriteRect(layer, locH, locV);
      if (x >= s.left && x < s.left + layer.width && y >= s.top && y < s.top + layer.height && layer.letter !== 'sd') {
        onPick(layer.slot);
        return;
      }
    }
  };

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const shownZoom = zoom || Math.max(1, Math.min(4, Math.floor(stageWidth / room.width)));

  const savePicture = () => {
    const c = canvas.current;
    if (!c) return;
    const img = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    download(encodePng(new Uint8Array(img.data.buffer), c.width, c.height), `${cls || 'furni'}_${probe?.direction ?? direction}.png`, 'image/png');
  };

  const letters = probe?.letters ?? [];
  return (
    <div className="preview">
      <div className="pane-head">
        <span className="pane-title"><Icon name="room" size={14} />Room</span>
        <span className="dir-pills" title="Direction">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((d) => (
            <button key={d} className={`dir${d === direction ? ' on' : ''}`} onClick={() => setDirection(d)} disabled={allDirections || (own.length > 0 && !own.includes(d))} title={own.length && !own.includes(d) ? 'The furni has no members for this direction (the client never turns it here)' : `Direction ${d}`}>
              {d}
            </button>
          ))}
        </span>
        <button className="icon" onClick={() => setDirection(own.length ? rotateDirection(direction, own) : (direction + 2) % 8)} disabled={allDirections} title="Turn like the client does (to the next direction the furni has)">
          <Icon name="rotate" />
        </button>
        <label className="chip" title="Every direction the furni has, side by side"><input type="checkbox" checked={allDirections} onChange={(e) => setAllDirections(e.target.checked)} />all</label>
        {probe && probe.direction !== direction && !allDirections && <span className="muted small">shows {probe.direction}</span>}
        <span className="spacer" />
        <select value={state} onChange={(e) => setState(+e.target.value)} title="State (.data)">
          {states.map((s, i) => <option key={i} value={i}>{i}: {s}</option>)}
        </select>
        <button className={`icon${playing && moves ? ' primary' : ''}`} onClick={() => setPlaying(!playing)} disabled={!moves} title={moves ? (playing ? 'Pause' : 'Play') : 'This state doesn\'t move'}>
          <Icon name={playing && moves ? 'pause' : 'play'} />
        </button>
        <span className="frame-count">{moves ? `frame ${tick}` : 'still'}</span>
      </div>
      <div className="preview-sub">
        <input className="colors" placeholder="#FFFFFF,#F7EBBC (items_definitions.colour)" value={colors} onChange={(e) => setColors(e.target.value)} title="Part colours" spellCheck={false} />
        {variants.length > 0 && (
          <select value={variants.findIndex((v) => v.colour === colors)} onChange={(e) => setColors(variants[+e.target.value]?.colour ?? colors)} title="Colour variants (the hotel's items_definitions, or the imported Flash file's)">
            <option value={-1}>colours…</option>
            {variants.map((v, i) => <option key={i} value={i}>{v.label}</option>)}
          </select>
        )}
        <span className="layer-chips" title="Layers">
          {letters.map((l) => (
            <label key={l} className="chip" style={{ '--hue': (28 + (l.charCodeAt(0) - 97) * 67) % 360 } as React.CSSProperties}><input type="checkbox" checked={!hidden.has(l)} onChange={() => { const n = new Set(hidden); n.has(l) ? n.delete(l) : n.add(l); setHidden(n); }} />{l}</label>
          ))}
        </span>
      </div>
      <div className="preview-stage" ref={stage}>
        {probe ? (
          <canvas ref={canvas} onClick={pick} className={transparent ? 'checker' : undefined} style={{ width: room.width * shownZoom, height: room.height * shownZoom }} title="Click a layer to select its member" />
        ) : (
          <p className="empty">No floor furni layers found (layer a: <code>&lt;class&gt;_a_0_&lt;w&gt;_&lt;l&gt;_&lt;dir&gt;_&lt;frame&gt;</code>).</p>
        )}
      </div>
      <div className="pane-foot preview-foot">
        <label className="chip"><input type="checkbox" checked={shadow} onChange={(e) => setShadow(e.target.checked)} />shadow</label>
        <label className="chip"><input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />grid</label>
        <label className="chip" title="Light up the tiles the furni stands on (as Odin counts them)"><input type="checkbox" checked={showFootprint} onChange={(e) => setShowFootprint(e.target.checked)} />tiles</label>
        {hasSmall && !smallCast && <label className="chip" title="The 32 px members in this cast"><input type="checkbox" checked={small} onChange={(e) => setSmall(e.target.checked)} />32 px</label>}
        <label className="chip" title="Draw the room on a transparent background (saved pictures keep it)"><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />transparent</label>
        <label className="swatch-label" title="Floor">floor <input type="color" value={floor} onChange={(e) => setFloor(e.target.value)} /></label>
        {!transparent && <label className="swatch-label" title="Background">bg <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} /></label>}
        <span className="spacer" />
        <select value={zoom} onChange={(e) => setZoom(+e.target.value)} title="Zoom">
          <option value={0}>fit</option>
          {[1, 2, 3, 4].map((z) => <option key={z} value={z}>{z}×</option>)}
        </select>
        <button className="icon" disabled={!probe} onClick={savePicture} title="Save picture: the room as drawn now, as a PNG"><Icon name="camera" /></button>
      </div>
    </div>
  );
}
