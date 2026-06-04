import React, { useState, useMemo } from 'react';
import './TimelineEditors.css';
import { useTranslation } from '../../../hooks/useTranslation';
import { useAppStore } from '../../../store/appStore';
import CompassPopover from '../CellEditor/CompassPopover';
import ClockPopover from '../CellEditor/TimeClockPopover';

function timeToMinutes(timeStr) { const parts = String(timeStr).split(':'); return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10); }
function timeToSeconds(timeStr) { const parts = String(timeStr).split(':'); return (parseInt(parts[0], 10) || 0) * 3600 + (parseInt(parts[1], 10) || 0) * 60 + (parseInt(parts[2], 10) || 0); }
function sortTimelineByTime(timeline) { timeline.sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time)); }
function getTimelineActiveRange(timeline, configStartTime, configEndTime) {
  if (!configStartTime || !configEndTime) return { validMinTime: null, validMaxTime: null, activeIndices: new Set((timeline||[]).map((_, i) => i)), totalCount: (timeline||[]).length };
  const start = timeToMinutes(configStartTime), end = timeToMinutes(configEndTime);
  const activeIndices = new Set();
  for (let i = 0; i < timeline.length; i++) { const t = timeToMinutes(timeline[i].time); if (t > start && t < end) activeIndices.add(i); }
  return { validMinTime: start, validMaxTime: end, activeIndices, totalCount: timeline.length };
}
function TimeCell({ value, onChange }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <span className="tl-input" style={{cursor:'pointer'}} onClick={() => setShow(true)}>{value || ''}</span>
      {show && <ClockPopover value={value || '00:00:00'} col="Time" onCommit={v => { onChange(v); setShow(false); }} onClose={() => setShow(false)} />}
    </>
  );
}

function DirectionCell({ value, onChange }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <span className="tl-input" style={{cursor:'pointer',display:'flex',alignItems:'center'}} onClick={() => setShow(true)}>
        {value != null ? value + '°' : ''}
      </span>
      {show && <CompassPopover value={value} onCommit={v => { onChange(v); setShow(false); }} onClose={() => setShow(false)} />}
    </>
  );
}

function getDefaultTime(appState) {
  const s = appState._configStartTime, e = appState._configEndTime;
  if (s && e) { const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); }; const mid = Math.floor((toMin(s) + toMin(e)) / 2); return String(Math.floor(mid / 60) % 24).padStart(2, '0') + ':' + String(mid % 60).padStart(2, '0') + ':00'; }
  if (s) return String(s).substring(0, 8);
  if (e) return String(e).substring(0, 8);
  return '12:00:00';
}
export default function WindEditor() {
  const { t } = useTranslation();
  const windTimeline = useAppStore(s => s.windTimeline);
  const _s = useAppStore(s => s._configStartTime);
  const _e = useAppStore(s => s._configEndTime);
  const [collapsed, setCollapsed] = useState(true);

  const sorted = useMemo(() => { const c=[...windTimeline]; sortTimelineByTime(c); return c; }, [windTimeline]);
  const range = useMemo(() => getTimelineActiveRange(sorted, _s, _e), [sorted, _s, _e]);
  const active = useMemo(() => sorted.filter((_,i) => range.activeIndices.has(i)), [sorted, range]);
  const hidden = range.totalCount - range.activeIndices.size;

  const update = (fn) => { const st = useAppStore.getState(); fn(st); /* state synced via Zustand */ };
  const add = () => update(st => { useAppStore.setState({ windTimeline: [...st.windTimeline, { direction:180, speed:5, time:getDefaultTime({_configStartTime:_s,_configEndTime:_e}), _isNew:true }] }); });
  const del = (ri) => update(st => { const c=[...st.windTimeline]; c.splice(ri,1); useAppStore.setState({ windTimeline: c }); });
  const chg = (ri, f, v) => update(st => { const c=[...st.windTimeline]; c[ri]={...c[ri], [f]: f==='speed'?parseInt(v)||0:v}; useAppStore.setState({ windTimeline: c }); });

  return (
    <div id="timeline-block-wind" className={`tl-embed-block ${collapsed ? 'collapsed' : ''}`}>
      <div className="tl-embed-header" onClick={() => setCollapsed(!collapsed)} data-block="wind">
        <span className="tl-embed-title">{t('tl_wind')}</span>
        <span className="tl-embed-arrow">{collapsed ? '▸' : '▾'}</span>
      </div>
      <div className="tl-embed-body">
        <div className="tl-embed-body-inner">
        <div className="tl-toolbar tl-embed-toolbar">
          <button className="btn-sm" onClick={add}>{t('tl_add')}</button>
          <span className="tl-range-indicator">{range.validMinTime!=null?`${t('tl_range')}: ${String(Math.floor(range.validMinTime/60)%24).padStart(2,'0')}:${String(range.validMinTime%60).padStart(2,'0')} ~ ${String(Math.floor(range.validMaxTime/60)%24).padStart(2,'0')}:${String(range.validMaxTime%60).padStart(2,'0')}`:''}</span>
          {hidden>0&&<span className="tl-hidden-count">{t('tl_hidden_count',{n:hidden})}</span>}
        </div>
        <div id="wind-list" className="tl-list">
          <div className="tl-hdr"><span>{t('tl_time')}</span><span>{t('tl_direction')}</span><span>{t('tl_speed')}</span><span></span><span></span></div>
          {active.map(e => { const ri = sorted.indexOf(e);
            return <div key={ri} className="tl-row" data-idx={ri} {...(e._isNew ? { 'data-new': '' } : {})}>
              <TimeCell value={e.time} onChange={v => chg(ri,'time',v)} />
              <DirectionCell value={e.direction} onChange={v => chg(ri,'direction',v)} />
              <div className="tl-speed-row"><input className="tl-speed-slider" type="range" min="0" max="40" value={e.speed||0} onChange={ev => chg(ri,'speed',ev.target.value)} /><span className="tl-speed-val">{e.speed||0} kt</span></div>
              <span></span>
              <button className="tl-btn-del" onClick={() => del(ri)} title={t('tl_delete')}>X</button>
            </div>;
          })}
        </div>
        </div>
      </div>
    </div>
  );
}
