import React, { useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef, forwardRef } from 'react';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import useUdpAircraftState from './useUdpAircraftState';
import SimClock from './SimClock';
import MapHelpOverlay from './MapHelpOverlay';
import { IoHelpCircleOutline, IoRefreshOutline } from 'react-icons/io5';
import { witchDirection, isParked, getSpriteSheet, getSpriteCell, getSpriteViewBox, SPRITE_CELL, SPRITE_SHEET_W, SPRITE_SHEET_H } from './witchMode';
import FlightStripCommandBar from './FlightStripCommandBar';
import { getCommandChildren, setTaxiways } from './commandTree';
import './FlightStripsWindow.css';

const SEAT_LABELS = { 1: 'RMP', 2: 'GND', 3: 'TWR', 4: 'DEP', 5: 'APPR', 6: 'DEL', 7: 'APN' };
const SEAT_LABELS_FULL = { 1: 'RAMP', 2: 'GROUND', 3: 'TOWER', 4: 'DEPARTURE', 5: 'APPROACH', 6: 'DELIVERY', 7: 'APRON' };
const STRIP_HEIGHT = 61; // 58px min-height + 3px gap

// Telemetry status → CSS modifier class (2=ActionRequired, 3=HandoffPending, 4=PendingAtStand)
const TELEMETRY_STRIP_CLASS = { 2: 'strip-telemetry-action-required', 3: 'strip-telemetry-handoff-pending', 4: 'strip-telemetry-pending-stand' };

// ─── Helpers ──────────────────────────────────────────────────────

/** Compute witch mode RPG stats from callsign + aircraft telemetry. */
function computeWitchStats(callSign, ac) {
  const digits = (callSign || '').replace(/\D/g, '');
  // HP: first two digits (if "00", take 100)
  const firstTwo = digits.slice(0, 2);
  let hp = parseInt(firstTwo, 10) || 0;
  if (firstTwo === '00') hp = 100;
  // MP: last two digits (if "01", take 1)
  const lastTwo = digits.slice(-2) || '00';
  let mp = parseInt(lastTwo, 10) || 0;
  if (lastTwo === '01') mp = 1;
  // ATK: speed in knots / 10
  const atk = Math.round((ac.airSpeedKnot || 0) / 10);
  // DEF: altitude — position.y is in game-units (1 GU = 100m), so / 0.3048
  // already yields ft/100 (same value shown on air radar label)
  const def = Math.round((ac.position && ac.position.y != null ? ac.position.y : 0) / 0.3048);
  return { hp, mp, atk, def };
}

/** Stable reorder: move srcIdx → dstIdx within a seat, preserving runway groups. */
function applyReorder(prev, seat, srcIdx, dstIdx) {
  // Flatten all strips in this seat across runways
  const all = [];
  const keys = Object.keys(prev[seat] || {}).sort();
  for (let k = 0; k < keys.length; k++) {
    const list = prev[seat][keys[k]] || [];
    for (let i = 0; i < list.length; i++) all.push({ cs: list[i], rwy: keys[k] });
  }
  if (srcIdx >= all.length || srcIdx < 0) return prev;
  const item = all[srcIdx];
  all.splice(srcIdx, 1);
  const dst = Math.min(dstIdx, all.length);
  all.splice(dst, 0, item);
  // Rebuild runway groups
  const ns = {};
  for (let k2 = 0; k2 < keys.length; k2++) ns[keys[k2]] = [];
  for (let j = 0; j < all.length; j++) {
    if (!ns[all[j].rwy]) ns[all[j].rwy] = [];
    ns[all[j].rwy].push(all[j].cs);
  }
  const r = Object.assign({}, prev);
  r[seat] = ns;
  return r;
}

// ─── Sub-component: single flight strip content ──────────────────

const FlightStripContent = React.memo(function FlightStripContent({
  ac, fd, seat, idx, isSelected, showGap, isArrival,
  seatLabel, sidFromMap, routeLines, onMouseDown,
  witchMode, witchFrame,
}) {
  const stripRef = useRef(null);
  const [transformOrigin, setTransformOrigin] = useState('center center');

  useLayoutEffect(() => {
    if (isSelected && stripRef.current) {
      const rect = stripRef.current.getBoundingClientRect();
      // scale(1.20) expands 10% per side from center
      const expandX = rect.width * 0.10;
      const expandY = rect.height * 0.10;

      const overflowRight = rect.right + expandX > window.innerWidth;
      const overflowLeft = rect.left - expandX < 0;
      const overflowBottom = rect.bottom + expandY > window.innerHeight;
      const overflowTop = rect.top - expandY < 0;

      let originX = 'center';
      let originY = 'center';

      // Grow away from the overflowing edge
      if (overflowRight && !overflowLeft) originX = 'right';
      else if (overflowLeft && !overflowRight) originX = 'left';

      if (overflowBottom && !overflowTop) originY = 'bottom';
      else if (overflowTop && !overflowBottom) originY = 'top';

      setTransformOrigin(originX + ' ' + originY);
    } else if (!isSelected) {
      setTransformOrigin('center center');
    }
  }, [isSelected]);

  return (
    <div
      ref={stripRef}
      key={ac.callSign}
      data-seat={seat}
      data-runway={ac.runway || '__'}
      className={'flight-strip' + (isArrival ? ' strip-arrival' : ' strip-departure') +
        (isSelected ? ' strip-selected' : '') +
        (showGap ? ' strip-gap-above' : '') +
        (TELEMETRY_STRIP_CLASS[ac.telemetryStatus] ? ' ' + TELEMETRY_STRIP_CLASS[ac.telemetryStatus] : '')}
      style={isSelected ? { transformOrigin } : undefined}
      data-callsign={ac.callSign}
      onMouseDown={onMouseDown}
    >
      {witchMode && (
        <div className="strip-witch-sprite">
          {(() => {
            const isAirborne = ac.position && ac.position.y > 1.0;
            const parkedOnGround = !isAirborne && isParked(ac);
            const action = isAirborne ? 'fly' : (parkedOnGround ? 'stand' : 'walk');
            const dir = parkedOnGround ? '' : witchDirection(ac.noseDirection);
            const cell = getSpriteCell(action, dir, witchFrame + 1);
            const vb = getSpriteViewBox(action, dir, witchFrame + 1);
            const sz = 48;
            const cid = 'cp-strip-' + ac.callSign;
            const fid = 'glow-strip-' + ac.callSign;
            const stats = computeWitchStats(ac.callSign, ac);
            return (
              <>
                <svg width={sz} height={sz} viewBox={vb} style={{ marginTop: '5px' }}>
                  <defs>
                    <clipPath id={cid}><rect x={cell.x} y={cell.y} width={SPRITE_CELL} height={SPRITE_CELL} /></clipPath>
                    <filter id={fid} x="-100%" y="-100%" width="300%" height="300%">
                      <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="white" flood-opacity="0.7" />
                    </filter>
                  </defs>
                  <image href={getSpriteSheet(ac.callSign, ac.spriteIdx)}
                    width={SPRITE_SHEET_W} height={SPRITE_SHEET_H}
                    clipPath={`url(#${cid})`}
                    {...(isSelected ? { filter: `url(#${fid})` } : {})} />
                </svg>
                <div className="strip-witch-stats">
                  <span className="witch-stat"><span className="witch-stat-label">HP</span>{stats.hp}</span>
                  <span className="witch-stat"><span className="witch-stat-label">MP</span>{stats.mp}</span>
                  <span className="witch-stat"><span className="witch-stat-label">ATK</span>{stats.atk}</span>
                  <span className="witch-stat"><span className="witch-stat-label">DEF</span>{stats.def}</span>
                </div>
              </>
            );
          })()}
        </div>
      )}
      <div className="strip-col-callsign">
        <div className="strip-box callsign-box"><span className="strip-callsign">{ac.callSign}</span></div>
        <div className="strip-callsign-info"><span className="strip-type">{ac.aircraftType}</span><span className="strip-stand-label">{ac.stand || ''}</span></div>
      </div>
      <div className="strip-col-proc">
        <span className="strip-sid-star">{ac.star || fd.airway || sidFromMap || '-'}</span>
        <span className="strip-reg">{fd.registration || ''}</span>
        <span className="strip-airport">{fd.airport || ''}</span>
      </div>
      <div className="strip-col-squawk"><span className="strip-squawk">{fd.squawk || ''}</span></div>
      <div className="strip-col-route">
        {(routeLines || [{ text: ac.route || '-', struck: false }]).map((line, i) =>
          <span key={i} className={'strip-taxi-route' + (line.struck ? ' strip-route-struck' : '')}>{line.text}</span>
        )}
      </div>
      <div className="strip-col-runway">
        <span className="strip-runway">{ac.runway || '--'}</span>
        <div className="strip-box channel-box"><span className="strip-channel">{seatLabel}</span></div>
      </div>
    </div>
  );
});

// ─── Drag ghost (floating clone of dragged strip) ────────────────

const DragGhost = forwardRef(function DragGhost({ ac, fd, seatLabel, sidFromMap, rectLeft, rectTop, rectW, isArrival, routeLines, telemetryClass, witchMode, witchFrame }, ref) {
  return (
    <div
      ref={ref}
      className={'flight-strip strip-drag-ghost' + (isArrival ? ' strip-arrival' : ' strip-departure') + (telemetryClass ? ' ' + telemetryClass : '')}
      style={{ position: 'fixed', left: rectLeft + 'px', top: rectTop + 'px', zIndex: 9999, pointerEvents: 'none', width: rectW + 'px' }}
    >
      {witchMode && (
        <div className="strip-witch-sprite">
          {(() => {
            const isAirborne = ac.position && ac.position.y > 1.0;
            const parkedOnGround = !isAirborne && isParked(ac);
            const action = isAirborne ? 'fly' : (parkedOnGround ? 'stand' : 'walk');
            const dir = parkedOnGround ? '' : witchDirection(ac.noseDirection);
            const cell = getSpriteCell(action, dir, witchFrame + 1);
            const vb = getSpriteViewBox(action, dir, witchFrame + 1);
            const sz = 48;
            const cid = 'cp-ghost-' + ac.callSign;
            const fid = 'glow-ghost-' + ac.callSign;
            const stats = computeWitchStats(ac.callSign, ac);
            return (
              <>
                <svg width={sz} height={sz} viewBox={vb} style={{ marginTop: '5px' }}>
                  <defs>
                    <clipPath id={cid}><rect x={cell.x} y={cell.y} width={SPRITE_CELL} height={SPRITE_CELL} /></clipPath>
                    <filter id={fid} x="-100%" y="-100%" width="300%" height="300%">
                      <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="white" flood-opacity="0.7" />
                    </filter>
                  </defs>
                  <image href={getSpriteSheet(ac.callSign, ac.spriteIdx)}
                    width={SPRITE_SHEET_W} height={SPRITE_SHEET_H}
                    clipPath={`url(#${cid})`} />
                </svg>
                <div className="strip-witch-stats">
                  <span className="witch-stat"><span className="witch-stat-label">HP</span>{stats.hp}</span>
                  <span className="witch-stat"><span className="witch-stat-label">MP</span>{stats.mp}</span>
                  <span className="witch-stat"><span className="witch-stat-label">ATK</span>{stats.atk}</span>
                  <span className="witch-stat"><span className="witch-stat-label">DEF</span>{stats.def}</span>
                </div>
              </>
            );
          })()}
        </div>
      )}
      <div className="strip-col-callsign">
        <div className="strip-box callsign-box"><span className="strip-callsign">{ac.callSign}</span></div>
        <div className="strip-callsign-info"><span className="strip-type">{ac.aircraftType}</span><span className="strip-stand-label">{ac.stand || ''}</span></div>
      </div>
      <div className="strip-col-proc">
        <span className="strip-sid-star">{ac.star || fd.airway || sidFromMap || '-'}</span>
        <span className="strip-reg">{fd.registration || ''}</span>
        <span className="strip-airport">{fd.airport || ''}</span>
      </div>
      <div className="strip-col-squawk"><span className="strip-squawk">{fd.squawk || ''}</span></div>
      <div className="strip-col-route">
        {(routeLines || [{ text: ac.route || '-', struck: false }]).map((line, i) =>
          <span key={i} className={'strip-taxi-route' + (line.struck ? ' strip-route-struck' : '')}>{line.text}</span>
        )}
      </div>
      <div className="strip-col-runway">
        <span className="strip-runway">{ac.runway || '--'}</span>
        <div className="strip-box channel-box"><span className="strip-channel">{seatLabel}</span></div>
      </div>
    </div>
  );
});

// ─── Main component ───────────────────────────────────────────────

export default function FlightStripsWindow({ airportIcao }) {
  const electronAPI = useElectronAPI();
  const sp = new URLSearchParams(window.location.search);
  const rootPath = decodeURIComponent(sp.get('root') || '');
  const { aircraft: udpAircraft, currentAirport: udpAirport, simTimeUnixMs, timeScale, udpAirportChanged } = useUdpAircraftState();
  const [helpOpen, setHelpOpen] = useState(false);
  const [flightData, setFlightData] = useState({});
  const [runwaySidMap, setRunwaySidMap] = useState({});
  const [dataLoading, setDataLoading] = useState(true);
  const [selectedCallSign, setSelectedCallSign] = useState(null);
  const selectedCallSignRef = useRef(null);
  const [witchMode, setWitchMode] = useState(false);
  const [witchFrame, setWitchFrame] = useState(0);
  const witchTimerRef = useRef(null);
  const helpDblClickRef = useRef(null);
  const [commandPath, setCommandPath] = useState([]);

  // Keep ref in sync so handleDragEnd (stable callback) can read current selection
  useEffect(() => { selectedCallSignRef.current = selectedCallSign; }, [selectedCallSign]);

  // Drag state — only layout-affecting values live in React state.
  // Pixel-level ghost tracking uses direct DOM via ghostRef (no re-render).
  const dragMetaRef = useRef({ startY: 0, rectTop: 0, rectLeft: 0, rectW: 0, callSign: '', ac: null, srcIdx: -1, seat: 0, srcRunway: '__' });
  const ghostRef = useRef(null);
  const initialState = { isDragging: false, hasMoved: false, hoverIdx: -1, seat: 0, isDropping: false };
  const [dragState, setDragState] = useState(initialState);
  const holdTimer = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ─── Route history: track taxiway/airway changes per callsign ────

  const [routeHistory, setRouteHistory] = useState({});  // { callsign: [{ text, struck }] }
  const prevRouteRef = useRef({});                         // { callsign: lastSeenRoute }

  useEffect(() => {
    if (!udpAircraft || udpAircraft.length === 0) return;
    setRouteHistory((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const ac of udpAircraft) {
        const cs = ac.callSign;
        const cur = (ac.route || '').trim();
        const last = prevRouteRef.current[cs];
        if (last !== undefined && last === cur) continue; // no change
        prevRouteRef.current[cs] = cur;
        const history = (prev[cs] || []).map((h) => ({ ...h, struck: true }));
        if (cur) history.push({ text: cur, struck: false });
        next[cs] = history.slice(-4); // keep last 4 lines
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [udpAircraft]);

  // ─── Witch mode animation timer (500ms per frame) ──────────────
  useEffect(() => {
    if (!witchMode) {
      if (witchTimerRef.current) { clearInterval(witchTimerRef.current); witchTimerRef.current = null; }
      setWitchFrame(0);
      return;
    }
    witchTimerRef.current = setInterval(() => { setWitchFrame(f => (f === 0 ? 1 : 0)); }, 500);
    return () => {
      if (witchTimerRef.current) { clearInterval(witchTimerRef.current); witchTimerRef.current = null; }
    };
  }, [witchMode]);

  // Cleanup drag listeners on unmount (safety net)
  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    };
  }, []);

  // ─── Drop animation: ghost slides from mouse position into the slot ──

  useEffect(() => {
    if (!dragState.isDropping || !ghostRef.current) return;
    const meta = dragMetaRef.current;
    const ghost = ghostRef.current;

    // Double rAF: wait for React re-render with new strip order, then paint
    let frame1;
    const frame2 = requestAnimationFrame(() => {
      frame1 = requestAnimationFrame(() => {
        const stripEl = document.querySelector(`[data-callsign="${meta.callSign}"]`);
        if (!stripEl || !ghost) {
          finish();
          return;
        }
        const rect = stripEl.getBoundingClientRect();
        // Animate ghost to the strip's new position, scaling down & fading out
        ghost.style.top = rect.top + 'px';
        ghost.style.left = rect.left + 'px';
        ghost.classList.add('strip-dropping');

        let finished = false;
        const onEnd = (e) => {
          if (finished) return;
          if (e.propertyName === 'top' || e.propertyName === 'opacity') {
            finished = true;
            ghost.removeEventListener('transitionend', onEnd);
            finish();
          }
        };
        ghost.addEventListener('transitionend', onEnd);
        // Fallback timeout in case transitionend doesn't fire
        setTimeout(() => { if (!finished) { finished = true; ghost.removeEventListener('transitionend', onEnd); finish(); } }, 400);
      });
    });

    const finish = () => {
      if (ghost) {
        ghost.classList.remove('strip-dropping');
      }
      setDragState(initialState);
      setSelectedCallSign(null);
    };

    return () => {
      cancelAnimationFrame(frame2);
      if (frame1) cancelAnimationFrame(frame1);
    };
  }, [dragState.isDropping]);

  // ─── Data loading ────────────────────────────────────────────

  const loadFlightData = useCallback(async () => {
    setDataLoading(true);
    if (electronAPI.getFlightStripData && rootPath) {
      try {
        const result = await electronAPI.getFlightStripData(airportIcao, rootPath);
        if (result && result.success) { setFlightData(result.data || {}); setRunwaySidMap(result.runwaySidMap || {}); }
      } catch (_) { /* network / IPC error */ }
    }
    setDataLoading(false);
  }, [airportIcao, rootPath, electronAPI]);

  useEffect(() => { loadFlightData(); }, [loadFlightData]);
  useEffect(() => { document.title = airportIcao ? airportIcao + ' Flight Strips' : 'Flight Strips'; }, [airportIcao]);

  // Fetch taxiway names for command bar sub-menus
  useEffect(() => {
    if (!electronAPI.collectValues || !rootPath || !airportIcao) return;
    electronAPI.collectValues(rootPath, airportIcao).then((result) => {
      if (result && result._taxiwayPaths) {
        setTaxiways(result._taxiwayPaths.paths || []);
      }
    }).catch(() => {});
  }, [airportIcao, rootPath, electronAPI]);

  // Auto-refresh when UDP airport transitions to match this window
  useEffect(() => {
    if (udpAirportChanged && udpAirport === airportIcao) {
      loadFlightData();
      if (electronAPI.resetUdpAircraft) electronAPI.resetUdpAircraft();
    }
  }, [udpAirportChanged, udpAirport, airportIcao, loadFlightData, electronAPI]);

  // ─── Selection sync with other map windows ───────────────────

  useEffect(() => {
    if (!electronAPI.onAircraftSelectedInMap) return;
    const handler = (d) => { if (d.icao === airportIcao) setSelectedCallSign(d.callSign || null); };
    electronAPI.onAircraftSelectedInMap(handler);
    if (electronAPI.getSelectedAircraft) {
      electronAPI.getSelectedAircraft(airportIcao).then((r) => { if (r && r.callSign) setSelectedCallSign(r.callSign); });
    }
    return () => { if (electronAPI.offAircraftSelectedInMap) electronAPI.offAircraftSelectedInMap(handler); };
  }, [airportIcao, electronAPI]);

  // Reset command path when selection changes
  useEffect(() => {
    if (!selectedCallSign) setCommandPath([]);
  }, [selectedCallSign]);

  // ─── UDP aircraft → seat/runway grouping ─────────────────────

  const { seatGroups, runwayGroups } = useMemo(() => {
    if (!udpAircraft || udpAircraft.length === 0) return { seatGroups: {}, runwayGroups: {} };
    if (udpAirport && udpAirport !== airportIcao) return { seatGroups: {}, runwayGroups: {} };

    const filtered = udpAircraft.filter(a => a.controlSeat !== 0 && a.controlSeat !== 255);

    const groups = {};   // seat → aircraft[]
    const rwyGroups = {}; // seat → runway → aircraft[]
    for (let i = 0; i < filtered.length; i++) {
      const ac = filtered[i];
      const seat = ac.controlSeat;
      if (!groups[seat]) { groups[seat] = []; rwyGroups[seat] = {}; }
      groups[seat].push(ac);
      const rwy = ac.runway || '__';
      if (!rwyGroups[seat][rwy]) rwyGroups[seat][rwy] = [];
      rwyGroups[seat][rwy].push(ac);
    }
    for (const s in groups) {
      groups[s].sort((a, b) => (a.seatSequence || 0) - (b.seatSequence || 0));
    }
    return { seatGroups: groups, runwayGroups: rwyGroups };
  }, [udpAircraft, udpAirport, airportIcao]);

  const seatOrder = useMemo(() => Object.keys(seatGroups).map(Number).sort((a, b) => a - b), [seatGroups]);

  // ─── Runway → flat-index ranges for drag-target validation ───

  const runwayRanges = useMemo(() => {
    const ranges = {};
    for (const seat of seatOrder) {
      ranges[seat] = {};
      const groups = runwayGroups[seat] || {};
      const runwayOrder = Object.keys(groups).sort();
      let idx = 0;
      for (const rwy of runwayOrder) {
        const count = groups[rwy].length;
        if (count > 0) ranges[seat][rwy] = { start: idx, end: idx + count - 1 };
        idx += count;
      }
    }
    return ranges;
  }, [seatOrder, runwayGroups]);

  const runwayRangesRef = useRef(runwayRanges);
  useEffect(() => { runwayRangesRef.current = runwayRanges; }, [runwayRanges]);

  // ─── Stable strip ordering across group changes ──────────────

  const [orderedGroups, setOrderedGroups] = useState({});

  useEffect(() => {
    setOrderedGroups((prev) => {
      const next = {};
      for (const seat in runwayGroups) {
        next[seat] = {};
        const byRunway = runwayGroups[seat];
        for (const rwy in byRunway) {
          const cur = new Set(byRunway[rwy].map(ac => ac.callSign));
          const p = (prev[seat] && prev[seat][rwy]) ? prev[seat][rwy] : [];
          const kept = p.filter(cs => cur.has(cs));
          const ks = new Set(kept);
          next[seat][rwy] = kept.concat(byRunway[rwy].map(ac => ac.callSign).filter(cs => !ks.has(cs)));
        }
      }
      return next;
    });
  }, [runwayGroups]);

  function getOrderedCallsigns(seat, runway, aircraft) {
    const order = (orderedGroups[seat] && orderedGroups[seat][runway]) ? orderedGroups[seat][runway] : [];
    const m = new Map(order.map((cs, i) => [cs, i]));
    return aircraft.slice().sort((a, b) => {
      const ai = m.has(a.callSign) ? m.get(a.callSign) : 1e9;
      const bi = m.has(b.callSign) ? m.get(b.callSign) : 1e9;
      if (ai !== bi) return ai - bi;
      return (a.seatSequence || 0) - (b.seatSequence || 0);
    });
  }

  // ─── Drag handlers ───────────────────────────────────────────
  // Pixel-level ghost movement uses direct DOM (ghostRef) — no React re-render.
  // Only hoverIdx changes trigger setDragState (layout-affecting).

  const handleDragMove = useCallback((e) => {
    // 1) Update ghost position directly via DOM — pixel-smooth, no React render
    if (ghostRef.current) {
      const dy = e.clientY - dragMetaRef.current.startY;
      ghostRef.current.style.top = (dragMetaRef.current.rectTop + dy) + 'px';
    }
    // 2) Only update React state when hoverIdx changes (gap position)
    setDragState((prev) => {
      if (!prev.isDragging) return prev;
      if (!prev.hasMoved) {
        const dy = Math.abs(e.clientY - dragMetaRef.current.startY);
        if (dy < 3) return prev; // micro-movement during click — ignore
        if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
        setSelectedCallSign(null);
        return { ...prev, hasMoved: true };
      }
      const dy = e.clientY - dragMetaRef.current.startY;
      const indexShift = Math.round(dy / STRIP_HEIGHT);
      const hoverIdx = Math.max(0, dragMetaRef.current.srcIdx + indexShift);
      if (hoverIdx === prev.hoverIdx) return prev; // bail out — no layout change
      return { ...prev, hoverIdx };
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    window.removeEventListener('mousemove', handleDragMove);
    window.removeEventListener('mouseup', handleDragEnd);
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    const meta = dragMetaRef.current;
    setDragState((prev) => {
      if (!prev.isDragging) return prev;
      if (prev.hasMoved && meta.srcIdx !== prev.hoverIdx) {
        // Only apply reorder if the drop target is within the same runway group
        const ranges = runwayRangesRef.current;
        const seatRanges = ranges[meta.seat] || {};
        const srcRange = seatRanges[meta.srcRunway];
        let totalStrips = 0;
        for (const rwy in seatRanges) {
          totalStrips = Math.max(totalStrips, seatRanges[rwy].end + 1);
        }
        const isValidTarget = srcRange && (
          (prev.hoverIdx >= srcRange.start && prev.hoverIdx <= srcRange.end) ||
          prev.hoverIdx === srcRange.end + 1 ||
          (prev.hoverIdx >= totalStrips && srcRange.end === totalStrips - 1)
        );
        if (isValidTarget) {
          setOrderedGroups((groups) => applyReorder(groups, meta.seat, meta.srcIdx, prev.hoverIdx));
          // Keep drag state alive for drop animation; selection cleared on anim end
          return { ...prev, isDropping: true };
        }
        // Invalid target — snap back immediately
        setSelectedCallSign(null);
      } else if (prev.hasMoved) {
        // Long hold or wiggle without changing position — cancel, no selection change
      } else {
        // Quick click without movement — toggle selection
        const next = selectedCallSignRef.current === meta.callSign ? null : meta.callSign;
        setSelectedCallSign(next);
        if (electronAPI.selectAircraftInMap) electronAPI.selectAircraftInMap(airportIcao, next);
      }
      return initialState;
    });
  }, [airportIcao, electronAPI, handleDragMove]);

  const handleDragStart = useCallback((e, seat, idx, ac) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    dragMetaRef.current = {
      startY: e.clientY, rectTop: rect.top, rectLeft: rect.left, rectW: rect.width,
      callSign: ac.callSign, ac, srcIdx: idx, seat, srcRunway: ac.runway || '__',
    };
    setDragState({ isDragging: true, hasMoved: false, hoverIdx: idx, seat });
    // Long hold without movement → enter drag after 400ms
    holdTimer.current = setTimeout(() => {
      setSelectedCallSign(null);
      setDragState((prev) => {
        if (!prev.isDragging) return prev;
        return { ...prev, hasMoved: true };
      });
    }, 400);
    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);
  }, [handleDragMove, handleDragEnd]);

  // ─── Toolbar actions ─────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    loadFlightData();
    if (electronAPI.resetUdpAircraft) electronAPI.resetUdpAircraft();
  }, [loadFlightData, electronAPI]);

  const handleHelpClick = useCallback(() => {
    if (witchMode) {
      setWitchMode(false);
      setHelpOpen(true);
    } else if (helpDblClickRef.current) {
      clearTimeout(helpDblClickRef.current);
      helpDblClickRef.current = null;
      setWitchMode(true);
    } else {
      helpDblClickRef.current = setTimeout(() => {
        helpDblClickRef.current = null;
        setHelpOpen(true);
      }, 300);
    }
  }, [witchMode]);

  const handleBodyClick = useCallback((e) => {
    if (e.target === e.currentTarget) {
      setSelectedCallSign(null);
      setCommandPath([]);
      if (electronAPI.selectAircraftInMap) electronAPI.selectAircraftInMap(airportIcao, null);
    }
  }, [airportIcao, electronAPI]);

  // ─── Derived values for render ───────────────────────────────

  const selectedAircraft = useMemo(() => {
    if (!selectedCallSign || !udpAircraft) return null;
    return udpAircraft.find(a => a.callSign === selectedCallSign) || null;
  }, [selectedCallSign, udpAircraft]);

  // ─── Command bar actions ──────────────────────────────────────

  const handleCommandAction = useCallback((cmd) => {
    const children = selectedAircraft
      ? getCommandChildren(selectedAircraft, cmd)
      : null;
    if (children) {
      // Branch node: navigate deeper
      setCommandPath(prev => [...prev, cmd.id]);
    } else if (cmd.commandId != null) {
      // Leaf node: send UDP command, then dismiss
      if (electronAPI.sendUdpCommand) {
        electronAPI.sendUdpCommand(cmd.commandId, selectedCallSign);
      }
      setSelectedCallSign(null);
      setCommandPath([]);
      if (electronAPI.selectAircraftInMap) {
        electronAPI.selectAircraftInMap(airportIcao, null);
      }
    }
  }, [airportIcao, electronAPI, selectedCallSign, selectedAircraft]);

  const handleCommandBack = useCallback(() => {
    setCommandPath(prev => prev.slice(0, -1));
  }, []);

  // ─── Derived values for render ───────────────────────────────

  const stripCountBySeat = useMemo(() => {
    const counts = {};
    for (const seat of seatOrder) {
      const groups = runwayGroups[seat] || {};
      let n = 0;
      for (const rwy in groups) n += groups[rwy].length;
      counts[seat] = n;
    }
    return counts;
  }, [seatOrder, runwayGroups]);

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div className={'flight-strips' + (witchMode ? ' witch-mode' : '')}>
      <div className="flight-strips-body" onClick={handleBodyClick}>
        {dataLoading && seatOrder.length === 0 ? (
          <div className="flight-strips-empty">{'Loading…'}</div>
        ) : seatOrder.length === 0 ? (
          <div className="flight-strips-empty">{udpAirport && udpAirport !== airportIcao ? 'Waiting for data…' : 'No active aircraft'}</div>
        ) : (
          seatOrder.map((seat) => {
            // Build flat list of items (separators + strips) for this seat
            const items = [];
            const groups = runwayGroups[seat] || {};
            const runwayOrder = Object.keys(groups).sort();
            let stripCount = 0;

            for (let ri = 0; ri < runwayOrder.length; ri++) {
              const rwy = runwayOrder[ri];
              const ordered = getOrderedCallsigns(seat, rwy, groups[rwy]);
              items.push({ type: 'sep', rwy, prevRwy: ri > 0 ? runwayOrder[ri - 1] : null });
              for (let oi = 0; oi < ordered.length; oi++) {
                items.push({ type: 'strip', ac: ordered[oi], rwy, idx: stripCount++ });
              }
            }

            const totalStrips = stripCount;
            // Source-runway range for drag-target validation (shared by strip gaps + end gap)
            const srcRunwayForSeat = dragMetaRef.current.srcRunway;
            const srcRange = runwayRanges[seat]?.[srcRunwayForSeat];

            return (
              <div key={seat} className="flight-strips-column">
                <div className="flight-strips-column-header">
                  <span>{SEAT_LABELS_FULL[seat] || SEAT_LABELS[seat] || ('Seat ' + seat)}</span>
                </div>
                {items.map((item) => {
                  if (item.type === 'sep') {
                    // Show gap above this separator when dragging to the end of the previous group
                    const showSepGap = !dragState.isDropping && dragState.isDragging && dragState.hasMoved &&
                      dragState.seat === seat &&
                      item.prevRwy === dragMetaRef.current.srcRunway &&
                      srcRange && dragState.hoverIdx === srcRange.end + 1 &&
                      dragMetaRef.current.srcIdx !== srcRange.end + 1;
                    return (
                      <div key={'sep-' + item.rwy} className={'flight-strip-runway-sep' + (showSepGap ? ' strip-sep-gap' : '')}>
                        <span>{'RUNWAY'} {item.rwy === '__' ? '--' : item.rwy}</span>
                      </div>
                    );
                  }

                  const ac = item.ac;
                  const rwy = item.rwy;
                  const idx = item.idx;
                  const isArrival = ac.flightDirection === 1;
                  const fd = flightData[ac.callSign] || {};
                  const sidFromMap = (!isArrival && fd.runway && runwaySidMap[fd.runway]) ? runwaySidMap[fd.runway][0] : '';

                  // Is this the strip being dragged? (hidden during drop animation)
                  const isSrc = !dragState.isDropping && dragState.isDragging && dragState.hasMoved &&
                    dragState.seat === seat && dragMetaRef.current.srcIdx === idx;
                  // Is the hover target inside the source runway group?
                  const inSrcRunway = srcRange && dragState.hoverIdx >= srcRange.start && dragState.hoverIdx <= srcRange.end;
                  // Open gap before this strip only if target is in the same runway group
                  const showGap = !dragState.isDropping && dragState.isDragging && dragState.hasMoved &&
                    dragState.seat === seat && dragState.hoverIdx === idx &&
                    dragMetaRef.current.srcIdx !== idx && inSrcRunway;

                  if (isSrc) {
                    // Show placeholder only when hover is still at the source position.
                    // Once dragged away, collapse the slot so other strips push up.
                    if (dragState.hoverIdx === idx) {
                      return <div key={ac.callSign} className="strip-drag-placeholder" />;
                    }
                    return null;
                  }

                  return (
                    <FlightStripContent
                      key={ac.callSign}
                      ac={ac} fd={fd} seat={seat} idx={idx}
                      isSelected={ac.callSign === selectedCallSign}
                      showGap={showGap}
                      isArrival={isArrival}
                      seatLabel={SEAT_LABELS[ac.controlSeat] || ''}
                      sidFromMap={sidFromMap}
                      routeLines={routeHistory[ac.callSign]}
                      onMouseDown={(e) => handleDragStart(e, seat, idx, ac)}
                      witchMode={witchMode}
                      witchFrame={witchFrame}
                    />
                  );
                })}

                {/* Gap at end of column — only when source runway is the last group */}
                {!dragState.isDropping && dragState.isDragging && dragState.hasMoved &&
                  dragState.seat === seat && dragState.hoverIdx >= totalStrips && (() => {
                    const lastIdx = totalStrips - 1;
                    const endGapValid = srcRange && srcRange.end === lastIdx;
                    if (lastIdx >= 0 && dragMetaRef.current.srcIdx !== lastIdx && endGapValid) {
                      return <div key="end-gap" className="strip-end-gap" />;
                    }
                    return null;
                  })()}

                {/* Floating clone of dragged strip */}
                {dragState.isDragging && dragState.hasMoved && dragState.seat === seat && dragMetaRef.current.ac && (
                  <DragGhost
                    ref={ghostRef}
                    ac={dragMetaRef.current.ac}
                    fd={flightData[dragMetaRef.current.ac.callSign] || {}}
                    seatLabel={SEAT_LABELS[dragMetaRef.current.ac.controlSeat] || ''}
                    sidFromMap={(() => {
                      const fd2 = flightData[dragMetaRef.current.ac.callSign] || {};
                      return (!(dragMetaRef.current.ac.flightDirection === 1) && fd2.runway && runwaySidMap[fd2.runway]) ? runwaySidMap[fd2.runway][0] : '';
                    })()}
                    rectLeft={dragMetaRef.current.rectLeft}
                    rectTop={dragMetaRef.current.rectTop}
                    rectW={dragMetaRef.current.rectW}
                    isArrival={dragMetaRef.current.ac.flightDirection === 1}
                    routeLines={routeHistory[dragMetaRef.current.ac.callSign]}
                    telemetryClass={TELEMETRY_STRIP_CLASS[dragMetaRef.current.ac.telemetryStatus] || ''}
                    witchMode={witchMode}
                    witchFrame={witchFrame}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
      {/* TODO: re-enable command bar when game command IDs are confirmed
      <FlightStripCommandBar
        aircraft={selectedAircraft}
        commandPath={commandPath}
        onCommandAction={handleCommandAction}
        onBack={handleCommandBack}
        witchMode={witchMode}
      />
      */}
      <div className="flight-strips-bar">
        <div className="flight-strips-bar-left">
          <SimClock simTimeUnixMs={simTimeUnixMs} className="flight-strips-clock" />
          <span className="flight-strips-timescale">{timeScale > 0 ? '×' + timeScale : ''}</span>
        </div>
        <div className="flight-strips-bar-actions">
          <div className="strips-bar-btn" onClick={handleRefresh} title="Refresh">
            {witchMode ? <img src="witch/refresh.png" alt="Refresh" className="witch-refresh-img" /> : <IoRefreshOutline size={16} />}
          </div>
          <div className="strips-bar-btn" onClick={handleHelpClick} title="Map Help">
            {witchMode ? <img src="witch/help.png" alt="?" className="witch-help-img" /> : <IoHelpCircleOutline size={16} />}
          </div>
        </div>
      </div>
      {helpOpen && <MapHelpOverlay type="strips" titleKey="map_help_strips_title" onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
