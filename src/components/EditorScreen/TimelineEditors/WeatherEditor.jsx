import React, { useState, useMemo } from 'react';
import { IoChevronForward, IoChevronDown, IoClose, IoAdd } from 'react-icons/io5';
import './TimelineEditors.css';
import { useTranslation } from '../../../hooks/useTranslation';
import { useAppStore } from '../../../store/appStore';
import { sortTimelineByTime, getTimelineActiveRange, getDefaultTime } from '../../../utils/timeUtils';
import TimeCell from './TimeCell';

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

  const update = (fn) => { const st = useAppStore.getState(); fn(st); st.setTimelineModified('weather', true); };
  const add = () => update(st => { useAppStore.setState({ weatherTimeline: [...st.weatherTimeline, { preset:'Sunny', time:getDefaultTime({_configStartTime:_s,_configEndTime:_e}), _isNew:true }] }); });
  const del = (ri) => update(st => { const c=[...st.weatherTimeline]; c.splice(ri,1); useAppStore.setState({ weatherTimeline: c }); });
  const chg = (ri, f, v) => update(st => { const c=[...st.weatherTimeline]; c[ri]={...c[ri], [f]:v}; useAppStore.setState({ weatherTimeline: c }); });

  return (
    <div id="timeline-block-weather" className={`tl-embed-block ${collapsed ? 'collapsed' : ''}`}>
      <div className="tl-embed-header" onClick={() => setCollapsed(!collapsed)} data-block="weather">
        <span className="tl-embed-title">{t('tl_weather')}</span>
        <span className="tl-embed-arrow">{collapsed ? <IoChevronForward size={12} /> : <IoChevronDown size={12} />}</span>
      </div>
      <div className="tl-embed-body">
        <div className="tl-embed-body-inner">
        <div id="weather-list" className="tl-list">
          <div className="tl-hdr">
            <span>{t('tl_time')}</span><span>{t('tl_preset')}</span>
            <span></span>
            <span className="tl-hdr-info">{range.validMinTime!=null?`${String(Math.floor(range.validMinTime/60)%24).padStart(2,'0')}:${String(range.validMinTime%60).padStart(2,'0')} ~ ${String(Math.floor(range.validMaxTime/60)%24).padStart(2,'0')}:${String(range.validMaxTime%60).padStart(2,'0')}`:''}</span>
            <span className="tl-hdr-info">{hidden>0?t('tl_hidden_count',{n:hidden}):''}</span>
            <button className="btn-sm" onClick={add}><IoAdd size={14} className="btn-icon" />{t('tl_add')}</button>
          </div>
          {active.map(e => { const ri = weatherTimeline.indexOf(e);
            return <div key={ri} className="tl-row" data-idx={ri} {...(e._isNew ? { 'data-new': '' } : {})}>
              <TimeCell value={e.time} onChange={v => chg(ri,'time',v)} minTime={_s} maxTime={_e} />
              <select className="tl-select" value={e.preset||'Sunny'} onChange={ev => chg(ri,'preset',ev.target.value)}>{PRESETS.map(p => <option key={p} value={p}>{p}</option>)}</select>
              <span></span><span></span><span></span>
              <button className="tl-btn-del" onClick={() => del(ri)} title={t('tl_delete')}><IoClose size={14} /></button>
            </div>;
          })}
        </div>
        </div>
      </div>
    </div>
  );
}
