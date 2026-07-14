import React, { useEffect, useState } from 'react';
import './LiveryInstallOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';

/**
 * Minimal full-screen overlay shown while downloading the livery zip.
 * On success, calls onComplete with the downloaded file path.
 * On failure, calls onError so the parent can fall back to a local file dialog.
 *
 * Props: { onComplete: (downloadedPath: string) => void, onError: () => void }
 */
export default function LiveryInstallOverlay({ onComplete, onError }) {
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
        electronAPI.onLiveryDownloadProgress(onProgress);
        cleanup = () => electronAPI.offLiveryDownloadProgress(onProgress);

        const result = await electronAPI.downloadLivery();

        if (cancelled) return;

        if (result.success) {
          onComplete(result.filePath);
        } else {
          onError();
        }
      } catch (err) {
        console.error('[Livery] download error:', err);
        if (!cancelled) onError();
      }
    }

    run();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div id="livery-overlay">
      <div id="livery-box">
        <div id="livery-header">
          <h2>{t('browser_livery')}</h2>
        </div>

        <div id="livery-body">
          <div className="livery-section">
            <div className="livery-progress-wrap">
              <div className="livery-progress-bar" style={{ width: percent + '%' }} />
            </div>
            <p className="livery-pct">{percent}%</p>
            <p className="livery-status">{t('livery_downloading')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
