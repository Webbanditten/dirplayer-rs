import { useEffect, useMemo, useRef, useState } from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import { CastDocument as CastDocumentClass } from '../wasm';
import type { Furni } from '../furni';
import {
  BUILTIN_PALETTES, XP_COLORS, blur, clone, ellipse, flip, floodFill, lightRamp, radialGradient, fromHex, fromRgbBytes, getPixel, greyRamp, hex, line, nearestIndex,
  paletteFromColors, rect, remap, resize, spray, stamp, toIndexed, toRgba, toRgbaImage, toRgbBytes, type Ink, type PaintImage, type ShapeFill,
} from '../paint';

type Tool = 'pencil' | 'brush' | 'eraser' | 'fill' | 'picker' | 'zoom' | 'airbrush' | 'line' | 'rect' | 'ellipse' | 'gradient' | 'reg';

const TOOLS: { id: Tool; icon: string; name: string; key: string }[] = [
  { id: 'reg', icon: '✛', name: 'Registration point (drag)', key: 'g' },
  { id: 'eraser', icon: '▱', name: 'Eraser (paints the background: index 0 / transparent)', key: 'e' },
  { id: 'fill', icon: '🪣', name: 'Fill with colour', key: 'f' },
  { id: 'picker', icon: '💧', name: 'Pick colour', key: 'k' },
  { id: 'zoom', icon: '🔍', name: 'Magnifier (right click: out)', key: 'z' },
  { id: 'pencil', icon: '✏️', name: 'Pencil', key: 'p' },
  { id: 'brush', icon: '🖌', name: 'Brush', key: 'b' },
  { id: 'airbrush', icon: '💨', name: 'Airbrush', key: 'a' },
  { id: 'line', icon: '╲', name: 'Line (Shift: 45°)', key: 'l' },
  { id: 'rect', icon: '▭', name: 'Rectangle (Shift: square)', key: 'r' },
  { id: 'ellipse', icon: '◯', name: 'Ellipse (Shift: circle)', key: 'o' },
  { id: 'gradient', icon: '◉', name: 'Radial gradient: drag from the centre, primary fading to secondary (Shift: circle). For glows: bright on black', key: 'd' },
];

interface Snapshot {
  img: PaintImage;
  regX: number;
  regY: number;
  /** palette member slot or built-in id (indexed only) */
  paletteId: number;
  /** that palette's colours (0xRRGGBB) at the time */
  palette: number[];
}

interface Props {
  doc: CastDocument;
  furni: Furni;
  slot: number;
  edit: (what: string, fn: () => void) => void;
  onClose: () => void;
}

const PAD = 12;

export function Paint({ doc, furni, slot, edit, onClose }: Props) {
  const member = furni.bySlot.get(slot);
  const header = member?.bitmap;

  const paletteColors = (id: number): number[] => {
    if (id > 0) return fromRgbBytes(doc.paletteColors(id));
    return fromRgbBytes(CastDocumentClass.builtinPalette(id));
  };

  const initial = useMemo<Snapshot | null>(() => {
    if (!header) return null;
    if (header.depth <= 8) {
      const px = doc.bitmapIndices(slot);
      const paletteId = header.paletteId;
      return { img: { kind: 'indexed', w: header.width, h: header.height, px }, regX: header.regX, regY: header.regY, paletteId, palette: paletteColors(paletteId) };
    }
    return { img: { kind: 'rgba', w: header.width, h: header.height, px: doc.rgba(slot) }, regX: header.regX, regY: header.regY, paletteId: 0, palette: [] };
    // Loaded once per member: the painting is the working copy from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot]);

  const [cur, setCur] = useState<Snapshot | null>(initial);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const [tool, setTool] = useState<Tool>('pencil');
  const lastTool = useRef<Tool>('pencil');
  const [size, setSize] = useState(1);
  const [shapeFill, setShapeFill] = useState<ShapeFill>('outline');
  const [zoom, setZoom] = useState(() => (header ? Math.max(1, Math.min(16, Math.floor(480 / Math.max(header.width, header.height, 1)))) : 4));
  const [grid, setGrid] = useState(true);
  const [zeroClear, setZeroClear] = useState(true);
  const [remapOnSwitch, setRemapOnSwitch] = useState(true);
  const black = initial?.img.kind === 'indexed' ? nearestIndex(initial.palette, 0x000000) : 0xff000000;
  const [primary, setPrimary] = useState<Ink>(black);
  const [secondary, setSecondary] = useState<Ink>(initial?.img.kind === 'indexed' ? 0 : 0xffffffff);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [resizeOpen, setResizeOpen] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const colorInput = useRef<HTMLInputElement>(null);
  const editIndex = useRef<number>(-1);
  const colorSession = useRef<number>(-1);
  const drag = useRef<{ button: number; x0: number; y0: number; x: number; y: number; base: PaintImage; work: PaintImage; timer?: number } | null>(null);
  const [, redraw] = useState(0);

  const indexed = cur?.img.kind === 'indexed';
  const transparentInk: Ink = indexed ? 0 : 0x00ffffff;

  /** Write a snapshot to the cast (the room preview follows). */
  const write = (s: Snapshot, what: string) =>
    edit(what, () => {
      if (s.img.kind === 'indexed') {
        if (s.paletteId > 0) {
          const now = fromRgbBytes(doc.paletteColors(s.paletteId));
          if (now.some((c, i) => c !== s.palette[i])) doc.setPaletteColors(s.paletteId, toRgbBytes(s.palette));
        }
        doc.setBitmapIndexed(slot, s.img.px, s.img.w, s.img.h, s.regX, s.regY, s.paletteId);
      } else {
        doc.setBitmap(slot, s.img.px, s.img.w, s.img.h, s.regX, s.regY, 'rgba', 0);
      }
    });

  const commit = (next: Partial<Snapshot>, what: string) => {
    if (!cur) return;
    if (!next.palette) colorSession.current = -1;
    const s = { ...cur, ...next };
    past.current.push(cur);
    future.current = [];
    setCur(s);
    write(s, what);
  };
  const undo = () => {
    const prev = past.current.pop();
    if (!prev || !cur) return;
    future.current.push(cur);
    setCur(prev);
    write(prev, 'Undo');
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next || !cur) return;
    past.current.push(cur);
    setCur(next);
    write(next, 'Redo');
  };

  // Keyboard: undo/redo, tool letters, Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.tagName === 'TEXTAREA' || (t?.tagName === 'INPUT' && ['text', 'number', 'search'].includes((t as HTMLInputElement).type))) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === 'Escape') {
        onClose();
      } else if (!mod) {
        const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
        if (t) setTool(t.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Draw the picture (or the stroke in progress), the pixel grid and the registration point.
  const shown = drag.current?.work ?? cur?.img;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !cur || !shown) return;
    const { w, h } = shown;
    c.width = (w + PAD * 2) * zoom;
    c.height = (h + PAD * 2) * zoom;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.putImageData(new ImageData(toRgba(shown, cur.palette, zeroClear), w, h), 0, 0);
    ctx.drawImage(tmp, PAD * zoom, PAD * zoom, w * zoom, h * zoom);
    if (grid && zoom >= 6) {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        ctx.moveTo((PAD + x) * zoom + 0.5, PAD * zoom);
        ctx.lineTo((PAD + x) * zoom + 0.5, (PAD + h) * zoom);
      }
      for (let y = 0; y <= h; y++) {
        ctx.moveTo(PAD * zoom, (PAD + y) * zoom + 0.5);
        ctx.lineTo((PAD + w) * zoom, (PAD + y) * zoom + 0.5);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.strokeRect(PAD * zoom - 0.5, PAD * zoom - 0.5, w * zoom + 1, h * zoom + 1);
    const rx = (PAD + cur.regX) * zoom + zoom / 2, ry = (PAD + cur.regY) * zoom + zoom / 2;
    ctx.strokeStyle = '#e0245e';
    ctx.beginPath();
    ctx.moveTo(rx - 12, Math.round(ry) + 0.5);
    ctx.lineTo(rx + 12, Math.round(ry) + 0.5);
    ctx.moveTo(Math.round(rx) + 0.5, ry - 12);
    ctx.lineTo(Math.round(rx) + 0.5, ry + 12);
    ctx.stroke();
  });

  if (!member || !header || !cur) return <div className="paint">This member isn't a bitmap.</div>;

  const toPixel = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / zoom) - PAD, y: Math.floor((e.clientY - r.top) / zoom) - PAD };
  };
  const inkFor = (button: number) => (button === 2 ? secondary : primary);
  const constrain = (x0: number, y0: number, x: number, y: number, shift: boolean, kind: Tool) => {
    if (!shift) return { x, y };
    const dx = x - x0, dy = y - y0;
    if (kind === 'line') {
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.max(Math.abs(dx), Math.abs(dy));
      return { x: x0 + Math.round(Math.cos(a) * len), y: y0 + Math.round(Math.sin(a) * len) };
    }
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: x0 + Math.sign(dx || 1) * m, y: y0 + Math.sign(dy || 1) * m };
  };
  const paintAt = (d: NonNullable<typeof drag.current>, x: number, y: number, shift: boolean) => {
    const c = tool === 'eraser' ? transparentInk : inkFor(d.button);
    const other = d.button === 2 ? primary : secondary;
    switch (tool) {
      case 'pencil':
        line(d.work, d.x, d.y, x, y, c, 1);
        break;
      case 'brush':
        line(d.work, d.x, d.y, x, y, c, size);
        break;
      case 'eraser':
        line(d.work, d.x, d.y, x, y, c, Math.max(2, size * 2));
        break;
      case 'line': {
        const p = constrain(d.x0, d.y0, x, y, shift, 'line');
        d.work = clone(d.base);
        line(d.work, d.x0, d.y0, p.x, p.y, c, size);
        break;
      }
      case 'gradient': {
        let rx = Math.abs(x - d.x0), ry = Math.abs(y - d.y0);
        if (shift) rx = ry = Math.max(rx, ry);
        d.work = clone(d.base);
        radialGradient(d.work, d.x0, d.y0, rx, ry, inkFor(d.button), other, cur.palette);
        break;
      }
      case 'rect':
      case 'ellipse': {
        const p = constrain(d.x0, d.y0, x, y, shift, tool);
        d.work = clone(d.base);
        (tool === 'rect' ? rect : ellipse)(d.work, d.x0, d.y0, p.x, p.y, c, other, shapeFill, size);
        break;
      }
    }
    d.x = x;
    d.y = y;
    redraw((n) => n + 1);
  };

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = toPixel(e);
    const button = e.button;
    if (tool === 'zoom') {
      setZoom((z) => (button === 2 ? Math.max(1, z / 2) : Math.min(32, z * 2)));
      return;
    }
    if (tool === 'picker') {
      const v = getPixel(cur.img, x, y);
      if (v >= 0) (button === 2 ? setSecondary : setPrimary)(v);
      setTool(lastTool.current);
      return;
    }
    if (tool === 'fill') {
      const work = clone(cur.img);
      floodFill(work, x, y, inkFor(button));
      commit({ img: work }, `Filled ${member.name}`);
      return;
    }
    if (tool === 'reg') {
      commit({ regX: x, regY: y }, `Registration point ${x}, ${y}`);
      drag.current = { button, x0: x, y0: y, x, y, base: cur.img, work: cur.img };
      return;
    }
    const d = { button, x0: x, y0: y, x, y, base: cur.img, work: clone(cur.img) } as NonNullable<typeof drag.current>;
    drag.current = d;
    if (tool === 'airbrush') {
      const puff = () => {
        spray(d.work, d.x, d.y, inkFor(button), 3 + size * 2);
        redraw((n) => n + 1);
      };
      puff();
      d.timer = window.setInterval(puff, 30);
      return;
    }
    if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') {
      if (tool === 'pencil') stamp(d.work, x, y, inkFor(button), 1);
      paintAt(d, x, y, e.shiftKey);
    }
  };
  const onMove = (e: React.MouseEvent) => {
    const p = toPixel(e);
    setHover(p);
    const d = drag.current;
    if (!d) return;
    if (tool === 'reg') {
      if (p.x !== cur.regX || p.y !== cur.regY) {
        setCur({ ...cur, regX: p.x, regY: p.y });
      }
      return;
    }
    if (tool === 'airbrush') {
      d.x = p.x;
      d.y = p.y;
      return;
    }
    paintAt(d, p.x, p.y, e.shiftKey);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.timer) clearInterval(d.timer);
    if (tool === 'reg') {
      write(cur, `Registration point ${cur.regX}, ${cur.regY}`);
      return;
    }
    commit({ img: d.work }, `${TOOLS.find((t) => t.id === tool)?.name ?? 'Drew'} on ${member.name}`);
  };

  // Palettes: the cast's palette members and the built-ins.
  const castPalettes = furni.members.filter((m) => m.type === 'palette');
  const usedBy = indexed && cur.paletteId > 0 ? furni.members.filter((m) => m.bitmap && m.bitmap.depth <= 8 && m.bitmap.paletteId === cur.paletteId).length : 0;
  const switchPalette = (id: number) => {
    const to = paletteColors(id);
    const img = remapOnSwitch && cur.img.kind === 'indexed' ? remap(cur.img, cur.palette, to) : cur.img;
    commit({ img, paletteId: id, palette: to }, `Palette of ${member.name}: ${id > 0 ? furni.bySlot.get(id)?.name : BUILTIN_PALETTES.find((p) => p.id === id)?.name}`);
  };
  const newPalette = (kind: string) => {
    if (!kind) return;
    const base =
      kind === 'copy' ? cur.palette
      : kind === 'ramp' ? greyRamp()
      : kind === 'light' ? lightRamp(0xffd060)
      : paletteFromColors([toRgba(cur.img, cur.palette, false) as unknown as Uint8Array]);
    const name = prompt('Name of the new palette', `${member.name.split('_')[0]} palette`);
    if (!name) return;
    let id = 0;
    edit(`New palette ${name}`, () => {
      id = doc.addPalette(name, toRgbBytes(base));
    });
    if (!id) return;
    if (cur.img.kind === 'indexed') {
      const img = kind === 'copy' || kind === 'light' ? cur.img : remap(cur.img, cur.palette, base);
      commit({ img, paletteId: id, palette: base }, `${member.name} on ${name}`);
    } else {
      commit({ img: toIndexed(cur.img.px, cur.img.w, cur.img.h, base), paletteId: id, palette: base }, `${member.name} as 8-bit on ${name}`);
      setPrimary(nearestIndex(base, 0x000000));
      setSecondary(0);
    }
  };
  const editColor = (index: number) => {
    if (cur.paletteId <= 0) {
      alertish('A built-in palette can’t be changed: make a copy with “New palette” first.');
      return;
    }
    editIndex.current = index;
    colorSession.current = -1;
    if (colorInput.current) {
      colorInput.current.value = hex(cur.palette[index] ?? 0);
      colorInput.current.click();
    }
  };
  const onColorChosen = (value: string) => {
    const i = editIndex.current;
    if (i < 0) return;
    const palette = cur.palette.slice();
    palette[i] = fromHex(value);
    // One picking session (the picker sends a change per drag step) is one undo step.
    if (colorSession.current === i) {
      const s = { ...cur, palette };
      setCur(s);
      write(s, `Palette colour ${i} = ${value}`);
    } else {
      colorSession.current = i;
      commit({ palette }, `Palette colour ${i} = ${value}`);
    }
  };
  const toEightBit = (target: string) => {
    if (!target || cur.img.kind !== 'rgba') return;
    if (target === 'new') return newPalette('picture');
    const id = Number(target);
    const pal = paletteColors(id);
    commit({ img: toIndexed(cur.img.px, cur.img.w, cur.img.h, pal), paletteId: id, palette: pal }, `${member.name} as 8-bit`);
    setPrimary(nearestIndex(pal, 0));
    setSecondary(0);
  };
  const toThirtyTwo = () => {
    commit({ img: toRgbaImage(cur.img, cur.palette), paletteId: 0, palette: [] }, `${member.name} as 32-bit`);
    setPrimary(0xff000000);
    setSecondary(0xffffffff);
  };

  const swatch = (c: Ink) => (indexed ? hex(cur.palette[c] ?? 0) : (c >>> 24) === 0 ? 'transparent' : hex(c));
  const hoverInfo = hover && hover.x >= 0 && hover.y >= 0 && hover.x < cur.img.w && hover.y < cur.img.h
    ? (() => {
        const v = getPixel(cur.img, hover.x, hover.y);
        return `${hover.x}, ${hover.y} · ${indexed ? `index ${v} ${hex(cur.palette[v] ?? 0)}` : `${hex(v)} alpha ${v >>> 24}`}`;
      })()
    : hover ? `${hover.x}, ${hover.y}` : '';

  return (
    <div className="paint">
      <div className="paint-head">
        <b>Paint: {member.name}</b>
        <span className="muted">{cur.img.w}×{cur.img.h}, {indexed ? '8-bit' : '32-bit'}, reg {cur.regX}, {cur.regY}</span>
        <span className="spacer" />
        <button onClick={undo} disabled={!past.current.length} title="Ctrl/Cmd+Z">↶ Undo</button>
        <button onClick={redo} disabled={!future.current.length} title="Ctrl/Cmd+Y">↷ Redo</button>
        <button onClick={() => commit({ img: flip(cur.img, true), regX: cur.img.w - cur.regX }, 'Flipped horizontally')}>⇋ Flip</button>
        <button onClick={() => commit({ img: flip(cur.img, false), regY: cur.img.h - cur.regY }, 'Flipped vertically')}>⇵ Flip</button>
        <select value="" onChange={(e) => e.target.value && commit({ img: blur(cur.img, +e.target.value, cur.palette) }, `Blurred ${member.name}`)} title="Soften the picture (a glow: draw a bright shape on black, then blur it)">
          <option value="">Blur…</option>
          {[1, 2, 3, 5, 8].map((r) => <option key={r} value={r}>radius {r}</option>)}
        </select>
        <button onClick={() => setResizeOpen(!resizeOpen)}>Canvas size…</button>
        <button className="primary" onClick={onClose} title="Esc">Done</button>
      </div>
      {resizeOpen && <ResizeForm img={cur.img} onApply={(w, h, ax, ay) => {
        const r = resize(cur.img, w, h, ax, ay, transparentInk);
        commit({ img: r.img, regX: cur.regX + r.dx, regY: cur.regY + r.dy }, `Canvas ${w}×${h}`);
        setResizeOpen(false);
      }} />}
      <div className="paint-body">
        <div className="toolbox">
          {TOOLS.map((t) => (
            <button key={t.id} className={tool === t.id ? 'on' : ''} title={`${t.name} (${t.key.toUpperCase()})`} onClick={() => {
              if (t.id === 'picker' && tool !== 'picker') lastTool.current = tool;
              setTool(t.id);
            }}>{t.icon}</button>
          ))}
          <div className="tool-options">
            {(tool === 'brush' || tool === 'eraser' || tool === 'line' || tool === 'rect' || tool === 'ellipse' || tool === 'airbrush') && (
              <>
                <div className="muted small">size</div>
                {[1, 2, 3, 5].map((s) => <button key={s} className={size === s ? 'on' : ''} onClick={() => setSize(s)}>{s}</button>)}
              </>
            )}
            {(tool === 'rect' || tool === 'ellipse') && (
              <>
                <div className="muted small">fill</div>
                {(['outline', 'both', 'fill'] as ShapeFill[]).map((f) => (
                  <button key={f} className={shapeFill === f ? 'on' : ''} onClick={() => setShapeFill(f)} title={{ outline: 'Outline', both: 'Outline (primary) and fill (secondary)', fill: 'Filled, no outline' }[f]}>
                    {{ outline: '▢', both: '▣', fill: '■' }[f]}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="paint-canvas-wrap">
          <div className="paint-canvas checker">
            <canvas ref={canvas} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => { setHover(null); onUp(); }} onContextMenu={(e) => e.preventDefault()} style={{ cursor: tool === 'zoom' ? 'zoom-in' : tool === 'reg' ? 'move' : 'crosshair' }} />
          </div>
          <div className="row small">
            <span className="muted">{hoverInfo}</span>
            <span className="spacer" />
            zoom <input type="range" min={1} max={32} value={zoom} onChange={(e) => setZoom(+e.target.value)} /> {zoom}×
            <label><input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> grid</label>
            {indexed && <label title="Show index 0 (the background the inks drop) see-through"><input type="checkbox" checked={zeroClear} onChange={(e) => setZeroClear(e.target.checked)} /> index 0 clear</label>}
          </div>
        </div>
      </div>
      <div className="colorbox">
        <div className="current" title="Primary (left button) and secondary (right button) colour">
          <span className="secondary" style={{ background: swatch(secondary) }} />
          <span className="primary" style={{ background: swatch(primary) }} />
        </div>
        {indexed ? (
          <div className="palette-grid">
            {cur.palette.slice(0, 256).map((c, i) => (
              <span key={i} className={`sw${i === primary ? ' p' : ''}${i === secondary ? ' s' : ''}`} style={{ background: hex(c) }} title={`${i}: ${hex(c)}${i === 0 ? ' (background)' : ''} · double-click to change`}
                onMouseDown={(e) => { e.preventDefault(); (e.button === 2 ? setSecondary : setPrimary)(i); }} onContextMenu={(e) => e.preventDefault()} onDoubleClick={() => editColor(i)} />
            ))}
          </div>
        ) : (
          <div className="xp-colors">
            <span className="sw clear" title="Transparent" onMouseDown={(e) => { e.preventDefault(); (e.button === 2 ? setSecondary : setPrimary)(0x00ffffff); }} onContextMenu={(e) => e.preventDefault()} />
            {XP_COLORS.map((c) => (
              <span key={c} className="sw" style={{ background: hex(c) }} title={hex(c)} onMouseDown={(e) => { e.preventDefault(); (e.button === 2 ? setSecondary : setPrimary)((0xff000000 | c) >>> 0); }} onContextMenu={(e) => e.preventDefault()} />
            ))}
            <label className="small">custom <input type="color" value={hex(primary)} onChange={(e) => setPrimary((0xff000000 | fromHex(e.target.value)) >>> 0)} /></label>
          </div>
        )}
        <input ref={colorInput} type="color" className="hidden-color" onChange={(e) => onColorChosen(e.target.value)} />
      </div>
      <div className="palette-tools">
        {indexed ? (
          <>
            <span>Palette</span>
            <select value={cur.paletteId} onChange={(e) => switchPalette(+e.target.value)}>
              {castPalettes.map((p) => <option key={p.slot} value={p.slot}>#{p.slot} {p.name}</option>)}
              <optgroup label="Built-in">
                {BUILTIN_PALETTES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
            </select>
            <label title="Keep the picture's colours when switching palette (each index to the nearest colour), instead of keeping the indices"><input type="checkbox" checked={remapOnSwitch} onChange={(e) => setRemapOnSwitch(e.target.checked)} /> remap colours</label>
            <select value="" onChange={(e) => newPalette(e.target.value)}>
              <option value="">New palette…</option>
              <option value="copy">a copy of this one</option>
              <option value="picture">from this picture's colours</option>
              <option value="ramp">grey ramp (for tinted, ink 41 layers)</option>
              <option value="light">light ramp (black to yellow, for ink 33 glows)</option>
            </select>
            {cur.paletteId > 0 && cur.palette[0] === 0xffffff && cur.palette[1] === 0 && (
              <label title="This palette is a light ramp (index = brightness, black to a colour): pick the light's colour to make the ramp again in it">
                light colour <input type="color" value={hex(cur.palette[255] ?? 0)} onChange={(e) => commit({ palette: lightRamp(fromHex(e.target.value)) }, `Light colour ${e.target.value}`)} />
              </label>
            )}
            {cur.paletteId > 0 ? <span className="muted small">used by {usedBy} bitmap{usedBy === 1 ? '' : 's'}: changing a colour changes them all</span> : <span className="muted small">built-in: copy it to change colours</span>}
            <span className="spacer" />
            <button onClick={toThirtyTwo} title="Store the picture as 32-bit colours with alpha (no palette)">Make 32-bit</button>
          </>
        ) : (
          <>
            <span className="muted small">32-bit: colours with alpha, no palette.</span>
            <span className="spacer" />
            <select value="" onChange={(e) => toEightBit(e.target.value)} title="Store the picture as palette indices">
              <option value="">Make 8-bit on…</option>
              <option value="new">a new palette from its colours</option>
              {castPalettes.map((p) => <option key={p.slot} value={p.slot}>#{p.slot} {p.name}</option>)}
              {BUILTIN_PALETTES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </>
        )}
      </div>
    </div>
  );
}

/** A note without a blocking browser dialog. */
function alertish(text: string) {
  const el = document.querySelector('footer.status');
  if (el) el.textContent = text;
}

function ResizeForm({ img, onApply }: { img: PaintImage; onApply: (w: number, h: number, ax: number, ay: number) => void }) {
  const [w, setW] = useState(img.w);
  const [h, setH] = useState(img.h);
  const [anchor, setAnchor] = useState('0.5,1');
  return (
    <div className="row paint-resize">
      width <input type="number" min={1} max={2048} value={w} onChange={(e) => setW(+e.target.value)} />
      height <input type="number" min={1} max={2048} value={h} onChange={(e) => setH(+e.target.value)} />
      picture at
      <select value={anchor} onChange={(e) => setAnchor(e.target.value)}>
        {[['0,0', 'top left'], ['0.5,0', 'top'], ['1,0', 'top right'], ['0,0.5', 'left'], ['0.5,0.5', 'centre'], ['1,0.5', 'right'], ['0,1', 'bottom left'], ['0.5,1', 'bottom (stays on the floor)'], ['1,1', 'bottom right']].map(([v, n]) => (
          <option key={v} value={v}>{n}</option>
        ))}
      </select>
      <button className="primary" disabled={w < 1 || h < 1} onClick={() => { const [ax, ay] = anchor.split(',').map(Number); onApply(w, h, ax, ay); }}>Apply</button>
    </div>
  );
}
