import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import './BrowserScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { airportDisplayName, airportSortOrder } from '../../utils/constants';
import { IoClose, IoChevronForward, IoLanguage, IoFolderOpenOutline, IoBugOutline, IoHelpCircleOutline, IoVideocamOutline, IoCodeSlash, IoChevronDown } from 'react-icons/io5';
import { AiFillSkin } from 'react-icons/ai';
import { MdOutlineRestore } from 'react-icons/md';
import { FaGear } from 'react-icons/fa6';
import { GiRadarSweep } from "react-icons/gi";
import { TbMapRoute } from "react-icons/tb";
import { FaTableList } from "react-icons/fa6";
import { IoSunnyOutline, IoMoonOutline } from 'react-icons/io5';
import { stripSuffixes } from '../../utils/htmlUtils';
import { DEMO_VISIBLE_BASES, DEMO_VISIBLE_ORDER, PROD_VISIBLE_BASES } from '../../utils/constants';
import { STEAM_DEMO_DIR_NAME } from '../../utils/constants/steam';

import AirportCardMap from './AirportCardMap';
import BrowserHelpOverlay, { BUTTONS, BROWSER_RADAR_TOGGLES_ENABLED } from './BrowserHelpOverlay';
import VideoReplaceOverlay from './VideoReplaceOverlay';
import VideoBackgroundModal from './VideoBackgroundModal';
import BepInExInstallOverlay from './BepInExInstallOverlay';
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

// Fallback geometry for the auto-collapse fit pass. Real values are measured
// from the DOM once the cards are laid out (see the layout effect below);
// these only kick in before the first measurement (e.g. jsdom, hidden window).
const CARD_GAP = 20;        // .airport-card margin-bottom
const FALLBACK_HEADER_H = 48;
const FALLBACK_ROW_H = 37;

function sameCollapseMap(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => a[k] === b[k]);
}

export default function BrowserScreen() {
  const { t, toggleLang, lang } = useTranslation();
  const electronAPI = useElectronAPI();
  const rootPath = useAppStore(s => s.rootPath);
  const airports = useAppStore(s => s.airports);
  const setScreen = useAppStore(s => s.setScreen);
  const theme = useAppStore(s => s.theme);
  const toggleTheme = useAppStore(s => s.toggleTheme);
  const isDemo = rootPath && rootPath.includes(STEAM_DEMO_DIR_NAME);
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
  const browserAutoCollapseDone = useAppStore(s => s.browserAutoCollapseDone);
  const markBrowserAutoCollapseDone = useAppStore(s => s.markBrowserAutoCollapseDone);
  // Collapse state lives in the store so the user's choices survive leaving
  // the browser for a level and coming back.
  const collapsedAirports = useAppStore(s => s.browserCollapsedAirports);
  const autoCollapsed = useAppStore(s => s.browserAutoCollapsed);
  const setBrowserCollapsedAirport = useAppStore(s => s.setBrowserCollapsedAirport);
  const setBrowserAutoCollapsed = useAppStore(s => s.setBrowserAutoCollapsed);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [appVersion, setAppVersion] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [videoReplace, setVideoReplace] = useState({ open: false, sourcePath: '' });
  const [showBackgroundModal, setShowBackgroundModal] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [bepInExLoading, setBepInExLoading] = useState(false);
  const [bepInExInstallOpen, setBepInExInstallOpen] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(null);
  const contentRef = useRef(null);
  const measuredRef = useRef({});
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

  // Settings dropdown: floating menu that auto-closes when clicking
  // anywhere outside of it, or on Escape.
  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) setSettingsOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [settingsOpen]);

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

  const handleConfirmRestoreAll = async () => {
    if (restoreLoading) return;
    setRestoreLoading(true);
    try {
      const result = await electronAPI.resetAllLevels();
      if (result.success) {
        // Clear browser cache so the UI immediately shows empty state;
        // the next scan (triggered by refreshKey) will confirm 0 files.
        setBrowserCache({}, {});
        setRefreshKey(k => k + 1);
        const { showModal, hideModal } = useAppStore.getState();
        showModal(
          () => t('restore_all_success_title'),
          () => <p>{t('restore_all_success_detail', { count: result.deletedCount, airports: result.airports })}</p>,
          () => <button className="btn-confirm" onClick={() => { hideModal(); electronAPI.quitApp(); }}>{t('modal_btn_ok')}</button>
        );
      } else {
        const msg = result.error === 'NO_GAME_ROOT' ? t('restore_all_no_game_root') : (result.error || t('restore_all_failed'));
        useAppStore.getState().showToast(msg, 'error');
      }
    } catch (err) {
      useAppStore.getState().showToast(err.message, 'error');
    } finally {
      setRestoreLoading(false);
    }
  };

  const handleRestoreAllClick = () => {
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t('restore_all_title'),
      () => (
        <>
          <p style={{ color: 'var(--red)', fontWeight: 600 }}>{t('restore_all_warning')}</p>
          <p style={{ marginTop: 8 }}>{t('restore_all_warning_detail')}</p>
        </>
      ),
      () => (
        <>
          <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
          <button className="btn-danger" onClick={async () => { hideModal(); await handleConfirmRestoreAll(); }}>{t('restore_all_confirm')}</button>
        </>
      )
    );
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

  const isAirportCollapsed = (icao) =>
    icao in collapsedAirports ? collapsedAirports[icao] : !!autoCollapsed[icao];

  const toggleAirportCollapse = (icao) => {
    setBrowserCollapsedAirport(icao, !isAirportCollapsed(icao));
  };

  // Auto-collapse: measure the real card geometry, then collapse trailing
  // airports (last first) until every airport fits the visible content box.
  // Runs exactly once per app session (the first time the level list loads);
  // afterwards it is inert, so navigation, resizing, or user toggles are
  // never overridden.
  useLayoutEffect(() => {
    if (browserAutoCollapseDone) return;
    const el = contentRef.current;
    if (!el || loading) return;

    const cards = el.querySelectorAll('.airport-card');
    cards.forEach(card => {
      const icao = card.getAttribute('data-icao');
      if (!icao) return;
      const headerEl = card.querySelector('.airport-card-header');
      const header = headerEl ? headerEl.offsetHeight : 0;
      const rows = card.querySelectorAll('.level-row').length;
      const expanded = card.getAttribute('data-expanded') === 'true';
      if (header <= 0 && card.offsetHeight <= 0) return;
      const entry = measuredRef.current[icao] || {};
      if (header > 0) entry.collapsed = header;
      if (expanded) entry.expanded = card.offsetHeight;
      entry.rows = rows;
      measuredRef.current[icao] = entry;
    });

    const cs = window.getComputedStyle(el);
    const padY = parseFloat(cs.paddingTop || 0) + parseFloat(cs.paddingBottom || 0);
    const avail = el.clientHeight - padY;
    if (!(avail > 0)) return; // not laid out yet (jsdom / hidden window)

    const list = [...airports]
      .sort((a, b) => airportSortOrder(a.icao) - airportSortOrder(b.icao))
      .filter(a => (fileInfos[a.icao] || []).length > 0);
    if (list.length === 0) {
      markBrowserAutoCollapseDone();
      if (Object.keys(autoCollapsed).length) setBrowserAutoCollapsed({});
      return;
    }

    let total = 0;
    const entries = list.map(a => {
      const m = measuredRef.current[a.icao] || {};
      const rows = m.rows ?? (fileInfos[a.icao] || []).filter(i => !i.error).length;
      // m.collapsed is the header's own height; add the card's 2px borders.
      const collapsed = m.collapsed ? m.collapsed + 2 : FALLBACK_HEADER_H;
      const expanded = m.expanded || (collapsed + rows * FALLBACK_ROW_H);
      const pref = (a.icao in collapsedAirports) ? collapsedAirports[a.icao] : null;
      total += CARD_GAP + (pref === null ? expanded : (pref ? collapsed : expanded));
      return { icao: a.icao, expanded, collapsed, pref };
    });

    const next = {};
    for (let i = entries.length - 1; i >= 0 && total > avail; i--) {
      const e = entries[i];
      if (e.pref !== null) continue; // user-controlled — respect their choice
      next[e.icao] = true;
      total -= (e.expanded - e.collapsed);
    }

    markBrowserAutoCollapseDone();
    if (!sameCollapseMap(autoCollapsed, next)) setBrowserAutoCollapsed(next);
  }, [loading, airports, fileInfos, collapsedAirports, autoCollapsed, browserAutoCollapseDone, markBrowserAutoCollapseDone, setBrowserAutoCollapsed]);

  return (
    <div id="screen-browser" className="screen" style={{ '--tod-width': lang === 'zh' ? '80px' : '180px' }}>
      <header className="browser-header">
        <div className="browser-title"><span>{t('browser_title')}</span></div>
        <div className="browser-actions">
          <button className="btn-sm btn-livery" {...bind(t('browser_livery_desc'))} onClick={() => setScreen('livery')}>
            <AiFillSkin size={14} className="btn-icon" />{t('browser_livery')}
          </button>
          <button className="btn-sm" {...bind(t('browser_restore_all_desc'))} onClick={handleRestoreAllClick} disabled={restoreLoading}>
            <MdOutlineRestore size={14} className="btn-icon" />{t('browser_restore_all')}
          </button>
          <div className="browser-settings-wrap" ref={settingsRef}>
            <button className="btn-sm" onClick={() => setSettingsOpen(o => !o)} aria-expanded={settingsOpen} aria-haspopup="menu">
              <FaGear size={14} className="btn-icon" />{t('browser_settings')}
            </button>
            {settingsOpen && (
              <div className="browser-settings-menu" role="menu">
                {/* Instant portal tooltip (no native-title delay); rootPath is the
                    already-cached store value, so nothing is fetched on hover. */}
                <button role="menuitem" {...bind(t('browser_change_dir_hint', { path: rootPath || '' }))} onClick={() => { setSettingsOpen(false); setScreen('setup'); }}>
                  <IoFolderOpenOutline size={14} className="btn-icon" />{t('browser_change_dir')}
                </button>
                <button role="menuitem" {...bind(t('browser_replace_bg_desc'))} onClick={() => { setSettingsOpen(false); handleReplaceBackground(); }}>
                  <IoVideocamOutline size={14} className="btn-icon" />{t('browser_replace_background')}
                </button>
                <button role="menuitem" {...bind(t(BUTTONS.bugReport.descKey))} onClick={() => { setSettingsOpen(false); handleBugReport(); }}>
                  <IoBugOutline size={14} className="btn-icon" />{t('browser_bug_report')}
                </button>
                {/* Label shows the *other* language's name: 中文 in en mode, English in zh mode */}
                <button role="menuitem" {...bind(t(BUTTONS.lang.descKey))} onClick={() => { setSettingsOpen(false); toggleLang(); }}>
                  <IoLanguage size={14} className="btn-icon" />{lang === 'zh' ? 'English' : '中文'}
                </button>
                <button role="menuitem" {...bind(t(BUTTONS.themeDark.descKey))} onClick={() => { setSettingsOpen(false); toggleTheme(); }}>
                  {theme === 'dark' ? <IoSunnyOutline size={14} className="btn-icon" /> : <IoMoonOutline size={14} className="btn-icon" />}{t(theme === 'dark' ? 'browser_light_mode' : 'browser_dark_mode')}
                </button>
                {/* Debug stays open on toggle so its active/loading state remains visible */}
                <button role="menuitem" className={debugMode ? 'active' : ''} {...bind(t('browser_debug_mode_desc'))} onClick={handleToggleDebugMode} disabled={bepInExLoading}>
                  <IoCodeSlash size={14} className="btn-icon" />{t('browser_debug_mode')}
                </button>
              </div>
            )}
          </div>
          <button className="btn-lang-toggle-top btn-icon-only" {...bind(t('browser_help_help_btn'))} onClick={() => setHelpOpen(true)}>
            <IoHelpCircleOutline size={14} />
          </button>
        </div>
      </header>

      <main className="browser-content" ref={contentRef}>
        {loading ? null : totalFileCount === 0 ? (
          <div className="browser-empty">{t('browser_no_files')}</div>
        ) : (
          allAirportsWithFiles.map(airport => {
            const collapsed = isAirportCollapsed(airport.icao);
            const geom = geomCache[airport.icao];
            const nRows = (fileInfos[airport.icao] || []).length;
            return (
              <div
                key={airport.icao}
                className={'airport-card' + (collapsed ? ' collapsed' : '')}
                data-icao={airport.icao}
                data-expanded={collapsed ? 'false' : 'true'}
              >
                {geom ? (
                  <AirportCardMap
                    areaData={geom.areaData}
                    taxiwayPaths={geom.taxiwayPaths}
                    runwayData={geom.runwayData}
                    numRows={collapsed ? 0 : nRows}
                  />
                ) : (
                  <AirportCardMap numRows={collapsed ? 0 : nRows} />
                )}
                <div
                  className="airport-card-header"
                  role="button"
                  tabIndex={0}
                  aria-expanded={!collapsed}
                  title={t(collapsed ? 'browser_airport_expand' : 'browser_airport_collapse')}
                  onClick={() => toggleAirportCollapse(airport.icao)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAirportCollapse(airport.icao); }
                  }}
                >
                  <span className="airport-header-left">
                    <span className={'airport-collapse-toggle' + (collapsed ? '' : ' open')}>
                      {collapsed ? <IoChevronForward size={15} /> : <IoChevronDown size={15} />}
                    </span>
                    <span className="airport-icao">{airportDisplayName(airport.icao, t)}</span>
                  </span>
                  <div className="airport-card-actions">
                    {BROWSER_RADAR_TOGGLES_ENABLED && !isDemo && (
                    <>
                    <button
                      className={'btn-radar-toggle' + (openGroundRadarAirports.has(airport.icao) ? ' active' : '')}
                      {...bind(t(BUTTONS.surfaceRadar.descKey))}
                      onClick={(e) => { e.stopPropagation(); handleToggleSurfaceRadar(airport.icao); }}
                    >
                      <TbMapRoute size={13} /> {t('toolbar_surface_radar')}
                    </button>
                    <button
                      className={'btn-radar-toggle' + (openAirRadarAirports.has(airport.icao) ? ' active' : '')}
                      {...bind(t(BUTTONS.approachRadar.descKey))}
                      onClick={(e) => { e.stopPropagation(); handleToggleApproachRadar(airport.icao); }}
                    >
                      <GiRadarSweep size={13} /> {t('toolbar_approach_radar')}
                    </button>
                    <button
                      className={'btn-radar-toggle' + (openFlightStripAirports.has(airport.icao) ? ' active' : '')}
                      {...bind(t(BUTTONS.flightStrips.descKey))}
                      onClick={(e) => { e.stopPropagation(); handleToggleFlightStrips(airport.icao); }}
                    >
                      <FaTableList size={13} /> {t('toolbar_flight_strips')}
                    </button>
                    </>
                    )}
                  </div>
                </div>
                {!collapsed && fileInfos[airport.icao].map((info, i) => {
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
            );
          })
        )}
      </main>

      {loading && (
        <div className="browser-scan-overlay">
          <div className="loading-state browser-scan-notice"><div className="spinner" /><p>{t('browser_loading')}</p></div>
        </div>
      )}

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
      {TooltipPortal}
    </div>
  );
}
