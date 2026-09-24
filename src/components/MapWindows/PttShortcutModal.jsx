import React, { useState, useEffect, useRef } from 'react';
import { IoClose } from 'react-icons/io5';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { buildAcceleratorFromEvent, normalizeAccelerator, isValidAccelerator } from '../../utils/pttShortcut';

/** Live echo while only modifiers are held (e.g. "Shift+…"). */
function modsEcho(e) {
  const m = [];
  if (e.ctrlKey || e.metaKey) m.push('Ctrl');
  if (e.altKey) m.push('Alt');
  if (e.shiftKey) m.push('Shift');
  return m.length ? m.join('+') + '+…' : '';
}

/**
 * Modal to remap the global PTT hotkey (OS-level toggle — works even when
 * the strips window or the whole app is unfocused).
 *
 * Minimal by design: title + the key only. The capture box is focused on
 * open and echoes every keystroke live (Escape closes, Backspace disables);
 * a complete Modifier+Key / F-key combo is persisted via the main process
 * (which owns the globalShortcut registration) and the value settles back
 * to the saved shortcut on key release. A failed save flashes the box red.
 */
export default function PttShortcutModal({ onClose }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
  const [display, setDisplay] = useState(null); // null = loading; else live echo / saved value
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const captureRef = useRef(null);
  const savedRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    if (!electronAPI || !electronAPI.getPttShortcut) { setDisplay(''); return; }
    electronAPI.getPttShortcut()
      .then((r) => {
        if (cancelled) return;
        const s = r && r.success && typeof r.shortcut === 'string' ? r.shortcut : '';
        savedRef.current = s;
        setDisplay(s);
      })
      .catch(() => { if (!cancelled) { savedRef.current = ''; setDisplay(''); } });
    return () => { cancelled = true; };
  }, [electronAPI]);

  useEffect(() => {
    if (captureRef.current) captureRef.current.focus();
  }, []);

  // Releasing any key settles the box back to the saved shortcut.
  useEffect(() => {
    const onKeyUp = () => {
      setFailed(false);
      setDisplay(savedRef.current);
    };
    window.addEventListener('keyup', onKeyUp);
    return () => window.removeEventListener('keyup', onKeyUp);
  }, []);

  const persist = async (accelerator) => {
    setSaving(true);
    setFailed(false);
    try {
      if (!electronAPI || !electronAPI.setPttShortcut) { setFailed(true); return false; }
      const r = await electronAPI.setPttShortcut(accelerator);
      if (r && r.success) {
        savedRef.current = r.shortcut || '';
        setDisplay(savedRef.current);
        return true;
      }
      // No UI text by design — report the cause to the main-process log.
      if (electronAPI.debugLog) {
        electronAPI.debugLog('[PTT-SHORTCUT] save failed', JSON.stringify(accelerator),
          'error=' + ((r && r.error) || 'UNKNOWN'));
      }
      setFailed(true);
      return false;
    } catch (err) {
      if (electronAPI && electronAPI.debugLog) {
        electronAPI.debugLog('[PTT-SHORTCUT] save threw', JSON.stringify(accelerator),
          'error=' + ((err && err.message) || 'UNKNOWN'));
      }
      setFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { if (onClose) onClose(); return; }
    if (saving) return;
    if (e.key === 'Backspace' || e.key === 'Delete') { persist(''); return; }
    const built = buildAcceleratorFromEvent(e);
    if (built === '') { setFailed(false); setDisplay(modsEcho(e) || savedRef.current); return; }
    if (!built) { setFailed(true); return; }
    const normalized = normalizeAccelerator(built) || built;
    setDisplay(normalized);
    if (!isValidAccelerator(normalized)) { setFailed(true); return; }
    setFailed(false);
    persist(normalized);
  };

  return (
    <div id="map-help-overlay" onClick={(e) => { if (e.target.id === 'map-help-overlay' && onClose) onClose(); }}>
      {/* mod-prompt-box restores the app UI font (the strips root forces a
          10px radar monospace on everything, which renders CJK off-spec). */}
      <div id="map-help-box" className="mod-prompt-box" onClick={(e) => e.stopPropagation()}>
        <div id="map-help-header">
          <h2>{t('ptt_shortcut_update')}</h2>
          <button onClick={onClose} title={t('tutorial_close')}>
            <IoClose size={18} />
          </button>
        </div>
        <div id="map-help-body">
          <div
            ref={captureRef}
            tabIndex={0}
            role="textbox"
            aria-label={t('ptt_shortcut_update')}
            className={'ptt-capture-box' + (failed ? ' ptt-capture-error' : '')}
            onKeyDown={handleKeyDown}
          >
            {display === null ? '…' : (display || t('ptt_shortcut_off'))}
          </div>
          <p className="ptt-capture-hint">{t('ptt_shortcut_hint')}</p>
        </div>
      </div>
    </div>
  );
}
