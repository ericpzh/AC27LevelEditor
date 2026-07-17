import React, { useEffect, useState } from 'react';
import './UpdateOverlay.css';
import { useTranslation } from '../hooks/useTranslation';
import { useElectronAPI } from '../hooks/useElectronAPI';

/**
 * Full-screen overlay shown while downloading the update exe.
 * On success, calls onComplete with the download result { updateDir, currentExePath, newExePath }.
 * On failure, calls onError with the error message.
 *
 * Props: { onComplete: (result) => void, onError: (errorMsg: string) => void }
 */
export default function UpdateOverlay({ onComplete, onError }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();

  const [percent, setPercent] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let cleanup = null;

    async function run() {
      try {
        // Subscribe to progress events
        const onProgress = (data) => {
          if (cancelled) return;
          if (data.percent != null) setPercent(data.percent);
        };
        electronAPI.onUpdateDownloadProgress(onProgress);
        cleanup = () => electronAPI.offUpdateDownloadProgress(onProgress);

        const result = await electronAPI.downloadUpdate();

        if (cancelled) return;

        if (result.success) {
          onComplete(result);
        } else {
          onError(result.error || 'Download failed');
        }
      } catch (err) {
        console.error('[Update] download error:', err);
        if (!cancelled) onError(err.message);
      }
    }

    run();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div id="update-overlay">
      <div id="update-box">
        <div id="update-header">
          <h2>{t('update_title')}</h2>
        </div>

        <div id="update-body">
          <div className="update-section">
            <div className="update-progress-wrap">
              <div className="update-progress-bar" style={{ width: percent + '%' }} />
            </div>
            <p className="update-pct">{percent}%</p>
            <p className="update-status">{t('update_downloading')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
