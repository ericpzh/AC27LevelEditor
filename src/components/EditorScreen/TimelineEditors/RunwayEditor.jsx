import React, { useState, useMemo } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { useAppStore } from '../../../store/appStore';
import { escapeHtml } from '../../../utils/htmlUtils';
import ClockPopover from '../CellEditor/TimeClockPopover';

function TimeCell({ value, onChange }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <span className="tl-input" style={{cursor:'pointer'}} onClick={() => setShow(true)}>{value || ''}</span>
      {show && <ClockPopover value={value || '00:00:00'} col="Time" onCommit={v => { onChange(v); setShow(false); }} onClose={() => setShow(false)} />}
    </>
  );
}

function getDefaultTime(_s, _e) {
  if (_s && _e) { const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); }; const mid = Math.floor((toMin(_s) + toMin(_e)) / 2); return String(Math.floor(mid / 60) % 24).padStart(2, '0') + ':' + String(mid % 60).padStart(2, '0') + ':00'; }
  if (_s) return String(_s).substring(0, 8);
  if (_e) return String(_e).substring(0, 8);
  return '12:00:00';
}

export default function RunwayEditor() {
  const { t } = useTranslation();
  const runwayTimeline = useAppStore(s => s.runwayTimeline);
  const _runwayPairs = useAppStore(s => s._runwayPairs);
  const airportValues = useAppStore(s => s.airportValues);
  const _s = useAppStore(s => s._configStartTime);
  const _e = useAppStore(s => s._configEndTime);
  const currentAirport = useAppStore(s => s.currentAirport);
  const flights = useAppStore(s => s.flights);
  const [collapsed, setCollapsed] = useState(true);

  const rw = runwayTimeline || { initialRunways:[], timeline:[] };
  const pairs = _runwayPairs || [];
  const hasPairs = pairs.length > 0;

  const allNames = useMemo(() => {
    const fp = pairs.length ? [...new Set(pairs.flatMap(p => [p.source,p.dest]))] : [];
    const fv = airportValues[currentAirport]?.Runway || [];
    const ff = [...new Set(flights.map(f => (f.Runway||'').trim()).filter(Boolean))];
    return [...new Set([...fp, ...fv, ...ff])].sort((a,b)=>{const na=parseInt(a)||0,nb=parseInt(b)||0; if(na!==nb)return na-nb; return a.localeCompare(b);});
  }, [pairs,airportValues,currentAirport,flights]);

  const initialSet = new Set(rw.initialRunways||[]);

  const update = (fn) => { const st = useAppStore.getState(); fn(st); /* state synced via Zustand */ };
  const toggleInit = (n) => update(st => { const cur=new Set(st.runwayTimeline.initialRunways||[]); cur.has(n)?cur.delete(n):cur.add(n); useAppStore.setState({runwayTimeline:{...st.runwayTimeline,initialRunways:[...cur]}}); });
  const addChange = () => update(st => { useAppStore.setState({runwayTimeline:{...st.runwayTimeline,timeline:[...(st.runwayTimeline.timeline||[]),{time:getDefaultTime(_s,_e),changes:[],_isNew:true}]}}); });
  const delChange = (i) => update(st => { const tl=[...(st.runwayTimeline.timeline||[])]; tl.splice(i,1); useAppStore.setState({runwayTimeline:{...st.runwayTimeline,timeline:tl}}); });
  const chgTime = (i,v) => update(st => { const tl=[...(st.runwayTimeline.timeline||[])]; tl[i]={...tl[i],time:v}; useAppStore.setState({runwayTimeline:{...st.runwayTimeline,timeline:tl}}); });
  const togglePair = (tli,s,d) => update(st => { const tl=[...(st.runwayTimeline.timeline||[])]; const changes=[...(tl[tli].changes||[])]; const key=s+'|'+d; const idx=changes.findIndex(c=>(c.source+'|'+c.dest)===key); idx>=0?changes.splice(idx,1):changes.push({source:s,dest:d}); tl[tli]={...tl[tli],changes}; useAppStore.setState({runwayTimeline:{...st.runwayTimeline,timeline:tl}}); });

  return (
    <div id="timeline-block-runway" className={`tl-embed-block ${collapsed ? 'collapsed' : ''}`}>
      <div className="tl-embed-header" onClick={() => setCollapsed(!collapsed)} data-block="runway">
        <span className="tl-embed-title">{t('tl_runway')}</span>
        <span className="tl-embed-arrow">{collapsed ? '▸' : '▾'}</span>
      </div>
      <div className="tl-embed-body">
        <div className="tl-embed-body-inner">
        <div className="tl-toolbar tl-embed-toolbar"></div>
        <div className="tl-list">
          <div className="rw-initial-row">
            <span className="rw-initial-label">{t('tl_initial_runway')}</span>
            <div className="rw-checkbox-grid">
              {allNames.length>0 ? allNames.map(name => (
                <label key={name} className="rw-checkbox-label"><input className="rw-checkbox" type="checkbox" checked={initialSet.has(name)} onChange={()=>toggleInit(name)} />{escapeHtml(name)}</label>
              )) : <span className="text-muted">{t('tl_no_runway_data')}</span>}
            </div>
          </div>
          <div className="rw-toolbar"><button className="btn-sm" onClick={addChange}>{t('tl_add')}</button></div>
          {hasPairs && (rw.timeline||[]).map((tle,i) => {
            const activeKeys = new Set((tle.changes||[]).map(ch=>ch.source+'|'+ch.dest));
            return <div key={i} className="rw-change-card" {...(tle._isNew?{'data-new':''}:{})}>
              <div className="rw-change-header">
                <TimeCell value={tle.time} onChange={v => chgTime(i,v)} />
                <div className="rw-change-checkboxes">
                  {pairs.map(p=>{const key=p.source+'|'+p.dest; return <label key={key} className="rw-checkbox-label"><input className="rw-change-cb" type="checkbox" checked={activeKeys.has(key)} onChange={()=>togglePair(i,p.source,p.dest)} />{escapeHtml(p.source)} → {escapeHtml(p.dest)}</label>;})}
                </div>
                <button className="tl-btn-del" onClick={()=>delChange(i)} title={t('tl_delete_change')}>X</button>
              </div>
            </div>;
          })}
        </div>
        </div>
      </div>
    </div>
  );
}
