import React, { useRef, useCallback, useEffect } from 'react';
import './SpinKnob.css';

const KNOB_SIZE = 40;
const CENTER = KNOB_SIZE / 2;
const RADIUS = 16;
const DEG_15 = 15 * Math.PI / 180;

/**
 * Rotary encoder knob — click-drag or scroll-wheel to emit angular steps.
 * Accepts optional `position` (0–1) to set the indicator as an absolute gauge.
 */
export default function SpinKnob({ label, onStep, position, onReset }) {
  const knobRef = useRef(null);
  const indicatorRef = useRef(null);
  const dragRef = useRef(null);          // { prevAngle, cumulative } when dragging
  const hasDragged = useRef(false);      // true if mousemove fired since mousedown

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
    hasDragged.current = true;
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
    dragRef.current = null;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  // ── Mouse-down — begin drag ────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    hasDragged.current = false;
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
    onStep(e.deltaY > 0 ? 1 : -1);
  }, [onStep]);

  return (
    <div className="spin-knob">
      <div
        className="spin-knob-svg-wrapper"
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
          {/* Outer ring */}
          <circle className="spin-knob-ring" cx={CENTER} cy={CENTER} r={RADIUS} />
          {/* Center dot */}
          <circle className="spin-knob-center" cx={CENTER} cy={CENTER} r={2.5} />
          {/* Rotating indicator line */}
          <line
            ref={indicatorRef}
            className="spin-knob-indicator"
            x1={CENTER} y1={CENTER}
            x2={CENTER} y2={CENTER - RADIUS + 4}
            data-angle="0"
          />
        </svg>
      </div>
      {label && <span className="spin-knob-label">{label}</span>}
    </div>
  );
}
