// polygon_simple.js — ESM mirror of src/acl/scenery_graph.js:polygonIsSimple
// Renderer (Vite) cannot `import { polygonIsSimple } from '../../../acl/scenery_graph.js'`
// because that file is CommonJS (module.exports) and is required by the Electron
// main process. The game triangulator hard-fails on bowtie polygons, so every
// area edit must be guarded — this is the same logic as the CJS original.
// Keep in sync with src/acl/scenery_graph.js.

function _segProperCross(p1, p2, p3, p4, eps) {
  const d = (p2.x - p1.x) * (p4.z - p3.z) - (p2.z - p1.z) * (p4.x - p3.x);
  if (Math.abs(d) < eps) return false;
  const t = ((p3.x - p1.x) * (p4.z - p3.z) - (p3.z - p1.z) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.z - p1.z) - (p3.z - p1.z) * (p2.x - p1.x)) / d;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

/**
 * True when the closed polygon `points` has no self-crossings.
 * @param {Array<{x:number,z:number}>} points
 * @param {number} [epsilon=1e-9]
 * @returns {boolean}
 */
export function polygonIsSimple(points, epsilon) {
  if (!Array.isArray(points) || points.length < 3) return true;
  const eps = epsilon != null ? epsilon : 1e-9;
  const ring = points.slice();
  while (
    ring.length > 1 &&
    Math.abs(ring[ring.length - 1].x - ring[0].x) < eps &&
    Math.abs(ring[ring.length - 1].z - ring[0].z) < eps
  )
    ring.pop();
  const n = ring.length;
  if (n < 3) return true;

  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    if (Math.abs(a.x - b.x) < eps && Math.abs(a.z - b.z) < eps) continue;
    edges.push({ a, b, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) });
  }
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (j === i + 1) continue;
      if (i === 0 && j === edges.length - 1) continue;
      const e1 = edges[i], e2 = edges[j];
      if (e1.maxX < e2.minX || e2.maxX < e1.minX || e1.maxZ < e2.minZ || e2.maxZ < e1.minZ) continue;
      if (_segProperCross(e1.a, e1.b, e2.a, e2.b, eps)) return false;
    }
  }
  return true;
}
