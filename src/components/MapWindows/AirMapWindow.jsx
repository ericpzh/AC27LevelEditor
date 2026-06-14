import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import useSvgZoom from './useSvgZoom';
import useUdpAircraftState from './useUdpAircraftState';
import ControlSidebar from './ControlSidebar';
import {
  MAP_PAD_RATIO, MAP_TARGET_RATIO, MAP_PLANE_VB, MAP_ICON_PATH,
  RAD_TO_DEG, AIR_MAP_BG_OFFSETS, AIR_MAP_DEFAULT_ZOOM, NM_TO_GU,
} from '../../utils/constants';
import './AirMapWindow.css';

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
  const [showRangeRings, setShowRangeRings] = useState(false);
  const [showRouteLabels, setShowRouteLabels] = useState(false);
  const [emergencyCallSign, setEmergencyCallSign] = useState(null);
  const airMapRef = useRef(null);
  const refreshTimerRef = useRef(null);

  const { aircraft: udpAircraft, currentAirport: udpAirport } = useUdpAircraftState();

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

  // ── Fetch static data ─────────────────────────────────────
  useEffect(() => {
    if (!rootPath || !airportIcao) return;
    (async () => {
      try {
        const vals = await electronAPI.collectValues(rootPath, airportIcao);
        setStarPaths(vals?._starPaths || {});
        setSidPaths(vals?._sidPaths || {});
        setMissedAppPaths(vals?._missedAppPaths || {});
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
    setSelectedCallSign(callSign);
    if (electronAPI.sendUdpCommand) {
      electronAPI.sendUdpCommand(1, callSign);
    }
  }, [electronAPI]);

  const handleBgClick = useCallback(() => {
    setSelectedCallSign(null);
  }, []);

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

  // ── Helper: route labels at start of each path, offset perp away from airport center ──
  function renderRouteLabels(pathsObj, color) {
    const labels = [];
    const cx = rangeCenter.x;
    const cz = rangeCenter.z;
    const offsetDist = fontSize * 3.5;
    Object.entries(pathsObj || {}).forEach(([name, variants]) => {
      (variants || []).forEach((v, i) => {
        const pts = v.points || [];
        if (pts.length < 2) return;
        const p0 = pts[0];
        const p1 = pts[1];
        // Direction of first segment
        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const segLen = Math.sqrt(dx * dx + dz * dz);
        if (segLen < 1e-9) return;
        const ux = dx / segLen;
        const uz = dz / segLen;
        // Perpendicular (rotate 90° CCW in XZ)
        const px = -uz;
        const pz = ux;
        // Pick side away from airport center
        const toCx = cx - p0.x;
        const toCz = cz - p0.z;
        const dot = toCx * px + toCz * pz;
        const sx = dot > 0 ? -px : px;
        const sz = dot > 0 ? -pz : pz;
        const lx = p0.x + sx * offsetDist;
        const lz = p0.z + sz * offsetDist;
        // Determine text-anchor based on direction relative to label position
        const anchor = (lx - p0.x) > 0 ? 'start' : 'end';
        labels.push(
          <text key={'lbl-' + name + '-' + i}
            x={lx}
            y={svgY(lz) - fontSize * 0.3}
            fill={color}
            fontSize={fontSize}
            textAnchor={anchor}
            className="air-map-route-label"
          >{name}</text>
        );
      });
    });
    return labels;
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

  const RING_RADII_NM = [10, 20, 30];
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
      const endD = 15 * NM_TO_GU;
      const tickHalf = 0.5 * NM_TO_GU;
      const tickNMs = [5, 10, 15];

      // Extension from threshold a (outward)
      elements.push(
        <line key={`ext-a-${name}`}
          x1={a.x + ux * startD} y1={svgY(a.z + uz * startD)}
          x2={a.x + ux * endD}   y2={svgY(a.z + uz * endD)}
          stroke="#4080c0" strokeWidth={extLineW} opacity="0.7"
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
            stroke="#4080c0" strokeWidth={extLineW * 0.8} opacity="0.6"
          />
        );
      });

      // Extension from threshold b (outward, opposite direction)
      elements.push(
        <line key={`ext-b-${name}`}
          x1={b.x - ux * startD} y1={svgY(b.z - uz * startD)}
          x2={b.x - ux * endD}   y2={svgY(b.z - uz * endD)}
          stroke="#4080c0" strokeWidth={extLineW} opacity="0.7"
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
            stroke="#4080c0" strokeWidth={extLineW * 0.8} opacity="0.6"
          />
        );
      });
    });
    return elements;
  }, [showRunwayExt, runwayThresholds, viewBox?.w]);

  // ── Range rings ──────────────────────────────────────────
  const rangeRingElements = useMemo(() => {
    if (!showRangeRings) return null;
    const cx = rangeCenter.x;
    const cy = svgY(rangeCenter.z);
    return (
      <g>
        {RING_RADII_NM.map(nm => (
          <circle key={`ring-${nm}`}
            cx={cx} cy={cy}
            r={nm * NM_TO_GU}
            fill="none"
            stroke="#4080c0"
            strokeWidth={ringLineW}
            opacity="0.4"
          />
        ))}
      </g>
    );
  }, [showRangeRings, rangeCenter, ringLineW]);

  if (!initialViewBox) return null;

  return (
    <div className="air-map" ref={airMapRef}>
      {loading && <div className="air-map-loading"><div className="spinner" /></div>}
      {error && <div className="air-map-error">{error}</div>}
      {!loading && !error && (
        <>
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

              {/* SID + STAR routes (Type 2 / Type 0) — matching gray */}
              {renderRoutePaths(sidPaths, '#888888', 'none', 0.5)}
              {renderRoutePaths(starPaths, '#888888', 'none', 0.5)}

              {/* Route name labels (toggled) */}
              {showRouteLabels && renderRouteLabels(starPaths, '#888888')}
              {showRouteLabels && renderRouteLabels(sidPaths, '#888888')}

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
                const color = '#1a4a8a';
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
                    {sorted.map((t, i) => {
                      const isCurrent = i === 0;
                      // Trailing dots: 80% of current size, uniform; opacity -15% per step
                      const r = isCurrent ? planeScale : planeScale * 0.8;
                      const opacity = isCurrent ? 1 : Math.max(0.1, 1 - i * 0.15);
                      const sy = svgY(t.z);
                      return (
                        <circle key={'t' + t.age} cx={t.x} cy={sy} r={r}
                          fill={color} opacity={opacity}
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
                        fill={ac.callSign === selectedCallSign ? '#ffff00' : '#ffffff'}
                        fontWeight="bold"
                      >{ac.flightDirection === 0 ? 'D' : 'A'}</text>
                    )}
                    {/* Connector line from dot to label anchor */}
                    {conn && (
                      <line
                        x1={sorted[0].x} y1={svgY(sorted[0].z)}
                        x2={conn.x} y2={conn.y}
                        stroke="#ffffff" strokeWidth={fontSize * 0.04} opacity="0.6"
                      />
                    )}
                    {/* Heading line for selected aircraft */}
                    {ac.callSign === selectedCallSign && sorted.length > 0 && ac.noseDirection && (
                      <line
                        x1={sorted[0].x} y1={svgY(sorted[0].z)}
                        x2={sorted[0].x + planeScale * 12 * Math.cos(headingDeg(ac.noseDirection) * Math.PI / 180)}
                        y2={svgY(sorted[0].z) + planeScale * 12 * Math.sin(headingDeg(ac.noseDirection) * Math.PI / 180)}
                        className="air-map-heading-line"
                      />
                    )}
                    {/* Callsign label at current position */}
                    {conn && (() => {
                      const isSel = ac.callSign === selectedCallSign;
                      const labelColor = isSel ? '#ffff00' : '#ffffff';
                      const altFt = Math.round(ac.position.y / 0.3048);
                      const altStr = String(altFt).padStart(3, '0');
                      return (
                      <text
                        x={refX}
                        y={refY}
                        textAnchor="start"
                        fontSize={fontSize}
                        fill={labelColor}
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
          >
            <button
              className={'air-map-side-btn' + (showRouteLabels ? ' active' : '')}
              onClick={() => setShowRouteLabels(v => !v)}
            >{t('air_map_labels')}</button>
            <button
              className={'air-map-side-btn' + (showRangeRings ? ' active' : '')}
              onClick={() => setShowRangeRings(v => !v)}
            >{t('air_map_airspace')}</button>
            <button
              className={'air-map-side-btn' + (showRunwayExt ? ' active' : '')}
              onClick={() => setShowRunwayExt(v => !v)}
            >{t('air_map_runway_ext')}</button>
            <button
              className={'air-map-side-btn' + (showBgImage ? ' active' : '')}
              onClick={() => setShowBgImage(v => !v)}
            >{t('air_map_bg')}</button>
            <button
              className="air-map-side-btn"
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
              }}
            >{t('map_refresh')}</button>
          </ControlSidebar>
        </>
      )}
    </div>
  );
}
