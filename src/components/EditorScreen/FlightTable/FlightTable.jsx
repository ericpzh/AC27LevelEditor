import React, { useState, useMemo, useCallback, useRef } from 'react';
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
    else if (options && options.length > 0) { setEditVal(value); setEditing(true); }
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
  const toggleSelection = useAppStore(s => s.toggleSelection);
  const setHighlightedIdx = useAppStore(s => s.setHighlightedIdx);
  const airportValues = useAppStore(s => s.airportValues);
  const currentAirport = useAppStore(s => s.currentAirport);
  const allFlights = useAppStore(s => s.flights);
  const audioCallsigns = useAppStore(s => s.audioCallsigns);
  const [collapsed, setCollapsed] = useState(false);

  const dragRef = useRef({ active: false, startIdx: -1, lastIdx: -1 });
  const isArrivals = type === 'arrivals';
  const vals = airportValues[currentAirport] || {};
  const allColumns = useMemo(() => ['AirlineCode', 'FlightNum', ...columns.filter(c => c !== 'AirlineCode' && c !== 'FlightNum')], [columns]);

  // Build valid flight numbers per airline from audio callsigns
  const validFlightNums = useMemo(() => {
    const map = {};
    const byAirline = audioCallsigns?.byAirline || {};
    for (const [code, nums] of Object.entries(byAirline)) {
      if (Array.isArray(nums)) map[code] = nums;
    }
    // Also add from all flights
    for (const fl of allFlights) {
      const ac = (fl.CallSign || '').substring(0, 3);
      const num = (fl.CallSign || '').substring(3);
      if (ac && num) {
        if (!map[ac]) map[ac] = [];
        if (!map[ac].includes(num)) map[ac].push(num);
      }
    }
    return map;
  }, [audioCallsigns, allFlights]);

  const onMouseDown = useCallback((e, gi) => {
    if (e.target.closest('input,select,button')) return;
    dragRef.current = { active: true, startIdx: gi, lastIdx: gi };
    useAppStore.setState({ selectedIndices: new Set([gi]), highlightedIdx: gi });
  }, []);
  const onMouseEnter = useCallback((e, gi) => {
    if (!dragRef.current.active) return;
    if (gi === dragRef.current.lastIdx) return;
    dragRef.current.lastIdx = gi;
    const min = Math.min(dragRef.current.startIdx, gi);
    const max = Math.max(dragRef.current.startIdx, gi);
    const set = new Set();
    for (let i = min; i <= max; i++) set.add(i);
    useAppStore.setState({ selectedIndices: set });
  }, []);
  const onMouseUp = useCallback(() => { dragRef.current.active = false; }, []);

  if (flights.length === 0) return null;

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
              {flights.map(fl => {
                const gi = allFlights.indexOf(fl);
                if (gi < 0) return null;
                const airlineCode = (fl.CallSign || '').substring(0, 3);
                return (
                  <tr key={gi}
                    className={`${isArrivals ? 'row-arrival' : 'row-departure'} ${selectedIndices.has(gi) ? 'selected' : ''} ${highlightedIdx === gi ? 'highlighted' : ''}`}
                    onClick={(e) => { if (e.target.closest('td')) return; setHighlightedIdx(gi); }}
                    onMouseDown={(e) => onMouseDown(e, gi)}
                    onMouseEnter={(e) => onMouseEnter(e, gi)}>
                    <td className="chk-cell"><input type="checkbox" className="chk-row" data-idx={gi} checked={selectedIndices.has(gi)} onChange={e => { e.stopPropagation(); toggleSelection(gi); }} /></td>
                    {allColumns.map(col => {
                      let val = fl[col] || '';
                      if (col === 'AirlineCode') val = airlineCode;
                      if (col === 'FlightNum') val = (fl.CallSign || '').substring(3);
                      const isTime = TIME_FIELDS.has(col);
                      const isDropdown = DROPDOWN_FIELDS.has(col);
                      const opts = (isDropdown ? vals[col] : null);
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
