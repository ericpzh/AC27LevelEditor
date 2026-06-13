import React, { useState, useMemo } from 'react';
import { IoChevronForward, IoChevronDown, IoClose, IoAdd } from 'react-icons/io5';
import './TimelineEditors.css';
import './RunwayEditor.css';
import { useTranslation } from '../../../hooks/useTranslation';
import { useAppStore } from '../../../store/appStore';
import { escapeHtml } from '../../../utils/htmlUtils';
import { sortTimelineByTime, getTimelineActiveRange, getDefaultTime } from '../../../utils/timeUtils';
import TimeCell from './TimeCell';

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
  const tl = rw.timeline || [];
  const sorted = useMemo(() => { const c=[...tl]; sortTimelineByTime(c); return c; }, [tl]);
  const range = useMemo(() => getTimelineActiveRange(sorted, _s, _e), [sorted, _s, _e]);
  const hidden = range.totalCount - range.activeIndices.size;
  const active = useMemo(() => sorted.filter((_,i) => range.activeIndices.has(i)), [sorted, range]);

  const allNames = useMemo(() => {
    const fp = pairs.length ? [...new Set(pairs.flatMap(p => [p.source,p.dest]))] : [];
    const fv = airportValues[currentAirport]?.Runway || [];
    const ff = [...new Set(flights.map(f => (f.Runway||'').trim()).filter(Boolean))];
    return [...new Set([...fp, ...fv, ...ff])].sort((a,b)=>{const na=parseInt(a)||0,nb=parseInt(b)||0; if(na!==nb)return na-nb; return a.localeCompare(b);});
  }, [pairs,airportValues,currentAirport,flights]);

  const initialSet = new Set(rw.initialRunways||[]);

  const update = (fn) => { const st = useAppStore.getState(); fn(st); st.setTimelineModified('runway', true); };
  const toggleInit = (n) => update(st => { const cur=new Set(st.runwayTimeline.initialRunways||[]); cur.has(n)?cur.delete(n):cur.add(n); useAppStore.setState({runwayTimeline:{...st.runwayTimeline,initialRunways:[...cur]}}); });
  const addChange = () => update(st => { useAppStore.setState({runwayTimeline:{...st.runwayTimeline,timeline:[...(st.runwayTimeline.timeline||[]),{time:getDefaultTime({_configStartTime:_s,_configEndTime:_e}),changes:[],_isNew:true}]}}); });
  const delChange = (entry) => update(st => { const tl=[...(st.runwayTimeline.timeline||[])]; const idx=tl.indexOf(entry); if(idx>=0) tl.splice(idx,1); useAppStore.setState({runwayTimeline:{...st.runwayTimeline,timeline:tl}}); });
  const chgTime = (entry,v) => update(st => { const tl=[...(st.runwayTimeline.timeline||[])]; const idx=tl.indexOf(entry); if(idx>=0) tl[idx]={...tl[idx],time:v}; useAppStore.setState({runwayTimeline:{...st.runwayTimeline,timeline:tl}}); });
  const togglePair = (entry,s,d) => update(st => { const tl=[...(st.runwayTimeline.timeline||[])]; const idx=tl.indexOf(entry); if(idx<0)return; const changes=[...(tl[idx].changes||[])]; const key=s+'|'+d; const ci=changes.findIndex(c=>(c.source+'|'+c.dest)===key); ci>=0?changes.splice(ci,1):changes.push({source:s,dest:d}); tl[idx]={...tl[idx],changes}; useAppStore.setState({runwayTimeline:{...st.runwayTimeline,timeline:tl}}); });

  return (
    <div id="timeline-block-runway" className={`tl-embed-block ${collapsed ? 'collapsed' : ''}`}>
      <div className="tl-embed-header" onClick={() => setCollapsed(!collapsed)} data-block="runway">
        <span className="tl-embed-title">{t('tl_runway')}</span>
        <span className="tl-embed-arrow">{collapsed ? <IoChevronForward size={12} /> : <IoChevronDown size={12} />}</span>
      </div>
      <div className="tl-embed-body">
        <div className="tl-embed-body-inner">
        <div className="tl-toolbar tl-embed-toolbar"></div>
        <div className="rw-initial-row">
          <span className="rw-initial-label">{t('tl_initial_runway')}</span>
          <div className="rw-checkbox-grid">
            {allNames.length>0 ? allNames.map(name => (
              <label key={name} className="rw-checkbox-label"><input className="rw-checkbox" type="checkbox" checked={initialSet.has(name)} onChange={()=>toggleInit(name)} />{escapeHtml(name)}</label>
            )) : <span className="text-muted">{t('tl_no_runway_data')}</span>}
          </div>
        </div>
        <div id="runway-list" className="tl-list">
          <div className="tl-hdr">
            <span>{t('tl_time')}</span><span>{t('tl_runway_change')}</span>
            <span></span>
            <span className="tl-hdr-info">{range.validMinTime!=null?`${String(Math.floor(range.validMinTime/60)%24).padStart(2,'0')}:${String(range.validMinTime%60).padStart(2,'0')} ~ ${String(Math.floor(range.validMaxTime/60)%24).padStart(2,'0')}:${String(range.validMaxTime%60).padStart(2,'0')}`:''}</span>
            <button className="btn-sm" onClick={addChange}><IoAdd size={14} className="btn-icon" />{t('tl_add')}</button>
          </div>
          {hasPairs && active.map(e => { const ri = sorted.indexOf(e);
            const activeKeys = new Set((e.changes||[]).map(ch=>ch.source+'|'+ch.dest));
            return <div key={ri} className="tl-row" {...(e._isNew?{'data-new':''}:{})}>
              <div className="rw-change-header">
                <TimeCell value={e.time} onChange={v => chgTime(e,v)} minTime={_s} maxTime={_e} />
                <div className="rw-change-checkboxes">
                  {pairs.map(p=>{const key=p.source+'|'+p.dest; return <label key={key} className="rw-checkbox-label"><input className="rw-change-cb" type="checkbox" checked={activeKeys.has(key)} onChange={()=>togglePair(e,p.source,p.dest)} />{escapeHtml(p.source)} → {escapeHtml(p.dest)}</label>;})}
                </div>
                <span></span><span></span>
                <button className="tl-btn-del" onClick={()=>delChange(e)} title={t('tl_delete_change')}><IoClose size={14} /></button>
              </div>
            </div>;
          })}
        </div>
        </div>
      </div>
    </div>
  );
}
