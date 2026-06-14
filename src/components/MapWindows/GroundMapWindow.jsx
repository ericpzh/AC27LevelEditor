import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import useSvgZoom from './useSvgZoom';
import useUdpAircraftState from './useUdpAircraftState';
import { RAD_TO_DEG, MAP_ICON_PATH } from '../../utils/constants';
import './GroundMapWindow.css';

// ─── Helpers ──────────────────────────────────────────────────────

/** Unity Z → SVG Y (flip). */
function svgY(z) { return -z; }

/** Heading angle from nose direction vector (Unity coords). */
function headingDeg(noseDir) {
  if (!noseDir) return 0;
  return Math.atan2(-noseDir.z, noseDir.x) * RAD_TO_DEG;
}

/** Compute 4 corner points of a runway rectangle from centerline endpoints. */
function computeRunwayCorners(a, b, halfWidth) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-9) return null;
  const px = dz / len;
  const pz = -dx / len;
  const hx = px * halfWidth;
  const hz = pz * halfWidth;
  return [
    { x: a.x - hx, z: a.z - hz },
    { x: a.x + hx, z: a.z + hz },
    { x: b.x + hx, z: b.z + hz },
    { x: b.x - hx, z: b.z - hz },
  ];
}

// ─── GroundMap full-window component ────────────────────────────

export default function GroundMapWindow({ airportIcao }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
  const sp = new URLSearchParams(window.location.search);
  const rootPath = decodeURIComponent(sp.get('root') || '');

  const [taxiwayPaths, setTaxiwayPaths] = useState([]);
  const [runwayData, setRunwayData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCallSign, setSelectedCallSign] = useState(null);

  const { aircraft: udpAircraft, currentAirport: udpAirport } = useUdpAircraftState();

  // ── Set window title ───────────────────────────────────────
  useEffect(() => {
    document.title = airportIcao ? airportIcao + ' Surface Radar' : 'Surface Radar';
  }, [airportIcao]);

  // ── Fetch static data from ACL cache ──────────────────────
  useEffect(() => {
    if (!rootPath || !airportIcao) return;
    (async () => {
      try {
        const vals = await electronAPI.collectValues(rootPath, airportIcao);
        setTaxiwayPaths(vals?._taxiwayPaths?.paths || []);
        setRunwayData(vals?._runwayData || {});
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [rootPath, airportIcao]);

  // ── Filter ground aircraft for this airport only ──────────
  const groundAircraft = useMemo(() => {
    if (udpAirport && udpAirport !== airportIcao) return [];
    return udpAircraft.filter(a => a.airSpeedKnot === 0 && a.route);
  }, [udpAircraft, udpAirport, airportIcao]);

  // ── Fixed ground box: center (0,0) ±30 on each axis ─────
  const dataBounds = useMemo(() => ({
    x: -30, z: 30, w: 60, h: 60,
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

  // ── Sizing relative to viewBox ─────────────────────────────
  const vbW = viewBox?.w || 1;
  const vbH = viewBox?.h || 1;
  const vbDiag = Math.max(vbW, vbH);
  const fontSize = vbDiag * 0.0155;
  const planeScale = vbDiag * 0.012;
  const labelOff = vbDiag * 0.03;
  const taxiwayW = vbDiag * 0.0075;
  const runwayStrokeW = vbDiag * 0.01;

  // ── Icon scale: MAP_ICON_PATH is 512×512 viewBox ────────
  const iconScale = planeScale / 256; // planeScale is desired icon half-size

  if (!initialViewBox) return null;

  return (
    <div className="ground-map" onWheel={handleWheel}>
      {loading && <div className="ground-map-loading"><div className="spinner" /></div>}
      {error && <div className="ground-map-error">{error}</div>}
      {!loading && !error && (
        <svg
          ref={svgRef}
          className="ground-map-svg"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          width="100%"
          height="100%"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={() => setSelectedCallSign(null)}
        >
          {/* Background — radar blue */}
          <rect x={viewBox.x} y={viewBox.y} width={viewBox.w} height={viewBox.h} fill="#0a1628" />

          {/* ── Layer 1: Taxiway centerlines (grey) ────────── */}
          {taxiwayPaths.map((tp, i) => {
            const color = tp.flags === 2 ? '#555' : tp.flags === 4 ? '#666' : '#444';
            return (
              <g key={'twy-' + i}>
                <polyline
                  points={tp.points.map(p => `${p.x},${svgY(p.z)}`).join(' ')}
                  fill="none"
                  stroke={color}
                  strokeWidth={taxiwayW}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}

          {/* ── Layer 2: Runway rectangles (black, on top) ──── */}
          {Object.entries(runwayData).map(([name, rw]) => {
            if (!rw.thresholds || rw.thresholds.length < 2) return null;
            const a = rw.thresholds[0];
            const b = rw.thresholds[1];
            const halfW = (rw.width || 0.50) / 2;
            const corners = computeRunwayCorners(a, b, halfW);
            if (!corners) return null;
            return (
              <g key={'rwy-' + name}>
                <polygon
                  points={corners.map(p => `${p.x},${svgY(p.z)}`).join(' ')}
                  fill="#000"
                  stroke="#000"
                  strokeWidth={runwayStrokeW}
                />
              </g>
            );
          })}

          {/* ── Layer 3: Live ground aircraft ────────────────── */}
          {groundAircraft.map((ac) => {
            const trail = ac.trail || [];
            const sorted = [...trail].sort((a, b) => a.age - b.age);
            if (sorted.length === 0) return null;
            const cur = sorted[0];
            const heading = headingDeg(ac.noseDirection);
            const sy = svgY(cur.z);
            return (
              <g key={'ac-' + ac.callSign} className="ground-map-aircraft-group"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedCallSign(ac.callSign);
                  if (electronAPI.sendUdpCommand) {
                    electronAPI.sendUdpCommand(1, ac.callSign);
                  }
                }}>
                {/* Airplane icon from IoAirplane — positioned & rotated */}
                <g transform={`translate(${cur.x}, ${sy}) rotate(${heading}) scale(${iconScale}) translate(-256, -256)`}>
                  <path d={MAP_ICON_PATH} fill={ac.callSign === selectedCallSign ? '#ffff00' : '#fff'} />
                </g>
                {/* Connector line */}
                <line
                  x1={cur.x + planeScale * 0.9} y1={sy}
                  x2={cur.x + labelOff} y2={sy}
                  stroke="#fff" strokeWidth={fontSize * 0.04} opacity="0.4"
                />
                {/* Callsign label — green (yellow when selected) */}
                <text
                  x={cur.x + labelOff + fontSize * 0.3}
                  y={sy + fontSize * 0.35}
                  textAnchor="start"
                  fontSize={fontSize}
                  fill={ac.callSign === selectedCallSign ? '#ffff00' : '#0f0'}
                >{ac.callSign}</text>
              </g>
            );
          })}

        </svg>
      )}
      <button
        className="ground-map-refresh-btn"
        onClick={() => { if (electronAPI.resetUdpAircraft) electronAPI.resetUdpAircraft(); }}
      >{t('map_refresh')}</button>
    </div>
  );
}
