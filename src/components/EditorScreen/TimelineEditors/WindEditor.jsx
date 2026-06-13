import React, { useState, useMemo } from 'react';
import { IoChevronForward, IoChevronDown, IoClose, IoAdd } from 'react-icons/io5';
import './TimelineEditors.css';
import { useTranslation } from '../../../hooks/useTranslation';
import { useAppStore } from '../../../store/appStore';
import { sortTimelineByTime, getTimelineActiveRange, getDefaultTime } from '../../../utils/timeUtils';
import CompassPopover from '../CellEditor/CompassPopover';
import TimeCell from './TimeCell';

function DirectionCell({ value, onChange }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <span className="tl-input tl-direction-cell" onClick={() => setShow(true)}>
        {value != null ? value + '°' : ''}
      </span>
      {show && <CompassPopover value={value} onCommit={v => { onChange(v); setShow(false); }} onClose={() => setShow(false)} />}
    </>
  );
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

  const update = (fn) => { const st = useAppStore.getState(); fn(st); st.setTimelineModified('wind', true); };
  const add = () => update(st => { useAppStore.setState({ windTimeline: [...st.windTimeline, { direction:180, speed:5, time:getDefaultTime({_configStartTime:_s,_configEndTime:_e}), _isNew:true }] }); });
  const del = (ri) => update(st => { const c=[...st.windTimeline]; c.splice(ri,1); useAppStore.setState({ windTimeline: c }); });
  const chg = (ri, f, v) => update(st => { const c=[...st.windTimeline]; c[ri]={...c[ri], [f]: f==='speed'?parseInt(v)||0:v}; useAppStore.setState({ windTimeline: c }); });

  return (
    <div id="timeline-block-wind" className={`tl-embed-block ${collapsed ? 'collapsed' : ''}`}>
      <div className="tl-embed-header" onClick={() => setCollapsed(!collapsed)} data-block="wind">
        <span className="tl-embed-title">{t('tl_wind')}</span>
        <span className="tl-embed-arrow">{collapsed ? <IoChevronForward size={12} /> : <IoChevronDown size={12} />}</span>
      </div>
      <div className="tl-embed-body">
        <div className="tl-embed-body-inner">
        <div id="wind-list" className="tl-list">
          <div className="tl-hdr">
            <span>{t('tl_time')}</span><span>{t('tl_direction')}</span><span>{t('tl_speed')}</span>
            <span></span>
            <span className="tl-hdr-info">{range.validMinTime!=null?`${String(Math.floor(range.validMinTime/60)%24).padStart(2,'0')}:${String(range.validMinTime%60).padStart(2,'0')} ~ ${String(Math.floor(range.validMaxTime/60)%24).padStart(2,'0')}:${String(range.validMaxTime%60).padStart(2,'0')}`:''}</span>
            <span className="tl-hdr-info">{hidden>0?t('tl_hidden_count',{n:hidden}):''}</span>
            <button className="btn-sm" onClick={add}><IoAdd size={14} className="btn-icon" />{t('tl_add')}</button>
          </div>
          {active.map(e => { const ri = windTimeline.indexOf(e);
            return <div key={ri} className="tl-row" data-idx={ri} {...(e._isNew ? { 'data-new': '' } : {})}>
              <TimeCell value={e.time} onChange={v => chg(ri,'time',v)} minTime={_s} maxTime={_e} />
              <DirectionCell value={e.direction} onChange={v => chg(ri,'direction',v)} />
              <div className="tl-speed-row"><input className="tl-speed-slider" type="range" min="0" max="40" value={e.speed||0} onChange={ev => chg(ri,'speed',ev.target.value)} /><span className="tl-speed-val">{e.speed||0} kt</span></div>
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
