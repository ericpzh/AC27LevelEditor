import React, { useState, useMemo, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { IoRemove } from 'react-icons/io5';
import { useTranslation } from '../../../hooks/useTranslation';
import { useElectronAPI } from '../../../hooks/useElectronAPI';
import { useAppStore } from '../../../store/appStore';
import useDrag from '../../../hooks/useDrag';
import { APPROACH_MIN_TTL, MAP_PAD_RATIO, MAP_GAP, MAP_HEADER_H, MAP_LEGEND_H, MAP_SVG_FRAC, MAP_MIN_SVG, MAP_PLANE_VB, MAP_ICON_PATH, MAP_TARGET_RATIO, AIR_MAP_BG_OFFSETS } from '../../../utils/constants';
import './StarMap.css';

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

// Extend a path to include a derived touchdown point (50m past the last point
// along the approach heading). Used for aircraft position interpolation so the
// aircraft reaches the runway threshold, not just the last AppPoint.
// Mirrors the 50m fallback derivation in src/acl/flight_plans.js and main.js.
function extendPathToThreshold(points) {
  if (!points || points.length < 2) return points || [];
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const dx = last.x - prev.x;
  const dz = (last.z || 0) - (prev.z || 0);
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  return [...points, { x: last.x + (dx / len) * 50, y: 0, z: last.z + (dz / len) * 50 }];
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
    const ttl = landingSec - saveSec;
    const pr = 1 - Math.max(APPROACH_MIN_TTL, ttl) / tat;
    if (pr <= 0 || pr >= 1) return null;

    const runway = editFlight.Runway || editFlight.runway;
    const variants = starPaths[hoveredStar];
    if (!variants) return null;
    const variant = variants.find(
      (v) => v.runway && v.runway.toUpperCase() === (runway || '').toUpperCase(),
    );
    if (!variant || !variant.points || variant.points.length < 2) return null;

    const extPoints = extendPathToThreshold(variant.points);
    const totalLen = pathLength(extPoints);
    const targetDist = totalLen * pr;
    const hp = interpolateOnPath(extPoints, targetDist);
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
    const ttl = landingSec - saveSec;
    const pr = 1 - Math.max(APPROACH_MIN_TTL, ttl) / tat;
    if (pr <= 0 || pr >= 1) return null;

    const variants = starPaths[star];
    if (!variants) return null;
    const variant = variants.find(
      (v) => v.runway && v.runway.toUpperCase() === (runway || '').toUpperCase(),
    );
    if (!variant || !variant.points || variant.points.length < 2) return null;

    const extPoints = extendPathToThreshold(variant.points);
    const totalLen = pathLength(extPoints);
    const targetDist = totalLen * pr;
    const hp = interpolateOnPath(extPoints, targetDist);
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
    let padX = rangeX * MAP_PAD_RATIO;
    let padY = rangeY * MAP_PAD_RATIO;

    let vbW = rangeX + 2 * padX;
    let vbH = rangeY + 2 * padY;
    if (vbW / vbH > MAP_TARGET_RATIO) {
      const extra = (vbW / MAP_TARGET_RATIO - vbH) / 2;
      padY += extra;
      vbH = rangeY + 2 * padY;
    } else if (vbH / vbW > MAP_TARGET_RATIO) {
      const extra = (vbH / MAP_TARGET_RATIO - vbW) / 2;
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

  // ── Map image layout: same algorithm as AirMapWindow ────────
  // Image fills the viewBox, positioned via AIR_MAP_BG_OFFSETS
  const bgCfg = AIR_MAP_BG_OFFSETS[airportIcao] || { dx: 0, dy: 0 };
  const bgImageLayout = useMemo(() => {
    if (!airportIcao) return null;
    return {
      x: vbX + (bgCfg.dx || 0),
      y: vbY + (bgCfg.dy || 0),
      w: bgCfg.w != null ? bgCfg.w : vbW,
      h: vbH,
    };
  }, [airportIcao, bgCfg.dx, bgCfg.dy, bgCfg.w, vbX, vbY, vbW, vbH]);

  // ── SVG pixel size ────────────────────────────────────────
  const dataRatio = vbW / vbH;
  const svgMax = Math.max(MAP_MIN_SVG, Math.min(
    Math.round(winW * MAP_SVG_FRAC),
    Math.round(winH * 0.78) - MAP_HEADER_H - MAP_LEGEND_H
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
  const panelH = hasData ? (svgH + MAP_HEADER_H + MAP_LEGEND_H) : (MAP_HEADER_H + 36);

  // ── Position: left-aligned by default; drag overrides ──
  const controlled = hasDragged || isDragging;
  const effLeft = controlled ? dragPos.left : 0;
  const effTop = controlled ? dragPos.top : MAP_GAP;

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
              {/* Map image background (from _Map.png positioned via MAP_GEO_REF) */}
              {bgImageLayout && (
                <>
                  <rect
                    x={bgImageLayout.x} y={bgImageLayout.y}
                    width={bgImageLayout.w} height={bgImageLayout.h}
                    fill={(AIR_MAP_BG_OFFSETS[airportIcao] || {}).bgUnder || '#000000'}
                  />
                  <image
                    href={`${airportIcao}_STAR.png`}
                    x={bgImageLayout.x} y={bgImageLayout.y}
                    width={bgImageLayout.w} height={bgImageLayout.h}
                    preserveAspectRatio="xMidYMid slice"
                    opacity="0.2"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                </>
              )}

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

                const renderAircraft = (ac, pos, isEditing) => {
                  const sx = pos.x;
                  const sy = -(pos.z);
                  const heading = pos.headingDeg || 0;
                  const sc = (isEditing ? planeSize * 1.5 : planeSize) / MAP_PLANE_VB;
                  const lblOff = isEditing ? planeLabelOff * 1.2 : planeLabelOff;

                  return (
                    <g key={ac.callsign}>
                      <g className={`star-map-aircraft${isEditing ? ' editing' : ''}`}
                        style={{
                          transform: `translate(${sx}px, ${sy}px) rotate(${heading}deg)`,
                        }}
                      >
                        <g transform={`scale(${sc}) translate(-256, -256)`}>
                          <path d={MAP_ICON_PATH} />
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
