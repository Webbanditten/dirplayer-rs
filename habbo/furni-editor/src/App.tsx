import { useCallback, useEffect, useMemo, useState } from 'react';
import { CastDocument, SwfDocument, decodeImage, download, encodePng, loadWasm, pickFile, pickFiles } from './wasm';
import { buildCast, planFlash, splitPlan } from './flash';
import { largeFileName, makeSmall, smallFileName } from './small';
import { ALIAS_INDEX, ASSET_INDEX, Furni, parseMemberName } from './furni';
import { FurniGrid, gridModel } from './components/FurniGrid';
import { Inspector, type ImportMode } from './components/Inspector';
import { Preview } from './components/Preview';
import { Paint } from './components/Paint';
import { LightPanel } from './components/LightPanel';
import { Icon, Logo } from './components/Icon';

const DEFAULT_HOST = 'https://images.habbo-danmark.com/hof_furni/';
const IMAGE_TYPES = 'image/png,image/gif,image/jpeg';

function stored(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/**
 * Housekeeping embeds the editor (OdinCMS Areas/Housekeeping/Views/FurniEditor) as
 * `?embed=housekeeping&parent=<the CMS origin>`. Messages only go to and come from that origin and the parent window:
 * the page sends `open` (a furni's casts), `published` and `status`; the editor sends `ready` and `publish` (both casts).
 * The editor never calls the CMS itself.
 */
const EMBED = (() => {
  const q = new URLSearchParams(location.search);
  if (q.get('embed') !== 'housekeeping' || window.parent === window) return null;
  try {
    return { origin: new URL(q.get('parent') ?? '').origin };
  } catch {
    return null;
  }
})();

/** The other size of the open furni (the large and the small cast are edited as a pair). */
interface Side {
  doc: CastDocument;
  name: string;
  dirty: boolean;
}

/** The file name a furni's cast gets: hh_furni_xx_<class>.cct, or hh_furni_xx_s_<class>.cct for the small one. */
function castName(f: Furni, fallback: string) {
  const cls = f.className();
  if (!cls) return fallback || 'cast.cct';
  return f.isSmallCast() ? smallFileName(cls) : largeFileName(cls);
}

export function App() {
  const [ready, setReady] = useState(false);
  const [doc, setDoc] = useState<CastDocument | null>(null);
  const [fileName, setFileName] = useState('');
  const [rev, setRev] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [other, setOther] = useState<Side | null>(null);
  const [selected, setSelected] = useState<{ slot: number; alias?: string } | null>(null);
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState<'furni' | 'members'>('furni');
  const [painting, setPainting] = useState<number | null>(null);
  const [lighting, setLighting] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('auto');
  const [host, setHost] = useState(() => stored('furniEditor.host', DEFAULT_HOST));
  const [className, setClassName] = useState(() => stored('furniEditor.class', 'chair_norja'));
  const [templateClass] = useState(() => stored('furniEditor.template', 'chair_norja'));
  const [flashSmall, setFlashSmall] = useState(() => stored('furniEditor.flashSmall', '0') === '1');
  const [flashColors, setFlashColors] = useState<{ label: string; colour: string }[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [theme, setTheme] = useState(() => stored('furniEditor.theme', 'auto'));
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
    store('furniEditor.theme', theme);
  }, [theme]);

  useEffect(() => {
    loadWasm().then(() => setReady(true), (e) => setStatus(`Couldn't load DirPlayer: ${e}`));
  }, []);

  const furni = useMemo(() => (doc ? new Furni(doc) : null), [doc, rev]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty || other?.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, other]);
  const anyDirty = dirty || !!other?.dirty;

  /** Show a new furni (and its other size, when there is one), dropping the open ones. */
  const show = useCallback(
    (next: CastDocument, name: string, changed: boolean, pair: Side | null = null) => {
      doc?.free();
      other?.doc.free();
      setOther(pair);
      setDoc(next);
      setPainting(null);
      setFileName(name);
      setDirty(changed);
      setSelected(null);
      setRev((r) => r + 1);
    },
    [doc, other],
  );

  /** Open a cast, or a large and a small cast together (the large one is shown first). */
  const open = useCallback(
    (bytes: Uint8Array, name: string, pair?: { bytes: Uint8Array; name: string }) => {
      if (anyDirty && !confirm('Discard the changes to the open cast?')) return;
      let next: CastDocument | null = null;
      try {
        next = new CastDocument(bytes);
        let pairDoc = pair ? new CastDocument(pair.bytes) : null;
        let [mainName, pairName] = [name, pair?.name ?? ''];
        if (pairDoc && new Furni(next).isSmallCast() && !new Furni(pairDoc).isSmallCast()) {
          [next, pairDoc] = [pairDoc, next];
          [mainName, pairName] = [pairName, mainName];
        }
        show(next, mainName, false, pairDoc ? { doc: pairDoc, name: pairName, dirty: false } : null);
        setFlashColors([]);
        const f = new Furni(next);
        setStatus(`Opened ${mainName}${pairDoc ? ` and ${pairName}` : ''}: ${f.members.length} members, class ${f.className() || '?'}`);
      } catch (e) {
        next?.free();
        setStatus(`Couldn't open ${name}: ${e}`);
      }
    },
    [anyDirty, show],
  );

  /** A Flash furni (.swf) converted into a new cast, built on a template cast from the hotel (for its Director-written
   *  container) whose members are replaced. */
  const importFlash = async (file: File) => {
    if (anyDirty && !confirm('Discard the changes to the open cast?')) return;
    setStatus(`Converting ${file.name}…`);
    let swf: SwfDocument | null = null;
    try {
      swf = new SwfDocument(new Uint8Array(await file.arrayBuffer()));
      const plan = planFlash(swf, file.name, { small: flashSmall });
      const template = `hh_furni_xx_${templateClass.trim() || 'chair_norja'}.cct`;
      const res = await fetch(host.replace(/\/?$/, '/') + template);
      if (!res.ok) throw new Error(`couldn't load the template cast ${template} (HTTP ${res.status})`);
      const templateBytes = new Uint8Array(await res.arrayBuffer());
      const sizes = splitPlan(plan);
      const next = new CastDocument(templateBytes);
      buildCast(next, swf, sizes.large);
      let small: CastDocument | null = null;
      if (sizes.small) {
        small = new CastDocument(templateBytes);
        buildCast(small, swf, sizes.small);
      }
      show(next, largeFileName(plan.sprite), true, small ? { doc: small, name: smallFileName(plan.sprite), dirty: true } : null);
      setFlashColors(plan.colors.map((c) => ({ label: `flash colour ${c.id}: ${c.colour}`, colour: c.colour })));
      const aliases = plan.fields.find((f) => f.name === ALIAS_INDEX)?.text.split('\n').length ?? 0;
      setStatus(
        `Converted ${file.name}: ${plan.sprite}, ${plan.dims[0]}×${plan.dims[1]}, ${plan.bitmaps.length} pictures${small ? ' (with a small cast)' : ''}, ${aliases} aliases, ` +
          `${plan.fields.map((f) => f.name).join(', ')}` + (plan.colors.length ? `; ${plan.colors.length} colour variants` : '') +
          (plan.warnings.length ? `. Warnings: ${plan.warnings.slice(0, 4).join('; ')}${plan.warnings.length > 4 ? ` (+${plan.warnings.length - 4})` : ''}` : ''),
      );
    } catch (e) {
      setStatus(`Couldn't convert ${file.name}: ${e}`);
    } finally {
      swf?.free();
    }
  };

  /** Run a change to the document, then refresh everything that shows it. */
  const edit = useCallback((what: string, fn: () => void) => {
    try {
      fn();
      setRev((r) => r + 1);
      setDirty(true);
      setStatus(what);
    } catch (e) {
      setStatus(`${what}: ${e}`);
    }
  }, []);

  /** One cast, or two (a furni's large and small cast) picked together. */
  const openFiles = async (files: File[]) => {
    const casts = files.filter((f) => /\.(cct|cst)$/i.test(f.name)).slice(0, 2);
    if (!casts.length) return;
    const [a, b] = await Promise.all(casts.map(async (f) => ({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name })));
    open(a.bytes, a.name, b);
  };
  const openFile = async () => openFiles(await pickFiles('.cct,.cst'));

  /** The large cast and, when the hotel has one, the small cast. */
  const openFromHotel = async () => {
    const cls = className.trim().replace(/^hh_furni_xx_(s_)?/i, '').replace(/\.cct$/i, '');
    const name = largeFileName(cls);
    store('furniEditor.host', host);
    store('furniEditor.class', cls);
    setStatus(`Loading ${name}…`);
    const get = async (file: string) => {
      const res = await fetch(host.replace(/\/?$/, '/') + file);
      return res.ok ? { bytes: new Uint8Array(await res.arrayBuffer()), name: file } : null;
    };
    try {
      const [large, small] = await Promise.all([get(name), get(smallFileName(cls)).catch(() => null)]);
      const first = large ?? small;
      if (!first) throw new Error('not on the hotel (HTTP 404)');
      open(first.bytes, first.name, large && small ? small : undefined);
    } catch (e) {
      setStatus(`Couldn't load ${name}: ${e}`);
    }
  };

  /** Save the shown cast, and the other size too when it has changes. */
  const save = () => {
    if (!doc || !furni) return;
    const saveOne = (d: CastDocument, name: string) => {
      const bytes = d.save();
      // Check the result opens before handing it out.
      new CastDocument(bytes).free();
      download(bytes, name);
      return `${name} (${bytes.length.toLocaleString()} bytes)`;
    };
    try {
      const done = [saveOne(doc, castName(furni, fileName))];
      setDirty(false);
      if (other?.dirty) {
        done.push(saveOne(other.doc, castName(new Furni(other.doc), other.name)));
        setOther({ ...other, dirty: false });
      }
      setStatus(`Saved ${done.join(' and ')}`);
    } catch (e) {
      setStatus(`Save failed: ${e}`);
    }
  };

  // --- Housekeeping ---
  const [hotelFurni, setHotelFurni] = useState<{ sprite: string; madeHere: boolean } | null>(null);
  const toParent = (message: unknown, transfer: Transferable[] = []) => EMBED && window.parent.postMessage(message, EMBED.origin, transfer);
  useEffect(() => {
    if (!EMBED || !ready) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== EMBED.origin || e.source !== window.parent) return;
      const m = e.data ?? {};
      if (m.type === 'open' && (m.large?.bytes instanceof ArrayBuffer || m.small?.bytes instanceof ArrayBuffer)) {
        const first = m.large ?? m.small;
        const pair = m.large && m.small ? { bytes: new Uint8Array(m.small.bytes), name: String(m.small.name) } : undefined;
        open(new Uint8Array(first.bytes), String(first.name), pair);
        if (Array.isArray(m.colors)) setFlashColors(m.colors.filter((c: { colour?: unknown }) => typeof c?.colour === 'string'));
        setHotelFurni({ sprite: String(m.sprite ?? ''), madeHere: !!m.madeHere });
        if (!m.madeHere) setStatus(`${m.sprite} is the hotel's own furni: it is never written over. "New furni from this…" makes a copy you can publish.`);
        else if (m.revision) setStatus(`Opened ${m.sprite} r${m.revision} (an earlier version: publishing it makes a new revision)`);
      } else if (m.type === 'published') {
        setStatus(String(m.text ?? ''));
        if (m.ok) {
          setDirty(false);
          setOther((o) => (o ? { ...o, dirty: false } : o));
          setHotelFurni({ sprite: String(m.sprite ?? ''), madeHere: true });
        }
      } else if (m.type === 'status') {
        setStatus(String(m.text ?? ''));
      }
    };
    window.addEventListener('message', onMessage);
    toParent({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [ready, open]);

  /** Hand both casts to Housekeeping, which checks them and asks before anything is written. */
  const publish = () => {
    if (!doc || !furni) return;
    const cls = furni.className();
    if (!cls) return setStatus('The cast has no furni class to publish');
    if (hotelFurni && !hotelFurni.madeHere && hotelFurni.sprite.toLowerCase() === cls.toLowerCase())
      return setStatus(`${cls} is the hotel's own furni and is never written over: "New furni from this…" first, then publish the copy`);
    try {
      const mine = doc.save();
      const theirs = other?.doc.save();
      const [large, small] = furni.isSmallCast() ? [theirs, mine] : [mine, theirs];
      if (!large) return setStatus(`Only the small cast is open: open or make the large one (${largeFileName(cls)}) too`);
      const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      const msg = { type: 'publish', sprite: cls, large: buf(large), small: small ? buf(small) : undefined, colour: flashColors[0]?.colour };
      toParent(msg, [msg.large, ...(msg.small ? [msg.small] : [])]);
      setStatus(`Sent ${cls} to Housekeeping: check the report there and confirm`);
    } catch (e) {
      setStatus(`Couldn't save the casts: ${e}`);
    }
  };

  // --- large and small ---
  const smallShown = furni?.isSmallCast() ?? false;
  /** The member of the other size that matches `name` (s_ in front for the small one; icons are the same). */
  const counterpart = (f: Furni, name: string, toSmall: boolean) => {
    const target = toSmall ? (/^s_/i.test(name) || /_small(_[a-z])?$/i.test(name) ? name : 's_' + name) : name.replace(/^s_/i, '');
    return f.members.find((m) => m.name.toLowerCase() === target.toLowerCase())?.slot;
  };
  const switchSize = (toSmall: boolean) => {
    if (!doc || !furni || toSmall === smallShown) return;
    const selName = sel ? furni.bySlot.get(sel.slot)?.name : undefined;
    const paintName = painting !== null ? furni.bySlot.get(painting)?.name : undefined;
    let target: Side;
    if (other) {
      target = other;
    } else if (toSmall) {
      const cls = furni.className();
      if (!confirm(`${cls} has no small (32 px) cast open. Make ${smallFileName(cls)} from the large pictures (halved)?`)) return;
      try {
        target = { doc: makeSmall(doc, cls), name: smallFileName(cls), dirty: true };
      } catch (e) {
        return setStatus(`Couldn't make the small version: ${e}`);
      }
    } else {
      return setStatus('No large cast is open with this one: open both files together (pick or drop the two .cct)');
    }
    setOther({ doc, name: fileName, dirty });
    setDoc(target.doc);
    setFileName(target.name);
    setDirty(target.dirty);
    const f = new Furni(target.doc);
    const nextSel = selName ? counterpart(f, selName, toSmall) : undefined;
    const nextPaint = paintName ? counterpart(f, paintName, toSmall) : undefined;
    setSelected(nextSel ? { slot: nextSel } : null);
    setPainting(nextPaint && f.bySlot.get(nextPaint)?.bitmap ? nextPaint : null);
    setRev((r) => r + 1);
    setStatus(`${toSmall ? 'Small (32 px)' : 'Large (64 px)'}: ${target.name}${other ? '' : ', made from the large pictures'}`);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'KeyS' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        switchSize(!smallShown);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const readImage = async (given?: File) => {
    const file = given ?? (await pickFile(IMAGE_TYPES));
    if (!file) return null;
    try {
      return decodeImage(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      setStatus(`Couldn't read ${file.name}: ${e}`);
      return null;
    }
  };

  const importInto = async (slot: number, file?: File) => {
    if (!doc || !furni) return;
    const img = await readImage(file);
    const m = furni.bySlot.get(slot);
    if (!img || !m?.bitmap) return;
    const keepReg = img.width === m.bitmap.width && img.height === m.bitmap.height;
    const regX = keepReg ? m.bitmap.regX : Math.round((m.bitmap.regX * img.width) / Math.max(1, m.bitmap.width));
    const regY = keepReg ? m.bitmap.regY : Math.round((m.bitmap.regY * img.height) / Math.max(1, m.bitmap.height));
    let report = '';
    edit(`Replaced ${m.name}`, () => {
      report = doc.setBitmap(slot, img.rgba, img.width, img.height, regX, regY, importMode, 0);
    });
    if (report) {
      const r = JSON.parse(report);
      setStatus(`Replaced ${m.name}: ${img.width}×${img.height}, ${r.depth}-bit, ${r.bytes} bytes` + (r.approximated ? `, ${r.approximated} pixels took the nearest palette colour` : '') + (r.partialAlpha ? `, ${r.partialAlpha} half-transparent pixels` : ''));
    }
  };

  const exportMember = (slot: number) => {
    if (!doc || !furni) return;
    const m = furni.bySlot.get(slot);
    if (!m?.bitmap) return;
    try {
      download(encodePng(doc.rgba(slot), m.bitmap.width, m.bitmap.height), `${m.name}.png`, 'image/png');
    } catch (e) {
      setStatus(`Export failed: ${e}`);
    }
  };

  const templateFor = (letter: string): number | undefined => {
    if (!furni) return undefined;
    const g = gridModel(furni);
    const row = g.rows.find((r) => r.letter === letter) ?? g.rows[0];
    const own = row && [...row.dirs.values()].flatMap((f) => [...f.values()]).find((c) => !c.aliasOf);
    return own?.slot ?? furni.members.find((m) => m.type === 'bitmap')?.slot;
  };

  const addFrame = async (letter: string, direction: number, frame: number, file?: File) => {
    if (!doc || !furni) return;
    const g = gridModel(furni);
    const name = `${g.cls}_${letter}_0_${g.dims[0]}_${g.dims[1]}_${direction}_${frame}`;
    const template = templateFor(letter);
    if (!template) return setStatus('No bitmap in the cast to base a new member on');
    const img = await readImage(file);
    if (!img) return;
    const t = furni.bySlot.get(template)!.bitmap!;
    edit(`Added ${name}`, () => {
      const slot = doc.addBitmap(template, name, img.rgba, img.width, img.height, Math.min(t.regX, img.width), Math.min(t.regY, img.height), importMode);
      setSelected({ slot });
    });
  };

  const addLayer = async (letter: string) => {
    if (!furni) return;
    const g = gridModel(furni);
    const dir = g.rows[0] ? Math.min(...g.rows[0].dirs.keys()) : 2;
    await addFrame(letter, dir, 0);
  };

  /** The text member `name`, created from another field when missing. */
  const ensureField = (name: string): number => {
    const existing = furni!.fieldSlot(name);
    if (existing) return existing;
    const template = furni!.members.find((m) => m.type === 'field' || m.type === 'text');
    if (!template) throw new Error('The cast has no field member to copy for ' + name);
    return doc!.addField(template.slot, name, '');
  };

  const mirror = () => {
    if (!doc || !furni) return;
    const g = gridModel(furni);
    const lines: string[] = [];
    for (const row of g.rows) {
      for (const [from, to] of [[2, 4], [0, 6]]) {
        const src = row.dirs.get(from);
        if (!src) continue;
        for (const [frame, cell] of src) {
          if (cell.aliasOf) continue;
          const own = row.dirs.get(to)?.get(frame);
          if (own && !own.aliasOf) continue;
          lines.push(`${g.cls}_${row.letter}_0_${g.dims[0]}_${g.dims[1]}_${to}_${frame}=${cell.name}*`);
        }
      }
    }
    if (!lines.length) return setStatus('Directions 4 and 6 already have members or aliases');
    edit(`Added ${lines.length} mirror aliases to ${ALIAS_INDEX}`, () => {
      const slot = ensureField(ALIAS_INDEX);
      const text = (doc.text(slot) ?? '').replace(/\s+$/, '');
      const kept = text.split(/\n/).filter((l) => !lines.some((n) => n.split('=')[0].toLowerCase() === l.split('=')[0].trim().toLowerCase()));
      doc.setText(slot, [...kept.filter((l) => l.trim()), ...lines].join('\n'));
    });
  };

  const duplicate = (slot: number) => {
    if (!doc || !furni) return;
    const m = furni.bySlot.get(slot);
    const name = m && prompt('Name of the copy', m.name + '_copy');
    if (!name) return;
    edit(`Copied ${m!.name} to ${name}`, () => setSelected({ slot: doc.duplicate(slot, name) }));
  };

  const remove = (slot: number) => {
    if (!doc || !furni) return;
    const m = furni.bySlot.get(slot);
    if (!m || !confirm(`Delete member ${m.name}?`)) return;
    edit(`Deleted ${m.name}`, () => doc.delete(slot));
    setSelected(null);
  };

  /** Rename the whole furni: every member of the class, its fields and the alias and asset indexes. */
  const cloneAs = () => {
    if (!doc || !furni) return;
    const old = furni.className();
    const next = prompt(`New class name for a copy of ${old} (members and texts are renamed)`, `${old}_2`)?.trim();
    if (!next || next === old) return;
    if (!/^[a-z0-9_]{1,64}$/.test(next)) return setStatus('Class names are lower-case letters, digits and _ (at most 64), as the hotel takes them');
    if (/^(s_|poster)/.test(next)) return setStatus('s_ names a small cast and poster casts are numbered by the catalogue: pick another name');
    const re = new RegExp(`^(s_)?${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[_.]|$)`, 'i');
    const swap = (s: string) => s.replace(re, (_m, small) => (small ?? '') + next);
    // Members borrowed from other furni (drken_pixel, sofachair_silo_d_...) get the new name in front too: a furni's
    // cast may only name its own members (the hotel checks), and the copy stays independent of the other furni.
    const shared = new Set([ALIAS_INDEX, ASSET_INDEX, 'copyright']);
    const rename = (d: CastDocument, f: Furni) => {
      const borrowed = new Map<string, string>();
      for (const m of f.members) {
        if (re.test(m.name)) d.setName(m.slot, swap(m.name));
        else if (m.name && m.type !== 'palette' && !shared.has(m.name.toLowerCase())) {
          borrowed.set(m.name.toLowerCase(), `${next}_${m.name}`);
          d.setName(m.slot, `${next}_${m.name}`);
        }
      }
      const part = (p: string) => {
        const star = p.endsWith('*') ? '*' : '';
        const name = star ? p.slice(0, -1) : p;
        return (borrowed.get(name.toLowerCase()) ?? swap(name)) + star;
      };
      for (const field of [ALIAS_INDEX, ASSET_INDEX]) {
        const slot = f.fieldSlot(field);
        if (!slot) continue;
        const text = d.text(slot) ?? '';
        d.setText(
          slot,
          field === ASSET_INDEX
            ? text.replace(new RegExp(`"(s_)?${old}"`, 'gi'), (_m, small) => `"${small ?? ''}${next}"`)
            : text.split(/\r?\n|\r/).map((l) => l.split('=').map((p) => part(p.trim())).join('=')).join('\n'),
        );
      }
    };
    edit(`Renamed the furni ${old} to ${next}${other ? ' (both sizes)' : ''}`, () => {
      rename(doc, furni);
      if (other) {
        rename(other.doc, new Furni(other.doc));
        setOther({ ...other, name: castName(new Furni(other.doc), other.name), dirty: true });
      }
      setFileName(castName(new Furni(doc), fileName));
    });
  };

  const sel = selected && furni?.bySlot.has(selected.slot) ? selected : null;
  const paint = (slot: number) => {
    if (furni?.bySlot.get(slot)?.bitmap) {
      setSelected({ slot });
      setPainting(slot);
    }
  };

  // Drop a .cct/.cst anywhere to open it; an image onto the window replaces the selected bitmap (the grid's + cells
  // take images for new frames themselves).
  const onDrop = async (e: React.DragEvent) => {
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    e.preventDefault();
    if (/\.(cct|cst)$/i.test(file.name)) openFiles([...e.dataTransfer.files]);
    else if (/\.swf$/i.test(file.name)) importFlash(file);
    else if (/^image\//.test(file.type) || /\.(png|gif|jpe?g)$/i.test(file.name)) {
      const m = sel && furni?.bySlot.get(sel.slot);
      if (m?.type === 'bitmap') importInto(m.slot, file);
      else setStatus('Select a bitmap member first, or drop the image on a + cell');
    }
  };

  const hostName = (() => {
    try {
      return new URL(host).host;
    } catch {
      return host;
    }
  })();
  const flashImport = async () => {
    const f = await pickFile('.swf');
    if (f) importFlash(f);
  };
  const hotelField = (
    <div className="field-group" title="Load a furni's casts (large and small) from the hotel's asset host">
      <Icon name="search" className="field-icon" />
      <input className="cls" value={className} onChange={(e) => setClassName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && openFromHotel()} placeholder="chair_norja" spellCheck={false} />
      <button onClick={openFromHotel} disabled={!ready}>Load</button>
    </div>
  );
  const sizeSwitch = (
    <span className="segmented" title="The furni's large (64 px) and small (32 px) cast (Alt+S)">
      <button className={!smallShown ? 'on' : ''} onClick={() => switchSize(false)}>
        <span className={`dot${(!smallShown ? dirty : other?.dirty) ? ' dirty' : ''}`} />64 px
      </button>
      <button className={smallShown ? 'on' : ''} onClick={() => switchSize(true)} title={!smallShown && !other ? 'Make a small version from the large pictures' : undefined}>
        {!smallShown && !other ? <Icon name="plus" size={12} /> : <span className={`dot${(smallShown ? dirty : other?.dirty) ? ' dirty' : ''}`} />}32 px
      </button>
    </span>
  );

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget || !(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        onDrop(e);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <Logo size={26} />
          <span className="brand-name">Furni <em>editor</em></span>
        </div>
        <span className="tb-div" />
        <div className="tb-group">
          <button onClick={openFile} disabled={!ready} title="Open a .cct, or a furni's large and small cast together (you can also drop them on the window)">
            <Icon name="folder" />Open
          </button>
          {hotelField}
          <button onClick={flashImport} disabled={!ready} title="Convert a Flash furni (.swf) into a Shockwave cast; you can also drop the .swf on the window">
            <Icon name="bolt" />Flash
          </button>
          <label className="chip" title="Also convert the Flash file's 32 px pictures (into the small cast)">
            <input type="checkbox" checked={flashSmall} onChange={(e) => { setFlashSmall(e.target.checked); store('furniEditor.flashSmall', e.target.checked ? '1' : '0'); }} />32 px
          </label>
        </div>
        <span className="spacer" />
        {doc && furni && (
          <div className="tb-group">
            <span className="doc-pill" title={[fileName, other?.name].filter(Boolean).join(' + ')}>
              <span className={`dot${dirty ? ' dirty' : ''}`} />
              <span className="name">{fileName}</span>
            </span>
            {sizeSwitch}
          </div>
        )}
        <span className="spacer" />
        <div className="tb-group">
          <button className="ghost" onClick={cloneAs} disabled={!doc} title="Rename every member of the class (both sizes), for a new furni based on this one">
            <Icon name="copy" />New from this…
          </button>
          <button className="primary" onClick={save} disabled={!doc} title="Save the cast (and the other size when it has changes)">
            <Icon name="save" />{other?.dirty && dirty ? 'Save both' : 'Save'}
          </button>
          {EMBED && (
            <button className="primary" onClick={publish} disabled={!doc} title="Housekeeping checks the casts and asks before publishing">
              <Icon name="upload" />Publish…
            </button>
          )}
          <button className={`icon ghost${settingsOpen ? ' on' : ''}`} onClick={() => setSettingsOpen(!settingsOpen)} title="Settings">
            <Icon name="sliders" />
          </button>
        </div>
        {settingsOpen && (
          <div className="popover" onMouseLeave={() => setSettingsOpen(false)}>
            <h4>Asset host</h4>
            <input value={host} onChange={(e) => setHost(e.target.value)} onBlur={() => store('furniEditor.host', host)} spellCheck={false} title="Where hof_furni casts are loaded from" />
            <span className="muted small">Casts are loaded from here by class name; Flash imports use its chair_norja as their template.</span>
            <h4>Theme</h4>
            <span className="segmented">
              {(['auto', 'light', 'dark'] as const).map((t) => (
                <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
                  {t === 'light' ? <Icon name="sun" size={13} /> : t === 'dark' ? <Icon name="moon" size={13} /> : null}
                  {t === 'auto' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </span>
          </div>
        )}
      </header>

      {!doc || !furni ? (
        <main className="welcome">
          <div className="hero">
            <Logo size={84} />
            <h1>Furni <em>editor</em></h1>
            <p>Edit Habbo furni casts in the browser: layers, directions and frames, a room to watch them in, pixel painting in the furni's own palettes, lights, and the 64 and 32 px casts side by side.</p>
          </div>
          <div className="start-cards">
            <button className="start-card" onClick={openFile} disabled={!ready}>
              <span className="tile-icon"><Icon name="folder" size={20} /></span>
              <b>Open a cast</b>
              <span><code>hh_furni_xx_&lt;class&gt;.cct</code> from disk, or the large and small cast together. Dropping them on the window works too.</span>
            </button>
            <div className="start-card">
              <span className="tile-icon"><Icon name="download" size={20} /></span>
              <b>Load from the hotel</b>
              <span>By class name, both sizes, from {hostName}.</span>
              {hotelField}
            </div>
            <button className="start-card" onClick={flashImport} disabled={!ready}>
              <span className="tile-icon"><Icon name="bolt" size={20} /></span>
              <b>Import a Flash furni</b>
              <span>A <code>.swf</code> becomes a Shockwave cast: pictures, directions, animations, colours.</span>
            </button>
          </div>
          <div className="features">
            {['Layers × directions × frames', 'Room preview with inks', 'Paint & palettes', 'Lights and glows', '64 / 32 px pair', 'Flash import'].map((f) => <span key={f}>{f}</span>)}
          </div>
          {!ready && <p className="loading"><span className="spinner" />Loading DirPlayer…</p>}
        </main>
      ) : painting !== null && furni.bySlot.get(painting)?.bitmap ? (
        <main className="panes painting">
          <section className="pane paint-pane">
            <Paint key={painting} doc={doc} furni={furni} slot={painting} edit={edit} onClose={() => setPainting(null)} />
          </section>
          <section className="pane center">
            <Preview doc={doc} furni={furni} rev={rev} selected={painting} onPick={(slot) => paint(slot)} extraColors={flashColors} />
          </section>
        </main>
      ) : (
        <main className="panes">
          <section className="pane left">
            <div className="pane-head">
              <span className="pane-title"><Icon name="layers" size={14} />Members</span>
              <span className="spacer" />
              <span className="segmented">
                <button className={tab === 'furni' ? 'on' : ''} onClick={() => setTab('furni')}>Furni</button>
                <button className={tab === 'members' ? 'on' : ''} onClick={() => setTab('members')}>All ({furni.members.length})</button>
              </span>
            </div>
            <div className="pane-body">
              {lighting && <LightPanel doc={doc} furni={furni} edit={edit} setStatus={setStatus} onClose={() => setLighting(false)} />}
              {tab === 'furni' ? (
                <FurniGrid onAddLight={() => setLighting(true)} doc={doc} furni={furni} rev={rev} small={false} selected={sel?.slot ?? null} onSelect={(slot, alias) => setSelected({ slot, alias })} onPaint={paint} onAddFrame={addFrame} onAddLayer={addLayer} onMirror={mirror} />
              ) : (
                <table className="members">
                  <tbody>
                    {furni.members.map((m) => {
                      const p = parseMemberName(m.name);
                      return (
                        <tr key={m.slot} className={sel?.slot === m.slot ? 'selected' : ''} onClick={() => setSelected({ slot: m.slot })} onDoubleClick={() => paint(m.slot)}>
                          <td className="muted">{m.slot}</td>
                          <td><span className="type-badge">{m.type}</span></td>
                          <td>{m.name}</td>
                          <td className="muted">{m.bitmap ? `${m.bitmap.width}×${m.bitmap.height} ${m.bitmap.depth}b` : ''}{p ? ` · ${p.letter} d${p.direction} f${p.frame}` : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="pane-foot fields">
              {[`${furni.isSmallCast() ? 's_' : ''}${furni.className()}.props`, `${furni.isSmallCast() ? 's_' : ''}${furni.className()}.data`, ALIAS_INDEX, ASSET_INDEX].map((n) => {
                const slot = furni.fieldSlot(n);
                return slot ? (
                  <button key={n} className={sel?.slot === slot ? 'on' : ''} onClick={() => setSelected({ slot })}>{n}</button>
                ) : (
                  <button key={n} className="missing" title={`Create ${n}`} onClick={() => edit(`Created ${n}`, () => setSelected({ slot: ensureField(n) }))}>+ {n}</button>
                );
              })}
            </div>
          </section>
          <section className="pane center">
            <Preview doc={doc} furni={furni} rev={rev} selected={sel?.slot ?? null} onPick={(slot) => setSelected({ slot })} extraColors={flashColors} />
          </section>
          <section className="pane right">
            <div className="pane-head">
              <span className="pane-title"><Icon name="inspect" size={14} />Inspector</span>
            </div>
            <div className="pane-body">
              {sel ? (
                <Inspector key={sel.slot} doc={doc} furni={furni} rev={rev} slot={sel.slot} alias={sel.alias} importMode={importMode} setImportMode={setImportMode} edit={edit} onImport={importInto} onExport={exportMember} onDuplicate={duplicate} onDelete={remove} onPaint={paint} />
              ) : (
                <div className="inspector-empty">
                  <div>
                    <Icon name="inspect" size={28} />
                    Pick a member in the grid, the list or the room.
                    <div className="small" style={{ marginTop: 6 }}>Double-click a picture to paint it.</div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </main>
      )}
      <footer className="statusbar">
        <div className="msg"><span>{status || (ready ? 'Ready' : 'Loading DirPlayer…')}</span></div>
        <span className="spacer" />
        <div className="hints">
          {doc && <span><kbd>Alt</kbd><kbd>S</kbd> 64 / 32 px</span>}
          {doc && painting === null && <span>double-click: paint</span>}
          {painting !== null && <span><kbd>Esc</kbd> done · <kbd>⌘Z</kbd> undo</span>}
        </div>
      </footer>
      {dragging && <div className="drop-overlay">Drop casts, a .swf or an image</div>}
    </div>
  );
}
