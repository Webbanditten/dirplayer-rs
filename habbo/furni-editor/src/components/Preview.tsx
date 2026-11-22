import { useEffect, useMemo, useRef, useState } from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import { Animator, FPS } from '../animation';
import { floorSetup, ownDirections, stateNames, type FloorSetup, type Furni, type Layer } from '../furni';
import { composite, drawFloor, fitRoom, footprint, roomLayout, tileLoc, type Placement, type RoomLayout } from '../room';
import { spriteRect } from '../furni';

interface Props {
  doc: CastDocument;
  furni: Furni;
  rev: number;
  selected: number | null;
  onPick: (slot: number) => void;
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

export function Preview({ doc, furni, rev, selected, onPick }: Props) {
  const [direction, setDirection] = useState(2);
  const [state, setState] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [shadow, setShadow] = useState(true);
  const [colors, setColors] = useState('');
  const [allDirections, setAllDirections] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [stageWidth, setStageWidth] = useState(600);
  const stage = useRef<HTMLDivElement>(null);
  const [floor, setFloor] = useState('#989865');
  const [background, setBackground] = useState('#000000');
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
    if (!cls) return;
    fetch(`/hotel-api/furni/search?query=${encodeURIComponent(cls)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: HotelFurni[]) => {
        if (!live || !Array.isArray(list)) return;
        const mine = list.filter((f) => f.sprite?.split('*')[0].toLowerCase() === cls.toLowerCase());
        mine.sort((a, b) => (a.sprite.includes('*') ? 1 : 0) - (b.sprite.includes('*') ? 1 : 0) || a.sprite.localeCompare(b.sprite, undefined, { numeric: true }));
        setHotel(mine);
        if (mine[0]?.colour) setColors(mine[0].colour);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cls]);
  const [tick, setTick] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);

  const hasSmall = useMemo(() => furni.members.some((m) => m.name.toLowerCase().startsWith('s_' + furni.className().toLowerCase() + '_')), [furni]);
  const useSmall = small && hasSmall;
  const probe = useMemo(() => floorSetup(furni, { direction, state, colors, shadow, small: useSmall }), [furni, direction, state, colors, shadow, useSmall]);
  const states = probe ? stateNames(probe.data) : ['default'];
  const own = useMemo(() => ownDirections(furni, useSmall), [furni, useSmall]);

  // Where furni go: one in the middle, or every direction it has side by side.
  const { room, placed } = useMemo(() => {
    const dims = probe?.dims ?? [1, 1];
    const span = Math.max(dims[0], dims[1]) + 1;
    const dirs = allDirections ? [0, 2, 4, 6].filter((d) => floorSetup(furni, { direction: d, state, small: useSmall })?.direction === d) : [direction];
    const cols = allDirections ? Math.max(1, dirs.length) * span + 1 : span + 1;
    const rows = span + 1;
    const placed: Placed[] = [];
    dirs.forEach((d, i) => {
      const setup = floorSetup(furni, { direction: d, state, colors, shadow, small: useSmall });
      if (!setup) return;
      placed.push({ setup, x: 1 + (allDirections ? i * span : 0), y: 1, animator: new Animator(setup.data, setup.letters, state) });
    });
    const room = fitRoom(roomLayout({ cols, rows }), placed.map((p) => ({ x: p.x, y: p.y, layers: p.setup.layersAt() })));
    return { room, placed };
  }, [furni, direction, state, colors, shadow, allDirections, useSmall, probe]);

  const floorPixels = useMemo(() => {
    const highlight = new Set<string>();
    if (showFootprint) for (const p of placed) footprint(p.x, p.y, p.setup.dims, p.setup.direction).forEach((t) => highlight.add(t));
    return drawFloor(room, { floor, background, grid, highlight });
  }, [room, placed, floor, background, grid, showFootprint]);

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
        c.getContext('2d')!.putImageData(composite(doc, room, floorPixels, placements), 0, 0);
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

  const letters = probe?.letters ?? [];
  return (
    <div className="preview">
      <div className="preview-controls">
        <div className="row">
          <span>Direction</span>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((d) => (
            <button key={d} className={`dir${d === direction ? ' on' : ''}${own.includes(d) ? ' own' : ''}`} onClick={() => setDirection(d)} disabled={allDirections} title={own.includes(d) ? 'Has members of its own' : 'Alias or direction 0 fallback'}>
              {d}
            </button>
          ))}
          <button onClick={() => setDirection((direction + 2) % 8)} disabled={allDirections} title="Turn like the client (by 2)">⟳</button>
          {probe && probe.direction !== direction && !allDirections && <span className="muted">shows {probe.direction}</span>}
          <label><input type="checkbox" checked={allDirections} onChange={(e) => setAllDirections(e.target.checked)} /> all</label>
        </div>
        <div className="row">
          <span>State</span>
          <select value={state} onChange={(e) => setState(+e.target.value)}>
            {states.map((s, i) => <option key={i} value={i}>{i}: {s}</option>)}
          </select>
          <button onClick={() => setPlaying(!playing)} disabled={!moves}>{playing && moves ? '❚❚ Pause' : '▶ Play'}</button>
          {moves && <span className="muted">frame {tick}</span>}
          {!moves && <span className="muted">still</span>}
          <span className="spacer" />
          <label><input type="checkbox" checked={shadow} onChange={(e) => setShadow(e.target.checked)} /> shadow</label>
          {hasSmall && <label><input type="checkbox" checked={small} onChange={(e) => setSmall(e.target.checked)} /> small (32)</label>}
        </div>
        <div className="row">
          <span>Colours</span>
          <input className="colors" placeholder="#FFFFFF,#F7EBBC (items_definitions.colour)" value={colors} onChange={(e) => setColors(e.target.value)} />
          {hotel.length > 0 && (
            <select value={hotel.find((f) => f.colour === colors)?.sprite ?? ''} onChange={(e) => setColors(hotel.find((f) => f.sprite === e.target.value)?.colour ?? '')} title="Colour variants in the hotel (items_definitions)">
              <option value="">hotel colours…</option>
              {hotel.map((f) => <option key={f.id} value={f.sprite}>{f.sprite}: {f.name}</option>)}
            </select>
          )}
        </div>
        <div className="row">
          <span>Layers</span>
          {letters.map((l) => (
            <label key={l}><input type="checkbox" checked={!hidden.has(l)} onChange={() => { const n = new Set(hidden); n.has(l) ? n.delete(l) : n.add(l); setHidden(n); }} />{l}</label>
          ))}
          <span className="spacer" />
          <label><input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> grid</label>
          <label><input type="checkbox" checked={showFootprint} onChange={(e) => setShowFootprint(e.target.checked)} /> tiles</label>
          <input type="color" value={floor} onChange={(e) => setFloor(e.target.value)} title="Floor" />
          <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} title="Background" />
          <select value={zoom} onChange={(e) => setZoom(+e.target.value)}>
            <option value={0}>fit</option>
            {[1, 2, 3, 4].map((z) => <option key={z} value={z}>{z}×</option>)}
          </select>
        </div>
      </div>
      <div className="preview-stage" ref={stage}>
        {probe ? (
          <canvas ref={canvas} onClick={pick} style={{ width: room.width * shownZoom, height: room.height * shownZoom }} title="Click a layer to select its member" />
        ) : (
          <p className="muted">No floor furni layers found (layer a: &lt;class&gt;_a_0_&lt;w&gt;_&lt;l&gt;_&lt;dir&gt;_&lt;frame&gt;).</p>
        )}
      </div>
      {selected !== null && <p className="muted small">Selected member #{selected}</p>}
    </div>
  );
}
