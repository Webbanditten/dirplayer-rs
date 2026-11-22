import { useCallback, useEffect, useMemo, useState } from 'react';
import { CastDocument, SwfDocument, decodeImage, download, encodePng, loadWasm, pickFile } from './wasm';
import { buildCast, planFlash } from './flash';
import { ALIAS_INDEX, ASSET_INDEX, Furni, parseMemberName } from './furni';
import { FurniGrid, gridModel } from './components/FurniGrid';
import { Inspector, type ImportMode } from './components/Inspector';
import { Preview } from './components/Preview';

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

export function App() {
  const [ready, setReady] = useState(false);
  const [doc, setDoc] = useState<CastDocument | null>(null);
  const [fileName, setFileName] = useState('');
  const [rev, setRev] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<{ slot: number; alias?: string } | null>(null);
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState<'furni' | 'members'>('furni');
  const [importMode, setImportMode] = useState<ImportMode>('auto');
  const [host, setHost] = useState(() => stored('furniEditor.host', DEFAULT_HOST));
  const [className, setClassName] = useState(() => stored('furniEditor.class', 'chair_norja'));
  const [templateClass] = useState(() => stored('furniEditor.template', 'chair_norja'));
  const [flashSmall, setFlashSmall] = useState(() => stored('furniEditor.flashSmall', '0') === '1');
  const [flashColors, setFlashColors] = useState<{ label: string; colour: string }[]>([]);

  useEffect(() => {
    loadWasm().then(() => setReady(true), (e) => setStatus(`Couldn't load DirPlayer: ${e}`));
  }, []);

  const furni = useMemo(() => (doc ? new Furni(doc) : null), [doc, rev]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const show = useCallback(
    (next: CastDocument, name: string, changed: boolean) => {
      doc?.free();
      setDoc(next);
      setFileName(name);
      setDirty(changed);
      setSelected(null);
      setRev((r) => r + 1);
    },
    [doc],
  );

  const open = useCallback(
    (bytes: Uint8Array, name: string) => {
      if (dirty && !confirm('Discard the changes to the open cast?')) return;
      try {
        const next = new CastDocument(bytes);
        show(next, name, false);
        setFlashColors([]);
        const f = new Furni(next);
        setStatus(`Opened ${name}: ${f.members.length} members, class ${f.className() || '?'}`);
      } catch (e) {
        setStatus(`Couldn't open ${name}: ${e}`);
      }
    },
    [dirty, show],
  );

  /** A Flash furni (.swf) converted into a new cast, built on a template cast from the hotel (for its Director-written
   *  container) whose members are replaced. */
  const importFlash = async (file: File) => {
    if (dirty && !confirm('Discard the changes to the open cast?')) return;
    setStatus(`Converting ${file.name}…`);
    let swf: SwfDocument | null = null;
    try {
      swf = new SwfDocument(new Uint8Array(await file.arrayBuffer()));
      const plan = planFlash(swf, file.name, { small: flashSmall });
      const template = `hh_furni_xx_${templateClass.trim() || 'chair_norja'}.cct`;
      const res = await fetch(host.replace(/\/?$/, '/') + template);
      if (!res.ok) throw new Error(`couldn't load the template cast ${template} (HTTP ${res.status})`);
      const next = new CastDocument(new Uint8Array(await res.arrayBuffer()));
      buildCast(next, swf, plan);
      show(next, `hh_furni_xx_${plan.sprite}.cct`, true);
      setFlashColors(plan.colors.map((c) => ({ label: `flash colour ${c.id}: ${c.colour}`, colour: c.colour })));
      const aliases = plan.fields.find((f) => f.name === ALIAS_INDEX)?.text.split('\n').length ?? 0;
      setStatus(
        `Converted ${file.name}: ${plan.sprite}, ${plan.dims[0]}×${plan.dims[1]}, ${plan.bitmaps.length} pictures, ${aliases} aliases, ` +
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

  const openFile = async () => {
    const file = await pickFile('.cct,.cst');
    if (file) open(new Uint8Array(await file.arrayBuffer()), file.name);
  };

  const openFromHotel = async () => {
    const name = `hh_furni_xx_${className.trim()}.cct`;
    store('furniEditor.host', host);
    store('furniEditor.class', className.trim());
    setStatus(`Loading ${name}…`);
    try {
      const res = await fetch(host.replace(/\/?$/, '/') + name);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      open(new Uint8Array(await res.arrayBuffer()), name);
    } catch (e) {
      setStatus(`Couldn't load ${name}: ${e}`);
    }
  };

  const save = () => {
    if (!doc || !furni) return;
    const name = furni.className() ? `hh_furni_xx_${furni.className()}.cct` : fileName || 'cast.cct';
    try {
      const bytes = doc.save();
      // Check the result opens before handing it out.
      new CastDocument(bytes).free();
      download(bytes, name);
      setDirty(false);
      setStatus(`Saved ${name} (${bytes.length.toLocaleString()} bytes)`);
    } catch (e) {
      setStatus(`Save failed: ${e}`);
    }
  };

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
    if (!/^[A-Za-z0-9_]+$/.test(next)) return setStatus('Class names are letters, digits and _');
    const re = new RegExp(`^(s_)?${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[_.]|$)`, 'i');
    const swap = (s: string) => s.replace(re, (_m, small) => (small ?? '') + next);
    edit(`Renamed the furni ${old} to ${next}`, () => {
      for (const m of furni.members) if (re.test(m.name)) doc.setName(m.slot, swap(m.name));
      for (const field of [ALIAS_INDEX, ASSET_INDEX]) {
        const slot = furni.fieldSlot(field);
        if (!slot) continue;
        const text = doc.text(slot) ?? '';
        doc.setText(
          slot,
          field === ASSET_INDEX
            ? text.replace(new RegExp(`"${old}"`, 'gi'), `"${next}"`)
            : text.split('\n').map((l) => l.split('=').map((p) => swap(p.trim())).join('=')).join('\n'),
        );
      }
    });
  };

  const sel = selected && furni?.bySlot.has(selected.slot) ? selected : null;

  // Drop a .cct/.cst anywhere to open it; an image onto the window replaces the selected bitmap (the grid's + cells
  // take images for new frames themselves).
  const onDrop = async (e: React.DragEvent) => {
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    e.preventDefault();
    if (/\.(cct|cst)$/i.test(file.name)) open(new Uint8Array(await file.arrayBuffer()), file.name);
    else if (/\.swf$/i.test(file.name)) importFlash(file);
    else if (/^image\//.test(file.type) || /\.(png|gif|jpe?g)$/i.test(file.name)) {
      const m = sel && furni?.bySlot.get(sel.slot);
      if (m?.type === 'bitmap') importInto(m.slot, file);
      else setStatus('Select a bitmap member first, or drop the image on a + cell');
    }
  };

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="toolbar">
        <b className="title">Furni editor</b>
        <button onClick={openFile} disabled={!ready}>Open .cct…</button>
        <span className="sep" />
        <input className="host" value={host} onChange={(e) => setHost(e.target.value)} title="Where hof_furni casts are loaded from" />
        <input className="cls" value={className} onChange={(e) => setClassName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && openFromHotel()} placeholder="class, e.g. chair_norja" />
        <button onClick={openFromHotel} disabled={!ready}>Load from hotel</button>
        <span className="sep" />
        <button onClick={async () => { const f = await pickFile('.swf'); if (f) importFlash(f); }} disabled={!ready} title="Convert a Flash furni (.swf) into a Shockwave cast; you can also drop the .swf on the window">
          Import Flash furni…
        </button>
        <label title="Also convert the 32 px pictures (s_ members)"><input type="checkbox" checked={flashSmall} onChange={(e) => { setFlashSmall(e.target.checked); store('furniEditor.flashSmall', e.target.checked ? '1' : '0'); }} /> 32 px</label>
        <span className="sep" />
        <button className="primary" onClick={save} disabled={!doc}>Save .cct</button>
        <button onClick={cloneAs} disabled={!doc} title="Rename every member of the class, for a new furni based on this one">New furni from this…</button>
        <span className="spacer" />
        <span className="muted">{fileName}{dirty ? ' (changed)' : ''}</span>
      </header>
      {!doc || !furni ? (
        <main className="welcome">
          <h2>Edit Habbo furni casts</h2>
          <p>Open a <code>hh_furni_xx_&lt;class&gt;.cct</code> from disk or load one from the hotel's asset host, or import a Flash furni (<code>.swf</code>) to make a new cast from it. Change layers, directions, frames, registration points and the <code>.props</code>/<code>.data</code> texts, watch it in the room, then save the cast.</p>
          {!ready && <p className="muted">Loading DirPlayer…</p>}
        </main>
      ) : (
        <main className="panes">
          <section className="pane left">
            <div className="tabs">
              <button className={tab === 'furni' ? 'on' : ''} onClick={() => setTab('furni')}>Furni</button>
              <button className={tab === 'members' ? 'on' : ''} onClick={() => setTab('members')}>All members ({furni.members.length})</button>
            </div>
            {tab === 'furni' ? (
              <FurniGrid doc={doc} furni={furni} rev={rev} small={false} selected={sel?.slot ?? null} onSelect={(slot, alias) => setSelected({ slot, alias })} onAddFrame={addFrame} onAddLayer={addLayer} onMirror={mirror} />
            ) : (
              <table className="members">
                <tbody>
                  {furni.members.map((m) => {
                    const p = parseMemberName(m.name);
                    return (
                      <tr key={m.slot} className={sel?.slot === m.slot ? 'selected' : ''} onClick={() => setSelected({ slot: m.slot })}>
                        <td className="muted">{m.slot}</td>
                        <td>{m.type}</td>
                        <td>{m.name}</td>
                        <td className="muted">{m.bitmap ? `${m.bitmap.width}×${m.bitmap.height} ${m.bitmap.depth}b` : ''}{p ? ` · ${p.letter} d${p.direction} f${p.frame}` : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="fields">
              {[`${furni.className()}.props`, `${furni.className()}.data`, ALIAS_INDEX, ASSET_INDEX].map((n) => {
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
            {sel ? (
              <Inspector key={sel.slot} doc={doc} furni={furni} rev={rev} slot={sel.slot} alias={sel.alias} importMode={importMode} setImportMode={setImportMode} edit={edit} onImport={importInto} onExport={exportMember} onDuplicate={duplicate} onDelete={remove} />
            ) : (
              <div className="inspector muted">Pick a member in the grid, the list or the room.</div>
            )}
          </section>
        </main>
      )}
      <footer className="status">{status}</footer>
    </div>
  );
}
