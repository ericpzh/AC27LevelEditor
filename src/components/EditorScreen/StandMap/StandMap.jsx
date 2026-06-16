import React, { useState, useMemo, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { IoRemove } from 'react-icons/io5';
import { useTranslation } from '../../../hooks/useTranslation';
import useDrag from '../../../hooks/useDrag';
import { MAP_PAD_RATIO, MAP_GAP, MAP_HEADER_H, MAP_LEGEND_H, MAP_SVG_FRAC, MAP_MIN_SVG, MAP_PLANE_VB, MAP_ICON_PATH, MAP_TARGET_RATIO, GROUND_MAP_STAND_ACCESS_WIDTH_MULT } from '../../../utils/constants';
import { useAppStore } from '../../../store/appStore';
import './StandMap.css';

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

// ── StandMap ──────────────────────────────────────────────

export default function StandMap({ stands, selectedStand, occupiedStands, onSelect, onShrink, buttonRef, airportIcao, callsign, taxiwayPaths, runwayData, areaData }) {
  const { t } = useTranslation();
  const activeMap = useAppStore(s => s.activeMap);
  const setActiveMap = useAppStore(s => s.setActiveMap);
  const [hoveredId, setHoveredId] = useState(null);
  const [opening, setOpening] = useState(true);
  const [closing, setClosing] = useState(false);
  const [animOrigin, setAnimOrigin] = useState({ x: 0, y: 0 });
  const panelRef = useRef(null);
  const { w: winW, h: winH } = useWindowSize();

  // ── Drag hook (always enabled unless closing) ──────────
  const { pos: dragPos, isDragging, hasDragged, headerHandlers } = useDrag({
    panelRef,
    enabled: !closing,
  });

  // ── Compute viewBox + dots ────────────────────────────────
  const { dots, viewBox, vbX, vbY, vbW, vbH, yMid } = useMemo(() => {
    const entries = Object.entries(stands || {});
    if (entries.length === 0) return { dots: [], viewBox: '', vbX: 0, vbY: 0, vbW: 1, vbH: 1 };

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [, pos] of entries) {
      if (pos.x < minX) minX = pos.x;
      if (pos.x > maxX) maxX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.y > maxY) maxY = pos.y;
    }

    const rangeX = (maxX - minX) || 1;
    const rangeY = (maxY - minY) || 1;
    let padX = rangeX * MAP_PAD_RATIO;
    let padY = rangeY * MAP_PAD_RATIO;

    // Enforce target aspect ratio on viewBox — pad shorter axis
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

    const vbX = minX - padX;
    const vbY = minY - padY;
    const yMid = minY + maxY;

    const dots = entries.map(([id, pos]) => ({
      id,
      cx: pos.x,
      cy: yMid - pos.y,
      heading: pos.heading || 0,
    }));

    return { dots, viewBox: `${vbX} ${vbY} ${vbW} ${vbH}`, vbX, vbY, vbW, vbH, yMid };
  }, [stands]);

  // ── ViewBox-relative sizing ───────────────────────────────
  const vbDiag = Math.max(vbW, vbH);
  const dotR = vbDiag * 0.008;
  const hoverR = vbDiag * 0.012;
  const currentR = vbDiag * 0.015;
  const ringR = vbDiag * 0.022;
  const fontSize = vbDiag * 0.02;
  const labelOff = vbDiag * 0.03;
  const activePlaneScale = vbDiag * 0.028 * 1.5;
  const staticPlaneScale = vbDiag * 0.028;
  const planeFontSize = vbDiag * 0.016;
  const planeLabelOff = vbDiag * 0.035;

  // ── Visible stand labels (greedy collision-avoidance) ──────
  const visibleStandLabels = useMemo(() => {
    if (dots.length === 0) return new Set();

    // Label position: offset from stand centre in tail direction (opposite of heading).
    // Scale distance by horizontal extent — plane icon is wider than tall, so labels
    // need more clearance when pointing horizontally (heading near 0° or 180°).
    const labelCX = (d) => {
      const rad = (d.heading + 180) * Math.PI / 180;
      const hExt = Math.abs(Math.cos(rad));
      return d.cx + labelOff * (1 + 0.6 * hExt) * Math.cos(rad);
    };
    const labelCY = (d) => {
      const rad = (d.heading + 180) * Math.PI / 180;
      const hExt = Math.abs(Math.cos(rad));
      return d.cy + labelOff * (1 + 0.6 * hExt) * Math.sin(rad);
    };

    const alwaysShow = new Set();
    if (selectedStand) alwaysShow.add(selectedStand);
    if (hoveredId && !(hoveredId in (occupiedStands || {}))) alwaysShow.add(hoveredId);

    const occupiedIds = new Set(Object.keys(occupiedStands || {}));

    const estCharW = fontSize * 0.58;
    const labelH = fontSize;

    const candidates = dots
      .filter(d => !alwaysShow.has(d.id) && !occupiedIds.has(d.id))
      .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));

    const placed = [];

    for (const id of alwaysShow) {
      const dot = dots.find(d => d.id === id);
      if (!dot) continue;
      const w = String(id).length * estCharW;
      const lcx = labelCX(dot);
      const lcy = labelCY(dot);
      placed.push({
        id,
        left: lcx - w / 2, right: lcx + w / 2,
        top: lcy - labelH, bottom: lcy,
      });
    }

    for (const d of candidates) {
      const w = String(d.id).length * estCharW;
      const lcx = labelCX(d);
      const lcy = labelCY(d);
      const left  = lcx - w / 2;
      const right = lcx + w / 2;
      const top   = lcy - labelH;
      const bottom = lcy;

      let overlaps = false;
      for (const p of placed) {
        if (left < p.right && right > p.left && top < p.bottom && bottom > p.top) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        placed.push({ id: d.id, left, right, top, bottom });
      }
    }

    return new Set(placed.map(p => p.id));
  }, [dots, selectedStand, hoveredId, occupiedStands, fontSize, labelOff]);

  // ── Target position for animated active-flight plane ──────
  const targetPlanePos = useMemo(() => {
    if (!selectedStand && !hoveredId) return null;
    if (hoveredId && !(hoveredId in (occupiedStands || {}))) {
      const dot = dots.find(d => d.id === hoveredId);
      return dot ? { cx: dot.cx, cy: dot.cy, heading: dot.heading } : null;
    }
    if (selectedStand) {
      const dot = dots.find(d => d.id === selectedStand);
      return dot ? { cx: dot.cx, cy: dot.cy, heading: dot.heading } : null;
    }
    return null;
  }, [selectedStand, hoveredId, occupiedStands, dots]);

  // ── Background area polygon styles (matching GroundMapWindow) ──
  const AREA_TYPE_STYLES = {
    0: { fill: '#1a3a6a', stroke: '#2a5a9a', opacity: 0.20 },
    1: { fill: '#444', stroke: 'none', opacity: 1.0 },
    2: { fill: '#000', stroke: 'none', opacity: 1.0 },
  };

  // ── Background SVG elements: areas, taxiways, runways ──────
  const bgElements = useMemo(() => {
    const els = [];
    const vbDiag = Math.max(vbW, vbH);
    if (!vbDiag) return els;
    const twyW = vbDiag * 0.006;
    // Coordinate transform matching stand dots: cy = yMid - pos.y
    const svgY = (z) => yMid - z;

    // Layer 1: Area polygons (semi-transparent by AreaType)
    if (areaData) {
      Object.entries(areaData).forEach(([areaTypeStr, areas]) => {
        const areaType = parseInt(areaTypeStr, 10);
        const style = AREA_TYPE_STYLES[areaType] || { fill: '#444', stroke: '#444', opacity: 0.20 };
        (areas || []).forEach((area) => {
          if (!area.enabled || !area.points || area.points.length < 3) return;
          const pointsStr = area.points.map(p => `${p.x},${svgY(p.z)}`).join(' ');
          els.push(
            <polygon
              key={'area-' + (area.guid || areaTypeStr + '-' + pointsStr.slice(0, 20))}
              points={pointsStr}
              fill={style.fill}
              fillOpacity={style.opacity}
              stroke={style.stroke}
              strokeWidth={style.stroke === 'none' ? 0 : twyW * 0.6}
              strokeOpacity={style.stroke === 'none' ? 0 : 0.5}
            />
          );
        });
      });
    }

    // Layer 2: Taxiway centerlines (grey)
    if (taxiwayPaths && taxiwayPaths.paths) {
      const twyPaths = taxiwayPaths.paths;
      const runwayNames = new Set(Object.keys(runwayData || {}));

      twyPaths.forEach((tp, i) => {
        if (!tp.points || tp.points.length < 2) return;
        const isRwy = runwayNames.has(tp.name) && runwayData;
        if (isRwy && tp.points.length >= 2) {
          // Runway-as-taxiway segments → black filled polygon
          const a = tp.points[0];
          const b = tp.points[tp.points.length - 1];
          const rwWidth = (runwayData[tp.name]?.width || 0.50);
          const halfW = rwWidth / 2;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const len = Math.sqrt(dx * dx + dz * dz);
          if (len < 1e-9) return;
          const px = dz / len;
          const pz = -dx / len;
          const hx = px * halfW;
          const hz = pz * halfW;
          const corners = [
            { x: a.x - hx, z: a.z - hz },
            { x: a.x + hx, z: a.z + hz },
            { x: b.x + hx, z: b.z + hz },
            { x: b.x - hx, z: b.z - hz },
          ];
          els.push(
            <polygon
              key={'rwy-twy-' + i}
              points={corners.map(p => `${p.x},${svgY(p.z)}`).join(' ')}
              fill="#000" stroke="#000"
            />
          );
        } else {
          // Normal taxiway centerline
          const width = tp.isStandAccess ? twyW * GROUND_MAP_STAND_ACCESS_WIDTH_MULT : twyW;
          els.push(
            <polyline
              key={'twy-' + i}
              points={tp.points.map(p => `${p.x},${svgY(p.z)}`).join(' ')}
              fill="none"
              stroke="#444"
              strokeWidth={width}
              strokeLinecap={tp.isStandAccess ? 'square' : 'round'}
              strokeLinejoin="round"
            />
          );
        }
      });
    }

    // Layer 3: Runway rectangles (black)
    if (runwayData) {
      Object.entries(runwayData).forEach(([name, rw]) => {
        if (!rw.thresholds || rw.thresholds.length < 2) return;
        const a = rw.thresholds[0];
        const b = rw.thresholds[1];
        const halfW = (rw.width || 0.50) / 2;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 1e-9) return;
        const px = dz / len;
        const pz = -dx / len;
        const hx = px * halfW;
        const hz = pz * halfW;
        const corners = [
          { x: a.x - hx, z: a.z - hz },
          { x: a.x + hx, z: a.z + hz },
          { x: b.x + hx, z: b.z + hz },
          { x: b.x - hx, z: b.z - hz },
        ];
        els.push(
          <polygon
            key={'rwy-' + name}
            points={corners.map(p => `${p.x},${svgY(p.z)}`).join(' ')}
            fill="#000" stroke="#000"
          />
        );
      });
    }

    return els;
  }, [taxiwayPaths, runwayData, areaData, yMid, vbW, vbH]);

  // ── SVG pixel size ─────────────────────────────────────────
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

  const panelW = svgW;
  const panelH = svgH + MAP_HEADER_H + MAP_LEGEND_H;

  // ── Position: right-aligned by default; drag overrides ──
  const controlled = hasDragged || isDragging;
  const effLeft = controlled ? dragPos.left : undefined;
  const effTop = controlled ? dragPos.top : MAP_GAP;
  const effRight = !controlled ? MAP_GAP : undefined;

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
    console.log('[StandMap] useLayoutEffect mount — setting origin, triggering expand');
    updateOrigin();
    // Trigger expand animation on next frame via state (survives re-renders)
    const raf = requestAnimationFrame(() => {
      console.log('[StandMap] expand — removing opening state');
      setOpening(false);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Shrink handler ─────────────────────────────────────
  const handleShrink = useCallback(() => {
    console.log('[StandMap] handleShrink called');
    updateOrigin();
    setClosing(true);
  }, [updateOrigin]);

  const handleTransitionEnd = useCallback((e) => {
    console.log('[StandMap] transitionEnd', { propertyName: e.propertyName, closing, targetClass: e.target.className });
    if (e.propertyName === 'transform' && closing) {
      console.log('[StandMap] shrink complete — calling onShrink');
      onShrink();
    }
  }, [closing, onShrink]);

  // ── Escape key closes ──────────────────────────────────
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') handleShrink(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleShrink]);

  // ── Dot state ──────────────────────────────────────────
  const getState = useCallback((standId) => {
    // No callsign (no aircraft selected): all stands disabled
    if (!callsign) return 'disabled';
    if (standId === selectedStand) return 'current';
    if (standId === hoveredId && !(standId in (occupiedStands || {}))) return 'hovered';
    if (standId in (occupiedStands || {})) return 'occupied';
    return 'available';
  }, [callsign, selectedStand, hoveredId, occupiedStands]);

  const handleDotClick = useCallback((e, standId) => {
    e.stopPropagation();
    e.preventDefault();
    if (!callsign) return;
    if (standId in (occupiedStands || {})) return;
    onSelect(standId);
  }, [callsign, occupiedStands, onSelect]);

  const handleDotMouseDown = useCallback((e) => {
    e.stopPropagation();
  }, []);

  if (!stands || Object.keys(stands).length === 0) return null;

  return createPortal(
    <div
      className={`stand-map-panel${opening ? ' opening' : ''}${isDragging ? ' dragging' : ''}${closing ? ' closing' : ''}`}
      ref={panelRef}
      style={{
        left: effLeft,
        right: effRight,
        top: effTop,
        width: panelW,
        height: panelH,
        transformOrigin: `${animOrigin.x}px ${animOrigin.y}px`,
        zIndex: activeMap === 'stand' ? 251 : 250,
      }}
      onTransitionEnd={handleTransitionEnd}
      onMouseDownCapture={() => setActiveMap('stand')}
    >
      <div className="stand-map-header" {...headerHandlers}>
        <span className="stand-map-title">{t('standmap_title')}</span>
        <div className="stand-map-header-actions">
          <button
            className="stand-map-shrink"
            onClick={handleShrink}
            title={t('minimize') || 'Hide'}
          >
            <IoRemove size={14} />
          </button>
        </div>
      </div>

      <div className="stand-map-content-wrap">
        <svg className="stand-map-svg" viewBox={viewBox} width={svgW} height={svgH}>
          {/* Dark radar-style background */}
          <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="#0a1628" />

          {/* Programmatic SVG background: areas, taxiways, runways */}
          <g opacity="0.2">{bgElements}</g>

          {/* ── Stand dots / static plane icons ────────────────── */}
          {dots.map(d => {
            const state = getState(d.id);
            const isOccupied = state === 'occupied';
            const showLabel = visibleStandLabels.has(d.id);
            const r = state === 'current' ? currentR : state === 'hovered' ? hoverR : dotR;

            return (
              <g key={d.id}>
                {state === 'current' && (
                  <circle cx={d.cx} cy={d.cy} r={ringR} className="stand-map-ring" />
                )}

                {isOccupied ? (
                  <g transform={`translate(${d.cx}, ${d.cy})`} className="stand-map-plane-group">
                    <g transform={`rotate(${d.heading}) scale(${staticPlaneScale / MAP_PLANE_VB}) translate(-256, -256)`}>
                      <path d={MAP_ICON_PATH} className="stand-map-plane" />
                    </g>
                    {(occupiedStands[d.id]?.callsign) && (
                      <text
                        x={planeLabelOff * (1 + 0.6 * Math.abs(Math.cos(d.heading * Math.PI / 180))) * Math.cos(d.heading * Math.PI / 180)}
                        y={planeLabelOff * (1 + 0.6 * Math.abs(Math.cos(d.heading * Math.PI / 180))) * Math.sin(d.heading * Math.PI / 180)}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={planeFontSize}
                        className="stand-map-ac-label">
                        {occupiedStands[d.id].callsign}
                      </text>
                    )}
                  </g>
                ) : (
                  <circle
                    cx={d.cx} cy={d.cy} r={r}
                    className={`stand-map-dot ${state}`}
                    onMouseEnter={() => setHoveredId(d.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onMouseDown={handleDotMouseDown}
                    onClick={(e) => handleDotClick(e, d.id)}
                  />
                )}

                {!isOccupied && showLabel && (
                  <text
                    x={d.cx + labelOff * (1 + 0.6 * Math.abs(Math.cos((d.heading + 180) * Math.PI / 180))) * Math.cos((d.heading + 180) * Math.PI / 180)}
                    y={d.cy + labelOff * (1 + 0.6 * Math.abs(Math.cos((d.heading + 180) * Math.PI / 180))) * Math.sin((d.heading + 180) * Math.PI / 180)}
                    textAnchor="middle"
                    fontSize={fontSize}
                    className={`stand-map-label${d.id === hoveredId ? ' hovered' : ''}${d.id === selectedStand ? ' selected' : ''}`}
                  >
                    {d.id}
                  </text>
                )}
              </g>
            );
          })}

          {/* ── Animated active-flight plane icon ──────── */}
          {targetPlanePos && callsign && (
            <g transform={`translate(${targetPlanePos.cx}, ${targetPlanePos.cy})`}
               className="stand-map-active-plane">
              <g transform={`rotate(${targetPlanePos.heading}) scale(${activePlaneScale / MAP_PLANE_VB}) translate(-256, -256)`}>
                <path d={MAP_ICON_PATH} />
              </g>
              <text
                x={planeLabelOff * (1 + 0.6 * Math.abs(Math.cos(targetPlanePos.heading * Math.PI / 180))) * Math.cos(targetPlanePos.heading * Math.PI / 180)}
                y={planeLabelOff * (1 + 0.6 * Math.abs(Math.cos(targetPlanePos.heading * Math.PI / 180))) * Math.sin(targetPlanePos.heading * Math.PI / 180)}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={planeFontSize}
                className="stand-map-ac-label active">
                {callsign}
              </text>
            </g>
          )}
        </svg>

        <div className="stand-map-legend">
          <div className="stand-map-legend-item">
            <span className="stand-map-legend-dot lg-current" /> {t('standmap_current')}
          </div>
          <div className="stand-map-legend-item">
            <span className="stand-map-legend-dot lg-available" /> {t('standmap_available')}
          </div>
          <div className="stand-map-legend-item">
            <svg className="stand-map-legend-plane" viewBox="0 0 512 512" width="12" height="12">
              <path d={MAP_ICON_PATH} fill="var(--text-muted)" />
            </svg>
            {t('standmap_occupied')}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
