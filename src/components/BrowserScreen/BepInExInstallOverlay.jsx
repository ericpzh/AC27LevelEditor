import React, { useEffect, useState } from 'react';
import './BepInExInstallOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { IoClose, IoAlertCircle } from 'react-icons/io5';

/**
 * Full-screen overlay shown while downloading and installing BepInEx.
 * Shows a single progress bar covering the entire pipeline
 * (download + extract + install), then auto-dismisses on completion.
 *
 * Props: { onClose: (success: boolean) => void }
 */
export default function BepInExInstallOverlay({ onClose }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();

  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState('bepinex_fetching');
  const [error, setError] = useState('');

  // Run the full install pipeline on mount
  useEffect(() => {
    let cancelled = false;
    let cleanup = null;

    async function run() {
      try {
        // Subscribe to progress events
        const onProgress = (data) => {
          if (cancelled) return;
          if (data.percent != null) setPercent(data.percent);
          if (data.message) setMessage(data.message);
        };
        electronAPI.onBepInExInstallProgress(onProgress);
        cleanup = () => electronAPI.offBepInExInstallProgress(onProgress);

        console.log('[BepInEx] starting install...');
        const result = await electronAPI.installBepInEx();
        console.log('[BepInEx] install result:', JSON.stringify(result));

        if (cancelled) return;

        if (result.success) {
          onClose(true);
        } else {
          setError(result.error || 'Unknown error');
        }
      } catch (err) {
        console.error('[BepInEx] install error:', err);
        if (!cancelled) setError(err.message);
      }
    }

    run();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key closes (only during error)
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && error) {
        e.preventDefault();
        onClose(false);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [error, onClose]);

  const handleOverlayClick = (e) => {
    if (e.target.id === 'bepinex-overlay' && error) {
      onClose(false);
    }
  };

  const isError = !!error;

  return (
    <div id="bepinex-overlay" onClick={handleOverlayClick}>
      <div id="bepinex-box" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div id="bepinex-header">
          <h2>{t(isError ? 'bepinex_error_fetch' : 'browser_debug_mode')}</h2>
          {isError && (
            <button onClick={() => onClose(false)} title={t('browser_help_close')}>
              <IoClose size={18} />
            </button>
          )}
        </div>

        {/* Body */}
        <div id="bepinex-body">
          {!isError && (
            <div className="bepinex-section">
              <div className="bepinex-progress-wrap">
                <div className="bepinex-progress-bar" style={{ width: percent + '%' }} />
              </div>
              <p className="bepinex-pct">{percent}%</p>
              <p className="bepinex-status">{t(message)}</p>
            </div>
          )}

          {isError && (
            <div className="bepinex-section bepinex-error-box">
              <IoAlertCircle size={48} className="bepinex-error-icon" />
              <p className="bepinex-error-msg">
                {error === 'NO_GAME_ROOT' ? t('bepinex_error_game_root') : error}
              </p>
              <button className="btn-sm" onClick={() => onClose(false)}>{t('browser_help_close')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
