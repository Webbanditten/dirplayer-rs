import { useEffect, useRef } from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import type { BitmapHeader } from '../furni';

/** Draw a member's pixels onto a canvas: scaled by `zoom` (nearest neighbour), mirrored when `flip`. */
export function paintMember(canvas: HTMLCanvasElement, doc: CastDocument, slot: number, h: BitmapHeader, zoom: number, flip = false) {
  canvas.width = Math.max(1, h.width * zoom);
  canvas.height = Math.max(1, h.height * zoom);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  let rgba: Uint8Array;
  try {
    rgba = doc.rgba(slot);
  } catch {
    return;
  }
  if (rgba.length !== h.width * h.height * 4 || h.width === 0) return;
  const img = new ImageData(new Uint8ClampedArray(rgba), h.width, h.height);
  const tmp = document.createElement('canvas');
  tmp.width = h.width;
  tmp.height = h.height;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  ctx.save();
  if (flip) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

export function Thumb({ doc, slot, header, flip, rev, size = 52 }: { doc: CastDocument; slot: number; header: BitmapHeader; flip?: boolean; rev: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const zoom = Math.max(1, Math.min(4, Math.floor(size / Math.max(header.width, header.height, 1))));
    paintMember(ref.current, doc, slot, header, zoom, flip);
  }, [doc, slot, header, flip, rev, size]);
  return <canvas ref={ref} className="thumb" style={{ maxWidth: size, maxHeight: size }} />;
}
