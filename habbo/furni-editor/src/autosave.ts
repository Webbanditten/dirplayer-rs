/**
 * The open casts, kept in this browser's IndexedDB while they have unsaved changes, so a reload, a crash or a closed
 * tab doesn't lose them. Only ever one record; it is cleared once everything is saved or published.
 */
import type { SideKey } from './history';

export interface SavedSide {
  bytes: Uint8Array;
  name: string;
  dirty: boolean;
}

export interface Autosave {
  at: number;
  shown: SideKey;
  large?: SavedSide;
  small?: SavedSide;
  colors?: { label: string; colour: string }[];
}

const DB = 'furniEditor';
const STORE = 'work';
const KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadAutosave(): Promise<Autosave | null> {
  try {
    const v = await run<Autosave | undefined>('readonly', (s) => s.get(KEY));
    return v && (v.large || v.small) ? v : null;
  } catch {
    return null;
  }
}

export async function writeAutosave(v: Autosave): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(v, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(KEY));
  } catch {
    /* nothing kept */
  }
}
