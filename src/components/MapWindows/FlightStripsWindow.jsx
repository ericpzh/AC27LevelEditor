import React, { useEffect, useMemo, useState, useCallback, useRef, forwardRef } from 'react';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import useUdpAircraftState from './useUdpAircraftState';
import SimClock from './SimClock';
import MapHelpOverlay from './MapHelpOverlay';
import { IoHelpCircleOutline, IoRefreshOutline } from 'react-icons/io5';
import './FlightStripsWindow.css';

const SEAT_LABELS = { 1: 'RMP', 2: 'GND', 3: 'TWR', 4: 'DEP', 5: 'APPR', 6: 'DEL', 7: 'APN' };
const SEAT_LABELS_FULL = { 1: 'RAMP', 2: 'GROUND', 3: 'TOWER', 4: 'DEPARTURE', 5: 'APPROACH', 6: 'DELIVERY', 7: 'APRON' };
const STRIP_HEIGHT = 61; // 58px min-height + 3px gap

// ─── Helpers ──────────────────────────────────────────────────────

/** Stable reorder: move srcIdx → dstIdx within a seat, preserving runway groups. */
function applyReorder(prev, seat, srcIdx, dstIdx) {
  // Flatten all strips in this seat across runways
  const all = [];
  const keys = Object.keys(prev[seat] || {});
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
  seatLabel, sidFromMap, onMouseDown,
}) {
  return (
    <div
      key={ac.callSign}
      data-seat={seat}
      data-runway={ac.runway || '__'}
      className={'flight-strip' + (isArrival ? ' strip-arrival' : ' strip-departure') +
        (isSelected ? ' strip-selected' : '') +
        (showGap ? ' strip-gap-above' : '')}
      onMouseDown={onMouseDown}
    >
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
      <div className="strip-col-route"><span className="strip-taxi-route">{ac.route || ''}</span></div>
      <div className="strip-col-runway">
        <span className="strip-runway">{ac.runway || '--'}</span>
        <div className="strip-box channel-box"><span className="strip-channel">{seatLabel}</span></div>
      </div>
    </div>
  );
});

// ─── Drag ghost (floating clone of dragged strip) ────────────────

const DragGhost = forwardRef(function DragGhost({ ac, fd, seatLabel, sidFromMap, rectLeft, rectTop, rectW, isArrival }, ref) {
  return (
    <div
      ref={ref}
      className={'flight-strip strip-drag-ghost' + (isArrival ? ' strip-arrival' : ' strip-departure')}
      style={{ position: 'fixed', left: rectLeft + 'px', top: rectTop + 'px', zIndex: 9999, pointerEvents: 'none', width: rectW + 'px' }}
    >
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
      <div className="strip-col-route"><span className="strip-taxi-route">{ac.route || ''}</span></div>
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
  const { aircraft: udpAircraft, currentAirport: udpAirport, simTimeUnixMs, timeScale } = useUdpAircraftState();
  const [helpOpen, setHelpOpen] = useState(false);
  const [flightData, setFlightData] = useState({});
  const [runwaySidMap, setRunwaySidMap] = useState({});
  const [dataLoading, setDataLoading] = useState(true);
  const [selectedCallSign, setSelectedCallSign] = useState(null);
  const selectedCallSignRef = useRef(null);

  // Keep ref in sync so handleDragEnd (stable callback) can read current selection
  useEffect(() => { selectedCallSignRef.current = selectedCallSign; }, [selectedCallSign]);

  // Drag state — only layout-affecting values live in React state.
  // Pixel-level ghost tracking uses direct DOM via ghostRef (no re-render).
  const dragMetaRef = useRef({ startY: 0, rectTop: 0, rectLeft: 0, rectW: 0, callSign: '', ac: null, srcIdx: -1, seat: 0 });
  const ghostRef = useRef(null);
  const initialState = { isDragging: false, hasMoved: false, hoverIdx: -1, seat: 0 };
  const [dragState, setDragState] = useState(initialState);
  const holdTimer = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Cleanup drag listeners on unmount (safety net)
  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    };
  }, []);

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
      if (!prev.isDragging || !prev.hasMoved) return prev;
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
        setOrderedGroups((groups) => applyReorder(groups, meta.seat, meta.srcIdx, prev.hoverIdx));
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
      callSign: ac.callSign, ac, srcIdx: idx, seat,
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

  const handleHelpToggle = useCallback(() => { setHelpOpen((v) => !v); }, []);

  const handleBodyClick = useCallback((e) => {
    if (e.target === e.currentTarget) {
      setSelectedCallSign(null);
      if (electronAPI.selectAircraftInMap) electronAPI.selectAircraftInMap(airportIcao, null);
    }
  }, [airportIcao, electronAPI]);

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
    <div className="flight-strips">
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
              items.push({ type: 'sep', rwy });
              for (let oi = 0; oi < ordered.length; oi++) {
                items.push({ type: 'strip', ac: ordered[oi], rwy, idx: stripCount++ });
              }
            }

            const totalStrips = stripCount;

            return (
              <div key={seat} className="flight-strips-column">
                <div className="flight-strips-column-header">
                  <span>{SEAT_LABELS_FULL[seat] || SEAT_LABELS[seat] || ('Seat ' + seat)}</span>
                </div>
                {items.map((item) => {
                  if (item.type === 'sep') {
                    return (
                      <div key={'sep-' + item.rwy} className="flight-strip-runway-sep">
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

                  // Is this the strip being dragged?
                  const isSrc = dragState.isDragging && dragState.hasMoved && dragState.seat === seat && dragMetaRef.current.srcIdx === idx;
                  // Open gap before this strip?
                  const showGap = dragState.isDragging && dragState.hasMoved && dragState.seat === seat && dragState.hoverIdx === idx && dragMetaRef.current.srcIdx !== idx;

                  if (isSrc) {
                    // Placeholder collapses original space; floating clone rendered below
                    return <div key={ac.callSign} className="strip-drag-placeholder" />;
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
                      onMouseDown={(e) => handleDragStart(e, seat, idx, ac)}
                    />
                  );
                })}

                {/* Gap at end of column when hovering past last strip */}
                {dragState.isDragging && dragState.hasMoved && dragState.seat === seat && dragState.hoverIdx >= totalStrips && (() => {
                  const lastIdx = totalStrips - 1;
                  if (lastIdx >= 0 && dragMetaRef.current.srcIdx !== lastIdx) {
                    return <div key="end-gap" className="strip-end-gap" />;
                  }
                  return null;
                })()}

                {/* Floating clone of dragged strip */}
                {dragState.isDragging && dragState.seat === seat && dragMetaRef.current.ac && (
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
                  />
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="flight-strips-bar">
        <div className="flight-strips-bar-left">
          <SimClock simTimeUnixMs={simTimeUnixMs} className="flight-strips-clock" />
          <span className="flight-strips-timescale">{timeScale > 0 ? '×' + timeScale : ''}</span>
        </div>
        <div className="flight-strips-bar-actions">
          <div className="strips-bar-btn" onClick={handleRefresh} title="Refresh"><IoRefreshOutline size={16} /></div>
          <div className="strips-bar-btn" onClick={handleHelpToggle} title="Map Help"><IoHelpCircleOutline size={16} /></div>
        </div>
      </div>
      {helpOpen && <MapHelpOverlay type="strips" titleKey="map_help_strips_title" onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
