import React, { useState } from 'react';
import './SetupScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';

export default function SetupScreen() {
  const { t, toggleLang } = useTranslation();
  const electronAPI = useElectronAPI();
  const setScreen = useAppStore(s => s.setScreen);
  const setRootPath = useAppStore(s => s.setRootPath);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSelectRoot = async () => {
    setLoading(true); setError(null);
    try {
      const result = await electronAPI.selectGameRoot();
      if (result.canceled) { setLoading(false); return; }
      if (result.error) { setError(result.error); setLoading(false); return; }
      setRootPath(result.rootPath, result.airports || []);
      try { electronAPI.saveLastRoot(result.rootPath); } catch (_) {}
      await electronAPI.initAirportCache(result.rootPath).catch(err => console.error(err));
      await electronAPI.captureDynamicsTemplates(result.rootPath).catch(err => console.error(err));
      setScreen('browser');
    } catch (err) { setError(err.message); }
    setLoading(false);
  };

  return (
    <div id="screen-setup" className="screen">
      <div className="setup-card">
        <h1>{t('setup_title')}</h1>
        <p className="setup-sub">{t('setup_sub')}</p>
        <button className="btn-lang-toggle-top" onClick={toggleLang}>{t('lang_switch_to')}</button>
        <div className="steam-hint">
          <div className="steam-hint-title">{t('setup_steam_title')}</div>
          <ol>
            <li dangerouslySetInnerHTML={{ __html: t('setup_steam_step1') }} />
            <li dangerouslySetInnerHTML={{ __html: t('setup_steam_step2') }} />
            <li>{t('setup_steam_step3')}</li>
          </ol>
          <p className="steam-path-hint"><span>{t('setup_steam_path_label')}</span><code>C:\Program Files (x86)\Steam\steamapps\common\Airport Control 27 Playtest</code></p>
        </div>
        <div className="setup-nightly-note">
          <span className="setup-nightly-icon">⚠️</span>
          <span dangerouslySetInnerHTML={{ __html: t('setup_nightly') }} />
        </div>
        <button className="btn-big" onClick={handleSelectRoot} disabled={loading}>
          {loading ? '...' : t('setup_select_root')}
        </button>
        {error && <p className="setup-error">{error}</p>}
      </div>
    </div>
  );
}
