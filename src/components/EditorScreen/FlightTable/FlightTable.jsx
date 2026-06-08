import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import './FlightTable.css';
import { useTranslation } from '../../../hooks/useTranslation';
import { useAppStore } from '../../../store/appStore';
import { IoChevronForward, IoChevronDown } from 'react-icons/io5';
import { ALL_FIELDS, ARRIVAL_FIELDS, DEPARTURE_FIELDS, FIELD_LABELS, COL_CLASSES, TIME_FIELDS, DROPDOWN_FIELDS, getActiveColumns } from '../../../utils/constants';
import ClockPopover from '../CellEditor/TimeClockPopover';

function EditableCell({ value, col, globalIdx, isTime, options, flightNums }) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(value);
  const [showClock, setShowClock] = useState(false);
  const updateFlight = useAppStore(s => s.updateFlight);
  const cls = COL_CLASSES[col] || '';

  const commit = useCallback((newVal) => {
    updateFlight(globalIdx, { [col]: newVal !== undefined ? newVal : editVal });
    setEditing(false);
    setShowClock(false);
  }, [globalIdx, col, editVal, updateFlight]);

  if (showClock) {
    return (
      <td className={cls} data-col={col} data-idx={globalIdx}>
        <ClockPopover value={value} col={col} onCommit={commit} onClose={() => setShowClock(false)} />
        <span className="cell-clickable" onClick={() => setShowClock(false)}>{value || ''}</span>
      </td>
    );
  }

  if (editing) {
    // Determine options: column dropdowns, or FlightNum special case
    let opts = options;
    if (col === 'FlightNum' && flightNums) opts = flightNums;

    if (opts && opts.length > 0) {
      return (
        <td className={cls} data-col={col} data-idx={globalIdx}>
          <select className="cell-widget" value={editVal} onChange={e => { setEditVal(e.target.value); commit(e.target.value); }} onBlur={() => setEditing(false)} autoFocus>
            {opts.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </td>
      );
    }
    return (
      <td className={cls} data-col={col} data-idx={globalIdx}>
        <input className="cell-widget" value={editVal} onChange={e => setEditVal(e.target.value)}
          onBlur={() => commit()} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditing(false); setEditVal(value); } }} autoFocus />
      </td>
    );
  }

  const handleClick = (e) => {
    e.stopPropagation();
    if (isTime) { setShowClock(true); }
    else if (col === 'FlightNum' && flightNums && flightNums.length > 0) { setEditVal(value); setEditing(true); }
    else if (options && options.length > 0) { setEditVal(value || options[0]); setEditing(true); }
    else { setEditVal(value); setEditing(true); }
  };

  return (
    <td className={`${cls} ${!value ? 'cell-null' : ''}`} data-col={col} data-idx={globalIdx} onClick={handleClick}>
      {value || ''}
    </td>
  );
}

export default function FlightTable({ type, flights, columns }) {
  const { t } = useTranslation();
  const selectedIndices = useAppStore(s => s.selectedIndices);
  const highlightedIdx = useAppStore(s => s.highlightedIdx);
  const searchMatches = useAppStore(s => s.searchMatches);
  const toggleSelection = useAppStore(s => s.toggleSelection);
  const setHighlightedIdx = useAppStore(s => s.setHighlightedIdx);
  const airportValues = useAppStore(s => s.airportValues);
  const currentAirport = useAppStore(s => s.currentAirport);
  const allFlights = useAppStore(s => s.flights);
  const audioCallsigns = useAppStore(s => s.audioCallsigns);
  const [collapsed, setCollapsed] = useState(false);

  const dragRef = useRef({ active: false, pending: false, lastDi: -1, pendingGi: -1 });
  const isArrivals = type === 'arrivals';

  // End drag on any mouseup — even outside the table
  useEffect(() => {
    const handleMouseUp = () => {
      if (!dragRef.current.active && !dragRef.current.pending) return;
      dragRef.current.active = false;
      dragRef.current.pending = false;
      dragRef.current.pendingGi = -1;
      document.body.style.userSelect = '';
      // Remove onselectstart suppression
      document.body.onselectstart = null;
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);
  const vals = airportValues[currentAirport] || {};
  const allColumns = useMemo(() => ['AirlineCode', 'FlightNum', ...columns.filter(c => c !== 'AirlineCode' && c !== 'FlightNum')], [columns]);

  // Build valid flight numbers per airline from canonical set
  // (_flightNums is collected during root scan from audio clips + ALL .acl files)
  const validFlightNums = useMemo(() => {
    const map = {};
    // Primary source: canonical _flightNums (includes audio numbers merged in)
    const canonByAirline = vals._flightNums || {};
    for (const [code, nums] of Object.entries(canonByAirline)) {
      map[code] = [...nums];
    }
    // Fallback: audio callsigns (if cache hasn't been built yet)
    const byAirline = audioCallsigns?.byAirline || {};
    for (const [code, nums] of Object.entries(byAirline)) {
      if (!map[code]) map[code] = [];
      for (const n of nums) {
        if (!map[code].includes(n)) map[code].push(n);
      }
    }
    return map;
  }, [vals._flightNums, audioCallsigns]);

  // Map global store index ↔ display index (position in the sorted flights prop)
  const giToDi = useMemo(() => {
    const map = new Map();
    for (let di = 0; di < flights.length; di++) {
      const gi = allFlights.indexOf(flights[di]);
      if (gi >= 0) map.set(gi, di);
    }
    return map;
  }, [flights, allFlights]);
  const diToGi = useMemo(() => flights.map(fl => allFlights.indexOf(fl)), [flights, allFlights]);

  const onMouseDown = useCallback((e, gi) => {
    if (e.target.closest('input,select,button')) return;
    // Portal-rendered popovers (clock, etc.) bubble through the React tree
    // but their DOM target is outside the table — ignore them entirely.
    if (e.target.closest('.time-clock-overlay') || e.target.closest('.compass-popover')) return;
    e.preventDefault(); // suppress text selection during drag
    document.body.style.userSelect = 'none';
    document.body.onselectstart = () => false;
    const isDataCell = e.target.closest('td') && !e.target.closest('td.chk-cell');
    if (isDataCell) {
      // Click on editable cell — defer toggle until we know it's a drag
      dragRef.current = { active: false, pending: true, lastDi: giToDi.get(gi) ?? -1, pendingGi: gi };
    } else {
      // Checkbox cell or row margin — toggle immediately
      dragRef.current = { active: true, pending: false, lastDi: giToDi.get(gi) ?? -1, pendingGi: -1 };
      const prev = useAppStore.getState().selectedIndices;
      const next = new Set(prev);
      if (next.has(gi)) next.delete(gi); else next.add(gi);
      useAppStore.setState({ selectedIndices: next, highlightedIdx: gi });
    }
  }, [giToDi]);
  const onMouseEnter = useCallback((e, gi) => {
    // Transition pending click → active drag on first row change
    if (dragRef.current.pending && !dragRef.current.active) {
      dragRef.current.active = true;
      dragRef.current.pending = false;
      const pendingGi = dragRef.current.pendingGi;
      // Toggle the initial row
      const prev = useAppStore.getState().selectedIndices;
      const set = new Set(prev);
      if (set.has(pendingGi)) set.delete(pendingGi); else set.add(pendingGi);
      useAppStore.setState({ selectedIndices: set, highlightedIdx: pendingGi });
    }
    if (!dragRef.current.active) return;
    const currDi = giToDi.get(gi);
    if (currDi == null) return;
    const prev = useAppStore.getState().selectedIndices;
    const set = new Set(prev);
    const lastDi = dragRef.current.lastDi;
    if (currDi > lastDi) {
      for (let di = lastDi + 1; di <= currDi; di++) {
        const idx = diToGi[di];
        if (idx >= 0) {
          if (set.has(idx)) set.delete(idx); else set.add(idx);
        }
      }
    } else if (currDi < lastDi) {
      for (let di = currDi; di < lastDi; di++) {
        const idx = diToGi[di];
        if (idx >= 0) {
          if (set.has(idx)) set.delete(idx); else set.add(idx);
        }
      }
    } else {
      // Same row re-entered — toggle it
      if (set.has(gi)) set.delete(gi); else set.add(gi);
    }
    dragRef.current.lastDi = currDi;
    useAppStore.setState({ selectedIndices: set });
  }, [flights, diToGi, giToDi]);
  const onMouseUp = useCallback(() => {
    dragRef.current.active = false;
    dragRef.current.pending = false;
    dragRef.current.pendingGi = -1;
    document.body.style.userSelect = '';
    document.body.onselectstart = null;
  }, []);

  return (
    <div id={isArrivals ? 'section-arrivals' : 'section-departures'} className={`section-block ${collapsed ? 'collapsed' : ''}`}>
      <div className={`section-header collapse-header ${!isArrivals ? 'departure-header' : ''}`} onClick={() => setCollapsed(!collapsed)} data-section={isArrivals ? 'arrivals' : 'departures'}>
        <span>{t(isArrivals ? 'table_arrivals' : 'table_departures')}</span>
        <span className="collapse-arrow">{collapsed ? <IoChevronForward size={12} /> : <IoChevronDown size={12} />}</span>
      </div>
        <div className="section-table-wrap" onMouseUp={onMouseUp}>
          <table className="flight-table">
            <thead><tr><th className="col-chk"></th>{allColumns.map(col => <th key={col} className={COL_CLASSES[col] || ''} data-col={col}>{t('field_' + col) || FIELD_LABELS[col] || col}</th>)}</tr></thead>
            <tbody>
              {flights.length === 0 && (
                <tr><td colSpan={allColumns.length + 1} className="empty-section-cell">{t('table_no_flights')}</td></tr>
              )}
              {flights.map(fl => {
                const gi = allFlights.indexOf(fl);
                if (gi < 0) return null;
                const airlineCode = (fl.CallSign || '').substring(0, 3);
                return (
                  <tr key={gi}
                    className={`${isArrivals ? 'row-arrival' : 'row-departure'} ${selectedIndices.has(gi) ? 'selected' : ''} ${highlightedIdx === gi ? 'highlighted' : ''} ${searchMatches.has(gi) ? 'search-match' : ''} ${highlightedIdx === gi && searchMatches.has(gi) ? 'search-current' : ''}`}
                    onClick={(e) => { if (e.target.closest('td')) return; setHighlightedIdx(gi); }}
                    onMouseDown={(e) => onMouseDown(e, gi)}
                    onMouseEnter={(e) => onMouseEnter(e, gi)}>
                    <td className="chk-cell"><input type="checkbox" className="chk-row" data-idx={gi} checked={selectedIndices.has(gi)} onChange={e => { e.stopPropagation(); toggleSelection(gi); }} /></td>
                    {allColumns.map(col => {
                      let val = fl[col] || '';
                      if (col === 'AirlineCode') val = airlineCode;
                      if (col === 'FlightNum') val = (fl.CallSign || '').substring(3);
                      // Registration is stored as _Registration in parsed data
                      if (col === 'Registration') val = fl._Registration || fl.Registration || '';
                      const isTime = TIME_FIELDS.has(col);
                      const isDropdown = DROPDOWN_FIELDS.has(col);
                      let opts = (isDropdown ? vals[col] : null);
                      // AircraftType: filter by airline (only show types this airline operates)
                      if (col === 'AircraftType' && airlineCode) {
                        const airlineTypes = vals._compat?.airlineToAircraft?.[airlineCode];
                        if (airlineTypes && airlineTypes.length > 0) opts = airlineTypes;
                      }
                      // Registration: filter by airline + aircraft type
                      if (col === 'Registration') {
                        const acType = (fl.AircraftType || '').trim();
                        const regKey = airlineCode + '|' + acType;
                        const filtered = vals._registrationMap?.[regKey];
                        if (filtered && filtered.length > 0) opts = filtered;
                      }
                      const flightNums = (col === 'FlightNum' ? validFlightNums[airlineCode] : null);
                      return <EditableCell key={col} value={val} col={col} globalIdx={gi} isTime={isTime} options={opts} flightNums={flightNums} />;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
    </div>
  );
}
