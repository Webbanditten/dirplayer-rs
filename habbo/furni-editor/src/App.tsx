import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CastDocument, SwfDocument, decodeImage, download, encodePng, loadWasm, pickFile, pickFiles } from './wasm';
import { buildCast, planFlash, splitPlan } from './flash';
import { largeFileName, madeFromLarge, makeSmall, smallFileName } from './small';
import { ALIAS_INDEX, ASSET_INDEX, Furni, isWallItem, parseMemberName } from './furni';
import { History, type SideKey, type Snap, type Step } from './history';
import { clearAutosave, loadAutosave, writeAutosave, type Autosave } from './autosave';
import { checkFurni, type Issue } from './check';
import { iconMembers, renderIcon, type IconView } from './icon';
import { FurniGrid, gridModel, memberNameFor } from './components/FurniGrid';
import { lingoValue, prop } from './lingo';
import { Inspector, type ImportMode } from './components/Inspector';
import { Preview } from './components/Preview';
import { Paint } from './components/Paint';
import { LightPanel } from './components/LightPanel';
import { CheckPanel } from './components/CheckPanel';
import { LayersPanel } from './components/LayersPanel';
import { StatesPanel } from './components/StatesPanel';
import { NewFurni, classNameProblem } from './components/NewFurni';
import { createFurni, type NewFurniOptions } from './newfurni';
import { makeShadow } from './shadow';
import type { HabboPose } from './habbo';
import { addHangLayer, keepLeftWallPictures, listLayer, needsHangLayer, needsLeftWallPictures, readData, stateCount } from './layers';
import { Icon, Logo } from './components/Icon';

/** How a change joins the undo history: `group` merges edits in a row (a painting session, arrow-key nudges);
 *  `both` copies both casts first because the change touches both. */
export interface EditOptions {
  group?: string;
  both?: boolean;
}
export type Edit = (what: string, fn: () => void, opts?: EditOptions) => void;

function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} hours ago` : new Date(at).toLocaleString();
}

const DEFAULT_HOST = 'https://images.habbo-danmark.com/hof_furni/';
const DEFAULT_SITE = 'https://habbo-danmark.com';
/** The hotel's website for its Habbo pictures: through the dev server's proxy in development (same origin). */
const DEV = !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
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
 * `?embed=housekeeping&parent=<the CMS origin>`: in a frame of its page, or popped out of it into a window of its own
 * (then the page is this window's opener). Messages only go to and come from that origin and that window:
 * the page sends `open` (a furni's casts), `published`, `status`, `handover` (asks for what is open, to carry it to
 * the editor in the other place) and `close` (it was carried over: close without a warning); the editor sends `ready`, `state`, `publish` (both casts) and `handover` (the open
 * casts as they are now). From a window of its own every message says `popup: true`.
 * The editor never calls the CMS itself.
 */
/** A wall item whose first picture is taller than a wall takes gets a first layer the hotel can hang it by
 *  (layers.ts addHangLayer). True when a cast got one. */
function makeHangable(...docs: (CastDocument | null | undefined)[]): boolean {
  let did = false;
  for (const d of docs) {
    if (!d) continue;
    // first the walls the hotel's way round (left wall pictures, mirrored for the right wall), then the first layer
    if (needsLeftWallPictures(new Furni(d))) keepLeftWallPictures(d, new Furni(d));
    const f = new Furni(d);
    if (needsHangLayer(f)) {
      addHangLayer(d, f);
      did = true;
    }
  }
  return did;
}

const EMBED = (() => {
  const q = new URLSearchParams(location.search);
  if (q.get('embed') !== 'housekeeping') return null;
  const framed = window.parent !== window;
  const host: Window | null = framed ? window.parent : (window.opener as Window | null);
  if (!host) return null;
  try {
    return { origin: new URL(q.get('parent') ?? '').origin, host, popup: !framed };
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
  const [tab, setTab] = useState<'furni' | 'layers' | 'states' | 'members'>('furni');
  // What the room shows: the direction the furni is turned to, its state (0-based) and its part colours.
  const [direction, setDirection] = useState(2);
  const [viewState, setViewState] = useState(0);
  const [colors, setColors] = useState('');
  // A Habbo in the room, and the seat height it sits or lies at (the definition's top_height when publishing).
  const [pose, setPoseState] = useState<HabboPose>('none');
  const [seat, setSeat] = useState(1);
  const setPose = (p: HabboPose) => {
    setPoseState(p);
    // the usual heights to start from: a chair's seat is 1.0, a bed's 1.6
    if (p === 'lay' && seat === 1) setSeat(1.6);
    else if (p === 'sit' && seat === 1.6) setSeat(1);
  };
  const [site, setSite] = useState(() => stored('furniEditor.site', DEFAULT_SITE));
  const [painting, setPainting] = useState<number | null>(null);
  const [lighting, setLighting] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('auto');
  const [host, setHost] = useState(() => stored('furniEditor.host', DEFAULT_HOST));
  const [className, setClassName] = useState(() => stored('furniEditor.class', 'chair_norja'));
  const [templateClass] = useState(() => stored('furniEditor.template', 'chair_norja'));
  const [flashSmall, setFlashSmall] = useState(() => stored('furniEditor.flashSmall', '0') === '1');
  const [flashKind, setFlashKind] = useState<'auto' | 'floor' | 'wall'>('auto');
  const [flashColors, setFlashColors] = useState<{ label: string; colour: string }[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  /** a picture dropped or pasted before anything is open: the New furni dialog starts with it */
  const [newPicture, setNewPicture] = useState<File | null>(null);
  /** Dragging in the room moves the furni's pictures (their registration points) instead of selecting them. */
  const [moveMode, setMoveMode] = useState(false);
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
  const smallShown = furni?.isSmallCast() ?? false;

  // --- undo, and which content each cast holds ---
  const history = useRef(new History());
  const [, setHistRev] = useState(0);
  /** A content generation per size: a change gives the cast a new one, undo puts the old one back; `saved` is the
   *  generation last saved or published, so a cast undone back to it is clean again. */
  const gens = useRef<Record<SideKey, number>>({ large: 0, small: 0 });
  const saved = useRef<Record<SideKey, number>>({ large: 0, small: 0 });
  const nextGen = useRef(1);
  /** The 32 px cast follows the 64 px one: it was made from it (and never changed by hand), so it is made again after
   *  every change to the large cast. `followedGen` is the large generation it was last made from. */
  const [smallFollows, setSmallFollows] = useState(false);
  const followedGen = useRef(0);
  /** The open small cast was made with the editor's earlier halving: the next sync makes it again and says so. */
  const remakeSmall = useRef(false);
  const live = useRef({ doc, other, fileName, dirty, smallShown, smallFollows });
  live.current = { doc, other, fileName, dirty, smallShown, smallFollows };
  const keys = (small: boolean): [SideKey, SideKey] => (small ? ['small', 'large'] : ['large', 'small']);

  /** Housekeeping carried what is open here to the editor in the other place: nothing is lost by closing this one. */
  const released = useRef(false);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if ((dirty || other?.dirty) && !released.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, other]);
  const anyDirty = dirty || !!other?.dirty;

  /** Show a new furni (and its other size, when there is one), dropping the open ones and their history. */
  const show = useCallback(
    (next: CastDocument, name: string, changed: boolean, pair: Side | null = null, follows?: boolean) => {
      doc?.free();
      other?.doc.free();
      history.current.clear();
      setHistRev((h) => h + 1);
      const shown = new Furni(next);
      const [mine, theirs] = keys(shown.isSmallCast());
      gens.current = { large: 0, small: 0 };
      // An untouched small cast (exactly what the editor makes from the large one) keeps following it. One made with
      // the editor's earlier halving is made again right away, with the sharper pictures.
      const made = follows === undefined && !!pair && !shown.isSmallCast() && madeFromLarge(next, pair.doc, shown.className());
      remakeSmall.current = made === 'earlier';
      followedGen.current = made === 'earlier' ? -1 : 0;
      setSmallFollows(follows ?? !!made);
      saved.current = { [mine]: changed ? -1 : 0, [theirs]: pair?.dirty ? -1 : 0 } as Record<SideKey, number>;
      setOther(pair);
      setDoc(next);
      setViewState(0);
      // each furni starts without a Habbo: sitting or lying on it also tells Housekeeping it is a seat or a bed
      setPoseState('none');
      setSeat(1);
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
    (bytes: Uint8Array, name: string, pair?: { bytes: Uint8Array; name: string }, changed = false) => {
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
        show(next, mainName, changed, pairDoc ? { doc: pairDoc, name: pairName, dirty: changed } : null);
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
      const plan = planFlash(swf, file.name, { small: flashSmall, kind: flashKind });
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
      // a Flash wall item can be taller than a wall takes here: the hotel couldn't hang it as it is
      const hung = makeHangable(next, small);
      show(next, largeFileName(plan.sprite), true, small ? { doc: small, name: smallFileName(plan.sprite), dirty: true } : null);
      setFlashColors(plan.colors.map((c) => ({ label: `flash colour ${c.id}: ${c.colour}`, colour: c.colour })));
      const aliases = plan.fields.find((f) => f.name === ALIAS_INDEX)?.text.split('\n').length ?? 0;
      setStatus(
        `Converted ${file.name}: ${plan.sprite}, ${plan.wall ? 'a wall item' : `${plan.dims[0]}×${plan.dims[1]}`}, ${plan.bitmaps.length} pictures${small ? ' (with a small cast)' : ''}, ${aliases} aliases, ` +
          `${plan.fields.map((f) => f.name).join(', ')}` + (plan.colors.length ? `; ${plan.colors.length} colour variants` : '') +
          (hung ? '. Its picture is taller than a wall takes, so it got a first layer the hotel hangs it by (layer a; your pictures start at b)' : '') +
          (plan.warnings.length ? `. Warnings: ${plan.warnings.slice(0, 4).join('; ')}${plan.warnings.length > 4 ? ` (+${plan.warnings.length - 4})` : ''}` : ''),
      );
    } catch (e) {
      setStatus(`Couldn't convert ${file.name}: ${e}`);
    } finally {
      swf?.free();
    }
  };

  /** A new furni from pictures (or empty, to paint): built on the hotel's template cast like a Flash import, with its
   *  shadow, icon and small cast. Returns why it failed, or null. */
  const createNew = async (o: NewFurniOptions): Promise<string | null> => {
    if (anyDirty && !confirm('Discard the changes to the open cast?')) return 'Kept the open cast';
    try {
      const template = `hh_furni_xx_${templateClass.trim() || 'chair_norja'}.cct`;
      const res = await fetch(host.replace(/\/?$/, '/') + template);
      if (!res.ok) throw new Error(`couldn't load the template cast ${template} (HTTP ${res.status})`);
      const made = createFurni(new Uint8Array(await res.arrayBuffer()), o);
      const hung = makeHangable(made.large, made.small);
      show(made.large, largeFileName(o.name), true, { doc: made.small, name: smallFileName(o.name), dirty: true }, true);
      setFlashColors([]);
      setHotelFurni(null);
      setNewOpen(false);
      setNewPicture(null);
      setMoveMode(!made.blank && o.kind === 'floor');
      const f = new Furni(made.large);
      const first = f.members.find((m) => m.type === 'bitmap' && /_a_0(_|$)/.test(m.name));
      if (made.blank && first) setPainting(first.slot);
      else if (first) setSelected({ slot: first.slot });
      setStatus(
        made.blank
          ? `Made ${o.name} with an empty canvas over its tiles: paint it here (the tiles show where it stands), then "Make icon" under the room`
          : o.kind === 'wall'
            ? `Made ${o.name}: a wall item with its mirror image for the right wall, an icon and a 32 px version${hung ? '. Its picture is taller than a wall takes, so it got a first layer the hotel hangs it by (layer a; yours is b)' : ''}`
            : `Made ${o.name}: it stands on its tiles with ${o.shadow ? 'a shadow, ' : ''}an icon and a 32 px version. Drag it in the room to place it exactly`,
      );
      return null;
    } catch (e) {
      return `Couldn't make the furni: ${e instanceof Error ? e.message : e}`;
    }
  };

  /** Run a change to the document as one undo step (copying the casts it touches first), then refresh everything
   *  that shows it. */
  const edit: Edit = useCallback((what: string, fn: () => void, opts: EditOptions = {}) => {
    const now = live.current;
    if (!now.doc) return;
    const [mine, theirs] = keys(now.smallShown);
    const both = !!(opts.both && now.other);
    const group = opts.group ? `${mine}:${opts.group}` : undefined;
    let step: Step | null = null;
    if (!history.current.joins(group)) {
      const sides: Step['sides'] = { [mine]: { doc: now.doc.snapshot(), name: now.fileName, gen: gens.current[mine] } };
      if (both) sides[theirs] = { doc: now.other!.doc.snapshot(), name: now.other!.name, gen: gens.current[theirs] };
      step = { what, group, at: Date.now(), sides };
    }
    try {
      fn();
    } catch (e) {
      if (step) for (const s of Object.values(step.sides)) s?.doc.free();
      setStatus(`${what}: ${e}`);
      return;
    }
    if (step) history.current.push(step);
    else history.current.extend(what);
    gens.current[mine] = nextGen.current++;
    if (both) {
      gens.current[theirs] = nextGen.current++;
      setOther((o) => (o ? { ...o, dirty: true } : o));
    }
    let note = '';
    if (now.smallFollows && now.other) {
      if (mine === 'small' && !both) {
        // changed by hand: from here on the small cast is its own
        setSmallFollows(false);
        note = ' · the 32 px version no longer follows the 64 px one (the ↻ next to "32 px" makes it from the large pictures again)';
      } else if (both) {
        // both changed alike: still what the large one gives
        followedGen.current = gens.current.large;
      }
    }
    setRev((r) => r + 1);
    setDirty(true);
    setHistRev((h) => h + 1);
    setStatus(what + note);
  }, []);

  /** The casts as they are now, for the step that will bring them back (the documents move, nothing is copied). */
  const currentSides = (want: SideKey[]): Step['sides'] => {
    const now = live.current;
    const [mine] = keys(now.smallShown);
    const out: Step['sides'] = {};
    for (const k of want) {
      if (k === mine && now.doc) out[k] = { doc: now.doc, name: now.fileName, gen: gens.current[k] };
      else if (k !== mine && now.other) out[k] = { doc: now.other.doc, name: now.other.name, gen: gens.current[k] };
    }
    return out;
  };
  const applyStep = (step: Step, verb: string) => {
    const now = live.current;
    const [mine] = keys(now.smallShown);
    let nextOther = now.other;
    for (const [k, snap] of Object.entries(step.sides) as [SideKey, Snap][]) {
      gens.current[k] = snap.gen;
      const changed = snap.gen !== saved.current[k];
      if (k === mine) {
        setDoc(snap.doc);
        setFileName(snap.name);
        setDirty(changed);
      } else {
        nextOther = { doc: snap.doc, name: snap.name, dirty: changed };
      }
    }
    setOther(nextOther);
    setRev((r) => r + 1);
    setHistRev((h) => h + 1);
    setStatus(`${verb}: ${step.what}`);
  };
  const undo = () => {
    const step = history.current.undo(currentSides);
    if (step) applyStep(step, 'Undid');
  };
  const redo = () => {
    const step = history.current.redo(currentSides);
    if (step) applyStep(step, 'Redid');
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (painting !== null || !(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement;
      if (t?.tagName === 'TEXTAREA' || (t?.tagName === 'INPUT' && ['text', 'number', 'search'].includes((t as HTMLInputElement).type))) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- autosave: the open casts in this browser while they have unsaved changes ---
  const [restore, setRestore] = useState<Autosave | null>(null);
  useEffect(() => {
    if (ready) loadAutosave().then((r) => r && setRestore(r));
  }, [ready]);
  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() => {
      const now = live.current;
      if (!now.doc) return;
      if (!now.dirty && !now.other?.dirty) {
        clearAutosave();
        return;
      }
      const [mine, theirs] = keys(now.smallShown);
      try {
        const rec: Autosave = { at: Date.now(), shown: mine, colors: flashColors };
        rec[mine] = { bytes: now.doc.save(), name: now.fileName, dirty: now.dirty };
        if (now.other) rec[theirs] = { bytes: now.other.doc.save(), name: now.other.name, dirty: now.other.dirty };
        writeAutosave(rec);
      } catch (e) {
        console.error('autosave', e);
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [doc, rev, dirty, other]);
  const restoreWork = () => {
    if (!restore) return;
    const first = restore[restore.shown] ?? restore.large ?? restore.small;
    const second = first === restore.large ? restore.small : restore.large;
    if (!first) return;
    try {
      const main = new CastDocument(first.bytes);
      const pair = second ? { doc: new CastDocument(second.bytes), name: second.name, dirty: second.dirty } : null;
      show(main, first.name, first.dirty, pair);
      setFlashColors(restore.colors ?? []);
      setStatus(`Restored ${[first.name, second?.name].filter(Boolean).join(' and ')} from ${ago(restore.at)}`);
    } catch (e) {
      setStatus(`Couldn't restore the unsaved casts: ${e}`);
    }
    setRestore(null);
  };
  const discardWork = () => {
    clearAutosave();
    setRestore(null);
  };

  /** Make the 32 px cast again from the 64 px one (when it follows it and the large cast changed since). Returns the
   *  small cast as it is afterwards. */
  const syncSmall = (force = false): Side | null => {
    const now = live.current;
    if (!now.doc || !now.other || now.smallShown) return now.other;
    if (!force && (!now.smallFollows || followedGen.current === gens.current.large)) return now.other;
    try {
      const cls = new Furni(now.doc).className();
      const next: Side = { doc: makeSmall(now.doc, cls), name: smallFileName(cls), dirty: true };
      const old = now.other.doc;
      followedGen.current = gens.current.large;
      gens.current.small = nextGen.current++;
      live.current = { ...now, other: next };
      setOther(next);
      setTimeout(() => old.free(), 2000); // after everything that showed it has let go
      if (remakeSmall.current) {
        remakeSmall.current = false;
        setStatus('The 32 px version was made with the editor\'s earlier halving: made it again with sharper pictures (save or publish to keep it)');
      }
      return next;
    } catch (e) {
      console.error('32 px', e);
      return now.other;
    }
  };
  // A little after the last change to the large cast, so dragging and painting stay light.
  useEffect(() => {
    if (!smallFollows || smallShown || !other) return;
    const t = setTimeout(() => syncSmall(), 500);
    return () => clearTimeout(t);
  }, [rev, smallFollows, smallShown, doc]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The ↻ next to "32 px": the small cast made from the large pictures again, and following them from now on. */
  const followAgain = () => {
    if (!doc || !other || smallShown) return;
    if (!confirm(`Make the 32 px version again from the 64 px pictures? What ${other.name} has now is replaced (the large cast is not changed).`)) return;
    setSmallFollows(true);
    syncSmall(true);
    setStatus('Made the 32 px version from the 64 px pictures: it follows them again');
  };

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
      const [mine, theirs] = keys(smallShown);
      const pair = syncSmall();
      const done = [saveOne(doc, castName(furni, fileName))];
      setDirty(false);
      saved.current[mine] = gens.current[mine];
      if (pair?.dirty) {
        done.push(saveOne(pair.doc, castName(new Furni(pair.doc), pair.name)));
        setOther({ ...pair, dirty: false });
        saved.current[theirs] = gens.current[theirs];
      }
      const n = issues.filter((i) => i.level === 'error').length;
      setStatus(`Saved ${done.join(' and ')}` + (n ? `. Check furni found ${n} error${n > 1 ? 's' : ''} Housekeeping would refuse` : ''));
    } catch (e) {
      setStatus(`Save failed: ${e}`);
    }
  };

  // --- Housekeeping ---
  const [hotelFurni, setHotelFurni] = useState<{ sprite: string; madeHere: boolean } | null>(null);
  /** A message to Housekeeping's page. False when it can't be reached (this is a window of its own and the page is closed). */
  const toParent = (message: Record<string, unknown>, transfer: Transferable[] = []): boolean => {
    if (!EMBED || EMBED.host.closed) return false;
    EMBED.host.postMessage(EMBED.popup ? { ...message, popup: true } : message, EMBED.origin, transfer);
    return true;
  };
  /** What is open, as it is now (unsaved changes included), for the editor in the other place (the page or the window). */
  const handOver = useRef<() => void>(() => undefined);
  handOver.current = () => {
    if (!doc || !furni) return void toParent({ type: 'handover' });
    try {
      const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      const mine = { name: fileName, bytes: buf(doc.save()) };
      const theirs = other ? { name: other.name, bytes: buf(other.doc.save()) } : undefined;
      const [large, small] = furni.isSmallCast() ? [theirs, mine] : [mine, theirs];
      toParent(
        { type: 'handover', sprite: furni.className(), large, small, colors: flashColors, shown: colors, hotel: hotelFurni, dirty: anyDirty, height: seat },
        [large, small].flatMap((c) => (c ? [c.bytes] : [])),
      );
    } catch (e) {
      console.error('handover', e);
      toParent({ type: 'handover' });
    }
  };
  useEffect(() => {
    if (!EMBED || !ready) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== EMBED.origin || e.source !== EMBED.host) return;
      const m = e.data ?? {};
      if (m.type === 'handover') {
        handOver.current();
      } else if (m.type === 'close') {
        // what was open here is in the other editor now
        released.current = true;
        if (EMBED.popup) window.close();
      } else if (m.type === 'open' && m.handover && (m.large?.bytes instanceof ArrayBuffer || m.small?.bytes instanceof ArrayBuffer)) {
        // what the editor in the other place had open, carried over as it was: unsaved work stays unsaved
        const first = m.large ?? m.small;
        const pair = m.large && m.small ? { bytes: new Uint8Array(m.small.bytes), name: String(m.small.name) } : undefined;
        open(new Uint8Array(first.bytes), String(first.name), pair, !!m.dirty);
        if (Array.isArray(m.colors)) setFlashColors(m.colors.filter((c: { colour?: unknown }) => typeof c?.colour === 'string'));
        if (typeof m.shown === 'string') setColors(m.shown);
        setHotelFurni(m.hotel && typeof m.hotel.sprite === 'string' ? { sprite: m.hotel.sprite, madeHere: !!m.hotel.madeHere } : null);
        if (typeof m.height === 'number' && m.height >= 0) setSeat(m.height);
        setStatus(`${m.sprite || first.name} is here now, as it was${m.dirty ? ' (with its unsaved changes)' : ''}. Publish… still goes to Housekeeping${EMBED.popup ? "'s window" : ''}`);
      } else if (m.type === 'open' && (m.large?.bytes instanceof ArrayBuffer || m.small?.bytes instanceof ArrayBuffer)) {
        const first = m.large ?? m.small;
        const pair = m.large && m.small ? { bytes: new Uint8Array(m.small.bytes), name: String(m.small.name) } : undefined;
        open(new Uint8Array(first.bytes), String(first.name), pair);
        if (Array.isArray(m.colors)) setFlashColors(m.colors.filter((c: { colour?: unknown }) => typeof c?.colour === 'string'));
        setHotelFurni({ sprite: String(m.sprite ?? ''), madeHere: !!m.madeHere });
        // the seat height of its definition: the Habbo in the room sits or lies there
        if (typeof m.height === 'number' && m.height >= 0) setSeat(m.height);
        if (!m.madeHere) setStatus(`${m.sprite} is the hotel's own furni: it is never written over. "New furni from this…" makes a copy you can publish.`);
        else if (m.revision) setStatus(`Opened ${m.sprite} r${m.revision} (an earlier version: publishing it makes a new revision)`);
      } else if (m.type === 'published') {
        setStatus(String(m.text ?? ''));
        if (m.ok) {
          setDirty(false);
          setOther((o) => (o ? { ...o, dirty: false } : o));
          saved.current = { ...gens.current };
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

  /** Hand both casts to Housekeeping, which checks them and asks before anything is written. A hotel furni first gets a
   *  name of its own (the name dialog), then goes on from here. */
  const publish = (afterRename = false) => {
    if (!doc || !furni) return;
    const cls = new Furni(doc).className();
    if (!cls) return setStatus('The cast has no furni class to publish');
    if (!afterRename && hotelFurni && !hotelFurni.madeHere && hotelFurni.sprite.toLowerCase() === cls.toLowerCase()) return askName('publish');
    const errors = afterRename ? 0 : issues.filter((i) => i.level === 'error').length;
    if (errors) {
      setCheckOpen(true);
      return setStatus(`Check furni found ${errors} error${errors > 1 ? 's' : ''}: Housekeeping would refuse the cast. Fix ${errors > 1 ? 'them' : 'it'} first`);
    }
    try {
      const mine = doc.save();
      const theirs = syncSmall()?.doc.save();
      const [large, small] = furni.isSmallCast() ? [theirs, mine] : [mine, theirs];
      if (!large) return setStatus(`Only the small cast is open: open or make the large one (${largeFileName(cls)}) too`);
      const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      const states = stateCount(readData(new Furni(furni.isSmallCast() && other ? other.doc : doc)));
      const msg = { type: 'publish', sprite: cls, large: buf(large), small: small ? buf(small) : undefined, colour: colors.trim() || flashColors[0]?.colour, states, wall: openWall,
        // what the Habbo in the room was set to: the kind of furni and its seat height
        kind: pose === 'sit' ? 'seat' : pose === 'lay' ? 'bed' : undefined, height: pose === 'sit' || pose === 'lay' ? seat : undefined };
      if (!toParent(msg, [msg.large, ...(msg.small ? [msg.small] : [])])) {
        return setStatus("Housekeeping's page is closed: open its furni editor page again and use its \"own window\" button (Download keeps what is open here as files)");
      }
      setStatus(`Sent ${cls} to Housekeeping: confirm it in ${EMBED?.popup ? "Housekeeping's window" : 'the panel on the left'} (the check report and its definition)`);
    } catch (e) {
      setStatus(`Couldn't save the casts: ${e}`);
    }
  };

  // --- large and small ---
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
      target = (toSmall ? syncSmall() : null) ?? other;
    } else if (toSmall) {
      const cls = furni.className();
      if (!confirm(`${cls} has no small (32 px) cast open. Make ${smallFileName(cls)} from the large pictures (halved)?`)) return;
      try {
        target = { doc: makeSmall(doc, cls), name: smallFileName(cls), dirty: true };
        gens.current.small = nextGen.current++;
        saved.current.small = -1;
        followedGen.current = gens.current.large;
        setSmallFollows(true);
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
    const name = memberNameFor(g, letter, direction, frame);
    const template = templateFor(letter);
    if (!template) return setStatus('No bitmap in the cast to base a new member on');
    const img = await readImage(file);
    if (!img) return;
    const t = furni.bySlot.get(template)!.bitmap!;
    // Where the furni shows a direction as the mirror image of this one (4 of 2, 6 of 0), the new picture gets its
    // mirrored name too, like the ones it already has.
    const rowA = g.rows.find((r) => r.letter === 'a');
    const twins = (g.wall ? [[4, 2]] : [[4, 2], [6, 0]])
      .filter(([to, from]) => {
        const cells = [...(rowA?.dirs.get(to)?.values() ?? [])];
        return from === direction && cells.length > 0 && cells.every((c) => c.aliasOf && c.flip);
      })
      .map(([to]) => to);
    edit(`Added ${name}${twins.length ? ` (and its mirror image for ${g.wall ? 'the right wall' : `direction ${twins.join(' and ')}`})` : ''}`, () => {
      const slot = doc.addBitmap(template, name, img.rgba, img.width, img.height, Math.min(t.regX, img.width), Math.min(t.regY, img.height), importMode);
      if (twins.length) {
        const aliasSlot = ensureField(ALIAS_INDEX);
        const text = (doc.text(aliasSlot) ?? '').replace(/\s+$/, '');
        doc.setText(aliasSlot, [text, ...twins.map((to) => `${memberNameFor(g, letter, to, frame)}=${name}*`)].filter((l) => l.trim()).join('\n'));
      }
      setSelected({ slot });
    });
  };

  const addLayer = async (letter: string) => {
    if (!furni || !doc) return;
    const g = gridModel(furni);
    // In the furni's main view: direction 2 when it has pictures of its own there, else its first own direction.
    const own = [...(g.rows[0]?.dirs.entries() ?? [])].filter(([, frames]) => [...frames.values()].some((c) => !c.aliasOf)).map(([d]) => d);
    const dir = own.includes(2) ? 2 : own.length ? Math.min(...own) : 2;
    const before = live.current.doc;
    await addFrame(letter, dir, 0);
    // With a .data the client draws exactly the layers it lists (a wall item always has one): list the new layer,
    // frame 0 in every state.
    const now = live.current.doc;
    if (!now || now !== before) return;
    const fresh = new Furni(now);
    if (!gridModel(fresh).rows.some((r) => r.letter === letter)) return; // no picture was picked
    if (g.wall || readData(fresh)) edit(`Listed layer ${letter} in ${g.cls}.data`, () => listLayer(now, fresh, letter, g.wall), { group: 'addlayer' });
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
      for (const [from, to] of g.wall ? [[2, 4]] : [[2, 4], [0, 6]]) {
        const src = row.dirs.get(from);
        if (!src) continue;
        for (const [frame, cell] of src) {
          if (cell.aliasOf) continue;
          const own = row.dirs.get(to)?.get(frame);
          if (own && !own.aliasOf) continue;
          lines.push(`${memberNameFor(g, row.letter, to, frame)}=${cell.name}*`);
        }
      }
    }
    if (!lines.length) return setStatus(g.wall ? 'The right wall already has members or aliases' : 'Directions 4 and 6 already have members or aliases');
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
    edit(`Deleted ${m.name}`, () => {
      doc.delete(slot);
      // its alias names (a mirrored direction) go with it: they would point at nothing
      const aliasSlot = m.type === 'bitmap' ? furni.fieldSlot(ALIAS_INDEX) : undefined;
      if (aliasSlot) {
        const lines = (doc.text(aliasSlot) ?? '').split(/\r?\n|\r/);
        const kept = lines.filter((l) => l.slice(l.indexOf('=') + 1).trim().replace(/\*$/, '').toLowerCase() !== m.name.toLowerCase());
        if (kept.length !== lines.length) doc.setText(aliasSlot, kept.join('\n'));
      }
    });
    setSelected(null);
  };

  /** Why a class name can't be used, or null when it can. */
  const nameProblem = (next: string, old: string) => {
    if (next && next === old) return `It's called ${old} already`;
    return classNameProblem(next);
  };

  /** The name dialog: renaming, copying a hotel furni, or the copy a hotel furni needs before it can be published. */
  const [nameAsk, setNameAsk] = useState<{ title: string; text: string; confirm: string; value: string; then?: 'publish' } | null>(null);
  const isHotelFurni = !!(EMBED && hotelFurni && !hotelFurni.madeHere && furni && hotelFurni.sprite.toLowerCase() === furni.className().toLowerCase());
  // Tell Housekeeping what is open, so its steps box can say where you are.
  const openClass = furni?.className() ?? '';
  const openWall = useMemo(() => (furni ? isWallItem(furni) : false), [furni, rev]);
  useEffect(() => {
    if (EMBED && ready) toParent({ type: 'state', sprite: openClass, hotel: isHotelFurni, wall: openWall });
  }, [openClass, isHotelFurni, openWall, ready]);
  const askName = (then?: 'publish') => {
    if (!furni) return;
    const old = furni.className();
    setNameAsk(
      isHotelFurni || then === 'publish'
        ? {
            title: then === 'publish' ? 'Publish as your own furni' : 'Make your own copy',
            text: `${old} is the hotel's own furni: it is never written over. Your copy gets a name of its own and is published as a new furni; ${old} stays as it is.`,
            confirm: then === 'publish' ? 'Copy and publish' : 'Make the copy',
            value: `${old}_2`,
            then,
          }
        : {
            title: `Rename ${old}`,
            text: hotelFurni?.madeHere
              ? `${old} is already in the hotel. A new name publishes a new furni with its own definition; ${old} stays in the hotel as it is.`
              : 'Every member of the furni (both sizes), its fields and its indexes get the new name. This is the class the hotel and the catalogue know it by.',
            confirm: 'Rename',
            value: old,
          },
    );
  };

  /** Rename the whole furni: every member of the class, its fields and the alias and asset indexes. */
  const cloneAs = (nextName?: string) => {
    if (!doc || !furni) return false;
    const old = furni.className();
    const next = (nextName ?? '').trim();
    const problem = nameProblem(next, old);
    if (problem) return setStatus(problem), false;
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
    }, { both: true });
    return true;
  };

  // --- check furni ---
  const [checkOpen, setCheckOpen] = useState(false);
  const otherFurni = useMemo(() => (other ? new Furni(other.doc) : null), [other, rev]);
  const issues: Issue[] = useMemo(() => {
    if (!furni) return [];
    try {
      return checkFurni(smallShown ? { small: furni, large: otherFurni ?? undefined } : { large: furni, small: otherFurni ?? undefined });
    } catch (e) {
      console.error('check', e);
      return [];
    }
  }, [furni, otherFurni, smallShown]);
  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warningCount = issues.filter((i) => i.level === 'warning').length;

  // --- the icon (<class>_small), from the preview's view ---
  const makeIcon = (v: IconView = { direction, state: viewState, colors }) => {
    if (!doc || !furni) return;
    const cls = furni.className();
    // Drawn from the 32 px cast's own pictures when it's open, else from the 64 px ones halved.
    const smallDoc = smallShown ? doc : other?.doc;
    const src = smallDoc ? { doc: smallDoc, furni: smallShown ? furni : otherFurni! } : { doc, furni };
    const img = renderIcon(src.doc, src.furni, v, !!smallDoc);
    if (!img) return setStatus('Nothing to draw: the icon is made from floor furni layers in the preview\'s direction');
    const targets = [doc, other?.doc].filter((d): d is CastDocument => !!d);
    const old = iconMembers(furni);
    if (old.length && !confirm(`Replace ${old.map((o) => o.name).join(' and ')} with the furni as the preview shows it (direction ${img.direction}, ${img.width}×${img.height})?`)) return;
    edit(`Made the icon ${cls}_small from direction ${img.direction}: ${img.width}×${img.height}${targets.length > 1 ? ', in both casts' : ''}`, () => {
      for (const d of targets) {
        const f = new Furni(d);
        const icons = iconMembers(f);
        const main = icons.find((i) => i.name.toLowerCase() === `${cls.toLowerCase()}_small`);
        // Colour parts of a drawn icon (_small_c) would be tinted over the new picture.
        for (const extra of icons) if (extra !== main) d.delete(extra.slot);
        const regX = Math.floor(img.width / 2), regY = Math.floor(img.height / 2);
        if (main) d.setBitmap(main.slot, img.rgba, img.width, img.height, regX, regY, 'auto', 0);
        else {
          const template = f.members.find((m) => m.type === 'bitmap')?.slot;
          if (!template) throw new Error('the cast has no bitmap to base the icon on');
          d.addBitmap(template, `${cls}_small`, img.rgba, img.width, img.height, regX, regY, 'auto');
        }
      }
    }, { both: true });
  };

  const pickIssue = (i: Issue) => {
    const want = i.side === 'small';
    if (want !== smallShown) switchSize(want);
    if (i.slot !== undefined) setSelected({ slot: i.slot });
    setPainting(null);
  };
  const fixIssue = (i: Issue) => {
    if (i.fix === 'icon') makeIcon();
    else if (i.fix === 'shadow') shadow();
    else if (i.fix === 'small') switchSize(true);
    else if (i.fix === 'rename') askName();
    else if (i.fix === 'hang') hang();
    else if (i.fix === 'walls') turnWalls();
  };

  /** Dragging in the room: the pictures' registration points follow the mouse (a mirrored picture the other way). */
  const moveLayers = (targets: { slot: number; flip: boolean; regX: number; regY: number }[], dx: number, dy: number, whole: boolean) => {
    if (!doc || !furni || !targets.length) return;
    const seen = new Set<number>();
    const list = targets.filter((t) => !seen.has(t.slot) && seen.add(t.slot));
    const what = whole ? `Moved the furni ${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy} px on its tiles` : `Moved ${furni.bySlot.get(list[0].slot)?.name ?? 'the layer'} ${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy} px`;
    edit(what, () => {
      for (const t of list) doc.setRegPoint(t.slot, t.regX + (t.flip ? dx : -dx), t.regY - dy);
    }, { group: `move:${list.map((t) => t.slot).join(',')}` });
  };

  /** The shadow, in the shown cast and in the other size when it's open. */
  /** A wall item that keeps the right wall's pictures gets the left wall's instead, as the hotel's are (both sizes). */
  const turnWalls = () => {
    if (!doc || !furni) return;
    let summary = '';
    edit('Turned its walls round', () => {
      summary = keepLeftWallPictures(doc, furni);
      const o = other ? new Furni(other.doc) : null;
      if (other && o && needsLeftWallPictures(o)) keepLeftWallPictures(other.doc, o);
    }, { both: true });
    if (summary) setStatus(summary);
  };
  /** A wall item whose first picture doesn't fit a wall gets a first layer the hotel can hang it by (both sizes). */
  const hang = () => {
    if (!doc || !furni) return;
    let summary = '';
    edit('Made it hangable', () => {
      summary = addHangLayer(doc, furni);
      const o = other ? new Furni(other.doc) : null;
      if (other && o && needsHangLayer(o)) addHangLayer(other.doc, o);
    }, { both: true });
    if (summary) setStatus(`${summary}. "try placing" under the room shows where it goes now`);
  };
  const shadow = () => {
    if (!doc || !furni) return;
    const has = gridModel(furni).shadows.filter((c) => !c.aliasOf).length;
    if (has && !confirm(`Replace the furni's shadow (${has} picture${has > 1 ? 's' : ''}) with a plain one on its tiles?`)) return;
    let summary = '';
    edit('Made the shadow', () => {
      summary = makeShadow(doc, furni);
      if (other) makeShadow(other.doc, new Furni(other.doc));
    }, { both: true });
    if (summary) setStatus(summary + (other ? ', in both sizes' : '') + '. Paint it to shape it');
  };

  const sel = selected && furni?.bySlot.has(selected.slot) ? selected : null;
  /** The furni's main picture: layer a's first own picture (direction 2 first). */
  const firstPicture = useMemo(() => {
    if (!furni) return undefined;
    const row = gridModel(furni).rows[0];
    const dirs = [...(row?.dirs.entries() ?? [])].sort((a, b) => (a[0] === 2 ? -1 : b[0] === 2 ? 1 : a[0] - b[0]));
    for (const [, frames] of dirs) for (const c of frames.values()) if (!c.aliasOf) return c.slot;
    return undefined;
  }, [furni]);
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
    else if (/^image\//.test(file.type) || /\.(png|gif|jpe?g)$/i.test(file.name)) takePicture(file);
  };

  /** A picture dropped on the window or pasted: over the selected picture, or the start of a new furni. */
  const takePicture = (file: File) => {
    const m = sel && furni?.bySlot.get(sel.slot);
    if (m?.type === 'bitmap') importInto(m.slot, file);
    else if (!doc) {
      setNewPicture(file);
      setNewOpen(true);
    } else setStatus('Select a picture to put it over first (or drop it on a + cell for a new frame; "New" starts a new furni from it)');
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (newOpen || painting !== null) return; // the dialog takes pictures itself
      const t = e.target as HTMLElement | null;
      if (t?.tagName === 'TEXTAREA' || t?.tagName === 'INPUT') return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      takePicture(file);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

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
      {other && !smallShown && (
        smallFollows
          ? <span className="follows" title="The 32 px version is made from the 64 px pictures and follows every change to them. Change the 32 px cast by hand and it becomes its own">auto</span>
          : <button className="refresh" onClick={followAgain} title="Make the 32 px version again from the 64 px pictures (replaces what the 32 px cast has now); it then follows the large pictures"><Icon name="rotate" size={12} /></button>
      )}
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
          <button onClick={() => setNewOpen(true)} disabled={!ready} title="A new furni from your own pictures, or empty to paint it here">
            <Icon name="plus" />New
          </button>
          <button onClick={openFile} disabled={!ready} title="Open a .cct, or a furni's large and small cast together (you can also drop them on the window)">
            <Icon name="folder" />Open
          </button>
          {hotelField}
          <button onClick={flashImport} disabled={!ready} title="Convert a Flash furni (.swf) into a Shockwave cast; you can also drop the .swf on the window. Its options are in Settings">
            <Icon name="bolt" />Flash
          </button>
        </div>
        <span className="spacer" />
        {doc && furni && (
          <div className="tb-group">
            <span className="doc-pill" title={[fileName, other?.name].filter(Boolean).join(' + ') + (anyDirty ? ' (changed since it was saved)' : '')}>
              <span className={`dot${anyDirty ? ' dirty' : ''}`} />
              <span className="name">{furni.className() || fileName}</span>
            </span>
            {sizeSwitch}
          </div>
        )}
        <span className="spacer" />
        <div className="tb-group">
          <button className="icon ghost" onClick={undo} disabled={!history.current.canUndo || painting !== null} title={history.current.canUndo ? `Undo: ${history.current.undoLabel} (Ctrl/Cmd+Z)` : 'Nothing to undo'}>
            <Icon name="undo" />
          </button>
          <button className="icon ghost" onClick={redo} disabled={!history.current.canRedo || painting !== null} title={history.current.canRedo ? `Redo: ${history.current.redoLabel} (Ctrl/Cmd+Shift+Z)` : 'Nothing to redo'}>
            <Icon name="redo" />
          </button>
          <button className={`ghost check-btn${checkOpen ? ' on' : ''}`} onClick={() => setCheckOpen(!checkOpen)} disabled={!doc} title="Check furni: what the hotel would refuse or draw differently">
            <Icon name="check" />Check
            {doc && (errorCount ? <span className="count error">{errorCount}</span> : warningCount ? <span className="count warning">{warningCount}</span> : <span className="count ok">✓</span>)}
          </button>
          <button className="ghost" onClick={() => askName()} disabled={!doc} title={isHotelFurni ? "The hotel's furni is never written over: make a copy under a name of your own, to edit and publish" : 'Rename the furni: every member of the class (both sizes), its fields and its indexes'}>
            <Icon name="copy" />{isHotelFurni ? 'Make a copy…' : 'Rename…'}
          </button>
          <button className={EMBED ? 'ghost' : 'primary'} onClick={save} disabled={!doc} title={EMBED ? 'Download the casts as files (.cct). Publishing doesn\'t need them' : 'Save the cast as a file (and the other size when it has changes)'}>
            <Icon name={EMBED ? 'download' : 'save'} />{EMBED ? 'Download' : other?.dirty && dirty ? 'Save both' : 'Save'}
          </button>
          {EMBED && (
            <button className="primary" onClick={() => publish()} disabled={!doc} title={isHotelFurni ? "Publish a copy of the hotel's furni under a name of your own (asks for the name)" : 'Housekeeping checks the casts and asks before publishing'}>
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
            <span className="muted small">Casts are loaded from here by class name; Flash imports and new furni use its chair_norja as their template.</span>
            <h4>Flash import</h4>
            <label className="chip" title="Also convert the Flash file's own 32 px pictures into the small cast (else the small cast is made from the large pictures)">
              <input type="checkbox" checked={flashSmall} onChange={(e) => { setFlashSmall(e.target.checked); store('furniEditor.flashSmall', e.target.checked ? '1' : '0'); }} />its own 32 px pictures
            </label>
            <select value={flashKind} onChange={(e) => setFlashKind(e.target.value as 'auto' | 'floor' | 'wall')} title="Floor furni or a wall item. Decide by itself: a wall item when the Flash furni is wall-thin and only has directions 2 and 4 (left and right wall)">
              <option value="auto">floor or wall item: decide by itself</option>
              <option value="floor">always floor furni</option>
              <option value="wall">always a wall item</option>
            </select>
            <h4>Hotel website</h4>
            <input value={site} onChange={(e) => setSite(e.target.value)} onBlur={() => store('furniEditor.site', site)} spellCheck={false} title="Where the Habbo in the preview room comes from (its /habbo-imaging/avatarimage)" />
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
        {checkOpen && doc && <CheckPanel issues={issues} onPick={pickIssue} onFix={fixIssue} onClose={() => setCheckOpen(false)} />}
      </header>

      {!doc || !furni ? (
        <main className="welcome">
          <div className="hero">
            <Logo size={84} />
            <h1>Furni <em>editor</em></h1>
            <p>Edit Habbo furni casts in the browser: layers, directions and frames, a room to watch them in, pixel painting in the furni's own palettes, lights, and the 64 and 32 px casts side by side.</p>
          </div>
          {restore && (
            <div className="restore-card" role="status">
              <span className="tile-icon"><Icon name="undo" size={20} /></span>
              <div className="restore-text">
                <b>Unsaved work from {ago(restore.at)}</b>
                <span>{[restore.large?.name, restore.small?.name].filter(Boolean).join(' and ')}. Kept in this browser until you save. Changing another cast replaces it.</span>
              </div>
              <button className="primary" onClick={restoreWork} disabled={!ready}>Restore</button>
              <button className="ghost" onClick={discardWork}>Discard</button>
            </div>
          )}
          <div className="start-cards">
            <button className="start-card featured" onClick={() => setNewOpen(true)} disabled={!ready}>
              <span className="tile-icon"><Icon name="plus" size={20} /></span>
              <b>New furni</b>
              <span>From your own pictures (PNG, GIF, JPEG, or pasted), or empty to paint it here. It gets its tiles, shadow, icon and 32 px version by itself.</span>
            </button>
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
            {['New furni from your pictures', 'Layers × directions × frames', 'Room preview with inks', 'Paint & palettes', 'Lights and glows', '64 / 32 px pair', 'Flash import'].map((f) => <span key={f}>{f}</span>)}
          </div>
          {!ready && <p className="loading"><span className="spinner" />Loading DirPlayer…</p>}
        </main>
      ) : painting !== null && furni.bySlot.get(painting)?.bitmap ? (
        <main className="panes painting">
          <section className="pane paint-pane">
            <Paint key={painting} doc={doc} furni={furni} slot={painting} edit={(what, fn) => edit(what, fn, { group: `paint:${painting}` })} onClose={() => setPainting(null)} />
          </section>
          <section className="pane center">
            <Preview doc={doc} furni={furni} rev={rev} selected={painting} onPick={(slot) => paint(slot)} extraColors={flashColors} direction={direction} setDirection={setDirection} state={viewState} setState={setViewState} colors={colors} setColors={setColors} pose={pose} setPose={setPose} seat={seat} setSeat={setSeat} site={DEV ? '/hotel-site' : site} onMakeIcon={makeIcon} moveMode={moveMode} setMoveMode={setMoveMode} onMove={moveLayers} />
          </section>
        </main>
      ) : (
        <main className="panes">
          <section className="pane left">
            <div className="pane-head">
              <span className="pane-title"><Icon name="layers" size={14} />Members</span>
              <span className="spacer" />
              <span className="segmented">
                <button className={tab === 'furni' ? 'on' : ''} onClick={() => setTab('furni')} title="The furni's pictures: layers by direction and frame">Pictures</button>
                <button className={tab === 'layers' ? 'on' : ''} onClick={() => setTab('layers')} title="How each layer is drawn: ink, colour, see-through, depth">Layers</button>
                <button className={tab === 'states' ? 'on' : ''} onClick={() => setTab('states')} title="What it shows in each state (off, on...) and what moves">States</button>
                <button className={tab === 'members' ? 'on' : ''} onClick={() => setTab('members')} title="Every member of the cast">All ({furni.members.length})</button>
              </span>
            </div>
            <div className="pane-body">
              {lighting && <LightPanel doc={doc} furni={furni} edit={edit} setStatus={setStatus} onClose={() => setLighting(false)} />}
              {tab === 'furni' ? (
                <FurniGrid onAddLight={() => setLighting(true)} doc={doc} furni={furni} rev={rev} small={false} selected={sel?.slot ?? null} onSelect={(slot, alias) => setSelected({ slot, alias })} onPaint={paint} onAddFrame={addFrame} onAddLayer={addLayer} onMirror={mirror} onShadow={shadow} />
              ) : tab === 'layers' ? (
                <LayersPanel doc={doc} furni={furni} rev={rev} edit={edit} direction={direction} state={viewState} colors={colors} setColors={setColors} selected={sel?.slot ?? null} onSelect={(slot) => setSelected({ slot })} setStatus={setStatus} />
              ) : tab === 'states' ? (
                <StatesPanel doc={doc} furni={furni} rev={rev} edit={edit} direction={direction} state={viewState} setState={setViewState} setStatus={setStatus} />
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
            <Preview doc={doc} furni={furni} rev={rev} selected={sel?.slot ?? null} onPick={(slot) => setSelected({ slot })} extraColors={flashColors} direction={direction} setDirection={setDirection} state={viewState} setState={setViewState} colors={colors} setColors={setColors} pose={pose} setPose={setPose} seat={seat} setSeat={setSeat} site={DEV ? '/hotel-site' : site} onMakeIcon={makeIcon} moveMode={moveMode} setMoveMode={setMoveMode} onMove={moveLayers} />
          </section>
          <section className="pane right">
            <div className="pane-head">
              <span className="pane-title"><Icon name="inspect" size={14} />{sel ? 'Inspector' : 'What next'}</span>
              {sel && <button className="icon ghost close-sel" onClick={() => setSelected(null)} title="Done with this picture: back to what to do next"><Icon name="close" /></button>}
            </div>
            <div className="pane-body">
              {sel ? (
                <Inspector key={sel.slot} doc={doc} furni={furni} rev={rev} slot={sel.slot} alias={sel.alias} importMode={importMode} setImportMode={setImportMode} edit={edit} onImport={importInto} onExport={exportMember} onDuplicate={duplicate} onDelete={remove} onPaint={paint} />
              ) : (
                <div className="next-steps">
                  <p className="muted small">Pick a picture in the grid or the room to see it here. Or:</p>
                  {firstPicture !== undefined && (
                    <button onClick={() => paint(firstPicture)}><Icon name="brush" /><span><b>Paint it</b>Draw on its pixels, with the tiles it stands on shown</span></button>
                  )}
                  <button onClick={() => addLayer(String.fromCharCode(97 + gridModel(furni).rows.length))}><Icon name="plus" /><span><b>Add a layer</b>Another picture on top: a cushion to colour, a glass pane, a glow</span></button>
                  <button onClick={() => setTab('layers')}><Icon name="layers" /><span><b>Set how layers are drawn</b>Tinted with a colour, see-through, in front of or behind a Habbo</span></button>
                  <button onClick={() => setTab('states')}><Icon name="play" /><span><b>Make it switch or move</b>States (a lamp's off and on) and frames that play</span></button>
                  {!openWall && <button onClick={() => setPose('sit')}><Icon name="room" /><span><b>Try a Habbo on it</b>Sitting, lying or beside it: sets the seat height too</span></button>}
                  <button onClick={() => setCheckOpen(true)}><Icon name="check" /><span><b>Check it</b>{errorCount ? `${errorCount} thing${errorCount > 1 ? 's' : ''} the hotel would refuse` : warningCount ? `${warningCount} thing${warningCount > 1 ? 's' : ''} to look at` : 'Nothing found: ready for the hotel'}</span></button>
                  {EMBED && <button className="primary" onClick={() => publish()}><Icon name="upload" /><span><b>Publish…</b>Housekeeping checks it and asks before it goes into the hotel</span></button>}
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
          {doc && moveMode && <span>drag: move the furni · <kbd>Alt</kbd> drag: one layer · arrows: 1 px</span>}
          {painting !== null ? <span><kbd>Esc</kbd> done · <kbd>⌘Z</kbd> undo a stroke</span> : doc && <span><kbd>⌘Z</kbd> undo</span>}
        </div>
      </footer>
      {dragging && !newOpen && <div className="drop-overlay">Drop casts, a .swf or an image</div>}
      {newOpen && <NewFurni initial={newPicture} onCreate={createNew} onClose={() => { setNewOpen(false); setNewPicture(null); }} />}
      {nameAsk && furni && (() => {
        const old = furni.className();
        const problem = nameProblem(nameAsk.value.trim(), old);
        // the rename dialog opens on the current name: say what it will do rather than "it's called that already"
        const showProblem = problem && !(nameAsk.value.trim() === old && !isHotelFurni && !nameAsk.then);
        const ok = () => {
          if (problem) return;
          const then = nameAsk.then;
          if (cloneAs(nameAsk.value)) {
            setNameAsk(null);
            if (then === 'publish') setTimeout(() => publish(true), 0);
          }
        };
        return (
          <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setNameAsk(null)}>
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="name-ask-title">
              <h3 id="name-ask-title">{nameAsk.title}</h3>
              <p>{nameAsk.text}</p>
              <label className="modal-field">
                <span>Class name</span>
                <input autoFocus value={nameAsk.value} spellCheck={false} onChange={(e) => setNameAsk({ ...nameAsk, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') setNameAsk(null); }} />
              </label>
              <p className={`modal-hint${showProblem ? ' bad' : ''}`}>
                {showProblem ? problem : `Casts: ${largeFileName(nameAsk.value.trim() || '…')} and ${smallFileName(nameAsk.value.trim() || '…')}`}
              </p>
              <div className="modal-buttons">
                <button className="ghost" onClick={() => setNameAsk(null)}>Cancel</button>
                <button className="primary" onClick={ok} disabled={!!problem}>{nameAsk.confirm}</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
