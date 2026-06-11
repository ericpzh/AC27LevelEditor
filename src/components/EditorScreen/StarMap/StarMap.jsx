import React, { useState, useMemo, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { IoRemove } from 'react-icons/io5';
import { useTranslation } from '../../../hooks/useTranslation';
import { useElectronAPI } from '../../../hooks/useElectronAPI';
import useDrag from '../../../hooks/useDrag';
import { useAppStore } from '../../../store/appStore';
import './StarMap.css';

const PAD_RATIO = 0.10;
const GAP = 8;
const HEADER_H = 38;
const LEGEND_H = 40;
const SVG_FRAC = 0.48;     // fraction of viewport width for longer SVG side
const MIN_SVG = 680;       // floor — legend always fits

// ── Window size hook ─────────────────────────────────────

function useWindowSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    let ticking = false;
    const onResize = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          setSize({ w: window.innerWidth, h: window.innerHeight });
          ticking = false;
        });
        ticking = true;
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

// ── Path interpolation helpers ──────────────────────────

function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = (points[i].y || 0) - (points[i - 1].y || 0);
    const dz = (points[i].z || 0) - (points[i - 1].z || 0);
    len += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return len;
}

function interpolateOnPath(points, targetDist) {
  let accumulated = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = (points[i].y || 0) - (points[i - 1].y || 0);
    const dz = (points[i].z || 0) - (points[i - 1].z || 0);
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (accumulated + segLen >= targetDist) {
      const t = segLen > 0 ? (targetDist - accumulated) / segLen : 0;
      return {
        x: points[i - 1].x + dx * t,
        y: (points[i - 1].y || 0) + dy * t,
        z: (points[i - 1].z || 0) + dz * t,
        dirX: segLen > 0 ? dx / segLen : 1,
        dirZ: segLen > 0 ? dz / segLen : 0,
      };
    }
    accumulated += segLen;
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y || 0, z: last.z || 0, dirX: 1, dirZ: 0 };
}

// ── Time string → seconds helper ────────────────────────

function timeToSec(t) {
  if (t == null) return 0;
  const parts = String(t).split(':');
  return (+parts[0] || 0) * 3600 + (+parts[1] || 0) * 60 + (+parts[2] || 0);
}

// ── StarMap ──────────────────────────────────────────────

export default function StarMap({ starPaths, selectedStar, selectedRunway, starRunwayMap, runwayThresholds, onSelect, onShrink, buttonRef, airportIcao, callsign, isDeparture, arrivalFlights, saveSec }) {
  const { t } = useTranslation();
  const activeMap = useAppStore(s => s.activeMap);
  const setActiveMap = useAppStore(s => s.setActiveMap);
  const electronAPI = useElectronAPI();
  const [hoveredStar, setHoveredStar] = useState(null);
  const [opening, setOpening] = useState(true);
  const [closing, setClosing] = useState(false);
  const [animOrigin, setAnimOrigin] = useState({ x: 0, y: 0 });
  const [aircraftPositions, setAircraftPositions] = useState([]);
  const [totalApproachTimes, setTotalApproachTimes] = useState({});
  const panelRef = useRef(null);
  const { w: winW, h: winH } = useWindowSize();

  // ── Drag hook ─────────────────────────────────────────────
  const { pos: dragPos, isDragging, hasDragged, headerHandlers } = useDrag({
    panelRef,
    enabled: !closing,
  });

  // ── Fetch aircraft positions from backend ──────────────────
  const apiRef = useRef(electronAPI);
  apiRef.current = electronAPI;

  useEffect(() => {
    if (!arrivalFlights || arrivalFlights.length === 0 || !saveSec || !airportIcao) {
      setAircraftPositions([]);
      setTotalApproachTimes({});
      return;
    }
    const arrivals = arrivalFlights.map((f) => ({
      callsign: f.CallSign || f.callsign,
      star: f.Airway || f.star,
      runway: f.Runway || f.runway,
      landingSec: f._landingSec != null ? f._landingSec : timeToSec(f.LandingTime || f.landingTime),
    }));

    let cancelled = false;
    apiRef.current.getAircraftPositions(airportIcao, arrivals, saveSec).then((res) => {
      if (cancelled) return;
      if (res && res.success) {
        setAircraftPositions(res.positions || []);
        setTotalApproachTimes(res.totalApproachTimes || {});
      }
    }).catch((err) => {
      if (!cancelled) { setAircraftPositions([]); setTotalApproachTimes({}); }
    });

    return () => { cancelled = true; };
  }, [arrivalFlights, saveSec, airportIcao]);

  // ── Helper: get total approach time with fallback ──────
  const fallbackTat = useMemo(() => {
    const vals = Object.values(totalApproachTimes);
    if (vals.length === 0) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }, [totalApproachTimes]);

  const getApproachTime = useCallback((starName) => {
    if (totalApproachTimes[starName] != null) return totalApproachTimes[starName];
    if (fallbackTat != null) return fallbackTat;
    return null;
  }, [totalApproachTimes, fallbackTat]);

  // ── Hover position: where the editing aircraft WOULD be on the hovered STAR ─
  const hoverPosition = useMemo(() => {
    if (!hoveredStar || !callsign || !starPaths || !totalApproachTimes || !saveSec) return null;
    const editFlight = (arrivalFlights || []).find(
      (f) => (f.CallSign || f.callsign) === callsign,
    );
    if (!editFlight) return null;
    const currentStar = editFlight.Airway || editFlight.star;
    if (hoveredStar === currentStar) return null;

    const tat = getApproachTime(hoveredStar);
    if (!tat) return null;

    const landingSec = editFlight._landingSec != null
      ? editFlight._landingSec
      : timeToSec(editFlight.LandingTime || editFlight.landingTime);
    const pr = 1 - (landingSec - saveSec) / tat;
    if (pr <= 0 || pr >= 1) return null;

    const runway = editFlight.Runway || editFlight.runway;
    const variants = starPaths[hoveredStar];
    if (!variants) return null;
    const variant = variants.find(
      (v) => v.runway && v.runway.toUpperCase() === (runway || '').toUpperCase(),
    );
    if (!variant || !variant.points || variant.points.length < 2) return null;

    const totalLen = pathLength(variant.points);
    const targetDist = totalLen * pr;
    const hp = interpolateOnPath(variant.points, targetDist);
    const headingDeg = Math.atan2(-hp.dirZ, hp.dirX) * (180 / Math.PI);

    return { x: hp.x, y: hp.y || 0, z: hp.z || 0, headingDeg };
  }, [hoveredStar, callsign, starPaths, totalApproachTimes, saveSec, arrivalFlights]);

  // ── Editing flight's actual position — computed LOCALLY ─
  const editPosition = useMemo(() => {
    if (!callsign || !starPaths || !totalApproachTimes || !saveSec) return null;
    const ef = (arrivalFlights || []).find(
      (f) => (f.CallSign || f.callsign) === callsign,
    );
    if (!ef) return null;

    const star = ef.Airway || ef.star;
    const runway = ef.Runway || ef.runway;

    const tat = getApproachTime(star);
    if (!tat) return null;

    const landingSec = ef._landingSec != null
      ? ef._landingSec
      : timeToSec(ef.LandingTime || ef.landingTime);
    const pr = 1 - (landingSec - saveSec) / tat;
    if (pr <= 0 || pr >= 1) return null;

    const variants = starPaths[star];
    if (!variants) return null;
    const variant = variants.find(
      (v) => v.runway && v.runway.toUpperCase() === (runway || '').toUpperCase(),
    );
    if (!variant || !variant.points || variant.points.length < 2) return null;

    const totalLen = pathLength(variant.points);
    const targetDist = totalLen * pr;
    const hp = interpolateOnPath(variant.points, targetDist);
    const headingDeg = Math.atan2(-hp.dirZ, hp.dirX) * (180 / Math.PI);

    return { x: hp.x, y: hp.y || 0, z: hp.z || 0, headingDeg };
  }, [callsign, arrivalFlights, starPaths, totalApproachTimes, saveSec]);

  // ── Flatten into renderable lines with availability ──────
  const { lines, viewBox, vbX, vbY, vbW, vbH, sortedStars, labelPositions } = useMemo(() => {
    const entries = Object.entries(starPaths || {});
    if (entries.length === 0) return { lines: [], viewBox: '', vbX: 0, vbY: 0, vbW: 1, vbH: 1, sortedStars: [] };

    const flat = [];
    for (const [starName, variants] of entries) {
      for (const v of variants) {
        if (v.points && v.points.length >= 2) {
          flat.push({ starName, runway: v.runway, points: v.points });
        }
      }
    }

    // Compute bounds across all points
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const line of flat) {
      for (const pt of line.points) {
        const sx = pt.x;
        const sy = -pt.z;
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
      }
    }

    const rangeX = (maxX - minX) || 1;
    const rangeY = (maxY - minY) || 1;
    let padX = rangeX * PAD_RATIO;
    let padY = rangeY * PAD_RATIO;

    const TARGET_RATIO = 1.35;
    let vbW = rangeX + 2 * padX;
    let vbH = rangeY + 2 * padY;
    if (vbW / vbH > TARGET_RATIO) {
      const extra = (vbW / TARGET_RATIO - vbH) / 2;
      padY += extra;
      vbH = rangeY + 2 * padY;
    } else if (vbH / vbW > TARGET_RATIO) {
      const extra = (vbH / TARGET_RATIO - vbW) / 2;
      padX += extra;
      vbW = rangeX + 2 * padX;
    }

    let vbX = minX - padX;
    let vbY = minY - padY;

    const sortedStars = [...new Set(flat.map(l => l.starName))].sort();

    // ── Helper: shortest distance from point to segment ──
    const ptSegDist = (px, py, x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) { const ex = px - x1; const ey = py - y1; return Math.sqrt(ex * ex + ey * ey); }
      let t = ((px - x1) * dx + (py - y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = x1 + t * dx, cy = y1 + t * dy;
      const ex = px - cx, ey = py - cy;
      return Math.sqrt(ex * ex + ey * ey);
    };

    // ── Build all polyline segments ──
    const allSegments = [];
    for (const line of flat) {
      for (let i = 1; i < line.points.length; i++) {
        allSegments.push({
          starName: line.starName,
          x1: line.points[i - 1].x, y1: -(line.points[i - 1].z),
          x2: line.points[i].x,       y2: -(line.points[i].z),
        });
      }
    }

    // ── Label positioning ──
    const estFontSize = Math.max(vbW, vbH) * 0.02;
    const estLabelOff = Math.max(vbW, vbH) * 0.015;
    const avgCharW = estFontSize * 0.58;
    const MIN_CLEARANCE = Math.max(vbW, vbH) * 0.02;
    const LABEL_PAD = estFontSize * 1.2;

    let rwyCx = 0, rwyCy = 0, rwyCount = 0;
    if (runwayThresholds) {
      for (const ends of Object.values(runwayThresholds)) {
        rwyCx += ends.a.x + ends.b.x;
        rwyCy += -(ends.a.z) + -(ends.b.z);
        rwyCount += 2;
      }
    }
    if (rwyCount > 0) { rwyCx /= rwyCount; rwyCy /= rwyCount; }

    const starLabelDefs = [];
    for (const starName of sortedStars) {
      if (selectedRunway && starRunwayMap) {
        const valid = starRunwayMap[starName];
        if (!valid || !valid.includes(selectedRunway)) continue;
      }

      const variants = flat.filter(l => l.starName === starName);
      if (variants.length === 0) continue;
      const path = variants[0].points;
      if (path.length < 2) continue;

      const p0x = path[0].x, p0y = -(path[0].z);
      const p1x = path[1].x, p1y = -(path[1].z);

      const dx = p1x - p0x, dy = p1y - p0y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen === 0) continue;
      const tx = dx / segLen, ty = dy / segLen;

      const perpX = -ty, perpY = tx;

      const toRwyX = rwyCx - p0x, toRwyY = rwyCy - p0y;
      const dot = toRwyX * perpX + toRwyY * perpY;
      const dirX = dot < 0 ? perpX : -perpX;
      const dirY = dot < 0 ? perpY : -perpY;

      const angle = Math.atan2(p0y - rwyCy, p0x - rwyCx);
      const lw = starName.length * avgCharW;
      const lh = estFontSize;

      starLabelDefs.push({ starName, p0x, p0y, dirX, dirY, angle, lw, lh });
    }

    starLabelDefs.sort((a, b) => a.angle - b.angle);

    const labelRectsOverlap = (cx, cy, lw, lh, placed) => {
      const left = cx - lw / 2 - LABEL_PAD;
      const right = cx + lw / 2 + LABEL_PAD;
      const top = cy - lh - estLabelOff - LABEL_PAD;
      const bottom = cy - estLabelOff + LABEL_PAD;
      for (const p of placed) {
        if (left < p.right && right > p.left && top < p.bottom && bottom > p.top) {
          return true;
        }
      }
      return false;
    };

    const labelPositions = {};
    const placed = [];
    const STEP = MIN_CLEARANCE * 0.5;
    const MAX_STEPS = 60;

    for (const def of starLabelDefs) {
      let lx = def.p0x, ly = def.p0y;

      for (let step = 0; step < MAX_STEPS; step++) {
        let minLineDist = Infinity;
        for (const seg of allSegments) {
          if (seg.starName === def.starName) continue;
          const d = ptSegDist(lx, ly, seg.x1, seg.y1, seg.x2, seg.y2);
          if (d < minLineDist) minLineDist = d;
        }

        const clearOfLines = minLineDist >= MIN_CLEARANCE;
        const clearOfLabels = !labelRectsOverlap(lx, ly, def.lw, def.lh, placed);

        if (clearOfLines && clearOfLabels) break;

        lx += def.dirX * STEP;
        ly += def.dirY * STEP;
      }

      labelPositions[def.starName] = { x: lx, y: ly };
      placed.push({
        left: lx - def.lw / 2,
        right: lx + def.lw / 2,
        top: ly - def.lh - estLabelOff,
        bottom: ly - estLabelOff,
      });

      const lRight = lx + def.lw / 2;
      const lTop = ly - def.lh - estLabelOff;
      if (lRight > vbX + vbW) vbW = lRight - vbX + padX;
      if (lTop < vbY) { const d = vbY - lTop; vbY -= d + padY; vbH += d + padY; }
    }

    const transformed = flat.map(line => ({
      ...line,
      svgPoints: line.points.map(pt => `${pt.x},${-(pt.z)}`).join(' '),
    }));

    return { lines: transformed, viewBox: `${vbX} ${vbY} ${vbW} ${vbH}`, vbX, vbY, vbW, vbH, sortedStars, labelPositions };
  }, [starPaths, selectedRunway, starRunwayMap, runwayThresholds]);

  // ── SVG pixel size ────────────────────────────────────────
  const dataRatio = vbW / vbH;
  const svgMax = Math.max(MIN_SVG, Math.min(
    Math.round(winW * SVG_FRAC),
    Math.round(winH * 0.78) - HEADER_H - LEGEND_H
  ));
  let svgW, svgH;
  if (dataRatio >= 1) {
    svgW = svgMax;
    svgH = Math.round(svgMax / dataRatio);
  } else {
    svgH = svgMax;
    svgW = Math.round(svgMax * dataRatio);
  }

  const hasData = starPaths && Object.keys(starPaths).length > 0 && lines.length > 0;

  const panelW = hasData ? svgW : 240;
  const panelH = hasData ? (svgH + HEADER_H + LEGEND_H) : (HEADER_H + 36);

  // ── Position: left-aligned by default; drag overrides ──
  const controlled = hasDragged || isDragging;
  const effLeft = controlled ? dragPos.left : 0;
  const effTop = controlled ? dragPos.top : GAP;

  // ── Compute transform-origin from button ref ───────────
  const updateOrigin = useCallback(() => {
    if (buttonRef?.current && panelRef.current) {
      const btnR = buttonRef.current.getBoundingClientRect();
      const panelR = panelRef.current.getBoundingClientRect();
      setAnimOrigin({
        x: btnR.left + btnR.width / 2 - panelR.left,
        y: btnR.top + btnR.height / 2 - panelR.top,
      });
    }
  }, [buttonRef]);

  // Set origin on mount for expand animation
  useLayoutEffect(() => {
    updateOrigin();
    // Trigger expand animation on next frame via state (survives re-renders)
    const raf = requestAnimationFrame(() => {
      setOpening(false);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Shrink handler ─────────────────────────────────────
  const handleShrink = useCallback(() => {
    updateOrigin();
    setClosing(true);
  }, [updateOrigin]);

  const handleTransitionEnd = useCallback((e) => {
    if (e.propertyName === 'transform' && closing) {
      onShrink();
    }
  }, [closing, onShrink]);

  // ── Escape key closes ──────────────────────────────────
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') handleShrink(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleShrink]);

  // ── ViewBox-relative sizing ───────────────────────────────
  const vbDiag = Math.max(vbW, vbH);
  const lineWSelected = vbDiag * 0.0075;
  const lineWHovered = vbDiag * 0.0055;
  const lineWDefault = vbDiag * 0.0035;
  const ringW = vbDiag * 0.005;
  const fontSize = vbDiag * 0.02;
  const labelOff = vbDiag * 0.015;
  const runwayLineW = vbDiag * 0.008;
  const planeSize = vbDiag * 0.028;
  const planeLabelOff = vbDiag * 0.035;

  // ── STAR-level validity for labels and click targets ─────
  const starValidForRunway = useCallback((starName) => {
    // No callsign (no aircraft selected) or departure flight: all STARs disabled
    if (!callsign || isDeparture) return false;
    if (!selectedRunway) return true;
    const rwys = starRunwayMap && starRunwayMap[starName];
    return rwys && rwys.includes(selectedRunway);
  }, [callsign, isDeparture, selectedRunway, starRunwayMap]);

  // ── Line state (per-variant) ──────────────────────────────
  const getState = useCallback((starName, lineRunway) => {
    // No callsign (no aircraft selected) or departure flight: all STARs disabled
    if (!callsign || isDeparture) return 'disabled';
    if (selectedRunway && lineRunway !== selectedRunway) return 'disabled';
    if (starName === selectedStar) return 'current';
    if (starName === hoveredStar) return 'hovered';
    return 'available';
  }, [callsign, isDeparture, selectedStar, hoveredStar, selectedRunway]);

  const handleLineClick = useCallback((e, starName, available) => {
    e.stopPropagation();
    e.preventDefault();
    if (!available) return;
    onSelect(starName);
  }, [onSelect]);

  const handleLineMouseDown = useCallback((e) => {
    e.stopPropagation();
  }, []);

  return createPortal(
    <div
      className={`star-map-panel${opening ? ' opening' : ''}${isDragging ? ' dragging' : ''}${closing ? ' closing' : ''}`}
      ref={panelRef}
      style={{
        left: effLeft,
        top: effTop,
        width: panelW,
        height: panelH,
        transformOrigin: `${animOrigin.x}px ${animOrigin.y}px`,
        zIndex: activeMap === 'star' ? 251 : 250,
      }}
      onTransitionEnd={handleTransitionEnd}
      onMouseDownCapture={() => setActiveMap('star')}
    >
      <div className="star-map-header" {...headerHandlers}>
        <span className="star-map-title">{t('starmap_title')}</span>
        <div className="star-map-header-actions">
          <button
            className="star-map-shrink"
            onClick={handleShrink}
            title={t('minimize') || 'Hide'}
          >
            <IoRemove size={14} />
          </button>
        </div>
      </div>

      <div className="star-map-content-wrap">
        {hasData ? (
          <>
            <svg className="star-map-svg" viewBox={viewBox} width={svgW} height={svgH}>
              <rect className="star-map-bg" x={vbX} y={vbY} width={vbW} height={vbH} />
              <image
                href={`${airportIcao}_STAR.png`}
                x={vbX} y={vbY} width={vbW} height={vbH}
                preserveAspectRatio="xMidYMid slice"
                opacity="0.05"
                onError={(e) => { e.target.style.display = 'none'; }}
              />

              {/* Runway threshold pairs */}
              {runwayThresholds && Object.entries(runwayThresholds).map(([key, ends]) => {
                const parts = key.split('/');
                const isCurrent = selectedRunway && parts.includes(selectedRunway);
                return (
                  <line
                    key={`rwy-${key}`}
                    x1={ends.a.x} y1={-(ends.a.z)}
                    x2={ends.b.x} y2={-(ends.b.z)}
                    strokeWidth={runwayLineW}
                    className={`star-map-runway${isCurrent ? ' current' : ''}`}
                  />
                );
              })}

              {/* ── Layer 1: STAR polylines ──────────────── */}
              {sortedStars.map(starName => {
                const starLines = lines.filter(l => l.starName === starName);
                if (starLines.length === 0) return null;
                const starValid = starValidForRunway(starName);

                return (
                  <g key={`lines-${starName}`}
                    onMouseEnter={() => { if (starValid) setHoveredStar(starName); }}
                    onMouseLeave={() => setHoveredStar(null)}
                    onMouseDown={handleLineMouseDown}
                    onClick={(e) => handleLineClick(e, starName, starValid)}
                    style={{ pointerEvents: starValid ? 'auto' : 'none' }}
                  >
                    {starLines.map((line, i) => (
                      <polyline
                        key={`hit-${i}`}
                        points={line.svgPoints}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={vbDiag * 0.04}
                      />
                    ))}
                    {starLines.some(l => getState(starName, l.runway) === 'current') && starLines.map((line, i) => (
                      <polyline
                        key={`ring-${i}`}
                        points={line.svgPoints}
                        fill="none"
                        strokeWidth={ringW}
                        className="star-map-ring"
                      />
                    ))}
                    {starLines.map((line, i) => {
                      const lineState = getState(starName, line.runway);
                      return (
                        <polyline
                          key={i}
                          points={line.svgPoints}
                          fill="none"
                          className={`star-map-line ${lineState}`}
                          strokeWidth={
                            lineState === 'current' ? lineWSelected :
                            lineState === 'hovered' ? lineWHovered :
                            lineWDefault
                          }
                        />
                      );
                    })}
                  </g>
                );
              })}

              {/* Aircraft position icons */}
              {(() => {
                const PLANE_VB = 512;
                const ICON_PATH = "M186.62 464H160a16 16 0 0 1-14.57-22.6l64.46-142.25L113.1 297l-35.3 42.77C71.07 348.23 65.7 352 52 352H34.08a17.66 17.66 0 0 1-14.7-7.06c-2.38-3.21-4.72-8.65-2.44-16.41l19.82-71c.15-.53.33-1.06.53-1.58a.38.38 0 0 0 0-.15 14.82 14.82 0 0 1-.53-1.59l-19.84-71.45c-2.15-7.61.2-12.93 2.56-16.06a16.83 16.83 0 0 1 13.6-6.7H52c10.23 0 20.16 4.59 26 12l34.57 42.05 97.32-1.44-64.44-142A16 16 0 0 1 160 48h26.91a25 25 0 0 1 19.35 9.8l125.05 152 57.77-1.52c4.23-.23 15.95-.31 18.66-.31C463 208 496 225.94 496 256c0 9.46-3.78 27-29.07 38.16-14.93 6.6-34.85 9.94-59.21 9.94-2.68 0-14.37-.08-18.66-.31l-57.76-1.54-125.36 152a25 25 0 0 1-19.32 9.75z";

                const renderAircraft = (ac, pos, isEditing) => {
                  const sx = pos.x;
                  const sy = -(pos.z);
                  const heading = pos.headingDeg || 0;
                  const sc = (isEditing ? planeSize * 1.5 : planeSize) / PLANE_VB;
                  const lblOff = isEditing ? planeLabelOff * 1.2 : planeLabelOff;

                  return (
                    <g key={ac.callsign}>
                      <g className={`star-map-aircraft${isEditing ? ' editing' : ''}`}
                        style={{
                          transform: `translate(${sx}px, ${sy}px) rotate(${heading}deg)`,
                        }}
                      >
                        <g transform={`scale(${sc}) translate(-256, -256)`}>
                          <path d={ICON_PATH} />
                        </g>
                      </g>
                      <text
                        x={sx}
                        y={sy - lblOff}
                        textAnchor="middle"
                        fontSize={vbDiag * 0.016}
                        className={`star-map-ac-label${isEditing ? ' editing' : ''}`}
                      >
                        {ac.callsign}
                      </text>
                    </g>
                  );
                };

                const elements = [];

                // ── Editing flight: always render from local computation ──
                if (callsign) {
                  let editRenderPos = null;
                  if (hoverPosition) {
                    editRenderPos = hoverPosition;
                  } else if (editPosition) {
                    editRenderPos = editPosition;
                  }
                  if (!editRenderPos) {
                    const ipcEdit = aircraftPositions.find(ac => ac.callsign === callsign);
                    if (ipcEdit) editRenderPos = ipcEdit;
                  }

                  if (editRenderPos) {
                    elements.push(renderAircraft(
                      { callsign },
                      editRenderPos,
                      true,
                    ));
                  }
                }

                // ── Other flights: from IPC positions ──
                for (const ac of aircraftPositions) {
                  if (callsign && ac.callsign === callsign) continue;
                  elements.push(renderAircraft(ac, ac, false));
                }

                return elements;
              })()}

              {/* Hover ghost: dashed line from editing aircraft to hovered STAR position */}
              {hoverPosition && (() => {
                const fromPos = (editPosition) || aircraftPositions.find(
                  (ac) => callsign && ac.callsign === callsign,
                );
                if (!fromPos) return null;

                const fromX = fromPos.x;
                const fromY = -(fromPos.z);
                const toX = hoverPosition.x;
                const toY = -(hoverPosition.z);

                return (
                  <g className="star-map-hover-ghost">
                    <line
                      x1={fromX} y1={fromY}
                      x2={toX} y2={toY}
                      className="star-map-hover-line"
                    />
                  </g>
                );
              })()}

              {/* ── STAR labels ─────────────────── */}
              {sortedStars.map(starName => {
                const labelPos = labelPositions[starName];
                if (!labelPos) return null;
                const starValid = starValidForRunway(starName);
                const labelState = starName === selectedStar ? 'current' : starName === hoveredStar ? 'hovered' : !starValid ? 'disabled' : 'available';
                const labelW = starName.length * fontSize * 0.6 + 4;
                const labelH = fontSize * 1.1;
                const labelX = labelPos.x - 2;
                const labelY = labelPos.y - labelOff - fontSize * 0.85;
                return (
                  <g key={`label-${starName}`} style={{ pointerEvents: 'none' }}>
                    <rect
                      x={labelX}
                      y={labelY}
                      width={labelW}
                      height={labelH}
                      rx={3}
                      className="star-map-label-bg"
                    />
                    <text
                      x={labelPos.x}
                      y={labelPos.y - labelOff}
                      textAnchor="start"
                      fontSize={fontSize}
                      className={`star-map-label${labelState === 'hovered' ? ' hovered' : ''}${labelState === 'current' ? ' current' : ''}${labelState === 'disabled' ? ' disabled' : ''}`}
                    >
                      {starName}
                    </text>
                  </g>
                );
              })}
            </svg>

            <div className="star-map-legend">
              <div className="star-map-legend-item">
                <span className="star-map-legend-swatch lg-current" /> {t('starmap_current')}
              </div>
              <div className="star-map-legend-item">
                <span className="star-map-legend-swatch lg-available" /> {t('starmap_available')}
              </div>
              <div className="star-map-legend-item">
                <span className="star-map-legend-swatch lg-disabled" /> {t('starmap_disabled')}
              </div>
            </div>
          </>
        ) : (
          <div className="star-map-empty">
            {t('starmap_no_data') || 'No STAR path data — rebuild cache to populate'}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
