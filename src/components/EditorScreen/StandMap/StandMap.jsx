import React, { useState, useMemo, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { IoRemove } from 'react-icons/io5';
import { useTranslation } from '../../../hooks/useTranslation';
import useDrag from '../../../hooks/useDrag';
import { useAppStore } from '../../../store/appStore';
import './StandMap.css';

const PAD_RATIO = 0.10;
const GAP = 8;
const HEADER_H = 38;
const LEGEND_H = 40;
const SVG_FRAC = 0.48;     // fraction of viewport width for longer SVG side
const MIN_SVG = 680;       // floor — legend always fits
const PLANE_VB = 512;
// IoAirplane icon path (same as StarMap)
const ICON_PATH = "M186.62 464H160a16 16 0 0 1-14.57-22.6l64.46-142.25L113.1 297l-35.3 42.77C71.07 348.23 65.7 352 52 352H34.08a17.66 17.66 0 0 1-14.7-7.06c-2.38-3.21-4.72-8.65-2.44-16.41l19.82-71c.15-.53.33-1.06.53-1.58a.38.38 0 0 0 0-.15 14.82 14.82 0 0 1-.53-1.59l-19.84-71.45c-2.15-7.61.2-12.93 2.56-16.06a16.83 16.83 0 0 1 13.6-6.7H52c10.23 0 20.16 4.59 26 12l34.57 42.05 97.32-1.44-64.44-142A16 16 0 0 1 160 48h26.91a25 25 0 0 1 19.35 9.8l125.05 152 57.77-1.52c4.23-.23 15.95-.31 18.66-.31C463 208 496 225.94 496 256c0 9.46-3.78 27-29.07 38.16-14.93 6.6-34.85 9.94-59.21 9.94-2.68 0-14.37-.08-18.66-.31l-57.76-1.54-125.36 152a25 25 0 0 1-19.32 9.75z";

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

export default function StandMap({ stands, selectedStand, occupiedStands, onSelect, onShrink, buttonRef, airportIcao, callsign }) {
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
  const { dots, viewBox, vbX, vbY, vbW, vbH } = useMemo(() => {
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
    let padX = rangeX * PAD_RATIO;
    let padY = rangeY * PAD_RATIO;

    // Enforce target aspect ratio on viewBox — pad shorter axis
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

    const vbX = minX - padX;
    const vbY = minY - padY;
    const yMid = minY + maxY;

    const dots = entries.map(([id, pos]) => ({
      id,
      cx: pos.x,
      cy: yMid - pos.y,
      heading: pos.heading || 0,
    }));

    return { dots, viewBox: `${vbX} ${vbY} ${vbW} ${vbH}`, vbX, vbY, vbW, vbH };
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

  // ── SVG pixel size ─────────────────────────────────────────
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

  const panelW = svgW;
  const panelH = svgH + HEADER_H + LEGEND_H;

  // ── Position: right-aligned by default; drag overrides ──
  const controlled = hasDragged || isDragging;
  const effLeft = controlled ? dragPos.left : undefined;
  const effTop = controlled ? dragPos.top : GAP;
  const effRight = !controlled ? GAP : undefined;

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
          <image
            href={`${airportIcao}_Stand.png`}
            x={vbX} y={vbY} width={vbW} height={vbH}
            preserveAspectRatio="xMidYMid slice"
            opacity="0.2"
            onError={(e) => { e.target.style.display = 'none'; }}
          />

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
                    <g transform={`rotate(${d.heading}) scale(${staticPlaneScale / PLANE_VB}) translate(-256, -256)`}>
                      <path d={ICON_PATH} className="stand-map-plane" />
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
              <g transform={`rotate(${targetPlanePos.heading}) scale(${activePlaneScale / PLANE_VB}) translate(-256, -256)`}>
                <path d={ICON_PATH} />
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
              <path d={ICON_PATH} fill="var(--text-muted)" />
            </svg>
            {t('standmap_occupied')}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
