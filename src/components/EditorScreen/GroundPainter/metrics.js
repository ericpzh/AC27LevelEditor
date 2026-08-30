/**
 * Ground Painter — pure geometry/metrics helpers (no React, no DOM).
 * Extracted from GroundPainter.jsx so tests (and future callers) can use them
 * without mounting the 3.7k-line component.
 */
import { DEFAULT_AIRPORT_SCALE } from '../../../utils/constants';

// Full ordered node-index polyline of a segment (nodeIdxs, or legacy aIdx/bIdx).
export function segNodeIdxs(sg) {
  return (sg && sg.nodeIdxs && sg.nodeIdxs.length >= 2) ? sg.nodeIdxs : (sg ? [sg.aIdx, sg.bIdx] : []);
}

// ── Length helpers (meters) ──
// 1 GU = DEFAULT_AIRPORT_SCALE meters (100 m/unit, see src/utils/constants/aviation.js)
export function polylineLengthMeters(points) {
  if (!points || points.length < 2) return 0;
  let gu = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (!a || !b) continue;
    gu += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return Math.round(gu * DEFAULT_AIRPORT_SCALE);
}
export function segmentLengthMeters(graph, idx) {
  if (!graph || !graph.segments || !graph.segments[idx]) return null;
  const sg = graph.segments[idx];
  const idxs = segNodeIdxs(sg);
  if (idxs.length < 2) return null;
  const pts = idxs.map((ni) => graph.nodes[ni]).filter(Boolean);
  if (pts.length < 2) return null;
  return polylineLengthMeters(pts);
}
export function runwayLengthMeters(graph, idx) {
  if (!graph || !graph.runways || !graph.runways[idx]) return null;
  const rw = graph.runways[idx];
  const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
  if (!a || !b) return null;
  return Math.round(Math.hypot(b.x - a.x, b.z - a.z) * DEFAULT_AIRPORT_SCALE);
}
export function formatLengthMeters(m) {
  if (m == null || !isFinite(m)) return '';
  return m.toLocaleString() + ' m';
}

// Render each taxiway segment as its own full polyline (preserving all curve
// vertices from the ACL segment Nodes) — the same geometry the Ground Map shows.
export function buildTaxiPaths(graph) {
  const segs = graph.segments || [];
  const paths = [];
  for (const sg of segs) {
    const pts = [];
    for (const ni of (sg.nodeIdxs || [sg.aIdx, sg.bIdx])) {
      const n = graph.nodes[ni];
      if (n) pts.push({ x: n.x, z: n.z });
    }
    if (pts.length >= 2) paths.push(pts);
  }
  return paths;
}
