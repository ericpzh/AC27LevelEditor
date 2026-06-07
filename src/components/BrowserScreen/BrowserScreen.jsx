import React, { useState, useEffect } from 'react';
import './BrowserScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { airportDisplayName, airportSortOrder } from '../../utils/constants';
import { IoClose, IoChevronForward, IoLanguage, IoFolderOpenOutline, IoBugOutline, IoRefreshOutline } from 'react-icons/io5';
import { IoSunnyOutline, IoMoonOutline } from 'react-icons/io5';
import { stripSuffixes } from '../../utils/htmlUtils';

// Only hide tutorial / test / endless / dev / bench / crossrunway / .Prod variants.
// Demo files (.demo.acl) are always visible alongside production levels.
const RE_HIDDEN = /tutorial|bench|test|crossrunway|dev|endless|\.prod/i;

function rescanGuideContent(t) {
  return (
    <div>
      <p>{t('browser_rescan_guide_body')}</p>
      <ol>
        <li>{t('browser_rescan_guide_step1')} <code className="guide-path">{t('browser_rescan_guide_step1_path')}</code></li>
        <li dangerouslySetInnerHTML={{ __html: t('browser_rescan_guide_step2') }} />
      </ol>
    </div>
  );
}

function computeTodLabel(startTime, t) {
  if (!startTime) return { label: '', type: '' };
  const startH = parseInt(String(startTime).substring(0, 2));
  if (startH >= 5 && startH < 7) return { label: t('browser_tod_dawn'), type: 'dawn' };
  if (startH >= 7 && startH < 12) return { label: t('browser_tod_morning'), type: 'morning' };
  if (startH >= 12 && startH < 17) return { label: t('browser_tod_afternoon'), type: 'afternoon' };
  if (startH >= 17 && startH < 19) return { label: t('browser_tod_dusk'), type: 'dusk' };
  return { label: t('browser_tod_night'), type: 'night' };
}

function toHHMM(s) { return String(s).substring(0, 5); }

export default function BrowserScreen() {
  const { t, toggleLang } = useTranslation();
  const electronAPI = useElectronAPI();
  const rootPath = useAppStore(s => s.rootPath);
  const airports = useAppStore(s => s.airports);
  const setScreen = useAppStore(s => s.setScreen);
  const theme = useAppStore(s => s.theme);
  const toggleTheme = useAppStore(s => s.toggleTheme);

  const isDemo = rootPath && rootPath.includes('Airport Control 27 Demo');

  const [fileInfos, setFileInfos] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    electronAPI.getAppVersion().then(v => setAppVersion(v)).catch(() => {});
  }, []);

  useEffect(() => {
    electronAPI.getCacheState().then(result => {
      if (result && result.state === 'mismatch') {
        const { showModal } = useAppStore.getState();
        showModal(
          t => t('browser_version_mismatch_title'),
          t => rescanGuideContent(t),
          t => <div className="modal-actions-row">
            <button className="btn-confirm" onClick={handleVersionMismatchRescan}>
              {t('browser_version_mismatch_button')}
            </button>
          </div>,
          false, // closeable=false
          null,  // headerRight
          true   // showLangToggle — Modal renders the button with its own live hooks
        );
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const sorted = [...airports].sort((a, b) => airportSortOrder(a.icao) - airportSortOrder(b.icao));
      const allInfos = {};
      for (const airport of sorted) {
        const infos = await electronAPI.getAirportFilesInfo(airport.icao, rootPath);
        if (isDemo) {
          // Demo mode: only show .demo.acl files
          allInfos[airport.icao] = infos.filter(info => info.isDemo);
        } else {
          // Normal mode: show production levels + .demo.acl slices; hide tutorial/test/endless/dev/bench/crossrunway/.Prod
          const visible = infos.filter(info => {
            // Always show .demo.acl files
            if (info.isDemo) return true;
            // Show production levels; hide tutorial/test/endless/dev/bench/crossrunway/.Prod variants
            if (info.error) return false;
            return !RE_HIDDEN.test(info.filename.toLowerCase());
          });
          allInfos[airport.icao] = visible.sort((a, b) =>
            (a.startTime || '99:99').localeCompare(b.startTime || '99:99')
          );
        }
      }
      if (!cancelled) { setFileInfos(allInfos); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [airports, rootPath, refreshKey, isDemo]);

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
      const result = await electronAPI.refreshRootScan(rootPath);
      if (result && result.airports) {
        useAppStore.getState().setRootPath(rootPath, result.airports);
      }
      setRefreshKey(k => k + 1);
      return result;
    } catch (_) {
      return null;
    } finally {
      setRefreshing(false);
    }
  };

  const handleVersionMismatchRescan = async () => {
    const { hideModal, showToast } = useAppStore.getState();
    hideModal();
    const result = await doRefreshScan();
    if (!result || !result.success) {
      showToast(t('toast_scan_failed'), 'error');
    }
  };

  const handleRefreshScan = () => {
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      t => t('browser_rescan_guide_title'),
      t => rescanGuideContent(t),
      t => <div className="modal-actions-row">
        <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
        <button className="btn-confirm" onClick={() => { hideModal(); doRefreshScan(); }}>{t('browser_btn_continue')}</button>
      </div>
    );
  };

  const allAirportsWithFiles = [...airports]
    .sort((a, b) => airportSortOrder(a.icao) - airportSortOrder(b.icao))
    .filter(a => (fileInfos[a.icao] || []).length > 0);

  const totalFileCount = Object.values(fileInfos).flat().length;

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
          <button className="btn-sm btn-bug-report" onClick={handleBugReport} title={t('browser_bug_report')}>
            <IoBugOutline size={14} className="btn-icon" />{t('browser_bug_report')}
          </button>
          <button className="btn-lang-toggle-top" onClick={toggleLang}><IoLanguage size={14} className="btn-icon" /> {t('lang_switch_to')}</button>
          <button className="btn-lang-toggle-top btn-icon-only" onClick={toggleTheme}>
            {theme === 'dark' ? <IoSunnyOutline size={14} /> : <IoMoonOutline size={14} />}
          </button>
        </div>
      </header>

      <main className="browser-content">
        {loading ? (
          <div className="loading-state"><div className="spinner" /><p>{t('browser_loading')}</p></div>
        ) : totalFileCount === 0 ? (
          <div className="browser-empty">{t('browser_no_files')}</div>
        ) : (
          allAirportsWithFiles.map(airport => (
            <div key={airport.icao} className="airport-card" style={{ '--card-bg': `url(./${airport.icao}.png)` }}>
              <div className="airport-card-header"><span className="airport-icao">{airportDisplayName(airport.icao, t)}</span></div>
              {fileInfos[airport.icao].map((info, i) => {
                if (info.error) return (
                  <div key={i} className="level-row level-row-error">
                    <span className="level-tod"></span>
                    <span className="level-timerange"></span>
                    <span className="level-name">{info.filename}</span>
                    <span className="level-stats level-error-text">{info.error}</span>
                    <span className="level-arrow"><IoChevronForward size={14} /></span>
                  </div>
                );
                const displayName = stripSuffixes(info.filename);
                const todInfo = computeTodLabel(info.startTime, t);
                const timeRange = info.startTime && info.endTime ? toHHMM(info.startTime) + '-' + toHHMM(info.endTime) : '';
                return (
                  <div key={i} className="level-row" onClick={() => handleOpenFile(info.path, airport.icao)}>
                    <span className="level-tod">{todInfo.label}</span>
                    <span className="level-timerange">{timeRange}</span>
                    <span className="level-name">{displayName}</span>
                    <span className="level-stats">
                      <span className="level-stat"><span className="level-stat-dot arrival" />{t('table_arrivals')} {info.arrivals || 0}</span>
                      <span className="level-stat"><span className="level-stat-dot departure" />{t('table_departures')} {info.departures || 0}</span>
                    </span>
                    <span className="level-arrow"><IoChevronForward size={14} /></span>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </main>

      {appVersion && <div className="browser-version">v{appVersion}</div>}
    </div>
  );
}
