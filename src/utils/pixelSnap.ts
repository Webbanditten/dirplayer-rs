import { RefObject, useEffect } from 'react';

/**
 * Keeps the stage canvas on whole device pixels.
 *
 * The canvas is drawn with `image-rendering: crisp-edges`. When page layout puts it at a fractional
 * position (a centred 720px stage in an odd-width window, a header whose height comes out at 26.5px),
 * the browser resamples the whole canvas with nearest-neighbour at a half-texel offset: rows and
 * columns get duplicated and dropped, which turns small pixel text into other letters ("Stem på dette
 * rum" -> "Stwm µå dwllw rum"). This nudges the (position: relative) root by the sub-pixel remainder.
 * `mountKey` re-attaches when the element behind `rootRef` is replaced (click-to-play).
 */
export function usePixelSnap(rootRef: RefObject<HTMLElement | null>, mountKey?: unknown) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let frame = 0;
    const snap = () => {
      frame = 0;
      const target = root.querySelector('canvas') ?? root;
      const dpr = window.devicePixelRatio || 1;
      const prevX = parseFloat(root.style.left) || 0;
      const prevY = parseFloat(root.style.top) || 0;
      const rect = target.getBoundingClientRect();
      const baseX = rect.left - prevX;
      const baseY = rect.top - prevY;
      const dx = (Math.round(baseX * dpr) - baseX * dpr) / dpr;
      const dy = (Math.round(baseY * dpr) - baseY * dpr) / dpr;
      if (Math.abs(dx - prevX) > 0.001) root.style.left = dx ? `${dx}px` : '';
      if (Math.abs(dy - prevY) > 0.001) root.style.top = dy ? `${dy}px` : '';
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(snap);
    };

    snap();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(document.documentElement);
    if (document.body) resizeObserver.observe(document.body);
    resizeObserver.observe(root);
    // The canvas only appears once the VM is ready.
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(root, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    // devicePixelRatio changes (browser zoom, moving to another screen) don't fire resize everywhere.
    let dprQuery: MediaQueryList | null = null;
    const watchDpr = () => {
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener('change', onDprChange);
    };
    const onDprChange = () => {
      watchDpr();
      schedule();
    };
    watchDpr();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, { capture: true });
      dprQuery?.removeEventListener('change', onDprChange);
      root.style.left = '';
      root.style.top = '';
    };
  }, [rootRef, mountKey]);
}
