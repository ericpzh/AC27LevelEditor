import React, { useEffect, useState } from 'react';
import '../BrowserScreen/LiveryInstallOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';

/**
 * Full-screen overlay shown while downloading AC27Approach.dll from R2
 * (via the ericpzh.rest/ac27approach Worker route). On success calls
 * onComplete with the downloaded file path; on failure calls onError so the
 * parent can fall back to the local file dialog — same shape as the livery
 * flow in BrowserScreen.
 *
 * Props: { onComplete: (downloadedPath: string) => void, onError: () => void }
 */
export default function ApproachPluginInstallOverlay({ onComplete, onError }) {
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
        electronAPI.onApproachDllDownloadProgress(onProgress);
        cleanup = () => electronAPI.offApproachDllDownloadProgress(onProgress);

        const result = await electronAPI.downloadApproachDll();

        if (cancelled) return;

        if (result.success) {
          onComplete(result.filePath);
        } else {
          onError();
        }
      } catch (err) {
        console.error('[ApproachDll] download error:', err);
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
          <h2>{t('load_dll_download_title')}</h2>
        </div>

        <div id="livery-body">
          <div className="livery-section">
            <div className="livery-progress-wrap">
              <div className="livery-progress-bar" style={{ width: percent + '%' }} />
            </div>
            <p className="livery-pct">{percent}%</p>
            <p className="livery-status">{t('load_dll_downloading')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}