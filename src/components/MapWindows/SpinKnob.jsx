import React, { useRef, useCallback, useEffect, useState } from 'react';
import './SpinKnob.css';

const KNOB_SIZE = 48;
const CENTER = KNOB_SIZE / 2;
const OUTER_R = 22;
const FACE_R = 18;
const DEG_15 = 15 * Math.PI / 180;

// Pre-computed SVG path for the curved double-arrow (constant args)
const ARROW_ARC_D = arrowArcPath(CENTER, CENTER, OUTER_R + 4);

// Curved double-arrow arc around lower 160° (outside bezel)
// Single connected path: left arrowhead → arc → right arrowhead
function arrowArcPath(cx, cy, r) {
  const toRad = (d) => d * Math.PI / 180;
  const startA = 10, endA = 170;
  const sr = toRad(startA), er = toRad(endA);
  const x1 = cx + r * Math.cos(sr), y1 = cy + r * Math.sin(sr);
  const x2 = cx + r * Math.cos(er), y2 = cy + r * Math.sin(er);
  const ah = 5;
  const ahA = toRad(25);
  // Left arrowhead tip → arc start
  const lTipX = x1 + ah * Math.cos(sr - ahA);
  const lTipY = y1 + ah * Math.sin(sr - ahA);
  const lBaseX = x1 + ah * Math.cos(sr + ahA);
  const lBaseY = y1 + ah * Math.sin(sr + ahA);
  // Right arrowhead
  const rTipX = x2 - ah * Math.cos(er + ahA);
  const rTipY = y2 - ah * Math.sin(er + ahA);
  const rBaseX = x2 - ah * Math.cos(er - ahA);
  const rBaseY = y2 - ah * Math.sin(er - ahA);
  // Single continuous stroke: left tip → left base (= arc start) → arc → right base → right tip
  return [
    `M ${lTipX} ${lTipY}`,
    `L ${x1} ${y1}`,
    `A ${r} ${r} 0 0 1 ${x2} ${y2}`,
    `L ${rTipX} ${rTipY}`,
    `M ${x1} ${y1} L ${lBaseX} ${lBaseY}`,
    `M ${x2} ${y2} L ${rBaseX} ${rBaseY}`,
  ].join(' ');
}

/**
 * Rotary encoder knob — click-drag or scroll-wheel to emit angular steps.
 * Accepts optional `position` (0–1) to set the indicator as an absolute gauge.
 */
export default function SpinKnob({ label, onStep, position, onReset }) {
  const knobRef = useRef(null);
  const indicatorRef = useRef(null);
  const dragRef = useRef(null);          // { prevAngle, cumulative } when dragging
  const hasDragged = useRef(false);      // true if mousemove fired since mousedown

  const pressTimerRef = useRef(null);
  const [pressed, setPressed] = useState(false);
  const hasPosition = position !== undefined && position !== null;

  // ── Map position 0–1 to degrees ─────────────────────────────
  // Uses the full sweep range defined by data-min-angle / data-max-angle
  // set on the indicator in CSS or passed via code. Default: -135° to +135°
  const positionToAngle = useCallback((pos) => {
    // Clamp
    const p = Math.max(0, Math.min(1, pos));
    // Map 0→-135, 1→+135
    return -135 + p * 270;
  }, []);

  // ── Keep indicator in sync with position prop ──────────────
  useEffect(() => {
    if (!hasPosition || !indicatorRef.current) return;
    const deg = positionToAngle(position);
    indicatorRef.current.setAttribute('data-angle', String(deg));
    indicatorRef.current.setAttribute('transform', `rotate(${deg} ${CENTER} ${CENTER})`);
  }, [hasPosition, position, positionToAngle]);

  // ── Angle from element center ──────────────────────────────
  const getAngle = useCallback((clientX, clientY) => {
    const el = knobRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(clientY - cy, clientX - cx);
  }, []);

  // ── Mouse-move handler (attached to document during drag) ──
  const handleMouseMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    // Cancel press animation once dragging starts
    if (!hasDragged.current) {
      hasDragged.current = true;
      if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
      setPressed(false);
    }
    const angle = getAngle(e.clientX, e.clientY);
    let delta = angle - d.prevAngle;
    // Normalize to [-PI, PI]
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    d.cumulative += delta;
    d.prevAngle = angle;

    // Emit steps at 15° thresholds (indicator follows position prop, not mouse)
    while (d.cumulative >= DEG_15) {
      onStep(1);
      d.cumulative -= DEG_15;
    }
    while (d.cumulative <= -DEG_15) {
      onStep(-1);
      d.cumulative += DEG_15;
    }
  }, [onStep, getAngle]);

  // ── Mouse-up — end drag ────────────────────────────────────
  const handleMouseUp = useCallback(() => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    setPressed(false);
    dragRef.current = null;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  // ── Mouse-down — begin drag ────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    hasDragged.current = false;
    // Brief delay before showing press animation —
    // if drag starts within this window, press is cancelled
    pressTimerRef.current = setTimeout(() => setPressed(true), 60);
    const angle = getAngle(e.clientX, e.clientY);
    dragRef.current = { prevAngle: angle, cumulative: 0 };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [getAngle, handleMouseMove, handleMouseUp]);

  // ── Click — reset to default if no drag occurred ────────────
  const handleClick = useCallback(() => {
    if (!hasDragged.current && onReset) {
      onReset();
    }
  }, [onReset]);

  // ── Scroll wheel ───────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    onStep(e.deltaY > 0 ? -1 : 1);
  }, [onStep]);

  return (
    <div className="spin-knob">
      <div
        className={'spin-knob-svg-wrapper' + (pressed ? ' pressed' : '')}
        ref={knobRef}
        onMouseDown={handleMouseDown}
        onWheel={handleWheel}
        onClick={handleClick}
      >
        <svg
          className="spin-knob-svg"
          viewBox={`0 0 ${KNOB_SIZE} ${KNOB_SIZE}`}
          width={KNOB_SIZE}
          height={KNOB_SIZE}
        >
          <defs>
            {/* Knob face gradient — convex metallic look */}
            <radialGradient id="knobFace" cx="40%" cy="35%" r="60%">
              <stop offset="0%" stopColor="#5a5a5a" />
              <stop offset="50%" stopColor="#3a3a3a" />
              <stop offset="100%" stopColor="#1e1e1e" />
            </radialGradient>
            {/* Bezel gradient — darker ring around the face */}
            <radialGradient id="knobBezel" cx="40%" cy="35%" r="60%">
              <stop offset="0%" stopColor="#444" />
              <stop offset="100%" stopColor="#181818" />
            </radialGradient>
          </defs>
          {/* Drop shadow under the knob */}
          <circle cx={CENTER + 1} cy={CENTER + 1.5} r={OUTER_R}
            fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="3" />
          {/* Bezel ring */}
          <circle className="spin-knob-bezel" cx={CENTER} cy={CENTER} r={OUTER_R} />
          {/* Knob face */}
          <circle className="spin-knob-face" cx={CENTER} cy={CENTER} r={FACE_R} />
          {/* Tick marks around the ring */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map(deg => {
            const rad = deg * Math.PI / 180;
            const innerR = OUTER_R - 3;
            const outerR2 = OUTER_R - 0.5;
            return (
              <line key={'tk-' + deg}
                x1={CENTER + innerR * Math.cos(rad)}
                y1={CENTER + innerR * Math.sin(rad)}
                x2={CENTER + outerR2 * Math.cos(rad)}
                y2={CENTER + outerR2 * Math.sin(rad)}
                className="spin-knob-tick"
              />
            );
          })}
          {/* Center hub dot */}
          <circle className="spin-knob-center" cx={CENTER} cy={CENTER} r={3} />
          {/* Rotating indicator line */}
          <line
            ref={indicatorRef}
            className="spin-knob-indicator"
            x1={CENTER} y1={CENTER}
            x2={CENTER} y2={CENTER - FACE_R + 4}
            data-angle="0"
          />
          {/* Curved double-arrow around lower 160° */}
          <path
            className="spin-knob-arrow"
            d={ARROW_ARC_D}
          />
        </svg>
      </div>
      {label && <span className="spin-knob-label">{label}</span>}
    </div>
  );
}
