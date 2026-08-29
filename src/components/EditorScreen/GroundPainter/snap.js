/**
 * Ground Painter — snap engine (pure math, no DOM).
 *
 * `findSnap(rawPos, anchor, snapGeom, opts)` runs a strict-priority cascade:
 *   1.1 endpoint (nearest vertex)
 *   1.2 on-segment (projection onto a segment interior)
 *   2.   angle snap — rotate the cursor around the anchor onto the nearest
 *        snapped turn angle (collinear 0°, ±45°, ±90°, ±135°) relative to the
 *        previous drawn edge (prev→anchor), keeping the cursor's radius. The
 *        vertex angle between the two edges is reported (straight = 180°).
 * The first family with a candidate wins. Pure math so the MCP and tests call
 * it directly (no SVG/DOM).
 */

export const SNAP_TYPES = {
  ENDPOINT: 'endpoint',
  ON_SEGMENT: 'onSegment',
  EXTENSION_180: 'extension180',
  PERPENDICULAR_90: 'perp90',
  DIAGONAL_45: 'diag45',
};

const DEG = Math.PI / 180;

// ─── Distances / geometry ─────────────────────────────────────────

export function distancePointToLine(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-12) return Math.hypot(px - ax, pz - az);
  return Math.abs((px - ax) * dz - (pz - az) * dx) / Math.sqrt(len2);
}

export function closestPointOnSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-12) return { x: ax, z: az, t: 0 };
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + t * dx, z: az + t * dz, t };
}

export function projectPointToLine(px, pz, ox, oz, dx, dz) {
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const t = (px - ox) * ux + (pz - oz) * uz;
  return { x: ox + ux * t, z: oz + uz * t };
}

export function segmentAngleDeg(ax, az, bx, bz) {
  return normalizeAngle180(Math.atan2(bz - az, bx - ax) / DEG);
}

export function directedAngleDeg(ax, az, bx, bz) {
  return Math.atan2(bz - az, bx - ax) / DEG;
}

export function normalizeAngle180(d) {
  let a = ((d % 180) + 180) % 180;
  return a;
}

export function angleDiffDirected(a, b) {
  let d = ((a - b) % 360 + 360) % 360;
  return d;
}

export function angleDiffToLine(a, lineDeg) {
  // fold into [0,90]
  const d = Math.abs(normalizeAngle180(a - lineDeg));
  return d > 90 ? 180 - d : d;
}

// ─── Thresholds ───────────────────────────────────────────────────

/** worldSnapDist(vbDiag) = clamp(vbDiag*0.012, [0.25, 0.80]); fallback 0.50 */
export function worldSnapDist(vbDiag, factor = 0.012) {
  const v = (vbDiag || 0) * factor;
  return Math.max(0.25, Math.min(0.80, v)) || 0.50;
}

/**
 * dynamicSnapDist(vbDiag, baseDiag, opts) — zoom-aware snap distance.
 *
 * `worldSnapDist` clamps to a fixed WORLD-unit band, which makes the on-screen
 * grab radius explode when deep-zoomed (a fixed world floor spans more and more
 * pixels as the viewport shrinks) and collapse when zoomed out (a fixed world
 * ceiling is a tiny fraction of a large viewport) — i.e. snapping feels too
 * sensitive when zoomed in and barely fires when zoomed out.
 *
 * Instead we anchor the radius to the CURRENT viewport (so the on-screen grab
 * aperture stays stable across airport size and zoom) and modulate it by the
 * zoom ratio so the snap DISTANCE shrinks when zoomed in and grows when zoomed
 * out (a zoomed-in window must not snap as far as a zoomed-out one).
 *
 *   snap  = baseSnap * zoom^pow
 *   baseSnap = baseDiag * factor          (constant on-screen size at base zoom)
 *   zoom  = clamp(vbDiag / baseDiag, [minZoom, maxZoom])
 *
 * `pow` tunes the zoom response:
 *   1.0  → constant on-screen aperture (radius tracks the map in world units).
 *   >1.0 → zoomed-in is TIGHTER on screen (smaller grab radius) and zoomed-out
 *          is looser — the safer choice for "zoomed in must not snap as far".
 *
 * Falls back to `worldSnapDist`-safe semantics (0.50) when no diagonals given.
 */
export function dynamicSnapDist(vbDiag, baseDiag, opts = {}) {
  const factor = opts.factor ?? 0.012;
  const pow = opts.pow ?? 1.15;
  const minZoom = opts.minZoom ?? 0.02;
  const maxZoom = opts.maxZoom ?? 6.0;
  const vb = (vbDiag && vbDiag > 0) ? vbDiag : 0;
  const base = (baseDiag && baseDiag > 0) ? baseDiag : vb;
  if (!vb && !base) return 0.50;
  const zoom = Math.max(minZoom, Math.min(maxZoom, base ? vb / base : 1));
  const baseSnap = base * factor;
  // Clamp zoom (a RATIO) rather than world units, so deep zoom-in cannot inflate
  // the on-screen aperture. Wide world floor/ceiling only guards edge cases.
  const snap = baseSnap * Math.pow(zoom, pow);
  return Math.max(opts.minSnap ?? 0.04, Math.min(opts.maxSnap ?? 400, snap));
}

/**
 * dynamicAngleTolDeg(vbDiag, baseDiag, opts) — zoom-aware ANGULAR snap window
 * (degrees), the angular twin of `dynamicSnapDist`.
 *
 * The cursor only snaps to a nice turn angle (collinear / ±45° / ±90° / ±135°)
 * when it is within `angleToleranceDeg` of that angle. A FIXED window feels too
 * grabby deep-zoomed-in (a small world arc fills the screen, so being 2.5° off
 * is a big visual miss) and too weak zoomed-out. So we scale it with the zoom
 * ratio: zooming IN shrinks the window ("less snappy" — finer control, you must
 * aim closer to the exact angle) and zooming OUT widens it (snaps more readily).
 *
 *   tol   = baseTolDeg * zoom^pow
 *   zoom  = clamp(vbDiag / baseDiag, [minZoom, maxZoom])
 *
 * `pow` mirrors dynamicSnapDist: 1.0 → linear; >1.0 → zoomed-in is extra tight.
 * Falls back to `baseTolDeg` (2.5°) when no diagonals are given.
 */
export function dynamicAngleTolDeg(vbDiag, baseDiag, opts = {}) {
  const baseTol = opts.baseTolDeg ?? 2.5;
  const pow = opts.pow ?? 1.15;
  const minZoom = opts.minZoom ?? 0.02;
  const maxZoom = opts.maxZoom ?? 6.0;
  const vb = (vbDiag && vbDiag > 0) ? vbDiag : 0;
  const base = (baseDiag && baseDiag > 0) ? baseDiag : vb;
  if (!vb && !base) return baseTol;
  const zoom = Math.max(minZoom, Math.min(maxZoom, base ? vb / base : 1));
  const tol = baseTol * Math.pow(zoom, pow);
  return Math.max(opts.minTolDeg ?? 0.6, Math.min(opts.maxTolDeg ?? 12, tol));
}

// ─── Geometry collection ──────────────────────────────────────────

function coordKey(x, z) { return (+x).toFixed(6) + ',' + (+z).toFixed(6); }

/**
 * Collect snap geometry from an id-free Graph, or from editor val shapes
 * { taxiwayPaths, runwayData, areaData, standPositions }.
 * Returns { points: Vec2[], segments: Segment[] }.
 */
export function collectSnapGeometry(input) {
  const points = [];
  const segments = [];
  if (!input) return { points, segments };

  const pushPoint = (x, z) => points.push({ x, z });

  if (Array.isArray(input.nodes)) {
    // id-free Graph
    for (const n of input.nodes) if (n && n.x != null && n.z != null) pushPoint(n.x, n.z);
    for (const s of input.segments || []) {
      const idxs = (s.nodeIdxs && s.nodeIdxs.length >= 2) ? s.nodeIdxs : [s.aIdx, s.bIdx];
      for (let i = 0; i < idxs.length - 1; i++) {
        const a = input.nodes[idxs[i]], b = input.nodes[idxs[i + 1]];
        if (a && b && !(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9)) {
          segments.push({ a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z } });
        }
      }
    }
    for (const rw of input.runways || []) {
      const a = input.nodes[rw.thAIdx], b = input.nodes[rw.thBIdx];
      if (a && b) segments.push({ a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z } });
    }
    for (const ar of input.areas || []) {
      const pts = ar.points || [];
      for (let i = 0; i < pts.length; i++) {
        pushPoint(pts[i].x, pts[i].z);
        const j = (i + 1) % pts.length;
        segments.push({ a: pts[i], b: pts[j] });
      }
    }
    for (const st of input.stands || []) {
      const nose = input.nodes[st.noseIdx], tail = input.nodes[st.tailIdx];
      if (nose) pushPoint(nose.x, nose.z);
      if (tail) pushPoint(tail.x, tail.z);
      if (nose && tail) segments.push({ a: nose, b: tail });
    }
    return { points: _dedup(points), segments: _dropZero(segments) };
  }

  // Editor val shapes
  if (input.taxiwayPaths && Array.isArray(input.taxiwayPaths.paths)) {
    for (const p of input.taxiwayPaths.paths) {
      const c = p.points || [];
      for (let i = 0; i < c.length; i++) {
        pushPoint(c[i].x, c[i].z);
        if (i > 0) segments.push({ a: c[i - 1], b: c[i] });
      }
    }
  }
  if (input.runwayData) {
    for (const rw of Object.values(input.runwayData)) {
      if (rw && Array.isArray(rw.points)) {
        const c = rw.points;
        if (c.length >= 2) segments.push({ a: c[0], b: c[c.length - 1] });
      }
    }
  }
  if (input.areaData) {
    for (const list of Object.values(input.areaData)) {
      for (const a of list || []) {
        const pts = a.points || [];
        for (let i = 0; i < pts.length; i++) {
          pushPoint(pts[i].x, pts[i].z);
          segments.push({ a: pts[i], b: pts[(i + 1) % pts.length] });
        }
      }
    }
  }
  if (input.standPositions) {
    for (const st of Object.values(input.standPositions)) {
      if (st && st.x != null && st.y != null) pushPoint(st.x, st.y);
    }
  }
  return { points: _dedup(points), segments: _dropZero(segments) };
}

function _dedup(points) {
  const seen = new Map();
  const out = [];
  for (const p of points) {
    const k = coordKey(p.x, p.z);
    if (!seen.has(k)) { seen.set(k, true); out.push(p); }
  }
  return out;
}

function _dropZero(segments) {
  return segments.filter((s) => !(Math.abs(s.a.x - s.b.x) < 1e-9 && Math.abs(s.a.z - s.b.z) < 1e-9));
}

// ─── findSnap cascade ─────────────────────────────────────────────

/**
 * @param {{x,z}} rawPos - raw cursor world position
 * @param {{x,z}|null} anchor - placed anchor (required for the angle snap)
 * @param {{points, segments}} snapGeom - from collectSnapGeometry
 * @param {object} [opts] - { snapDist, angleToleranceDeg, prev }
 *   `prev` is the vertex before `anchor` in the in-progress path (null for the
 *   first edge). The angle snap rotates the cursor around the anchor onto a
 *   snapped turn relative to the edge prev→anchor (collinear/±45°/±90°/±135°).
 * @returns {null | {x, z, type, distance, kind, angle?}}
 *   `angle` (present on angle snaps) is the vertex angle between the last edge
 *   and the candidate edge (straight continuation = 180°).
 */
export function findSnap(rawPos, anchor, snapGeom, opts = {}) {
  if (!snapGeom) return null;
  const snapDist = opts.snapDist ?? 0.50;
  const angTol = opts.angleToleranceDeg ?? 2.5;

  // 1.1 endpoint — nearest vertex within snapDist
  let bestEnd = null, bestEndD = Infinity;
  for (const p of snapGeom.points) {
    const d = Math.hypot(rawPos.x - p.x, rawPos.z - p.z);
    if (d <= snapDist && d < bestEndD) { bestEndD = d; bestEnd = p; }
  }
  // exclude the anchor itself (avoid snapping an in-progress endpoint to itself)
  if (anchor && bestEnd && Math.abs(bestEnd.x - anchor.x) < 1e-9 && Math.abs(bestEnd.z - anchor.z) < 1e-9) {
    bestEnd = null;
  }
  if (bestEnd) {
    return { x: bestEnd.x, z: bestEnd.z, type: SNAP_TYPES.ENDPOINT, distance: bestEndD, kind: 'endpoint' };
  }

  // 1.2 on-segment — projection within snapDist
  let bestSeg = null, bestSegD = Infinity;
  for (const s of snapGeom.segments) {
    const proj = closestPointOnSegment(rawPos.x, rawPos.z, s.a.x, s.a.z, s.b.x, s.b.z);
    const d = Math.hypot(rawPos.x - proj.x, rawPos.z - proj.z);
    if (d <= snapDist && d < bestSegD) { bestSegD = d; bestSeg = proj; }
  }
  if (bestSeg) {
    // If projection is essentially an endpoint, 1.1 handled it.
    return { x: bestSeg.x, z: bestSeg.z, type: SNAP_TYPES.ON_SEGMENT, distance: bestSegD, kind: 'endpoint' };
  }

  // Anchor required for the angular snap.
  if (!anchor) return null;

  // Previous path vertex — needed to measure the angle to the last drawn edge.
  const prev = opts.prev ?? null;

  // Angle snap relative to the last drawn edge (prev→anchor): rotate the cursor
  // around the anchor onto the nearest snapped turn (collinear / ±45° / ±90° /
  // ±135°), keeping the cursor's radius. Simple angle relation — no guide lines.
  const ang = _snapAngle(rawPos, anchor, prev, angTol);
  if (ang) return ang;

  return null;
}

function _snapAngle(raw, anchor, prev, tol) {
  if (!prev || !anchor) return null;
  const ex = anchor.x - prev.x, ez = anchor.z - prev.z;
  if (Math.hypot(ex, ez) < 1e-9) return null;
  const dx = raw.x - anchor.x, dz = raw.z - anchor.z;
  const r = Math.hypot(dx, dz);
  if (r < 1e-6) return null; // cursor on the anchor — angle is undefined

  const baseDir = Math.atan2(ez, ex) / DEG; // last drawn edge direction (prev→anchor)
  const candDir = Math.atan2(dz, dx) / DEG; // candidate edge direction (anchor→raw)
  let turn = candDir - baseDir;             // how much the candidate turns off the edge
  turn = ((turn % 360) + 360) % 360;
  if (turn > 180) turn -= 360;              // (−180,180]

  // Snapped turn targets: 0 = straight continuation (180° vertex), ±90 =
  // perpendicular, ±45/±135 = diagonal.
  const targets = [0, 45, -45, 90, -90, 135, -135];
  let bestT = 0, bestDiff = Infinity;
  for (const t of targets) {
    let diff = Math.abs(turn - t);
    if (diff > 180) diff = 360 - diff;
    if (diff < bestDiff) { bestDiff = diff; bestT = t; }
  }
  if (bestDiff > tol) return null;

  const dir = (baseDir + bestT) * DEG;
  const x = anchor.x + Math.cos(dir) * r;
  const z = anchor.z + Math.sin(dir) * r;
  const type = Math.abs(bestT) <= 5 ? SNAP_TYPES.EXTENSION_180
    : Math.abs(Math.abs(bestT) - 90) <= 5 ? SNAP_TYPES.PERPENDICULAR_90
    : SNAP_TYPES.DIAGONAL_45;
  // Vertex angle between the last edge and the candidate (straight = 180°).
  const angle = 180 - Math.abs(bestT);
  return { x, z, type, distance: bestDiff, angle, kind: 'anchor', turn: bestT };
}

// ─── Guides (render) ──────────────────────────────────────────────

export function getSnapGuides(anchor, snapGeom, viewBox) {
  if (!anchor || !snapGeom) return [];
  const guides = [];
  for (const s of snapGeom.segments) {
    const dir = segmentAngleDeg(s.a.x, s.a.z, s.b.x, s.b.z);
    guides.push({ origin: s.a, angleDeg: dir, family: '180' });
    guides.push({ origin: s.a, angleDeg: normalizeAngle180(dir + 90), family: '90' });
    guides.push({ origin: s.a, angleDeg: normalizeAngle180(dir + 45), family: '45' });
    guides.push({ origin: s.a, angleDeg: normalizeAngle180(dir + 135), family: '135' });
  }
  return guides;
}

// ─── Public helpers re-exported ───────────────────────────────────

export function getSnappedWorldPos(evt, svgEl, viewBox, anchor, snapGeom, opts) {
  // Convert client → SVG → world using the svg element's CTM (renderer provides).
  const pt = svgEl.createSVGPoint ? svgEl.createSVGPoint() : null;
  if (!pt) return null;
  pt.x = evt.clientX; pt.y = evt.clientY;
  const ctm = svgEl.getScreenCTM ? svgEl.getScreenCTM() : null;
  if (!ctm) return null;
  const svg = pt.matrixTransform(ctm.inverse());
  // svgY: world z = -svg.y
  const raw = { x: svg.x, z: -svg.y };
  return findSnap(raw, anchor, snapGeom, opts);
}
