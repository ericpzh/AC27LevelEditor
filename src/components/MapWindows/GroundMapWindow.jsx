import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import useSvgZoom from './useSvgZoom';
import useUdpAircraftState from './useUdpAircraftState';
import ControlSidebar from './ControlSidebar';
import SimClock from './SimClock';
import MapHelpOverlay from './MapHelpOverlay';
import { IoHelpCircleOutline } from 'react-icons/io5';
import { RAD_TO_DEG, MAP_ICON_PATH, GROUND_MAP_DEFAULT_ZOOM, GROUND_MAP_CENTER_OFFSET, GROUND_RADAR_STAND_PROXIMITY, GROUND_MAP_TAXIWAY_LABEL_SPACING, GROUND_MAP_STAND_ACCESS_WIDTH_MULT } from '../../utils/constants';
import { witchDirection, isParked } from './witchMode';
import './GroundMapWindow.css';
import './MapShared.css';

// ─── Helpers ──────────────────────────────────────────────────────

/** Unity Z → SVG Y (flip). */
function svgY(z) { return -z; }

/** Heading angle from nose direction vector (Unity coords). */
function headingDeg(noseDir) {
  if (!noseDir) return 0;
  return Math.atan2(-noseDir.z, noseDir.x) * RAD_TO_DEG;
}

/** Color scheme for ACL area polygons by AreaType. */
const AREA_TYPE_STYLES = {
  0: { fill: '#1a3a6a', stroke: '#2a5a9a', opacity: 0.20 },   // Airport boundary (blue)
  1: { fill: '#444', stroke: 'none', opacity: 1.0 },           // Stand/apron (match taxiway)
  2: { fill: '#000', stroke: 'none', opacity: 1.0 },           // Building (solid black)
};

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
  const [standPositions, setStandPositions] = useState({});
  const [areaData, setAreaData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCallSign, setSelectedCallSign] = useState(null);
  const [showTaxiwayNames, setShowTaxiwayNames] = useState(false);
  const [showAllAircraft, setShowAllAircraft] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [witchMode, setWitchMode] = useState(false);
  const [witchFrame, setWitchFrame] = useState(0);
  const witchTimerRef = useRef(null);
  const labelTimerRef = useRef(null);

  const { aircraft: udpAircraft, currentAirport: udpAirport, simTimeUnixMs } = useUdpAircraftState();

  // ── Sync selected aircraft across ground + air map windows ──
  useEffect(() => {
    if (!electronAPI || !airportIcao) return;
    // Fetch current selection on mount (e.g. if air map already has one selected)
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

  // ── Debug: log selected aircraft full UDP data every 5s ────
  useEffect(() => {
    if (!selectedCallSign) return;
    const tick = () => {
      const ac = udpAircraft.find(a => a.callSign === selectedCallSign);
      if (ac && electronAPI.debugLog) electronAPI.debugLog('[UDP-DEBUG]', ac.callSign, JSON.parse(JSON.stringify(ac)));
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [selectedCallSign, udpAircraft, electronAPI]);

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
        setStandPositions(vals?._standPositions || {});
        setAreaData(vals?._areaData || {});
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
    return udpAircraft.filter(a => {
      if (a.position && a.position.y > 1.0) return false; // airborne → AirMapWindow
      // Hide inactive aircraft parked at a stand (unless showAllAircraft)
      if (showAllAircraft) return true;
      if (!a.stand || !standPositions[a.stand] || !a.position) return true;
      const sp = standPositions[a.stand];
      const dx = a.position.x - sp.x;
      const dz = a.position.z - sp.y; // standPositions.y is game Z
      const atStand = dx * dx + dz * dz <= GROUND_RADAR_STAND_PROXIMITY * GROUND_RADAR_STAND_PROXIMITY;
      return !atStand;
    });
  }, [udpAircraft, udpAirport, airportIcao, standPositions, showAllAircraft]);

  // ── Ground box: center (0,0) + per-airport offset, per-airport default zoom ───
  const dataBounds = useMemo(() => {
    const zoom = GROUND_MAP_DEFAULT_ZOOM[airportIcao] ?? 1.0;
    const halfW = 30 * zoom;
    return { x: -halfW, z: halfW, w: halfW * 2, h: halfW * 2 };
  }, [airportIcao]);

  // ── SVG viewBox ───────────────────────────────────────────
  const initialViewBox = useMemo(() => {
    if (!dataBounds) return null;
    const offset = GROUND_MAP_CENTER_OFFSET[airportIcao] || { x: 0, z: 0 };
    return {
      x: dataBounds.x + (offset.x || 0),
      y: dataBounds.z - dataBounds.h + (-(offset.z || 0)),
      w: dataBounds.w,
      h: dataBounds.h,
    };
  }, [dataBounds, airportIcao]);

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
    // Zoom: 0 = fully out (initial size), 1 = fully in (2% size)
    const zoomRaw = viewBox.w / initialViewBox.w; // 0.02 .. 1.0
    const zoom = (1 - zoomRaw) / 0.98;           // 0 (out) .. 1 (in)
    // Pan: center offset relative to half-width, clamped to ±1, mapped to 0–1
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

  // ── Set of runway names to filter out from taxiway labels ──
  const runwayNameSet = useMemo(() => {
    const s = new Set();
    for (const key of Object.keys(runwayData)) s.add(key);
    return s;
  }, [runwayData]);

  // ── Split taxiway paths: runway-named vs normal ─────────────
  const { runwayTaxiwayPaths, normalTaxiwayPaths } = useMemo(() => {
    const rwy = [];
    const norm = [];
    for (const tp of taxiwayPaths) {
      if (tp.name && runwayNameSet.has(tp.name)) {
        rwy.push(tp);
      } else {
        norm.push(tp);
      }
    }
    return { runwayTaxiwayPaths: rwy, normalTaxiwayPaths: norm };
  }, [taxiwayPaths, runwayNameSet]);

  // ── Taxiway label indices (proximity dedup per name) ──────────
  const taxiwayLabelIndices = useMemo(() => {
    const show = new Set();
    if (!showTaxiwayNames) return show;
    const placed = {}; // name → [{x, z}]
    normalTaxiwayPaths.forEach((tp, i) => {
      const midIdx = Math.floor((tp.points?.length || 0) / 2);
      const midPt = tp.points?.[midIdx];
      if (!tp.name || !midPt) return;
      if (!placed[tp.name]) placed[tp.name] = [];
      const prev = placed[tp.name];
      const minGapSq = GROUND_MAP_TAXIWAY_LABEL_SPACING * GROUND_MAP_TAXIWAY_LABEL_SPACING;
      if (prev.some(p => {
        const dx = midPt.x - p.x;
        const dz = (midPt.z || 0) - (p.z || 0);
        return dx * dx + dz * dz < minGapSq;
      })) return;
      placed[tp.name].push({ x: midPt.x, z: midPt.z || 0 });
      show.add(i);
    });
    return show;
  }, [normalTaxiwayPaths, showTaxiwayNames]);

  // ── Area polygons from ACL SceneryData.Areas ──────────────
  const areaPolygonElements = useMemo(() => {
    const els = [];
    Object.entries(areaData || {}).forEach(([areaTypeStr, areas]) => {
      const areaType = parseInt(areaTypeStr, 10);
      const style = AREA_TYPE_STYLES[areaType] || { fill: '#444', stroke: '#444', opacity: 0.20 };
      (areas || []).forEach((area) => {
        if (!area.enabled || !area.points || area.points.length < 3) return;
        const pointsStr = area.points.map(p => `${p.x},${svgY(p.z)}`).join(' ');
        els.push(
          <polygon
            key={'area-' + area.guid}
            points={pointsStr}
            fill={style.fill}
            fillOpacity={style.opacity}
            stroke={style.stroke}
            strokeWidth={style.stroke === 'none' ? 0 : taxiwayW * 0.6}
            strokeOpacity={style.stroke === 'none' ? 0 : 0.5}
          />
        );
      });
    });
    return els;
  }, [areaData, taxiwayW]);

  if (!initialViewBox) return null;

  return (
    <div className="ground-map">
      {loading && <div className="ground-map-loading"><div className="spinner" /></div>}
      {error && <div className="ground-map-error">{error}</div>}
      {!loading && !error && (
        <>
          <SimClock simTimeUnixMs={simTimeUnixMs} className="ground-map-clock" />
          <div className="ground-map-svg-container" onWheel={handleWheel}>
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
              onClick={() => {
                if (electronAPI.selectAircraftInMap) {
                  electronAPI.selectAircraftInMap(airportIcao, null);
                }
              }}
            >
              {/* Background — radar blue */}
              <rect x={viewBox.x} y={viewBox.y} width={viewBox.w} height={viewBox.h} fill="#0a1628" />

              {/* ── Layer 1: Taxiway centerlines (grey) ────────── */}
              {normalTaxiwayPaths.map((tp, i) => {
                const width = tp.isStandAccess ? taxiwayW * GROUND_MAP_STAND_ACCESS_WIDTH_MULT : taxiwayW;
                return (
                <polyline
                  key={'twy-' + i}
                  points={tp.points.map(p => `${p.x},${svgY(p.z)}`).join(' ')}
                  fill="none"
                  stroke="#444"
                  strokeWidth={width}
                  strokeLinecap={tp.isStandAccess ? "rect": "round"}
                  strokeLinejoin="round"
                />);
              })}

              {/* ── Layer 1b: Area polygons (semi-transparent, by AreaType) ── */}
              {areaPolygonElements}

              {/* ── Layer 2: Runway rectangles (black, on top of taxiways) ──── */}
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

              {/* ── Layer 2c: Taxiway segments with runway names → runway style ── */}
              {runwayTaxiwayPaths.map((tp, i) => {
                if (!tp.points || tp.points.length < 2) return null;
                const a = tp.points[0];
                const b = tp.points[tp.points.length - 1];
                const rwWidth = (runwayData[tp.name]?.width || 0.50);
                const halfW = rwWidth / 2;
                const corners = computeRunwayCorners(a, b, halfW);
                if (!corners) return null;
                return (
                  <polygon
                    key={'rwy-twy-' + i}
                    points={corners.map(p => `${p.x},${svgY(p.z)}`).join(' ')}
                    fill="#000"
                    stroke="#000"
                    strokeWidth={runwayStrokeW}
                  />
                );
              })}

              {/* ── Layer 2b: Taxiway labels (above runways) ────────── */}
              {normalTaxiwayPaths.map((tp, i) => {
                if (!taxiwayLabelIndices.has(i)) return null;
                const mid = tp.points[Math.floor(tp.points.length / 2)];
                return (
                  <text
                    key={'twylbl-' + i}
                    x={mid.x}
                    y={svgY(mid.z) - fontSize * 0.9}
                    textAnchor="middle"
                    fontSize={fontSize * 0.65}
                    fill="#ffffff"
                    className="ground-map-taxiway-label"
                  >{tp.name}</text>
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
                      if (electronAPI.selectAircraftInMap) {
                        electronAPI.selectAircraftInMap(airportIcao, ac.callSign);
                      }
                    }}>
                    {/* Aircraft icon — either airplane SVG path or witch sprite */}
                    {witchMode ? (
                      (() => {
                        const parked = isParked(ac, standPositions, GROUND_RADAR_STAND_PROXIMITY);
                        const action = parked ? 'stand' : 'walk';
                        const dir = parked ? '' : witchDirection(ac.noseDirection);
                        const href = parked
                          ? `witch/stand${witchFrame + 1}.png`
                          : `witch/walk${dir}${witchFrame + 1}.png`;
                        const sz = planeScale * 6.5;
                        return (
                          <image href={href}
                            x={cur.x - sz / 2}
                            y={sy - sz / 2}
                            width={sz} height={sz}
                            style={{ pointerEvents: 'none' }}
                          />
                        );
                      })()
                    ) : (
                      <g transform={`translate(${cur.x}, ${sy}) rotate(${heading}) scale(${iconScale}) translate(-256, -256)`}>
                        <path d={MAP_ICON_PATH} fill={ac.callSign === selectedCallSign ? '#ffff00' : '#fff'} />
                      </g>
                    )}
                    {/* Connector line */}
                    {!witchMode && (
                      <line
                        x1={cur.x + planeScale * 0.9} y1={sy}
                        x2={cur.x + labelOff} y2={sy}
                        stroke="#fff" strokeWidth={fontSize * 0.04} opacity="0.4"
                      />
                    )}
                    {/* Callsign label — green (yellow when selected) */}
                    {!witchMode && (
                      <text
                        x={cur.x + labelOff + fontSize * 0.3}
                        y={sy + fontSize * 0.35}
                        textAnchor="start"
                        fontSize={fontSize}
                        fill={ac.callSign === selectedCallSign ? '#ffff00' : '#0f0'}
                      >{ac.callSign}</text>
                    )}
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
            <div className={'air-map-toggle' + (showAllAircraft ? ' active' : '')}
              onClick={() => setShowAllAircraft(v => !v)}>
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">{t('ground_map_show_all')}</span>
            </div>
            <div className={'air-map-toggle' + (showTaxiwayNames ? ' active' : '')}
              onClick={() => {
                if (witchMode) {
                  // Already in witch mode — any click exits and does normal action
                  setWitchMode(false);
                  setShowTaxiwayNames(v => !v);
                } else if (labelTimerRef.current) {
                  // Double-click: enter witch mode
                  clearTimeout(labelTimerRef.current);
                  labelTimerRef.current = null;
                  setWitchMode(true);
                } else {
                  // First click: wait for potential double-click
                  labelTimerRef.current = setTimeout(() => {
                    labelTimerRef.current = null;
                    setShowTaxiwayNames(v => !v);
                  }, 300);
                }
              }}>
              <div className="air-map-toggle-knob" />
              <span className="air-map-toggle-label">{t('ground_map_taxiway')}</span>
            </div>
            <div className="air-map-toggle"
              onClick={() => { if (electronAPI.resetUdpAircraft) electronAPI.resetUdpAircraft(); }}>
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
      {helpOpen && <MapHelpOverlay type="ground" onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
