import React, { useState, useMemo, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { IoClose } from 'react-icons/io5';
import { useTranslation } from '../../../hooks/useTranslation';
import './StandMap.css';

const PAD_RATIO = 0.10;
const GAP = 8;
const HEADER_H = 34;
const LEGEND_H = 30;
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

// ── StandMap ──────────────────────────────────────────────

export default function StandMap({ stands, selectedStand, occupiedStands, onSelect, onClose, cellRef, airportIcao }) {
  const { t } = useTranslation();
  const [hoveredId, setHoveredId] = useState(null);
  const [panelPos, setPanelPos] = useState({ top: 0 });
  const panelRef = useRef(null);
  const { w: winW, h: winH } = useWindowSize();

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
    // so the map fills more visual space instead of being a thin strip.
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
    }));

    return { dots, viewBox: `${vbX} ${vbY} ${vbW} ${vbH}`, vbX, vbY, vbW, vbH };
  }, [stands]);

  // ── SVG pixel size: proportional to viewport, data aspect ratio ─
  const dataRatio = vbW / vbH;
  // SVG scales with window width, clamped by height so it never overflows vertically
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

  // ── Position ─────────────────────────────────────────────
  useLayoutEffect(() => {
    let top = GAP;
    if (cellRef?.current) {
      top = cellRef.current.getBoundingClientRect().top;
    }
    if (top + panelH > winH - GAP) top = winH - panelH - GAP;
    if (top < GAP) top = GAP;
    setPanelPos({ top });
  }, [cellRef, panelH, winH]);

  // ── ViewBox-relative sizing ───────────────────────────────
  const vbDiag = Math.max(vbW, vbH);
  const dotR = vbDiag * 0.008;
  const hoverR = vbDiag * 0.012;
  const currentR = vbDiag * 0.015;
  const ringR = vbDiag * 0.022;
  const fontSize = vbDiag * 0.02;
  const labelOff = vbDiag * 0.03;

  // ── Close handlers ────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    const handleClick = (e) => {
      // Don't close if click is inside panel OR inside the cell (user interacting with dropdown)
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        if (cellRef?.current && cellRef.current.contains(e.target)) return;
        onClose();
      }
    };
    const timer = setTimeout(() => window.addEventListener('mousedown', handleClick), 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handleClick);
    };
  }, [onClose, cellRef]);

  // ── Dot state ────────────────────────────────────────────
  const getState = useCallback((standId) => {
    if (standId === selectedStand) return 'current';
    if (standId === hoveredId && !occupiedStands?.has(standId)) return 'hovered';
    if (occupiedStands?.has(standId)) return 'occupied';
    return 'available';
  }, [selectedStand, hoveredId, occupiedStands]);

  const handleDotClick = useCallback((e, standId) => {
    e.stopPropagation();
    e.preventDefault();
    if (occupiedStands?.has(standId)) return;
    onSelect(standId);
  }, [occupiedStands, onSelect]);

  const handleDotMouseDown = useCallback((e) => {
    // Prevent mousedown from bubbling through React portal to the row,
    // which would toggle row selection.
    e.stopPropagation();
  }, []);

  if (!stands || Object.keys(stands).length === 0) return null;

  return createPortal(
    <div
      className="stand-map-panel"
      style={{
        right: GAP,
        top: Math.round(panelPos.top),
        width: panelW,
        height: panelH,
      }}
      ref={panelRef}
    >
      <div className="stand-map-header">
        <span className="stand-map-title">{t('standmap_title')}</span>
        <button className="stand-map-close" onClick={onClose} title="Close">
          <IoClose size={14} />
        </button>
      </div>

      <svg className="stand-map-svg" viewBox={viewBox} width={svgW} height={svgH}>
        <image
          href={`${airportIcao}_Stand.png`}
          x={vbX} y={vbY} width={vbW} height={vbH}
          preserveAspectRatio="xMidYMid slice"
          opacity="0.2"
          onError={(e) => { e.target.style.display = 'none'; }}
        />

        {dots.map(d => {
          const state = getState(d.id);
          const r = state === 'current' ? currentR : state === 'hovered' ? hoverR : dotR;

          return (
            <g key={d.id}>
              {state === 'current' && (
                <circle cx={d.cx} cy={d.cy} r={ringR} className="stand-map-ring" />
              )}
              <circle
                cx={d.cx} cy={d.cy} r={r}
                className={`stand-map-dot ${state}`}
                onMouseEnter={() => setHoveredId(d.id)}
                onMouseLeave={() => setHoveredId(null)}
                onMouseDown={handleDotMouseDown}
                onClick={(e) => handleDotClick(e, d.id)}
              />
              <text
                x={d.cx} y={d.cy + labelOff}
                textAnchor="middle"
                fontSize={fontSize}
                className="stand-map-label"
              >
                {d.id}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="stand-map-legend">
        <div className="stand-map-legend-item">
          <span className="stand-map-legend-dot lg-current" /> {t('standmap_current')}
        </div>
        <div className="stand-map-legend-item">
          <span className="stand-map-legend-dot lg-available" /> {t('standmap_available')}
        </div>
        <div className="stand-map-legend-item">
          <span className="stand-map-legend-dot lg-occupied" /> {t('standmap_occupied')}
        </div>
      </div>
    </div>,
    document.body
  );
}
