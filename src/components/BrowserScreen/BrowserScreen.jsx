import React, { useState, useEffect } from 'react';
import './BrowserScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { airportDisplayName, airportSortOrder } from '../../utils/constants';
import { IoClose, IoChevronForward, IoLanguage, IoFolderOpenOutline, IoBugOutline, IoRefreshOutline, IoMapOutline, IoNavigateOutline, IoListOutline, IoHelpCircleOutline, IoVideocamOutline, IoCodeSlash, IoColorPaletteOutline } from 'react-icons/io5';
import { IoSunnyOutline, IoMoonOutline } from 'react-icons/io5';
import { stripSuffixes } from '../../utils/htmlUtils';
import { safeHtml } from '../../utils/safeHtml';
import { RE_HIDDEN, DEMO_VISIBLE_BASES } from '../../utils/constants';
import CacheProgressBody from '../common/CacheProgressBody';
import AirportCardMap from './AirportCardMap';
import BrowserHelpOverlay, { BUTTONS } from './BrowserHelpOverlay';
import VideoReplaceOverlay from './VideoReplaceOverlay';
import VideoBackgroundModal from './VideoBackgroundModal';
import BepInExInstallOverlay from './BepInExInstallOverlay';
import LiveryInstallOverlay from './LiveryInstallOverlay';
import useTooltip from './useTooltip';

function rescanGuideContent(t) {
  return (
    <div>
      <p>{t('browser_rescan_guide_body')}</p>
      <ol>
        <li>{t('browser_rescan_guide_step1')} <code className="guide-path">{t('browser_rescan_guide_step1_path')}</code></li>
        <li>{safeHtml(t('browser_rescan_guide_step2'))}</li>
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
  const openGroundRadarAirports = useAppStore(s => s.openGroundRadarAirports);
  const openAirRadarAirports = useAppStore(s => s.openAirRadarAirports);
  const setGroundRadarOpen = useAppStore(s => s.setGroundRadarOpen);
  const setAirRadarOpen = useAppStore(s => s.setAirRadarOpen);
  const openFlightStripAirports = useAppStore(s => s.openFlightStripAirports);
  const setFlightStripOpen = useAppStore(s => s.setFlightStripOpen);

  const [fileInfos, setFileInfos] = useState({});
  const [geomCache, setGeomCache] = useState({}); // { [icao]: { areaData, taxiwayPaths, runwayData } | null }
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [appVersion, setAppVersion] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [videoReplace, setVideoReplace] = useState({ open: false, sourcePath: '' });
  const [showBackgroundModal, setShowBackgroundModal] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [bepInExLoading, setBepInExLoading] = useState(false);
  const [bepInExInstallOpen, setBepInExInstallOpen] = useState(false);
  const [liveryLoading, setLiveryLoading] = useState(false);
  const [liveryOverlayOpen, setLiveryOverlayOpen] = useState(false);
  const { bind, TooltipPortal } = useTooltip();

  useEffect(() => {
    electronAPI.getAppVersion().then(v => setAppVersion(v)).catch(() => {});
  }, []);

  useEffect(() => {
    electronAPI.checkBepInEx().then(result => {
      setDebugMode(result.installed);
    }).catch(() => {});
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

  // Listen for mid-session cache invalidation (e.g., cache.json deleted while app is open)
  useEffect(() => {
    if (!electronAPI.onCacheInvalidated) return;
    electronAPI.onCacheInvalidated(() => {
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
        true   // showLangToggle
      );
    });
  }, []);

  // Listen for radar windows closed via X button (main process notifies us)
  useEffect(() => {
    if (!electronAPI.onRadarWindowClosed) return;
    electronAPI.onRadarWindowClosed(({ icao, type }) => {
      if (type === 'ground') setGroundRadarOpen(icao, false);
      else if (type === 'air') setAirRadarOpen(icao, false);
      else if (type === 'flightStrips') setFlightStripOpen(icao, false);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const sorted = [...airports].sort((a, b) => airportSortOrder(a.icao) - airportSortOrder(b.icao));
      const allInfos = {};
      const allGeom = {};
      for (const airport of sorted) {
        const infos = await electronAPI.getAirportFilesInfo(airport.icao, rootPath);
        if (isDemo) {
          // Demo mode: show .demo.acl files + _emerg.acl files (whitelist)
          // Non-demo .acl files are hidden unless they are _emerg files
          allInfos[airport.icao] = infos.filter(info => {
            // Hide levels that failed to parse (e.g. Git LFS stubs)
            if (info.error) return false;
            return DEMO_VISIBLE_BASES.has(info.filename);
          });
        } else {
          // Normal mode: show production levels + .demo.acl slices; hide tutorial/test/endless/dev/bench/crossrunway/.Prod
          const visible = infos.filter(info => {
            // Hide levels that failed to parse (e.g. Git LFS stubs)
            if (info.error) return false;
            // Show .demo.acl files
            if (info.isDemo) return true;
            // Show production levels; hide tutorial/test/endless/dev/bench/crossrunway/.Prod variants
            return !RE_HIDDEN.test(info.filename);
          });
          allInfos[airport.icao] = visible.sort((a, b) =>
            (a.startTime || '99:99').localeCompare(b.startTime || '99:99')
          );
        }

        // Fetch ground radar geometry for this airport's card background
        try {
          const vals = await electronAPI.collectValues(rootPath, airport.icao);
          allGeom[airport.icao] = vals ? {
            areaData: vals._areaData || {},
            taxiwayPaths: vals._taxiwayPaths?.paths || [],
            runwayData: vals._runwayData || {},
          } : null;
        } catch (_) {
          allGeom[airport.icao] = null;
        }
      }
      if (!cancelled) { setFileInfos(allInfos); setGeomCache(allGeom); setLoading(false); }
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

  const handleReplaceBackground = () => {
    setShowBackgroundModal(true);
  };

  const handleModalReplace = async () => {
    setShowBackgroundModal(false);
    const result = await electronAPI.selectVideoFile();
    if (result.canceled) return;
    setVideoReplace({ open: true, sourcePath: result.filePath });
  };

  const handleModalRestore = async () => {
    setShowBackgroundModal(false);
    try {
      const result = await electronAPI.restoreVideoBackup();
      if (result.success) {
        const { showToast } = useAppStore.getState();
        showToast(t('vbg_restore_success'), 'success');
      } else {
        const { showToast } = useAppStore.getState();
        showToast(result.error || t('vbg_restore_failed'), 'error');
      }
    } catch (err) {
      const { showToast } = useAppStore.getState();
      showToast(err.message, 'error');
    }
  };

  const handleToggleDebugMode = async () => {
    if (bepInExLoading) return;

    if (debugMode) {
      setBepInExLoading(true);
      try {
        const result = await electronAPI.uninstallBepInEx();
        if (result.success) {
          setDebugMode(false);
          const { showToast } = useAppStore.getState();
          showToast(t('bepinex_uninstalled'), 'success');
        } else {
          const { showToast } = useAppStore.getState();
          showToast(result.error || 'Uninstall failed', 'error');
        }
      } catch (err) {
        const { showToast } = useAppStore.getState();
        showToast(err.message, 'error');
      } finally {
        setBepInExLoading(false);
      }
    } else {
      setBepInExInstallOpen(true);
    }
  };

  const handleInstallLivery = () => {
    if (liveryLoading) return;
    setLiveryLoading(true);
    setLiveryOverlayOpen(true);
  };

  const handleLiveryDownloadComplete = async (downloadedPath) => {
    setLiveryOverlayOpen(false);
    try {
      const result = await electronAPI.installLivery(downloadedPath);
      const { showToast } = useAppStore.getState();
      if (result.success) {
        showToast(t('livery_installed'), 'success');
      } else {
        showToast(result.error === 'NO_GAME_ROOT' ? t('vr_no_game_root') : (result.error || t('livery_failed')), 'error');
      }
    } catch (err) {
      const { showToast } = useAppStore.getState();
      showToast(err.message, 'error');
    } finally {
      setLiveryLoading(false);
    }
  };

  const handleLiveryDownloadError = async () => {
    setLiveryOverlayOpen(false);
    setLiveryLoading(false);

    const dialogResult = await electronAPI.selectLiveryZip();
    if (dialogResult.canceled) return;

    setLiveryLoading(true);
    try {
      const result = await electronAPI.installLivery(dialogResult.filePath);
      const { showToast } = useAppStore.getState();
      if (result.success) {
        showToast(t('livery_installed'), 'success');
      } else {
        showToast(result.error === 'NO_GAME_ROOT' ? t('vr_no_game_root') : (result.error || t('livery_failed')), 'error');
      }
    } catch (err) {
      const { showToast } = useAppStore.getState();
      showToast(err.message, 'error');
    } finally {
      setLiveryLoading(false);
    }
  };

  const [refreshing, setRefreshing] = useState(false);

  const doRefreshScan = async () => {
    setRefreshing(true);
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      t => t('browser_scanning_title'),
      () => <CacheProgressBody />,
      null,
      false,
    );
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
      hideModal();
    }
  };

  const handleVersionMismatchRescan = async () => {
    const { showToast } = useAppStore.getState();
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

  const handleToggleSurfaceRadar = (icao) => {
    const st = useAppStore.getState();
    if (st.openGroundRadarAirports.has(icao)) {
      electronAPI.closeGroundMap(icao);
      setGroundRadarOpen(icao, false);
    } else {
      electronAPI.openGroundMap(icao, rootPath);
      setGroundRadarOpen(icao, true);
    }
  };

  const handleToggleApproachRadar = (icao) => {
    const st = useAppStore.getState();
    if (st.openAirRadarAirports.has(icao)) {
      electronAPI.closeAirMap(icao);
      setAirRadarOpen(icao, false);
    } else {
      electronAPI.openAirMap(icao, rootPath);
      setAirRadarOpen(icao, true);
    }
  };

  const handleToggleFlightStrips = (icao) => {
    const st = useAppStore.getState();
    if (st.openFlightStripAirports.has(icao)) {
      electronAPI.closeFlightStrips(icao);
      setFlightStripOpen(icao, false);
    } else {
      electronAPI.openFlightStrips(icao, rootPath);
      setFlightStripOpen(icao, true);
    }
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
          <button className="btn-sm" {...bind(t(BUTTONS.changeDir.descKey))} onClick={() => setScreen('setup')}><IoFolderOpenOutline size={14} className="btn-icon" />{t('browser_change_dir')}</button>
          <button className={`btn-sm ${refreshing ? 'btn-disabled' : ''}`} {...bind(t(BUTTONS.refresh.descKey))} onClick={handleRefreshScan} disabled={refreshing}>
            <IoRefreshOutline size={14} className="btn-icon" />{refreshing ? t('browser_refreshing') : t('browser_refresh_scan')}
          </button>
          <button className="btn-sm" {...bind(t('browser_livery_desc'))} onClick={handleInstallLivery} disabled={liveryLoading}>
            <IoColorPaletteOutline size={14} className="btn-icon" />{t('browser_livery')}
          </button>
          <button className={`btn-sm ${debugMode ? 'btn-debug-active' : ''}`} {...bind(t('browser_debug_mode_desc'))} onClick={handleToggleDebugMode} disabled={bepInExLoading}>
            <IoCodeSlash size={14} className="btn-icon" />{t('browser_debug_mode')}
          </button>
          <button className="btn-sm" {...bind(t('browser_replace_bg_desc'))} onClick={handleReplaceBackground}>
            <IoVideocamOutline size={14} className="btn-icon" />{t('browser_replace_background')}
          </button>
          <button className="btn-lang-toggle-top btn-icon-only" {...bind(t(BUTTONS.bugReport.descKey))} onClick={handleBugReport}>
            <IoBugOutline size={14} />
          </button>
          <button className="btn-lang-toggle-top btn-icon-only" {...bind(t(BUTTONS.lang.descKey))} onClick={toggleLang}>
            <IoLanguage size={14} />
          </button>
          <button className="btn-lang-toggle-top btn-icon-only" {...bind(t(BUTTONS.themeDark.descKey))} onClick={toggleTheme}>
            {theme === 'dark' ? <IoSunnyOutline size={14} /> : <IoMoonOutline size={14} />}
          </button>
          <button className="btn-lang-toggle-top btn-icon-only" {...bind(t('browser_help_help_btn'))} onClick={() => setHelpOpen(true)}>
            <IoHelpCircleOutline size={14} />
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
            <div key={airport.icao} className="airport-card">
              {(() => {
                const geom = geomCache[airport.icao];
                const nRows = (fileInfos[airport.icao] || []).length;
                return geom ? (
                  <AirportCardMap
                    areaData={geom.areaData}
                    taxiwayPaths={geom.taxiwayPaths}
                    runwayData={geom.runwayData}
                    numRows={nRows}
                  />
                ) : (
                  <AirportCardMap numRows={nRows} />
                );
              })()}
              <div className="airport-card-header">
                <span className="airport-icao">{airportDisplayName(airport.icao, t)}</span>
                <div className="airport-card-actions">
                  {!isDemo && (
                  <>
                  <button
                    className={'btn-radar-toggle' + (openGroundRadarAirports.has(airport.icao) ? ' active' : '')}
                    {...bind(t(BUTTONS.surfaceRadar.descKey))}
                    onClick={(e) => { e.stopPropagation(); handleToggleSurfaceRadar(airport.icao); }}
                  >
                    <IoMapOutline size={13} /> {t('toolbar_surface_radar')}
                  </button>
                  <button
                    className={'btn-radar-toggle' + (openAirRadarAirports.has(airport.icao) ? ' active' : '')}
                    {...bind(t(BUTTONS.approachRadar.descKey))}
                    onClick={(e) => { e.stopPropagation(); handleToggleApproachRadar(airport.icao); }}
                  >
                    <IoNavigateOutline size={13} /> {t('toolbar_approach_radar')}
                  </button>
                  <button
                    className={'btn-radar-toggle' + (openFlightStripAirports.has(airport.icao) ? ' active' : '')}
                    {...bind(t(BUTTONS.flightStrips.descKey))}
                    onClick={(e) => { e.stopPropagation(); handleToggleFlightStrips(airport.icao); }}
                  >
                    <IoListOutline size={13} /> {t('toolbar_flight_strips')}
                  </button>
                  </>
                  )}
                </div>
              </div>
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

      {helpOpen && <BrowserHelpOverlay onClose={() => setHelpOpen(false)} />}
      {showBackgroundModal && (
        <VideoBackgroundModal
          onClose={() => setShowBackgroundModal(false)}
          onReplace={handleModalReplace}
          onRestore={handleModalRestore}
        />
      )}
      {videoReplace.open && <VideoReplaceOverlay sourcePath={videoReplace.sourcePath} onClose={() => setVideoReplace({ open: false, sourcePath: '' })} />}
      {bepInExInstallOpen && (
        <BepInExInstallOverlay
          onClose={(success) => {
            setBepInExInstallOpen(false);
            if (success) {
              setDebugMode(true);
              const { showToast } = useAppStore.getState();
              showToast(t('bepinex_installed'), 'success');
            }
          }}
        />
      )}
      {liveryOverlayOpen && (
        <LiveryInstallOverlay
          onComplete={handleLiveryDownloadComplete}
          onError={handleLiveryDownloadError}
        />
      )}
      {TooltipPortal}
    </div>
  );
}
