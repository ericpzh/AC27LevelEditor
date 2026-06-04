import React, { useState, useMemo } from 'react';
import './TimelineEditors.css';
import { useTranslation } from '../../../hooks/useTranslation';
import { useAppStore } from '../../../store/appStore';
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

function getDefaultTime(appState) {
  const s = appState._configStartTime, e = appState._configEndTime;
  if (s && e) { const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); }; const mid = Math.floor((toMin(s) + toMin(e)) / 2); return String(Math.floor(mid / 60) % 24).padStart(2, '0') + ':' + String(mid % 60).padStart(2, '0') + ':00'; }
  if (s) return String(s).substring(0, 8);
  if (e) return String(e).substring(0, 8);
  return '12:00:00';
}

const PRESETS = ['Sunny','FewCloudy','MidCloudy','PartlyCloudy','OvercastSky','AfterRain'];

export default function WeatherEditor() {
  const { t } = useTranslation();
  const weatherTimeline = useAppStore(s => s.weatherTimeline);
  const _s = useAppStore(s => s._configStartTime);
  const _e = useAppStore(s => s._configEndTime);
  const [collapsed, setCollapsed] = useState(true);

  const sorted = useMemo(() => { const c=[...weatherTimeline]; sortTimelineByTime(c); return c; }, [weatherTimeline]);
  const range = useMemo(() => getTimelineActiveRange(sorted, _s, _e), [sorted, _s, _e]);
  const active = useMemo(() => sorted.filter((_,i) => range.activeIndices.has(i)), [sorted, range]);
  const hidden = range.totalCount - range.activeIndices.size;

  const update = (fn) => { const st = useAppStore.getState(); fn(st); /* state synced via Zustand */ };
  const add = () => update(st => { useAppStore.setState({ weatherTimeline: [...st.weatherTimeline, { preset:'Sunny', time:getDefaultTime({_configStartTime:_s,_configEndTime:_e}), _isNew:true }] }); });
  const del = (ri) => update(st => { const c=[...st.weatherTimeline]; c.splice(ri,1); useAppStore.setState({ weatherTimeline: c }); });
  const chg = (ri, f, v) => update(st => { const c=[...st.weatherTimeline]; c[ri]={...c[ri], [f]:v}; useAppStore.setState({ weatherTimeline: c }); });

  return (
    <div id="timeline-block-weather" className={`tl-embed-block ${collapsed ? 'collapsed' : ''}`}>
      <div className="tl-embed-header" onClick={() => setCollapsed(!collapsed)} data-block="weather">
        <span className="tl-embed-title">{t('tl_weather')}</span>
        <span className="tl-embed-arrow">{collapsed ? '▸' : '▾'}</span>
      </div>
      <div className="tl-embed-body">
        <div className="tl-embed-body-inner">
        <div className="tl-toolbar tl-embed-toolbar">
          <button className="btn-sm" onClick={add}>{t('tl_add')}</button>
          <span className="tl-range-indicator">{range.validMinTime!=null?`${t('tl_range')}: ${String(Math.floor(range.validMinTime/60)%24).padStart(2,'0')}:${String(range.validMinTime%60).padStart(2,'0')} ~ ${String(Math.floor(range.validMaxTime/60)%24).padStart(2,'0')}:${String(range.validMaxTime%60).padStart(2,'0')}`:''}</span>
          {hidden>0&&<span className="tl-hidden-count">{t('tl_hidden_count',{n:hidden})}</span>}
        </div>
        <div id="weather-list" className="tl-list">
          <div className="tl-hdr"><span>{t('tl_time')}</span><span>{t('tl_preset')}</span><span></span><span></span></div>
          {active.map(e => { const ri = sorted.indexOf(e);
            return <div key={ri} className="tl-row" data-idx={ri} {...(e._isNew ? { 'data-new': '' } : {})}>
              <TimeCell value={e.time} onChange={v => chg(ri,'time',v)} />
              <select className="tl-select" value={e.preset||'Sunny'} onChange={ev => chg(ri,'preset',ev.target.value)}>{PRESETS.map(p => <option key={p} value={p}>{p}</option>)}</select>
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
