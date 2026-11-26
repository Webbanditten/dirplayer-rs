import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { decodeImage, pickFile } from '../wasm';
import { directionsFor, removeBackground, trim, type NewFurniOptions, type Picture, type Turns } from '../newfurni';
import { opaqueBox, standOnTiles, tileBox, tileDiamonds } from '../tiles';
import { largeFileName, smallFileName } from '../small';

const IMAGE_TYPES = 'image/png,image/gif,image/jpeg';

/** Why a class name can't be used for a new furni, or null when it can. */
export function classNameProblem(name: string): string | null {
  if (!name) return 'Give it a name';
  if (!/^[a-z0-9_]{1,64}$/.test(name)) return 'Lower-case letters, digits and _ only (at most 64), as the hotel takes class names';
  if (/^(s_|poster)/.test(name)) return 's_ names a small cast and poster casts are numbered by the catalogue: pick another name';
  return null;
}

interface Slot {
  direction: number;
  label: string;
  hint: string;
}

function slotsFor(kind: 'floor' | 'wall', turns: Turns): Slot[] {
  if (kind === 'wall') return [{ direction: 2, label: 'On the left wall', hint: 'The right wall shows it mirrored' }];
  if (turns === 'none') return [{ direction: 0, label: 'The furni', hint: 'It looks the same however it is placed' }];
  if (turns === 'mirror') return [{ direction: 2, label: '↘ Facing right-down', hint: 'Turned, it shows this mirrored (facing left-down)' }];
  return [
    { direction: 2, label: '↘ Facing right-down (direction 2)', hint: 'The front. Its mirror image faces left-down (4)' },
    { direction: 0, label: '↗ Facing right-up (direction 0)', hint: 'The back. Its mirror image faces left-up (6)' },
  ];
}

interface Props {
  /** a picture to start with (dropped on the window or pasted before the dialog opened) */
  initial?: File | null;
  onCreate: (o: NewFurniOptions) => Promise<string | null>;
  onClose: () => void;
}

/** "New furni": a name, what it is, and a picture per side (or none, to paint it here). */
export function NewFurni({ initial, onCreate, onClose }: Props) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'floor' | 'wall'>('floor');
  const [length, setLength] = useState(1);
  const [width, setWidth] = useState(1);
  const [turns, setTurns] = useState<Turns>('mirror');
  const [raw, setRaw] = useState<Partial<Record<number, Picture>>>({});
  const [cutBackground, setCutBackground] = useState(true);
  const [shadow, setShadow] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const slots = slotsFor(kind, turns);
  const dims: [number, number] = kind === 'wall' ? [1, 1] : [length, width];

  // A picture without transparency of its own has a background to cut away.
  const hasBackground = useMemo(() => Object.values(raw).some((p) => p && !p.rgba.some((v, i) => i % 4 === 3 && v < 255)), [raw]);
  const pictures = useMemo(() => {
    const out: Partial<Record<number, Picture>> = {};
    for (const s of slots) {
      const p = raw[s.direction];
      if (!p) continue;
      const copy: Picture = { rgba: p.rgba.slice(), width: p.width, height: p.height };
      if (cutBackground) removeBackground(copy);
      out[s.direction] = trim(copy);
    }
    return out;
  }, [raw, cutBackground, kind, turns]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (direction: number, file?: File | null) => {
    const f = file ?? (await pickFile(IMAGE_TYPES));
    if (!f) return;
    try {
      const img = decodeImage(new Uint8Array(await f.arrayBuffer()));
      setRaw((r) => ({ ...r, [direction]: { rgba: img.rgba, width: img.width, height: img.height } }));
      setError('');
      if (!name) {
        const guess = f.name.replace(/\.[a-z]+$/i, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
        if (guess && !classNameProblem(guess)) setName(guess);
      }
    } catch (e) {
      setError(`Couldn't read ${f.name}: ${e}`);
    }
  };

  useEffect(() => {
    if (initial) load(slots[0].direction, initial);
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/Cmd+V: a copied picture goes into the first side that has none.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      const free = slots.find((s) => !raw[s.direction]) ?? slots[0];
      load(free.direction, file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  const problem = classNameProblem(name.trim());
  const create = async () => {
    if (problem || busy) return;
    setBusy(true);
    const failed = await onCreate({ name: name.trim(), kind, dims, turns, pictures, shadow: shadow && kind === 'floor' });
    setBusy(false);
    if (failed) setError(failed);
  };
  const anyPicture = slots.some((s) => pictures[s.direction]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal new-furni" role="dialog" aria-modal="true" aria-labelledby="new-furni-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h3 id="new-furni-title">New furni</h3>
        <p>From your own pictures, or empty to paint it here. It gets its tiles, a shadow, an icon and the small (32 px) version by itself; everything can be changed afterwards.</p>

        <label className="modal-field">
          <span>Class name (what the hotel and the catalogue know it by)</span>
          <input autoFocus value={name} spellCheck={false} placeholder="my_chair" onChange={(e) => setName(e.target.value.toLowerCase())} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </label>

        <div className="nf-row">
          <span className="nf-label">It is a</span>
          <span className="segmented">
            <button className={kind === 'floor' ? 'on' : ''} onClick={() => setKind('floor')}>Floor furni</button>
            <button className={kind === 'wall' ? 'on' : ''} onClick={() => setKind('wall')}>Wall item</button>
          </span>
          {kind === 'floor' && (
            <>
              <span className="nf-label">on</span>
              <input type="number" min={1} max={8} value={length} onChange={(e) => setLength(Math.max(1, Math.min(8, +e.target.value || 1)))} title="Tiles one way (length)" />
              ×
              <input type="number" min={1} max={8} value={width} onChange={(e) => setWidth(Math.max(1, Math.min(8, +e.target.value || 1)))} title="Tiles the other way (width)" />
              <span className="nf-label">tiles</span>
            </>
          )}
        </div>

        {kind === 'floor' && (
          <div className="nf-row">
            <span className="nf-label">Turning it</span>
            <select value={turns} onChange={(e) => setTurns(e.target.value as Turns)}>
              <option value="none">does nothing: one picture (a plant, a round table)</option>
              <option value="mirror">mirrors it: one picture, two sides (a lamp, a shelf)</option>
              <option value="four">shows four sides: two pictures, each mirrored (a chair, a sofa)</option>
            </select>
          </div>
        )}

        <div className="nf-slots">
          {slots.map((s) => (
            <PictureSlot key={`${kind}${turns}${s.direction}`} slot={s} dims={dims} wall={kind === 'wall'} picture={pictures[s.direction]} onPick={(file) => load(s.direction, file)} onClear={() => setRaw((r) => ({ ...r, [s.direction]: undefined }))} />
          ))}
        </div>

        <div className="nf-row">
          {hasBackground && <label className="chip" title="The picture has no transparency: the colour of its corners, where it touches the border, is cut away"><input type="checkbox" checked={cutBackground} onChange={(e) => setCutBackground(e.target.checked)} />cut away the background</label>}
          {kind === 'floor' && <label className="chip" title="A flat shadow on its tiles, like the hotel's furni have"><input type="checkbox" checked={shadow} onChange={(e) => setShadow(e.target.checked)} />shadow</label>}
          <span className="muted small">{anyPicture ? 'Drag it in the room afterwards to place it exactly.' : 'No picture: you get an empty canvas over its tiles to paint on.'}</span>
        </div>

        <p className={`modal-hint${error || (name && problem) ? ' bad' : ''}`}>
          {error || (name && problem) || `Casts: ${largeFileName(name.trim() || '…')} and ${smallFileName(name.trim() || '…')}`}
        </p>
        <div className="modal-buttons">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={create} disabled={!!problem || busy}><Icon name="plus" size={14} />{busy ? 'Making it…' : anyPicture ? 'Make the furni' : 'Make it and paint'}</button>
        </div>
      </div>
    </div>
  );
}

/** One side's picture: drop or pick it; shown standing on its tiles (or hanging on the wall) as the room will draw it. */
function PictureSlot({ slot, dims, wall, picture, onPick, onClear }: { slot: Slot; dims: [number, number]; wall: boolean; picture?: Picture; onPick: (file?: File | null) => void; onClear: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const t = tileBox(dims, slot.direction);
    const box = picture ? opaqueBox(picture.rgba, picture.width, picture.height) : null;
    const reg = picture && box && !wall ? standOnTiles(box, dims, slot.direction) : { regX: 0, regY: 0 };
    // Everything in pixels from the furni's tile point; the canvas covers the tiles and the picture.
    const left = Math.min(t.left, picture && !wall ? -reg.regX : t.left) - 6;
    const top = Math.min(t.top, picture && !wall ? -reg.regY : t.top - 40) - 6;
    const right = Math.max(t.right, picture && !wall ? picture.width - reg.regX : t.right) + 6;
    const bottom = t.bottom + 8;
    const w = wall && picture ? picture.width + 12 : right - left, h = wall && picture ? picture.height + 12 : bottom - top;
    c.width = w;
    c.height = h;
    // small furni are shown twice their size
    c.style.width = `${w * (w <= 160 && h <= 110 ? 2 : 1)}px`;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    if (!wall) {
      for (const d of tileDiamonds(dims, slot.direction)) {
        ctx.beginPath();
        d.forEach(([x, y], i) => (i ? ctx.lineTo(x - left + 0.5, y - top + 0.5) : ctx.moveTo(x - left + 0.5, y - top + 0.5)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(152, 152, 101, 0.55)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(90, 90, 50, 0.6)';
        ctx.stroke();
      }
    }
    if (picture) {
      const tmp = document.createElement('canvas');
      tmp.width = picture.width;
      tmp.height = picture.height;
      tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(picture.rgba), picture.width, picture.height), 0, 0);
      ctx.drawImage(tmp, wall ? 6 : -reg.regX - left, wall ? 6 : -reg.regY - top);
    }
  }, [picture, dims[0], dims[1], slot.direction, wall]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      className={`nf-slot${over ? ' over' : ''}${picture ? ' filled' : ''}`}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onPick(e.dataTransfer.files?.[0]);
      }}
    >
      <div className="nf-slot-head"><b>{slot.label}</b><span className="muted small">{slot.hint}</span></div>
      <button className="nf-drop checker" onClick={() => onPick()} title="Pick a picture (PNG, GIF or JPEG), drop one here, or paste one">
        <canvas ref={canvas} />
        {!picture && <span className="nf-drop-text"><Icon name="image" size={18} />Drop, paste or pick a picture</span>}
      </button>
      {picture && (
        <div className="nf-slot-foot">
          <span className="muted small">{picture.width}×{picture.height} px</span>
          <span className="spacer" />
          <button className="ghost" onClick={onClear}>Remove</button>
        </div>
      )}
    </div>
  );
}
