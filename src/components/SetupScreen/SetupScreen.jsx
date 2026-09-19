import React, { useState, useEffect } from 'react';
import { IoLanguage, IoFolderOpenOutline, IoCheckmarkCircleOutline } from 'react-icons/io5';
import './SetupScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import CacheProgressBody from '../common/CacheProgressBody';
import { safeHtml } from '../../utils/safeHtml';

export default function SetupScreen() {
  const { t, toggleLang } = useTranslation();
  const electronAPI = useElectronAPI();
  const setScreen = useAppStore(s => s.setScreen);
  const setRootPath = useAppStore(s => s.setRootPath);
  const setCacheBuildProgress = useAppStore(s => s.setCacheBuildProgress);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detected, setDetected] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
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

  return (
    <div id="screen-setup" className="screen">
      <div className="setup-card">
        <h1>{t('setup_title')}</h1>
        <p className="setup-sub">{t('setup_sub')}</p>
        <button className="btn-lang-toggle-top" onClick={toggleLang}><IoLanguage size={14} className="btn-icon" /> {t('lang_switch_to')}</button>
        <div className="steam-hint">
          <div className="steam-hint-title">{t('setup_steam_title')}</div>
          <ol>
            <li>{safeHtml(t('setup_steam_step1'))}</li>
            <li>{safeHtml(t('setup_steam_step2'))}</li>
            <li>{t('setup_steam_step3')}</li>
          </ol>
          <p className="steam-path-hint"><span>{t('setup_steam_path_label')}</span><code>C:\Program Files (x86)\Steam\steamapps\common\Airport Control 25 Playtest</code> {t('setup_steam_path_or')} <code>D:\SteamLibrary\steamapps\common\Airport Control 27 Demo</code></p>
        </div>
        {detected && (
          <div className="setup-detected">
            <div className="setup-detected-title">
              {t(detected.steam ? 'setup_detected_title_steam' : 'setup_detected_title')}
            </div>
            <code className="setup-detected-path">{detected.rootPath}</code>
            <button className="btn-big setup-detected-btn" onClick={handleUseDetected} disabled={loading}>
              {loading ? '...' : <><IoCheckmarkCircleOutline size={16} className="btn-icon" />{t('setup_detected_confirm')}</>}
            </button>
            <p className="setup-detected-hint">{t('setup_detected_hint')}</p>
          </div>
        )}
        <button className="btn-big" onClick={handleSelectRoot} disabled={loading}>
          {loading ? '...' : <><IoFolderOpenOutline size={16} className="btn-icon" />{t('setup_select_root')}</>}
        </button>
        {error && <p className="setup-error">{error}</p>}
      </div>
    </div>
  );
}
