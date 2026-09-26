import { useEffect, useRef } from 'react';

/**
 * Live 3D preview bridge.
 *
 * While the floating 3D window is open, poll the painter canvas' content
 * revision (~1 Hz) and push fresh **full-resolution** panel textures only when
 * the painting actually changed. The textures are canvas elements
 * (`getPanelCanvases`) rather than PNG data URLs, so there is no encode/decode
 * cost — three.js uploads the canvas straight to the GPU — which keeps a
 * full-res refresh cheap enough to sample once a second while painting.
 *
 * The canvas exposes:
 *   getRevision()            monotonic counter bumped on every overlay frame
 *   getPanelCanvases(size)   persistent, full-res per-panel canvas elements
 *
 * @param {object} o
 * @param {boolean} o.active                 poll only while the window is open
 * @param {{current: object|null}} o.canvasRef  the painter canvas handle
 * @param {() => Array} [o.exportFallback]   full-res export used when the handle
 *                                           has no `getPanelCanvases`
 * @param {(images: Array) => void} o.onImages  receives the fresh panel list
 * @param {number} [o.intervalMs]
 */
export function useLive3DImages({ active, canvasRef, exportFallback, onImages, intervalMs = 1000 }) {
  const onImagesRef = useRef(onImages);
  onImagesRef.current = onImages;
  const exportFallbackRef = useRef(exportFallback);
  exportFallbackRef.current = exportFallback;

  useEffect(() => {
    if (!active) return undefined;
    const cv0 = canvasRef.current;
    // Seed from the current revision so the initial frame isn't re-exported —
    // only a real edit triggers a refresh.
    let last = cv0 && typeof cv0.getRevision === 'function' ? cv0.getRevision() : -1;
    const id = setInterval(() => {
      const cv = canvasRef.current;
      if (!cv || typeof cv.getRevision !== 'function') return;
      const rev = cv.getRevision();
      if (rev === last) return;
      last = rev;
      let images;
      try {
        images = typeof cv.getPanelCanvases === 'function'
          ? cv.getPanelCanvases()
          : (exportFallbackRef.current ? exportFallbackRef.current() : []);
      } catch (_) {
        return; // keep the previous textures
      }
      if (onImagesRef.current) onImagesRef.current(images);
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, canvasRef, intervalMs]);
}
