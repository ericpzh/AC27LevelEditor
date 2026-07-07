import React, { useEffect, useState } from 'react';
import './VideoBackgroundModal.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { IoClose, IoVideocamOutline, IoRefreshOutline } from 'react-icons/io5';

/**
 * Confirmation modal shown before replacing or restoring menu background videos.
 * Explains what the feature does and offers two actions:
 * - Replace Video: proceed to file picker → convert → replace pipeline
 * - Restore: revert all airports to original videos from .webm.bak backups
 *
 * Props: { onClose, onReplace, onRestore }
 */
export default function VideoBackgroundModal({ onClose, onReplace, onRestore }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();

  const [backupExists, setBackupExists] = useState(false);
  const [checking, setChecking] = useState(true);

  // Check whether any .webm.bak backups exist
  useEffect(() => {
    let cancelled = false;
    electronAPI.checkVideoBackupExists().then((r) => {
      if (cancelled) return;
      if (r.success) setBackupExists(r.exists);
      setChecking(false);
    }).catch(() => {
      if (!cancelled) setChecking(false);
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key closes
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const handleOverlayClick = (e) => {
    if (e.target.id === 'vbg-modal-overlay') onClose();
  };

  return (
    <div id="vbg-modal-overlay" onClick={handleOverlayClick}>
      <div id="vbg-modal-box" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div id="vbg-modal-header">
          <h2>{t('vbg_modal_title')}</h2>
          <button onClick={onClose} title={t('browser_help_close')}>
            <IoClose size={18} />
          </button>
        </div>

        {/* Body */}
        <div id="vbg-modal-body">
          <p className="vbg-modal-desc">{t('vbg_modal_description')}</p>

          <div className="vbg-modal-actions">
            <button className="vbg-modal-btn vbg-secondary" onClick={onReplace}>
              <IoVideocamOutline size={14} />{t('vbg_modal_replace_btn')}
            </button>
            <button
              className="vbg-modal-btn vbg-secondary"
              onClick={onRestore}
              disabled={!backupExists || checking}
              title={!backupExists && !checking ? t('vbg_modal_no_backup') : undefined}
            >
              <IoRefreshOutline size={14} />{t('vbg_modal_restore_btn')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
