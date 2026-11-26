import type React from 'react';
import { Icon } from './Icon';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import { Animator, FPS } from '../animation';
import { furniSetup, isWallItem, ownDirections, rotateDirection, stateNames, type FloorSetup, type Furni, type Layer } from '../furni';
import { composite, drawFloor, fitRoom, footprint, placementLoc, roomLayout, tileLoc, wallAnchor, wallHeightFor, type Extra, type Placement, type RoomLayout } from '../room';
import { partOutline, tryPlace, wallParts } from '../wallplace';
import { DEFAULT_FIGURE, habboDepth, habboRect, habboUrl, loadHabbo, type HabboPicture, type HabboPose } from '../habbo';
import { tileSpan } from '../tiles';
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
  /** the view: the direction it is turned to, the state (0-based) and the part colours (items_definitions.colour) */
  direction: number;
  setDirection: (d: number) => void;
  state: number;
  setState: (s: number) => void;
  colors: string;
  setColors: (c: string) => void;
  onMakeIcon?: (view: { direction: number; state: number; colors: string }) => void;
  /** a Habbo in the room: standing beside the furni, sitting or lying on it; `seat` is the seat's height (the
   *  definition's top_height) it sits or lies at */
  pose: HabboPose;
  setPose: (p: HabboPose) => void;
  seat: number;
  setSeat: (h: number) => void;
  /** the hotel's website, for its Habbo pictures */
  site: string;
  /** move mode: dragging in the room moves pictures (their registration points) instead of selecting them */
  moveMode?: boolean;
  setMoveMode?: (on: boolean) => void;
  /** the pictures to move, with the registration points they had when the drag began, and how far (room pixels) */
  onMove?: (targets: MoveTarget[], dx: number, dy: number, whole: boolean) => void;
}

export interface MoveTarget {
  slot: number;
  flip: boolean;
  regX: number;
  regY: number;
}

/** Where a direction faces on the screen (0 is away to the right, 2 towards you to the right...). */
const ARROWS: Record<number, string> = { 0: '↗', 1: '→', 2: '↘', 3: '↓', 4: '↙', 5: '←', 6: '↖', 7: '↑' };
const FACING: Record<number, string> = { 0: 'right-up (its back to you)', 2: 'right-down', 4: 'left-down', 6: 'left-up (its back to you)' };

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
  /** a wall item's wall (direction 2 left, 4 right) and how far below the wall's top it hangs */
  wall?: { direction: number; drop: number };
  animator: Animator;
}

export function Preview({ doc, furni, rev, selected, onPick, extraColors = [], direction, setDirection, state, setState, colors, setColors, onMakeIcon, pose, setPose, seat, setSeat, site, moveMode = false, setMoveMode, onMove }: Props) {
  const [playing, setPlaying] = useState(true);
  const [shadow, setShadow] = useState(true);
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
  // "try placing" (wall items): the item carried over the walls with the mouse, as the client's mover carries it
  const [placing, setPlacing] = useState(false);
  const [hand, setHand] = useState<{ x: number; y: number } | null>(null);
  const [put, setPut] = useState(false);
  const [handWall, setHandWall] = useState(2);

  // A small cast of its own (hh_furni_xx_s_...) always shows small; a cast with both sizes has the checkbox.
  const smallCast = useMemo(() => furni.isSmallCast(), [furni]);
  const hasSmall = useMemo(() => furni.members.some((m) => m.name.toLowerCase().startsWith('s_' + furni.className().toLowerCase() + '_')), [furni]);
  const useSmall = smallCast || (small && hasSmall);
  const wallItem = useMemo(() => isWallItem(furni), [furni, rev]);
  const probe = useMemo(() => furniSetup(furni, { direction, state, colors, shadow, small: useSmall }), [furni, direction, state, colors, shadow, useSmall, rev]);
  const states = probe ? stateNames(probe.data) : ['default'];
  const shownDirection = probe?.direction ?? direction;
  const own = useMemo(() => ownDirections(furni, useSmall), [furni, useSmall]);
  // Stay on directions the furni has: 2 when it has it, else its first.
  useEffect(() => {
    if (own.length && !own.includes(direction)) setDirection(own.includes(2) ? 2 : own[0]);
  }, [own, direction]);

  // Where furni go: one in the middle, or every direction it has side by side; a wall item on its wall (with "all",
  // the left and the right wall at once).
  const placingNow = placing && wallItem;
  const { room, placed } = useMemo(() => {
    if (placingNow) {
      // Two walls with room to carry the item along them, and around them for where it can't go.
      const tile = useSmall ? 32 : 64;
      const setup = furniSetup(furni, { direction: handWall, state, colors, shadow: false, small: useSmall });
      const layers = setup?.layersAt() ?? [];
      if (setup && layers.length) {
        const widest = Math.max(...layers.map((l) => l.width)), tallest = Math.max(...layers.map((l) => l.height));
        const span = Math.max(5, Math.ceil(widest / (tile / 2)) + 3);
        const base = roomLayout({ cols: span, rows: span }, tile, wallHeightFor(tile));
        const pad = Math.round(Math.max(tile, widest, tallest) / 2);
        const room = { ...base, xOffset: base.xOffset + pad, yOffset: base.yOffset + pad, width: base.width + 2 * pad, height: base.height + 2 * pad };
        return { room, placed: [{ setup, x: 0, y: 0, wall: { direction: setup.direction, drop: 0 }, animator: new Animator(setup.data, setup.letters, state) }] as Placed[] };
      }
    }
    if (wallItem) {
      const tile = useSmall ? 32 : 64;
      const dirs = allDirections ? (own.length ? own : [direction]) : [direction];
      const placed: Placed[] = [];
      const wallHeight = wallHeightFor(tile);
      let widest = 0;
      for (const d of dirs) {
        const setup = furniSetup(furni, { direction: d, state, colors, shadow: false, small: useSmall });
        if (!setup || placed.some((p) => p.setup.direction === setup.direction)) continue;
        const layers = setup.layersAt();
        const above = Math.max(0, ...layers.map((l) => l.regY - l.shiftY));
        const below = Math.max(0, ...layers.map((l) => l.height - l.regY + l.shiftY));
        widest = Math.max(widest, ...layers.map((l) => l.width));
        // centred on the wall's height (the wall keeps the client's height: a taller item sticks out above and below)
        const drop = Math.round(wallHeight / 2 + (above - below) / 2);
        placed.push({ setup, x: 0, y: 0, wall: { direction: setup.direction, drop }, animator: new Animator(setup.data, setup.letters, state) });
      }
      // Walls long enough for the item: a wall climbs half a tile to the side per tile, plus a tile either side.
      const span = Math.max(3, Math.ceil(widest / (tile / 2)) + 2);
      const room = fitRoom(roomLayout({ cols: span, rows: span }, tile, wallHeight), placed.map((p) => ({ x: p.x, y: p.y, wall: p.wall, layers: p.setup.layersAt() })));
      return { room, placed };
    }
    const dims = probe?.dims ?? [1, 1];
    const span = Math.max(dims[0], dims[1]) + 1;
    const dirs = allDirections ? (own.length ? own : [direction]) : [direction];
    const cols = allDirections ? Math.max(1, dirs.length) * span + 1 : span + 1;
    const rows = span + 1;
    const placed: Placed[] = [];
    dirs.forEach((d, i) => {
      const setup = furniSetup(furni, { direction: d, state, colors, shadow, small: useSmall });
      if (!setup) return;
      placed.push({ setup, x: 1 + (allDirections ? i * span : 0), y: 1, animator: new Animator(setup.data, setup.letters, state) });
    });
    // Room for the Habbo too: its canvas over each tile it can be on (64 x 110 above the tile point, lifted by the seat).
    const tile = useSmall ? 32 : 64;
    const habboBoxes = (p: Placed): Layer[] => {
      if (pose === 'none') return [];
      const [w, l] = tileSpan(p.setup.dims, p.setup.direction);
      const tiles = pose === 'stand' ? [[0, l]] : pose === 'lay' ? [[0, 0]] : Array.from({ length: w * l }, (_, k) => [k % w, Math.floor(k / w)]);
      const lift = pose === 'stand' ? 0 : Math.round((seat - 1) * (tile / 2));
      return tiles.map(([i, j]) => ({
        name: 'habbo', letter: 'habbo', slot: 0, flip: false, ink: 0, blend: 100, z: 0, order: 0, shiftX: 0, shiftY: 0, xFactor: tile,
        width: pose === 'lay' ? Math.round(tile * 1.5) : tile, height: Math.round(tile * 1.75),
        regX: -((i - j) * tile) / 2, regY: Math.round(tile * 1.6) + lift - ((i + j) * tile) / 4,
      }));
    };
    const room = fitRoom(roomLayout({ cols, rows }, tile), placed.map((p) => ({ x: p.x, y: p.y, layers: [...p.setup.layersAt(), ...habboBoxes(p)] })));
    return { room, placed };
  }, [furni, direction, state, colors, shadow, allDirections, useSmall, probe, own, wallItem, rev, pose, seat, placingNow, handWall]);

  // Carried with the mouse: where its registration point is, the rectangle the client tests, and the client's answer.
  const attempt = useMemo(() => {
    const layers = placingNow ? placed[0]?.setup.layersAt() ?? [] : [];
    if (!layers.length) return null;
    // the client goes by the item's first sprite: its first layer
    const first = layers.reduce((a, b) => (b.order < a.order ? b : a));
    const start = wallAnchor(room, 2, Math.round(room.wallHeight / 2));
    const at = hand ?? { x: Math.round(start.locH), y: Math.round(start.locV) };
    // from the member's registration point and size, not mirrored even when the picture is (as the client has it)
    const box = { left: at.x - first.regX, top: at.y - first.regY, right: at.x - first.regX + first.width, bottom: at.y - first.regY + first.height };
    return { at, box, result: tryPlace(room, box, at) };
  }, [placingNow, placed, room, hand]);
  // the wall under the hand decides which picture is shown, the left wall's or the right wall's
  useEffect(() => {
    const wall = attempt?.result.ok ? (attempt.result.wall === 'left' ? 2 : 4) : 0;
    if (wall && wall !== handWall) setHandWall(wall);
  }, [attempt, handWall]);

  // The Habbos in the room: beside the furni (standing), on each of its tiles (sitting, at most four) or on its first
  // tile (lying), turned like the furni.
  const habbos = useMemo(() => {
    if (pose === 'none' || wallItem) return [];
    const out: { x: number; y: number; direction: number }[] = [];
    for (const p of placed) {
      const [w, l] = tileSpan(p.setup.dims, p.setup.direction);
      if (pose === 'stand') out.push({ x: p.x, y: p.y + l, direction: 2 });
      else if (pose === 'lay') out.push({ x: p.x, y: p.y, direction: p.setup.direction });
      else {
        for (let i = 0; i < w; i++) for (let j = 0; j < l; j++) if (out.length < 4 * placed.length) out.push({ x: p.x + i, y: p.y + j, direction: p.setup.direction });
      }
    }
    return out;
  }, [placed, pose, wallItem]);
  const [pictures, setPictures] = useState<Map<number, HabboPicture | null>>(new Map());
  const [habboFailed, setHabboFailed] = useState(false);
  useEffect(() => {
    if (pose === 'none') return;
    let live = true;
    const dirs = [...new Set(habbos.map((h) => h.direction))];
    Promise.all(dirs.map((d) => loadHabbo(habboUrl(site, DEFAULT_FIGURE, pose, d, useSmall)))).then((list) => {
      if (!live) return;
      setPictures(new Map(dirs.map((d, i) => [d, list[i]])));
      setHabboFailed(list.some((p) => !p));
    });
    return () => {
      live = false;
    };
  }, [habbos, pose, useSmall, site]);
  const extras: Extra[] = useMemo(() => {
    if (pose === 'none') return [];
    const out: Extra[] = [];
    for (const h of habbos) {
      const picture = pictures.get(h.direction);
      if (!picture) continue;
      const { locH, locV } = tileLoc(room, h.x, h.y);
      out.push({ picture, ...habboRect(pose, useSmall, picture, locH, locV, seat, h.direction), z: habboDepth(h.x + h.y, pose) });
    }
    return out;
  }, [habbos, pictures, room, pose, seat, useSmall]);

  const floorPixels = useMemo(() => {
    const highlight = new Set<string>();
    if ((showFootprint || moveMode) && !wallItem) for (const p of placed) footprint(p.x, p.y, p.setup.dims, p.setup.direction).forEach((t) => highlight.add(t));
    const style = { floor, grid, highlight };
    return transparent
      ? { black: drawFloor(room, { ...style, background: '#000000' }), white: drawFloor(room, { ...style, background: '#ffffff' }) }
      : { black: drawFloor(room, { ...style, background }), white: undefined };
  }, [room, placed, floor, background, grid, showFootprint, moveMode, transparent]);

  const moves = placed.some((p) => p.animator.moves);
  const layersNow = useRef<{ room: RoomLayout; layers: { layer: Layer; x: number; y: number; wall?: Placed['wall'] }[] }>({ room, layers: [] });

  // Draw now, and every 1/24 s while animating.
  useEffect(() => {
    const draw = () => {
      const placements: Placement[] = placed.map((p) => ({
        x: p.x,
        y: p.y,
        wall: p.wall && attempt ? { ...p.wall, at: { locH: attempt.at.x, locV: attempt.at.y } } : p.wall,
        ghost: attempt ? !attempt.result.ok : undefined,
        layers: p.setup.layersAt(p.animator.choice()),
        hidden,
      }));
      layersNow.current = { room, layers: placements.flatMap((p) => p.layers.map((layer) => ({ layer, x: p.x, y: p.y, wall: p.wall }))) };
      const c = canvas.current;
      if (!c) return;
      c.width = room.width;
      c.height = room.height;
      try {
        c.getContext('2d')!.putImageData(composite(doc, room, floorPixels.black, placements, floorPixels.white, extras), 0, 0);
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
  }, [doc, rev, placed, floorPixels, room, playing, moves, hidden, extras, attempt]);

  const carry = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (put) return;
    const r = e.currentTarget.getBoundingClientRect();
    setHand({ x: Math.floor(((e.clientX - r.left) / r.width) * room.width), y: Math.floor(((e.clientY - r.top) / r.height) * room.height) });
  };
  /** A click puts it down where the client would take it, or picks it up again. */
  const putDown = () => {
    if (put) setPut(false);
    else if (attempt?.result.ok) setPut(true);
  };

  /** The front-most layer under the mouse (the shadow only when asked for and nothing else is there). */
  const layerAt = (e: React.MouseEvent<HTMLCanvasElement>, withShadow = false) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * room.width;
    const y = ((e.clientY - r.top) / r.height) * room.height;
    const { layers } = layersNow.current;
    for (const shadows of withShadow ? [false, true] : [false]) {
      for (let i = layers.length - 1; i >= 0; i--) {
        const { layer } = layers[i];
        if ((layer.letter === 'sd') !== shadows) continue;
        const { locH, locV } = placementLoc(room, layers[i]);
        const s = spriteRect(layer, locH, locV);
        if (x >= s.left && x < s.left + layer.width && y >= s.top && y < s.top + layer.height) return layers[i];
      }
    }
    return null;
  };
  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = layerAt(e);
    if (hit) onPick(hit.layer.slot);
  };

  // Move mode: drag the furni (every layer of the one under the mouse, not its shadow) or, with Alt, one layer; the
  // arrow keys move what was last dragged by a pixel.
  const drag = useRef<{ targets: MoveTarget[]; whole: boolean; x: number; y: number; dx: number; dy: number } | null>(null);
  const lastMoved = useRef<{ slots: number[]; whole: boolean } | null>(null);
  const targetsOf = (slots: Set<number> | null, at: { x: number; y: number; wall?: Placed['wall'] }): MoveTarget[] =>
    layersNow.current.layers
      .filter((l) => l.x === at.x && l.y === at.y && l.wall?.direction === at.wall?.direction && (slots ? slots.has(l.layer.slot) : l.layer.letter !== 'sd'))
      .map((l) => ({ slot: l.layer.slot, flip: l.layer.flip, regX: l.layer.regX, regY: l.layer.regY }));
  const startMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!moveMode || !onMove || e.button !== 0) return;
    const hit = layerAt(e, true);
    if (!hit) return;
    e.preventDefault();
    e.currentTarget.focus();
    const one = e.altKey || hit.layer.letter === 'sd';
    const targets = targetsOf(one ? new Set([hit.layer.slot]) : null, hit);
    drag.current = { targets, whole: !one, x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
    lastMoved.current = { slots: targets.map((t) => t.slot), whole: !one };
    onPick(hit.layer.slot);
  };
  const scale = () => {
    const c = canvas.current;
    return c ? c.getBoundingClientRect().width / Math.max(1, c.width) : 1;
  };
  useEffect(() => {
    if (!moveMode) return;
    const onMouseMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = Math.round((e.clientX - d.x) / scale()), dy = Math.round((e.clientY - d.y) / scale());
      if (dx === d.dx && dy === d.dy) return;
      d.dx = dx;
      d.dy = dy;
      onMove?.(d.targets, dx, dy, d.whole);
    };
    const onMouseUp = () => {
      drag.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  });
  const nudge = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const k = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
    if (!k || !moveMode || !onMove) return;
    e.preventDefault();
    const { layers } = layersNow.current;
    const want = lastMoved.current;
    const first = layers.find((l) => (want ? want.slots.includes(l.layer.slot) : l.layer.letter !== 'sd'));
    if (!first) return;
    const targets = targetsOf(want ? new Set(want.slots) : null, first);
    const by = e.shiftKey ? 8 : 1;
    onMove(targets, k[0] * by, k[1] * by, want?.whole ?? true);
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
  const tinted = useMemo(() => !!probe?.layersAt().some((l) => l.ink === 41), [probe]);
  return (
    <div className="preview">
      <div className="pane-head">
        <span className="pane-title"><Icon name="room" size={14} />Room</span>
        <span className="dir-pills" title={wallItem ? 'The wall it hangs on' : 'The way it faces (the hotel turns furni to 0, 2, 4 and 6)'}>
          {(wallItem ? [2, 4] : [...new Set([0, 2, 4, 6, ...own])].sort((a, b) => a - b)).map((d) => (
            <button key={d} className={`dir${d === shownDirection ? ' on' : ''}`} onClick={() => setDirection(d)} disabled={allDirections || (own.length > 0 && !own.includes(d))} title={own.length && !own.includes(d) ? (wallItem ? 'No pictures for this wall' : `The furni has no pictures for direction ${d}: the hotel never turns it there`) : wallItem ? (d === 4 ? 'The right wall' : 'The left wall') : `Direction ${d}: facing ${FACING[d] ?? ''}`}>
              {wallItem ? (d === 4 ? 'right wall' : 'left wall') : <><span className="arrow">{ARROWS[d] ?? ''}</span>{d}</>}
            </button>
          ))}
        </span>
        <button className="icon" onClick={() => setDirection(own.length ? rotateDirection(direction, own) : (direction + 2) % 8)} disabled={allDirections} title="Turn like the client does (to the next direction the furni has)">
          <Icon name="rotate" />
        </button>
        <label className="chip" title={wallItem ? 'Both walls at once' : 'Every direction the furni has, side by side'}><input type="checkbox" checked={allDirections} onChange={(e) => setAllDirections(e.target.checked)} />{wallItem ? 'both walls' : 'all'}</label>
        <span className="spacer" />
        {states.length > 1 && (
          <select value={state} onChange={(e) => setState(+e.target.value)} title="The state it is in (the States tab says what each shows)">
            {states.map((s, i) => <option key={i} value={i}>{i + 1}: {s}</option>)}
          </select>
        )}
        {moves && (
          <>
            <button className={`icon${playing ? ' primary' : ''}`} onClick={() => setPlaying(!playing)} title={playing ? 'Pause' : 'Play'}>
              <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <span className="frame-count">frame {tick}</span>
          </>
        )}
      </div>
      <div className="preview-sub">
        {(tinted || variants.length > 0 || colors.trim() !== '') && <input className="colors" placeholder="#FFFFFF,#F7EBBC" value={colors} onChange={(e) => setColors(e.target.value)} title="Part colours, one per layer (a, b, c...): what tinted layers are coloured with (items_definitions.colour). The Layers tab has a colour picker per tinted layer" spellCheck={false} />}
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
          <div className="stage-canvas" style={{ width: room.width * shownZoom, height: room.height * shownZoom }}>
            <canvas
              ref={canvas}
              tabIndex={moveMode && !attempt ? 0 : undefined}
              onClick={attempt ? putDown : moveMode ? undefined : pick}
              onMouseDown={attempt ? undefined : startMove}
              onMouseMove={attempt ? carry : undefined}
              onKeyDown={nudge}
              className={[transparent ? 'checker' : '', moveMode && !attempt ? 'moving' : '', attempt ? 'placing' : ''].filter(Boolean).join(' ') || undefined}
              style={{ width: room.width * shownZoom, height: room.height * shownZoom }}
              title={attempt ? undefined : moveMode ? 'Drag the furni to place it on its tiles (Alt: only the layer under the mouse); the arrow keys move it by a pixel, with Shift by 8' : 'Click a layer to select its member'}
            />
            {attempt && (
              <svg className="place-overlay" viewBox={`0 0 ${room.width} ${room.height}`}>
                {wallParts(room).map((p) => {
                  const on = attempt.result.part && attempt.result.part.wall === p.wall && attempt.result.part.x === p.x && attempt.result.part.y === p.y;
                  return <polygon key={`${p.wall}${p.x},${p.y}`} className={on ? 'part on' : 'part'} points={partOutline(p).map((c) => c.join(',')).join(' ')} />;
                })}
                <rect className={attempt.result.rect.inside ? 'box ok' : 'box no'} x={attempt.box.left} y={attempt.box.top} width={attempt.box.right - attempt.box.left} height={attempt.box.bottom - attempt.box.top} />
                <circle className={attempt.result.rect.upperOk ? 'corner ok' : 'corner no'} cx={attempt.result.rect.upper[0]} cy={attempt.result.rect.upper[1]} r={1.6} />
                <circle className={attempt.result.rect.lowerOk ? 'corner ok' : 'corner no'} cx={attempt.result.rect.lower[0]} cy={attempt.result.rect.lower[1]} r={1.6} />
                <g className={attempt.result.ok ? 'hand ok' : attempt.result.rect.inside ? 'hand no' : 'hand'}>
                  <line x1={attempt.at.x - 6} y1={attempt.at.y + 0.5} x2={attempt.at.x + 7} y2={attempt.at.y + 0.5} />
                  <line x1={attempt.at.x + 0.5} y1={attempt.at.y - 6} x2={attempt.at.x + 0.5} y2={attempt.at.y + 7} />
                  <circle cx={attempt.at.x + 0.5} cy={attempt.at.y + 0.5} r={2.5} />
                </g>
              </svg>
            )}
          </div>
        ) : (
          wallItem ? (
            <p className="empty">No wall item layers found (layer a: <code>leftwall &lt;class&gt;_a_&lt;frame&gt;</code> or <code>rightwall …</code>, with a <code>&lt;class&gt;.data</code> listing the layers).</p>
          ) : (
            <p className="empty">No floor furni layers found (layer a: <code>&lt;class&gt;_a_0_&lt;w&gt;_&lt;l&gt;_&lt;dir&gt;_&lt;frame&gt;</code>).</p>
          )
        )}
      </div>
      {attempt && (
        <div className="place-note">
          <p className={attempt.result.ok ? 'ok' : 'no'}>
            {put
              ? <>Placed at <code>{attempt.result.location}</code>. Click it to pick it up again.</>
              : attempt.result.ok
                ? <>It can go here: <code>{attempt.result.location}</code> ({attempt.result.wall} wall, part {attempt.result.part!.x},{attempt.result.part!.y}; the hand is {attempt.result.local![0]}, {attempt.result.local![1]} into it). Click to put it down.</>
                : attempt.result.reason}
          </p>
          <p className="legend">
            The cross is the hand: the first picture's registration point, which is where the item is placed. The dashed box is that picture's rectangle
            as the hotel counts it (from the registration point, never mirrored): all of it has to be inside one wall, and the two dots are the corners the hotel checks.
            The lit wall part is the one the place is counted from.
          </p>
        </div>
      )}
      <div className="pane-foot preview-foot">
        {setMoveMode && onMove && <label className="chip" title="Drag the furni in the room to place it on its tiles (it moves its pictures' registration points). Alt-drag moves only the layer under the mouse"><input type="checkbox" checked={moveMode} onChange={(e) => setMoveMode(e.target.checked)} />move</label>}
        {wallItem && (
          <label className="chip" title="Carry the item over the walls with the mouse, as the hotel does when you place it: see where it can go, which point is in your hand and what has to fit on the wall">
            <input type="checkbox" checked={placing} onChange={(e) => { setPlacing(e.target.checked); setPut(false); setHand(null); }} />try placing
          </label>
        )}
        {!wallItem && <label className="chip"><input type="checkbox" checked={shadow} onChange={(e) => setShadow(e.target.checked)} />shadow</label>}
        <label className="chip"><input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />grid</label>
        {!wallItem && <label className="chip" title="Light up the tiles the furni stands on (as Odin counts them)"><input type="checkbox" checked={showFootprint} onChange={(e) => setShowFootprint(e.target.checked)} />tiles</label>}
        {hasSmall && !smallCast && <label className="chip" title="The 32 px members in this cast"><input type="checkbox" checked={small} onChange={(e) => setSmall(e.target.checked)} />32 px</label>}
        <label className="chip" title="Draw the room on a transparent background (saved pictures keep it)"><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />transparent</label>
        <label className="swatch-label" title="Floor">floor <input type="color" value={floor} onChange={(e) => setFloor(e.target.value)} /></label>
        {!transparent && <label className="swatch-label" title="Background">bg <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} /></label>}
        {!wallItem && (
          <span className="habbo-ctl" title="A Habbo in the room, drawn where the hotel puts one: beside the furni for its size, or sitting / lying on it to set the seat's height and see which layers go in front of it (their depth, in the Layers tab)">
            <select value={pose} onChange={(e) => setPose(e.target.value as HabboPose)}>
              <option value="none">no Habbo</option>
              <option value="stand">Habbo beside it</option>
              <option value="sit">Habbo sitting on it</option>
              <option value="lay">Habbo lying on it</option>
            </select>
            {(pose === 'sit' || pose === 'lay') && (
              <label title="The seat's height in the furni's definition (Height when publishing): 1.0 is a usual chair, a bed is around 1.6. Each 0.1 lifts the Habbo about 3 px">
                seat <input type="number" min={0} max={10} step={0.1} value={seat} onChange={(e) => setSeat(Math.max(0, Math.min(10, Math.round((+e.target.value || 0) * 10) / 10)))} />
              </label>
            )}
            {pose !== 'none' && habboFailed && <span className="muted small" title="The hotel's Habbo pictures couldn't be loaded from this page">no picture</span>}
          </span>
        )}
        <span className="spacer" />
        <select value={zoom} onChange={(e) => setZoom(+e.target.value)} title="Zoom">
          <option value={0}>fit</option>
          {[1, 2, 3, 4].map((z) => <option key={z} value={z}>{z}×</option>)}
        </select>
        {onMakeIcon && <button disabled={!probe} onClick={() => onMakeIcon({ direction: shownDirection, state, colors })} title={`Make the icon (${cls}_small), the picture the hand, trades and the catalogue show, from this view: the furni in direction ${shownDirection}, this state and these colours`}><Icon name="image" size={14} />Make icon</button>}
        <button className="icon" disabled={!probe} onClick={savePicture} title="Save a picture of the room as it is drawn now (PNG)"><Icon name="camera" /></button>
      </div>
    </div>
  );
}
