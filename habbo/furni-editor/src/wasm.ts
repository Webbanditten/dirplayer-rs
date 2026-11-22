import init, { CastDocument } from '../../../vm-rust/pkg/vm_rust.js';

let ready: Promise<unknown> | null = null;

/** Load DirPlayer's WebAssembly module once. The editor only uses CastDocument, so the module's start function is
 *  told not to start a player (the switch its browser tests use; a player needs the host page's audio glue). */
export function loadWasm() {
  (window as unknown as Record<string, unknown>).__dirplayerTestMode = true;
  return (ready ??= init());
}

export { CastDocument };

export function decodeImage(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const out = CastDocument.decodeImage(bytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  return { width: view.getUint32(0, true), height: view.getUint32(4, true), rgba: out.subarray(8) };
}

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return CastDocument.encodePng(rgba, width, height);
}

export function download(bytes: Uint8Array, name: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
