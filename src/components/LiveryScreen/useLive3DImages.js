import { useEffect, useRef } from 'react';

/**
 * Live 3D preview bridge.
 *
 * While the floating 3D window is open, poll the painter canvas' content
 * revision (~8 Hz) and push fresh, small panel textures only when the painting
 * actually changed. This keeps a brush stroke from re-exporting the full 2048²
 * composite every frame and avoids React churn inside the stroke itself.
 *
 * The canvas exposes:
 *   getRevision()               monotonic counter bumped on every overlay frame
 *   exportPreviewParts(size)    cheap scaled per-panel export
 *   exportParts()               full-res fallback (no live-scaling support)
 *
 * @param {object} o
 * @param {boolean} o.active                 poll only while the window is open
 * @param {{current: object|null}} o.canvasRef  the painter canvas handle
 * @param {() => Array} [o.exportFallback]   full-res export used when the handle
 *                                           has no `exportPreviewParts`
 * @param {(images: Array) => void} o.onImages  receives the fresh panel list
 * @param {number} [o.intervalMs]
 */
export function useLive3DImages({ active, canvasRef, exportFallback, onImages, intervalMs = 120 }) {
  const onImagesRef = useRef(onImages);
  onImagesRef.current = onImages;
  const exportFallbackRef = useRef(exportFallback);
  exportFallbackRef.current = exportFallback;

  useEffect(() => {
    if (!active) return undefined;
    const cv0 = canvasRef.current;
    // Seed from the current revision so the full-res initial frame isn't
    // immediately downgraded — only a real edit triggers a re-export.
    let last = cv0 && typeof cv0.getRevision === 'function' ? cv0.getRevision() : -1;
    const id = setInterval(() => {
      const cv = canvasRef.current;
      if (!cv || typeof cv.getRevision !== 'function') return;
      const rev = cv.getRevision();
      if (rev === last) return;
      last = rev;
      let images;
      try {
        images = typeof cv.exportPreviewParts === 'function'
          ? cv.exportPreviewParts(512)
          : (exportFallbackRef.current ? exportFallbackRef.current() : []);
      } catch (_) {
        return; // keep the previous textures
      }
      if (onImagesRef.current) onImagesRef.current(images);
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, canvasRef, intervalMs]);
}
