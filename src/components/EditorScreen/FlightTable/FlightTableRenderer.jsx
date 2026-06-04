import React, { useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../../hooks/useTranslation';
import { useAppStore } from '../../../store/appStore';
import { ALL_FIELDS, ARRIVAL_FIELDS, DEPARTURE_FIELDS, FIELD_LABELS, COL_CLASSES, TIME_FIELDS, DROPDOWN_FIELDS } from '../../../utils/constants';

function getActiveColumns(flights, fieldList) {
  const cols = [];
  for (const [fn] of ALL_FIELDS) {
    if (!fieldList.includes(fn)) continue;
    if (fn === 'AirlineCode' || fn === 'FlightNum') cols.push(fn);
    else if (flights.some(fl => (fl[fn] || '').trim())) cols.push(fn);
  }
  return cols;
}

function EditableCell({ value, col, globalIdx, isTime, isDropdown, options }) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(value);
  const [showClock, setShowClock] = useState(false);
  const updateFlight = useAppStore(s => s.updateFlight);

  const commit = useCallback((newVal) => {
    const v = newVal !== undefined ? newVal : editVal;
    updateFlight(globalIdx, { [col]: v });
    // Zustand updateFlight already handles state
    setEditing(false); setShowClock(false);
  }, [globalIdx, col, editVal, updateFlight]);

  if (showClock) {
    const parts = String(value || '00:00:00').split(':');
    const h = parseInt(parts[0]) || 0, m = parseInt(parts[1]) || 0, s = parseInt(parts[2]) || 0;
    const timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return (
      <td data-col={col} data-idx={globalIdx}>
        {createPortal(
          <div style={{position:'fixed',inset:0,zIndex:500,background:'rgba(0,0,0,0.3)',display:'flex',alignItems:'center',justifyContent:'center'}} onClick={e => { if(e.target===e.currentTarget) setShowClock(false); }}>
            <div style={{background:'var(--bg-surface)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 24px',minWidth:260,boxShadow:'var(--shadow)'}} onClick={e=>e.stopPropagation()}>
              <div style={{fontSize:14,fontWeight:600,color:'var(--text)',marginBottom:12,textAlign:'center'}}>Time</div>
              <div style={{fontSize:28,fontWeight:700,color:'var(--accent)',textAlign:'center',marginBottom:16}}>{timeStr}</div>
              <div style={{display:'flex',gap:12,justifyContent:'center',marginBottom:16}}>
                {[['H',h,23],['M',m,59],['S',s,59]].map(([l,val,max]) => (
                  <div key={l} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                    <label style={{fontSize:10,color:'var(--text-muted)'}}>{l}</label>
                    <input type="number" min={0} max={max} defaultValue={val} onChange={e => {
                      const v = parseInt(e.target.value)||0;
                      const p = String(value||'00:00:00').split(':');
                      if(l==='H') p[0]=String(v).padStart(2,'0');
                      if(l==='M') p[1]=String(v).padStart(2,'0');
                      if(l==='S') p[2]=String(v).padStart(2,'0');
                      commit(p.join(':'));
                    }} style={{width:56,padding:6,textAlign:'center',background:'var(--bg)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:'var(--radius-sm)',fontSize:16,fontFamily:'inherit'}} />
                  </div>
                ))}
              </div>
              <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                <button className="btn-cancel" onClick={()=>setShowClock(false)} style={{padding:'5px 14px',fontSize:12}}>Cancel</button>
                <button className="btn-confirm" onClick={()=>setShowClock(false)} style={{padding:'5px 14px',fontSize:12}}>OK</button>
              </div>
            </div>
          </div>, document.body)}
        <span style={{cursor:'pointer'}} onClick={()=>setShowClock(false)}>{value||''}</span>
      </td>
    );
  }

  if (editing) {
    if (isDropdown && options && options.length > 0) {
      return (
        <td data-col={col} data-idx={globalIdx}>
          <select className="cell-widget" value={editVal} onChange={e=>{setEditVal(e.target.value);commit(e.target.value);}} onBlur={()=>setEditing(false)} autoFocus>
            <option value=""></option>
            {options.map(o=><option key={o} value={o}>{o}</option>)}
          </select>
        </td>
      );
    }
    return (
      <td data-col={col} data-idx={globalIdx}>
        <input className="cell-widget" value={editVal} onChange={e=>setEditVal(e.target.value)}
          onBlur={()=>commit()} onKeyDown={e=>{if(e.key==='Enter')commit();if(e.key==='Escape'){setEditing(false);setEditVal(value);}}}
          autoFocus />
      </td>
    );
  }

  const cls = COL_CLASSES[col] || '';
  return (
    <td className={`${cls} ${!value?'cell-null':''}`} data-col={col} data-idx={globalIdx}
      onDoubleClick={()=>{if(isTime){setShowClock(true)}else{setEditVal(value);setEditing(true);}}}>
      {value||''}
    </td>
  );
}

export default function FlightTableRenderer({ type }) {
  const { t } = useTranslation();
  const flights = useAppStore(s => s.flights);
  const selectedIndices = useAppStore(s => s.selectedIndices);
  const highlightedIdx = useAppStore(s => s.highlightedIdx);
  const toggleSelection = useAppStore(s => s.toggleSelection);
  const setHighlightedIdx = useAppStore(s => s.setHighlightedIdx);
  const airportValues = useAppStore(s => s.airportValues);
  const currentAirport = useAppStore(s => s.currentAirport);
  const [collapsed, setCollapsed] = useState(false);

  const isArrivals = type === 'arrivals';
  const fieldList = isArrivals ? ARRIVAL_FIELDS : DEPARTURE_FIELDS;
  const filtered = useMemo(() => isArrivals ? flights.filter(fl=>(fl.LandingTime||'').trim()) : flights.filter(fl=>!(fl.LandingTime||'').trim()), [flights,isArrivals]);
  const cols = useMemo(()=>getActiveColumns(filtered,fieldList),[filtered,fieldList]);
  const allColumns = ['AirlineCode','FlightNum',...cols.filter(c=>c!=='AirlineCode'&&c!=='FlightNum')];
  const vals = airportValues[currentAirport] || {};

  if (filtered.length === 0) return null;

  return (
    <div className={`section-block ${collapsed?'collapsed':''}`}>
      <div className={`section-header collapse-header ${!isArrivals?'departure-header':''}`} onClick={()=>setCollapsed(!collapsed)} data-section={isArrivals?'arrivals':'departures'}>
        <span>{t(isArrivals?'table_arrivals':'table_departures')}</span>
        <span className="collapse-arrow">{collapsed?'▸':'▾'}</span>
      </div>
        <div className="section-table-wrap">
          <table className="flight-table">
            <thead><tr><th className="col-chk"></th>{allColumns.map(col=><th key={col} className={COL_CLASSES[col]||''} data-col={col}>{t('field_'+col)||FIELD_LABELS[col]||col}</th>)}</tr></thead>
            <tbody>
              {filtered.map((fl,di)=>{
                const gi = flights.indexOf(fl);
                return (
                  <tr key={gi} className={`${isArrivals?'row-arrival':'row-departure'} ${selectedIndices.has(gi)?'selected':''}`}
                    onClick={()=>setHighlightedIdx(gi)}
                    style={highlightedIdx===gi?{outline:'1px solid var(--accent)',outlineOffset:-1}:{}}>
                    <td className="chk-cell"><input type="checkbox" className="chk-row" data-idx={gi} checked={selectedIndices.has(gi)} onChange={e=>{e.stopPropagation();toggleSelection(gi);}} /></td>
                    {allColumns.map(col=>{
                      let val=fl[col]||'';
                      if(col==='AirlineCode') val=(fl.CallSign||'').substring(0,3);
                      if(col==='FlightNum') val=(fl.CallSign||'').substring(3);
                      return <EditableCell key={col} value={val} col={col} globalIdx={gi} isTime={TIME_FIELDS.has(col)} isDropdown={DROPDOWN_FIELDS.has(col)} options={vals[col]} />;
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
