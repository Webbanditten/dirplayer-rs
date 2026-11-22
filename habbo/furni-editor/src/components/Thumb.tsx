import { useEffect, useRef } from 'react';
import type { CastDocument } from '../../../../vm-rust/pkg/vm_rust.js';
import type { BitmapHeader } from '../furni';

/** Draw a member's pixels onto a canvas: scaled by `zoom` (nearest neighbour), mirrored when `flip`. */
/**
 * White that touches the picture's edge made see-through, as matte ink (the default, 8) shows a member in the room:
 * thumbnails of 8-bit furni then sit on the cell's checker instead of in a white box.
 */
function knockOutEdgeWhite(px: Uint8ClampedArray, w: number, h: number) {
  const white = (i: number) => px[i * 4 + 3] === 255 && px[i * 4] === 255 && px[i * 4 + 1] === 255 && px[i * 4 + 2] === 255;
  const stack: number[] = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (!white(i)) continue;
    px[i * 4 + 3] = 0;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
}

export function paintMember(canvas: HTMLCanvasElement, doc: CastDocument, slot: number, h: BitmapHeader, zoom: number, flip = false, matte = false) {
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
  if (matte && h.depth <= 8) knockOutEdgeWhite(img.data, h.width, h.height);
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
    paintMember(ref.current, doc, slot, header, zoom, flip, true);
  }, [doc, slot, header, flip, rev, size]);
  return <canvas ref={ref} className="thumb" style={{ maxWidth: size, maxHeight: size }} />;
}
