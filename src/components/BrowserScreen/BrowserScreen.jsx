import React, { useState, useEffect } from 'react';
import './BrowserScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { airportDisplayName, airportSortOrder } from '../../utils/constants';
import { IoClose, IoChevronForward, IoLanguage, IoFolderOpenOutline, IoBugOutline, IoMapOutline, IoNavigateOutline, IoListOutline, IoHelpCircleOutline, IoVideocamOutline, IoCodeSlash, IoColorPaletteOutline } from 'react-icons/io5';
import { IoSunnyOutline, IoMoonOutline } from 'react-icons/io5';
import { stripSuffixes } from '../../utils/htmlUtils';
import { DEMO_VISIBLE_BASES, DEMO_VISIBLE_ORDER, PROD_VISIBLE_BASES } from '../../utils/constants';

import AirportCardMap from './AirportCardMap';
import BrowserHelpOverlay, { BUTTONS } from './BrowserHelpOverlay';
import VideoReplaceOverlay from './VideoReplaceOverlay';
import VideoBackgroundModal from './VideoBackgroundModal';
import BepInExInstallOverlay from './BepInExInstallOverlay';
import LiveryInstallOverlay from './LiveryInstallOverlay';
import useTooltip from './useTooltip';

function sortLevelRows(a, b, isDemo) {
  // _emerg files always last; within each group use whitelist order
  if (a.isEmer !== b.isEmer) return a.isEmer ? 1 : -1;
  const order = isDemo ? DEMO_VISIBLE_ORDER : PROD_VISIBLE_BASES;
  const rankA = order.indexOf(a.filename) === -1 ? 9999 : order.indexOf(a.filename);
  const rankB = order.indexOf(b.filename) === -1 ? 9999 : order.indexOf(b.filename);
  if (rankA !== rankB) return rankA - rankB;
  return a.filename.localeCompare(b.filename);
}
function toHHMM(s) { return String(s).substring(0, 5); }

export default function BrowserScreen() {
  const { t, toggleLang, lang } = useTranslation();
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

  const fileInfos = useAppStore(s => s.fileInfos);
  const geomCache = useAppStore(s => s.geomCache);
  const browserDataLoaded = useAppStore(s => s.browserDataLoaded);
  const setBrowserCache = useAppStore(s => s.setBrowserCache);
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
      // Skip full scan if cache is already populated (e.g. returning from editor)
      if (browserDataLoaded && refreshKey === 0) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const sorted = [...airports].sort((a, b) => airportSortOrder(a.icao) - airportSortOrder(b.icao));
      const allInfos = {};
      const allGeom = {};
      for (const airport of sorted) {
        const infos = await electronAPI.getAirportFilesInfo(airport.icao, rootPath);
        if (isDemo) {
          // Demo mode: show only files in the demo whitelist
          allInfos[airport.icao] = infos.filter(info => DEMO_VISIBLE_BASES.has(info.filename)).sort((a, b) => sortLevelRows(a, b, isDemo));
        } else {
          // Normal mode: show only whitelisted production levels.
          // No .demo files are in PROD_VISIBLE_BASES, so the whitelist alone
          // suffices. info.isDemo is deliberately not checked — it flags files
          // in DEMO_VISIBLE_BASES (30-min demo window), and some of those are
          // regular .acl files that also appear in PROD_VISIBLE_BASES.
          // Levels that failed to parse (e.g. "No WorldState flight data", or
          // Git LFS stubs) are intentionally KEPT so the airport header and its
          // radar-window toggles remain available for that airport.
          const visible = infos.filter(filter => PROD_VISIBLE_BASES.includes(filter.filename));
          allInfos[airport.icao] = visible.sort((a, b) => sortLevelRows(a, b, isDemo));
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
      if (!cancelled) { setBrowserCache(allInfos, allGeom); setLoading(false); }
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
    <div id="screen-browser" className="screen" style={{ '--tod-width': lang === 'zh' ? '80px' : '130px' }}>
      <header className="browser-header">
        <div className="browser-title"><span>{t('browser_title')}</span></div>
        <div className="browser-actions">
          <span className="browser-root-path">{rootPath || ''}</span>
          <button className="btn-sm" {...bind(t(BUTTONS.changeDir.descKey))} onClick={() => setScreen('setup')}><IoFolderOpenOutline size={14} className="btn-icon" />{t('browser_change_dir')}</button>
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
                // Levels that can't be opened (e.g. "No WorldState flight data") render
                // no row at all — the airport header + radar toggles stay visible.
                if (info.error) return null;
                // Display name replaces the old time-of-day label as the
                // large leading element of the row. Comes from i18n
                // (level_name_<base>); t() falls back to the key itself
                // if a file has no translation entry.
                const displayName = t('level_name_' + info.filename.replace(/\.acl$/i, ''));
                const fileName = stripSuffixes(info.filename);
                const timeRange = info.startTime && info.endTime ? toHHMM(info.startTime) + '-' + toHHMM(info.endTime) : '';
                return (
                  <div key={i} className="level-row" onClick={() => handleOpenFile(info.path, airport.icao)}>
                    <span className="level-tod">{displayName}</span>
                    <span className="level-timerange">{timeRange}</span>
                    <span className="level-name">{fileName}</span>
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
