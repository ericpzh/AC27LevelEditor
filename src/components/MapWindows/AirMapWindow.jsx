import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import useSvgZoom from './useSvgZoom';
import useUdpAircraftState from './useUdpAircraftState';
import {
  MAP_PAD_RATIO, MAP_TARGET_RATIO, MAP_PLANE_VB, MAP_ICON_PATH,
  RAD_TO_DEG, STAR_BG_OFFSETS,
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

  const { aircraft: udpAircraft, currentAirport: udpAirport } = useUdpAircraftState();

  // ── Set window title ───────────────────────────────────────
  useEffect(() => {
    document.title = airportIcao ? airportIcao + ' Approach Radar' : 'Approach Radar';
  }, [airportIcao]);

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

  // ── Compute data bounds ───────────────────────────────────
  // Fixed Unity coordinate system: center (0,0) ±1500 on each axis
  const dataBounds = useMemo(() => ({
    x: -1500, z: 1500, w: 3000, h: 3000,
  }), []);

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

  const { viewBox, svgRef, resetZoom, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp } = useSvgZoom(initialViewBox);

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

  // ── Helper: route labels ──────────────────────────────────
  function renderRouteLabels(pathsObj, color) {
    const labels = [];
    Object.entries(pathsObj || {}).forEach(([name, variants]) => {
      (variants || []).forEach((v) => {
        const pts = v.points || [];
        if (pts.length < 2) return;
        const mid = Math.floor(pts.length / 2);
        labels.push(
          <text key={'lbl-' + name + '-' + mid}
            x={pts[mid].x}
            y={svgY(pts[mid].z) - fontSize * 0.5}
            fill={color}
            fontSize={fontSize}
            textAnchor="middle"
            className="air-map-route-label"
          >{name}</text>
        );
      });
    });
    return labels;
  }

  // ── Background image config (dataBounds-based, per-airport tuning) ─
  const bgCfg = STAR_BG_OFFSETS[airportIcao] || { dx: 0, dy: 0 };
  const imgY = dataBounds.z - dataBounds.h;
  const imgW = bgCfg.w != null ? bgCfg.w : dataBounds.w;
  const imgH = dataBounds.h;

  if (!initialViewBox) return null;

  return (
    <div className="air-map" onWheel={handleWheel} style={bgCfg.bg ? { background: bgCfg.bg } : undefined}>
      {loading && <div className="air-map-loading"><div className="spinner" /></div>}
      {error && <div className="air-map-error">{error}</div>}
      {!loading && !error && (
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
          {bgCfg.bgUnder && (
            <rect x={dataBounds.x + bgCfg.dx} y={imgY + bgCfg.dy} width={imgW} height={imgH}
              fill={bgCfg.bgUnder} opacity={showBgImage ? 1 : 0}
              style={{ transition: 'opacity 0.3s' }} />
          )}
          {/* Map image — always in DOM (cached), opacity toggle avoids re-fetch */}
          <image
            href={`${airportIcao}_Map.png`}
            x={dataBounds.x + bgCfg.dx}
            y={imgY + bgCfg.dy}
            width={imgW}
            height={imgH}
            preserveAspectRatio="xMidYMid slice"
            opacity={showBgImage ? 0.2 : 0}
            style={{ transition: 'opacity 0.3s' }}
            onError={(e) => { e.target.style.display = 'none'; }}
          />

          {/* Missed Approach routes (Type 3) — dashed orange */}
          {renderRoutePaths(missedAppPaths, '#e09030', '6,4')}

          {/* SID routes (Type 2) — blue */}
          {renderRoutePaths(sidPaths, '#4090d0')}

          {/* STAR routes (Type 0) — white, under aircraft */}
          {renderRoutePaths(starPaths, '#888888', 'none', 0.5)}

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
                    <tspan x={refX} dy="-1.2em">{ac.callSign}</tspan>
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
      )}
      <button
        className="air-map-refresh-btn"
        onClick={() => { if (electronAPI.resetUdpAircraft) electronAPI.resetUdpAircraft(); }}
      >{t('map_refresh')}</button>
      <button
        className={'air-map-bg-toggle' + (showBgImage ? ' active' : '')}
        onClick={() => setShowBgImage(v => !v)}
      >{t('air_map_bg')}</button>
    </div>
  );
}
