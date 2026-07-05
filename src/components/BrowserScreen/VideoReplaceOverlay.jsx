import React, { useEffect, useState } from 'react';
import './VideoReplaceOverlay.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { IoClose, IoAlertCircle } from 'react-icons/io5';

/**
 * Full-screen overlay shown while converting a user-selected video to VP8 WebM
 * and replacing all airport main-menu background videos. Auto-discovers
 * all XXXX.webm/ folders, streams progress, and auto-dismisses on completion.
 *
 * Props: { sourcePath: string, onClose: () => void }
 */
export default function VideoReplaceOverlay({ sourcePath, onClose }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();

  const [phase, setPhase] = useState('converting'); // converting | error
  const [convertPct, setConvertPct] = useState(0);
  const [error, setError] = useState('');

  // Run the full pipeline on mount
  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        // 1. Discover all menu video folders
        console.log('[VideoReplace] discovering menu videos...');
        const disc = await electronAPI.discoverMenuVideos();
        console.log('[VideoReplace] discover result:', JSON.stringify({ error: disc.error, folderCount: disc.folders?.length }));
        if (disc.error) {
          if (!cancelled) { setPhase('error'); setError(disc.error); }
          return;
        }
        const folders = disc.folders || [];
        if (!folders.length) {
          if (!cancelled) { setPhase('error'); setError('NO_FOLDERS'); }
          return;
        }
        console.log('[VideoReplace] found', folders.length, 'airport(s):', folders.map(f => f.icao).join(', '));

        // 2. Convert source video to temp file
        // Use a temp output path derived from source filename
        const srcName = sourcePath.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
        const tmpDir = sourcePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        const outputPath = tmpDir + '/' + srcName + '_vp8.webm';

        // Subscribe to convert progress
        const onConvert = (data) => {
          if (!cancelled) {
            setConvertPct(data.percent || 0);
          }
        };
        electronAPI.onVideoConvertProgress(onConvert);

        const convResult = await electronAPI.convertVideo({ inputPath: sourcePath, outputPath });
        electronAPI.offVideoConvertProgress(onConvert);

        if (!convResult.success) {
          if (!cancelled) { setPhase('error'); setError(convResult.error || 'Conversion failed'); }
          return;
        }

        if (cancelled) return;

        // Replace videos silently (no separate UI phase — fast file ops)
        const repResult = await electronAPI.replaceMenuVideos({
          convertedVideoPath: convResult.outputPath,
          airports: folders.map(f => ({ icao: f.icao, dirPath: f.dirPath, files: f.files })),
        });

        if (!repResult.success) {
          if (!cancelled) { setPhase('error'); setError(repResult.error || 'Replace failed'); }
          return;
        }

        // Success — close immediately, no confirmation screen
        if (!cancelled) onClose();
      } catch (err) {
        if (!cancelled) { setPhase('error'); setError(err.message); }
      }
    }

    run();

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key closes (only during error)
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && phase === 'error') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [phase, onClose]);

  const handleOverlayClick = (e) => {
    if (e.target.id === 'vr-overlay' && phase === 'error') {
      onClose();
    }
  };

  return (
    <div id="vr-overlay" onClick={handleOverlayClick}>
      <div id="vr-box" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div id="vr-header">
          <h2>{t(phase === 'error' ? 'vr_error_convert' : 'browser_replace_background')}</h2>
          {phase === 'error' && (
            <button onClick={onClose} title={t('browser_help_close')}>
              <IoClose size={18} />
            </button>
          )}
        </div>

        {/* Body */}
        <div id="vr-body">
          {/* Converting phase */}
          {phase === 'converting' && (
            <div className="vr-section">
              <div className="vr-progress-wrap">
                <div className="vr-progress-bar" style={{ width: convertPct + '%' }} />
              </div>
              <p className="vr-pct">{convertPct}%</p>
            </div>
          )}

          {/* Error phase */}
          {phase === 'error' && (
            <div className="vr-section vr-error-box">
              <IoAlertCircle size={48} className="vr-error-icon" />
              <p className="vr-error-msg">
                {error === 'NO_FOLDERS' ? t('vr_no_folders') : error === 'NO_GAME_ROOT' ? t('vr_no_game_root') : error}
              </p>
              <p className="vr-error-hint">{t('vr_error_untouched')}</p>
              <button className="btn-sm" onClick={onClose}>{t('browser_help_close')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
