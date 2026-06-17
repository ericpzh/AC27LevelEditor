import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import useSvgZoom from './useSvgZoom';
import useUdpAircraftState from './useUdpAircraftState';
import ControlSidebar from './ControlSidebar';
import SpinKnob from './SpinKnob';
import SimClock from './SimClock';
import MapHelpOverlay from './MapHelpOverlay';
import { IoHelpCircleOutline } from 'react-icons/io5';
import {
  MAP_PAD_RATIO, MAP_TARGET_RATIO, MAP_PLANE_VB, MAP_ICON_PATH,
  RAD_TO_DEG, AIR_MAP_BG_OFFSETS, AIR_MAP_DEFAULT_ZOOM, NM_TO_GU,
} from '../../utils/constants';
import { witchDirection, getSpriteViewBox, getSpriteSheet, SPRITE_SHEET_W, SPRITE_SHEET_H } from './witchMode';
import './AirMapWindow.css';
import './MapShared.css';

// ─── Constants ─────────────────────────────────────────────────

/** Pre-computed range ring levels: index 0 = 10nm gap, ..., 11 = 120nm gap. */
const RING_LEVELS = (() => {
  const levels = [];
  for (let gap = 10; gap <= 120; gap += 10) {
    const rings = [];
    for (let r = gap; r <= 240; r += gap) rings.push(r);
    levels.push(rings);
  }
  return levels;
})();

// ─── Helpers ──────────────────────────────────────────────────

/** Unity Z → SVG Y (flip, center at 0). */
function svgY(z) { return -z; }

/** Heading angle from nose direction vector (Unity coords). */
function headingDeg(noseDir) {
  if (!noseDir) return 0;
  return Math.atan2(-noseDir.z, noseDir.x) * RAD_TO_DEG;
}

// ─── AirMap full-window component ──────────────────────────────

export default function AirMapWindow({ airportIcao }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
  // Read gameRoot from URL query param — zustand store is empty in separate window
  const sp = new URLSearchParams(window.location.search);
  const rootPath = decodeURIComponent(sp.get('root') || '');

  const [starPaths, setStarPaths] = useState({});
  const [sidPaths, setSidPaths] = useState({});
  const [missedAppPaths, setMissedAppPaths] = useState({});
  const [runwayThresholds, setRunwayThresholds] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCallSign, setSelectedCallSign] = useState(null);
  const [showBgImage, setShowBgImage] = useState(false);
  const [speedToggle, setSpeedToggle] = useState(true);
  const [showRunwayExt, setShowRunwayExt] = useState(false);
  const [rangeRingLevel, setRangeRingLevel] = useState(3); // 0=gap10, ..., 3=gap40 (default)
  const [showRouteLabels, setShowRouteLabels] = useState(false);
  const [showStarPaths, setShowStarPaths] = useState(true);
  const [showSidPaths, setShowSidPaths] = useState(false);
  const [showApprPaths, setShowApprPaths] = useState(false);
  const [apprPaths, setApprPaths] = useState({});
  const [emergencyCallSign, setEmergencyCallSign] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [witchMode, setWitchMode] = useState(false);
  const [witchFrame, setWitchFrame] = useState(0);
  const witchTimerRef = useRef(null);
  const labelTimerRef = useRef(null);
  const airMapRef = useRef(null);
  const refreshTimerRef = useRef(null);

  const { aircraft: udpAircraft, currentAirport: udpAirport, simTimeUnixMs } = useUdpAircraftState();

  // ── Sync selected aircraft across ground + air map windows ──
  useEffect(() => {
    if (!electronAPI || !airportIcao) return;
    // Fetch current selection on mount (e.g. if ground map already has one selected)
    if (electronAPI.getSelectedAircraft) {
      electronAPI.getSelectedAircraft(airportIcao).then(r => {
        if (r?.callSign) setSelectedCallSign(r.callSign);
      });
    }
    const handler = (data) => {
      if (data.icao === airportIcao) setSelectedCallSign(data.callSign || null);
    };
    if (electronAPI.onAircraftSelectedInMap) {
      electronAPI.onAircraftSelectedInMap(handler);
    }
    return () => {
      if (electronAPI.offAircraftSelectedInMap) {
        electronAPI.offAircraftSelectedInMap(handler);
      }
    };
  }, [electronAPI, airportIcao]);

  // ── Set window title ───────────────────────────────────────
  useEffect(() => {
    document.title = airportIcao ? airportIcao + ' Approach Radar' : 'Approach Radar';
  }, [airportIcao]);

  // ── Dynamic background via CSS custom property (avoids inline style) ──
  const bgCfg = AIR_MAP_BG_OFFSETS[airportIcao] || { dx: 0, dy: 0 };
  useEffect(() => {
    if (airMapRef.current) {
      airMapRef.current.style.setProperty('--air-map-bg',
        showBgImage && bgCfg.bg ? bgCfg.bg : '#000000');
    }
  }, [showBgImage, bgCfg.bg]);

  // ── 5s speed/type toggle ─────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setSpeedToggle(v => !v), 5000);
    return () => clearInterval(id);
  }, []);

  // ── Witch mode animation timer (500ms per frame) ──────────────
  useEffect(() => {
    if (!witchMode) {
      if (witchTimerRef.current) {
        clearInterval(witchTimerRef.current);
        witchTimerRef.current = null;
      }
      setWitchFrame(0);
      return;
    }
    witchTimerRef.current = setInterval(() => {
      setWitchFrame(f => (f === 0 ? 1 : 0));
    }, 500);
    return () => {
      if (witchTimerRef.current) {
        clearInterval(witchTimerRef.current);
        witchTimerRef.current = null;
      }
    };
  }, [witchMode]);

  // ── Fetch static data ─────────────────────────────────────
  useEffect(() => {
    if (!rootPath || !airportIcao) return;
    (async () => {
      try {
        const vals = await electronAPI.collectValues(rootPath, airportIcao);
        setStarPaths(vals?._starPaths || {});
        setSidPaths(vals?._sidPaths || {});
        setMissedAppPaths(vals?._missedAppPaths || {});
        setApprPaths(vals?._apprPaths || {});
        setRunwayThresholds(vals?._runwayThresholds || {});
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [rootPath, airportIcao]);

  // ── Filter air aircraft for this airport only ─────────────
  const airAircraft = useMemo(() => {
    if (udpAirport && udpAirport !== airportIcao) return [];
    return udpAircraft.filter(a =>
      a.position && a.position.y > 1.0
    );
  }, [udpAircraft, udpAirport, airportIcao]);

  // ── Compute data bounds (per-airport default zoom) ────────
  const dataBounds = useMemo(() => {
    const zoom = AIR_MAP_DEFAULT_ZOOM[airportIcao] ?? 1.0;
    const halfW = 1500 * zoom;
    return { x: -halfW, z: halfW, w: halfW * 2, h: halfW * 2 };
  }, [airportIcao]);

  // ── SVG viewBox ───────────────────────────────────────────
  const initialViewBox = useMemo(() => {
    if (!dataBounds) return null;
    return {
      x: dataBounds.x,
      y: dataBounds.z - dataBounds.h,
      w: dataBounds.w,
      h: dataBounds.h,
    };
  }, [dataBounds]);

  const { viewBox, svgRef, resetZoom, resetPanH, resetPanV, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp,
          zoomIn, zoomOut, panLeft, panRight, panUp, panDown } = useSvgZoom(initialViewBox);

  // ── Stable sidebar callbacks ───────────────────────────────
  const handleZoomStep = useCallback((dir) => {
    if (dir > 0) zoomIn(); else zoomOut();
  }, [zoomIn, zoomOut]);
  const handlePanHStep = useCallback((dir) => {
    if (dir > 0) panRight(); else panLeft();
  }, [panLeft, panRight]);
  const handlePanVStep = useCallback((dir) => {
    if (dir > 0) panUp(); else panDown();
  }, [panUp, panDown]);
  const handleResetZoom = useCallback(() => resetZoom(), [resetZoom]);
  const handleResetPanH = useCallback(() => resetPanH(), [resetPanH]);
  const handleResetPanV = useCallback(() => resetPanV(), [resetPanV]);

  // ── Knob gauge positions ──────────────────────────────────
  const knobPositions = useMemo(() => {
    if (!initialViewBox || !viewBox) return { zoom: 0.5, panH: 0.5, panV: 0.5 };
    const zoomRaw = viewBox.w / initialViewBox.w;
    const zoom = (1 - zoomRaw) / 0.98;
    const initCX = initialViewBox.x + initialViewBox.w / 2;
    const initCY = initialViewBox.y + initialViewBox.h / 2;
    const curCX = viewBox.x + viewBox.w / 2;
    const curCY = viewBox.y + viewBox.h / 2;
    const panHRaw = (curCX - initCX) / (initialViewBox.w * 0.5);
    const panVRaw = (curCY - initCY) / (initialViewBox.h * 0.5);
    const panH = Math.max(0, Math.min(1, panHRaw * 0.5 + 0.5));
    const panV = Math.max(0, Math.min(1, panVRaw * 0.5 + 0.5));
    return { zoom, panH, panV };
  }, [viewBox, initialViewBox]);

  // ── Sizing ────────────────────────────────────────────────
  const vbDiag = Math.max(viewBox?.w || 1, viewBox?.h || 1);
  const routeLineW = vbDiag * 0.0015;
  const fontSize = vbDiag * 0.0138;
  const planeScale = vbDiag * 0.0064;

  // ── Select aircraft ───────────────────────────────────────
  const handleAircraftClick = useCallback((e, callSign) => {
    e.stopPropagation();
    if (electronAPI.selectAircraftInMap) {
      electronAPI.selectAircraftInMap(airportIcao, callSign);
    }
  }, [electronAPI, airportIcao]);

  const handleBgClick = useCallback(() => {
    if (electronAPI.selectAircraftInMap) {
      electronAPI.selectAircraftInMap(airportIcao, null);
    }
  }, [electronAPI, airportIcao]);

  // ── Dynamic label layout to avoid overlap ─────────────────
  const labelLayouts = useMemo(() => {
    const layouts = {};
    if (!airAircraft.length) return layouts;

    const labelGap = planeScale * 3.5;
    const labelH = fontSize * 3.6;

    // Directions to try, in preference order
    const directions = [
      { name: 'right',  conn: (d) => ({ x: d.x + labelGap, y: d.y }), anchor: 'start',  refYOff: 0,                 bboxDir: 'right' },
      { name: 'top',    conn: (d) => ({ x: d.x, y: d.y - labelGap }), anchor: 'middle', refYOff: -1.5 * fontSize,  bboxDir: 'up' },
      { name: 'left',   conn: (d) => ({ x: d.x - labelGap, y: d.y }), anchor: 'end',    refYOff: 0,                 bboxDir: 'left' },
      { name: 'bottom', conn: (d) => ({ x: d.x, y: d.y + labelGap }), anchor: 'middle', refYOff: 1.5 * fontSize,   bboxDir: 'down' },
    ];

    const getLabelW = (ac) => {
      const maxChars = Math.max(ac.callSign.length, ac.aircraftType.length, 8);
      return maxChars * fontSize * 0.65;
    };

    const getBBox = (c, d, lw) => {
      switch (d.bboxDir) {
        case 'right': return { x: c.x, y: c.y - labelH / 2, w: lw, h: labelH };
        case 'left':  return { x: c.x - lw, y: c.y - labelH / 2, w: lw, h: labelH };
        case 'up':    return { x: c.x - lw / 2, y: c.y - labelH, w: lw, h: labelH };
        case 'down':  return { x: c.x - lw / 2, y: c.y, w: lw, h: labelH };
      }
    };

    const overlaps = (a, b) =>
      !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
        a.y + a.h <= b.y || b.y + b.h <= a.y);

    // Priority: selected aircraft first, then higher altitude first
    const sorted = [...airAircraft].sort((a, b) => {
      if (a.callSign === selectedCallSign) return -1;
      if (b.callSign === selectedCallSign) return 1;
      return (b.position?.y || 0) - (a.position?.y || 0);
    });

    const placed = [];
    for (const ac of sorted) {
      if (!ac.position) continue;
      const dot = { x: ac.position.x, y: svgY(ac.position.z) };
      const lw = getLabelW(ac);
      let best = null;

      for (const d of directions) {
        const c = d.conn(dot);
        const bb = getBBox(c, d, lw);
        if (!placed.some(p => overlaps(bb, p))) {
          best = { dir: d, conn: c, bbox: bb };
          break;
        }
      }
      // Fallback: first direction if all collide
      if (!best) {
        const d = directions[0];
        const c = d.conn(dot);
        best = { dir: d, conn: c, bbox: getBBox(c, d, lw) };
      }
      placed.push(best.bbox);
      layouts[ac.callSign] = best;
    }
    return layouts;
  }, [airAircraft, selectedCallSign, planeScale, fontSize, svgY]);

  // ── Helper: render route polylines ────────────────────────
  // ── Trim STAR paths at APPR overlap so each category shows its unique portion ──
  const trimmedStarPaths = useMemo(() => {
    if (!Object.keys(apprPaths).length) return starPaths;
    // Build a set of all APPR point hashes (rounded to 0.5 GU ≈ 50m tolerance)
    const apprPointSet = new Set();
    for (const variants of Object.values(apprPaths)) {
      for (const v of (variants || [])) {
        for (const p of (v.points || [])) {
          apprPointSet.add(Math.round(p.x * 2) + ',' + Math.round(p.z * 2));
        }
      }
    }
    if (!apprPointSet.size) return starPaths;
    const trimmed = {};
    for (const [name, variants] of Object.entries(starPaths)) {
      trimmed[name] = (variants || []).map(v => {
        const pts = v.points || [];
        // Walk from start; stop at first point that appears in any APPR path
        let cutIdx = pts.length;
        for (let i = 0; i < pts.length; i++) {
          const key = Math.round(pts[i].x * 2) + ',' + Math.round(pts[i].z * 2);
          if (apprPointSet.has(key)) { cutIdx = i + 1; break; }
        }
        return { ...v, points: pts.slice(0, cutIdx) };
      }).filter(v => v.points.length >= 2);
    }
    return trimmed;
  }, [starPaths, apprPaths]);

  function renderRoutePaths(pathsObj, color, dashArray, opacity = 0.7) {
    return Object.entries(pathsObj || {}).map(([name, variants]) =>
      (variants || []).map((v, i) => {
        const ptsStr = (v.points || []).map(p => `${p.x},${svgY(p.z)}`).join(' ');
        return (
          <polyline
            key={`${name}-${i}`}
            points={ptsStr}
            fill="none"
            stroke={color}
            strokeWidth={routeLineW}
            strokeDasharray={dashArray || 'none'}
            opacity={opacity}
          />
        );
      })
    );
  }

  // ── Helper: route labels at start of each path, offset perp away from airport center,
  //     with vertical spreading to avoid overlaps ──
  function renderRouteLabels(pathsObj, color) {
    const labelMeta = [];
    const cx = rangeCenter.x;
    const cz = rangeCenter.z;
    const offsetDist = fontSize * 3.5;
    Object.entries(pathsObj || {}).forEach(([name, variants]) => {
      // Only one label per route name (first variant)
      const v = (variants || [])[0];
      if (!v) return;
      const pts = v.points || [];
      if (pts.length < 2) return;
      const p0 = pts[0];
      const p1 = pts[1];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 1e-9) return;
      const ux = dx / segLen;
      const uz = dz / segLen;
      const px = -uz;
      const pz = ux;
      const toCx = cx - p0.x;
      const toCz = cz - p0.z;
      const dot = toCx * px + toCz * pz;
      const sx = dot > 0 ? -px : px;
      const sz = dot > 0 ? -pz : pz;
      const lx = p0.x + sx * offsetDist;
      const lz = p0.z + sz * offsetDist;
      const anchor = (lx - p0.x) > 0 ? 'start' : 'end';
      labelMeta.push({ name, key: name, x: lx, z: lz, anchor });
    });
    // Sort by Z (SVG Y) so we can spread vertically
    labelMeta.sort((a, b) => a.z - b.z);
    // Spread overlapping labels apart
    const minGap = fontSize * 2.0;
    for (let i = 1; i < labelMeta.length; i++) {
      const prev = labelMeta[i - 1];
      const dz = labelMeta[i].z - prev.z;
      if (dz < minGap) {
        labelMeta[i].z = prev.z + minGap;
      }
    }
    return labelMeta.map(m => (
      <text key={'lbl-' + m.key}
        x={m.x}
        y={svgY(m.z) - fontSize * 0.3}
        fill={color}
        fontSize={fontSize}
        textAnchor={m.anchor}
        className="air-map-route-label"
      >{m.name}</text>
    ));
  }

  // ── Background image geometry ────────────────────────────
  const imgY = dataBounds.z - dataBounds.h;
  const imgW = bgCfg.w != null ? bgCfg.w : dataBounds.w;
  const imgH = dataBounds.h;

  // ── Range rings center (geometric mean of all runway thresholds) ──
  const rangeCenter = useMemo(() => {
    const rwys = runwayThresholds || {};
    const entries = Object.values(rwys);
    if (!entries.length) return { x: 0, z: 0 };
    let sx = 0, sz = 0, n = 0;
    for (const e of entries) {
      if (e.a) { sx += e.a.x; sz += e.a.z; n++; }
      if (e.b) { sx += e.b.x; sz += e.b.z; n++; }
    }
    return n ? { x: sx / n, z: sz / n } : { x: 0, z: 0 };
  }, [runwayThresholds]);

  const ringLineW = (viewBox?.w || 1) * 0.0012;

  // ── Runway extension lines + tick marks ──────────────────
  const runwayExtElements = useMemo(() => {
    if (!showRunwayExt) return null;
    const elements = [];
    const extLineW = (viewBox?.w || 1) * 0.001;
    Object.entries(runwayThresholds || {}).forEach(([name, entry]) => {
      if (!entry.a || !entry.b) return;
      const a = entry.a, b = entry.b;

      // Direction from b→a (outward from a) and a→b (outward from b)
      const dx = a.x - b.x;
      const dz = a.z - b.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-9) return;
      const ux = dx / len;   // points outward from a
      const uz = dz / len;
      // Perpendicular (rotate 90° CCW in XZ → SVG)
      const px = -uz;
      const pz = ux;

      const startD = 1 * NM_TO_GU;
      const endD = 20 * NM_TO_GU;
      const tickHalf = 0.5 * NM_TO_GU;
      const tickNMs = [5, 10, 15, 20];
      const dash = 0.8 * NM_TO_GU;

      // Extension from threshold a (outward) — dashed
      elements.push(
        <line key={`ext-a-${name}`}
          x1={a.x + ux * startD} y1={svgY(a.z + uz * startD)}
          x2={a.x + ux * endD}   y2={svgY(a.z + uz * endD)}
          stroke="#ffffff" strokeWidth={extLineW} opacity="0.7"
          strokeDasharray={`${dash} ${dash * 0.7}`}
        />
      );
      tickNMs.forEach(nm => {
        const d = nm * NM_TO_GU;
        const cx = a.x + ux * d;
        const cz = a.z + uz * d;
        elements.push(
          <line key={`tick-a-${name}-${nm}`}
            x1={cx - px * tickHalf} y1={svgY(cz - pz * tickHalf)}
            x2={cx + px * tickHalf} y2={svgY(cz + pz * tickHalf)}
            stroke="#ffffff" strokeWidth={extLineW * 0.8} opacity="0.6"
          />
        );
      });

      // Extension from threshold b (outward, opposite direction) — dashed
      elements.push(
        <line key={`ext-b-${name}`}
          x1={b.x - ux * startD} y1={svgY(b.z - uz * startD)}
          x2={b.x - ux * endD}   y2={svgY(b.z - uz * endD)}
          stroke="#ffffff" strokeWidth={extLineW} opacity="0.7"
          strokeDasharray={`${dash} ${dash * 0.7}`}
        />
      );
      tickNMs.forEach(nm => {
        const d = nm * NM_TO_GU;
        const cx = b.x - ux * d;
        const cz = b.z - uz * d;
        elements.push(
          <line key={`tick-b-${name}-${nm}`}
            x1={cx - px * tickHalf} y1={svgY(cz - pz * tickHalf)}
            x2={cx + px * tickHalf} y2={svgY(cz + pz * tickHalf)}
            stroke="#ffffff" strokeWidth={extLineW * 0.8} opacity="0.6"
          />
        );
      });
    });
    return elements;
  }, [showRunwayExt, runwayThresholds, viewBox?.w]);

  // ── Range rings ──────────────────────────────────────────
  const MAX_RING_LEVEL = RING_LEVELS.length - 1;
  const rangeRingElements = useMemo(() => {
    const radii = RING_LEVELS[rangeRingLevel];
    if (!radii) return null;
    const cx = rangeCenter.x;
    const cy = svgY(rangeCenter.z);
    return (
      <g>
        {radii.map(nm => (
          <React.Fragment key={`ring-${nm}`}>
            <circle
              cx={cx} cy={cy}
              r={nm * NM_TO_GU}
              fill="none"
              stroke="#ffffff"
              strokeWidth={ringLineW}
              opacity="0.4"
            />
            {showRouteLabels && (
              <text
                x={cx + nm * NM_TO_GU}
                y={cy}
                textAnchor="start"
                dominantBaseline="middle"
                fill="#ffffff"
                fontSize={fontSize * 0.75}
                opacity="0.5"
              >{nm}</text>
            )}
          </React.Fragment>
        ))}
      </g>
    );
  }, [rangeRingLevel, rangeCenter, ringLineW, showRouteLabels, fontSize]);

  // ── Border rect + 10° ticks (independent overlay SVG, percentage-based so it
  //     always hugs the container edges regardless of the main SVG viewBox) ──
  const borderOverlay = useMemo(() => {
    const els = [];
    const MIN_TICK = 0.5, MAX_TICK = 2.0;
    // Border rect at 0-100%
    els.push(<rect key="b" x="0" y="0" width="100" height="100" fill="none" stroke="#fff" strokeWidth="0.12" opacity="0.6" />);
    for (let d = 0; d < 360; d += 10) {
      const rad = d * Math.PI / 180, sx = Math.sin(rad), sy = -Math.cos(rad);
      const t = Math.min(Math.abs(sx) < 1e-9 ? 1e9 : 50 / Math.abs(sx), Math.abs(sy) < 1e-9 ? 1e9 : 50 / Math.abs(sy));
      const bx = 50 + sx * t, by = 50 + sy * t;
      // Tick length: short at edge centres, long at corners
      const angleFromCardinal = Math.min(d % 90, 90 - (d % 90));
      const tickLen = MIN_TICK + (MAX_TICK - MIN_TICK) * (angleFromCardinal / 45);
      els.push(<line key={'t'+d} x1={bx} y1={by} x2={bx - sx * tickLen} y2={by - sy * tickLen} stroke="#fff" strokeWidth="0.15" opacity="0.6" />);
      // Label at the tick endpoint (tick points inward from border)
      const lx = bx - sx * (tickLen + 1.2);
      const ly = by - sy * (tickLen + 1.2);
      els.push(<text key={'l'+d} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize="1.2" opacity="0.6">{String(d).padStart(3, '0')}</text>);
    }
    return (
      <div className="air-map-border-overlay">
        <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
          {els}
        </svg>
      </div>
    );
  }, []);

  if (!initialViewBox) return null;

  return (
    <div className="air-map" ref={airMapRef}>
      {loading && <div className="air-map-loading"><div className="spinner" /></div>}
      {error && <div className="air-map-error">{error}</div>}
      {!loading && !error && (
        <>
          {/* Sim time clock in top-left corner */}
          <SimClock simTimeUnixMs={simTimeUnixMs} />
          <div className="air-map-svg-container" onWheel={handleWheel}>
            <svg
              ref={svgRef}
              className="air-map-svg"
              viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
              width="100%"
              height="100%"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onClick={handleBgClick}
            >
              {/* Color behind the map image (shows through 20% opacity) */}
              {showBgImage && bgCfg.bgUnder && (
                <rect x={dataBounds.x + bgCfg.dx} y={imgY + bgCfg.dy} width={imgW} height={imgH}
                  fill={bgCfg.bgUnder} opacity={1} />
              )}
              {/* Map image */}
              {showBgImage && (
              <image
                href={`${airportIcao}_Map.png`}
                x={dataBounds.x + bgCfg.dx}
                y={imgY + bgCfg.dy}
                width={imgW}
                height={imgH}
                preserveAspectRatio="xMidYMid slice"
                opacity="0.2"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
              )}

              {/* Range rings (behind routes) */}
              {rangeRingElements}

              {/* SID / STAR / APPR routes — each toggleable */}
              {showSidPaths && renderRoutePaths(sidPaths, '#888888', 'none', 0.5)}
              {showSidPaths && renderRoutePaths(missedAppPaths, '#888888', 'none', 0.5)}
              {showStarPaths && renderRoutePaths(trimmedStarPaths, '#888888', 'none', 0.5)}
              {showApprPaths && renderRoutePaths(apprPaths, '#888888', 'none', 0.5)}

              {/* Route name labels — only for categories whose toggle is on */}
              {showRouteLabels && showStarPaths && renderRouteLabels(trimmedStarPaths, '#888888')}
              {showRouteLabels && showSidPaths && renderRouteLabels(sidPaths, '#888888')}
              {showRouteLabels && showApprPaths && renderRouteLabels(apprPaths, '#888888')}

              {/* Runway extension lines + ticks */}
              {runwayExtElements}

              {/* Runway thresholds */}
              {Object.entries(runwayThresholds || {}).map(([name, entry]) => (
                <line key={'rwy-' + name}
                  x1={entry.a.x} y1={svgY(entry.a.z)}
                  x2={entry.b.x} y2={svgY(entry.b.z)}
                  stroke="#666" strokeWidth={routeLineW * 1.5} />
              ))}

              {/* Live air aircraft — trail circles */}
              {airAircraft.map((ac) => {
                const isDeparture = ac.flightDirection === 0;
                const labelColor = isDeparture ? '#66ff66' : '#ffffff';
                const trail = ac.trail || [];
                // Sort by age ascending (current first)
                const sorted = [...trail].sort((a, b) => a.age - b.age);
                // Dynamic label layout for this aircraft
                const layout = sorted.length > 0 ? labelLayouts[ac.callSign] : null;
                const conn = layout?.conn;
                const dir = layout?.dir;
                const refX = conn
                  ? dir.anchor === 'end' ? conn.x - fontSize * 0.3
                    : dir.anchor === 'middle' ? conn.x
                    : conn.x + fontSize * 0.3
                  : 0;
                const refY = conn ? conn.y + dir.refYOff : 0;
                return (
                  <g key={'ac-' + ac.callSign} className="air-map-aircraft-group"
                    onClick={(e) => handleAircraftClick(e, ac.callSign)}>
                    {sorted.length > 0 && witchMode ? (
                      // ── Witch sprite (sprite sheet via viewBox clip) ──
                      (() => {
                        const cur = sorted[0];
                        const dir = witchDirection(ac.noseDirection);
                        const vb = getSpriteViewBox('fly', dir, witchFrame + 1);
                        const sz = planeScale * 12;
                        return (
                          <svg key="ws" x={cur.x - sz / 2} y={svgY(cur.z) - sz / 2}
                            width={sz} height={sz} viewBox={vb}
                            style={{ pointerEvents: 'none' }}>
                            <image href={getSpriteSheet(ac.callSign)}
                              width={SPRITE_SHEET_W} height={SPRITE_SHEET_H} />
                          </svg>
                        );
                      })()
                    ) : (
                      <>
                        {sorted.map((t, i) => {
                          const isCurrent = i === 0;
                          // Trailing dots: 80% of current size, uniform; opacity -15% per step
                          const r = isCurrent ? planeScale : planeScale * 0.8;
                          const opacity = isCurrent ? 1 : Math.max(0.1, 1 - i * 0.15);
                          const sy = svgY(t.z);
                          return (
                            <circle key={'t' + t.age} cx={t.x} cy={sy} r={r}
                              fill="#1a4a8a" opacity={opacity}
                            />
                          );
                        })}
                        {/* A/D indicator on current dot */}
                        {sorted.length > 0 && (
                          <text
                            x={sorted[0].x + planeScale * 1.5}
                            y={svgY(sorted[0].z) - planeScale * 1.5}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fontSize={fontSize * 1.15}
                            fill={ac.callSign === selectedCallSign ? '#ffff00' : labelColor}
                            fontWeight="bold"
                          >{isDeparture ? 'D' : 'A'}</text>
                        )}
                      </>
                    )}
                    {/* Connector line from dot to label anchor */}
                    {!witchMode && conn && (
                      <line
                        x1={sorted[0].x} y1={svgY(sorted[0].z)}
                        x2={conn.x} y2={conn.y}
                        stroke={labelColor} strokeWidth={fontSize * 0.04} opacity="0.6"
                      />
                    )}
                    {/* Heading line for selected aircraft */}
                    {!witchMode && ac.callSign === selectedCallSign && sorted.length > 0 && ac.noseDirection && (
                      <line
                        x1={sorted[0].x} y1={svgY(sorted[0].z)}
                        x2={sorted[0].x + planeScale * 12 * Math.cos(headingDeg(ac.noseDirection) * Math.PI / 180)}
                        y2={svgY(sorted[0].z) + planeScale * 12 * Math.sin(headingDeg(ac.noseDirection) * Math.PI / 180)}
                        className="air-map-heading-line"
                      />
                    )}
                    {/* Callsign label at current position */}
                    {!witchMode && conn && (() => {
                      const isSel = ac.callSign === selectedCallSign;
                      const callLabelColor = isSel ? '#ffff00' : labelColor;
                      const altFt = Math.round(ac.position.y / 0.3048);
                      const altStr = String(altFt).padStart(3, '0');
                      return (
                      <text
                        x={refX}
                        y={refY}
                        textAnchor="start"
                        fontSize={fontSize}
                        fill={callLabelColor}
                      >
                        {emergencyCallSign === ac.callSign && (
                          <tspan x={refX} dy="-2.4em" className="air-map-em-label">EM</tspan>
                        )}
                        <tspan x={refX} dy={emergencyCallSign === ac.callSign ? '1.2em' : '-1.2em'}>{ac.callSign}</tspan>
                        <tspan x={refX} dy="1.2em">
                          {altStr}{' '}
                          {speedToggle
                            ? String(Math.round(ac.airSpeedKnot / 10)).padStart(2, '0')
                            : ac.aircraftType}
                        </tspan>
                      </text>
                      );
                    })()}
                  </g>
                );
              })}

            </svg>
            {/* Border rect + 10° ticks — independent overlay SVG, always hugs container edges */}
            {borderOverlay}
          </div>
          <ControlSidebar
            zoomStep={handleZoomStep}
            panHStep={handlePanHStep}
            panVStep={handlePanVStep}
            zoomPos={knobPositions.zoom}
            panHPos={knobPositions.panH}
            panVPos={knobPositions.panV}
            onResetZoom={handleResetZoom}
            onResetPanH={handleResetPanH}
            onResetPanV={handleResetPanV}
            airspaceKnob={
              <SpinKnob label="AIRSPACE" onStep={(dir) => setRangeRingLevel(l => Math.max(0, Math.min(MAX_RING_LEVEL, l + dir)))} position={rangeRingLevel / MAX_RING_LEVEL} onReset={() => setRangeRingLevel(3)} />
            }
          >
            <div className={'air-map-toggle' + (showStarPaths ? ' active' : '')}
              onClick={() => setShowStarPaths(v => !v)}>
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">{t('air_map_star')}</span>
            </div>
            <div className={'air-map-toggle' + (showSidPaths ? ' active' : '')}
              onClick={() => setShowSidPaths(v => !v)}>
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">{t('air_map_sid')}</span>
            </div>
            <div className={'air-map-toggle' + (showApprPaths ? ' active' : '')}
              onClick={() => setShowApprPaths(v => !v)}>
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">{t('air_map_appr')}</span>
            </div>
            <div className={'air-map-toggle' + (showRouteLabels ? ' active' : '')}
              onClick={() => {
                if (witchMode) {
                  // Already in witch mode — any click exits and does normal action
                  setWitchMode(false);
                  setShowRouteLabels(v => !v);
                } else if (labelTimerRef.current) {
                  // Double-click: enter witch mode
                  clearTimeout(labelTimerRef.current);
                  labelTimerRef.current = null;
                  setWitchMode(true);
                } else {
                  // First click: wait for potential double-click
                  labelTimerRef.current = setTimeout(() => {
                    labelTimerRef.current = null;
                    setShowRouteLabels(v => !v);
                  }, 300);
                }
              }}>
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">{t('air_map_labels')}</span>
            </div>
            <div className={'air-map-toggle' + (showRunwayExt ? ' active' : '')}
              onClick={() => setShowRunwayExt(v => !v)}>
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">{t('air_map_runway_ext')}</span>
            </div>
            <div className={'air-map-toggle' + (showBgImage ? ' active' : '')}
              onClick={() => setShowBgImage(v => !v)}>
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">{t('air_map_bg')}</span>
            </div>
            <div className="air-map-toggle"
              onClick={() => {
                if (refreshTimerRef.current) {
                  // Double-click: EM pick + reset
                  clearTimeout(refreshTimerRef.current);
                  refreshTimerRef.current = null;
                  const current = airAircraft;
                  if (current.length > 0) {
                    const ri = Math.floor(Math.random() * current.length);
                    setEmergencyCallSign(current[ri].callSign);
                  } else {
                    setEmergencyCallSign(null);
                  }
                  if (electronAPI.resetUdpAircraft) electronAPI.resetUdpAircraft();
                } else {
                  // Single click: wait for potential double-click, then reset
                  refreshTimerRef.current = setTimeout(() => {
                    refreshTimerRef.current = null;
                    if (electronAPI.resetUdpAircraft) electronAPI.resetUdpAircraft();
                  }, 300);
                }
              }}>
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">{t('map_refresh')}</span>
            </div>
            <div className="map-help-btn"
              onClick={() => setHelpOpen(true)}>
              <div className="map-help-btn-icon"><IoHelpCircleOutline size={22} /></div>
            </div>
          </ControlSidebar>
        </>
      )}
      {helpOpen && <MapHelpOverlay type="air" onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
