import React, { useState, useEffect } from 'react';
import { IoLanguage, IoFolderOpenOutline, IoCheckmarkCircleOutline } from 'react-icons/io5';
import './SetupScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import CacheProgressBody from '../common/CacheProgressBody';
import { safeHtml } from '../../utils/safeHtml';
import { STEAM_GAME_DIR_NAME, STEAM_DEMO_DIR_NAME } from '../../utils/constants/steam';

export default function SetupScreen() {
  const { t, toggleLang } = useTranslation();
  const electronAPI = useElectronAPI();
  const setScreen = useAppStore(s => s.setScreen);
  const setRootPath = useAppStore(s => s.setRootPath);
  const setCacheBuildProgress = useAppStore(s => s.setCacheBuildProgress);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detected, setDetected] = useState(null);
  const [workshop, setWorkshop] = useState(false);
  const [platform, setPlatform] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let isWorkshop = false;
      try {
        isWorkshop = (await electronAPI.isWorkshopBuild()) === true;
      } catch (err) { console.error(err); }
      if (cancelled) return;
      setWorkshop(isWorkshop);
      try {
        const info = await electronAPI.getSystemInfo();
        if (!cancelled) setPlatform((info && info.platform) || null);
      } catch (err) { /* non-fatal — hint falls back to the Windows example */ }
      // Auto-detection is Steam/Workshop-only — the normal build never runs a
      // search; the user selects the game folder manually.
      if (!isWorkshop) return;
      try {
        const res = await electronAPI.detectGameRoot();
        if (!cancelled && res && res.found) setDetected(res);
      } catch (err) { console.error(err); }
    })();
    return () => { cancelled = true; };
  }, [electronAPI]);

  const proceedWithRoot = async (rootPath, airports) => {
    setRootPath(rootPath, airports || []);
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      t => t('browser_scanning_title'),
      () => <CacheProgressBody />,
      null,
      false,
    );
    try {
      await electronAPI.initAirportCache(rootPath);
    } catch (err) { console.error(err); }
    hideModal();
    setScreen('browser');
  };

  const handleUseDetected = async () => {
    if (!detected) return;
    setLoading(true); setError(null);
    try {
      await proceedWithRoot(detected.rootPath, detected.airports);
    } catch (err) { setError(err.message); useAppStore.getState().hideModal(); }
    setLoading(false);
  };

  const handleSelectRoot = async () => {
    setLoading(true); setError(null);
    try {
      const result = await electronAPI.selectGameRoot();
      if (result.canceled) { setLoading(false); return; }
      if (result.errorCode) { setError(t(result.errorCode, { path: result.errorPath })); setLoading(false); return; }
      await proceedWithRoot(result.rootPath, result.airports);
    } catch (err) { setError(err.message); useAppStore.getState().hideModal(); }
    setLoading(false);
  };

  // Steam install-path example for the current OS. macOS/Linux use a single
  // canonical path; Windows keeps the historical C:/D: pair (the `or` label).
  const steamPathHint = platform === 'darwin'
    ? <code>{`~/Library/Application Support/Steam/steamapps/common/${STEAM_GAME_DIR_NAME}`}</code>
    : platform === 'linux'
      ? <code>{`~/.steam/steam/steamapps/common/${STEAM_GAME_DIR_NAME}`}</code>
      : <><code>{`C:\\Program Files (x86)\\Steam\\steamapps\\common\\${STEAM_GAME_DIR_NAME}`}</code> {t('setup_steam_path_or')} <code>{`D:\\SteamLibrary\\steamapps\\common\\${STEAM_DEMO_DIR_NAME}`}</code></>;

  const steamHint = (
    <div className="steam-hint">
      <div className="steam-hint-title">{t('setup_steam_title')}</div>
      <ol>
        <li>{safeHtml(t('setup_steam_step1'))}</li>
        <li>{safeHtml(t('setup_steam_step2'))}</li>
        <li>{t('setup_steam_step3')}</li>
      </ol>
      <p className="steam-path-hint"><span>{t('setup_steam_path_label')}</span>{steamPathHint}</p>
    </div>
  );

  const useDetectedButton = (
    <button className="btn-big setup-detected-btn" onClick={handleUseDetected} disabled={loading}>
      {loading ? '...' : <><IoCheckmarkCircleOutline size={16} className="btn-icon" />{t('setup_detected_confirm')}</>}
    </button>
  );

  const renderSelectRootButton = (className) => (
    <button className={className} onClick={handleSelectRoot} disabled={loading}>
      {loading ? '...' : <><IoFolderOpenOutline size={16} className="btn-icon" />{t('setup_select_root')}</>}
    </button>
  );

  const selectRootButton = renderSelectRootButton('btn-big');
  // Side-by-side with "Use this folder", the manual picker is the fallback —
  // render it as a secondary/ghost button so the detected folder stays primary.
  const selectRootButtonSecondary = renderSelectRootButton('btn-big setup-detected-secondary');

  return (
    <div id="screen-setup" className="screen">
      <div className="setup-card">
        <h1>{t('setup_title')}</h1>
        <button className="btn-lang-toggle-top" onClick={toggleLang}><IoLanguage size={14} className="btn-icon" /> {t('lang_switch_to')}</button>
        {workshop ? (
          <>
            {detected && (
              <div className="setup-detected">
                <div className="setup-detected-title">{t('setup_detected_title_steam')}</div>
                <code className="setup-detected-path">{detected.rootPath}</code>
                <div className="setup-detected-actions">
                  {useDetectedButton}
                  {selectRootButtonSecondary}
                </div>
              </div>
            )}
            {steamHint}
            {!detected && selectRootButton}
          </>
        ) : (
          <>
            {steamHint}
            {selectRootButton}
          </>
        )}
        {error && <p className="setup-error">{error}</p>}
      </div>
    </div>
  );
}
