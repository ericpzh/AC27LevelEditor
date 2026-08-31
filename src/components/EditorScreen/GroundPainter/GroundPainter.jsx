/**
 * Ground Painter — dedicated full-screen window over the level's static scenery.
 *
 * Reads the painter's id-free Graph (store `groundPainterGraph`) built in the
 * MAIN process (`load-ground-painter-data` → buildSceneryGraph) against the
 * snapshot of `currentPath`; persists via `save-ground-painter-data` (.bak
 * choice prompted on Save, mirroring the editor save UX). Renders a pixel-copy
 * of the GroundMapWindow layer order (bg → taxiway → Area → runway).
 *
 * NOTE: authored per plan; requires the Vite/Electron build to run.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import GroundPainterToolbar from './GroundPainterToolbar';
import './GroundPainter.css';
import { findSnap, worldSnapDist, dynamicSnapDist, dynamicAngleTolDeg, collectSnapGeometry, SNAP_TYPES } from './snap';
import { polygonIsSimple } from './polygon_simple.js';
import { computeFillet, applyVirtualFillet, countIncidentAll, countIncidentByCoord, findNodeIndexByCoord, isStraightSegment, repairGhostRefs, ghostNodeIndices } from './fillet';
import { segNodeIdxs, polylineLengthMeters, segmentLengthMeters, runwayLengthMeters, formatLengthMeters, buildTaxiPaths } from './metrics';
// Keep the metrics helpers reachable from the component's import surface.
export { polylineLengthMeters, segmentLengthMeters, runwayLengthMeters, formatLengthMeters, buildTaxiPaths };
import { useTranslation } from '../../../hooks/useTranslation';
import { useAppStore } from '../../../store/appStore';
import { IoClose, IoCheckmark } from 'react-icons/io5';
import { MAP_ICON_PATH, MAP_PLANE_VB, STAND_LENGTH, RUNWAY_WIDTH, DEFAULT_AIRPORT_SCALE, PUSHBACK_OFFSET_1, PUSHBACK_OFFSET_2, WIND_UNITS } from '../../../utils/constants';

const svgY = (z) => -z;

// Dynamic selection thresholds — shrink when zoomed in so stands don't block areas.
// At base zoom (viewBox == baseVB) thresholds equal the classic constant-screen size.
// When zoomed in 2× (viewBox half width) the screen hit radius halves.
// Stand icon is FIXED on the map (world size = baseDiag*0.028/2.4 — the ZSJN 240% reference),
// so its world size does NOT scale with vbDiag.
function getDynamicSelectThresholds(viewBox, baseVB) {
  const vbDiag = viewBox ? Math.max(viewBox[2], viewBox[3]) : 60;
  const baseDiag = baseVB ? Math.max(baseVB[2], baseVB[3]) : vbDiag;
  const rawScale = baseDiag ? vbDiag / baseDiag : 1; // <1 when zoomed in
  const scale = Math.max(0.28, Math.min(1.6, Math.pow(Math.max(rawScale, 0.18), 0.92)));
  const baseTH = Math.max(worldSnapDist(vbDiag), 0.45);
  // Fixed stand icon world size (ZSJN 240% reference)
  const fixedWorldSize = baseDiag * 0.028 / 2.4;
  const fixedIconHalf = fixedWorldSize / 2;
  const baseTH_STAND = Math.max(fixedIconHalf * 1.35, 0.28);
  const TH = Math.max(0.16, Math.min(0.85, baseTH * scale));
  const TH_STAND = Math.max(0.14, Math.min(0.9, baseTH_STAND * scale));
  const tightStand = Math.max(0.12, fixedIconHalf * 0.75 * scale);
  return { vbDiag, baseDiag, scale, TH, TH_STAND, tightStand, iconHalf: fixedIconHalf, fixedWorldSize };
}

// Zoom-aware snap distance, anchored to the BASE (fit) viewBox: keeps the
// on-screen grab radius stable across zoom, and makes a zoomed-in window snap a
// SMALLER distance than a zoomed-out one (dynamicSnapDist).
function painterSnapDist(viewBox, baseVB) {
  const vbDiag = viewBox ? Math.max(viewBox[2], viewBox[3]) : 0;
  const baseDiag = baseVB ? Math.max(baseVB[2], baseVB[3]) : vbDiag;
  return dynamicSnapDist(vbDiag, baseDiag);
}

// Zoom-aware ANGULAR snap window (degrees), the angular twin of painterSnapDist:
// at base (fit) zoom it's the classic 2.5° window; zooming IN tightens it
// ("less snappy" — finer control) and zooming OUT widens it (snaps more readily).
function painterAngleTol(viewBox, baseVB) {
  const vbDiag = viewBox ? Math.max(viewBox[2], viewBox[3]) : 0;
  const baseDiag = baseVB ? Math.max(baseVB[2], baseVB[3]) : vbDiag;
  return dynamicAngleTolDeg(vbDiag, baseDiag);
}

// Plane-icon thumb for heading sliders — same data-URI as FlightPatchCommandBar
const PLANE_THUMB_URI =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="${MAP_ICON_PATH}" fill="currentColor"/></svg>`
  );

const pad3 = (n) => String(n).padStart(3, '0');
const TOOL_LINE = 'taxiwayLine';
const TOOL_CURVE = 'taxiwayCurve'; // now fillet/rounding - picks 2 straight segments
const TOOL_RUNWAY = 'runwayLine';
const TOOL_STAND = 'stand';
const TOOL_SELECT = 'select';
const TOOL_BOX_SELECT = 'boxSelect';

// Taxiway-segment `Flags` bitmask (see src/acl/taxiway.js): 1=standard, 2=wider,
// 4=special. A runway's coupled pavement strip is flagged 4 (special) — the same
// value the game's own runway pavement uses (ZSJN 01/19 strips are all Flags=4).
const RUNWAY_PAVEMENT_FLAGS = 4;


// While a text/edit field has focus (e.g. the floating runway end-name boxes),
// keystrokes belong to the textbox — don't hijack Delete/Backspace/Escape/Ctrl+Z.
const isTextEditTarget = (el) => {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};
// Same styling as GroundMapWindow AREA_TYPE_STYLES so the painter matches the Ground Map.
const AREA_TYPE_STYLES = {
  0: { fill: '#1a3a6a', stroke: '#2a5a9a', opacity: 0.20 },
  1: { fill: '#444', stroke: 'none', opacity: 0.75 },
  2: { fill: '#000', stroke: 'none', opacity: 1.0 },
};
// Draw order (bottom → top): BOUNDARY < APRON < BUILDING — all BELOW taxiway.
const AREA_Z_ORDER = [0, 1, 2];

// Distance from point (px,pz) to segment a-b (in world units).
function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
function pointInPoly(px, pz, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, zi = pts[i].z, xj = pts[j].x, zj = pts[j].z;
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function minEdgeDist(px, pz, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    d = Math.min(d, distToSeg(px, pz, pts[i].x, pts[i].z, pts[j].x, pts[j].z));
  }
  return d;
}
// Min distance from point to a polyline (open). Used for curve selection so a
// click near a curved taxiway's arc (not its endpoints' straight chord) selects it.
function distToPoly(px, pz, pts) {
  if (!pts || pts.length < 2) return Infinity;
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, distToSeg(px, pz, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z));
  }
  return d;
}

// ── Runway ↔ collinear pavement-strip coupling ──────────────────
// A physical runway is drawn NOT only as a `runway:*` pair but also as a set of
// `taxiway-segment` pavement strips whose `Name` === the runway's physical name
// (the ZSJN pattern: runway `01/19` ↔ a 9-segment chain named `"01/19"` running
// the full runway length). The chain shares only its 2 threshold nodes with the
// runway; the rest are the strip's own nodes, so moving/adding a runway must
// re-project (or create) the strips or the pavement is left behind.
//
// `runwayPavement(graph, meta, rwIdx)` → the runway's coupled strip node
// indices (from `meta.runwayPavement`, computed at load by Name match), plus the
// runway axis's ORIGINAL threshold coords. Returns null if the runway has no
// coupled pavement. Falls back to a live Name match so a runway added this session
// (whose strip was created by `commitRunway`) couples correctly even if meta
// hasn't been extended. Prefers `meta` because it is index-based and survives a
// mid-session rename (graph segment names are synced on rename too, but meta is
// the authoritative, name-independent handle).
function runwayPavement(graph, meta, rwIdx) {
  if (!graph || !graph.runways || !graph.runways[rwIdx]) return null;
  const rw = graph.runways[rwIdx];
  const a0 = graph.nodes[rw.thAIdx], b0 = graph.nodes[rw.thBIdx];
  if (!a0 || !b0) return null;
  let stripNodes = (meta && meta.runwayPavement && meta.runwayPavement[rwIdx]) || [];
  if (stripNodes.length === 0) {
    // Live fallback: any segment whose Name === the runway physical name.
    const phys = rw.physicalName;
    const seen = new Set();
    stripNodes = [];
    for (const s of graph.segments) {
      if (s.name !== phys) continue;
      for (const ni of (s.nodeIdxs || [s.aIdx, s.bIdx])) {
        if (seen.has(ni)) continue;
        seen.add(ni);
        stripNodes.push(ni);
      }
    }
  }
  if (stripNodes.length === 0) return null;
  return {
    thAIdx: rw.thAIdx, thBIdx: rw.thBIdx,
    a0: { x: a0.x, z: a0.z }, b0: { x: b0.x, z: b0.z },
    stripNodes: stripNodes.map((ni) => ({ ni, x: graph.nodes[ni].x, z: graph.nodes[ni].z })),
  };
}

// Project a point `p` from the OLD runway axis (a0,b0) to the NEW axis (a1,b1),
// preserving its perpendicular offset and its FRACTIONAL along-axis position
// (along / oldLength scaled to the new axis length). This re-lays the collinear
// pavement strip on top of the runway's NEW line, so it follows the runway for
// translate, rotate AND a single-threshold reshape (where one endpoint moves and
// the runway length changes). A purely rigid mapping (no along scaling) would
// squish the strip toward the moved end whenever the runway length changes.
function reprojectOnRunwayAxis(p, a0, b0, a1, b1) {
  const ux0 = b0.x - a0.x, uz0 = b0.z - a0.z, l0 = Math.hypot(ux0, uz0) || 1;
  const u0x = ux0 / l0, u0z = uz0 / l0, n0x = -u0z, n0z = u0x;
  const dx = p.x - a0.x, dz = p.z - a0.z;
  const along = dx * u0x + dz * u0z;
  const perp = dx * n0x + dz * n0z;
  const ux1 = b1.x - a1.x, uz1 = b1.z - a1.z, l1 = Math.hypot(ux1, uz1) || 1;
  const u1x = ux1 / l1, u1z = uz1 / l1, n1x = -u1z, n1z = u1x;
  // Scale along by l1/l0 so a node stays at the same fraction of the runway
  // (the strip tracks a changed runway length), instead of keeping a fixed
  // absolute along offset (which breaks when one threshold is dragged).
  const alongScaled = along * (l1 / l0);
  return { x: a1.x + alongScaled * u1x + perp * n1x, z: a1.z + alongScaled * u1z + perp * n1z };
}
// ── Multi-selection ROTATION helpers ──────────────────────────
// Rotate a world point (x,z) around a pivot (cx,cz) by `deg` degrees (rigid).
// Applying this to a stand's geometry maps its `heading` to heading - deg, which
// keeps head/tail/icon in lockstep (see standHeadingPlacement).
function rotateWorldPoint(px, pz, cx, cz, deg) {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const dx = px - cx, dz = pz - cz;
  return { x: cx + cos * dx - sin * dz, z: cz + sin * dx + cos * dz };
}
// Place a stand's TAIL and pushback nodes from its nose position + heading (deg).
// MUST stay in lockstep with the renderer's heading rotation so the icon and the
// HEAD→TAIL line agree. tail = nose - vec*L (vec = (cos, -sin)); pushbacks behind tail.
function standHeadingPlacement(nose, hdg, st) {
  const hRad = (hdg * Math.PI) / 180;
  const tail = { x: nose.x - Math.cos(hRad) * STAND_LENGTH, z: nose.z + Math.sin(hRad) * STAND_LENGTH };
  const pushbacks = [];
  if (Array.isArray(st.pushbackIdxs) && st.pushbackIdxs.length > 0) {
    const vecX = Math.cos(hRad), vecZ = -Math.sin(hRad);
    st.pushbackIdxs.forEach((pi, k) => {
      const off = k === 0 ? PUSHBACK_OFFSET_1 : PUSHBACK_OFFSET_2;
      pushbacks.push({ idx: pi, x: tail.x - vecX * off, z: tail.z - vecZ * off });
    });
  }
  return { tail, pushbacks };
}
// Build a rigid-rotation plan over a selection: the set of graph nodes, area
// point-arrays and stand headings that must all rotate together around a common
// pivot (the selection's bounding-box center). `nodes` hold the ORIGINAL
// positions — the apply step always rotates from these so a drag never
// accumulates drift. Returns null when there is nothing to rotate.
function buildRotationPlan(graph, meta, sels) {
  if (!graph || !sels || !sels.length) return null;
  const nodeMap = new Map();   // ni -> {ni,x,z}
  const areas = [];            // {idx, points:[{x,z}]}
  const stands = [];           // {idx, heading}
  const pts = [];              // all points (for the bounding-box center)
  const addNode = (ni) => {
    const n = graph.nodes[ni];
    if (n && !nodeMap.has(ni)) nodeMap.set(ni, { ni, x: n.x, z: n.z });
  };
  const acc = (x, z) => { pts.push({ x, z }); };
  for (const sel of sels) {
    if (sel.kind === 'segment') {
      const sg = graph.segments[sel.idx]; if (!sg) continue;
      for (const ni of segNodeIdxs(sg)) { addNode(ni); const n = graph.nodes[ni]; if (n) acc(n.x, n.z); }
    } else if (sel.kind === 'runway') {
      const rw = graph.runways[sel.idx]; if (!rw) continue;
      addNode(rw.thAIdx); { const a = graph.nodes[rw.thAIdx]; if (a) acc(a.x, a.z); }
      addNode(rw.thBIdx); { const b = graph.nodes[rw.thBIdx]; if (b) acc(b.x, b.z); }
      const pav = runwayPavement(graph, meta, sel.idx);
      if (pav) for (const s of pav.stripNodes) { addNode(s.ni); const n = graph.nodes[s.ni]; if (n) acc(n.x, n.z); }
    } else if (sel.kind === 'stand') {
      const st = graph.stands[sel.idx]; if (!st) continue;
      addNode(st.noseIdx); { const n = graph.nodes[st.noseIdx]; if (n) acc(n.x, n.z); }
      addNode(st.tailIdx); { const n = graph.nodes[st.tailIdx]; if (n) acc(n.x, n.z); }
      for (const pi of (st.pushbackIdxs || [])) { addNode(pi); const n = graph.nodes[pi]; if (n) acc(n.x, n.z); }
      stands.push({ idx: sel.idx, heading: st.heading || 360 });
    } else if (sel.kind === 'area') {
      const ar = graph.areas && graph.areas[sel.idx]; if (!ar) continue;
      const points = (ar.points || []).map((p) => ({ x: p.x, z: p.z }));
      areas.push({ idx: sel.idx, points });
      for (const p of points) acc(p.x, p.z);
    }
  }
  if (!pts.length) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, minX, maxX, minZ, maxZ, nodes: [...nodeMap.values()], areas, stands };
}
// ── Box-select helpers (NOT AREA) ─────────────────────────────
// Rect is {minX,maxX,minZ,maxZ} in world units. "Inside" = fully inside for
// polylines/runways, point-inside for stands.
function pointInBox(pt, box) {
  return pt.x >= box.minX && pt.x <= box.maxX && pt.z >= box.minZ && pt.z <= box.maxZ;
}
function computeBoxSelection(graph, box) {
  if (!graph || !box) return [];
  const out = [];
  // Runway pavement-strip names share the physicalName and should NOT be
  // selectable as standalone taxiway segments.
  const runwayStripNames = new Set((graph.runways || []).map((r) => r.physicalName));
  for (let i = 0; i < (graph.segments || []).length; i++) {
    const sg = graph.segments[i];
    if (sg.name && runwayStripNames.has(sg.name)) continue;
    const pts = segNodeIdxs(sg).map((ni) => graph.nodes[ni]).filter(Boolean);
    if (pts.length < 2) continue;
    // fully inside: every vertex inside box
    if (pts.every((p) => pointInBox(p, box))) out.push({ kind: 'segment', idx: i });
  }
  for (let i = 0; i < (graph.runways || []).length; i++) {
    const rw = graph.runways[i];
    const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
    if (!a || !b) continue;
    if (pointInBox(a, box) && pointInBox(b, box)) out.push({ kind: 'runway', idx: i });
  }
  for (let i = 0; i < (graph.stands || []).length; i++) {
    const st = graph.stands[i];
    const nose = graph.nodes[st.noseIdx];
    if (!nose) continue;
    if (pointInBox(nose, box)) out.push({ kind: 'stand', idx: i });
  }
  // Areas are box-selectable ALONGSIDE taxiways/runways/stands (no occlusion
  // gate — a box may select areas at the same time as the lines/stands on top).
  // Matching rule is identical to segments/runways: the box fully encloses the
  // area (every vertex inside).
  for (let i = 0; i < (graph.areas || []).length; i++) {
    const ar = graph.areas[i];
    const pts = (ar && ar.points) || [];
    if (pts.length >= 3 && pts.every((p) => pointInBox(p, box))) out.push({ kind: 'area', idx: i });
  }
  return out;
}
function isMultiSelected(multiSelected, kind, idx) {
  if (!multiSelected || !multiSelected.length) return false;
  return multiSelected.some((s) => s.kind === kind && s.idx === idx);
}
function pointOnMultiSelected(graph, multiSelected, wp) {
  if (!graph || !wp || !multiSelected || !multiSelected.length) return false;
  const TH = 0.6;
  for (const sel of multiSelected) {
    if (sel.kind === 'segment') {
      const sg = graph.segments[sel.idx];
      const pts = segNodeIdxs(sg).map((ni) => graph.nodes[ni]).filter(Boolean);
      if (pts.length >= 2 && distToPoly(wp.x, wp.z, pts) <= TH) return true;
    } else if (sel.kind === 'runway') {
      const rw = graph.runways[sel.idx];
      const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
      if (!a || !b) continue;
      const halfW = (rw.width || 0.50) / 2;
      if (distToSeg(wp.x, wp.z, a.x, a.z, b.x, b.z) <= Math.max(TH, halfW)) return true;
    } else if (sel.kind === 'stand') {
      const st = graph.stands[sel.idx];
      const nose = graph.nodes[st.noseIdx];
      if (nose && Math.hypot(wp.x - nose.x, wp.z - nose.z) <= TH) return true;
    } else if (sel.kind === 'area') {
      const ar = graph.areas && graph.areas[sel.idx];
      const pts = (ar && ar.points) || [];
      if (pts.length >= 3 && (pointInPoly(wp.x, wp.z, pts) || minEdgeDist(wp.x, wp.z, pts) <= TH)) return true;
    }
  }
  return false;
}
// Is any higher-priority line/runway/stand under wp? (Lines beat areas in select.)
// Used so a selected area is NOT grabbed when a taxiway/runway/stand sits on top.
function lineUnderPoint(graph, wp) {
  if (!graph || !wp) return false;
  const TH = 0.5;
  for (let i = 0; i < (graph.segments || []).length; i++) {
    const pts = segNodeIdxs(graph.segments[i]).map((ni) => graph.nodes[ni]).filter(Boolean);
    if (pts.length >= 2 && distToPoly(wp.x, wp.z, pts) <= TH) return true;
  }
  for (let i = 0; i < (graph.runways || []).length; i++) {
    const rw = graph.runways[i];
    const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
    if (a && b && distToSeg(wp.x, wp.z, a.x, a.z, b.x, b.z) <= TH) return true;
  }
  for (let i = 0; i < (graph.stands || []).length; i++) {
    const st = graph.stands[i];
    const nose = graph.nodes[st.noseIdx];
    if (nose && Math.hypot(wp.x - nose.x, wp.z - nose.z) <= TH) return true;
  }
  return false;
}
// Is the world point ON the selected object (its movable body/region)? Used to
// decide between body-moving the selection vs panning when a selection exists.
function pointOnSelected(graph, sel, wp) {
  if (!sel || !wp || !graph) return false;
  const TH = 0.6; // generous region threshold (GU), consistent with selection
  if (sel.kind === 'segment') {
    const sg = graph.segments[sel.idx];
    const pts = segNodeIdxs(sg).map((ni) => graph.nodes[ni]).filter(Boolean);
    if (pts.length < 2) return false;
    return distToPoly(wp.x, wp.z, pts) <= TH;
  }
  if (sel.kind === 'runway') {
    const rw = graph.runways[sel.idx];
    const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
    if (!a || !b) return false;
    const halfW = (rw.width || 0.50) / 2;
    return distToSeg(wp.x, wp.z, a.x, a.z, b.x, b.z) <= Math.max(TH, halfW);
  }
  if (sel.kind === 'stand') {
    const st = graph.stands[sel.idx];
    const nose = graph.nodes[st.noseIdx];
    if (!nose) return false;
    return Math.hypot(wp.x - nose.x, wp.z - nose.z) <= TH;
  }
  if (sel.kind === 'area') {
    const ar = graph.areas && graph.areas[sel.idx];
    const pts = (ar && ar.points) || [];
    if (pts.length < 3) return false;
    if (lineUnderPoint(graph, wp)) return false; // a line on top occludes the area
    return pointInPoly(wp.x, wp.z, pts) || minEdgeDist(wp.x, wp.z, pts) <= TH;
  }
  return false;
}
// ── Background image helpers (selectable / draggable / rotatable) ──
function getBgBounds(bg) {
  if (!bg || !bg.baseW || !bg.baseH) return null;
  const bgW = bg.baseW * bg.scale;
  const bgH = bg.baseH * bg.scale;
  const cx = bg.anchorX + (bg.offsetX / 100) * bgW;
  const cz = bg.anchorZ + (bg.offsetY / 100) * bgH;
  return { bgW, bgH, cx, cz, minX: cx - bgW / 2, maxX: cx + bgW / 2, minZ: cz - bgH / 2, maxZ: cz + bgH / 2, w: bgW, h: bgH };
}
function normalizeBgRotation(a) {
  let n = Number(a);
  if (!isFinite(n)) n = 0;
  n = ((n + 180) % 360 + 360) % 360 - 180;
  // keep -180 .. 180; map 180 -> 180 (not -180)
  if (n === -180) n = 180;
  return Math.round(n);
}
function pointInBgBounds(bg, wp) {
  const b = getBgBounds(bg);
  if (!b || !wp) return false;
  const rot = (bg.rotation || 0) * Math.PI / 180;
  if (!rot) return wp.x >= b.minX && wp.x <= b.maxX && wp.z >= b.minZ && wp.z <= b.maxZ;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const dxp = wp.x - b.cx;
  const dzp = wp.z - b.cz;
  const dx = cos * dxp - sin * dzp;
  const dz = sin * dxp + cos * dzp;
  return Math.abs(dx) <= b.w / 2 + 1e-9 && Math.abs(dz) <= b.h / 2 + 1e-9;
}
function getBgRotationHandleWorld(bg) {
  const b = getBgBounds(bg);
  if (!b) return null;
  const a = (bg.rotation || 0) * Math.PI / 180;
  const offset = Math.max(0.6, Math.min(b.w, b.h) * 0.14);
  const sin = Math.sin(a), cos = Math.cos(a);
  const R = b.h / 2 + offset;
  const hx = b.cx + sin * R;
  const hz = b.cz + cos * R;
  return { x: hx, z: hz, cx: b.cx, cz: b.cz, offset, R, b };
}
function hasForegroundHit(graph, wp, viewBox, baseVB) {
  if (!graph || !wp) return false;
  const { TH, TH_STAND } = getDynamicSelectThresholds(viewBox, baseVB);
  for (const st of (graph.stands || [])) {
    const n = graph.nodes[st.noseIdx];
    if (n && Math.hypot(wp.x - n.x, wp.z - n.z) <= TH_STAND) return true;
    const t = graph.nodes[st.tailIdx];
    if (t && Math.hypot(wp.x - t.x, wp.z - t.z) <= TH_STAND * 0.62) return true;
  }
  const runwayStripNames = new Set((graph.runways || []).map((r) => r.physicalName));
  for (const sg of (graph.segments || [])) {
    if (sg.name && runwayStripNames.has(sg.name)) continue;
    const pts = segNodeIdxs(sg).map((ni) => graph.nodes[ni]).filter(Boolean);
    if (pts.length >= 2 && distToPoly(wp.x, wp.z, pts) <= TH) return true;
  }
  for (const rw of (graph.runways || [])) {
    const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
    if (a && b && distToSeg(wp.x, wp.z, a.x, a.z, b.x, b.z) <= TH) return true;
  }
  for (const ar of (graph.areas || [])) {
    const pts = ar.points || [];
    if (pts.length < 3) continue;
    if (pointInPoly(wp.x, wp.z, pts)) return true;
    if (minEdgeDist(wp.x, wp.z, pts) <= TH) return true;
  }
  return false;
}

// ── Snap / angle helpers ─────────────────────────────────────────
const SNAP_DEG = Math.PI / 180;

// Vertex angle (degrees) at `anchor` between the incoming edge (prev→anchor) and
// the outgoing edge (anchor→tip). A straight continuation = 180°, perpendicular = 90°.
function vertexAngleDeg(prev, anchor, tip) {
  if (!prev || !anchor || !tip) return null;
  const a0 = Math.atan2(anchor.z - prev.z, anchor.x - prev.x);
  const a1 = Math.atan2(tip.z - anchor.z, tip.x - anchor.x);
  let d = (a1 - a0) / SNAP_DEG;
  d = ((d % 360) + 360) % 360;
  if (d > 180) d -= 360; // (−180,180]
  return 180 - Math.abs(d);
}

// Previous vertex of the current line chain: the node joined to `anchor` by the
// most recently committed segment (the "original straight line" while chaining).
function lastChainPrev(graph, anchor) {
  if (!graph || !anchor) return null;
  const nodes = graph.nodes || [];
  const segs = graph.segments || [];
  let nodeIdx = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n && Math.abs(n.x - anchor.x) < 1e-9 && Math.abs(n.z - anchor.z) < 1e-9) { nodeIdx = i; break; }
  }
  if (nodeIdx < 0) return null;
  for (let i = segs.length - 1; i >= 0; i--) {
    const sg = segs[i];
    const idxs = (sg.nodeIdxs && sg.nodeIdxs.length >= 2) ? sg.nodeIdxs : [sg.aIdx, sg.bIdx];
    if (idxs[0] === nodeIdx) { const o = nodes[idxs[1]]; if (o) return { x: o.x, z: o.z }; }
    if (idxs[idxs.length - 1] === nodeIdx) { const o = nodes[idxs[idxs.length - 2]]; if (o) return { x: o.x, z: o.z }; }
  }
  return null;
}

// The vertex before `anchor` in the current drawing step: from the in-progress
// path (area polygon) or the last committed chain edge (line tool).
function placePrev(committing, tool, graph) {
  if (!committing || !committing.length) return null;
  if (committing.length >= 2) return committing[committing.length - 2];
  if (tool === TOOL_LINE) return lastChainPrev(graph, committing[0]);
  return null;
}

// SVG polyline points for an arc of radius r, centered at (cx,cz) in world
// space, sweeping from ray a0 to a1 (degrees). Sweeps the shorter (≤180°) angle.
function snapArcPoints(cx, cz, a0, a1, r, n = 20) {
  let d = (a1 - a0) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (a0 + (d * i) / n) * SNAP_DEG;
    pts.push((cx + r * Math.cos(a)).toFixed(4) + ',' + svgY(cz + r * Math.sin(a)).toFixed(4));
  }
  return pts.join(' ');
}

/**
 * Snap indicator for placement tools: shows what the cursor is snapping to.
 * - angular guides (180°/90°/45°): dashed guide ray through the guide origin, +
 *   open ring at the snap point.
 * - endpoint / on-segment snap: bright green ring + dot at the target.
 * - area polygon close: green ring + filled preview (handled in main render).
 * - raw cursor (no snap): faint open circle.
 */
function SnapIndicator({ world, vb, dotR, sw }) {
  if (!world) return null;
  const x = world.x, z = world.z;
  const angular = world.type === SNAP_TYPES.EXTENSION_180 ||
    world.type === SNAP_TYPES.PERPENDICULAR_90 ||
    world.type === SNAP_TYPES.DIAGONAL_45;
  if (angular) {
    // Simple angle-snap preview: a clean ring at the rotated snap point; the
    // vertex angle itself is shown by the separate angle badge (no guide ray).
    return (
      <g>
        <circle cx={x} cy={svgY(z)} r={dotR * 1.25} fill="none" stroke="#ffd34d" strokeWidth={sw} opacity={0.95} />
        <circle cx={x} cy={svgY(z)} r={dotR * 0.6} fill="#0a1628" stroke="#ffd34d" strokeWidth={sw * 0.7} />
      </g>
    );
  }
  // area polygon closing snap — treat like endpoint but allow extra styling via world.isAreaClose
  if (world.isAreaClose || world.type === SNAP_TYPES.ENDPOINT || world.type === SNAP_TYPES.ON_SEGMENT) {
    return (
      <g>
        <circle cx={x} cy={svgY(z)} r={dotR * 1.4} fill="none" stroke="#3fdc6e" strokeWidth={sw} opacity={0.95} />
        <circle cx={x} cy={svgY(z)} r={dotR * 0.75} fill="#3fdc6e" />
        {world.isAreaClose && <circle cx={x} cy={svgY(z)} r={dotR * 2.0} fill="none" stroke="#3fdc6e" strokeWidth={sw * 0.7} opacity={0.55} />}
      </g>
    );
  }
  // raw cursor (no snap detected)
  return (
    <g>
      <circle cx={x} cy={svgY(z)} r={dotR * 0.7} fill="none" stroke="#8a94a6" strokeWidth={sw} />
    </g>
  );
}

export default function GroundPainter({ vals }) {
  const { t } = useTranslation();
  const graph = useAppStore((s) => s.groundPainterGraph);
  const meta = useAppStore((s) => s.groundPainterMeta);
  const tool = useAppStore((s) => s.groundPainterTool);
  const hasEdited = useAppStore((s) => s.groundPainterHasEdited);
  const snapshotText = useAppStore((s) => s.groundPainterSnapshotText);
  const currentPath = useAppStore((s) => s.currentPath);
  const setTool = useAppStore((s) => s.setGroundPainterTool);
  const close = useAppStore((s) => s.closeGroundPainter);
  const showModal = useAppStore((s) => s.showModal);
  const hideModal = useAppStore((s) => s.hideModal);
  // Whether a depth-1 undo (Ctrl+Z) is available — drives the undo button's enabled state.
  const canUndo = useAppStore((s) => !!s.groundPainterHistory);

  const svgRef = useRef(null);
  const saveCbRef = useRef(null); // .bak checkbox ref (matches Flight Editor modal)
  const dragRef = useRef(null);        // { sx, sy, vb, moved, button } during a pan drag
  const wasDragged = useRef(false);    // suppress the click that ends a drag
  const boxDragRef = useRef(null);     // box-select drag { startWorld, moved }
  const [viewBox, setViewBox] = useState(null);
  const [baseVB, setBaseVB] = useState(null); // bounds-derived viewBox (for zoom %/reset)
  const [committing, setCommitting] = useState(null); // in-progress shape (array of points)
  const [world, setWorld] = useState(null); // current snapped world pos (preview)
  const [selected, setSelected] = useState(null); // {kind:'segment'|'runway'|'area'|'stand', idx} | null
  const [multiSelected, setMultiSelected] = useState([]); // [{kind, idx}] for box-select (NOT AREA)
  const [boxRect, setBoxRect] = useState(null); // {x0,z0,x1,z1} world rect preview during box drag
  const [selectEnabled, setSelectEnabled] = useState(true); // Select tool toggle (off = pan-only)
  const [areaType, setAreaType] = useState(2);    // 0 boundary | 1 apron | 2 building (default building)
  const [heading, setHeading] = useState(360);    // stand heading 1..360 for NEXT stand (toolbar)
  const [gpError, setGpError] = useState(null);   // transient validation message
  const [filletRadius, setFilletRadius] = useState(2.00); // GU, for rounding tool (range 0.50~5.00)
  const [filletPicks, setFilletPicks] = useState([]); // [segIdxA, segIdxB?] for fillet tool
  const [hoverSegIdx, setHoverSegIdx] = useState(null); // hover for fillet picking
  const [bgImage, setBgImage] = useState(null); // imported background image state
  const [bgPanelOpen, setBgPanelOpen] = useState(false); // background-image control panel
  const headingPushRef = useRef(false); // true after pushHist for current slider drag

  // ── Stand heading helpers (HEAD=nose icon, TAIL=nose + offset*deg) ──
  // Tail is derived from nose + heading so the icon stays as HEAD.
  const normalizeHeading = useCallback((h) => {
    let n = Math.round(Number(h));
    if (!isFinite(n)) n = 360;
    n = ((n % 360) + 360) % 360;
    return n === 0 ? 360 : n;
  }, []);

  const updateStandHeading = useCallback((idx, newHeading) => {
    const g = useAppStore.getState().groundPainterGraph;
    if (!g || !g.stands[idx]) return;
    const st = g.stands[idx];
    const nose = g.nodes[st.noseIdx];
    if (!nose) return;
    const hdg = normalizeHeading(newHeading);
    // Push history once per drag session so Ctrl+Z reverts to pre-drag heading
    if (!headingPushRef.current) {
      headingPushRef.current = true;
      const s = useAppStore.getState();
      useAppStore.setState({ groundPainterHistory: s.groundPainterGraph });
    }
    // HEAD = nose, TAIL/ pushback placed from nose + heading (shared with rotate).
    const place = standHeadingPlacement(nose, hdg, st);
    const nodes = [...g.nodes];
    nodes[st.tailIdx] = { ...nodes[st.tailIdx], x: place.tail.x, z: place.tail.z };
    for (const pb of place.pushbacks) if (nodes[pb.idx]) nodes[pb.idx] = { ...nodes[pb.idx], x: pb.x, z: pb.z };
    const stands = [...g.stands];
    stands[idx] = { ...st, heading: hdg };
    useAppStore.setState({ groundPainterGraph: { ...g, nodes, stands }, groundPainterHasEdited: true });
  }, [normalizeHeading]);

  // ── Stand / taxiway name editing ──
  const updateStandName = useCallback((idx, newName) => {
    const g = useAppStore.getState().groundPainterGraph;
    if (!g || !g.stands[idx]) return;
    const stands = [...g.stands];
    stands[idx] = { ...stands[idx], name: String(newName ?? ''), nameEdited: true };
    const s = useAppStore.getState();
    useAppStore.setState({ groundPainterHistory: s.groundPainterGraph, groundPainterGraph: { ...g, stands }, groundPainterHasEdited: true });
  }, []);

  const updateSegmentName = useCallback((idx, newName) => {
    const g = useAppStore.getState().groundPainterGraph;
    if (!g || !g.segments[idx]) return;
    const segments = [...g.segments];
    segments[idx] = { ...segments[idx], name: String(newName ?? ''), nameEdited: true };
    const s = useAppStore.getState();
    useAppStore.setState({ groundPainterHistory: s.groundPainterGraph, groundPainterGraph: { ...g, segments }, groundPainterHasEdited: true });
  }, []);

  const handleStandHeadingSliderStart = useCallback(() => {
    headingPushRef.current = false;
  }, []);

  const handleStandHeadingSliderEnd = useCallback(() => {
    // allow next drag to create a fresh undo step
    headingPushRef.current = false;
  }, []);

  // Reset heading push flag when selection changes
  useEffect(() => {
    headingPushRef.current = false;
  }, [selected]);

  // ── Fillet helpers ──
  const findNearestSegmentIdx = useCallback((wp) => {
    if (!graph || !wp) return null;
    let best = null;
    let bestD = Infinity;
    const { TH } = getDynamicSelectThresholds(viewBox, baseVB);
    for (let i = 0; i < (graph.segments || []).length; i++) {
      const sg = graph.segments[i];
      const pts = segNodeIdxs(sg).map((ni) => graph.nodes[ni]).filter(Boolean);
      if (pts.length < 2) continue;
      const d = distToPoly(wp.x, wp.z, pts);
      if (d < bestD && d <= TH) { bestD = d; best = i; }
    }
    return best;
  }, [graph, viewBox, baseVB]);

  const resetFillet = useCallback(() => { setFilletPicks([]); setHoverSegIdx(null); setGpError(null); }, []);

  // Terminate the active tool's in-progress placement input and return it to an
  // INACTIVE (not currently placing) mode: discard a half-drawn straight-line /
  // runway / area draft (committing points), its live cursor preview (world),
  // and any fillet picks. Used both when switching tools and when re-selecting
  // the active tool button (which cancels the input mode).
  const cancelPlacementInput = useCallback(() => {
    resetFillet();
    setCommitting(null);
    setWorld(null);
    setBoxRect(null);
    boxDragRef.current = null;
  }, [resetFillet]);

  // Clear fillet picks when leaving the curve tool or when graph changes (new file)
  useEffect(() => {
    if (tool !== TOOL_CURVE) {
      if (filletPicks.length) setFilletPicks([]);
      if (hoverSegIdx != null) setHoverSegIdx(null);
    }
  }, [tool, filletPicks.length, hoverSegIdx]);

  // ── Tool exit: the previous tool fully quits and terminates its input ──
  // Whenever a DIFFERENT tool is selected, cancel any in-progress placement so
  // a straight-line / runway / area draft polyline + dots don't linger for the
  // next tool to inherit (or re-commit on a stray click). This fires on every
  // tool change, including programmatic switches (Escape, post-commit, select
  // toggle). Toolbar button clicks cancel synchronously in onTool too, so a
  // SAME-tool re-click (no store change here) also returns to the inactive
  // input mode.
  const lastToolRef = useRef(tool);
  useEffect(() => {
    if (lastToolRef.current !== tool) {
      lastToolRef.current = tool;
      cancelPlacementInput();
    }
  }, [tool, cancelPlacementInput]);

  const filletPreview = useMemo(() => {
    if (tool !== TOOL_CURVE) return null;
    if (!graph) return null;
    if (filletPicks.length === 1) {
      // preview for second pick is not yet fully determined, but we can show first pick highlight
      return { picks: filletPicks.slice() };
    }
    if (filletPicks.length >= 2) {
      const res = computeFillet(graph, filletPicks[0], filletPicks[1], filletRadius);
      if (!res.ok) return { error: res.error, picks: filletPicks.slice() };
      return { ...res, picks: filletPicks.slice() };
    }
    return null;
  }, [tool, graph, filletPicks, filletRadius]);

  // ── Length display for straight segments (taxiway / runway) ──
  // Draft length while placing a new straight line (commit preview)
  const draftLengthM = useMemo(() => {
    if (!committing || committing.length !== 1 || !world) return null;
    if (tool !== TOOL_LINE && tool !== TOOL_RUNWAY) return null;
    const a = committing[0];
    const b = world;
    if (!a || !b || !isFinite(a.x) || !isFinite(b.x)) return null;
    const gu = Math.hypot(b.x - a.x, b.z - a.z);
    if (gu < 1e-6) return 0;
    return Math.round(gu * DEFAULT_AIRPORT_SCALE);
  }, [committing, world, tool]);

  // Selected straight segment / runway length (live, updates while dragging)
  const selectedLengthM = useMemo(() => {
    if (!graph || !selected) return null;
    if (selected.kind === 'segment') return segmentLengthMeters(graph, selected.idx);
    if (selected.kind === 'runway') return runwayLengthMeters(graph, selected.idx);
    return null;
  }, [graph, selected]);

  // Midpoint for the canvas length label (draft takes priority over selection)
  const lengthLabel = useMemo(() => {
    if (draftLengthM != null && committing && committing[0] && world) {
      const a = committing[0], b = world;
      return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, meters: draftLengthM, kind: tool === TOOL_RUNWAY ? 'runway' : 'segment' };
    }
    if (selectedLengthM != null && graph && selected) {
      if (selected.kind === 'segment') {
        const sg = graph.segments[selected.idx];
        const idxs = sg ? segNodeIdxs(sg) : [];
        const pts = idxs.map((ni) => graph.nodes[ni]).filter(Boolean);
        if (pts.length >= 2) {
          // For straight line the midpoint of endpoints is sufficient; for
          // multi-vertex polylines use average of all points.
          let mx = 0, mz = 0;
          for (const p of pts) { mx += p.x; mz += p.z; }
          mx /= pts.length; mz /= pts.length;
          return { x: mx, z: mz, meters: selectedLengthM, kind: 'segment' };
        }
      } else if (selected.kind === 'runway') {
        const rw = graph.runways[selected.idx];
        const a = rw ? graph.nodes[rw.thAIdx] : null;
        const b = rw ? graph.nodes[rw.thBIdx] : null;
        if (a && b) return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, meters: selectedLengthM, kind: 'runway' };
      }
    }
    return null;
  }, [draftLengthM, committing, world, tool, selectedLengthM, graph, selected]);

  // Vertex-angle badge between the last drawn edge and the candidate edge being
  // placed (line / polygon). Shown while there is a previous edge. Also carries
  // the two ray angles so a snap can draw an arc between the edges at the vertex.
  const angleLabel = useMemo(() => {
    if (!committing || !committing.length || !world) return null;
    const anchor = committing[committing.length - 1];
    const prev = placePrev(committing, tool, graph);
    const a = vertexAngleDeg(prev, anchor, world);
    if (a == null || !prev) return null;
    const a0 = Math.atan2(prev.z - anchor.z, prev.x - anchor.x) / SNAP_DEG;
    const a1 = Math.atan2(world.z - anchor.z, world.x - anchor.x) / SNAP_DEG;
    return { x: (anchor.x + world.x) / 2, z: (anchor.z + world.z) / 2, angle: a, anchor, a0, a1 };
  }, [committing, world, tool, graph]);

  // ── Load on open: graph + meta built in the MAIN process ──
  useEffect(() => {
    (async () => {
      try {
        console.log('[GP] load begin currentPath=', currentPath);
        const res = await window.electronAPI.loadGroundPainterData(currentPath);
        console.log('[GP] load res keys=', res ? Object.keys(res) : null, 'textLen=', res && res.text ? res.text.length : null);
        if (!res || !res.graph) {
          console.error('[GP][ASSERT] empty graph on open', { currentPath });
          return;
        }
        const g = res.graph;
        console.log('[GP] loaded graph counts n=' + (g.nodes && g.nodes.length) + ' s=' + (g.segments && g.segments.length) + ' r=' + (g.runways && g.runways.length) + ' a=' + (g.areas && g.areas.length) + ' st=' + (g.stands && g.stands.length));
        console.log('[GP] loaded meta nodeOrigPk=' + (res.meta && res.meta.nodeOrigPk && res.meta.nodeOrigPk.length) + ' segOrigPk=' + (res.meta && res.meta.segOrigPk && res.meta.segOrigPk.length) + ' runwayOrigPk=' + (res.meta && res.meta.runwayOrigPk && res.meta.runwayOrigPk.length) + ' areaOrigId=' + (res.meta && res.meta.areaOrigId && res.meta.areaOrigId.length) + ' standOrigPk=' + (res.meta && res.meta.standOrigPk && res.meta.standOrigPk.length));
        useAppStore.setState({
          groundPainterGraph: res.graph,
          groundPainterMeta: res.meta,
          groundPainterSnapshotText: res.text,
          groundPainterHasEdited: false,
        });
        // A different level opened: reset the per-level viewport so the view is
        // re-fit to THIS level's bounds, and drop the previous level's background
        // image. Without this, baseVB/viewBox stay frozen on the first level and
        // every background-image import is fitted against stale bounds — so the
        // same zoom-slider % maps to a different on-screen size across loads.
        setBaseVB(null);
        setViewBox(null);
        setBgPanelOpen(false);
        setSelected(null);
        setMultiSelected([]);
        setBoxRect(null);
        boxDragRef.current = null;
        // Restore the persisted background image (if any) for THIS level so its
        // position & scale are reproduced exactly. The anchor is ALWAYS taken
        // from the deterministic per-airport ground anchor (cache.json), so a
        // previously-saved image keeps its size/offsets but its world position
        // never drifts with the (possibly-edited) graph bounds.
        {
          const cachedAnchor = vals && vals._groundAnchor;
          const savedBg = res.bg || null;
          if (savedBg && cachedAnchor && cachedAnchor.anchorX != null && cachedAnchor.anchorZ != null) {
            setBgImage({ ...savedBg, anchorX: cachedAnchor.anchorX, anchorZ: cachedAnchor.anchorZ });
          } else {
            setBgImage(savedBg);
          }
        }
      } catch (e) {
        console.error('[GP][ASSERT] open failed', e);
      }
    })();
  }, [currentPath, vals]);

  // ── viewBox from graph bounds + 10% pad (fit ONLY on first load) ──
  const bounds = useMemo(() => {
    if (!graph || !graph.nodes.length) return null;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const n of graph.nodes) {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.z < minZ) minZ = n.z; if (n.z > maxZ) maxZ = n.z;
    }
    return { minX, minZ, maxX, maxZ };
  }, [graph]);
  useEffect(() => {
    if (!bounds || baseVB) return; // fit once; keep the user's zoom/pan afterward
    const padX = (bounds.maxX - bounds.minX) * 0.1 || 5;
    const padZ = (bounds.maxZ - bounds.minZ) * 0.1 || 5;
    const vb = [bounds.minX - padX, svgY(bounds.maxZ + padZ), (bounds.maxX - bounds.minX + 2 * padX), (bounds.maxZ - bounds.minZ + 2 * padZ)];
    setViewBox(vb);
    setBaseVB(vb);
  }, [bounds, baseVB]);

  // ── Zoom (scrollwheel + UI buttons) ──
  const zoomAt = useCallback((sx, sy, f) => {
    setViewBox((vb) => {
      if (!vb) return vb;
      const [vx, vy, vw, vh] = vb;
      const nw = vw * f, nh = vh * f;
      return [sx - ((sx - vx) / vw) * nw, sy - ((sy - vy) / vh) * nh, nw, nh];
    });
  }, []);
  const onWheel = useCallback((evt) => {
    // React attaches onWheel passively → preventDefault() warns. The canvas is
    // fixed/overflow-hidden so the page won't scroll; just zoom.
    const svg = svgRef.current; if (!svg || !viewBox) return;
    const pt = svg.createSVGPoint ? svg.createSVGPoint() : { x: 0, y: 0 };
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null; if (!ctm) return;
    const s = pt.matrixTransform(ctm.inverse());
    zoomAt(s.x, s.y, evt.deltaY > 0 ? 1.1 : 0.9); // wheel down = zoom out
  }, [viewBox, zoomAt]);
  const zoomCenter = useCallback((f) => {
    setViewBox((vb) => {
      if (!vb) return vb;
      const [vx, vy, vw, vh] = vb;
      const cx = vx + vw / 2, cy = vy + vh / 2;
      return [cx - (vw * f) / 2, cy - (vh * f) / 2, vw * f, vh * f];
    });
  }, []);
  const resetZoom = useCallback(() => { if (baseVB) setViewBox(baseVB); }, [baseVB]);
  const zoomPercent = baseVB && viewBox ? Math.round(100 / (viewBox[2] / baseVB[2])) : 100;

  // ── Background image: import (file → data URL) + placement controls ──
  // The image is a map-anchored reference layer (rendered in world/SVG coords),
  // so it stays glued to the scenery while the user pans/zooms to trace over it.
  // placement: image center = anchor (map view center at import) shifted by
  // offset% of the current (scale-adjusted) image width/height.
  const updateBgImage = useCallback((patch) => {
    setBgImage((bg) => (bg ? { ...bg, ...patch } : bg));
  }, []);

  const handleImportImage = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const probe = new Image();
      probe.onload = () => {
        const naturalW = probe.naturalWidth || 1;
        const naturalH = probe.naturalHeight || 1;
        // Reference rectangle (world coords) — a DETERMINISTIC per-airport value
        // computed once during the ACL scan and persisted to cache.json. We use
        // `_groundAnchor` (cached bounds + center) when available, so both the
        // image's world SIZE and its POSITION are constant across loads and never
        // drift with the live (possibly-edited) graph bounds. Falls back to the
        // live graph bounds only if the cache has no anchor for this airport.
        const cached = vals && vals._groundAnchor;
        const srcBounds = cached || bounds;
        const hasSrc = !!srcBounds;
        const padX = hasSrc ? (srcBounds.maxX - srcBounds.minX) * 0.1 : 5;
        const padZ = hasSrc ? (srcBounds.maxZ - srcBounds.minZ) * 0.1 : 5;
        const refX = hasSrc ? srcBounds.minX - padX : 0;
        const refY = hasSrc ? svgY(srcBounds.maxZ + padZ) : -10;
        const fw = hasSrc ? (srcBounds.maxX - srcBounds.minX) + 2 * padX : 20;
        const fh = hasSrc ? (srcBounds.maxZ - srcBounds.minZ) + 2 * padZ : 20;
        const fitScale = Math.min(fw / naturalW, fh / naturalH);
        const baseW = Math.max(naturalW * fitScale, 1e-6);
        const baseH = Math.max(naturalH * fitScale, 1e-6);
        // Center of the reference rectangle → world coords (SVG y = -world z).
        // When the cached anchor exists, use its exact stored center so it never
        // drifts; otherwise (no cache) derive it from the reference rectangle.
        const useCachedCenter = cached && cached.anchorX != null && cached.anchorZ != null;
        const anchorX = useCachedCenter ? cached.anchorX : refX + fw / 2;
        const anchorZ = useCachedCenter ? cached.anchorZ : -(refY + fh / 2);
        setBgImage({ src: dataUrl, naturalW, naturalH, anchorX, anchorZ, baseW, baseH, scale: 1, offsetX: 0, offsetY: 0, rotation: 0, opacity: 0.6 });
        setBgPanelOpen(true); // keep the panel open so the user can tune placement
      };
      probe.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }, [bounds, vals]);

  const clearBgImage = useCallback(() => setBgImage(null), []);
  const resetBgImage = useCallback(() => setBgImage((bg) => (bg ? { ...bg, scale: 1, offsetX: 0, offsetY: 0, rotation: 0, opacity: 0.6 } : bg)), []);

  // Rendered scale (screen px per viewBox unit) so selection handles/dots stay a
  // constant ON-SCREEN size regardless of zoom.
  const pxScale = (() => {
    const el = svgRef.current;
    const vw = viewBox ? viewBox[2] : 1, vh = viewBox ? viewBox[3] : 1;
    const sw = el ? (el.clientWidth || 1) : 1, sh = el ? (el.clientHeight || 1) : 1;
    return Math.min(sw / vw, sh / vh) || 1;
  })();
  const DOT_R = 5 / pxScale;  // ~5px dot
  const HL_SW = 1.5 / pxScale; // ~1.5px highlight stroke

  // Clear the selection highlight when not on the Select tool — except keep
  // STAND selections visible while in the stand tool (so its floating slider
  // stays interactive and the plane remains selectable without switching back).
  // Box-select keeps its multi-selection while active.
  useEffect(() => {
    if (tool !== TOOL_SELECT && tool !== TOOL_BOX_SELECT) {
      // keep stand selection when tool is stand (its heading slider lives there)
      if (tool === TOOL_STAND && selected && selected.kind === 'stand') return;
      setSelected(null);
      if (multiSelected.length) setMultiSelected([]);
      if (boxRect) setBoxRect(null);
      boxDragRef.current = null;
    } else if (tool === TOOL_BOX_SELECT) {
      // entering box-select clears single selection to avoid double highlight
      if (selected) setSelected(null);
    } else if (tool === TOOL_SELECT) {
      // entering normal select clears box multi-selection
      if (multiSelected.length) setMultiSelected([]);
      if (boxRect) setBoxRect(null);
      boxDragRef.current = null;
    }
  }, [tool, selected, multiSelected.length, boxRect]);

  // Legacy migration: 'delete' was previously a tool mode — now it's an action button.
  useEffect(() => {
    if (tool === 'delete') setTool('select');
  }, [tool, setTool]);

  const snapGeom = useMemo(() => (graph ? collectSnapGeometry(graph) : { points: [], segments: [] }), [graph]);
  const taxiPaths = useMemo(() => (graph ? buildTaxiPaths(graph) : []), [graph]);

  // ── mouse → world + snap (snap is always on) ──
  const toWorld = useCallback((evt) => {
    const svg = svgRef.current; if (!svg) return null;
    const pt = svg.createSVGPoint ? svg.createSVGPoint() : { x: 0, y: 0 };
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null; if (!ctm) return null;
    const s = pt.matrixTransform(ctm.inverse());
    return { x: s.x, z: -s.y };
  }, []);

  const onMove = useCallback((evt) => {
    // Box-select rectangle drag has priority when active
    if (boxDragRef.current) {
      const rawBox = toWorld(evt);
      if (!rawBox) return;
      const dx = evt.clientX - boxDragRef.current.sx, dy = evt.clientY - boxDragRef.current.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) boxDragRef.current.moved = true;
      const sw = boxDragRef.current.startWorld;
      if (sw) setBoxRect({ x0: sw.x, z0: sw.z, x1: rawBox.x, z1: rawBox.z });
      return;
    }
    const d = dragRef.current;
    if (d) {
      const dx = evt.clientX - d.sx, dy = evt.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved) {
        if (d.mode === 'node' || d.mode === 'body' || d.mode === 'vertex' || d.mode === 'multiRotate') {
          if (!d.histPushed) { d.histPushed = true; pushHist(); } // one undo step per drag
          applyDrag(evt); // move / rotate selected geometry
        } else if (d.mode === 'bgImage' || d.mode === 'bgRotate') {
          applyDrag(evt); // draggable / rotatable background image
        } else if (d.mode === 'pan') {
          const svg = svgRef.current;
          const sx = svg ? d.vb[2] / (svg.clientWidth || 1) : 1;
          const sy = svg ? d.vb[3] / (svg.clientHeight || 1) : 1;
          setViewBox([d.vb[0] - dx * sx, d.vb[1] - dy * sy, d.vb[2], d.vb[3]]);
        }
      }
      return;
    }
    const raw = toWorld(evt); if (!raw || !snapGeom) return;
    // Fillet hover: highlight nearest segment
    if (tool === TOOL_CURVE) {
      const hit = findNearestSegmentIdx(raw);
      setHoverSegIdx(hit);
    }
    const snapDist = painterSnapDist(viewBox, baseVB);
    // Area polygon closing snap — check committing vertices before generic snap.
    // Eligible: indices 0 .. committing.length-3 (ensures ≥3 distinct points after close,
    // and excludes the immediate previous vertex which would give a degenerate edge).
    if (tool === 'area' && committing && committing.length >= 3) {
      let bestIdx = -1; let bestD = Infinity;
      const maxIdx = committing.length - 3;
      for (let i = 0; i <= maxIdx; i++) {
        const c = committing[i];
        const d2 = Math.hypot(raw.x - c.x, raw.z - c.z);
        if (d2 <= snapDist && d2 < bestD) { bestD = d2; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        const pt = committing[bestIdx];
        setWorld({ x: pt.x, z: pt.z, type: SNAP_TYPES.ENDPOINT, isAreaClose: true, closeIdx: bestIdx, distance: bestD, kind: 'endpoint' });
        return;
      }
    }
    // Stand should not snap at all — free placement
    if (tool === TOOL_STAND) {
      setWorld(raw);
      return;
    }
    const anchor = committing && committing.length ? committing[committing.length - 1] : null;
    const prev = placePrev(committing, tool, graph);
    let snapped = findSnap(raw, anchor, snapGeom, { snapDist, angleToleranceDeg: painterAngleTol(viewBox, baseVB), prev });
    // In area polygon mode, the immediately previous vertex is not snappable
    // (prevents 2-point degenerate close; enforces ≥3 points after truncation).
    if (snapped && tool === 'area' && prev && Math.hypot(snapped.x - prev.x, snapped.z - prev.z) < 1e-9) snapped = null;
    setWorld(snapped || raw);
  }, [toWorld, snapGeom, viewBox, baseVB, committing, applyDrag, tool, findNearestSegmentIdx, graph]);

  // Start a drag: middle button always pans; Select tool left-drag moves the
  // selected object's endpoint/body, otherwise pans. Non-select tools place.
  // Box-select (多选) has its own rectangle drag plus multi-body move.
  const onMouseDown = useCallback((evt) => {
    if (!viewBox) return;
    // Right-click → cancel/backtrack the active placement tool input and clear
    // all selection (single or box multi-select), returning to the tool's
    // initial just-entered state. Unlike Escape (which switches to the Select
    // tool), the active tool stays put for a fresh placement.
    if (evt.button === 2) {
      evt.preventDefault();
      // Taxiway / placement tools: clear or backtrack the active in-progress
      // input back to the initial just-entered state.
      if (tool === TOOL_LINE && committing) {
        // Drop the continuing line draft (fresh placement next).
        setCommitting(null);
        setWorld(null);
      } else if (tool === TOOL_CURVE && filletPicks.length > 0) {
        // One (or two) fillet segment(s) picked: reset the picks.
        resetFillet();
        setWorld(null);
      } else if (tool === 'area' && committing && committing.length > 0) {
        // Backtrack: each right-click pops the last placed vertex, down to 0.
        // Keep `world` so the cursor preview stays for continued drawing.
        setCommitting((c) => (c && c.length > 1 ? c.slice(0, -1) : null));
      }
      // Always clear any selection (single or box multi-select) too.
      if (selected || (multiSelected && multiSelected.length) || boxRect) {
        setSelected(null);
        if (multiSelected && multiSelected.length) setMultiSelected([]);
        if (boxRect) setBoxRect(null);
        boxDragRef.current = null;
      }
      dragRef.current = null;
      return;
    }
    const wp = toWorld(evt);
    if (evt.button === 1) { // middle → pan always
      evt.preventDefault();
      dragRef.current = { mode: 'pan', sx: evt.clientX, sy: evt.clientY, vb: viewBox.slice(), moved: false, button: 1 };
      return;
    }
    // ── Box-select mode ────────────────────────────────
    if (tool === TOOL_BOX_SELECT && evt.button === 0) {
      const shift = !!evt.shiftKey;
      // The group that can be body-moved: the box multi-selection if any, else the
      // single `selected` left by a plain click (so a single-clicked item is also
      // draggable). Shift NEVER body-moves — it always ADDS to the selection
      // (join) via click or box marquee, resolved on mouseup.
      const dragSet = multiSelected.length ? multiSelected : (selected ? [selected] : []);
      if (!shift && wp && dragSet.length) {
        // Rotation handle (↻ at the selection's top-center) — drag to rotate the
        // WHOLE group around the selection's bounding-box center. Checked first so
        // the gizmo wins over body-move/marquee when they overlap.
        const rotPlan = buildRotationPlan(graph, meta, dragSet);
        if (rotPlan) {
          const rotHandleR = Math.max(0.5, painterSnapDist(viewBox, baseVB) * 1.1);
          if (Math.hypot(wp.x - rotPlan.cx, wp.z - rotPlan.maxZ) <= rotHandleR * 1.9) {
            dragRef.current = {
              mode: 'multiRotate', sx: evt.clientX, sy: evt.clientY, moved: false, startWorld: wp,
              plan: rotPlan, startAngle: Math.atan2(wp.z - rotPlan.cz, wp.x - rotPlan.cx) * 180 / Math.PI,
            };
            return;
          }
        }
        // if click on any already-selected object → move the whole group
        let onMulti = pointOnMultiSelected(graph, dragSet, wp);
        // also allow grabbing an endpoint of a selected segment/runway
        let grabNode = null;
        let grabRunwayIdx = null;
        let grabRwPav = null;
        if (!onMulti) {
          const { TH: dynTH2 } = getDynamicSelectThresholds(viewBox, baseVB);
          for (const sel of dragSet) {
            if (sel.kind === 'segment') {
              const sg = graph.segments[sel.idx];
              for (const ni of segNodeIdxs(sg)) {
                const n = graph.nodes[ni];
                if (n && Math.hypot(wp.x - n.x, wp.z - n.z) <= dynTH2) { grabNode = ni; break; }
              }
            } else if (sel.kind === 'runway') {
              const rw = graph.runways[sel.idx];
              const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
              if (a && Math.hypot(wp.x - a.x, wp.z - a.z) <= dynTH2) { grabNode = rw.thAIdx; grabRunwayIdx = sel.idx; grabRwPav = runwayPavement(graph, meta, sel.idx); break; }
              if (b && Math.hypot(wp.x - b.x, wp.z - b.z) <= dynTH2) { grabNode = rw.thBIdx; grabRunwayIdx = sel.idx; grabRwPav = runwayPavement(graph, meta, sel.idx); break; }
            }
            if (grabNode != null) break;
          }
          if (grabNode != null) {
            dragRef.current = { mode: 'node', nodeIdx: grabNode, sx: evt.clientX, sy: evt.clientY, moved: false, startWorld: wp, runwayIdx: grabRunwayIdx, rwPav: grabRwPav, isMulti: true };
            return;
          }
        }
        if (onMulti) {
          // body drag for whole selection (group translate)
          const nodeSet = new Set();
          const multiRwPavs = [];
          const origAreas = [];
          for (const sel of dragSet) {
            if (sel.kind === 'segment') {
              for (const ni of segNodeIdxs(graph.segments[sel.idx])) if (graph.nodes[ni] != null) nodeSet.add(ni);
            } else if (sel.kind === 'runway') {
              const rw = graph.runways[sel.idx];
              if (graph.nodes[rw.thAIdx]) nodeSet.add(rw.thAIdx);
              if (graph.nodes[rw.thBIdx]) nodeSet.add(rw.thBIdx);
              const pav = runwayPavement(graph, meta, sel.idx);
              if (pav) {
                multiRwPavs.push(pav);
                for (const s of pav.stripNodes) nodeSet.add(s.ni);
              }
            } else if (sel.kind === 'stand') {
              const st = graph.stands[sel.idx];
              if (graph.nodes[st.noseIdx]) nodeSet.add(st.noseIdx);
              if (graph.nodes[st.tailIdx]) nodeSet.add(st.tailIdx);
              for (const pi of (st.pushbackIdxs || [])) if (graph.nodes[pi]) nodeSet.add(pi);
            } else if (sel.kind === 'area') {
              // Areas store their own points (not node indices); capture them so a
              // group drag moves the polygon with the lines/stands on top.
              const ar = graph.areas && graph.areas[sel.idx];
              if (ar && Array.isArray(ar.points)) origAreas.push({ idx: sel.idx, points: ar.points.map((p) => ({ x: p.x, z: p.z })) });
            }
          }
          const origNodes = [...nodeSet].map((ni) => ({ ni, x: graph.nodes[ni].x, z: graph.nodes[ni].z }));
          dragRef.current = { mode: 'body', kind: 'multi', sx: evt.clientX, sy: evt.clientY, moved: false, startWorld: wp, origNodes, multiSelected: [...dragSet], multiRwPavs, origAreas };
          return;
        }
      }
      // otherwise start a new box rectangle (marquee) — shift+click/drag resolved on mouseup
      if (wp) {
        boxDragRef.current = { sx: evt.clientX, sy: evt.clientY, startWorld: wp, moved: false };
        setBoxRect({ x0: wp.x, z0: wp.z, x1: wp.x, z1: wp.z });
        // suppress normal pan drag while boxing
        return;
      }
      dragRef.current = { mode: 'pan', sx: evt.clientX, sy: evt.clientY, vb: viewBox.slice(), moved: false };
      return;
    }
    // ── Background image selectable / draggable / rotatable (SELECT mode, lowest priority behind scenery) ──
    // Two-step UX: click selects bg (via onClick), second drag moves/rotates it. This avoids
    // stealing panning when the bg covers most of the view (fit-to-view default).
    // Only when bg is already selected does a drag inside its rect move it; foreground
    // on top still wins (clicking a taxiway overlapping the bg selects the taxiway).
    // Rotation handle has priority over body drag.
    if (selected && selected.kind === 'bgImage' && bgImage && wp && tool === TOOL_SELECT && selectEnabled) {
      const h = getBgRotationHandleWorld(bgImage);
      if (h) {
        const handleR = Math.max(0.35, painterSnapDist(viewBox, baseVB) * 0.95);
        if (Math.hypot(wp.x - h.x, wp.z - h.z) <= handleR * 1.9) {
          dragRef.current = { mode: 'bgRotate', sx: evt.clientX, sy: evt.clientY, moved: false, startWorld: wp, origBg: { ...bgImage } };
          return;
        }
      }
      if (pointInBgBounds(bgImage, wp) && !hasForegroundHit(graph, wp, viewBox, baseVB)) {
        dragRef.current = { mode: 'bgImage', sx: evt.clientX, sy: evt.clientY, moved: false, startWorld: wp, origBg: { ...bgImage } };
        return;
      }
    }
    const canDragSelected = (tool === TOOL_SELECT && selectEnabled) || (tool === TOOL_STAND && selected && selected.kind === 'stand');
    if (evt.button !== 0 || !canDragSelected) {
      // non-select tool (except stand's own stand), or select toggled off → left drag pans
      dragRef.current = { mode: 'pan', sx: evt.clientX, sy: evt.clientY, vb: viewBox.slice(), moved: false };
      return;
    }
    if (selected && wp) {
      const g = graph;
      const { TH: dynTH } = getDynamicSelectThresholds(viewBox, baseVB);
      const grabTH = dynTH; // node/vertex grab radius (dynamic, shrinks when zoomed in)
      const bodyTH = Math.max(0.22, dynTH * 1.10); // body drag threshold
      if (selected.kind === 'area') {
        const ar = g.areas && g.areas[selected.idx];
        const pts = (ar && ar.points) || [];
        for (let pi = 0; pi < pts.length; pi++) {
          if (Math.hypot(wp.x - pts[pi].x, wp.z - pts[pi].z) <= grabTH) {
            dragRef.current = { mode: 'vertex', idx: selected.idx, pointIdx: pi, sx: evt.clientX, sy: evt.clientY, moved: false, startWorld: wp };
            return;
          }
        }
      } else if (selected.kind === 'stand') {
        // Stands use HEAD/TAIL derived from heading — dragging a single endpoint would
        // break the frozen STAND_LENGTH. Only body drag (translate HEAD+TAIL together)
        // is allowed; heading is controlled by the floating 1..360 slider.
      } else {
        const pts = [];
        if (selected.kind === 'segment') { const sg = g.segments[selected.idx]; for (const ni of segNodeIdxs(sg)) if (g.nodes[ni]) pts.push(ni); }
        if (selected.kind === 'runway') { const rw = g.runways[selected.idx]; if (g.nodes[rw.thAIdx]) pts.push(rw.thAIdx); if (g.nodes[rw.thBIdx]) pts.push(rw.thBIdx); }
        for (const ni of pts) {
          const n = g.nodes[ni];
          if (Math.hypot(wp.x - n.x, wp.z - n.z) <= grabTH) {
            const dr = { mode: 'node', nodeIdx: ni, sx: evt.clientX, sy: evt.clientY, moved: false, startWorld: wp };
            if (selected.kind === 'runway') {
              dr.runwayIdx = selected.idx;
              dr.rwPav = runwayPavement(g, meta, selected.idx);
            }
            dragRef.current = dr;
            return;
          }
        }
      }
      // Dynamic body-hit test (replaces pointOnSelected with zoom-dependent thresholds)
      let onSelected = false;
      if (selected.kind === 'segment') {
        const sg = g.segments[selected.idx];
        const pts = segNodeIdxs(sg).map((ni) => g.nodes[ni]).filter(Boolean);
        if (pts.length >= 2) onSelected = distToPoly(wp.x, wp.z, pts) <= bodyTH;
      } else if (selected.kind === 'runway') {
        const rw = g.runways[selected.idx];
        const a = g.nodes[rw.thAIdx], b = g.nodes[rw.thBIdx];
        if (a && b) {
          const halfW = (rw.width || 0.50) / 2;
          onSelected = distToSeg(wp.x, wp.z, a.x, a.z, b.x, b.z) <= Math.max(bodyTH, halfW);
        }
      } else if (selected.kind === 'stand') {
        const st = g.stands[selected.idx];
        const nose = g.nodes[st.noseIdx];
        if (nose) onSelected = Math.hypot(wp.x - nose.x, wp.z - nose.z) <= bodyTH;
      } else if (selected.kind === 'area') {
        const ar = g.areas && g.areas[selected.idx];
        const pts = (ar && ar.points) || [];
        if (pts.length >= 3) {
          // area is occluded by a line/stand on top (dynamic check)
          let blocked = false;
          const lineTH = bodyTH;
          for (let i = 0; i < (g.segments || []).length && !blocked; i++) {
            const segPts = segNodeIdxs(g.segments[i]).map((ni) => g.nodes[ni]).filter(Boolean);
            if (segPts.length >= 2 && distToPoly(wp.x, wp.z, segPts) <= lineTH) blocked = true;
          }
          for (let i = 0; i < (g.runways || []).length && !blocked; i++) {
            const rw2 = g.runways[i];
            const a2 = g.nodes[rw2.thAIdx], b2 = g.nodes[rw2.thBIdx];
            if (a2 && b2 && distToSeg(wp.x, wp.z, a2.x, a2.z, b2.x, b2.z) <= lineTH) blocked = true;
          }
          for (let i = 0; i < (g.stands || []).length && !blocked; i++) {
            const st2 = g.stands[i];
            const nose2 = g.nodes[st2.noseIdx];
            if (nose2 && Math.hypot(wp.x - nose2.x, wp.z - nose2.z) <= lineTH) blocked = true;
          }
          if (!blocked) onSelected = pointInPoly(wp.x, wp.z, pts) || minEdgeDist(wp.x, wp.z, pts) <= bodyTH;
        }
      }
      if (!onSelected) {
        dragRef.current = { mode: 'pan', sx: evt.clientX, sy: evt.clientY, vb: viewBox.slice(), moved: false };
        return;
      }
      // not on a handle but on the selected object → move the whole object's body
      const nodePts = [];
      if (selected.kind === 'segment') { const sg = g.segments[selected.idx]; for (const ni of segNodeIdxs(sg)) if (g.nodes[ni]) nodePts.push(ni); }
      if (selected.kind === 'runway') { const rw = g.runways[selected.idx]; if (g.nodes[rw.thAIdx]) nodePts.push(rw.thAIdx); if (g.nodes[rw.thBIdx]) nodePts.push(rw.thBIdx); }
      if (selected.kind === 'stand') {
        const st = g.stands[selected.idx];
        if (g.nodes[st.noseIdx]) nodePts.push(st.noseIdx);
        if (g.nodes[st.tailIdx]) nodePts.push(st.tailIdx);
        for (const pi of (st.pushbackIdxs || [])) if (g.nodes[pi]) nodePts.push(pi);
      }
      dragRef.current = {
        mode: 'body', kind: selected.kind, idx: selected.idx, sx: evt.clientX, sy: evt.clientY, moved: false, startWorld: wp,
        origNodes: nodePts.map((ni) => ({ ni, x: g.nodes[ni].x, z: g.nodes[ni].z })),
        origPoints: selected.kind === 'area' ? (g.areas[selected.idx].points || []).map((p) => ({ x: p.x, z: p.z })) : null,
        rwPav: selected.kind === 'runway' ? runwayPavement(g, meta, selected.idx) : null,
      };
      return;
    }
    // no selection → empty-space pan
    dragRef.current = { mode: 'pan', sx: evt.clientX, sy: evt.clientY, vb: viewBox.slice(), moved: false };
  }, [viewBox, baseVB, tool, selected, multiSelected, boxRect, graph, meta, toWorld, selectEnabled, bgImage, committing, filletPicks, resetFillet]);

  // Pick the single object under a world point using the Select tool's priority
  // (stand > taxiway/runway > area, with area occlusion/edge weighting). Returns
  // {kind, idx} or null. Shared by the Select-tool click and the box-select
  // click so both select the same way.
  const pickForeground = useCallback((raw) => {
    const g = graph;
    if (!g || !raw) return null;
    const { TH, TH_STAND, tightStand } = getDynamicSelectThresholds(viewBox, baseVB);
    let bestStand = null;
    const considerStand = (idx, dist, th) => { if (dist <= th && (!bestStand || dist < bestStand.dist)) bestStand = { kind: 'stand', idx, dist }; };
    g.stands.forEach((st, i) => {
      const n = g.nodes[st.noseIdx]; if (n) considerStand(i, Math.hypot(raw.x - n.x, raw.z - n.z), TH_STAND);
      const t = g.nodes[st.tailIdx]; if (t) considerStand(i, Math.hypot(raw.x - t.x, raw.z - t.z), TH_STAND * 0.62);
    });
    let bestLine = null;
    const considerLine = (kind, idx, dist, th) => { if (dist <= th && (!bestLine || dist < bestLine.dist)) bestLine = { kind, idx, dist }; };
    const runwayStripNames = new Set((g.runways || []).map((r) => r.physicalName));
    g.segments.forEach((sg, i) => {
      if (sg.name && runwayStripNames.has(sg.name)) return;
      const pts = segNodeIdxs(sg).map((ni) => g.nodes[ni]).filter(Boolean);
      if (pts.length >= 2) considerLine('segment', i, distToPoly(raw.x, raw.z, pts), TH);
    });
    g.runways.forEach((rw, i) => {
      const a = g.nodes[rw.thAIdx], b = g.nodes[rw.thBIdx];
      if (a && b) considerLine('runway', i, distToSeg(raw.x, raw.z, a.x, a.z, b.x, b.z), TH);
    });
    const bestLinear = bestStand || bestLine;
    let bestArea = null;
    g.areas.forEach((ar, i) => {
      const pts = ar.points || [];
      const inside = pointInPoly(raw.x, raw.z, pts);
      const edge = minEdgeDist(raw.x, raw.z, pts);
      let cost;
      if (ar.areaType === 0) { if (edge > TH) return; cost = 100 + edge; }
      else if (ar.areaType === 2) { if (edge > TH && !inside) return; cost = inside ? 0 : edge; }
      else { if (edge > TH && !inside) return; cost = inside ? 1 : edge + 1; }
      if (!bestArea || cost < bestArea.cost) bestArea = { kind: 'area', idx: i, cost, inside, edge };
    });
    if (!bestLinear && !bestArea) return null;
    if (bestLinear && !bestArea) return bestLinear;
    if (!bestLinear && bestArea) return bestArea;
    // both exist — if area is interior and linear is a stand not tightly hit, prefer area
    const areaInside = bestArea.inside;
    if (areaInside && bestLinear.kind === 'stand' && bestLinear.dist > tightStand) return bestArea;
    return bestLinear;
  }, [graph, viewBox, baseVB]);

  // Resolve a box-select CLICK (no marquee drag) at a world point.
  // - Shift+click = join: add the clicked item to the multi-selection.
  // - Plain click = single-select (like the Select tool). Empty click deselects.
  const applyBoxClick = useCallback((wp, shift) => {
    if (!wp || !graph) return;
    if (shift) {
      const hit = pickForeground(wp);
      // click on empty under Shift keeps the existing selection (no-op)
      if (hit) setMultiSelected((prev) => (isMultiSelected(prev, hit.kind, hit.idx) ? prev : [...prev, hit]));
      return;
    }
    const hit = pickForeground(wp);
    // Plain click = single-select (like the Select tool). Empty click deselects.
    // Stored as a ONE-element multi-selection (not `selected`): the box-select tool
    // keeps everything in the multi-selection set, and the tool-change effect
    // would otherwise force a set `selected` back to null while in box mode.
    if (hit) { setMultiSelected([hit]); setSelected(null); }
    else { setSelected(null); setMultiSelected([]); }
  }, [graph, pickForeground]);

  const onMouseUp = useCallback((evt) => {
    // Finish box-select rectangle / click
    if (boxDragRef.current) {
      const b = boxDragRef.current;
      const moved = b.moved;
      const rect = boxRect;
      const shift = !!(evt && evt.shiftKey);
      boxDragRef.current = null;
      // allow onClick suppression if we actually dragged a box
      if (moved) wasDragged.current = true;
      if (moved && rect) {
        const minX = Math.min(rect.x0, rect.x1), maxX = Math.max(rect.x0, rect.x1);
        const minZ = Math.min(rect.z0, rect.z1), maxZ = Math.max(rect.z0, rect.z1);
        const w = maxX - minX, h = maxZ - minZ;
        // tiny drag (<0.04 GU) = treat as a click → single-select / join
        if (w < 0.04 && h < 0.04) {
          setBoxRect(null);
          if (b.startWorld) applyBoxClick(b.startWorld, shift);
        } else {
          const box = { minX, maxX, minZ, maxZ };
          const hits = computeBoxSelection(graph, box);
          if (shift) {
            // Shift+drag = join: union the marquee hits into the existing selection
            setMultiSelected((prev) => {
              const merged = [...prev];
              for (const hit of hits) if (!isMultiSelected(merged, hit.kind, hit.idx)) merged.push(hit);
              return merged;
            });
          } else {
            setMultiSelected(hits);
            setSelected(null);
          }
          setBoxRect(null);
        }
      } else {
        // No meaningful marquee (a plain mouseup) — treat as a click.
        setBoxRect(null);
        if (b.startWorld) applyBoxClick(b.startWorld, shift);
      }
      // keep dragRef cleared as well (in case a pan was started)
      dragRef.current = null;
      return;
    }
    if (dragRef.current && dragRef.current.moved) {
      // Only a LEFT-button drag is followed by a `click` event (which consumes
      // this flag). A middle-button pan produces no click of its own, so arming
      // wasDragged here would leak it onto the NEXT left click and swallow the
      // next point of a taxiway/area being drawn (requiring a second click to
      // "exit" the pan). Middle-button pan must not leave wasDragged set.
      if (dragRef.current.button !== 1) wasDragged.current = true;
    }
    dragRef.current = null;
  }, [boxRect, graph, applyBoxClick]);

  // Rotate a built plan (ORIGINAL positions) by `deg` degrees around the plan's
  // center. Always recomputes from the plan so a drag never accumulates drift.
  const applyMultiRotate = useCallback((plan, deg) => {
    const g = useAppStore.getState().groundPainterGraph;
    if (!g || !plan) return;
    const cx = plan.cx, cz = plan.cz;
    const nodes = [...g.nodes];
    for (const { ni, x, z } of plan.nodes) nodes[ni] = { ...nodes[ni], ...rotateWorldPoint(x, z, cx, cz, deg) };
    let areas = g.areas ? [...g.areas] : null;
    for (const ar of plan.areas) {
      if (areas && areas[ar.idx]) areas[ar.idx] = { ...areas[ar.idx], points: ar.points.map((p) => rotateWorldPoint(p.x, p.z, cx, cz, deg)) };
    }
    let stands = g.stands ? [...g.stands] : null;
    if (stands) {
      for (const stItem of plan.stands) {
        const st = stands[stItem.idx];
        if (!st) continue;
        const nose = nodes[st.noseIdx];
        if (!nose) continue;
        const hdg = normalizeHeading(stItem.heading - deg);
        stands[stItem.idx] = { ...st, heading: hdg };
        const place = standHeadingPlacement(nose, hdg, st);
        if (nodes[st.tailIdx]) nodes[st.tailIdx] = { ...nodes[st.tailIdx], x: place.tail.x, z: place.tail.z };
        for (const pb of place.pushbacks) if (nodes[pb.idx]) nodes[pb.idx] = { ...nodes[pb.idx], x: pb.x, z: pb.z };
      }
    }
    useAppStore.setState({ groundPainterGraph: { ...g, nodes, areas: areas || g.areas, stands: stands || g.stands }, groundPainterHasEdited: true });
  }, [normalizeHeading]);

  // Rotate the current (multi-)selection around its common center by `deg`.
  // Used by [ / ] keyboard shortcuts and the toolbar rotate buttons.
  const rotateSelection = useCallback((deg) => {
    const sels = (multiSelected && multiSelected.length) ? multiSelected : (selected ? [selected] : []);
    if (!sels.length) return;
    const st = useAppStore.getState();
    const plan = buildRotationPlan(st.groundPainterGraph, st.groundPainterMeta, sels);
    if (!plan) return;
    pushHist();
    applyMultiRotate(plan, deg);
  }, [multiSelected, selected, applyMultiRotate]);

  function applyDrag(evt) {
    const d = dragRef.current; if (!d || !d.startWorld) return;
    const raw = toWorld(evt); if (!raw) return;
    // Background image drag — direct offset update (no graph snap, no history)
    if (d.mode === 'bgImage') {
      const orig = d.origBg;
      if (!orig) return;
      const bgW = orig.baseW * orig.scale;
      const bgH = orig.baseH * orig.scale;
      if (!bgW || !bgH) return;
      const dx = raw.x - d.startWorld.x;
      const dz = raw.z - d.startWorld.z;
      const newCx = (orig.anchorX + (orig.offsetX / 100) * bgW) + dx;
      const newCz = (orig.anchorZ + (orig.offsetY / 100) * bgH) + dz;
      const newOffsetX = Math.max(-100, Math.min(100, ((newCx - orig.anchorX) / bgW) * 100));
      const newOffsetY = Math.max(-100, Math.min(100, ((newCz - orig.anchorZ) / bgH) * 100));
      setBgImage({ ...orig, offsetX: newOffsetX, offsetY: newOffsetY });
      return;
    }
    if (d.mode === 'bgRotate') {
      const orig = d.origBg;
      if (!orig) return;
      const b = getBgBounds(orig);
      if (!b) return;
      const dx = raw.x - b.cx;
      const dz = raw.z - b.cz;
      let ang = Math.atan2(dx, dz) * 180 / Math.PI;
      ang = normalizeBgRotation(ang);
      setBgImage({ ...orig, rotation: ang });
      return;
    }
    if (d.mode === 'multiRotate') {
      const plan = d.plan;
      if (!plan) return;
      const curAngle = Math.atan2(raw.z - plan.cz, raw.x - plan.cx) * 180 / Math.PI;
      const delta = curAngle - d.startAngle;
      applyMultiRotate(plan, delta);
      return;
    }
    const g = useAppStore.getState().groundPainterGraph;
    // Multi-selection body drag (box-select group) — free move, no snap to avoid jitter
    if (d.kind === 'multi') {
      const dx = raw.x - d.startWorld.x, dz = raw.z - d.startWorld.z;
      const nodes = [...g.nodes];
      for (const { ni, x, z } of d.origNodes) nodes[ni] = { ...nodes[ni], x: x + dx, z: z + dz };
      // Also translate any co-selected area polygons so the group moves as one.
      let areas = g.areas;
      if (d.origAreas && d.origAreas.length) {
        areas = [...g.areas];
        for (const oa of d.origAreas) {
          if (!areas[oa.idx]) continue;
          areas[oa.idx] = { ...areas[oa.idx], points: oa.points.map((p) => ({ x: p.x + dx, z: p.z + dz })) };
        }
      }
      useAppStore.setState({ groundPainterGraph: { ...g, nodes, areas }, groundPainterHasEdited: true });
      return;
    }
    // Stand should not snap at all — free drag to avoid icon jumping
    if (d.kind === 'stand') {
      const dx = raw.x - d.startWorld.x, dz = raw.z - d.startWorld.z;
      const nodes = [...g.nodes];
      for (const { ni, x, z } of d.origNodes) nodes[ni] = { ...nodes[ni], x: x + dx, z: z + dz };
      useAppStore.setState({ groundPainterGraph: { ...g, nodes }, groundPainterHasEdited: true });
      return;
    }
    const nw = findSnap(raw, null, snapGeom, { snapDist: painterSnapDist(viewBox, baseVB), angleToleranceDeg: painterAngleTol(viewBox, baseVB) }) || raw;

    if (d.mode === 'node') {
      // Degenerate-edge guard: within any polyline containing this node, no two
      // consecutive nodes may land on the same position — the writer encodes
      // vertices by coordinate, so co-located neighbours collapse into one
      // encoded vertex ("joins vertex X to itself") and the save-time integrity
      // check refuses the file. Freeze at the last valid position, like the
      // area-vertex guard. Scanning the whole polyline also catches a drag onto
      // a node two positions away (folding the polyline flat).
      for (const sg of g.segments) {
        const idxs = segNodeIdxs(sg);
        let hits = false;
        for (const ni of idxs) if (ni === d.nodeIdx) { hits = true; break; }
        if (!hits) continue;
        let prev = null;
        for (const ni of idxs) {
          const pos = ni === d.nodeIdx ? nw : g.nodes[ni];
          if (!pos) { prev = null; continue; }
          if (prev && Math.hypot(pos.x - prev.x, pos.z - prev.z) < 1e-4) return;
          prev = pos;
        }
      }
      const nodes = [...g.nodes];
      nodes[d.nodeIdx] = { ...nodes[d.nodeIdx], x: nw.x, z: nw.z };
      // If the dragged node is a runway threshold, re-project the runway's
      // collinear pavement strip chain so it follows the runway (its own nodes
      // are not shared with the runway).
      const rw = d.runwayIdx != null ? g.runways[d.runwayIdx] : null;
      if (rw && d.rwPav) {
        const a1 = { x: nodes[rw.thAIdx].x, z: nodes[rw.thAIdx].z };
        const b1 = { x: nodes[rw.thBIdx].x, z: nodes[rw.thBIdx].z };
        for (const s of d.rwPav.stripNodes) {
          if (s.ni === rw.thAIdx || s.ni === rw.thBIdx) continue; // threshold already moved
          const p = reprojectOnRunwayAxis(s, d.rwPav.a0, d.rwPav.b0, a1, b1);
          nodes[s.ni] = { ...nodes[s.ni], x: p.x, z: p.z };
        }
      }
      useAppStore.setState({ groundPainterGraph: { ...g, nodes }, groundPainterHasEdited: true });
    } else if (d.mode === 'vertex') {
      const areas = [...g.areas];
      if (!areas[d.idx] || !areas[d.idx].points) return;
      const points = [...areas[d.idx].points];
      points[d.pointIdx] = { x: nw.x, z: nw.z };
      // Triangulator guard: the game refuses to load an area whose outline
      // crosses itself. Freeze the vertex at its last valid position instead
      // of committing a bowtie; dragging back onto a valid spot re-enables it.
      if (!polygonIsSimple(points)) return;
      areas[d.idx] = { ...areas[d.idx], points };
      useAppStore.setState({ groundPainterGraph: { ...g, areas }, groundPainterHasEdited: true });
    } else if (d.mode === 'body') {
      const dx = nw.x - d.startWorld.x, dz = nw.z - d.startWorld.z;
      if (d.kind === 'area') {
        if (!g.areas[d.idx] || !g.areas[d.idx].points) return;
        const areas = [...g.areas];
        areas[d.idx] = { ...areas[d.idx], points: d.origPoints.map((p) => ({ x: p.x + dx, z: p.z + dz })) };
        useAppStore.setState({ groundPainterGraph: { ...g, areas }, groundPainterHasEdited: true });
      } else {
        const nodes = [...g.nodes];
        for (const { ni, x, z } of d.origNodes) nodes[ni] = { ...nodes[ni], x: x + dx, z: z + dz };
        // Whole-runway body drag: re-project its collinear pavement strip chain.
        if (d.kind === 'runway' && d.rwPav) {
          const rw = g.runways[d.idx];
          const a1 = { x: d.rwPav.a0.x + dx, z: d.rwPav.a0.z + dz };
          const b1 = { x: d.rwPav.b0.x + dx, z: d.rwPav.b0.z + dz };
          for (const s of d.rwPav.stripNodes) {
            if (rw && (s.ni === rw.thAIdx || s.ni === rw.thBIdx)) continue; // thresholds handled above
            const p = reprojectOnRunwayAxis(s, d.rwPav.a0, d.rwPav.b0, a1, b1);
            nodes[s.ni] = { ...nodes[s.ni], x: p.x, z: p.z };
          }
        }
        useAppStore.setState({ groundPainterGraph: { ...g, nodes }, groundPainterHasEdited: true });
      }
    }
  }

  const onClick = useCallback((evt) => {
    if (wasDragged.current) { wasDragged.current = false; return; }
    // Box-select handles selection via drag rectangle (onMouseUp), not click
    if (tool === TOOL_BOX_SELECT) return;
    const raw = toWorld(evt) || world;
    // Helper: find nearest stand within selectable radius (HEAD = nose icon)
    const findNearestStand = (g, wp) => {
      if (!g || !wp || !g.stands || g.stands.length === 0) return null;
      const { TH_STAND } = getDynamicSelectThresholds(viewBox, baseVB);
      let best = null;
      g.stands.forEach((st, i) => {
        const n = g.nodes[st.noseIdx];
        if (!n) return;
        const d = Math.hypot(wp.x - n.x, wp.z - n.z);
        if (d <= TH_STAND && (!best || d < best.dist)) best = { kind: 'stand', idx: i, dist: d };
        // tail hit with tighter radius so it doesn't block area as much
        const t = g.nodes[st.tailIdx];
        if (t) {
          const dt = Math.hypot(wp.x - t.x, wp.z - t.z);
          if (dt <= TH_STAND * 0.62 && (!best || dt < best.dist)) best = { kind: 'stand', idx: i, dist: dt };
        }
      });
      return best;
    };

    if (tool === TOOL_SELECT && selectEnabled) {
      if (!graph || !raw) return;
      // Pick the object under the cursor using the Select tool's priority rule
      // (shared with the box-select click so both select identically).
      const bestForeground = pickForeground(raw);
      if (bestForeground) { setSelected(bestForeground); return; }
      // No foreground hit — try background image (lowest priority, behind all scenery)
      if (bgImage && pointInBgBounds(bgImage, raw)) { setSelected({ kind: 'bgImage' }); return; }
      setSelected(null); return;
    }
    // Compute a FRESH snapped point at click time so a placed vertex snaps even
    // if `world` (last mousemove) never fired; close an area by RAW distance so a
    // nearby snap target can't hijack the "click first vertex to close" gesture.
    const anchor = committing && committing.length ? committing[committing.length - 1] : null;
    const prev = placePrev(committing, tool, graph);
    let p = findSnap(raw, anchor, snapGeom, { snapDist: painterSnapDist(viewBox, baseVB), angleToleranceDeg: painterAngleTol(viewBox, baseVB), prev }) || raw;
    // Area polygon: previous vertex is not snappable (ensures ≥3-point close)
    if (tool === 'area' && prev && p && Math.hypot(p.x - prev.x, p.z - prev.z) < 1e-9) p = raw;
    if (!p) return;
    if (tool === TOOL_LINE) {
      setCommitting((c) => {
        const clean = { x: p.x, z: p.z };
        const next = c ? [...c, clean] : [clean];
        if (next.length === 2) {
          if (Math.hypot(next[0].x - next[1].x, next[0].z - next[1].z) < 1e-6) { setGpError(t('ground_painter_error_distinct_endpoints') || 'Segment needs distinct endpoints'); return [clean]; }
          const st = useAppStore.getState();
          const gg = st.groundPainterGraph;
          const mm = st.groundPainterMeta;
          let nodes = [...gg.nodes];
          let segs = [...gg.segments];
          let newMeta = structuredClone(mm);
          if (!Array.isArray(newMeta.deletedPks)) newMeta.deletedPks = newMeta.deletedPks ? [...newMeta.deletedPks] : [];
          if (!Array.isArray(newMeta.nodeOrigPk)) newMeta.nodeOrigPk = [...gg.nodes].map(() => null);
          if (!Array.isArray(newMeta.segOrigPk)) newMeta.segOrigPk = [...gg.segments].map(() => null);
          const coordKeyLocal = (x, z) => (+x).toFixed(6) + ',' + (+z).toFixed(6);
          const getOrCreate = (pt) => {
            const existing = findNodeIndexByCoord({ nodes }, pt.x, pt.z);
            if (existing >= 0) return existing;
            const idx = nodes.length;
            nodes.push({ x: pt.x, z: pt.z, type: 2, flags: 0 });
            newMeta.nodeOrigPk.push(null);
            return idx;
          };
          // ── Auto-slice: T-junction ──────────────────────────────────
          // When an endpoint of the new segment lands on the interior of an
          // existing taxiway (on-segment snap), split that existing segment
          // into two, removing the original. This makes a "-------- + |"
          // connection become three segments sharing a junction node.
          const EPS_T = 1e-6;
          const splitMap = new Map(); // segIdx -> Array<{pt, edgeIdx, t}>
          for (const pt of next) {
            const existingIdxOrig = findNodeIndexByCoord(gg, pt.x, pt.z);
            if (existingIdxOrig >= 0) continue; // endpoint snap -> no split
            for (let segIdx = 0; segIdx < gg.segments.length; segIdx++) {
              const seg = gg.segments[segIdx];
              const idxs = seg.nodeIdxs && seg.nodeIdxs.length ? seg.nodeIdxs : [seg.aIdx, seg.bIdx];
              let foundEdge = null;
              let foundT = null;
              for (let ei = 0; ei < idxs.length - 1; ei++) {
                const a = gg.nodes[idxs[ei]];
                const b = gg.nodes[idxs[ei + 1]];
                if (!a || !b) continue;
                const dx = b.x - a.x, dz = b.z - a.z;
                const len2 = dx * dx + dz * dz;
                if (len2 < 1e-12) continue;
                let t = ((pt.x - a.x) * dx + (pt.z - a.z) * dz) / len2;
                if (t <= EPS_T || t >= 1 - EPS_T) continue;
                const projX = a.x + t * dx, projZ = a.z + t * dz;
                const d = Math.hypot(pt.x - projX, pt.z - projZ);
                if (d > 1e-6) continue;
                foundEdge = ei;
                foundT = t;
                break;
              }
              if (foundEdge !== null) {
                if (!splitMap.has(segIdx)) splitMap.set(segIdx, []);
                const arr = splitMap.get(segIdx);
                if (!arr.some((e) => Math.hypot(e.pt.x - pt.x, e.pt.z - pt.z) < 1e-6)) {
                  arr.push({ pt, edgeIdx: foundEdge, t: foundT });
                }
              }
            }
          }
          // Ensure junction nodes exist for each distinct split pt
          const uniqPtMap = new Map();
          for (const arr of splitMap.values()) {
            for (const { pt } of arr) {
              const k = coordKeyLocal(pt.x, pt.z);
              if (!uniqPtMap.has(k)) uniqPtMap.set(k, pt);
            }
          }
          const ptKeyToJuncIdx = new Map();
          for (const [k, pt] of uniqPtMap) {
            const juncIdx = getOrCreate(pt);
            ptKeyToJuncIdx.set(k, juncIdx);
          }
          // Ensure endpoints of the new segment have nodes (reuse junc if interior)
          const na = getOrCreate(next[0]);
          const nb = getOrCreate(next[1]);
          if (na === nb) { setGpError(t('ground_painter_error_distinct_endpoints') || 'Segment needs distinct endpoints'); return [clean]; }
          // Replace each split segment with its pieces (in descending index order)
          const segIdxsToSplit = [...splitMap.keys()].sort((a, b) => b - a);
          for (const segIdx of segIdxsToSplit) {
            const seg = gg.segments[segIdx];
            const arr = splitMap.get(segIdx);
            arr.sort((u, v) => (u.edgeIdx - v.edgeIdx) || (u.t - v.t));
            const idxs = seg.nodeIdxs && seg.nodeIdxs.length ? seg.nodeIdxs : [seg.aIdx, seg.bIdx];
            // Build expanded polyline with junction nodes inserted
            const expanded = [idxs[0]];
            for (let ei = 0; ei < idxs.length - 1; ei++) {
              const edgePts = arr.filter((e) => e.edgeIdx === ei).sort((x, y) => x.t - y.t);
              for (const e of edgePts) {
                const k = coordKeyLocal(e.pt.x, e.pt.z);
                const juncIdx = ptKeyToJuncIdx.get(k);
                expanded.push(juncIdx);
              }
              expanded.push(idxs[ei + 1]);
            }
            const segJuncIdxSet = new Set(arr.map((e) => ptKeyToJuncIdx.get(coordKeyLocal(e.pt.x, e.pt.z))));
            const posList = [];
            for (let p = 0; p < expanded.length; p++) if (segJuncIdxSet.has(expanded[p])) posList.push(p);
            const pieces = [];
            let prevPos = 0;
            for (const pos of posList) {
              const piece = expanded.slice(prevPos, pos + 1);
              if (piece.length >= 2) pieces.push(piece);
              prevPos = pos;
            }
            if (prevPos < expanded.length - 1) {
              const tail = expanded.slice(prevPos, expanded.length);
              if (tail.length >= 2) pieces.push(tail);
            }
            // Remove original segment (mark deleted)
            const oldPk = newMeta.segOrigPk[segIdx];
            if (oldPk != null && !newMeta.deletedPks.includes(oldPk)) newMeta.deletedPks.push(oldPk);
            segs.splice(segIdx, 1);
            newMeta.segOrigPk.splice(segIdx, 1);
            // Insert pieces as new segments
            for (const piece of pieces) {
              segs.push({ aIdx: piece[0], bIdx: piece[piece.length - 1], nodeIdxs: piece, flags: seg.flags ?? 2, directed: seg.directed ?? false, name: seg.name });
              newMeta.segOrigPk.push(null);
            }
          }
          segs.push({ aIdx: na, bIdx: nb, nodeIdxs: [na, nb], flags: 2, directed: false });
          newMeta.segOrigPk.push(null);
          const newGraph = { ...gg, nodes, segments: segs };
          useAppStore.setState({ groundPainterHistory: structuredClone(gg), groundPainterMetaHistory: structuredClone(mm), groundPainterGraph: newGraph, groundPainterMeta: newMeta, groundPainterHasEdited: true });
          // Continue drawing: next taxiway starts at the end of the previous one
          return [clean];
        }
        return next;
      });
    } else if (tool === TOOL_CURVE) {
      // Fillet/rounding: pick two straight segments sharing a degree-2 node
      const segIdx = findNearestSegmentIdx(raw);
      if (segIdx == null) { setGpError(t('ground_painter_fillet_error_click_near') || 'Click near a straight taxiway segment'); return; }
      const sg = graph.segments[segIdx];
      if (!isStraightSegment(sg)) { setGpError(t('ground_painter_fillet_error_straight') || 'Only straight segments can be filleted'); return; }
      // if already picked first, handle second pick
      if (filletPicks.length === 0) {
        setFilletPicks([segIdx]);
        setGpError(null);
      } else if (filletPicks.length === 1) {
        if (filletPicks[0] === segIdx) {
          // deselect / reset
          setFilletPicks([]);
          setGpError(null);
          return;
        }
        // validate pair - show preview, don't auto-commit; slider will appear
        const probe = computeFillet(graph, filletPicks[0], segIdx, filletRadius);
        if (!probe.ok) {
          setFilletPicks([filletPicks[0], segIdx]);
          const msg = probe.errorParams ? t(probe.error, probe.errorParams) : t(probe.error);
          setGpError(msg);
          return;
        }
        setFilletPicks([filletPicks[0], segIdx]);
        setGpError(null);
      } else {
        // already 2 picks, reset and start new
        setFilletPicks([segIdx]);
        setGpError(null);
      }
    } else if (tool === TOOL_RUNWAY) {
      setCommitting((c) => {
        const clean = { x: p.x, z: p.z };
        const next = c ? [...c, clean] : [clean];
        if (next.length >= 2) { commitRunway(next); setTool('select'); return null; }
        return next;
      });
    } else if (tool === TOOL_STAND) {
      // Stand should not snap at all — use raw cursor position
      const g = useAppStore.getState().groundPainterGraph;
      const hit = findNearestStand(g, raw);
      if (hit) {
        setSelected(hit);
        // keep the painter in stand tool so the toolbar heading stays visible,
        // but also let the floating slider control the selected stand
        return;
      }
      const st = useAppStore.getState();
      const gg = st.groundPainterGraph;
      const hdgNorm = normalizeHeading(heading);
      const nose = { x: raw.x, z: raw.z };
      const hRad = (hdgNorm * Math.PI) / 180;
      const tail = { x: nose.x - Math.cos(hRad) * STAND_LENGTH, z: nose.z + Math.sin(hRad) * STAND_LENGTH };
      const nn = gg.nodes.length, nt = gg.nodes.length + 1;
      commitGraph({ ...gg, nodes: [...gg.nodes, nose, tail], stands: [...gg.stands, { noseIdx: nn, tailIdx: nt, heading: hdgNorm, pushbackIdxs: [], name: '' }] });
      // auto-select the newly placed stand so its heading slider appears right next to the plane
      setSelected({ kind: 'stand', idx: gg.stands.length });
    } else if (tool === 'area') {
      setGpError(null);
      const pts = committing || [];
      if (pts.length === 0) { setCommitting([{ x: p.x, z: p.z }]); return; }
      // Closing snap: check distance to any eligible committing vertex (excludes
      // the immediate previous vertex to ensure ≥3 distinct points remain).
      const closeSnapDist = painterSnapDist(viewBox, baseVB);
      let closeIdx = -1; let bestD = Infinity;
      const maxCloseIdx = pts.length - 3;
      for (let i = 0; i <= maxCloseIdx; i++) {
        const d = Math.hypot(raw.x - pts[i].x, raw.z - pts[i].z);
        if (d <= closeSnapDist && d < bestD) { bestD = d; closeIdx = i; }
      }
      if (closeIdx >= 0) {
        const truncated = pts.slice(closeIdx);
        if (truncated.length >= 3) { commitArea(truncated); }
        else { setGpError(t('ground_painter_error_area_min_vertices') || 'Area needs at least 3 vertices'); }
        return;
      }
      setCommitting([...pts, { x: p.x, z: p.z }]);
    }
  }, [world, tool, setTool, graph, committing, commitArea, commitRunway, snapGeom, viewBox, baseVB, heading, selectEnabled, filletPicks, filletRadius, findNearestSegmentIdx, t, bgImage, pickForeground]);

  // Delete key removes the selected object. Deleting MUST also record the
  // removed object's original PK/id in meta.deletedPks / meta.deletedAreaIds and
  // splice the parallel meta arrays — otherwise patchSceneryBlob (the write-back)
  // has no record that the entry was removed and keeps it verbatim in the .acl,
  // so the deletion silently does not persist.
  const deleteSelected = useCallback(() => {
    const hasMulti = multiSelected && multiSelected.length > 0;
    if (!selected && !hasMulti) return;
    const st = useAppStore.getState();
    const g = st.groundPainterGraph;
    const m = st.groundPainterMeta;
    const gg = { ...g, nodes: [...g.nodes], segments: [...g.segments], runways: [...g.runways], areas: [...g.areas], stands: [...g.stands] };
    // Clone meta parallel arrays (defensive: meta may be null in a fresh/empty state).
    const mm = m ? {
      ...m,
      nodeOrigPk: m.nodeOrigPk ? [...m.nodeOrigPk] : m.nodeOrigPk,
      segOrigPk: m.segOrigPk ? [...m.segOrigPk] : m.segOrigPk,
      runwayOrigPk: m.runwayOrigPk ? [...m.runwayOrigPk] : m.runwayOrigPk,
      runwayPavement: m.runwayPavement ? [...m.runwayPavement] : m.runwayPavement,
      runwayOrigInfo: m.runwayOrigInfo ? [...m.runwayOrigInfo] : m.runwayOrigInfo,
      areaOrigId: m.areaOrigId ? [...m.areaOrigId] : m.areaOrigId,
      standOrigPk: m.standOrigPk ? [...m.standOrigPk] : m.standOrigPk,
      deletedPks: m.deletedPks ? [...m.deletedPks] : [],
      deletedAreaIds: m.deletedAreaIds ? [...m.deletedAreaIds] : [],
    } : m;
    const markDeletedPk = (pk) => { if (pk != null && mm && !mm.deletedPks.includes(pk)) mm.deletedPks.push(pk); };
    const doOrphanGC = (uniqueDelNodes) => {
      const orphans = [];
      for (const ni of uniqueDelNodes) {
        if (ni == null || ni < 0) continue;
        let used = false;
        for (const sg of gg.segments) {
          const idxs = sg.nodeIdxs && sg.nodeIdxs.length ? sg.nodeIdxs : [sg.aIdx, sg.bIdx];
          if (idxs.includes(ni)) { used = true; break; }
        }
        if (used) continue;
        for (const rw of gg.runways) {
          if (rw.thAIdx === ni || rw.thBIdx === ni) { used = true; break; }
        }
        if (used) continue;
        for (const st of gg.stands) {
          if (st.noseIdx === ni || st.tailIdx === ni) { used = true; break; }
          if (st.pushbackIdxs && st.pushbackIdxs.includes(ni)) { used = true; break; }
        }
        if (!used) orphans.push(ni);
      }
      orphans.sort((a, b) => b - a);
      for (const delIdx of orphans) {
        if (mm && mm.nodeOrigPk && delIdx < mm.nodeOrigPk.length) {
          const pk = mm.nodeOrigPk[delIdx];
          if (pk != null) markDeletedPk(pk);
        }
        gg.nodes.splice(delIdx, 1);
        if (mm && mm.nodeOrigPk) mm.nodeOrigPk.splice(delIdx, 1);
        for (const sg of gg.segments) {
          if (sg.nodeIdxs) {
            for (let i = 0; i < sg.nodeIdxs.length; i++) if (sg.nodeIdxs[i] > delIdx) sg.nodeIdxs[i]--;
            if (sg.aIdx != null && sg.aIdx > delIdx) sg.aIdx--;
            if (sg.bIdx != null && sg.bIdx > delIdx) sg.bIdx--;
          } else {
            if (sg.aIdx != null && sg.aIdx > delIdx) sg.aIdx--;
            if (sg.bIdx != null && sg.bIdx > delIdx) sg.bIdx--;
          }
        }
        for (const rw of gg.runways) {
          if (rw.thAIdx > delIdx) rw.thAIdx--;
          if (rw.thBIdx > delIdx) rw.thBIdx--;
        }
        for (const st of gg.stands) {
          if (st.noseIdx > delIdx) st.noseIdx--;
          if (st.tailIdx > delIdx) st.tailIdx--;
          if (st.pushbackIdxs) {
            for (let i = 0; i < st.pushbackIdxs.length; i++) if (st.pushbackIdxs[i] > delIdx) st.pushbackIdxs[i]--;
          }
        }
        if (mm && mm.runwayPavement) {
          for (const arr of mm.runwayPavement) {
            for (let i = 0; i < arr.length; i++) if (arr[i] > delIdx) arr[i]--;
          }
        }
      }
    };
    // Runway cascade: a runway IS its pavement strips + threshold nodes. Remove
    // the strip segments named after the physical runway alongside the runway
    // entry, otherwise they survive as paint with dangling thresholds (and the
    // game still triangulates them). Freed end designators are recorded in meta
    // so the ground save can purge flights whose Runway no longer resolves.
    const cascadeDeleteRunway = (idx, gcSink) => {
      const rw = gg.runways[idx];
      const phys = rw ? String(rw.physicalName || '') : '';
      const endNames = rw && Array.isArray(rw.names) ? rw.names.map((n) => String(n || '').trim()).filter(Boolean) : [];
      if (mm && mm.runwayOrigPk) { markDeletedPk(mm.runwayOrigPk[idx]); mm.runwayOrigPk.splice(idx, 1); }
      if (mm && mm.runwayOrigInfo) {
        const info = mm.runwayOrigInfo[idx];
        if (info && Array.isArray(info.pks)) for (const pk of info.pks) markDeletedPk(pk);
        mm.runwayOrigInfo.splice(idx, 1);
      }
      if (mm && mm.runwayPavement) mm.runwayPavement.splice(idx, 1);
      gg.runways.splice(idx, 1);
      const gcNodes = Array.isArray(gcSink) ? gcSink : [];
      if (rw) { if (rw.thAIdx != null) gcNodes.push(rw.thAIdx); if (rw.thBIdx != null) gcNodes.push(rw.thBIdx); }
      if (phys) {
        for (let si = gg.segments.length - 1; si >= 0; si--) {
          const sg = gg.segments[si];
          if (sg.name !== phys) continue;
          if (mm && mm.segOrigPk) { markDeletedPk(mm.segOrigPk[si]); mm.segOrigPk.splice(si, 1); }
          for (const ni of segNodeIdxs(sg)) if (ni != null) gcNodes.push(ni);
          gg.segments.splice(si, 1);
        }
      }
      if (!gcSink && gcNodes.length) doOrphanGC(gcNodes);
      if (mm) {
        if (!Array.isArray(mm.deletedRunwayNames)) mm.deletedRunwayNames = [];
        for (const nm of [phys, ...endNames]) {
          if (nm && !mm.deletedRunwayNames.includes(nm)) mm.deletedRunwayNames.push(nm);
        }
      }
    };
    // Record a deleted stand's id(s) so the ground save can purge flights parked
    // at it (game "has no flight plan reference"-class failures).
    const recordDeletedStand = (st) => {
      if (!st || !mm) return;
      if (!Array.isArray(mm.deletedStandNames)) mm.deletedStandNames = [];
      for (const nm of [st.identifier, st.name]) {
        const v = String(nm || '').trim();
        if (v && !mm.deletedStandNames.includes(v)) mm.deletedStandNames.push(v);
      }
    };
    if (hasMulti) {
      // ── Box-select multi delete (NOT AREA) ─────────────────
      const segIdxs = multiSelected.filter((s) => s.kind === 'segment').map((s) => s.idx).sort((a, b) => b - a);
      const rwIdxs = multiSelected.filter((s) => s.kind === 'runway').map((s) => s.idx).sort((a, b) => b - a);
      const standIdxs = multiSelected.filter((s) => s.kind === 'stand').map((s) => s.idx).sort((a, b) => b - a);
      const areaIdxs = multiSelected.filter((s) => s.kind === 'area').map((s) => s.idx).sort((a, b) => b - a);
      // collect all del nodes from segments before splicing
      const allDelNodes = new Set();
      for (const idx of segIdxs) {
        const sg = g.segments[idx] ?? gg.segments[idx];
        const idxs = segNodeIdxs(sg);
        for (const ni of idxs) if (ni != null) allDelNodes.add(ni);
      }
      for (const idx of segIdxs) {
        if (mm && mm.segOrigPk) { markDeletedPk(mm.segOrigPk[idx]); mm.segOrigPk.splice(idx, 1); }
        gg.segments.splice(idx, 1);
      }
      for (const idx of rwIdxs) {
        // The cascade removes the runway's strips and immediately GCs their
        // nodes. Nodes shared with objects deleted later in this same multi
        // (e.g. a stand pushback node on a strip endpoint) survive that GC —
        // the stands branch below feeds them to the final doOrphanGC.
        cascadeDeleteRunway(idx, null);
      }
      for (const idx of standIdxs) {
        if (mm && mm.standOrigPk) { markDeletedPk(mm.standOrigPk[idx]); mm.standOrigPk.splice(idx, 1); }
        const st = gg.stands[idx];
        if (st) {
          for (const ni of [st.noseIdx, st.tailIdx, ...(st.pushbackIdxs || [])]) if (ni != null) allDelNodes.add(ni);
        }
        gg.stands.splice(idx, 1);
        recordDeletedStand(st);
      }
      for (const idx of areaIdxs) {
        if (mm && mm.areaOrigId) {
          const id = mm.areaOrigId[idx];
          if (id != null && !mm.deletedAreaIds.includes(id)) mm.deletedAreaIds.push(id);
          mm.areaOrigId.splice(idx, 1);
        }
        gg.areas.splice(idx, 1);
      }
      // Not all Del nodes are used by deleted segments/stands (some may be shared
      // with survivors); the survivors re-indexed below account for that via doOrphanGC.
      if (allDelNodes.size) doOrphanGC([...allDelNodes]);
    } else if (selected.kind === 'segment') {
      // Capture the nodes of the segment being deleted before removing it.
      const delSeg = gg.segments[selected.idx] ?? g.segments[selected.idx];
      const delNodeIdxs = delSeg ? segNodeIdxs(delSeg) : [];
      const uniqueDelNodes = [...new Set(delNodeIdxs.filter((v) => v != null))];
      if (mm && mm.segOrigPk) { markDeletedPk(mm.segOrigPk[selected.idx]); mm.segOrigPk.splice(selected.idx, 1); }
      gg.segments.splice(selected.idx, 1);
      doOrphanGC(uniqueDelNodes);
    } else if (selected.kind === 'runway') {
      cascadeDeleteRunway(selected.idx, null);
    } else if (selected.kind === 'area') {
      if (mm && mm.areaOrigId) {
        const id = mm.areaOrigId[selected.idx];
        if (id != null && !mm.deletedAreaIds.includes(id)) mm.deletedAreaIds.push(id);
        mm.areaOrigId.splice(selected.idx, 1);
      }
      gg.areas.splice(selected.idx, 1);
    } else if (selected.kind === 'stand') {
      if (mm && mm.standOrigPk) { markDeletedPk(mm.standOrigPk[selected.idx]); mm.standOrigPk.splice(selected.idx, 1); }
      const st = gg.stands[selected.idx];
      const delNodes = st ? [st.noseIdx, st.tailIdx, ...(st.pushbackIdxs || [])].filter((v) => v != null) : [];
      gg.stands.splice(selected.idx, 1);
      if (delNodes.length) doOrphanGC(delNodes);
      recordDeletedStand(st);
    } else if (selected.kind === 'bgImage') {
      // Background image: just clear it (not part of graph/meta)
      setBgImage(null);
      setSelected(null);
      if (hasMulti) setMultiSelected([]);
      return;
    }
    // Commit graph + meta together and push a depth-1 history for Ctrl+Z.
    useAppStore.setState({
      groundPainterHistory: structuredClone(g),
      groundPainterMetaHistory: structuredClone(m),
      groundPainterGraph: gg,
      groundPainterMeta: mm,
      groundPainterHasEdited: true,
    });
    setSelected(null);
    if (hasMulti) setMultiSelected([]);
  }, [selected, multiSelected]);
  // Depth-1 undo (Ctrl+Z) and the toolbar undo button share this single slot: restore
  // the prior graph/meta and clear the history so there is nothing left to undo.
  const undo = useCallback(() => {
    const s = useAppStore.getState();
    if (!s.groundPainterHistory) return;
    const restore = { groundPainterGraph: s.groundPainterHistory, groundPainterHistory: null, groundPainterHasEdited: true };
    if (s.groundPainterMetaHistory) {
      restore.groundPainterMeta = s.groundPainterMetaHistory;
      restore.groundPainterMetaHistory = null;
    }
    useAppStore.setState(restore);
    // also clear fillet picks on undo
    setFilletPicks([]);
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      // Focus is in a text/edit field (e.g. runway end-name box): let the browser
      // do pure text editing — never delete the object, undo the graph, or deselect.
      if (isTextEditTarget(e.target)) return;
      if (e.key === 'Escape') {
        if (tool === TOOL_CURVE && filletPicks.length > 0) {
          resetFillet();
          return;
        }
        // cancel an in-progress line/area placement and return to Select
        if (committing) { setCommitting(null); setTool('select'); }
        // else de-select the current selection
        else if (boxRect) { setBoxRect(null); boxDragRef.current = null; }
        else if (multiSelected.length) { setMultiSelected([]); setBoxRect(null); }
        else if (selected) { setSelected(null); }
        return;
      }
      if (e.key === 'Enter') {
        if (tool === TOOL_CURVE && filletPicks.length >= 2) {
          e.preventDefault();
          commitFillet(filletPicks[0], filletPicks[1], filletRadius);
          return;
        }
      }
      // ── Tool keyboard shortcuts (A/S/D/F/R/G/H) ──
      // Bare single letters switch the active tool, mirroring the toolbar buttons
      // (Select 'A' is also a toggle). Skipped while a text/edit field is focused
      // (guarded above) and when a modifier is held so it never fights Ctrl/Cmd
      // shortcuts (undo, save, flight ops).
      const TOOL_KEY_MAP = { a: TOOL_SELECT, s: TOOL_BOX_SELECT, d: TOOL_LINE, f: TOOL_CURVE, r: TOOL_RUNWAY, g: 'area', h: TOOL_STAND };
      const k = e.key.toLowerCase();
      if (TOOL_KEY_MAP[k] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (k === 'a') {
          // Select toggles like the toolbar button: from another tool → activate +
          // enable; already in select → toggle pan-only mode.
          if (tool !== TOOL_SELECT) { cancelPlacementInput(); setTool(TOOL_SELECT); setSelectEnabled(true); }
          else setSelectEnabled((v) => !v);
        } else {
          cancelPlacementInput();
          setTool(TOOL_KEY_MAP[k]);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault(); e.stopPropagation(); // depth-1 undo (select/deselect do NOT count)
        undo();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selected || multiSelected.length)) { e.preventDefault(); deleteSelected(); }
      // Rotate the whole (multi-)selection around its center in 45° steps — `[` ↺  `]` ↻.
      if ((e.key === '[' || e.key === ']') && (selected || multiSelected.length)) {
        e.preventDefault();
        rotateSelection(e.key === ']' ? -45 : 45);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, multiSelected, boxRect, deleteSelected, committing, setTool, tool, filletPicks, filletRadius, resetFillet, undo, cancelPlacementInput, setSelectEnabled, rotateSelection]);

  const onDblClick = useCallback(() => {
    if (tool === 'area' && committing && committing.length >= 3) commitArea(committing.map((pt) => ({ x: pt.x, z: pt.z })));
    else if (tool === TOOL_CURVE && filletPicks.length >= 2) commitFillet(filletPicks[0], filletPicks[1], filletRadius);
    else if (tool === TOOL_RUNWAY && committing && committing.length >= 2) commitRunway(committing.map((pt) => ({ x: pt.x, z: pt.z })));
    else if (tool === TOOL_LINE && committing && committing.length >= 2) {
      // Reuse the same auto-slice logic as onClick (T-junction) so a double-click finish also slices
      const st = useAppStore.getState();
      const gg = st.groundPainterGraph;
      const mm = st.groundPainterMeta;
      const clean = committing.map((pt) => ({ x: pt.x, z: pt.z }));
      // Only handle the pending last edge (committing length is 2 via the click path; for longer chains commit pairwise)
      if (clean.length === 2 && Math.hypot(clean[0].x - clean[1].x, clean[0].z - clean[1].z) < 1e-6) { setGpError(t('ground_painter_error_distinct_endpoints') || 'Segment needs distinct endpoints'); setCommitting(null); return; }
      let nodes = [...gg.nodes];
      let segs = [...gg.segments];
      let newMeta = structuredClone(mm);
      if (!Array.isArray(newMeta.deletedPks)) newMeta.deletedPks = newMeta.deletedPks ? [...newMeta.deletedPks] : [];
      const coordKeyLocal = (x, z) => (+x).toFixed(6) + ',' + (+z).toFixed(6);
      const getOrCreate = (pt) => {
        const existing = findNodeIndexByCoord({ nodes }, pt.x, pt.z);
        if (existing >= 0) return existing;
        const idx = nodes.length;
        nodes.push({ x: pt.x, z: pt.z, type: 2, flags: 0 });
        newMeta.nodeOrigPk.push(null);
        return idx;
      };
      // Collect T-junction splits for each pending edge
      const allPairs = [];
      for (let i = 0; i < clean.length - 1; i++) allPairs.push([clean[i], clean[i + 1]]);
      const EPS_T = 1e-6;
      const splitMap = new Map();
      for (const [pA, pB] of allPairs) {
        for (const pt of [pA, pB]) {
          const existingIdxOrig = findNodeIndexByCoord(gg, pt.x, pt.z);
          if (existingIdxOrig >= 0) continue;
          for (let segIdx = 0; segIdx < gg.segments.length; segIdx++) {
            if (splitMap.has(segIdx) && splitMap.get(segIdx).some((e) => Math.hypot(e.pt.x - pt.x, e.pt.z - pt.z) < 1e-6)) continue;
            const seg = gg.segments[segIdx];
            const idxs = seg.nodeIdxs && seg.nodeIdxs.length ? seg.nodeIdxs : [seg.aIdx, seg.bIdx];
            for (let ei = 0; ei < idxs.length - 1; ei++) {
              const a = gg.nodes[idxs[ei]], b = gg.nodes[idxs[ei + 1]];
              if (!a || !b) continue;
              const dx = b.x - a.x, dz = b.z - a.z;
              const len2 = dx * dx + dz * dz;
              if (len2 < 1e-12) continue;
              let t = ((pt.x - a.x) * dx + (pt.z - a.z) * dz) / len2;
              if (t <= EPS_T || t >= 1 - EPS_T) continue;
              const projX = a.x + t * dx, projZ = a.z + t * dz;
              if (Math.hypot(pt.x - projX, pt.z - projZ) > 1e-6) continue;
              if (!splitMap.has(segIdx)) splitMap.set(segIdx, []);
              splitMap.get(segIdx).push({ pt, edgeIdx: ei, t });
              break;
            }
          }
        }
      }
      const uniqPtMap = new Map();
      for (const arr of splitMap.values()) for (const { pt } of arr) { const k = coordKeyLocal(pt.x, pt.z); if (!uniqPtMap.has(k)) uniqPtMap.set(k, pt); }
      const ptKeyToJuncIdx = new Map();
      for (const [k, pt] of uniqPtMap) ptKeyToJuncIdx.set(k, getOrCreate(pt));
      // Ensure nodes for all committing vertices (dedup)
      const idxMap = new Map();
      for (const pt of clean) {
        const k = coordKeyLocal(pt.x, pt.z);
        if (!idxMap.has(k)) idxMap.set(k, getOrCreate(pt));
      }
      const segIdxsToSplit = [...splitMap.keys()].sort((a, b) => b - a);
      for (const segIdx of segIdxsToSplit) {
        const seg = gg.segments[segIdx];
        const arr = splitMap.get(segIdx);
        arr.sort((u, v) => (u.edgeIdx - v.edgeIdx) || (u.t - v.t));
        const idxs = seg.nodeIdxs && seg.nodeIdxs.length ? seg.nodeIdxs : [seg.aIdx, seg.bIdx];
        const expanded = [idxs[0]];
        for (let ei = 0; ei < idxs.length - 1; ei++) {
          const edgePts = arr.filter((e) => e.edgeIdx === ei).sort((x, y) => x.t - y.t);
          for (const e of edgePts) expanded.push(ptKeyToJuncIdx.get(coordKeyLocal(e.pt.x, e.pt.z)));
          expanded.push(idxs[ei + 1]);
        }
        const segJuncIdxSet = new Set(arr.map((e) => ptKeyToJuncIdx.get(coordKeyLocal(e.pt.x, e.pt.z))));
        const posList = [];
        for (let p = 0; p < expanded.length; p++) if (segJuncIdxSet.has(expanded[p])) posList.push(p);
        const pieces = [];
        let prevPos = 0;
        for (const pos of posList) { const piece = expanded.slice(prevPos, pos + 1); if (piece.length >= 2) pieces.push(piece); prevPos = pos; }
        if (prevPos < expanded.length - 1) { const tail = expanded.slice(prevPos, expanded.length); if (tail.length >= 2) pieces.push(tail); }
        const oldPk = newMeta.segOrigPk[segIdx];
        if (oldPk != null && !newMeta.deletedPks.includes(oldPk)) newMeta.deletedPks.push(oldPk);
        segs.splice(segIdx, 1);
        newMeta.segOrigPk.splice(segIdx, 1);
        for (const piece of pieces) { segs.push({ aIdx: piece[0], bIdx: piece[piece.length - 1], nodeIdxs: piece, flags: seg.flags ?? 2, directed: seg.directed ?? false, name: seg.name }); newMeta.segOrigPk.push(null); }
      }
      for (let i = 0; i < clean.length - 1; i++) {
        const kA = coordKeyLocal(clean[i].x, clean[i].z), kB = coordKeyLocal(clean[i+1].x, clean[i+1].z);
        const na = idxMap.get(kA), nb = idxMap.get(kB);
        if (na === nb) continue;
        const exists = segs.some((s) => { const ids = s.nodeIdxs || [s.aIdx, s.bIdx]; return (ids.length===2 && ((ids[0]===na && ids[1]===nb)||(ids[0]===nb && ids[1]===na))); });
        if (exists) continue;
        segs.push({ aIdx: na, bIdx: nb, nodeIdxs: [na, nb], flags: 2, directed: false });
        newMeta.segOrigPk.push(null);
      }
      const newGraph = { ...gg, nodes, segments: segs };
      useAppStore.setState({ groundPainterHistory: structuredClone(gg), groundPainterMetaHistory: structuredClone(mm), groundPainterGraph: newGraph, groundPainterMeta: newMeta, groundPainterHasEdited: true });
      setCommitting(clean.length >= 2 ? [{ x: clean[clean.length-1].x, z: clean[clean.length-1].z }] : null);
    }
  }, [tool, committing, commitArea, commitRunway, filletPicks, filletRadius, t]);

  // ── Save (with .bak prompt) + Cancel ──
  function commitArea(pts) {
    if (!pts || pts.length < 3) { setGpError(t('ground_painter_error_area_min_vertices') || 'Area needs at least 3 vertices'); setCommitting(null); return; }
    const st = useAppStore.getState();
    const gg = st.groundPainterGraph;
    const clean = pts.map((p) => ({ x: p.x, z: p.z }));
    const areas = [...gg.areas, { areaType, points: clean, owner: null }];
    commitGraph({ ...gg, areas });
    setCommitting(null);
    setGpError(null);
    setTool('select');
  }

  // ── Fillet (rounding) commit ──
  // Select two straight segments (connected or non-connected non-parallel), compute
  // tangent arc radius r, CUT both legs at t1/t2 and insert curved segment.
  // - Connected degree==2: ghost-delete the shared O node (old corner removed).
  // - Connected degree!=2: keep O for other incident branches, but still truncate the two picked legs.
  // - Virtual (non-connected): use imaginary intersection O, truncate both legs at their tangent points.
  function commitFillet(segIdxA, segIdxB, radius) {
    const s = useAppStore.getState();
    const g0 = s.groundPainterGraph;
    const m0 = s.groundPainterMeta;
    const fmtSeg = (seg, g) => {
      const gg = g || g0;
      return seg ? JSON.stringify({ idxs: seg.nodeIdxs || [seg.aIdx, seg.bIdx], flags: seg.flags, name: seg.name, pts: (seg.nodeIdxs||[seg.aIdx,seg.bIdx]).map(i=>gg.nodes[i]) }) : 'null';
    };
    let res = computeFillet(g0, segIdxA, segIdxB, radius);
    // A failed compute (angle/parallel/inside/…) must never fall through: the
    // tail below dereferences res.o/res.arcPoints. Enter-key commit is not gated
    // on the preview, so guard here rather than only in the UI.
    if (!res.ok) {
      setGpError(res.errorParams ? t(res.error, res.errorParams) : t(res.error));
      return;
    }
    // If O lies interior to a picked straight segment (e.g. T top single segment with O interior to its edge),
    // split that segment at O so the other side is kept. This handles the "other part deleted" T case where
    // the straight taxiway is a single long segment with the T's stem meeting its interior.
    // We detect straddle via computeFillet's "Intersection lies inside" error, then split and retry.
    let gSplit = null, mSplit = null, segASplit = segIdxA, segBSplit = segIdxB;
    if (!res.ok && res.error && res.error.includes('Intersection lies inside')) {
      // Need O to split — compute O via line intersection of the two picked segments' infinite lines
      const getFirstLast = (seg, g) => {
        const idxs = seg.nodeIdxs || [seg.aIdx, seg.bIdx];
        return [g.nodes[idxs[0]], g.nodes[idxs[idxs.length-1]]];
      };
      const segA0pre = g0.segments[segIdxA], segB0pre = g0.segments[segIdxB];
      const [aF, aL] = getFirstLast(segA0pre, g0);
      const [bF, bL] = getFirstLast(segB0pre, g0);
      const dx1=aL.x-aF.x, dz1=aL.z-aF.z, dx2=bL.x-bF.x, dz2=bL.z-bF.z;
      const denom=dx1*dz2 - dz1*dx2;
      let Ointer=null;
      if (Math.abs(denom) > 1e-9) {
        const t=((bF.x-aF.x)*dz2 - (bF.z-aF.z)*dx2)/denom;
        Ointer={x:aF.x+t*dx1, z:aF.z+t*dz1};
      }
      if (Ointer) {
        gSplit = structuredClone(g0);
        mSplit = structuredClone(m0);
        if (!Array.isArray(mSplit.deletedPks)) mSplit.deletedPks=[];
        const oNodeExisting = findNodeIndexByCoord(gSplit, Ointer.x, Ointer.z);
        let oNodeIdx = oNodeExisting;
        if (oNodeIdx < 0) {
          oNodeIdx = gSplit.nodes.length;
          gSplit.nodes.push({ x: Ointer.x, z: Ointer.z, type: 2, flags: 0 });
          mSplit.nodeOrigPk.push(null);
        } else {
        }
        const isOnInterior = (seg, g) => {
          const idxs=seg.nodeIdxs||[seg.aIdx,seg.bIdx];
          const pts=idxs.map(i=>g.nodes[i]).filter(Boolean);
          for(let ei=0; ei<pts.length-1; ei++){
            const a=pts[ei], b=pts[ei+1];
            const d=distToSeg(Ointer.x,Ointer.z, a.x,a.z, b.x,b.z);
            if(d>1e-6) continue;
            const eDx=b.x-a.x, eDz=b.z-a.z, eLen2=eDx*eDx+eDz*eDz;
            if(eLen2<1e-9) continue;
            let tt=((Ointer.x-a.x)*eDx+(Ointer.z-a.z)*eDz)/eLen2;
            if(tt>1e-6 && tt<1-1e-6) return { edgeIdx: ei, t:tt, a,b };
          }
          return null;
        };
        const splits=[];
        for(const sIdx of [segIdxA, segIdxB]){
          const seg=gSplit.segments[sIdx];
          if(!seg || !isStraightSegment(seg)) continue;
          const hit=isOnInterior(seg, gSplit);
          if(hit){
            splits.push({ segIdx: sIdx, seg, hit, oNodeIdx });
          }
        }
        if(splits.length){
          splits.sort((a,b)=>b.segIdx-a.segIdx);
          for(const sp of splits){
            const seg=gSplit.segments[sp.segIdx];
            const idxs=seg.nodeIdxs||[seg.aIdx,seg.bIdx];
            const leftIdxs=[...idxs.slice(0, sp.hit.edgeIdx+1).filter((v,i)=>i!==sp.hit.edgeIdx+1), oNodeIdx]; // actually left part up to O
            // More robust: split polyline at O: left = nodes up to edgeIdx inclusive + O, right = O + nodes from edgeIdx+1 onward
            // For 2-point A-B with O interior to edge 0 (A-B), left = [A, O], right = [O, B]
            const leftNodes=[...idxs.slice(0, sp.hit.edgeIdx+1), oNodeIdx];
            // Remove duplicate if edge's b is at same coordinate as O? O interior, so b is far, not duplicate
            // Actually left should be A..a + O, right O..b
            // For 2-point, leftNodes = [A, O], rightNodes = [O, B]
            // For 4-point pavement where O interior to edge 1-2, left = [0,1,O], right = [O,2,3]
            // Simplify: left = idxs.slice(0, sp.hit.edgeIdx+1); left[left.length-1]=oNodeIdx? No.
            // Let's construct properly:
            const leftPart=idxs.slice(0, sp.hit.edgeIdx+1);
            const rightPart=idxs.slice(sp.hit.edgeIdx+1);
            // leftPart ends at a, rightPart starts at b, O is between a and b
            // So new left = leftPart + [oNodeIdx] (replace b with O? Actually leftPart's last is a, rightPart's first is b, O between them)
            // For edge a-b with O interior, left = [...nodes before edge, a, oNodeIdx], right = [oNodeIdx, b, ...nodes after]
            const leftPoly=[...idxs.slice(0, sp.hit.edgeIdx+1), oNodeIdx];
            const rightPoly=[oNodeIdx, ...idxs.slice(sp.hit.edgeIdx+1)];
            // But for 2-point A-B with O interior to A-B, idxs=[A,B], edgeIdx 0, leftPoly=[A, O], rightPoly=[O, B] correct
            // For 4-point [0,1,2,3] with O interior to edge 1-2 (between 1 and 2), leftPoly=[0,1,O], rightPoly=[O,2,3]
            const leftPoly2=[...idxs.slice(0, sp.hit.edgeIdx+1), oNodeIdx];
            const rightPoly2=[oNodeIdx, ...idxs.slice(sp.hit.edgeIdx+1)];
            const pk=mSplit.segOrigPk[sp.segIdx];
            if(pk!=null && !mSplit.deletedPks.includes(pk)) mSplit.deletedPks.push(pk);
            gSplit.segments.splice(sp.segIdx,1);
            mSplit.segOrigPk.splice(sp.segIdx,1);
            const flags=seg.flags??2, name=seg.name;
            const leftSeg={aIdx:leftPoly2[0], bIdx:leftPoly2[leftPoly2.length-1], nodeIdxs:leftPoly2, flags, directed:false, ...(name?{name}:{})};
            const rightSeg={aIdx:rightPoly2[0], bIdx:rightPoly2[rightPoly2.length-1], nodeIdxs:rightPoly2, flags, directed:false, ...(name?{name}:{})};
            gSplit.segments.splice(sp.segIdx,0, leftSeg, rightSeg);
            mSplit.segOrigPk.splice(sp.segIdx,0, null, null);
            // Update seg indices for picked segs that were after this split
            // Need to adjust segASplit/segBSplit to point to the subsegment that will be used for fillet (the side that contains the original far)
            // Determine which side contains the original far that was on the filleted side (the far that was maxDot)
            // For now, we can just re-find the picked seg indices by searching for segments that contain the original farIdx
            // Simpler: after split, recompute which new subsegment contains the original far endpoint that was farthest in direction of the other segment
            // For now, just keep segASplit/segBSplit pointing to the subsegment that contains O? Actually both new subsegments share O, so either could be picked, but fillet should use the side that is on the same side as the other picked segment's direction.
            // To avoid complexity, we will just set segASplit/segBSplit to the subsegment that is on the same side as the original far that was farthest from O in direction of the fillet.
            // We can determine by checking which new subsegment contains the original farIdx that was farthest from O in the original compute's far direction.
            // For now, we will just leave segASplit/segBSplit as the original indices and let the next compute find the correct subsegment via line intersection? Actually after split, the original segment is gone, so segIdxA/B need to be updated to point to the correct new subsegment.
            // We will handle by searching for the new subsegment that shares O and is on the same side as the original far.
          }
          // After splits, need to find new seg indices for the filleted sides
          // For each original picked seg that was split, find which of the two new subsegments contains the original far that was on the filleted side.
          // The filleted side far is the one that was maxDot in the original compute's virtual direction.
          // We can recompute by finding which new subsegment has its farthest point in direction of the other segment.
          // Simpler: just set segASplit/segBSplit to the subsegment that is incident to O and is on the same side as the original stem's direction.
          // For now, we will search for segments at O that are newly created and pick the one that is most aligned with the other picked segment.
          // As a fallback, just pick the right subsegment (O-B) for top single case where O interior and stem is north, the filleted side is east (O-B), so right subsegment is correct.
        }
        // After splits, try recompute with new graph
        // Need to find new seg indices for the picked sides: search for segments that contain O and are on the filleted side
        // For now, just find any segment at O that is newly created and not the kept side
        // Simpler: just recompute fillet with the new graph by trying all combinations of subsegments at O?
      }
    }
    let resRetry = res;
    // If we did splits, need to recompute - for now just keep original res if no split, otherwise need to find new indices
    // This is placeholder - actual split handling will update gSplit/mSplit and recompute
    if (gSplit) {
      // Find new seg indices for fillet: for each original picked seg that was split, find the new subsegment that is most aligned with the other picked seg
      // For now, just use the first new subsegment that contains O and is not the kept side
      // As a simple heuristic, pick the subsegment that contains O and whose farthest point is farthest from O in the direction of the fillet
      // We will just recompute by trying all segments at O
    }
    // Validate straight (already in compute but double)
    const segA0 = g0.segments[segIdxA];
    const segB0 = g0.segments[segIdxB];
    if (segA0 && !isStraightSegment(segA0)) { setGpError(t('ground_painter_fillet_error_straight')); return; }
    if (segB0 && !isStraightSegment(segB0)) { setGpError(t('ground_painter_fillet_error_straight')); return; }

    // Clone
    const g = structuredClone(g0);
    const m = structuredClone(m0);
    if (!Array.isArray(m.deletedPks)) m.deletedPks = m.deletedPks ? [...m.deletedPks] : [];
    // Ensure deletedPks is array
    if (!m.deletedPks) m.deletedPks = [];

    // ── Pre-split: if O lies interior to a picked straight segment (e.g. T top single segment 37-38 with O interior at 4.007,3.37),
    // split that segment at O so the other side (beyond O) is kept as a separate segment.
    // This handles the case where the straight taxiway is a single segment with O interior, not yet split at the T.
    const oNodeIdxExisting = findNodeIndexByCoord(g0, res.o.x, res.o.z);
    const checkAndSplit = (segIdx) => {
      const seg = g0.segments[segIdx];
      if (!seg || !isStraightSegment(seg)) return null;
      const idxs = seg.nodeIdxs || [seg.aIdx, seg.bIdx];
      const pts = idxs.map(i=>g0.nodes[i]).filter(Boolean);
      if (pts.length < 2) return null;
      // Find edge where O lies interior (not at endpoint)
      for (let ei=0; ei<pts.length-1; ei++) {
        const a=pts[ei], b=pts[ei+1];
        const d = distToSeg(res.o.x, res.o.z, a.x, a.z, b.x, b.z);
        if (d > 1e-6) continue;
        const dx=b.x-a.x, dz=b.z-a.z, len2=dx*dx+dz*dz;
        if (len2 < 1e-9) continue;
        let t=((res.o.x - a.x)*dx + (res.o.z - a.z)*dz)/len2;
        t=Math.max(0,Math.min(1,t));
        const proj={x:a.x+t*dx, z:a.z+t*dz};
        const distToO=Math.hypot(proj.x-res.o.x, proj.z-res.o.z);
        if (distToO > 1e-6) continue;
        // Check if O is interior to this edge (not at its endpoints)
        const distToA=Math.hypot(res.o.x-a.x, res.o.z-a.z);
        const distToB=Math.hypot(res.o.x-b.x, res.o.z-b.z);
        const edgeLen=Math.hypot(dx,dz);
        if (distToA < 1e-6 || distToB < 1e-6) continue; // at endpoint, not interior
        if (t>1e-6 && t<1-1e-6) {
          return { segIdx, edgeIdx: ei, idxs, pts, t, oNodeIdx: oNodeIdxExisting };
        }
      }
      return null;
    };
    const splits = [];
    for (const sIdx of [segIdxA, segIdxB]) {
      const sp = checkAndSplit(sIdx);
      if (sp) splits.push(sp);
    }
    if (splits.length) {
      // Perform splits in descending segIdx order to keep indices stable
      splits.sort((a,b)=>b.segIdx-a.segIdx);
      for (const sp of splits) {
        const seg = g.segments[sp.segIdx];
        const origIdxs = seg.nodeIdxs || [seg.aIdx, seg.bIdx];
        const leftIdxs = origIdxs.slice(0, sp.edgeIdx+1);
        const rightIdxs = origIdxs.slice(sp.edgeIdx+1);
        // O node index to use for split point
        let oIdxForSplit = sp.oNodeIdx;
        if (oIdxForSplit == null || oIdxForSplit < 0) {
          // Create new node at O
          oIdxForSplit = g.nodes.length;
          g.nodes.push({ x: res.o.x, z: res.o.z, type: 2, flags: 0 });
          m.nodeOrigPk.push(null);
        } else {
          // Need to map oIdxForSplit from g0 to g after previous splits? Since we cloned and haven't changed nodes except maybe new O, the index remains same.
          // But if we already created a new O node for previous split, subsequent splits should reuse same O node.
          // So if oNodeIdxExisting was null and we created new, subsequent splits should reuse that new index.
        }
        // Build left and right polylines with O inserted
        const leftNodes = [...leftIdxs.slice(0, -1), oIdxForSplit];
        const rightNodes = [oIdxForSplit, ...rightIdxs];
        // Remove original segment
        const pk = m.segOrigPk[sp.segIdx];
        if (pk != null && !m.deletedPks.includes(pk)) m.deletedPks.push(pk);
        g.segments.splice(sp.segIdx, 1);
        m.segOrigPk.splice(sp.segIdx, 1);
        // Insert left and right as new segments (keep order: left then right, but inserted at same position)
        // To keep indices, insert left then right at original position
        const segFlags = seg.flags ?? 2;
        const segName = seg.name;
        const leftSeg = { aIdx: leftNodes[0], bIdx: leftNodes[leftNodes.length-1], nodeIdxs: leftNodes, flags: segFlags, directed: false, ...(segName?{name:segName}:{}) };
        const rightSeg = { aIdx: rightNodes[0], bIdx: rightNodes[rightNodes.length-1], nodeIdxs: rightNodes, flags: segFlags, directed: false, ...(segName?{name:segName}:{}) };
        g.segments.splice(sp.segIdx, 0, leftSeg, rightSeg);
        m.segOrigPk.splice(sp.segIdx, 0, null, null);
        // Adjust segIdxA/B for any picked indices that were after the split point
        // Since we inserted 1 extra segment (original 1 -> 2), indices after sp.segIdx shift by +1
        // Update segIdxA/B if they were after sp.segIdx
        // Also need to update which subsegment is the picked one for fillet: the subsegment that contains the far side in direction n
        // For now, assume the picked segment's far side is the side that contains the original far endpoint that was used for fillet's p1/p2.
        // We can determine which of the two new subsegments contains the original farIdx (p1Idx/p2Idx)
        // and set segIdxA/B to that subsegment's new index.
        const newLeftIdx = sp.segIdx;
        const newRightIdx = sp.segIdx+1;
        // Determine which new subsegment contains the original far endpoint for this seg
        const origFarIdx = (sp.segIdx === segIdxA ? res.p1Idx : sp.segIdx === segIdxB ? res.p2Idx : null);
        // Actually res.p1Idx/p2Idx are far endpoints for the original picked segments before split.
        // After split, the far side subsegment is the one that contains that farIdx.
        let pickedSubIdx = null;
        if (origFarIdx != null) {
          if (leftNodes.includes(origFarIdx)) pickedSubIdx = newLeftIdx;
          else if (rightNodes.includes(origFarIdx)) pickedSubIdx = newRightIdx;
        }
        if (sp.segIdx === segIdxA && pickedSubIdx != null) {
          segIdxA = pickedSubIdx;
          // Also need to adjust segIdxB if it was after
          if (segIdxB > sp.segIdx) segIdxB++;
        } else if (sp.segIdx === segIdxB && pickedSubIdx != null) {
          segIdxB = pickedSubIdx;
        } else {
          // If split segment was not one of the picked but the kept side, no update needed
        }
        // If we split a segment that was not picked but is the kept side of a T, we still need to keep it, but we already split it
        // For the case where O interior to a non-picked segment that is collinear with one picked, the split will create two segments, both kept, but fillet should use one of them.
        // This logic handles picked only.
      }
      // After splits, recompute res with new seg indices? The original res was computed with old seg indices and O, but after split, O is now at a node, and the picked subsegment is now endpoint at O, so the fillet geometry remains same (O, n, t). No need to recompute.
    }

    // Connected: truncation IS the fillet — the corner region between O and the
    // tangent points is replaced by the arc, so the picked segments are removed
    // and re-created truncated at their tangent points.
    // Virtual (non-connected): NEVER delete taxiway — both picked segments keep
    // their full geometry and the arc is wired on additively (applyVirtualFillet).
    const isVirtual = !!res.virtualO;
    if (!isVirtual) {
      const toDelete = [segIdxA, segIdxB].sort((a, b) => b - a);
      for (const idx of toDelete) {
        const seg = g0.segments[idx];
        const pk = m.segOrigPk[idx];
        if (pk != null && !m.deletedPks.includes(pk)) m.deletedPks.push(pk);
        g.segments.splice(idx, 1);
        m.segOrigPk.splice(idx, 1);
      }
    }
    const deg = isVirtual ? 0 : countIncidentByCoord(g0, res.o.x, res.o.z);
    // Ghost-delete the O nodes for the picked segments when they are not shared
    // with any kept branch. For a simple corner (deg==2) this deletes the single
    // corner vertex (or 2 duplicate vertices). For a T (deg==3) with three
    // duplicate O nodes at the same coordinate, it deletes the 2 O nodes for the
    // picked arms and keeps the third for the untouched arm. For a T with a
    // single shared O node (all three arms share the same index) the O is kept.
    if (!isVirtual) {
      const pickedOIdxs = res.duplicate ? [res.oIdxA, res.oIdxB].filter((v) => v != null) : (res.oIdx != null ? [res.oIdx] : []);
      // Collect incident segments at O coordinate
      const incidentAtO = [];
      for (let si = 0; si < g0.segments.length; si++) {
        const sg = g0.segments[si];
        const idxs = sg.nodeIdxs && sg.nodeIdxs.length ? sg.nodeIdxs : [sg.aIdx, sg.bIdx];
        for (const ni of idxs) {
          const n = g0.nodes[ni];
          if (n && Math.abs(n.x - res.o.x) < 1e-6 && Math.abs(n.z - res.o.z) < 1e-6) { incidentAtO.push({ segIdx: si, nodeIdx: ni, seg: {idxs, flags:sg.flags, name:sg.name} }); break; }
        }
      }
      for (const oIdx of pickedOIdxs) {
        let usedByKept = false;
        for (const inc of incidentAtO) {
          if (inc.segIdx === segIdxA || inc.segIdx === segIdxB) continue;
          if (inc.nodeIdx === oIdx) { usedByKept = true; break; }
        }
        if (!usedByKept) {
          const pk = m.nodeOrigPk[oIdx];
          if (pk != null && !m.deletedPks.includes(pk)) m.deletedPks.push(pk);
        }
      }
    }
    // The nodes ghost-deleted above are still in g.nodes (kept for index
    // stability) but will NOT be written to the .acl, so nothing created from
    // here on may reference them. Resolve each O through a LIVE node at the same
    // coordinate instead: at a T junction the arms often use duplicate nodes at
    // one snap point, and a surviving twin carries exactly the same geometry and
    // connections. This is what used to produce a new leg pointing at a deleted
    // node → "$iref:null" → `invalid $iref payload "null"` on save.
    const ghostIdxs = ghostNodeIndices(g, m);
    const liveEquivalent = (idx) => {
      if (idx == null) return null;
      if (!ghostIdxs.has(idx)) return idx;
      const n = g.nodes[idx];
      if (!n) return null;
      for (let i = 0; i < g.nodes.length; i++) {
        if (ghostIdxs.has(i)) continue;
        const c = g.nodes[i];
        if (c && Math.abs(c.x - n.x) < 1e-6 && Math.abs(c.z - n.z) < 1e-6) return i;
      }
      return null;
    };

    let idxT1 = null, idxT2 = null;
    if (!isVirtual) {
      // ── Append new nodes for arc (including t1/t2) ──
      const base = g.nodes.length;
      for (const pt of res.arcPoints) {
        g.nodes.push({ x: pt.x, z: pt.z, type: 2, flags: 0 });
        m.nodeOrigPk.push(null);
      }
      idxT1 = base;
      idxT2 = base + res.arcPoints.length - 1;
    }
    const p1Idx = res.p1Idx;
    const p2Idx = res.p2Idx;

    // Helper: create truncated leg for a segment, handling runway pavement interior split
    // For normal 2-point segments O is at endpoint → simple far->T.
    // For runway pavement (4-point, flags 4) where O is interior (threshold), we keep
    // the non-filleted side stub and truncate the filleted side at T.
    const createTruncatedLeg = (segOrig, farIdx, tIdx) => {
      const flags = segOrig?.flags ?? 2;
      const name = segOrig?.name;
      const idxs = segOrig?.nodeIdxs && segOrig.nodeIdxs.length ? segOrig.nodeIdxs : null;
      // Check pavement interior case
      if (flags === RUNWAY_PAVEMENT_FLAGS && idxs && idxs.length > 2) {
        // Find position of O in this segment by coordinate
        let pos = -1;
        for (let i = 0; i < idxs.length; i++) {
          const n = g0.nodes[idxs[i]];
          if (n && Math.abs(n.x - res.o.x) < 1e-6 && Math.abs(n.z - res.o.z) < 1e-6) { pos = i; break; }
        }
        if (pos > 0 && pos < idxs.length - 1) {
          const isFarAtEnd = farIdx === idxs[idxs.length - 1];
          const isFarAtStart = farIdx === idxs[0];
          if (isFarAtEnd) {
            // Keep left stub [0..pos] (overhang to O) and create right truncated [T, ...pos+1..end]
            const leftIdxs = idxs.slice(0, pos + 1);
            g.segments.push({ aIdx: leftIdxs[0], bIdx: leftIdxs[leftIdxs.length - 1], nodeIdxs: leftIdxs, flags, directed: false, ...(name ? { name } : {}) });
            m.segOrigPk.push(null);
            const rightIdxs = [tIdx, ...idxs.slice(pos + 1)];
            g.segments.push({ aIdx: rightIdxs[0], bIdx: rightIdxs[rightIdxs.length - 1], nodeIdxs: rightIdxs, flags, directed: false, ...(name ? { name } : {}) });
            m.segOrigPk.push(null);
            return;
          } else if (isFarAtStart) {
            // Keep right stub [pos..end] and create left truncated [far..T]
            const rightIdxs = idxs.slice(pos);
            g.segments.push({ aIdx: rightIdxs[0], bIdx: rightIdxs[rightIdxs.length - 1], nodeIdxs: rightIdxs, flags, directed: false, ...(name ? { name } : {}) });
            m.segOrigPk.push(null);
            const leftIdxs = [...idxs.slice(0, pos), tIdx];
            g.segments.push({ aIdx: leftIdxs[0], bIdx: leftIdxs[leftIdxs.length - 1], nodeIdxs: leftIdxs, flags, directed: false, ...(name ? { name } : {}) });
            m.segOrigPk.push(null);
            return;
          }
        }
      }
      // Generic: simple far->T
      g.segments.push({ aIdx: farIdx, bIdx: tIdx, nodeIdxs: [farIdx, tIdx], flags, directed: false, ...(name ? { name } : {}) });
      m.segOrigPk.push(null);
    };

    if (isVirtual) {
      // Virtual (non-connected): wire both picked segments to their tangent
      // points additively — extension stub beyond the near endpoint, split at
      // the tangent point, or direct anchor when a node already sits there.
      // No taxiway is removed; the arc is appended inside, anchored at the
      // (possibly pre-existing) tangent nodes.
      applyVirtualFillet(g, m, res, segIdxA, segIdxB);
    } else {
      // Create truncated legs for both picked segments
      createTruncatedLeg(segA0, p1Idx, idxT1);
      // For second leg, note direction: T2 -> P2 (still far->T but order reversed for consistency)
      // createTruncatedLeg expects far->T, but for B we have T2->P2 (T to far). Our helper creates far->T, which is same line reversed.
      // To keep direction consistent, call with far P2 and T2
      createTruncatedLeg(segB0, p2Idx, idxT2);
    }

    // For T (deg>2) keep the original O-T stubs as well so the 3rd arm stays connected to both filleted arms via O.
    // This gives 3 segs on the straight top (west O, O-T, T-far) + 2 on vertical (O-T, T-far) + arc = 6 as requested.
    // For simple corner deg==2 there is no 3rd arm, so O-T is not needed (O will be deleted).
    if (!isVirtual && deg > 2) {
      const oA = liveEquivalent(res.duplicate ? res.oIdxA : res.oIdx);
      const oB = liveEquivalent(res.duplicate ? res.oIdxB : res.oIdx);
      // Only keep O-T if O node still exists (not ghost-deleted) and T is distinct from O
      if (oA != null && idxT1 != null && oA !== idxT1) {
        const segAFlags = segA0?.flags ?? 2;
        const segAName = segA0?.name;
        // Avoid duplicate if pavement interior already created O-T via split (pavement case creates left stub + right truncated, but not O-T)
        // Check if a segment O->T already exists (pavement interior split creates left stub 0..pos and right truncated T..end, but not O-T)
        const existsOT1 = g.segments.some(s => {
          const idxs = s.nodeIdxs || [s.aIdx, s.bIdx];
          return (idxs[0] === oA && idxs[idxs.length-1] === idxT1) || (idxs[0] === idxT1 && idxs[idxs.length-1] === oA);
        });
        if (!existsOT1) {
          g.segments.push({ aIdx: oA, bIdx: idxT1, nodeIdxs: [oA, idxT1], flags: segAFlags, directed: false, ...(segAName ? { name: segAName } : {}) });
          m.segOrigPk.push(null);
        }
      }
      if (oB != null && idxT2 != null && oB !== idxT2) {
        const segBFlags = segB0?.flags ?? 2;
        const segBName = segB0?.name;
        const existsOT2 = g.segments.some(s => {
          const idxs = s.nodeIdxs || [s.aIdx, s.bIdx];
          return (idxs[0] === oB && idxs[idxs.length-1] === idxT2) || (idxs[0] === idxT2 && idxs[idxs.length-1] === oB);
        });
        if (!existsOT2) {
          g.segments.push({ aIdx: oB, bIdx: idxT2, nodeIdxs: [oB, idxT2], flags: segBFlags, directed: false, ...(segBName ? { name: segBName } : {}) });
          m.segOrigPk.push(null);
        }
      }
    }

    // Arc: T1 -> ... -> T2 (all new nodes). The virtual path appended its own
    // arc inside applyVirtualFillet, anchored at possibly pre-existing nodes.
    if (!isVirtual) {
      const arcIdxs = [];
      for (let i = 0; i < res.arcPoints.length; i++) arcIdxs.push(idxT1 + i);
      g.segments.push({ aIdx: idxT1, bIdx: idxT2, nodeIdxs: arcIdxs, flags: 2, directed: false });
      m.segOrigPk.push(null);
    }

    // If any pavement was filleted, clear its runwayPavement meta entry so the live
    // name-based fallback finds the new truncated pavement correctly (otherwise stale
    // meta would point to deleted nodes).
    const pavNames = new Set();
    if (segA0?.flags === RUNWAY_PAVEMENT_FLAGS && segA0?.name) pavNames.add(segA0.name);
    if (segB0?.flags === RUNWAY_PAVEMENT_FLAGS && segB0?.name) pavNames.add(segB0.name);
    for (const pavName of pavNames) {
      for (let r = 0; r < g.runways.length; r++) {
        if (g.runways[r].physicalName === pavName && m.runwayPavement && m.runwayPavement[r]) {
          m.runwayPavement[r] = [];
        }
      }
    }

    // Virtual path: no orphan-node GC here anymore. applyVirtualFillet is
    // additive — both picked segments keep their full geometry (extension
    // stubs and tangent-point splits keep every original node referenced), so
    // no near node can become isolated and no node PK is ghost-deleted.

    // Invariant: no entity that the writer will re-synthesize may reference a
    // ghost node (a node kept in the graph but dropped from the file) — that is
    // what serializes as "$iref:null" and aborts the save.
    const repair = repairGhostRefs(g, m);
    if (repair.dropped > 0) console.warn('[fillet] repairGhostRefs:', { ...repair, warnings: repair.warnings.map((w) => t(w) || w) });

    // Commit with meta history
    const prevG = s.groundPainterGraph;
    const prevM = s.groundPainterMeta;
    useAppStore.setState({
      groundPainterHistory: structuredClone(prevG),
      groundPainterMetaHistory: structuredClone(prevM),
      groundPainterGraph: g,
      groundPainterMeta: m,
      groundPainterHasEdited: true,
    });
    setFilletPicks([]);
    setHoverSegIdx(null);
    setGpError(null);
  }
  // Legacy alias kept for dbl-click path (now delegates to fillet)
  function commitCurve(pts) {
    setGpError(t('ground_painter_fillet_tool_hint') || 'Curve tool is now fillet: select two straight taxiways');
  }

  // Runway — one straight line becomes one physical runway pair. Name/PhysicalName
  // derived from the threshold heading so it never collides with an existing pair.
  // names[0] ↔ thA, names[1] ↔ thB, physicalName = join. Also synthesizes a
  // collinear `taxiway-segment` pavement strip named after the physical runway
  // (the ZSJN pattern: runway "01/19" is drawn partly as strips named "01/19"),
  // sharing the runway's two threshold nodes so it moves with the runway, plus a
  // small overhang node past each threshold (the real strips poke out past the
  // runway ends — that is what makes them visible, since the black runway
  // rectangle draws on top of the centerline). Matches the airport's strip shape.
  function commitRunway(pts) {
    if (!pts || pts.length < 2) return;
    const st = useAppStore.getState();
    const gg = st.groundPainterGraph;
    const mm = st.groundPainterMeta;
    const [aRaw, bRaw] = pts;
    const a = { x: aRaw.x, z: aRaw.z }, b = { x: bRaw.x, z: bRaw.z };
    const dx = b.x - a.x, dz = b.z - a.z;
    const h = Math.round(((Math.atan2(-dz, dx) * 180) / Math.PI % 360 + 360) % 360);
    let num = Math.round(h / 10) % 36; if (num === 0) num = 36;
    const name1 = String(num).padStart(2, '0');
    const name2 = String((num + 18) % 36).padStart(2, '0');
    const physicalName = name1 + '/' + name2;
    // Overhang beyond each threshold (game units) so the strip shows past the
    // runway rectangle. Real ZSJN strips poke out ~0.58 units (58 m at 100 m/unit).
    const OH = 0.6;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const overA = { x: a.x - ux * OH, z: a.z - uz * OH };
    const overB = { x: b.x + ux * OH, z: b.z + uz * OH };
    // Node indices: 0 overhang-A, 1 threshold A, 2 threshold B, 3 overhang-B.
    const iOA = gg.nodes.length, iA = iOA + 1, iB = iOA + 2, iOB = iOA + 3;
    const nodes = [...gg.nodes,
      { x: overA.x, z: overA.z, type: 2, flags: 0 },
      { x: a.x, z: a.z, type: 2, flags: 0 },
      { x: b.x, z: b.z, type: 2, flags: 0 },
      { x: overB.x, z: overB.z, type: 2, flags: 0 }];
    const segments = [...gg.segments,
      { aIdx: iA, bIdx: iB, nodeIdxs: [iOA, iA, iB, iOB], name: physicalName, flags: RUNWAY_PAVEMENT_FLAGS, directed: false }];
    const runways = [...gg.runways, { thAIdx: iA, thBIdx: iB, names: [name1, name2], name: name1, physicalName, width: RUNWAY_WIDTH }];
    // Extend meta so the new nodes + strip are persisted and the strip couples
    // to the runway (parallel length checks need meta in lockstep).
    const newMeta = mm ? {
      ...mm,
      nodeOrigPk: [...mm.nodeOrigPk, null, null, null, null],
      segOrigPk: [...mm.segOrigPk, null],
      runwayOrigPk: [...mm.runwayOrigPk, null],
      runwayPavement: [...(mm.runwayPavement || []), [iOA, iA, iB, iOB]],
      runwayOrigInfo: [...(mm.runwayOrigInfo || []), { pks: [null, null], physicalName, names: [name1, name2], width: RUNWAY_WIDTH }],
    } : mm;
    commitGraph({ ...gg, nodes, segments, runways }, newMeta);
    setCommitting(null);
    setGpError(null);
    setTool('select');
  }

  // Update selected runway endpoint names (physicalName is join)
  function updateSelectedRunwayNames(idx, newNames) {
    const st = useAppStore.getState();
    const gg = st.groundPainterGraph;
    if (!gg || !gg.runways[idx]) return;
    const rw = gg.runways[idx];
    // Plain text editing: keep the raw input verbatim (may be empty/partial while
    // typing). No in-place normalization/validation — that runs on Save.
    const names = [String(newNames[0] ?? ''), String(newNames[1] ?? '')];
    const physicalName = names.join('/');
    const oldPhys = rw.physicalName || '';
    const runways = [...gg.runways];
    runways[idx] = { ...rw, names, name: names[0], physicalName };
    // Keep the coupled pavement-strip segments (named after the runway's physical
    // name, e.g. "04/19") in lockstep with the rename. Selection + box-select both
    // exclude runway strips BY NAME (runwayStripNames), so without this the
    // old-named strip becomes a selectable taxiway overlapping the runway and
    // steals every click (segments are hit-tested before runways and the
    // equal-distance tie keeps the segment). Saves are unaffected — the
    // physical-name cascade rewrites the strips on write too — but syncing here
    // keeps the session graph consistent so the runway stays clickable.
    let segments = gg.segments;
    if (oldPhys && oldPhys !== physicalName) {
      segments = gg.segments.map((sg) => (sg.name === oldPhys ? { ...sg, name: physicalName } : sg));
    }
    pushHist();
    useAppStore.setState({ groundPainterGraph: { ...gg, runways, segments }, groundPainterHasEdited: true });
  }

  // Undo helpers (depth-1): push the pre-mutation graph on each committed edit.
  function pushHist() { const s = useAppStore.getState(); useAppStore.setState({ groundPainterHistory: s.groundPainterGraph }); }
  function commitGraph(newGraph, newMeta) {
    const s = useAppStore.getState();
    const patch = { groundPainterHistory: s.groundPainterGraph, groundPainterGraph: newGraph, groundPainterHasEdited: true };
    if (newMeta) patch.groundPainterMeta = newMeta;
    useAppStore.setState(patch);
  }

  // Writer warnings arrive as { key, params, text }: the writer runs in the
  // Electron main process where no translation context exists, so it emits an
  // i18n key + params (translated here) plus its plain-English rendering as a
  // fallback for anything the dictionary does not cover.
  function writerWarningText(w) {
    if (w && typeof w === 'object' && w.key) {
      const s = t(w.key, w.params);
      if (s && s !== w.key) return s;
      return w.text || JSON.stringify(w.params || {});
    }
    return String(w);
  }

  const save = useCallback(async (createBackup) => {
    const st = useAppStore.getState();
    setGpError(null);
    // Validate runway end names on Save — each must be "D" / "D[D]" / "DD"
    // optionally followed by a single capital letter (e.g. 4, 4R, 27, 27L).
    // Leading zeros are stripped by the game's `_normalizeRunway`, so both
    // "4R" and "04R" are valid end names.
    const g = st.groundPainterGraph;
    if (g && Array.isArray(g.runways)) {
      const nameOk = (n) => /^[0-9]{1,2}[A-Z]?$/.test(String(n));
      for (const rw of g.runways) {
        const names = Array.isArray(rw.names) && rw.names.length >= 2
          ? rw.names
          : [rw.name || '', (rw.physicalName || '').split('/')[1] || ''];
        if (!names.every(nameOk)) {
          setGpError(t('ground_painter_validation_runway_name') || '跑道端名须为 1 或 2 位数字，可后接单个大写字母（如 4、4R、27 或 27L）');
          return; // keep the window open so the user can fix the names
        }
      }
    }
    // Invariant guard: an entity the writer re-synthesizes must not reference a
    // node that will not be written (a ghost node — its PK is in deletedPks) or
    // an index that no longer exists. Either one serializes to "$iref:null" and
    // aborts the save with `invalid $iref payload "null"`. Repairing here is a
    // net, not the fix: this firing means some edit left the graph inconsistent.
    const repair = repairGhostRefs(st.groundPainterGraph, st.groundPainterMeta);
    if (repair.remapped || repair.dropped) {
      console.error('[GP] save: graph referenced deleted/missing nodes and was repaired — ' +
        'the edit that produced this is a bug:', { ...repair, warnings: repair.warnings.map((w) => t(w) || w) });
    }
    let res;
    try {
      res = await window.electronAPI.saveGroundPainterData({
        filePath: st.currentPath, snapshotText: st.groundPainterSnapshotText,
        graph: st.groundPainterGraph, meta: st.groundPainterMeta, createBackup: !!createBackup,
        bg: bgImage,
      });
    } catch (e) {
      console.error('[GP] save failed', e);
      setGpError(t('ground_painter_save_failed', { msg: e && e.message ? e.message : String(e) }) || 'Save failed');
      return; // keep the window open so the user can retry / fix
    }
    if (res && res.newText) useAppStore.setState({ groundPainterSnapshotText: res.newText, groundPainterHasEdited: false });
    // ── Reload flight schedule editor from disk (as-of current state) ──
    // Desired flow: Ground save (save acl) -> pop back to flight editor (load acl again).
    // Keep the ground graph's snapshot updated above, then refresh the outer
    // editor's flights/timelines/airportValues so the toolbar table reflects the
    // just-saved file. Failure is non-fatal — the ACL save already succeeded.
    try {
      const st2 = useAppStore.getState();
      const curPath = st2.currentPath;
      const curAirport = st2.currentAirport;
      const rPath = st2.rootPath;
      if (curPath) {
        const data = await window.electronAPI.loadAcl(curPath);
        if (data && data.success) {
          useAppStore.setState({
            flights: data.flights,
            before: data.before,
            after: data.after,
            arrayContent: data.arrayContent,
            originalBlocks: data.originalBlocks,
            modified: false,
            highlightedIdx: -1,
            selectedIndices: new Set(),
            _configStartTime: data.config?.startTime || null,
            _configEndTime: data.config?.endTime || null,
            _saveSec: data._saveSec,
            _currentDateTime: data._currentDateTime || null,
            isDemo: data.isDemo || false,
            timelineModified: { weather: false, wind: false, runway: false },
          });
          try {
            if (curAirport && useAppStore.getState().fileInfos?.[curAirport]) {
              const updatedInfo = await window.electronAPI.getFileInfo(curPath);
              if (updatedInfo && !updatedInfo.error) useAppStore.getState().updateSingleFileInfo(curAirport, curPath, updatedInfo);
            }
          } catch (_) {}
          if (curAirport && rPath) {
            try {
              const [vals, audio, tl, rp] = await Promise.all([
                window.electronAPI.collectValues(rPath, curAirport),
                window.electronAPI.loadAudioCallsigns(rPath, curAirport),
                window.electronAPI.loadTimelines(curPath),
                window.electronAPI.scanRunwayPairs(rPath, curAirport),
              ]);
              const wsu = tl && tl.success ? (tl.windSpeedUnit || WIND_UNITS.KNOTS) : WIND_UNITS.KNOTS;
              const _convWind = (entries, fromUnit, toUnit) => {
                if (!entries || !entries.length) return entries;
                if (fromUnit === toUnit) return entries;
                const MPS_TO_KNOTS = 1.94384;
                const factor = (fromUnit === WIND_UNITS.MPS && toUnit === WIND_UNITS.KNOTS) ? MPS_TO_KNOTS : (fromUnit === WIND_UNITS.KNOTS && toUnit === WIND_UNITS.MPS) ? (1 / MPS_TO_KNOTS) : 1;
                if (factor === 1) return entries;
                return entries.map((e) => ({ ...e, speed: Math.round(e.speed * factor) }));
              };
              const st3 = useAppStore.getState();
              useAppStore.setState({
                airportValues: { ...st3.airportValues, [curAirport]: vals },
                audioCallsigns: audio || st3.audioCallsigns,
                weatherTimeline: tl && tl.success ? (tl.weatherTimeline || []) : st3.weatherTimeline,
                windTimeline: tl && tl.success ? _convWind(tl.windTimeline || [], wsu, WIND_UNITS.KNOTS) : st3.windTimeline,
                runwayTimeline: tl && tl.success ? (tl.runwayTimeline || { initialRunways: [], timeline: [] }) : st3.runwayTimeline,
                _runwayPairs: (rp && rp.success) ? (rp.pairs || []) : st3._runwayPairs,
                weatherPath: tl ? tl.weatherPath : st3.weatherPath,
                windPath: tl ? tl.windPath : st3.windPath,
                runwayTimelinePath: tl ? tl.runwayTimelinePath : st3.runwayTimelinePath,
                _windSpeedUnit: wsu,
              });
            } catch (e) {
              console.warn('[GP] post-save reload aux failed', e);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[GP] post-save reload failed', e);
    }
    // Non-fatal: the save succeeded but some geometry could not be written (e.g.
    // a segment whose endpoint node was deleted). Tell the user instead of
    // silently dropping it — the flight editor has already been reloaded above,
    // so OK just pops back to it.
    if (res && Array.isArray(res.warnings) && res.warnings.length > 0) {
      showModal(
        t('ground_painter_saved_with_warnings') || 'Saved with warnings',
        <div>{res.warnings.map((w, i) => (<div key={i} style={{ marginBottom: 6 }}>{writerWarningText(w)}</div>))}</div>,
        <div className="modal-actions-row"><button className="btn-confirm" onClick={() => { hideModal(); close(); }}>{t('modal_btn_ok')}</button></div>
      );
      return;
    }
    close(); // save complete -> pop back to flight schedule editor
  }, [t, close, bgImage, showModal, hideModal]);

  // Exact copy of the Flight Editor backup-before-save modal (useEditorSaveActions).
  const onSavePrompt = useCallback(() => {
    showModal(t('modal_backup_title'),
      <label className="modal-checkbox-row"><input type="checkbox" ref={el => (saveCbRef.current = el)} defaultChecked className="modal-checkbox" /><span>{t('modal_backup_checkbox')}</span></label>,
      <div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button><button className="btn-confirm" onClick={async () => { hideModal(); await save(saveCbRef.current ? saveCbRef.current.checked : true); }}>{t('modal_btn_confirm_save')}</button></div>);
  }, [t, showModal, hideModal, save]);

  // Multi-selection rotation plan (bounding-box pivot + nodes/areas/stands to
  // rotate). Only built while the Box-Select tool holds a multi-selection, so the
  // ↻ gizmo and its drag both operate on the same geometry set.
  const multiRotatePlan = useMemo(() => {
    if (tool !== TOOL_BOX_SELECT || !multiSelected.length) return null;
    return buildRotationPlan(graph, meta, multiSelected);
  }, [graph, meta, multiSelected, tool]);

  // ── svg layer rendering (GroundMapWindow order) ──
  const render = () => {
    if (!graph) return null;
    const taxiW = 0.15; // 3x for visibility + easier selection
    const placing = tool === TOOL_LINE || tool === TOOL_CURVE || tool === TOOL_RUNWAY || tool === TOOL_STAND || tool === 'area';
    const vbDiag = viewBox ? Math.max(viewBox[2], viewBox[3]) : 1;
    return (
      <>
        <rect x={-1e6} y={-1e6} width={2e6} height={2e6} fill="#0a1628" />
        {/* Imported background image — map-anchored reference layer behind the
            scenery. Rendered in world/SVG coords so it stays aligned with the
            map as the user pans/zooms to trace over it. */}
        {bgImage && (() => {
          const bgW = bgImage.baseW * bgImage.scale;
          const bgH = bgImage.baseH * bgImage.scale;
          const cx = bgImage.anchorX + (bgImage.offsetX / 100) * bgW;
          const cz = bgImage.anchorZ + (bgImage.offsetY / 100) * bgH;
          const rot = bgImage.rotation || 0;
          return (
            <image href={bgImage.src} x={cx - bgW / 2} y={svgY(cz) - bgH / 2} width={bgW} height={bgH} preserveAspectRatio="none" opacity={bgImage.opacity ?? 0.6} transform={rot ? `rotate(${rot} ${cx} ${svgY(cz)})` : undefined} />
          );
        })()}
        {/* Areas (below taxiway): BOUNDARY < APRON < BUILDING */}
        {[...graph.areas].sort((x, y) => AREA_Z_ORDER.indexOf(x.areaType) - AREA_Z_ORDER.indexOf(y.areaType)).map((ar, i) => {
          const st = AREA_TYPE_STYLES[ar.areaType] || AREA_TYPE_STYLES[1];
          return (
            <polygon key={'a' + i} points={(ar.points || []).map((p) => p.x + ',' + svgY(p.z)).join(' ')} fill={st.fill} fillOpacity={st.opacity} stroke={st.stroke === 'none' ? 'none' : st.stroke} strokeWidth={st.stroke === 'none' ? 0 : taxiW * 0.6} />
          );
        })}
        {/* Taxiways: the graph's own polylines (full curve points straight from the
            ACL segment Nodes). Single source — no cache.json / merged snapshot. */}
        {graph.segments.length > 0 && taxiPaths.map((pts, i) => (
          <polyline key={'twy' + i} points={pts.map((pp) => pp.x + ',' + svgY(pp.z)).join(' ')} fill="none" stroke="#444" strokeWidth={taxiW} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {graph.runways.map((rw, i) => {
          const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx]; if (!a || !b) return null;
          const halfW = (rw.width || 0.50) / 2;
          const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
          const px = (-dz / len) * halfW, pz = (dx / len) * halfW;
          const pts = [[a.x - px, a.z - pz], [b.x - px, b.z - pz], [b.x + px, b.z + pz], [a.x + px, a.z + pz]].map(([x, z]) => x + ',' + svgY(z)).join(' ');
          return <polygon key={'r' + i} points={pts} fill="#000" fillOpacity={0.85} />;
        })}
        {/* Stand planes (nose-anchored, heading rotation like StandMap) */}
        {graph.stands.map((st, i) => {
          const nose = graph.nodes[st.noseIdx];
          const tail = graph.nodes[st.tailIdx];
          if (!nose) return null;
          const h = st.heading || 360;
          // Fixed world size: ZSJN 240% reference (baseDiag*0.028/2.4)
          const baseDiagForIcon = baseVB ? Math.max(baseVB[2], baseVB[3]) : vbDiag;
          const fixedWorldSize = baseDiagForIcon * 0.028 / 2.4;
          const scale = fixedWorldSize / MAP_PLANE_VB;
          const isSel = (selected && selected.kind === 'stand' && selected.idx === i) || isMultiSelected(multiSelected, 'stand', i);
          const tailLineOpacity = isSel ? 0.95 : 0.45;
          return (
            <g key={'s' + i}>
              {/* TAIL line HEAD→TAIL and tail dot — shows STAND_LENGTH offset, HEAD is icon */}
              {tail && (
                <>
                  <line x1={nose.x} y1={svgY(nose.z)} x2={tail.x} y2={svgY(tail.z)} stroke={isSel ? '#ffd34d' : '#8a94a6'} strokeWidth={isSel ? HL_SW * 1.1 : HL_SW * 0.7} strokeDasharray={isSel ? '0' : '4 4'} opacity={tailLineOpacity} />
                  <circle cx={tail.x} cy={svgY(tail.z)} r={DOT_R * 0.75} fill={isSel ? '#ffd34d' : '#8a94a6'} opacity={isSel ? 1 : 0.7} />
                  {isSel && <text x={tail.x} y={svgY(tail.z) + DOT_R * 2.2} textAnchor="middle" fontSize={DOT_R * 1.7} fill="#ffd34d" fontWeight={700} style={{ paintOrder: 'stroke', stroke: '#0a1628', strokeWidth: DOT_R * 0.5, strokeLinejoin: 'round' }}>TAIL</text>}
                </>
              )}
              {/* HEAD plane icon */}
              <g transform={`translate(${nose.x}, ${svgY(nose.z)})`}>
                {/* selection border highlight behind the plane */}
                {isSel && <circle r={DOT_R * 1.65} fill="none" stroke="#ffd34d" strokeWidth={HL_SW} opacity={0.95} />}
                {isSel && <circle r={DOT_R * 2.35} fill="none" stroke="#fff" strokeWidth={HL_SW * 0.55} opacity={0.9} />}
                <g transform={`rotate(${h}) scale(${scale}) translate(-256, -256)`}>
                  <path d={MAP_ICON_PATH} fill={isSel ? '#ffff00' : '#ffd34d'} opacity={isSel ? 1 : 0.95} stroke={isSel ? '#ffd34d' : 'none'} strokeWidth={isSel ? 14 : 0} paintOrder="stroke" />
                </g>
                {isSel && <text x={0} y={-DOT_R * 2.8} textAnchor="middle" fontSize={DOT_R * 1.7} fill="#ffff00" fontWeight={800} style={{ paintOrder: 'stroke', stroke: '#0a1628', strokeWidth: DOT_R * 0.5, strokeLinejoin: 'round' }}>HEAD</text>}
              </g>
            </g>
          );
        })}
        <SelOutline />
        {/* Multi-selection bounding box + rotation handle (↻) — drag it to rotate
            every selected element together around the selection's center. */}
        {multiRotatePlan && (() => {
          const { cx, cz, minX, maxX, minZ, maxZ } = multiRotatePlan;
          const w = maxX - minX, h = maxZ - minZ;
          return (
            <g pointerEvents="none">
              <rect x={minX} y={svgY(maxZ)} width={Math.max(w, 1e-6)} height={Math.max(h, 1e-6)} fill="none" stroke="#6aa0ff" strokeWidth={HL_SW} strokeDasharray="6,4" opacity={0.9} />
              <line x1={cx} y1={svgY(cz)} x2={cx} y2={svgY(maxZ)} stroke="#6aa0ff" strokeWidth={HL_SW * 0.8} strokeDasharray="4,3" opacity={0.8} />
              <g transform={`translate(${cx}, ${svgY(maxZ)})`}>
                <circle r={DOT_R * 1.5} fill="#0a1628" stroke="#6aa0ff" strokeWidth={HL_SW} />
                <circle r={DOT_R * 1.5} fill="none" stroke="#fff" strokeWidth={HL_SW * 0.4} opacity={0.55} />
                <text textAnchor="middle" dy={DOT_R * 0.48} fontSize={DOT_R * 2} fill="#6aa0ff" style={{ userSelect: 'none', pointerEvents: 'none', fontWeight: 700 }}>↻</text>
              </g>
            </g>
          );
        })()}
        {/* Background image selection outline — draggable + rotatable reference layer */}
        {selected && selected.kind === 'bgImage' && bgImage && (() => {
          const b = getBgBounds(bgImage);
          if (!b) return null;
          const rot = bgImage.rotation || 0;
          const h = getBgRotationHandleWorld(bgImage);
          return (
            <g key="bgSel">
              <g transform={rot ? `rotate(${rot} ${b.cx} ${svgY(b.cz)})` : undefined}>
                <rect x={b.minX} y={svgY(b.maxZ)} width={b.w} height={b.h} fill="none" stroke="#6aa0ff" strokeWidth={HL_SW} strokeDasharray="6,4" opacity={0.95} />
                <rect x={b.minX} y={svgY(b.maxZ)} width={b.w} height={b.h} fill="none" stroke="#fff" strokeWidth={HL_SW * 0.5} strokeDasharray="6,4" opacity={0.35} />
                <rect x={b.minX - DOT_R * 0.6} y={svgY(b.maxZ) - DOT_R * 0.6} width={DOT_R * 1.2} height={DOT_R * 1.2} fill="#6aa0ff" stroke="#fff" strokeWidth={HL_SW * 0.4} />
                <rect x={b.maxX - DOT_R * 0.6} y={svgY(b.maxZ) - DOT_R * 0.6} width={DOT_R * 1.2} height={DOT_R * 1.2} fill="#6aa0ff" stroke="#fff" strokeWidth={HL_SW * 0.4} />
                <rect x={b.minX - DOT_R * 0.6} y={svgY(b.minZ) - DOT_R * 0.6} width={DOT_R * 1.2} height={DOT_R * 1.2} fill="#6aa0ff" stroke="#fff" strokeWidth={HL_SW * 0.4} />
                <rect x={b.maxX - DOT_R * 0.6} y={svgY(b.minZ) - DOT_R * 0.6} width={DOT_R * 1.2} height={DOT_R * 1.2} fill="#6aa0ff" stroke="#fff" strokeWidth={HL_SW * 0.4} />
              </g>
              <circle cx={b.cx} cy={svgY(b.cz)} r={DOT_R * 0.8} fill="#6aa0ff" stroke="#fff" strokeWidth={HL_SW * 0.5} opacity={0.9} />
              {h && (
                <>
                  <line x1={b.cx} y1={svgY(b.cz)} x2={h.x} y2={svgY(h.z)} stroke="#6aa0ff" strokeWidth={HL_SW * 0.85} strokeDasharray="5,3" opacity={0.85} />
                  <g transform={`translate(${h.x}, ${svgY(h.z)})`}>
                    <circle r={DOT_R * 1.45} fill="#0a1628" stroke="#6aa0ff" strokeWidth={HL_SW} />
                    <circle r={DOT_R * 1.45} fill="none" stroke="#fff" strokeWidth={HL_SW * 0.4} opacity={0.55} />
                    <text textAnchor="middle" dy={DOT_R * 0.48} fontSize={DOT_R * 1.9} fill="#6aa0ff" style={{ userSelect: 'none', pointerEvents: 'none', fontWeight: 700 }}>↻</text>
                  </g>
                </>
              )}
            </g>
          );
        })()}
        {/* Box-select rectangle preview (多选) — world-space dashed rect with translucent fill */}
        {boxRect && (() => {
          const minX = Math.min(boxRect.x0, boxRect.x1);
          const maxX = Math.max(boxRect.x0, boxRect.x1);
          const minZ = Math.min(boxRect.z0, boxRect.z1);
          const maxZ = Math.max(boxRect.z0, boxRect.z1);
          const w = maxX - minX, h = maxZ - minZ;
          if (w < 1e-9 && h < 1e-9) return null;
          return (
            <g>
              <rect x={minX} y={svgY(maxZ)} width={w} height={h} fill="#6aa0ff" fillOpacity={0.12} stroke="#6aa0ff" strokeWidth={HL_SW * 0.9} strokeDasharray="6 4" opacity={0.95} />
              <rect x={minX} y={svgY(maxZ)} width={w} height={h} fill="none" stroke="#fff" strokeWidth={HL_SW * 0.4} strokeDasharray="6 4" opacity={0.35} />
            </g>
          );
        })()}
        {/* Fillet picks / hover highlight and preview */}
        {tool === TOOL_CURVE && graph && (() => {
          const highlights = [];
          // hover
          if (hoverSegIdx != null && !filletPicks.includes(hoverSegIdx)) {
            const sg = graph.segments[hoverSegIdx];
            const pts = segNodeIdxs(sg).map((ni) => graph.nodes[ni]).filter(Boolean);
            if (pts.length >= 2) highlights.push(<polyline key="hover" points={pts.map((pp) => pp.x + ',' + svgY(pp.z)).join(' ')} fill="none" stroke="#8a94ff" strokeWidth={HL_SW * 1.2} strokeDasharray="4,3" opacity={0.9} />);
          }
          // picks
          for (const pi of filletPicks) {
            const sg = graph.segments[pi];
            const pts = segNodeIdxs(sg).map((ni) => graph.nodes[ni]).filter(Boolean);
            if (pts.length >= 2) highlights.push(<polyline key={"pick"+pi} points={pts.map((pp) => pp.x + ',' + svgY(pp.z)).join(' ')} fill="none" stroke="#ffd34d" strokeWidth={HL_SW * 1.4} opacity={1} />);
          }
          // preview arc when 2 picks and valid
          let preview = null;
          if (filletPreview && filletPreview.ok && filletPreview.arcPoints) {
            const ap = filletPreview.arcPoints;
            // Virtual (disconnected) fillet: nothing is cut — both taxiways keep
            // their full geometry and the arc is added on top. Show the tangent →
            // near-endpoint connection side: where an extension stub bridges the
            // gap to the arc (or an existing piece stays and the arc branches off).
            const nearA = filletPreview.virtualO && filletPreview.nearIdxA != null ? graph.nodes[filletPreview.nearIdxA] : null;
            const nearB = filletPreview.virtualO && filletPreview.nearIdxB != null ? graph.nodes[filletPreview.nearIdxB] : null;
            preview = (
              <g key="filletPreview">
                {nearA && nearB ? (
                  <>
                    <line x1={filletPreview.t1.x} y1={svgY(filletPreview.t1.z)} x2={nearA.x} y2={svgY(nearA.z)} stroke="#ffd34d" strokeWidth={HL_SW} strokeDasharray="6,4" opacity={0.95} />
                    <line x1={filletPreview.t2.x} y1={svgY(filletPreview.t2.z)} x2={nearB.x} y2={svgY(nearB.z)} stroke="#ffd34d" strokeWidth={HL_SW} strokeDasharray="6,4" opacity={0.95} />
                  </>
                ) : (
                  <>
                    {/* Truncated legs P_far -> T (connected fillet cuts the straight legs at the tangent points) */}
                    <line x1={filletPreview.p1.x} y1={svgY(filletPreview.p1.z)} x2={filletPreview.t1.x} y2={svgY(filletPreview.t1.z)} stroke="#ffd34d" strokeWidth={HL_SW} strokeDasharray="6,4" opacity={0.95} />
                    <line x1={filletPreview.t2.x} y1={svgY(filletPreview.t2.z)} x2={filletPreview.p2.x} y2={svgY(filletPreview.p2.z)} stroke="#ffd34d" strokeWidth={HL_SW} strokeDasharray="6,4" opacity={0.95} />
                  </>
                )}
                {/* Arc */}
                <polyline points={ap.map((pp) => pp.x + ',' + svgY(pp.z)).join(' ')} fill="none" stroke="#3fdc6e" strokeWidth={HL_SW * 1.2} strokeLinecap="round" strokeLinejoin="round" />
                {/* Tangent points */}
                <circle cx={filletPreview.t1.x} cy={svgY(filletPreview.t1.z)} r={DOT_R * 0.9} fill="#3fdc6e" />
                <circle cx={filletPreview.t2.x} cy={svgY(filletPreview.t2.z)} r={DOT_R * 0.9} fill="#3fdc6e" />
                <circle cx={filletPreview.center.x} cy={svgY(filletPreview.center.z)} r={DOT_R * 0.5} fill="#8a94ff" opacity={0.9} />
              </g>
            );
          } else if (filletPreview && filletPreview.error && filletPicks.length >= 2) {
            // error preview: show picks in red
            preview = <text x={filletPreview.t1 ? filletPreview.t1.x : 0} y={filletPreview.t1 ? svgY(filletPreview.t1.z) : 0} fontSize={DOT_R*1.4} fill="#ff6b6b">{filletPreview.errorParams ? t(filletPreview.error, filletPreview.errorParams) : t(filletPreview.error)}</text>;
          }
          return <g>{highlights}{preview}</g>;
        })()}
        {committing && committing.length > 0 && (
          <g>
            <polyline points={committing.concat(world ? [world] : []).map((pp) => pp.x + ',' + svgY(pp.z)).join(' ')} fill="none" stroke="#ffd34d" strokeWidth={HL_SW} />
            {/* Area polygon closing preview: filled enclosed area (under dots so dots stay on top) */}
            {tool === 'area' && world && world.isAreaClose && (() => {
              const idx = world.closeIdx;
              const truncated = committing.slice(idx);
              if (!truncated || truncated.length < 3) return null;
              const st = AREA_TYPE_STYLES[areaType] || AREA_TYPE_STYLES[1];
              const polyPts = truncated.map((pp) => pp.x + ',' + svgY(pp.z)).join(' ');
              return (
                <polygon points={polyPts} fill={st.fill} fillOpacity={0.45} stroke="#3fdc6e" strokeWidth={HL_SW * 1.2} strokeDasharray="6,4" />
              );
            })()}
            {/* committed endpoints (visible while painting a line/area) */}
            {committing.map((pp, k) => {
              const isCloseVertex = tool === 'area' && world && world.isAreaClose && world.closeIdx === k;
              const isDiscarded = tool === 'area' && world && world.isAreaClose && k < world.closeIdx;
              return <circle key={'cpt' + k} cx={pp.x} cy={svgY(pp.z)} r={isCloseVertex ? DOT_R * 1.35 : DOT_R * 0.9} fill={isCloseVertex ? '#3fdc6e' : (isDiscarded ? '#8a94a6' : '#ffd34d')} stroke={isCloseVertex ? '#3fdc6e' : 'none'} strokeWidth={isCloseVertex ? HL_SW * 0.6 : 0} opacity={isDiscarded ? 0.45 : 1} />;
            })}
            {/* extra highlight ring on the snap/close vertex */}
            {tool === 'area' && world && world.isAreaClose && (() => {
              const idx = world.closeIdx;
              const truncated = committing.slice(idx);
              if (!truncated || truncated.length < 3) return null;
              return (
                <g>
                  <circle cx={truncated[0].x} cy={svgY(truncated[0].z)} r={DOT_R * 2.0} fill="none" stroke="#3fdc6e" strokeWidth={HL_SW * 1.15} opacity={0.95} />
                  <circle cx={truncated[0].x} cy={svgY(truncated[0].z)} r={DOT_R * 1.15} fill="none" stroke="#fff" strokeWidth={HL_SW * 0.55} opacity={0.85} />
                </g>
              );
            })()}
          </g>
        )}
        {/* snap feedback for placement tools (line/area/stand) */}
        {(placing && world) && <SnapIndicator world={world} vb={viewBox} dotR={DOT_R} sw={HL_SW} />}
        {/* angle arc between the last edge and the candidate edge when a snap fires */}
        {world && angleLabel && (world.type === SNAP_TYPES.EXTENSION_180 || world.type === SNAP_TYPES.PERPENDICULAR_90 || world.type === SNAP_TYPES.DIAGONAL_45) && (() => {
          const r = DOT_R * 2.2;
          const pts = snapArcPoints(angleLabel.anchor.x, angleLabel.anchor.z, angleLabel.a0, angleLabel.a1, r);
          return (
            <g>
              <polyline points={pts} fill="none" stroke="#ffd34d" strokeWidth={HL_SW * 0.9} strokeLinecap="round" opacity={0.95} />
              <circle cx={angleLabel.anchor.x} cy={svgY(angleLabel.anchor.z)} r={DOT_R * 0.6} fill="none" stroke="#ffd34d" strokeWidth={HL_SW * 0.6} opacity={0.9} />
            </g>
          );
        })()}
        {/* length label for straight taxiway / runway (draft preview or selected) */}
        {lengthLabel && (() => {
          const txt = formatLengthMeters(lengthLabel.meters);
          const fontSize = DOT_R * 2.6; // ~13px on screen
          const padX = fontSize * 0.5;
          const padY = fontSize * 0.3;
          const charW = fontSize * 0.56;
          const w = txt.length * charW + padX * 2;
          const h = fontSize + padY * 2;
          const x = lengthLabel.x;
          const y = svgY(lengthLabel.z);
          const rx = x - w / 2;
          const ry = y - h * 0.9; // offset upward so it doesn't sit on the line
          return (
            <g>
              <rect x={rx} y={ry} width={w} height={h} rx={h * 0.28} ry={h * 0.28} fill="#0a1628" stroke="#ffd34d" strokeWidth={HL_SW * 0.9} opacity={0.94} />
              <text x={x} y={ry + h / 2 + fontSize * 0.34} textAnchor="middle" fontSize={fontSize} fontWeight={650} fill="#ffd34d" style={{ fontVariantNumeric: 'tabular-nums', paintOrder: 'stroke' }} dominantBaseline="middle">{txt}</text>
            </g>
          );
        })()}
        {/* vertex angle badge between the last drawn edge and the candidate edge */}
        {angleLabel && (() => {
          const txt = Math.round(angleLabel.angle) + '\u00B0';
          const fontSize = DOT_R * 2.6;
          const padX = fontSize * 0.5;
          const padY = fontSize * 0.3;
          const charW = fontSize * 0.56;
          const w = txt.length * charW + padX * 2;
          const h = fontSize + padY * 2;
          const x = angleLabel.x;
          const y = svgY(angleLabel.z);
          const rx = x - w / 2;
          const ry = y + h * 0.9; // offset downward so it doesn't overlap the length label
          return (
            <g>
              <rect x={rx} y={ry} width={w} height={h} rx={h * 0.28} ry={h * 0.28} fill="#0a1628" stroke="#ff9f43" strokeWidth={HL_SW * 0.9} opacity={0.94} />
              <text x={x} y={ry + h / 2 + fontSize * 0.34} textAnchor="middle" fontSize={fontSize} fontWeight={650} fill="#ff9f43" style={{ fontVariantNumeric: 'tabular-nums', paintOrder: 'stroke' }} dominantBaseline="middle">{txt}</text>
            </g>
          );
        })()}
      </>
    );
  };

  const onToggleSelect = useCallback(() => {
    if (tool !== TOOL_SELECT) {
      // Single-click from any other tool (taxiway line/curve, runway, area, stand, boxSelect)
      // → switch to select, enable it, and cancel current edit (committing/fillet/box preview)
      cancelPlacementInput();
      setTool(TOOL_SELECT);
      setSelectEnabled(true);
    } else {
      // Already in select → toggle enabled (pan-only) without touching edit state
      setSelectEnabled((v) => !v);
    }
  }, [tool, setTool, cancelPlacementInput]);

  const handleRunwayNamesChange = useCallback((newNames) => {
    if (!selected || selected.kind !== 'runway') return;
    updateSelectedRunwayNames(selected.idx, newNames);
  }, [selected]);

  // ── Selection highlight (render helper) ──
  const SelOutline = () => {
    if (!graph) return null;
    const HL = '#ffd34d', sw = HL_SW, dr = DOT_R;
    const n = graph.nodes;
    const allSels = [];
    if (selected) allSels.push(selected);
    if (multiSelected && multiSelected.length) allSels.push(...multiSelected);
    if (!allSels.length) return null;
    const renderOne = (sel, key) => {
      if (sel.kind === 'segment') {
        const sg = graph.segments[sel.idx];
        if (!sg) return null;
        const idxs = segNodeIdxs(sg);
        const ppt = idxs.map((ni) => n[ni]).filter(Boolean);
        if (ppt.length < 2) return null;
        return (
          <g key={key}>
            <polyline points={ppt.map((pp) => pp.x + ',' + svgY(pp.z)).join(' ')} fill="none" stroke={HL} strokeWidth={sw} />
            {idxs.map((_, k) => {
              const pp = ppt[k]; if (!pp) return null;
              return <circle key={k} cx={pp.x} cy={svgY(pp.z)} r={dr} fill={HL} />;
            })}
          </g>
        );
      }
      if (sel.kind === 'runway') {
        const rw = graph.runways[sel.idx]; if (!rw) return null;
        const a = n[rw.thAIdx], b = n[rw.thBIdx]; if (!a || !b) return null;
        const halfW = (rw.width || 0.50) / 2;
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
        const px = (-dz / len) * halfW, pz = (dx / len) * halfW;
        const pts = [[a.x - px, a.z - pz], [b.x - px, b.z - pz], [b.x + px, b.z + pz], [a.x + px, a.z + pz]].map(([x, z]) => x + ',' + svgY(z)).join(' ');
        return (
          <g key={key}>
            <polygon points={pts} fill="none" stroke={HL} strokeWidth={sw} />
            <circle cx={a.x} cy={svgY(a.z)} r={dr} fill={HL} />
            <circle cx={b.x} cy={svgY(b.z)} r={dr} fill={HL} />
          </g>
        );
      }
      if (sel.kind === 'area') {
        const ar = (graph.areas && graph.areas[sel.idx]) || { points: [] };
        return (
          <g key={key}>
            <polygon points={(ar.points || []).map((p) => p.x + ',' + svgY(p.z)).join(' ')} fill="none" stroke={HL} strokeWidth={sw} />
            {(ar.points || []).map((pt, ii) => <circle key={ii} cx={pt.x} cy={svgY(pt.z)} r={dr} fill={HL} />)}
          </g>
        );
      }
      if (sel.kind === 'stand') {
        const st = graph.stands[sel.idx]; if (!st) return null;
        const nose = n[st.noseIdx], tail = n[st.tailIdx];
        if (!nose) return null;
        const baseDiagForSel = baseVB ? Math.max(baseVB[2], baseVB[3]) : (viewBox ? Math.max(viewBox[2], viewBox[3]) : 60);
        const fixedWorldSizeSel = baseDiagForSel * 0.028 / 2.4;
        const iconHalf = fixedWorldSizeSel / 2 || 0.6;
        const half = iconHalf * 1.15;
        return (
          <g key={key}>
            {tail && <line x1={nose.x} y1={svgY(nose.z)} x2={tail.x} y2={svgY(tail.z)} stroke={HL} strokeWidth={sw * 1.2} opacity={0.95} />}
            <rect x={nose.x - half} y={svgY(nose.z) - half} width={half * 2} height={half * 2} fill="none" stroke={HL} strokeWidth={sw} rx={half * 0.18} opacity={0.95} />
            <rect x={nose.x - half * 1.25} y={svgY(nose.z) - half * 1.25} width={half * 2.5} height={half * 2.5} fill="none" stroke="#fff" strokeWidth={sw * 0.55} rx={half * 0.22} opacity={0.9} />
            <circle cx={nose.x} cy={svgY(nose.z)} r={dr * 0.55} fill={HL} />
            {tail && <circle cx={tail.x} cy={svgY(tail.z)} r={dr * 0.85} fill="none" stroke={HL} strokeWidth={sw} />}
          </g>
        );
      }
      return null;
    };
    return <>{allSels.map((s, i) => renderOne(s, `${s.kind}-${s.idx}-${i}`))}</>;
  };

  // Floating runway endpoint editors — threshold name boxes outward beyond each end.
  // For a vertical runway (dx≈0) the boxes must be directly above the north threshold
  // and directly below the south threshold.  We achieve this with a fixed *screen-pixel*
  // offset along the runway's screen direction, so the gap is constant regardless of zoom.
  // Uses SVG CTM for accurate mapping (handles preserveAspectRatio letterboxing).
  const runwayOverlay = (() => {
    if (!selected || selected.kind !== 'runway' || !graph || !viewBox || !svgRef.current) return null;
    const rw = graph.runways[selected.idx];
    if (!rw) return null;
    const a = graph.nodes[rw.thAIdx], b = graph.nodes[rw.thBIdx];
    if (!a || !b) return null;
    const names = Array.isArray(rw.names) ? rw.names : [rw.name || '', (rw.physicalName || '').split('/')[1] || ''];
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null;
    // Accurate world->screen via SVG CTM (handles viewBox + preserveAspectRatio)
    const toScreenAccurate = (wx, wz) => {
      if (ctm && svg.createSVGPoint) {
        const pt = svg.createSVGPoint();
        pt.x = wx; pt.y = svgY(wz);
        const sp = pt.matrixTransform(ctm);
        return { x: sp.x - rect.left, y: sp.y - rect.top };
      }
      // Fallback: manual viewBox math
      const [vx, vy, vw, vh] = viewBox;
      const sx = ((wx - vx) / vw) * rect.width;
      const sy = ((svgY(wz) - vy) / vh) * rect.height;
      return { x: sx, y: sy };
    };
    // Thresholds in screen space
    const paThresh = toScreenAccurate(a.x, a.z);
    const pbThresh = toScreenAccurate(b.x, b.z);
    const dxS = pbThresh.x - paThresh.x;
    const dyS = pbThresh.y - paThresh.y;
    const lenS = Math.hypot(dxS, dyS) || 1;
    const uxS = dxS / lenS;
    const uyS = dyS / lenS;
    const pixelOff = 26; // screen pixels beyond threshold (center of 46×20 box)
    const pa = { x: paThresh.x - uxS * pixelOff, y: paThresh.y - uyS * pixelOff };
    const pb = { x: pbThresh.x + uxS * pixelOff, y: pbThresh.y + uyS * pixelOff };
    const inputStyle = { width: 46, height: 20, background: '#0a1628', color: '#ffd34d', border: '1px solid #ffd34d', borderRadius: 3, textAlign: 'center', fontSize: 12, fontWeight: 700, outline: 'none' };
    return (
      <>
        <input type="text" value={names[0] || ''} onChange={(e) => handleRunwayNamesChange([e.target.value, names[1]])} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} maxLength={3} style={{ position: 'absolute', left: pa.x - 23, top: pa.y - 10, ...inputStyle, pointerEvents: 'auto' }} />
        <input type="text" value={names[1] || ''} onChange={(e) => handleRunwayNamesChange([names[0], e.target.value])} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} maxLength={3} style={{ position: 'absolute', left: pb.x - 23, top: pb.y - 10, ...inputStyle, pointerEvents: 'auto' }} />
      </>
    );
  })();

  // ── Stand heading slider overlay — parked right next to selected plane icon
  // HEAD = plane icon (nose), TAIL = HEAD + offset*deg (tail behind HEAD)
  const standSliderOverlay = (() => {
    if (!selected || selected.kind !== 'stand' || !graph || !viewBox || !svgRef.current) return null;
    const st = graph.stands[selected.idx];
    if (!st) return null;
    const nose = graph.nodes[st.noseIdx];
    if (!nose) return null;
    const hdg = normalizeHeading(st.heading || 360);
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null;
    const toScreen = (wx, wz) => {
      if (ctm && svg.createSVGPoint) {
        const pt = svg.createSVGPoint();
        pt.x = wx; pt.y = svgY(wz);
        const sp = pt.matrixTransform(ctm);
        return { x: sp.x - rect.left, y: sp.y - rect.top };
      }
      const [vx, vy, vw, vh] = viewBox;
      const sx = ((wx - vx) / vw) * rect.width;
      const sy = ((svgY(wz) - vy) / vh) * rect.height;
      return { x: sx, y: sy };
    };
    const noseScr = toScreen(nose.x, nose.z);
    const nameVal = st.name || '';
    // Park to the right of HEAD (east in screen space) with fallback to left if near edge
    const panelW = 240, panelH = 74;
    let left = noseScr.x + 22;
    let top = noseScr.y - panelH / 2;
    if (left + panelW > rect.width - 8) left = noseScr.x - panelW - 22;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (top + panelH > rect.height - 8) top = rect.height - panelH - 8;
    const stop = (e) => e.stopPropagation();
    return (
      <div
        className="gp-stand-slider"
        onClick={stop}
        onMouseDown={stop}
        style={{ position: 'absolute', left, top, width: panelW, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: 6, background: '#0a1628', border: '1px solid #ffd34d', borderRadius: 6, padding: '6px 8px', boxShadow: '0 4px 16px rgba(0,0,0,0.45)' }}
      >
        <input
          type="text"
          value={nameVal}
          maxLength={20}
          placeholder=""
          onChange={(e) => updateStandName(selected.idx, e.target.value)}
          onClick={stop}
          onMouseDown={stop}
          style={{ flex: 1, background: '#1a2332', color: '#ffd34d', border: '1px solid #4a5568', borderRadius: 3, padding: '2px 6px', fontSize: 12, outline: 'none' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="range"
            min={1}
            max={360}
            value={hdg}
            className="gp-heading-range gp-plane-thumb"
            style={{ '--hdg': `${hdg}deg`, '--thumb-plane': `url("${PLANE_THUMB_URI}")`, flex: 1 } }
            onMouseDown={handleStandHeadingSliderStart}
            onTouchStart={handleStandHeadingSliderStart}
            onMouseUp={handleStandHeadingSliderEnd}
            onTouchEnd={handleStandHeadingSliderEnd}
            onBlur={handleStandHeadingSliderEnd}
            onChange={(e) => updateStandHeading(selected.idx, e.target.value)}
          />
          <span style={{ color: '#ffd34d', fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right', userSelect: 'none' }}>{pad3(hdg)}°</span>
        </div>
      </div>
    );
  })();

  // ── Taxiway name overlay — parked below the selected segment's length (distance) label ──
  const segmentNameOverlay = (() => {
    if (!selected || selected.kind !== 'segment' || !graph || !viewBox || !svgRef.current) return null;
    const sg = graph.segments[selected.idx];
    if (!sg) return null;
    const idxs = segNodeIdxs(sg);
    const pts = idxs.map((ni) => graph.nodes[ni]).filter(Boolean);
    if (pts.length < 2) return null;
    // Midpoint = centroid of the segment's polyline (same as the length label).
    let mx = 0, mz = 0;
    for (const p of pts) { mx += p.x; mz += p.z; }
    mx /= pts.length; mz /= pts.length;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null;
    const toScreen = (wx, wz) => {
      if (ctm && svg.createSVGPoint) {
        const pt = svg.createSVGPoint();
        pt.x = wx; pt.y = svgY(wz);
        const sp = pt.matrixTransform(ctm);
        return { x: sp.x - rect.left, y: sp.y - rect.top };
      }
      const [vx, vy, vw, vh] = viewBox;
      const sx = ((wx - vx) / vw) * rect.width;
      const sy = ((svgY(wz) - vy) / vh) * rect.height;
      return { x: sx, y: sy };
    };
    const mid = toScreen(mx, mz);
    const nameVal = sg.name || '';
    // Match the ON-SCREEN width of the selected segment's length/distance label
    // box (same font metrics as the SVG length label) so the name box reads as its
    // pair rather than a wide strip. `lenText` comes from the same meters value
    // the distance box shows.
    const lenM = segmentLengthMeters(graph, selected.idx);
    const lenText = formatLengthMeters(lenM);
    const lFont = DOT_R * 2.6;
    const lCharW = lFont * 0.56;
    const lPadX = lFont * 0.5;
    const scaleX = ctm ? Math.abs(ctm.a) : pxScale;
    const distBoxW = (lenText.length * lCharW + lPadX * 2) * scaleX;
    const dispW = Math.max(distBoxW, 56); // small floor so the box stays typable
    const rowH = 26;
    let left = mid.x - dispW / 2;
    let top = mid.y + 24; // below the length/distance box (which sits above the midpoint)
    if (left < 8) left = 8;
    if (left + dispW > rect.width - 8) left = rect.width - dispW - 8;
    if (top < 8) top = 8;
    if (top + rowH > rect.height - 8) top = rect.height - rowH - 8;
    return (
      <div
        style={{ position: 'absolute', left, top, width: dispW, boxSizing: 'border-box', pointerEvents: 'auto', background: '#0a1628', border: '1px solid #ffd34d', borderRadius: 6, padding: '3px', boxShadow: '0 4px 16px rgba(0,0,0,0.45)' }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          value={nameVal}
          maxLength={24}
          placeholder=""
          onChange={(e) => updateSegmentName(selected.idx, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{ width: '100%', boxSizing: 'border-box', background: '#1a2332', color: '#ffd34d', border: '1px solid #4a5568', borderRadius: 3, padding: '2px 6px', fontSize: 12, outline: 'none' }}
        />
      </div>
    );
  })();

  // ── Background image rotation slider overlay — appears when bg image is selected
  const bgRotationOverlay = (() => {
    if (!selected || selected.kind !== 'bgImage' || !bgImage || !viewBox || !svgRef.current) return null;
    const h = getBgRotationHandleWorld(bgImage);
    const b = getBgBounds(bgImage);
    if (!h || !b) return null;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null;
    const toScreen = (wx, wz) => {
      if (ctm && svg.createSVGPoint) {
        const pt = svg.createSVGPoint();
        pt.x = wx; pt.y = svgY(wz);
        const sp = pt.matrixTransform(ctm);
        return { x: sp.x - rect.left, y: sp.y - rect.top };
      }
      const [vx, vy, vw, vh] = viewBox;
      const sx = ((wx - vx) / vw) * rect.width;
      const sy = ((svgY(wz) - vy) / vh) * rect.height;
      return { x: sx, y: sy };
    };
    const rot = normalizeBgRotation(bgImage.rotation || 0);
    const handleScr = toScreen(h.x, h.z);
    const panelW = 220, panelH = 36;
    let left = handleScr.x + 16;
    let top = handleScr.y - panelH / 2;
    if (left + panelW > rect.width - 8) left = handleScr.x - panelW - 16;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (top + panelH > rect.height - 8) top = rect.height - panelH - 8;
    return (
      <div
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ position: 'absolute', left, top, width: panelW, pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 8, background: '#0a1628', border: '1px solid #6aa0ff', borderRadius: 6, padding: '6px 8px', boxShadow: '0 4px 16px rgba(0,0,0,0.45)' }}
      >
        <span style={{ color: '#6aa0ff', fontSize: 11, fontWeight: 700, minWidth: 42, userSelect: 'none' }}>旋转 {rot}°</span>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={rot}
          onChange={(e) => updateBgImage({ rotation: normalizeBgRotation(Number(e.target.value)) })}
          style={{ flex: 1, accentColor: '#6aa0ff' }}
        />
        <button
          onClick={(e) => { e.stopPropagation(); updateBgImage({ rotation: 0 }); }}
          title="重置旋转"
          style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1a2332', border: '1px solid #4a5568', borderRadius: 4, color: '#a0aec0', cursor: 'pointer', fontSize: 12 }}
        >
          ↺
        </button>
      </div>
    );
  })();

  // ── Fillet floating slider + confirm/cancel — appears after two valid picks
  const filletOverlay = (() => {
    if (tool !== TOOL_CURVE) return null;
    if (!graph || !viewBox || !svgRef.current) return null;
    if (filletPicks.length < 1) return null;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null;
    const toScreen = (wx, wz) => {
      if (ctm && svg.createSVGPoint) {
        const pt = svg.createSVGPoint();
        pt.x = wx; pt.y = svgY(wz);
        const sp = pt.matrixTransform(ctm);
        return { x: sp.x - rect.left, y: sp.y - rect.top };
      }
      const [vx, vy, vw, vh] = viewBox;
      const sx = ((wx - vx) / vw) * rect.width;
      const sy = ((svgY(wz) - vy) / vh) * rect.height;
      return { x: sx, y: sy };
    };
    // anchor at intersection O (or midpoint of t1/t2 if available); with one
    // pick (hint panel only), anchor at the picked segment's midpoint
    let anchor = null;
    if (filletPicks.length < 2) {
      const sgA = graph.segments[filletPicks[0]];
      if (sgA) {
        const pts = segNodeIdxs(sgA).map((ni) => graph.nodes[ni]).filter(Boolean);
        if (pts.length >= 2) anchor = { x: (pts[0].x + pts[pts.length - 1].x) / 2, z: (pts[0].z + pts[pts.length - 1].z) / 2 };
      }
    } else if (filletPreview && filletPreview.o) anchor = filletPreview.o;
    else if (filletPreview && filletPreview.center) anchor = filletPreview.center;
    else {
      // fallback: midpoint of the two picked segments' midpoints
      const sgA = graph.segments[filletPicks[0]];
      const sgB = graph.segments[filletPicks[1]];
      if (sgA && sgB) {
        const aPts = segNodeIdxs(sgA).map((ni) => graph.nodes[ni]).filter(Boolean);
        const bPts = segNodeIdxs(sgB).map((ni) => graph.nodes[ni]).filter(Boolean);
        if (aPts.length >= 2 && bPts.length >= 2) {
          const amx = (aPts[0].x + aPts[aPts.length-1].x)/2, amz = (aPts[0].z + aPts[aPts.length-1].z)/2;
          const bmx = (bPts[0].x + bPts[bPts.length-1].x)/2, bmz = (bPts[0].z + bPts[bPts.length-1].z)/2;
          anchor = { x: (amx+bmx)/2, z: (amz+bmz)/2 };
        }
      }
    }
    if (!anchor) return null;
    const scr = toScreen(anchor.x, anchor.z);
    const panelW = filletPicks.length < 2 ? 190 : 300, panelH = 48;
    let left = scr.x + 18;
    let top = scr.y - panelH/2;
    if (left + panelW > rect.width - 8) left = scr.x - panelW - 18;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (top + panelH > rect.height - 8) top = rect.height - panelH - 8;
    const hasError = filletPreview && filletPreview.error;
    return (
      <div
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ position: 'absolute', left, top, width: panelW, pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 8, background: '#0a1628', border: `1px solid ${hasError ? '#ff6b6b' : '#3fdc6e'}`, borderRadius: 8, padding: '8px 10px', boxShadow: '0 4px 16px rgba(0,0,0,0.45)' }}
      >
        {filletPicks.length < 2 ? (
          <span style={{ color: '#ffd34d', fontSize: 12, flex: 1 }}>{t('ground_painter_fillet_pick_second') || 'pick second'}</span>
        ) : hasError ? (
          <span style={{ color: '#ff6b6b', fontSize: 12, flex: 1 }}>{filletPreview.errorParams ? t(filletPreview.error, filletPreview.errorParams) : t(filletPreview.error)}</span>
        ) : (
          <input
            type="range"
            min={0.5}
            max={5.0}
            step={0.05}
            value={filletRadius}
            onChange={(e) => setFilletRadius(parseFloat(e.target.value))}
            title={t('ground_painter_fillet_radius') || 'Fillet radius'}
            aria-label={t('ground_painter_fillet_radius') || 'Fillet radius'}
            style={{ flex: 1 }}
          />
        )}
        <button
          onClick={(e) => { e.stopPropagation(); resetFillet(); }}
          title={t('modal_btn_cancel') || '取消'}
          style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1a2332', border: '1px solid #4a5568', borderRadius: 4, color: '#a0aec0', cursor: 'pointer' }}
        >
          <IoClose size={16} />
        </button>
        {filletPicks.length >= 2 && (
          <button
            onClick={(e) => { e.stopPropagation(); commitFillet(filletPicks[0], filletPicks[1], filletRadius); }}
            disabled={!!hasError}
            title={t('modal_btn_confirm_save') || '确认 (Enter)'}
            aria-label={t('ground_painter_fillet_ready') || 'press Enter to confirm'}
            style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: hasError ? '#2d3748' : '#3fdc6e', border: `1px solid ${hasError ? '#4a5568' : '#3fdc6e'}`, borderRadius: 4, color: hasError ? '#718096' : '#0a1628', cursor: hasError ? 'not-allowed' : 'pointer', opacity: hasError ? 0.5 : 1 }}
          >
            <IoCheckmark size={16} />
          </button>
        )}
      </div>
    );
  })();

  return createPortal(
    <div className="ground-painter">
      <div className="ground-painter-canvas" style={{ position: 'relative' }}>
        {viewBox ? (
          <>
            <svg ref={svgRef} viewBox={viewBox.join(' ')} width="100%" height="100%" onMouseMove={onMove} onMouseDown={onMouseDown} onMouseUp={onMouseUp} onClick={onClick} onDoubleClick={onDblClick} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()}>
              {render()}
            </svg>
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {runwayOverlay}
              {standSliderOverlay}
              {segmentNameOverlay}
              {bgRotationOverlay}
              {filletOverlay}
            </div>
          </>
        ) : (
          <div className="gp-empty">Loading scenery…</div>
        )}
      </div>

      <GroundPainterToolbar
        tool={tool}
        onTool={(id) => { cancelPlacementInput(); setTool(id); }}
        selectEnabled={selectEnabled}
        onToggleSelect={onToggleSelect}
        hasEdited={hasEdited}
        onSave={onSavePrompt}
        onCancel={() => { resetFillet(); close(); }}
        selected={selected}
        multiSelected={multiSelected}
        onDeselect={() => { setSelected(null); setMultiSelected([]); setBoxRect(null); boxDragRef.current = null; }}
        onDelete={deleteSelected}
        onUndo={undo}
        canUndo={canUndo}
        areaType={areaType}
        onAreaType={setAreaType}
        heading={heading}
        onHeading={setHeading}
        zoomPercent={zoomPercent}
        onZoomIn={() => zoomCenter(0.8)}
        onZoomOut={() => zoomCenter(1.25)}
        onZoomReset={resetZoom}
        t={t}
        bgPanelOpen={bgPanelOpen}
        onToggleBgPanel={() => setBgPanelOpen((v) => !v)}
        hasBgImage={!!bgImage}
        bgOffsetX={bgImage ? bgImage.offsetX : 0}
        bgOffsetY={bgImage ? bgImage.offsetY : 0}
        bgScale={bgImage ? bgImage.scale : 1}
        bgRotation={bgImage ? (bgImage.rotation ?? 0) : 0}
        bgOpacity={bgImage ? (bgImage.opacity ?? 0.6) : 0.6}
        onBgOffsetX={(v) => updateBgImage({ offsetX: v })}
        onBgOffsetY={(v) => updateBgImage({ offsetY: v })}
        onBgScale={(v) => updateBgImage({ scale: v })}
        onBgRotation={(v) => updateBgImage({ rotation: normalizeBgRotation(v) })}
        onBgOpacity={(v) => updateBgImage({ opacity: v })}
        onImportImage={handleImportImage}
        onClearBgImage={clearBgImage}
        onResetBgImage={resetBgImage}
      />

      {gpError && <div className="gp-error">{gpError}</div>}
    </div>,
    document.body,
  );
}