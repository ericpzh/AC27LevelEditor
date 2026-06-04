import React, { useState, useRef, useCallback, useEffect } from 'react';
import './CellEditor.css';
import { createPortal } from 'react-dom';
import { FIELD_LABELS } from '../../../utils/constants';

const SIZE = 220, CX = SIZE / 2, CY = SIZE / 2, R = 95;

function buildTickMarks() {
  const lines = [];
  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90) * Math.PI / 180;
    const inner = R - 10;
    const x1 = CX + inner * Math.cos(angle), y1 = CY + inner * Math.sin(angle);
    const x2 = CX + R * Math.cos(angle), y2 = CY + R * Math.sin(angle);
    const numR = R - 22;
    const nx = CX + numR * Math.cos(angle), ny = CY + numR * Math.sin(angle) + 5;
    lines.push(<line key={'t'+i} className="clock-tick" x1={x1} y1={y1} x2={x2} y2={y2} />);
    lines.push(<text key={'n'+i} className="clock-num" x={nx} y={ny}>{i === 0 ? 12 : i}</text>);
  }
  for (let i = 0; i < 60; i++) {
    if (i % 5 === 0) continue;
    const angle = (i * 6 - 90) * Math.PI / 180;
    const inner = R - 5;
    lines.push(<line key={'m'+i} className="clock-tick-minor" x1={CX + inner * Math.cos(angle)} y1={CY + inner * Math.sin(angle)} x2={CX + R * Math.cos(angle)} y2={CY + R * Math.sin(angle)} />);
  }
  return lines;
}

function setHand(el, x, y, len, angleDeg) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  el.setAttribute('x1', x); el.setAttribute('y1', y);
  el.setAttribute('x2', x + len * Math.cos(rad)); el.setAttribute('y2', y + len * Math.sin(rad));
}

export default function ClockPopover({ value, col, onCommit, onClose }) {
  const parsed = (value || '00:00:00').split(':');
  const [hour, setHour] = useState(parseInt(parsed[0]) || 0);
  const [minute, setMinute] = useState(parseInt(parsed[1]) || 0);
  const [second, setSecond] = useState(parseInt(parsed[2]) || 0);
  const [inputVal, setInputVal] = useState(() => `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}`);
  const hourRef = useRef(null), minRef = useRef(null), secRef = useRef(null);

  const updateHands = useCallback((h, m, s) => {
    if (hourRef.current) setHand(hourRef.current, CX, CY, 42, ((h % 12) + m / 60 + s / 3600) * 30);
    if (minRef.current) setHand(minRef.current, CX, CY, 62, (m + s / 60) * 6);
    if (secRef.current) setHand(secRef.current, CX, CY, 70, s * 6);
  }, []);

  const commit = (newVal) => {
    const v = newVal || `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}`;
    onCommit(v);
  };

  // Drag state
  const dragRef = useRef({ active: false, target: 'minute', lastH: hour, lastM: minute, lastS: second });

  const handleDragStart = useCallback((e, target) => {
    e.preventDefault();
    dragRef.current = { active: true, target: target || 'minute', lastH: hour, lastM: minute, lastS: second };
  }, [hour, minute, second]);

  const handleDragMove = useCallback((e) => {
    if (!dragRef.current.active) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / SIZE;
    const mx = ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) / scale - CX;
    const my = ((e.touches ? e.touches[0].clientY : e.clientY) - rect.top) / scale - CY;
    let angle = Math.atan2(my, mx) * 180 / Math.PI + 90;
    if (angle < 0) angle += 360;
    const { target, lastH, lastM, lastS } = dragRef.current;
    let h = hour, m = minute, s = second;

    if (target === 'hour') {
      const h12 = Math.round(angle / 30) % 12;
      const candidates = [h12, h12 + 12, h12 - 12].filter(x => x >= 0 && x <= 23);
      h = candidates.reduce((best, x) => Math.abs(x - lastH) < Math.abs(best - lastH) ? x : best, candidates[0]);
    } else if (target === 'second') {
      const ns = Math.round(angle / 6) % 60;
      if (lastS > 50 && ns < 10) { m = (m + 1) % 60; if (m === 0) h = (h + 1) % 24; }
      else if (lastS < 10 && ns > 50) { m = (m + 59) % 60; if (m === 59) h = (h + 23) % 24; }
      s = ns; dragRef.current.lastS = s;
    } else {
      const nm = Math.round(angle / 6) % 60;
      if (lastM > 50 && nm < 10) h = (h + 1) % 24;
      else if (lastM < 10 && nm > 50) h = (h + 23) % 24;
      m = nm; dragRef.current.lastM = m;
    }
    setHour(h); setMinute(m); setSecond(s);
    setInputVal(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
    updateHands(h, m, s);
  }, [hour, minute, second, updateHands]);

  const handleDragEnd = useCallback(() => { dragRef.current.active = false; }, []);

  const handleInput = useCallback((e) => {
    const val = e.target.value;
    setInputVal(val);
    const m = val.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    let h = hour, min = minute, sec = second;
    if (m) { h = Math.min(23, parseInt(m[1]) || 0); min = Math.min(59, parseInt(m[2]) || 0); sec = m[3] ? Math.min(59, parseInt(m[3]) || 0) : 0; }
    else if (/^\d+$/.test(val) && val.length <= 6) {
      h = Math.min(23, parseInt(val.substring(0, 2)) || 0);
      if (val.length >= 3) min = Math.min(59, parseInt(val.substring(2, 4)) || 0);
      if (val.length >= 5) sec = Math.min(59, parseInt(val.substring(4, 6)) || 0);
    }
    setHour(h); setMinute(min); setSecond(sec);
    updateHands(h, min, sec);
  }, [hour, minute, second, updateHands]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }, [commit, onClose]);

  // Init hands on mount
  useEffect(() => { updateHands(hour, minute, second); }, []);

  return createPortal(
    <div className="time-clock-overlay" onClick={e => { if (e.target.classList.contains('time-clock-overlay')) onClose(); }}>
      <div className="time-clock-popover show">
        <div className="clock-title">{FIELD_LABELS[col] || col} Time</div>
        <svg className="clock-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}
          onMouseDown={(e) => handleDragStart(e, 'minute')}
          onMouseMove={handleDragMove}
          onMouseUp={handleDragEnd}
          onMouseLeave={handleDragEnd}
          onTouchStart={(e) => handleDragStart(e, 'minute')}
          onTouchMove={handleDragMove}
          onTouchEnd={handleDragEnd}>
          <circle className="clock-face-bg" cx={CX} cy={CY} r={R} />
          {buildTickMarks()}
          <line ref={hourRef} className="clock-hand clock-hand-hour" />
          <line ref={minRef} className="clock-hand clock-hand-minute" />
          <line ref={secRef} className="clock-hand clock-hand-second" />
          <circle className="clock-center-dot" cx={CX} cy={CY} r="4" />
        </svg>
        <div className="clock-input-row">
          <input className="clock-time-input" type="text" value={inputVal} onChange={handleInput} onKeyDown={handleKeyDown} placeholder="HH:MM:SS" maxLength={8} autoFocus />
          <button className="clock-btn clock-btn-ok" onClick={() => commit()}>✓</button>
          <button className="clock-btn clock-btn-cancel" onClick={onClose}>✕</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
