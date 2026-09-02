/**
 * Fillet (rounding) geometry for taxiway painter.
 * Pure math, no DOM/store. Given two straight segments sharing node O,
 * compute the tangent arc of radius r between them.
 *
 * Coordinate: x,z in GU (y=0, same as Graph nodes). Uses same atan2 convention
 * as stand heading: heading = atan2(-dz, dx).
 */

const DEG = Math.PI / 180;

const COORD_EPS = 1e-6;
function coordsEqual(a, b, eps = COORD_EPS) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.z - b.z) < eps;
}

// OsmId (first integer in `taxiway-segment:<osm>:<ord>`) from a segment PK. Split
// pieces must keep the parent strip's OsmId so a runway's type-4 pavement stays
// one continuous visual path (fresh negatives fragment it → "discontinuous").
function osmFromSegPk(pk) {
  if (!pk) return null;
  const m = /^taxiway-segment:(-?\d+):\d+$/.exec(pk);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Find existing node index by coordinate (epsilon 1e-6). Returns index or -1.
 */
export function findNodeIndexByCoord(graph, x, z, eps = COORD_EPS) {
  if (!graph || !graph.nodes) return -1;
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    if (!n) continue;
    if (Math.abs(n.x - x) < eps && Math.abs(n.z - z) < eps) return i;
  }
  return -1;
}

/**
 * Find common node index between two segments (straight, nodeIdxs length 2).
 * Supports both index-equality and coordinate-equality (for duplicate nodes at same snap point).
 * Returns { oIdx, oIdxA, oIdxB, oCoord, p1Idx, p2Idx } or null.
 * If duplicate O nodes exist at same coordinate, oIdxA/oIdxB are both present.
 */
export function findCommonNodeInfo(graph, segA, segB) {
  if (!graph || !segA || !segB) return null;
  const aIdxs = segA.nodeIdxs && segA.nodeIdxs.length >= 2 ? segA.nodeIdxs : [segA.aIdx, segA.bIdx];
  const bIdxs = segB.nodeIdxs && segB.nodeIdxs.length >= 2 ? segB.nodeIdxs : [segB.aIdx, segB.bIdx];
  // 1) index equality fast path
  const setA = new Set(aIdxs);
  let commonIdx = null;
  for (const bi of bIdxs) if (setA.has(bi)) {
    if (commonIdx != null) return null;
    commonIdx = bi;
  }
  if (commonIdx != null) {
    const oCoord = graph.nodes[commonIdx];
    if (!oCoord) return null;
    // find p's
    let p1 = null, p2 = null;
    for (const ai of aIdxs) if (ai !== commonIdx) p1 = ai;
    for (const bi of bIdxs) if (bi !== commonIdx) p2 = bi;
    return { oIdx: commonIdx, oIdxA: commonIdx, oIdxB: commonIdx, oCoord, p1Idx: p1, p2Idx: p2, duplicate: false };
  }
  // 2) coordinate equality (duplicate nodes at same snap point)
  for (const ai of aIdxs) {
    const aPos = graph.nodes[ai];
    if (!aPos) continue;
    for (const bi of bIdxs) {
      const bPos = graph.nodes[bi];
      if (!bPos) continue;
      if (coordsEqual(aPos, bPos)) {
        // found shared coordinate via two distinct nodes
        let p1 = null, p2 = null;
        for (const aa of aIdxs) if (aa !== ai) p1 = aa;
        for (const bb of bIdxs) if (bb !== bi) p2 = bb;
        return { oIdx: ai, oIdxA: ai, oIdxB: bi, oCoord: aPos, p1Idx: p1, p2Idx: p2, duplicate: true, oCoordB: bPos };
      }
    }
  }
  return null;
}

const RUNWAY_PAVEMENT_FLAGS = 4;

/** Check if all points of a polyline are collinear (within eps). */
function pointsCollinear(pts, eps = 1e-6) {
  if (!pts || pts.length <= 2) return true;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return false;
  const nx = -dz / len, nz = dx / len; // normal
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i].x - a.x) * nx + (pts[i].z - a.z) * nz);
    if (d > eps) return false;
  }
  return true;
}

/**
 * Is segment straight? Straight = exactly 2 vertices, OR a runway pavement
 * strip (Flags==4, Type under runway) which uses 4 collinear points
 * (overhang-threshold-threshold-overhang) but is still geometrically straight.
 * Any polyline whose points are collinear is considered straight for fillet.
 */
export function isStraightSegment(seg) {
  if (!seg) return false;
  // Runway pavement strip (Flags==4) — 4 collinear points, treat as straight
  if (seg.flags === RUNWAY_PAVEMENT_FLAGS) {
    // trust flags but verify collinearity if we have nodes context? Without graph we can't, so assume straight.
    return true;
  }
  if (seg.nodeIdxs) {
    if (seg.nodeIdxs.length === 2) return true;
    // >2 nodes: only straight if explicitly flagged as runway pavement
    return false;
  }
  return seg.aIdx != null && seg.bIdx != null;
}

/**
 * For a straight segment (2-point or runway pavement 4-point collinear),
 * return the ray from O outward that should be used for fillet.
 * Handles O interior to the polyline (runway pavement threshold) by picking
 * the longer ray (runway interior > overhang stub).
 * Returns { farIdx, n:{x,z}, maxDot, far } or null if O not on segment line.
 */
function getConnectedRay(graph, seg, oCoord, oIdx) {
  const idxs = seg.nodeIdxs && seg.nodeIdxs.length ? seg.nodeIdxs : [seg.aIdx, seg.bIdx];
  // Fast path: 2-point
  if (idxs.length === 2) {
    const farIdx = idxs[0] === oIdx ? idxs[1] : idxs[0];
    // duplicate-coord case: OIdx not in idxs but coordinate equal — find matching coord
    let actualFarIdx = farIdx;
    if (!idxs.includes(oIdx)) {
      // duplicate: O coordinate equals one endpoint's coordinate, find that endpoint by coord
      for (const ci of idxs) {
        const c = graph.nodes[ci];
        if (c && Math.abs(c.x - oCoord.x) < COORD_EPS && Math.abs(c.z - oCoord.z) < COORD_EPS) {
          // this endpoint is O duplicate, the other is far
          actualFarIdx = idxs.find((v) => v !== ci);
          break;
        }
      }
    }
    const far = graph.nodes[actualFarIdx];
    if (!far) return null;
    const vx = far.x - oCoord.x, vz = far.z - oCoord.z;
    const len = Math.hypot(vx, vz);
    if (len < 1e-9) return null;
    return { farIdx: actualFarIdx, n: { x: vx / len, z: vz / len }, maxDot: len, far };
  }
  // Multi-point (runway pavement 4-point): points are collinear, O may be interior
  const pts = idxs.map((i) => graph.nodes[i]).filter(Boolean);
  if (pts.length < 2) return null;
  // Check collinearity (defensive)
  // Find index of O in idxs (or coordinate match)
  let pos = idxs.indexOf(oIdx);
  if (pos === -1) {
    // duplicate coord fallback: find by coordinate
    for (let i = 0; i < idxs.length; i++) {
      const c = graph.nodes[idxs[i]];
      if (c && Math.abs(c.x - oCoord.x) < COORD_EPS && Math.abs(c.z - oCoord.z) < COORD_EPS) { pos = i; break; }
    }
  }
  if (pos === -1) return null;
  if (pos === 0) {
    const farIdx = idxs[idxs.length - 1];
    const far = graph.nodes[farIdx];
    const vx = far.x - oCoord.x, vz = far.z - oCoord.z;
    const len = Math.hypot(vx, vz);
    return { farIdx, n: { x: vx / len, z: vz / len }, maxDot: len, far };
  } else if (pos === idxs.length - 1) {
    const farIdx = idxs[0];
    const far = graph.nodes[farIdx];
    const vx = far.x - oCoord.x, vz = far.z - oCoord.z;
    const len = Math.hypot(vx, vz);
    return { farIdx, n: { x: vx / len, z: vz / len }, maxDot: len, far };
  } else {
    // Interior: two rays, pick longer (runway interior vs overhang stub)
    const farPrevIdx = idxs[0];
    const farNextIdx = idxs[idxs.length - 1];
    const farPrev = graph.nodes[farPrevIdx];
    const farNext = graph.nodes[farNextIdx];
    const vp = { x: farPrev.x - oCoord.x, z: farPrev.z - oCoord.z };
    const vn = { x: farNext.x - oCoord.x, z: farNext.z - oCoord.z };
    const lenPrev = Math.hypot(vp.x, vp.z);
    const lenNext = Math.hypot(vn.x, vn.z);
    if (lenPrev > lenNext) {
      return { farIdx: farPrevIdx, n: { x: vp.x / lenPrev, z: vp.z / lenPrev }, maxDot: lenPrev, far: farPrev };
    } else {
      return { farIdx: farNextIdx, n: { x: vn.x / lenNext, z: vn.z / lenNext }, maxDot: lenNext, far: farNext };
    }
  }
}

/**
 * Count incident entities (segments + runway endpoints + stand nodes) at a node index.
 */
export function countIncidentAll(graph, nodeIdx) {
  if (!graph || nodeIdx == null) return 0;
  let c = 0;
  for (const sg of graph.segments || []) {
    const idxs = sg.nodeIdxs && sg.nodeIdxs.length ? sg.nodeIdxs : [sg.aIdx, sg.bIdx];
    if (idxs.includes(nodeIdx)) c++;
  }
  for (const rw of graph.runways || []) {
    if (rw.thAIdx === nodeIdx || rw.thBIdx === nodeIdx) c++;
  }
  for (const st of graph.stands || []) {
    if (st.noseIdx === nodeIdx || st.tailIdx === nodeIdx) c++;
    if (Array.isArray(st.pushbackIdxs) && st.pushbackIdxs.includes(nodeIdx)) c++;
  }
  return c;
}

/**
 * Count incident segments by coordinate (handles duplicate nodes at same snap point).
 */
export function countIncidentByCoord(graph, x, z, eps = COORD_EPS) {
  if (!graph) return 0;
  let c = 0;
  for (const sg of graph.segments || []) {
    const idxs = sg.nodeIdxs && sg.nodeIdxs.length ? sg.nodeIdxs : [sg.aIdx, sg.bIdx];
    for (const ni of idxs) {
      const n = graph.nodes[ni];
      if (n && Math.abs(n.x - x) < eps && Math.abs(n.z - z) < eps) { c++; break; }
    }
  }
  for (const rw of graph.runways || []) {
    for (const ni of [rw.thAIdx, rw.thBIdx]) {
      const n = graph.nodes[ni];
      if (n && Math.abs(n.x - x) < eps && Math.abs(n.z - z) < eps) { c++; break; }
    }
  }
  for (const st of graph.stands || []) {
    const idxs = [st.noseIdx, st.tailIdx, ...(st.pushbackIdxs || [])];
    for (const ni of idxs) {
      const n = graph.nodes[ni];
      if (n && Math.abs(n.x - x) < eps && Math.abs(n.z - z) < eps) { c++; break; }
    }
  }
  return c;
}

function segOtherIdx(seg, common) {
  const idxs = seg.nodeIdxs && seg.nodeIdxs.length ? seg.nodeIdxs : [seg.aIdx, seg.bIdx];
  for (const id of idxs) if (id !== common) return id;
  return null;
}

/**
 * Intersection of two infinite lines in the XZ plane.
 * Each line defined by two points a0->a1 and b0->b1.
 * Returns {x,z} or null if parallel (denom ~0).
 */
function lineIntersection(a0, a1, b0, b1) {
  const dx1 = a1.x - a0.x, dz1 = a1.z - a0.z;
  const dx2 = b1.x - b0.x, dz2 = b1.z - b0.z;
  const denom = dx1 * dz2 - dz1 * dx2;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((b0.x - a0.x) * dz2 - (b0.z - a0.z) * dx2) / denom;
  return { x: a0.x + t * dx1, z: a0.z + t * dz1 };
}

/**
 * Compute fillet between two straight segments.
 * If they share a common endpoint O, uses O as the corner.
 * Otherwise if their infinite extensions intersect at O (non-parallel),
 * uses the imaginary intersection as O — allows filleting two
 * non-connected straight taxiways.
 *
 * @param {object} graph - id-free graph
 * @param {number} segIdxA - first segment index
 * @param {number} segIdxB - second segment index
 * @param {number} radius - requested radius in GU (e.g. 0.6). Will be clamped to feasible max.
 * @returns {{ok:boolean, error?:string, oIdx, p1Idx, p2Idx, p1, p2, o, theta, thetaDeg, t, rEff, rMax, center, t1, t2, arcPoints, a1, a2, delta, n}}
 */
export function computeFillet(graph, segIdxA, segIdxB, radius) {
  const segs = graph.segments || [];
  const segA = segs[segIdxA];
  const segB = segs[segIdxB];
  const rReq = radius != null ? Number(radius) : 0.6;

  const common = findCommonNodeInfo(graph, segA, segB);

  // ── Shared state for both paths ──
  let o, n1x, n1z, n2x, n2z, p1Idx, p2Idx, p1, p2;
  let oIdx = null, oIdxA = null, oIdxB = null, duplicate = false, oCoord = null;
  let virtualO = false;
  let nearIdxA = null, nearIdxB = null;
  let maxDot1 = 0, maxDot2 = 0;
  let len1 = 0, len2 = 0;

  if (common) {
    // ── Connected: O is the shared endpoint (may be interior for runway pavement 4-point) ──
    ({ oIdx, oIdxA, oIdxB, oCoord, duplicate } = common);
    o = oCoord;
    if (!o) return { ok: false, error: 'ground_painter_fillet_error_missing' };
    // Use ray helper so runway pavement (4-point, O interior) picks the correct longer ray
    const rayA = getConnectedRay(graph, segA, o, duplicate ? oIdxA : oIdx);
    const rayB = getConnectedRay(graph, segB, o, duplicate ? oIdxB : oIdx);
    if (!rayA || !rayB) return { ok: false, error: 'ground_painter_fillet_error_degenerate' };
    p1Idx = rayA.farIdx; p2Idx = rayB.farIdx;
    p1 = rayA.far; p2 = rayB.far;
    n1x = rayA.n.x; n1z = rayA.n.z;
    n2x = rayB.n.x; n2z = rayB.n.z;
    len1 = rayA.maxDot; len2 = rayB.maxDot;
    // Also need full segment lengths for rMax fallback? Use ray maxDot.
    maxDot1 = rayA.maxDot; maxDot2 = rayB.maxDot;
    nearIdxA = duplicate ? oIdxA : oIdx;
    nearIdxB = duplicate ? oIdxB : oIdx;
    // Keep original oIdx for ghost handling (for interior pavement, oIdx is threshold)
    // duplicate already maps to both O nodes
    virtualO = false;
    if (len1 < 1e-9 || len2 < 1e-9) return { ok: false, error: 'ground_painter_fillet_error_zero' };
  } else {
    // ── Non-connected: use imaginary intersection of infinite lines ──
    const aIdxs = segA.nodeIdxs && segA.nodeIdxs.length >= 2 ? segA.nodeIdxs : [segA.aIdx, segA.bIdx];
    const bIdxs = segB.nodeIdxs && segB.nodeIdxs.length >= 2 ? segB.nodeIdxs : [segB.aIdx, segB.bIdx];
    // For runway pavement (4-point) use first-last to define the infinite line (overhang to overhang)
    const aFirst = graph.nodes[aIdxs[0]], aLast = graph.nodes[aIdxs[aIdxs.length - 1]];
    const bFirst = graph.nodes[bIdxs[0]], bLast = graph.nodes[bIdxs[bIdxs.length - 1]];
    if (!aFirst || !aLast || !bFirst || !bLast) return { ok: false, error: 'ground_painter_fillet_error_missing' };
    // Use first-last for line direction/length (covers full polyline)
    len1 = Math.hypot(aLast.x - aFirst.x, aLast.z - aFirst.z);
    len2 = Math.hypot(bLast.x - bFirst.x, bLast.z - bFirst.z);
    if (len1 < 1e-9 || len2 < 1e-9) return { ok: false, error: 'ground_painter_fillet_error_zero' };
    const inter = lineIntersection(aFirst, aLast, bFirst, bLast);
    // Parallel (or collinear-disjoint) picks have no intersection point at all.
    // Without this guard the ray math below dereferences o.x on null.
    if (!inter) return { ok: false, error: 'ground_painter_fillet_error_parallel' };
    o = inter;
    oCoord = inter;
    virtualO = true;
    // Determine direction from O toward each segment (ray that contains the segment)
    const dx1 = aLast.x - aFirst.x, dz1 = aLast.z - aFirst.z;
    const dx2 = bLast.x - bFirst.x, dz2 = bLast.z - bFirst.z;
    const d1Len = Math.hypot(dx1, dz1) || 1;
    const d2Len = Math.hypot(dx2, dz2) || 1;
    const d1x = dx1 / d1Len, d1z = dz1 / d1Len;
    const d2x = dx2 / d2Len, d2z = dz2 / d2Len;
    // Midpoint of first-last (center of segment) to decide forward ray
    const mid1 = { x: (aFirst.x + aLast.x) / 2, z: (aFirst.z + aLast.z) / 2 };
    const mid2 = { x: (bFirst.x + bLast.x) / 2, z: (bFirst.z + bLast.z) / 2 };
    const dotMid1 = (mid1.x - o.x) * d1x + (mid1.z - o.z) * d1z;
    const dotMid2 = (mid2.x - o.x) * d2x + (mid2.z - o.z) * d2z;
    if (Math.abs(dotMid1) < 1e-9 && Math.abs(dotMid2) < 1e-9) {
      // Both mids at O — degenerate (segments cross at midpoint). Pick arbitrary ray.
    }
    n1x = dotMid1 >= 0 ? d1x : -d1x;
    n1z = dotMid1 >= 0 ? d1z : -d1z;
    n2x = dotMid2 >= 0 ? d2x : -d2x;
    n2z = dotMid2 >= 0 ? d2z : -d2z;
    // Compute dots for ALL nodes of each segment along the chosen ray
    let maxDotA = -Infinity, minDotA = Infinity, farIdxA = null, nearIdxA_tmp = null;
    for (const ai of aIdxs) {
      const ap = graph.nodes[ai]; if (!ap) continue;
      const d = (ap.x - o.x) * n1x + (ap.z - o.z) * n1z;
      if (d > maxDotA) { maxDotA = d; farIdxA = ai; }
      if (d < minDotA) { minDotA = d; nearIdxA_tmp = ai; }
    }
    let maxDotB = -Infinity, minDotB = Infinity, farIdxB = null, nearIdxB_tmp = null;
    for (const bi of bIdxs) {
      const bp = graph.nodes[bi]; if (!bp) continue;
      const d = (bp.x - o.x) * n2x + (bp.z - o.z) * n2z;
      if (d > maxDotB) { maxDotB = d; farIdxB = bi; }
      if (d < minDotB) { minDotB = d; nearIdxB_tmp = bi; }
    }
    maxDot1 = maxDotA; maxDot2 = maxDotB;
    const minDot1 = minDotA, minDot2 = minDotB;
    // Straddling check: segment spans both sides of O (has points on both sides of the ray).
    // For runway pavement (flags==4) the overhang stub (0.6 GU) may be on the opposite side —
    // allow a small negative tolerance for that overhang.
    const isPavA = segA.flags === RUNWAY_PAVEMENT_FLAGS;
    const isPavB = segB.flags === RUNWAY_PAVEMENT_FLAGS;
    const pavOverhangTol = 0.75; // game overhang is ~0.6 GU, allow a bit more
    if ((minDot1 < -1e-9 && !(isPavA && minDot1 >= -pavOverhangTol)) ||
        (minDot2 < -1e-9 && !(isPavB && minDot2 >= -pavOverhangTol))) {
      return { ok: false, error: 'ground_painter_fillet_error_inside' };
    }
    if (maxDot1 <= 1e-9 || maxDot2 <= 1e-9) {
      return { ok: false, error: 'ground_painter_fillet_error_behind' };
    }
    // For pavement, the nearest forward node (smallest non-negative dot) is the effective near
    // (threshold), not the overhang behind. Find smallest dot >= -pavOverhangTol that is >= -eps
    // Actually for pavement with O at threshold, the threshold dot ~0, overhang dot -0.6, far overhang ~10.
    // The near for truncation should be the threshold (dot 0) not the overhang.
    // So pick near as the node with smallest dot that is >= -1e-9 (forward side).
    // For normal 2-point segments, this is just the nearer endpoint.
    let nearA = null, minPosA = Infinity;
    for (const ai of aIdxs) {
      const ap = graph.nodes[ai]; if (!ap) continue;
      const d = (ap.x - o.x) * n1x + (ap.z - o.z) * n1z;
      if (d >= -1e-9 && d < minPosA) { minPosA = d; nearA = ai; }
    }
    let nearB = null, minPosB = Infinity;
    for (const bi of bIdxs) {
      const bp = graph.nodes[bi]; if (!bp) continue;
      const d = (bp.x - o.x) * n2x + (bp.z - o.z) * n2z;
      if (d >= -1e-9 && d < minPosB) { minPosB = d; nearB = bi; }
    }
    p1Idx = farIdxA; nearIdxA = nearA != null ? nearA : nearIdxA_tmp; p1 = graph.nodes[p1Idx];
    p2Idx = farIdxB; nearIdxB = nearB != null ? nearB : nearIdxB_tmp; p2 = graph.nodes[p2Idx];
    oIdx = null; oIdxA = nearIdxA; oIdxB = nearIdxB; duplicate = false;
  }

  const dot = n1x * n2x + n1z * n2z;
  const clampedDot = Math.max(-1, Math.min(1, dot));
  const theta = Math.acos(clampedDot); // 0..PI
  const thetaDeg = theta / DEG;
  if (theta < 5 * DEG || theta > 175 * DEG) {
    return { ok: false, error: 'ground_painter_fillet_error_angle', errorParams: { angle: thetaDeg.toFixed(1) } };
  }

  const half = theta / 2;
  const sinHalf = Math.sin(half);
  const tanHalf = Math.tan(half);
  // rMax: keep tangent points inside the kept legs (distance from O to far endpoint)
  // Use maxDot for virtual, len for connected (which equals maxDot as well)
  const leg1 = virtualO ? maxDot1 : len1;
  const leg2 = virtualO ? maxDot2 : len2;
  const rMax = Math.min(leg1, leg2) * tanHalf * 0.98;
  const rEff = Math.min(rReq, rMax);
  // distance from O to tangent point along each leg
  const t = rEff / tanHalf; // = r * cot(theta/2)

  if (t >= leg1 - 1e-9 || t >= leg2 - 1e-9) {
    return { ok: false, error: 'ground_painter_fillet_error_large' };
  }

  // tangent points
  const t1 = { x: o.x + n1x * t, z: o.z + n1z * t };
  const t2 = { x: o.x + n2x * t, z: o.z + n2z * t };

  // bisector (internal)
  const bx = n1x + n2x, bz = n1z + n2z;
  const bLen = Math.hypot(bx, bz);
  if (bLen < 1e-9) return { ok: false, error: 'ground_painter_fillet_error_opposite' };
  const bnX = bx / bLen, bnZ = bz / bLen;
  const ocDist = rEff / sinHalf;
  const center = { x: o.x + bnX * ocDist, z: o.z + bnZ * ocDist };

  const a1 = Math.atan2(t1.z - center.z, t1.x - center.x);
  const a2 = Math.atan2(t2.z - center.z, t2.x - center.x);
  // signed delta should be PI - theta, with sign determined by cross of (t1-C) x (t2-C) vs bisector?
  // Compute cross to decide direction (should sweep the minor arc away from O)
  let delta = a2 - a1;
  // normalize to -PI..PI
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  // The minor arc magnitude should be PI - theta
  const expected = Math.PI - theta;
  // If |delta| is not close to expected, take the other direction
  if (Math.abs(Math.abs(delta) - expected) > 0.01) {
    // try opposite direction
    if (delta > 0) delta = delta - 2 * Math.PI;
    else delta = delta + 2 * Math.PI;
  }
  // Ensure |delta| ≈ PI - theta, clamp sign so arc is on the same side as O? Already internal.
  // If still not matching, force magnitude
  if (Math.abs(Math.abs(delta) - expected) > 0.12) {
    // fallback: choose delta that goes away from O (center to O opposite)
    // Determine which delta puts midpoint opposite O
    const testDelta = delta;
    const midAngle = a1 + testDelta / 2;
    const mid = { x: center.x + Math.cos(midAngle) * rEff, z: center.z + Math.sin(midAngle) * rEff };
    const vecOMidX = mid.x - o.x, vecOMidZ = mid.z - o.z;
    const dotMid = vecOMidX * bnX + vecOMidZ * bnZ;
    // dotMid should be positive (mid is towards O side? Actually center is towards interior, mid is between t1/t2, which is also interior but closer to O than center? Let's check: for 90°, center at (r,r) from O, t1 at (r,0), t2 at (0,r), mid at (r*(1 - cos45?), hmm.
    // For interior fillet, mid is interior but less distant than center. dotMid positive means mid is same side as center from O.
    // Both deltas will be same side? So not reliable.
    // Just ensure magnitude.
    delta = Math.sign(delta) * expected;
    if (delta === 0) delta = expected;
  }

  // generate points
  const arcAngle = Math.abs(delta);
  const steps = Math.max(8, Math.ceil(arcAngle / (10 * DEG)));
  const n = steps + 1; // include both ends
  const arcPoints = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const ang = a1 + delta * f;
    arcPoints.push({ x: center.x + Math.cos(ang) * rEff, z: center.z + Math.sin(ang) * rEff });
  }
  // Ensure endpoints exactly t1,t2 (override due to floating)
  arcPoints[0] = { x: t1.x, z: t1.z };
  arcPoints[arcPoints.length - 1] = { x: t2.x, z: t2.z };

  const ret = {
    ok: true,
    oIdx, oIdxA, oIdxB, p1Idx, p2Idx, p1, p2, o,
    duplicate, oCoord,
    virtualO, nearIdxA, nearIdxB,
    maxDot1, maxDot2,
    theta, thetaDeg, t, rEff, rMax, rReq,
    n1x, n1z, n2x, n2z,
    center, t1, t2, arcPoints, a1, a2, delta, n,
    len1, len2, segIdxA, segIdxB,
  };
  return ret;
}

// ─── Virtual (non-connected) fillet: ADDITIVE wiring ─────────────────────
// A fillet between two DISCONNECTED straight segments (imaginary intersection
// O) must never remove existing taxiway. The connected fillet replaces the
// corner region [O..tangent] with the arc — that IS the rounding. The virtual
// fillet has no corner to round: both picked segments keep their full geometry
// and the arc is wired on top:
//   - a node already sits at the tangent point (endpoint, or interior node of a
//     multi-vertex polyline): anchor the arc there directly, splitting the
//     polyline at an interior node so the branch is a real junction;
//   - tangent point beyond the segment's near endpoint (the common gap case):
//     keep the segment untouched and append an extension stub [T -> near] that
//     bridges the gap to the arc;
//   - tangent point strictly inside the span: split the segment at the tangent
//     point into [near..T] + [T..far] — both halves stay, the arc branches at T.

/** Distance of a point along the unit ray (n) from O. */
function _dotAlong(o, nx, nz, p) {
  return (p.x - o.x) * nx + (p.z - o.z) * nz;
}

function _polyIdxs(seg) {
  return seg.nodeIdxs && seg.nodeIdxs.length ? seg.nodeIdxs.slice() : [seg.aIdx, seg.bIdx];
}

/**
 * Wire one picked segment to its tangent point WITHOUT removing any of its
 * geometry. Appends segments/nodes to graph/meta as needed (extension stub or
 * split pieces; a split ghost-deletes the original segment PK — its geometry is
 * fully preserved by the two pieces). Returns the anchor node index the arc
 * should start/end at.
 */
export function attachVirtualFilletLeg(graph, meta, segIdx, tPt, o, nx, nz, t) {
  const seg = graph.segments[segIdx];
  if (!seg) return null;
  const idxs = _polyIdxs(seg);
  const flags = seg.flags ?? 2;
  const name = seg.name;
  const directed = seg.directed ?? false;
  const parentOsm = (meta.segOrigPk && meta.segOrigPk[segIdx]) != null
    ? osmFromSegPk(meta.segOrigPk[segIdx])
    : (seg.parentOsm ?? null);
  const mk = (poly) => {
    // A piece whose polyline contains two consecutive positions closer than the
    // write-time coordinate resolution collapses into ONE encoded vertex — the
    // segment then "joins vertex X to itself" and the save is refused. Drop
    // duplicate positions; a piece with fewer than two distinct positions is
    // not a segment at all.
    const dedup = [];
    for (const ni of poly) {
      const n = graph.nodes[ni];
      const last = dedup.length ? graph.nodes[dedup[dedup.length - 1]] : null;
      if (last && n && Math.hypot(n.x - last.x, n.z - last.z) < 1e-4) continue;
      dedup.push(ni);
    }
    if (dedup.length < 2) return null;
    return { aIdx: dedup[0], bIdx: dedup[dedup.length - 1], nodeIdxs: dedup, flags, directed, ...(name ? { name } : {}), ...(parentOsm != null && { parentOsm }) };
  };
  const ghostOrig = () => {
    const pk = meta.segOrigPk[segIdx];
    if (pk != null && !(meta.deletedPks || []).includes(pk)) {
      if (!meta.deletedPks) meta.deletedPks = [];
      meta.deletedPks.push(pk);
    }
  };

  const dots = idxs.map((i) => {
    const n = graph.nodes[i];
    return n ? _dotAlong(o, nx, nz, n) : NaN;
  });
  // A node already at the tangent point → anchor there, no new geometry.
  for (let p = 0; p < idxs.length; p++) {
    if (!Number.isNaN(dots[p]) && Math.abs(dots[p] - t) < 1e-6) {
      if (p === 0 || p === idxs.length - 1) return idxs[p];
      // Interior node of a multi-vertex polyline: split at it so the arc
      // branches off a real junction (both halves keep every original node).
      const leftPiece = mk(idxs.slice(0, p + 1));
      const rightPiece = mk(idxs.slice(p));
      if (!leftPiece || !rightPiece) return idxs[p]; // would degenerate — anchor without splitting
      ghostOrig();
      graph.segments.splice(segIdx, 1);
      meta.segOrigPk.splice(segIdx, 1);
      graph.segments.splice(segIdx, 0, leftPiece, rightPiece);
      meta.segOrigPk.splice(segIdx, 0, null, null);
      return idxs[p];
    }
  }
  // Near endpoint = node closest to the imaginary intersection O.
  let nearPos = 0;
  for (let i = 1; i < dots.length; i++) if (dots[i] < dots[nearPos]) nearPos = i;
  const dNear = dots[nearPos];
  // New tangent node (needed for both remaining cases).
  const tIdx = graph.nodes.length;
  graph.nodes.push({ x: tPt.x, z: tPt.z, type: 2, flags: 0 });
  meta.nodeOrigPk.push(null);
  if (Number.isNaN(dNear) || dNear >= t - 1e-9) {
    // Tangent point lies beyond the segment's near endpoint: the segment does
    // not reach the arc. Keep it untouched and bridge the gap with a stub —
    // unless the tangent effectively sits ON the near node (a stub would
    // collapse into a self-loop); then the node itself is the anchor.
    const nearNode = graph.nodes[idxs[nearPos]];
    if (nearNode && Math.hypot(tPt.x - nearNode.x, tPt.z - nearNode.z) < 1e-4) return idxs[nearPos];
    const stub = mk([tIdx, idxs[nearPos]]);
    if (!stub) return idxs[nearPos];
    graph.segments.push(stub);
    meta.segOrigPk.push(null);
    return tIdx;
  }
  // Tangent point strictly inside the span: split at the bracketing edge.
  let edge = -1;
  for (let i = 0; i < idxs.length - 1; i++) {
    const d0 = dots[i], d1 = dots[i + 1];
    if (Number.isNaN(d0) || Number.isNaN(d1)) continue;
    if ((d0 <= t && t <= d1) || (d1 <= t && t <= d0)) { edge = i; break; }
  }
  if (edge < 0) {
    // Pathological non-monotonic polyline: fall back to a stub touching the
    // node closest to the tangent point — still removes nothing.
    let bestPos = 0;
    for (let i = 1; i < dots.length; i++) if (Math.abs(dots[i] - t) < Math.abs(dots[bestPos] - t)) bestPos = i;
    const bestNode = graph.nodes[idxs[bestPos]];
    if (bestNode && Math.hypot(tPt.x - bestNode.x, tPt.z - bestNode.z) < 1e-4) return idxs[bestPos];
    const stub = mk([tIdx, idxs[bestPos]]);
    if (!stub) return idxs[bestPos];
    graph.segments.push(stub);
    meta.segOrigPk.push(null);
    return tIdx;
  }
  const left = [...idxs.slice(0, edge + 1), tIdx];
  const right = [tIdx, ...idxs.slice(edge + 1)];
  const leftPiece = mk(left);
  const rightPiece = mk(right);
  if (!leftPiece || !rightPiece) {
    // The tangent sits (almost) on an existing node — anchoring there beats a
    // degenerate split. Undo the tentative tangent node and keep the segment.
    graph.nodes.pop();
    meta.nodeOrigPk.pop();
    return Math.abs(dots[edge] - t) <= Math.abs(dots[edge + 1] - t) ? idxs[edge] : idxs[edge + 1];
  }
  ghostOrig();
  graph.segments.splice(segIdx, 1);
  meta.segOrigPk.splice(segIdx, 1);
  graph.segments.splice(segIdx, 0, leftPiece, rightPiece);
  meta.segOrigPk.splice(segIdx, 0, null, null);
  return tIdx;
}

/**
 * Apply a VIRTUAL (non-connected) fillet additively: wire both picked segments
 * to their tangent points (never deleting taxiway) and append the arc segment
 * bridging the two anchors. Arc endpoints may be pre-existing nodes, so only
 * the interior arc points are added as new nodes.
 * @returns {{idxT1:number, idxT2:number}} anchor node indices of the arc ends
 */
export function applyVirtualFillet(graph, meta, res, segIdxA, segIdxB) {
  // Pre-check (before any mutation): when BOTH legs would anchor at existing
  // nodes that are the same or share a position, the arc starts and ends at
  // one encoded vertex ("joins vertex X to itself") — the virtual fillet
  // cannot represent a corner where the two picked segments meet. Reject
  // before mutating so callers see a clean error on an untouched graph.
  const sidesDef = [
    { segIdx: segIdxA, nx: res.n1x, nz: res.n1z },
    { segIdx: segIdxB, nx: res.n2x, nz: res.n2z },
  ];
  const existingAnchor = sidesDef.map((s) => {
    const seg = graph.segments[s.segIdx];
    if (!seg) return null;
    const idxs = _polyIdxs(seg);
    for (let p = 0; p < idxs.length; p++) {
      const n = graph.nodes[idxs[p]];
      if (!n) continue;
      if (Math.abs(_dotAlong(res.o, s.nx, s.nz, n) - res.t) < 1e-6) return idxs[p];
    }
    return null; // a fresh tangent node will be created for this leg
  });
  if (existingAnchor[0] != null && existingAnchor[1] != null) {
    const na = graph.nodes[existingAnchor[0]];
    const nb = graph.nodes[existingAnchor[1]];
    if (existingAnchor[0] === existingAnchor[1] ||
        (na && nb && Math.hypot(na.x - nb.x, na.z - nb.z) < 1e-4)) {
      throw new Error('fillet rejected: both arc ends anchor at the same position — the two segments already meet there');
    }
  }
  // Higher segment index first: splitting splices the segment array and would
  // shift the other picked index.
  const sides = [
    { segIdx: segIdxA, nx: res.n1x, nz: res.n1z, tPt: res.t1 },
    { segIdx: segIdxB, nx: res.n2x, nz: res.n2z, tPt: res.t2 },
  ].sort((a, b) => b.segIdx - a.segIdx);
  const anchors = {};
  for (const s of sides) {
    let a = attachVirtualFilletLeg(graph, meta, s.segIdx, s.tPt, res.o, s.nx, s.nz, res.t);
    if (a == null) {
      // Segment vanished (should not happen): still give the arc a live node.
      a = graph.nodes.length;
      graph.nodes.push({ x: s.tPt.x, z: s.tPt.z, type: 2, flags: 0 });
      meta.nodeOrigPk.push(null);
    }
    anchors[s.segIdx] = a;
  }
  const arcIdxs = [anchors[segIdxA]];
  const base = graph.nodes.length;
  for (let i = 1; i < res.arcPoints.length - 1; i++) {
    graph.nodes.push({ x: res.arcPoints[i].x, z: res.arcPoints[i].z, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);
    arcIdxs.push(base + i - 1);
  }
  arcIdxs.push(anchors[segIdxB]);
  // A fillet arc whose two ends anchor at the same node — or at two nodes that
  // share a position — encodes as a polyline that starts and ends at ONE
  // vertex: "segment joins vertex X to itself", which the save-time integrity
  // check refuses. That happens when both legs anchor at the junction where
  // the two picked segments meet; the virtual (additive) fillet cannot
  // represent a corner — reject instead of writing poison.
  {
    const na = graph.nodes[arcIdxs[0]];
    const nb = graph.nodes[arcIdxs[arcIdxs.length - 1]];
    if (arcIdxs[0] === arcIdxs[arcIdxs.length - 1] ||
        (na && nb && Math.hypot(na.x - nb.x, na.z - nb.z) < 1e-4)) {
      throw new Error('fillet rejected: both arc ends anchor at the same position — the two segments already meet there');
    }
  }
  graph.segments.push({ aIdx: arcIdxs[0], bIdx: arcIdxs[arcIdxs.length - 1], nodeIdxs: arcIdxs, flags: 2, directed: false });
  meta.segOrigPk.push(null);
  return { idxT1: anchors[segIdxA], idxT2: anchors[segIdxB] };
}
// ─── Ghost-node invariant ────────────────────────────────────────────────
// A node whose original PK was pushed into meta.deletedPks is a GHOST: it is
// kept in graph.nodes on purpose (so every other entity's index stays stable)
// but patchSceneryBlob will NOT emit it into the .acl. Any NEW entity (one the
// writer re-synthesizes, i.e. meta.segOrigPk/standOrigPk/runwayOrigPk is null)
// that still points at a ghost index therefore serializes to "$iref:null" —
// the save then aborts with `invalid $iref payload "null"`.
//
// Every mutation that ghost-deletes a node MUST stop referencing it. These two
// helpers make that invariant explicit and enforceable instead of leaving it to
// each call site.

function _coordKey(n) {
  return Math.round(n.x * 1e6) + ',' + Math.round(n.z * 1e6);
}

/** Node indices that are ghosts (kept in the graph, dropped from the file). */
export function ghostNodeIndices(graph, meta) {
  const ghosts = new Set();
  const deleted = new Set((meta && meta.deletedPks) || []);
  if (!deleted.size || !graph || !graph.nodes) return ghosts;
  const orig = (meta && meta.nodeOrigPk) || [];
  for (let i = 0; i < graph.nodes.length; i++) {
    const pk = orig[i];
    if (pk != null && deleted.has(pk)) ghosts.add(i);
  }
  return ghosts;
}

/**
 * Re-point NEW entities away from ghost nodes onto a live node at the same
 * coordinate (duplicate nodes at a snap point are geometrically identical, so
 * this preserves the shape), and drop entities that cannot be repaired.
 *
 * Called after any mutation that ghost-deletes a node. Old (survivor) entities
 * are left alone on purpose: the writer copies them verbatim from the snapshot,
 * so editing their indices would silently not persist.
 *
 * @returns {{remapped:number, dropped:number, warnings:string[]}}
 *   warnings are i18n keys — translate them at the display site.
 */
export function repairGhostRefs(graph, meta) {
  const out = { remapped: 0, dropped: 0, warnings: [] };
  const ghosts = ghostNodeIndices(graph, meta);
  if (!ghosts.size || !graph) return out;

  // First live node per coordinate — the replacement for a ghosted twin.
  const liveByCoord = new Map();
  for (let i = 0; i < (graph.nodes || []).length; i++) {
    if (ghosts.has(i)) continue;
    const n = graph.nodes[i];
    if (!n) continue;
    const k = _coordKey(n);
    if (!liveByCoord.has(k)) liveByCoord.set(k, i);
  }
  const fix = (i) => {
    if (i == null) return null;
    if (!ghosts.has(i)) {
      // Also catches a stale index — a node that was spliced out while a
      // reference to it survived. Same "$iref:null" outcome at save time.
      return graph.nodes[i] ? i : null;
    }
    const n = graph.nodes[i];
    const twin = n ? liveByCoord.get(_coordKey(n)) : undefined;
    if (twin != null) { out.remapped++; return twin; }
    return null;
  };
  const repairList = (list) => {
    const fixed = [];
    for (const i of list) {
      const v = fix(i);
      if (v != null) fixed.push(v);
    }
    return fixed;
  };
  const isNew = (arr, i) => !arr || arr[i] == null;

  for (let s = (graph.segments || []).length - 1; s >= 0; s--) {
    const sg = graph.segments[s];
    if (!sg || !isNew(meta.segOrigPk, s)) continue;
    const idxs = sg.nodeIdxs && sg.nodeIdxs.length ? sg.nodeIdxs : [sg.aIdx, sg.bIdx];
    if (!idxs.some((i) => ghosts.has(i) || !graph.nodes[i])) continue;
    const fixed = repairList(idxs);
    // Twin remapping can fold the polyline: two consecutive ghosts remapped
    // onto the same live twin produce consecutive duplicates, and a segment
    // whose ends remap to one node encodes as a self-loop ("joins vertex X to
    // itself"). Collapse duplicates and drop fully-degenerate segments.
    const dedup = [];
    for (const ni of fixed) {
      if (dedup.length && dedup[dedup.length - 1] === ni) continue;
      dedup.push(ni);
    }
    const n0 = graph.nodes[dedup[0]];
    const n1 = graph.nodes[dedup[dedup.length - 1]];
    const endsColocated = dedup.length >= 2 && n0 && n1 && Math.hypot(n0.x - n1.x, n0.z - n1.z) < 1e-4 && dedup.length === 2;
    if (dedup.length < 2 || endsColocated) {
      graph.segments.splice(s, 1);
      if (meta.segOrigPk && s < meta.segOrigPk.length) meta.segOrigPk.splice(s, 1);
      out.dropped++;
      out.warnings.push('ground_painter_fillet_dropped_leg');
      continue;
    }
    sg.nodeIdxs = dedup;
    sg.aIdx = dedup[0];
    sg.bIdx = dedup[dedup.length - 1];
  }

  for (let i = (graph.stands || []).length - 1; i >= 0; i--) {
    const st = graph.stands[i];
    if (!st || !isNew(meta.standOrigPk, i)) continue;
    const nose = fix(st.noseIdx);
    const tail = fix(st.tailIdx);
    if (nose == null || tail == null) {
      graph.stands.splice(i, 1);
      if (meta.standOrigPk && i < meta.standOrigPk.length) meta.standOrigPk.splice(i, 1);
      out.dropped++;
      out.warnings.push('ground_painter_fillet_dropped_stand');
      continue;
    }
    st.noseIdx = nose;
    st.tailIdx = tail;
    if (Array.isArray(st.pushbackIdxs)) st.pushbackIdxs = repairList(st.pushbackIdxs);
  }

  for (let i = (graph.runways || []).length - 1; i >= 0; i--) {
    const rw = graph.runways[i];
    if (!rw) continue;
    const a = fix(rw.thAIdx);
    const b = fix(rw.thBIdx);
    if (a == null || b == null) {
      // Unrepairable thresholds (the node was ghost-deleted and no live node
      // sits at the same coordinate). Drop the runway AND its pavement strips
      // AND the meta rows — mirroring the delete cascade — for NEW and
      // SURVIVOR runways alike. A survivor left behind makes the writer emit
      // named runway entries whose ThresholdPoints dangle: the game (and this
      // editor's reader) then drop the runway silently, orphaning its strips
      // and its physical-runway registry key.
      const phys = String(rw.physicalName || '');
      graph.runways.splice(i, 1);
      if (meta.runwayOrigPk && i < meta.runwayOrigPk.length) {
        const pk = meta.runwayOrigPk[i];
        if (pk != null && meta.deletedPks && !meta.deletedPks.includes(pk)) meta.deletedPks.push(pk);
        meta.runwayOrigPk.splice(i, 1);
      }
      if (meta.runwayOrigInfo && i < meta.runwayOrigInfo.length) {
        const info = meta.runwayOrigInfo[i];
        if (info && Array.isArray(info.pks)) {
          for (const pk of info.pks) {
            if (pk != null && meta.deletedPks && !meta.deletedPks.includes(pk)) meta.deletedPks.push(pk);
          }
        }
        meta.runwayOrigInfo.splice(i, 1);
      }
      if (meta.runwayPavement && i < meta.runwayPavement.length) meta.runwayPavement.splice(i, 1);
      for (let si = (graph.segments || []).length - 1; si >= 0; si--) {
        const sg = graph.segments[si];
        if (!sg || sg.name !== phys) continue;
        if (meta.segOrigPk && si < meta.segOrigPk.length) {
          const pk = meta.segOrigPk[si];
          if (pk != null && meta.deletedPks && !meta.deletedPks.includes(pk)) meta.deletedPks.push(pk);
          meta.segOrigPk.splice(si, 1);
        }
        graph.segments.splice(si, 1);
      }
      out.dropped++;
      out.warnings.push('ground_painter_fillet_dropped_runway');
      continue;
    }
    if (!isNew(meta.runwayOrigPk, i)) continue;
    rw.thAIdx = a;
    rw.thBIdx = b;
  }

  // Final sweep: drop any segment that would serialize as a degenerate edge —
  // a self-loop (both ends the same node) or two consecutive vertices at the
  // same position. These are always paint fragments (unnamed synthesized
  // pieces whose geometry collapsed); the game's taxiway edge factory
  // null-derefs on them, so they must never reach the .acl.
  for (let s = (graph.segments || []).length - 1; s >= 0; s--) {
    const sg = graph.segments[s];
    if (!sg) continue;
    const idxs = sg.nodeIdxs && sg.nodeIdxs.length ? sg.nodeIdxs : [sg.aIdx, sg.bIdx];
    let bad = sg.aIdx != null && sg.aIdx === sg.bIdx;
    if (!bad) {
      let prev = null;
      for (const ni of idxs) {
        const n = graph.nodes[ni];
        if (!n) { prev = null; continue; }
        if (prev && Math.hypot(n.x - prev.x, n.z - prev.z) < 1e-4) { bad = true; break; }
        prev = n;
      }
    }
    if (bad) {
      graph.segments.splice(s, 1);
      if (meta.segOrigPk && s < meta.segOrigPk.length) {
        const pk = meta.segOrigPk[s];
        if (pk != null && meta.deletedPks && !meta.deletedPks.includes(pk)) meta.deletedPks.push(pk);
        meta.segOrigPk.splice(s, 1);
      }
      out.dropped++;
    }
  }

  return out;
}
