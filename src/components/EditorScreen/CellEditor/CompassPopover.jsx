import React, { useState, useRef, useCallback } from 'react';
import './CellEditor.css';
import { createPortal } from 'react-dom';

const SIZE = 220, CX = SIZE / 2, CY = SIZE / 2, R = 95;
const DIRS = ['N','','','E','','','S','','','W','',''];
const CARDINAL = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

function buildCompassTicks() {
  const els = [];
  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 - 90) * Math.PI / 180;
    const inner = R - 12;
    const x1 = CX + inner * Math.cos(angle), y1 = CY + inner * Math.sin(angle);
    const x2 = CX + R * Math.cos(angle), y2 = CY + R * Math.sin(angle);
    els.push(<line key={'t'+i} className="clock-tick" x1={x1} y1={y1} x2={x2} y2={y2} />);
    if (DIRS[i]) {
      const numR = R - 24;
      els.push(<text key={'n'+i} className="clock-num" x={CX + numR * Math.cos(angle)} y={CY + numR * Math.sin(angle) + 5}>{DIRS[i]}</text>);
    }
  }
  for (let i = 0; i < 36; i++) {
    if (i % 3 === 0) continue;
    const angle = (i * 10 - 90) * Math.PI / 180;
    const inner = R - 6;
    els.push(<line key={'m'+i} className="clock-tick-minor" x1={CX + inner * Math.cos(angle)} y1={CY + inner * Math.sin(angle)} x2={CX + R * Math.cos(angle)} y2={CY + R * Math.sin(angle)} />);
  }
  return els;
}

export default function CompassPopover({ value, onCommit, onClose }) {
  const [deg, setDeg] = useState(() => {
    let d = parseInt(value) || 0;
    if (d < 0) d = 0; if (d > 359) d = 359;
    return d;
  });
  const [inputVal, setInputVal] = useState(String(deg));
  const handRef = useRef(null), arrowRef = useRef(null);

  const updateCompass = useCallback((d) => {
    const angle = (d - 90) * Math.PI / 180;
    const tipX = CX + R * Math.cos(angle), tipY = CY + R * Math.sin(angle);
    const baseAngle = angle + Math.PI; const baseR = 6;
    const bx1 = CX + baseR * Math.cos(baseAngle - 0.6), by1 = CY + baseR * Math.sin(baseAngle - 0.6);
    const bx2 = CX + baseR * Math.cos(baseAngle + 0.6), by2 = CY + baseR * Math.sin(baseAngle + 0.6);
    if (handRef.current) { handRef.current.setAttribute('x1', CX); handRef.current.setAttribute('y1', CY); handRef.current.setAttribute('x2', tipX); handRef.current.setAttribute('y2', tipY); }
    if (arrowRef.current) arrowRef.current.setAttribute('points', `${tipX},${tipY} ${bx1},${by1} ${bx2},${by2}`);
  }, []);

  // Init on mount
  React.useEffect(() => { updateCompass(deg); }, []);

  const dragRef = useRef(false);

  const handleDragMove = useCallback((e) => {
    if (!dragRef.current) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / SIZE;
    const mx = ((e.touches ? e.touches[0].clientX : e.clientX) - rect.left) / scale - CX;
    const my = ((e.touches ? e.touches[0].clientY : e.clientY) - rect.top) / scale - CY;
    let angle = Math.atan2(my, mx) * 180 / Math.PI + 90;
    if (angle < 0) angle += 360;
    const d = Math.round(angle) % 360;
    setDeg(d); setInputVal(String(d)); updateCompass(d);
  }, [updateCompass]);

  const commit = useCallback(() => {
    const v = parseInt(inputVal);
    const newVal = (!isNaN(v) && v >= 0 && v <= 359) ? v : deg;
    onCommit(newVal);
  }, [inputVal, deg, onCommit]);

  return createPortal(
    <div className="time-clock-overlay" onClick={e => { if (e.target.classList.contains('time-clock-overlay')) onClose(); }}>
      <div className="time-clock-popover compass-popover show">
        <div className="clock-title">Wind Direction (deg)</div>
        <svg className="clock-svg compass-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}
          onMouseDown={() => { dragRef.current = true; }}
          onMouseMove={handleDragMove}
          onMouseUp={() => { dragRef.current = false; }}
          onMouseLeave={() => { dragRef.current = false; }}
          onTouchStart={() => { dragRef.current = true; }}
          onTouchMove={handleDragMove}
          onTouchEnd={() => { dragRef.current = false; }}>
          <circle className="clock-face-bg" cx={CX} cy={CY} r={R} />
          {buildCompassTicks()}
          <line ref={handRef} className="compass-hand" />
          <circle className="clock-center-dot compass-dot" cx={CX} cy={CY} r="4" />
          <polygon ref={arrowRef} className="compass-arrowhead" />
        </svg>
        <div className="clock-input-row">
          <input className="clock-time-input compass-input" type="text" value={inputVal} onChange={e => { setInputVal(e.target.value); const v = parseInt(e.target.value); if (!isNaN(v) && v >= 0 && v <= 359) { setDeg(v); updateCompass(v); } }} onKeyDown={e => { if (e.key==='Enter') { e.preventDefault(); commit(); } if (e.key==='Escape') { e.preventDefault(); onClose(); } }} placeholder="000" maxLength={3} autoFocus />
          <span className="compass-unit">°</span>
          <button className="clock-btn clock-btn-ok" onClick={commit}>✓</button>
          <button className="clock-btn clock-btn-cancel" onClick={onClose}>✕</button>
        </div>
        <div className="compass-label">{CARDINAL[Math.round(deg / 22.5) % 16]}  {deg}°</div>
      </div>
    </div>,
    document.body
  );
}
