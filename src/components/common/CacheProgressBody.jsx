import React, { useEffect } from 'react';
import { useAppStore } from '../../store/appStore';
import { useElectronAPI } from '../../hooks/useElectronAPI';

/**
 * Simple percentage display shown during airport cache building.
 * Subscribes to cache-build-progress IPC events across ALL airports/files.
 */
export default function CacheProgressBody() {
  const progress = useAppStore(s => s.cacheBuildProgress);
  const setCacheBuildProgress = useAppStore(s => s.setCacheBuildProgress);
  const electronAPI = useElectronAPI();

  useEffect(() => {
    const handler = (data) => setCacheBuildProgress(data);
    if (electronAPI.onCacheBuildProgress) {
      electronAPI.onCacheBuildProgress(handler);
    }
    return () => {
      if (electronAPI.offCacheBuildProgress) {
        electronAPI.offCacheBuildProgress(handler);
      }
    };
  }, []);

  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="cache-progress">
      <div className="cache-progress-bar-track">
        <div
          className="cache-progress-bar-fill"
          style={{ width: pct + '%' }}
        />
      </div>
      <div className="cache-progress-pct">{pct}%</div>
    </div>
  );
}
