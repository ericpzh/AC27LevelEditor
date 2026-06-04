import React, { useState, useRef, useCallback, useEffect } from 'react';
import { IoClose } from 'react-icons/io5';
import './CellEditor.css';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../../hooks/useTranslation';

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
  return lines;
}

function setHand(el, x, y, len, angleDeg) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  el.setAttribute('x1', x); el.setAttribute('y1', y);
  el.setAttribute('x2', x + len * Math.cos(rad)); el.setAttribute('y2', y + len * Math.sin(rad));
}

function fmtTime(h, m) {
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

export default function ClockPopover({ value, col, onCommit, onClose }) {
  const { t } = useTranslation();
  const title = col === 'Time' ? t('tl_time') : (t('field_' + col) || col);
  const parsed = (value || '00:00').split(':');
  const [hour, setHour] = useState(parseInt(parsed[0]) || 0);
  const [minute, setMinute] = useState(parseInt(parsed[1]) || 0);
  const [inputVal, setInputVal] = useState(() => fmtTime(hour, minute));
  const hourRef = useRef(null), minRef = useRef(null);

  const updateHands = useCallback((h, m) => {
    if (hourRef.current) setHand(hourRef.current, CX, CY, 42, (h % 12 + m / 60) * 30);
    if (minRef.current) setHand(minRef.current, CX, CY, 62, m * 6);
  }, []);

  const commit = (newVal) => {
    const v = newVal || fmtTime(hour, minute) + ':00';
    onCommit(v);
  };

  const dragRef = useRef({ active: false, lastH: hour, lastM: minute });

  const handleDragStart = useCallback((e) => {
    e.preventDefault();
    dragRef.current = { active: true, lastH: hour, lastM: minute };
  }, [hour, minute]);

  const handleDragMove = useCallback((e) => {
    if (!dragRef.current.active) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / SIZE;
    const mx = ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) / scale - CX;
    const my = ((e.touches ? e.touches[0].clientY : e.clientY) - rect.top) / scale - CY;
    let angle = Math.atan2(my, mx) * 180 / Math.PI + 90;
    if (angle < 0) angle += 360;
    const { lastH, lastM } = dragRef.current;
    let h = hour, m = minute;

    const nm = Math.round(angle / 6) % 60;
    if (lastM > 50 && nm < 10) h = (h + 1) % 24;
    else if (lastM < 10 && nm > 50) h = (h + 23) % 24;
    m = nm; dragRef.current.lastM = m;

    setHour(h); setMinute(m);
    setInputVal(fmtTime(h, m));
    updateHands(h, m);
  }, [hour, minute, updateHands]);

  const handleDragEnd = useCallback(() => { dragRef.current.active = false; }, []);

  const handleInput = useCallback((e) => {
    const val = e.target.value;
    setInputVal(val);
    const match = val.match(/^(\d{1,2}):(\d{1,2})/);
    let h = hour, min = minute;
    if (match) { h = Math.min(23, parseInt(match[1]) || 0); min = Math.min(59, parseInt(match[2]) || 0); }
    else if (/^\d+$/.test(val) && val.length <= 4) {
      h = Math.min(23, parseInt(val.substring(0, 2)) || 0);
      if (val.length >= 3) min = Math.min(59, parseInt(val.substring(2, 4)) || 0);
    }
    setHour(h); setMinute(min);
    updateHands(h, min);
  }, [hour, minute, updateHands]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }, [commit, onClose]);

  useEffect(() => { updateHands(hour, minute); }, []);

  return createPortal(
    <div className="time-clock-overlay" onClick={e => { if (e.target.classList.contains('time-clock-overlay')) onClose(); }}>
      <div className="time-clock-popover show">
        <div className="clock-title">{title}</div>
        <svg className="clock-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}
          onMouseDown={handleDragStart}
          onMouseMove={handleDragMove}
          onMouseUp={handleDragEnd}
          onMouseLeave={handleDragEnd}
          onTouchStart={handleDragStart}
          onTouchMove={handleDragMove}
          onTouchEnd={handleDragEnd}>
          <circle className="clock-face-bg" cx={CX} cy={CY} r={R} />
          {buildTickMarks()}
          <line ref={hourRef} className="clock-hand clock-hand-hour" />
          <line ref={minRef} className="clock-hand clock-hand-minute" />
          <circle className="clock-center-dot" cx={CX} cy={CY} r="4" />
        </svg>
        <div className="clock-input-row">
          <input className="clock-time-input" type="text" value={inputVal} onChange={handleInput} onKeyDown={handleKeyDown} placeholder="HH:MM" maxLength={5} autoFocus />
          <button className="clock-btn clock-btn-ok" onClick={() => commit()}>✓</button>
          <button className="clock-btn clock-btn-cancel" onClick={onClose}><IoClose size={16} /></button>
        </div>
      </div>
    </div>,
    document.body
  );
}
