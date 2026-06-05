import React, { useState, useEffect, useCallback } from 'react';
import './BrowserScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { airportDisplayName, airportSortOrder } from '../../utils/constants';
import { IoClose, IoChevronForward, IoLanguage, IoFolderOpenOutline, IoEyeOutline, IoEyeOffOutline, IoBugOutline, IoRefreshOutline } from 'react-icons/io5';
import { escapeHtml, stripSuffixes } from '../../utils/htmlUtils';

// Module-scope regexps — hoisted per AGENTS rule 7.10
const RE_TUTORIAL = /tutorial/i;
const RE_DEMO = /demo/i;
const RE_TEST = /bench|test|crossrunway|dev|\.prod/i;
const RE_ENDLESS = /endless/i;

// Demo mode: show only these time-window subsets of real ACL files
const DEMO_LEVELS = [
  { icao: 'ZSJN', filePattern: /morning/i, labelStartTime: '05:45', labelEndTime: '06:15' },
  { icao: 'ZSJN', filePattern: /07-10/i,  labelStartTime: '07:30', labelEndTime: '08:00' },
  { icao: 'KJFK', filePattern: /09-11/i,  labelStartTime: '09:30', labelEndTime: '10:00' },
  { icao: 'KJFK', filePattern: /20-22/i,  labelStartTime: '20:30', labelEndTime: '21:00' },
];

export default function BrowserScreen() {
  const { t, toggleLang } = useTranslation();
  const electronAPI = useElectronAPI();
  const rootPath = useAppStore(s => s.rootPath);
  const airports = useAppStore(s => s.airports);
  const setScreen = useAppStore(s => s.setScreen);

  const isDemo = rootPath && rootPath.includes('Airport Control 27 Demo');

  const [fileInfos, setFileInfos] = useState({});
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState(() => {
    try { return !!localStorage.getItem('browser-note-dismissed'); } catch (_) { return false; }
  });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const sorted = [...airports].sort((a, b) => airportSortOrder(a.icao) - airportSortOrder(b.icao));
      const allInfos = {};
      for (const airport of sorted) {
        let infos = await electronAPI.getAirportFilesInfo(airport.icao, rootPath);
        if (isDemo) {
          // Filter to demo entries matching this airport
          infos = infos.filter(info => {
            return DEMO_LEVELS.some(d => d.icao === airport.icao && d.filePattern.test(info.filename));
          });
          for (const info of infos) {
            // Override display times with demo time windows
            const demoEntry = DEMO_LEVELS.find(d => d.icao === airport.icao && d.filePattern.test(info.filename));
            info.startTime = demoEntry ? demoEntry.labelStartTime : info.startTime;
            info.endTime = demoEntry ? demoEntry.labelEndTime : info.endTime;
            info._hidden = false;
            info._metaLabels = [];
            if (info.startTime && info.endTime) {
              const toHHMM = s => String(s).substring(0, 5);
              info._metaLabels.push({ label: toHHMM(info.startTime) + '-' + toHHMM(info.endTime), type: 'timerange' });
              const startH = parseInt(String(info.startTime).substring(0, 2));
              let todLabel, todType;
              if (startH >= 5 && startH < 7) { todLabel = t('browser_tod_dawn'); todType = 'dawn'; }
              else if (startH >= 7 && startH < 12) { todLabel = t('browser_tod_morning'); todType = 'morning'; }
              else if (startH >= 12 && startH < 17) { todLabel = t('browser_tod_afternoon'); todType = 'afternoon'; }
              else if (startH >= 17 && startH < 19) { todLabel = t('browser_tod_dusk'); todType = 'dusk'; }
              else { todLabel = t('browser_tod_night'); todType = 'night'; }
              info._metaLabels.push({ label: todLabel, type: 'tod', tod: todType });
            }
          }
        } else {
          for (const info of infos) {
            const name = info.filename.toLowerCase();
            info._hidden = false; info._metaLabels = [];
            if (info.error) { info._hidden = true; info._metaLabels.push({ label: t('browser_parse_error'), type: 'error' }); }
            else if (RE_TUTORIAL.test(name)) { info._hidden = true; info._metaLabels.push({ label: t('browser_tag_tutorial'), type: 'tutorial' }); }
            else if (RE_DEMO.test(name)) { info._hidden = true; info._metaLabels.push({ label: 'Demo', type: 'demo' }); }
            else if (RE_TEST.test(name)) { info._hidden = true; info._metaLabels.push({ label: t('browser_tag_test'), type: 'test' }); }
            else if (RE_ENDLESS.test(name)) { info._hidden = true; info._metaLabels.push({ label: t('browser_tag_endless'), type: 'endless' }); }
            if (!info._hidden && info.startTime && info.endTime) {
              const toHHMM = s => String(s).substring(0, 5);
              info._metaLabels.push({ label: toHHMM(info.startTime) + '-' + toHHMM(info.endTime), type: 'timerange' });
              const startH = parseInt(String(info.startTime).substring(0, 2));
              let todLabel, todType;
              if (startH >= 5 && startH < 7) { todLabel = t('browser_tod_dawn'); todType = 'dawn'; }
              else if (startH >= 7 && startH < 12) { todLabel = t('browser_tod_morning'); todType = 'morning'; }
              else if (startH >= 12 && startH < 17) { todLabel = t('browser_tod_afternoon'); todType = 'afternoon'; }
              else if (startH >= 17 && startH < 19) { todLabel = t('browser_tod_dusk'); todType = 'dusk'; }
              else { todLabel = t('browser_tod_night'); todType = 'night'; }
              info._metaLabels.push({ label: todLabel, type: 'tod', tod: todType });
            }
          }
        }
        infos = [...infos].sort((a, b) => { const aT=RE_TUTORIAL.test(a.filename)?0:1, bT=RE_TUTORIAL.test(b.filename)?0:1; if(aT!==bT)return aT-bT; return (a.startTime||'99:99').localeCompare(b.startTime||'99:99'); });
        allInfos[airport.icao] = infos;
      }
      if (!cancelled) { setFileInfos(allInfos); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [airports, rootPath, refreshKey]);

  const getLabel = useCallback((l) => {
    if (l.type === 'error') return t('browser_parse_error');
    if (l.type === 'tutorial') return t('browser_tag_tutorial');
    if (l.type === 'test') return t('browser_tag_test');
    if (l.type === 'endless') return t('browser_tag_endless');
    if (l.type === 'tod' && l.tod) return t('browser_tod_' + l.tod);
    return l.label;
  }, [t]);

  const handleOpenFile = (filePath, airportIcao) => {
    window._pendingEditor = { filePath, airportIcao };
    useAppStore.getState().setScreen('editor');
  };

  const handleBugReport = () => {
    electronAPI.openExternal('https://github.com/ericpzh/AC27LevelEditor/issues');
  };

  const [refreshing, setRefreshing] = useState(false);

  const doRefreshScan = async () => {
    setRefreshing(true);
    try {
      await electronAPI.refreshRootScan(rootPath);
      setRefreshKey(k => k + 1); // trigger useEffect to reload with proper hidden/label processing
    } catch (_) {}
    setRefreshing(false);
  };

  const handleRefreshScan = () => {
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      t('browser_rescan_guide_title'),
      <div>
        <p>{t('browser_rescan_guide_body')}</p>
        <ol>
          <li>{t('browser_rescan_guide_step1')} <code className="guide-path">{t('browser_rescan_guide_step1_path')}</code></li>
          <li dangerouslySetInnerHTML={{ __html: t('browser_rescan_guide_step2') }} />
        </ol>
      </div>,
      <div className="modal-actions-row">
        <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
        <button className="btn-confirm" onClick={() => { hideModal(); doRefreshScan(); }}>{t('browser_btn_continue')}</button>
      </div>
    );
  };

  const visibleCount = Object.values(fileInfos).flat().filter(i => showHidden || !i._hidden).length;

  return (
    <div id="screen-browser" className="screen">
      <header className="browser-header">
        <div className="browser-title"><span>{t('browser_title')}</span></div>
        <div className="browser-actions">
          <span className="browser-root-path">{rootPath || ''}</span>
          <button className="btn-sm" onClick={() => setScreen('setup')}><IoFolderOpenOutline size={14} className="btn-icon" />{t('browser_change_dir')}</button>
          <button className={`btn-sm ${refreshing ? 'btn-disabled' : ''}`} onClick={handleRefreshScan} disabled={refreshing} title={t('browser_refresh_scan')}>
            <IoRefreshOutline size={14} className="btn-icon" />{refreshing ? t('browser_refreshing') : t('browser_refresh_scan')}
          </button>
          {!isDemo && (
            <button className={`btn-sm btn-toggle-hidden ${showHidden ? 'active' : ''}`} onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? <><IoEyeOffOutline size={14} className="btn-icon" />{t('browser_hide_hidden')}</> : <><IoEyeOutline size={14} className="btn-icon" />{t('browser_toggle_hidden')}</>}
            </button>
          )}
          <button className="btn-sm btn-bug-report" onClick={handleBugReport} title={t('browser_bug_report')}>
            <IoBugOutline size={14} className="btn-icon" />{t('browser_bug_report')}
          </button>
          <button className="btn-lang-toggle-top" onClick={toggleLang}><IoLanguage size={14} className="btn-icon" /> {t('lang_switch_to')}</button>
        </div>
      </header>

      {!noteDismissed && (
        <div className="browser-note">
          <span>{t('browser_note')}</span>
          <button className="browser-note-close" onClick={() => { setNoteDismissed(true); try { localStorage.setItem('browser-note-dismissed','1'); } catch(_){} }}><IoClose size={16} /></button>
        </div>
      )}

      <main className="browser-content">
        {loading ? (
          <div className="loading-state"><div className="spinner" /><p>{t('browser_loading')}</p></div>
        ) : visibleCount === 0 ? (
          <div className="browser-empty">{t('browser_no_files')}</div>
        ) : (
          [...airports].sort((a, b) => airportSortOrder(a.icao) - airportSortOrder(b.icao)).filter(a => (fileInfos[a.icao]||[]).some(i => showHidden || !i._hidden)).map(airport => (
            <div key={airport.icao} className="airport-card" style={{ '--card-bg': `url(./${airport.icao}.png)` }}>
              <div className="airport-card-header"><span className="airport-icao">{airportDisplayName(airport.icao, t)}</span></div>
              {fileInfos[airport.icao].map((info, i) => {
                if (info._hidden && !showHidden) return null;
                const allTags = info._metaLabels || [];
                const todTag = allTags.find(t=>t.type==='tod'), trTag = allTags.find(t=>t.type==='timerange');
                const badgeTags = allTags.filter(t=>t.type!=='tod'&&t.type!=='time'&&t.type!=='timerange');
                if (info.error) return (
                  <div key={i} className="level-row level-row-error">
                    <span className="level-tod"></span>
                    <span className="level-timerange"></span>
                    <span className="level-name">{info.filename}</span>
                    {badgeTags.length>0 && <span className="level-tags">{badgeTags.map((l,j)=><span key={j} className={`level-tag tag-${l.type}`}>{escapeHtml(getLabel(l))}</span>)}</span>}
                    <span className="level-stats level-error-text">{info.error}</span>
                    <span className="level-arrow"><IoChevronForward size={14} /></span>
                  </div>
                );
                const displayName = stripSuffixes(info.filename);
                return (
                  <div key={i} className="level-row" onClick={()=>handleOpenFile(info.path, airport.icao)}>
                    <span className="level-tod">{todTag ? getLabel(todTag) : ''}</span>
                    <span className="level-timerange">{trTag ? trTag.label : ''}</span>
                    <span className="level-name">{displayName}</span>
                    {badgeTags.length>0 && <span className="level-tags">{badgeTags.map((l,j)=><span key={j} className={`level-tag tag-${l.type}`}>{escapeHtml(getLabel(l))}</span>)}</span>}
                    <span className="level-stats">
                      <span className="level-stat"><span className="level-stat-dot arrival" />{t('table_arrivals')} {info.arrivals||0}</span>
                      <span className="level-stat"><span className="level-stat-dot departure" />{t('table_departures')} {info.departures||0}</span>
                    </span>
                    <span className="level-arrow"><IoChevronForward size={14} /></span>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </main>
    </div>
  );
}
