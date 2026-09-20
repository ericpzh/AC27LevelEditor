import React, { useEffect, useState } from 'react';
import './UploadLiveryDialog.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { airlineDisplayName } from '../../utils/constants/airlines';
import { shortAircraftType } from '../../utils/constants/livery';

function errKey(code) {
  return 'livery_err_' + String(code || 'unknown');
}

// Map an IPC error code to display text. Unknown codes (e.g. a raw native
// string slipping through) never render as a bare key — they fall back to
// the generic upload failure text, with the raw code/detail underneath.
function errText(t, code, detail) {
  const key = errKey(code);
  const mapped = t(key);
  const text = (mapped && mapped !== key) ? mapped : t('livery_err_UPLOAD_FAILED');
  const extra = [code && mapped === key ? String(code) : '', detail || '']
    .filter(Boolean).join(' — ');
  return { text, extra };
}

function rlog(...args) {
  try {
    if (window.electronAPI && window.electronAPI.rendererLog) {
      window.electronAPI.rendererLog('[WorkshopDialog]', ...args).catch(() => {});
    }
  } catch (_) {}
}

const VISIBILITY_KEYS = [
  'livery_upload_visibility_public',
  'livery_upload_visibility_friends',
  'livery_upload_visibility_private',
  'livery_upload_visibility_unlisted',
];

// Workshop Upload dialog (plan.md §7.3): collects Title/Description plus
// visibility, tags, change note and preview, pre-filled from the previous
// version (live Steam metadata → local cache → manifest defaults) via
// get-workshop-publish-info. Shows upload progress and, on success, the item
// URL. Errors stay inline so the user can retry without retyping.
export default function UploadLiveryDialog({ folder, onClose }) {
  const { t, lang } = useTranslation();
  const electronAPI = useElectronAPI();
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState(2);
  const [tagsText, setTagsText] = useState('Livery');
  const [previewDataUrl, setPreviewDataUrl] = useState(null);
  const [previewPath, setPreviewPath] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [errorExtra, setErrorExtra] = useState('');
  const [loadErrorExtra, setLoadErrorExtra] = useState('');
  // True when the main process has no workshop-debug handler, i.e. it
  // predates the whole feature — renderer hot-reloads without restart while
  // main does not, so this is how a stale main looks from the dialog.
  const [staleMain, setStaleMain] = useState(false);

  // Localized default title for a first upload: the airline's display name (the
  // same source the livery list page uses) + the compact aircraft type, e.g.
  // EN "Air China A-320neo Livery" / ZH "中国国航 A-320neo 涂装". A previously
  // published title (sidecar) always wins.
  const defaultWorkshopTitle = (res) => {
    const code = res && res.airline;
    const airline = code ? airlineDisplayName(code, lang) : '';
    const type = shortAircraftType(res && res.targetPlaneId);
    return t('livery_workshop_default_title', { airline, type }).replace(/\s+/g, ' ').trim();
  };

  useEffect(() => {
    let cancelled = false;
    rlog(`open folder=${folder}`);
    // Debug handshake: which main serves us (run dir, module mtime, host).
    // A rejection means NO handler — stale main, uploads cannot work.
    (async () => {
      try {
        const dbg = electronAPI.getWorkshopDebugInfo
          ? await electronAPI.getWorkshopDebugInfo()
          : null;
        if (cancelled) return;
        if (dbg && dbg.success) {
          rlog(`main handshake dir=${dbg.mainFile && dbg.mainFile.dir} mtime=${dbg.mainFile && dbg.mainFile.mtime} host=${dbg.host} steamworks=${Boolean(dbg.steamworksPresent)}`);
        }
      } catch (err) {
        if (!cancelled) {
          setStaleMain(true);
          rlog(`main handshake MISSING (stale main process): ${(err && err.message) || err}`);
        }
      }
    })();
    const onProg = (p) => {
      if (!cancelled) setProgress(p || null);
    };
    try {
      if (electronAPI.onWorkshopUploadProgress) electronAPI.onWorkshopUploadProgress(onProg);
    } catch (_) {}
    (async () => {
      try {
        const res = await electronAPI.getWorkshopPublishInfo(folder);
        if (cancelled) return;
        if (!res || !res.success) {
          const { text, extra } = errText(t, res && res.error, res && res.detail);
          setLoadError(text);
          setLoadErrorExtra(extra);
          rlog(`prefill failed folder=${folder} code=${res && res.error} detail=${res && res.detail}`);
        } else {
          setInfo(res);
          setTitle(res.title || defaultWorkshopTitle(res));
          setDescription(res.description || '');
          if (Number.isFinite(Number(res.visibility))) setVisibility(Number(res.visibility));
          if (Array.isArray(res.tags) && res.tags.length) setTagsText(res.tags.join(', '));
          if (res.previewDataUrl) setPreviewDataUrl(res.previewDataUrl);
        }
      } catch (err) {
        if (!cancelled) setLoadError((err && err.message) || t('livery_err_unknown'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      try {
        if (electronAPI.offWorkshopUploadProgress) electronAPI.offWorkshopUploadProgress(onProg);
      } catch (_) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  // Escape closes (but never mid-upload); backdrop click too.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !uploading && onClose) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [uploading, onClose]);

  const close = () => {
    if (!uploading && onClose) onClose();
  };

  const handleChoosePreview = async () => {
    try {
      const res = await electronAPI.selectLiveryPreview();
      if (!res || res.canceled) return;
      if (!res.success) {
        const { text, extra } = errText(t, res.error, res.detail);
        useAppStore.getState().showToast(extra ? `${text} — ${extra}` : text, 'error');
        return;
      }
      setPreviewPath(res.filePath || '');
      if (res.imageDataUrl) setPreviewDataUrl(res.imageDataUrl);
    } catch (err) {
      useAppStore.getState().showToast((err && err.message) || '', 'error');
    }
  };

  const doUpload = async () => {
    if (uploading || !title.trim()) return;
    setUploading(true);
    setError('');
    setErrorExtra('');
    setProgress(null);
    setResult(null);
    rlog(`submit folder=${folder} title=${title.trim().slice(0, 80)}`);
    try {
      const payload = {
        folder,
        title: title.trim(),
        description,
        visibility: Number(visibility),
        tags: String(tagsText).split(',').map(s => s.trim()).filter(Boolean),
        previewPath: previewPath || undefined,
      };
      const res = await electronAPI.publishLivery(payload);
      if (res && res.success) {
        setResult({ publishedFileId: res.publishedFileId, url: res.url });
        rlog(`success folder=${folder} id=${res.publishedFileId} url=${res.url}`);
      } else {
        const { text, extra } = errText(t, res && res.error, res && res.detail);
        setError(text);
        setErrorExtra(extra);
        rlog(`failed folder=${folder} code=${res && res.error} detail=${res && res.detail}`);
      }
    } catch (err) {
      const { text, extra } = errText(t, null, (err && err.message) || '');
      setError(text);
      setErrorExtra(extra);
      rlog(`threw folder=${folder} detail=${(err && err.message) || err}`);
    } finally {
      setUploading(false);
    }
  };

  const openExternal = (url) => {
    if (url && electronAPI.openExternal) electronAPI.openExternal(url).catch(() => {});
  };

  const openLog = () => {
    try {
      if (electronAPI.openWorkshopLog) {
        electronAPI.openWorkshopLog().catch(() => {});
      }
    } catch (_) {}
  };

  const unavailable = Boolean(info && !info.available);
  const unavailableText = unavailable ? errText(t, info.reason, null).text : '';
  const submitDisabled = loading || uploading || !title.trim() || unavailable || Boolean(result);
  const pct = progress && progress.total > 0
    ? Math.max(0, Math.min(100, Math.round((progress.progress / progress.total) * 100)))
    : null;

  return (
    <div id="livery-upload-overlay" onClick={(e) => { if (e.target.id === 'livery-upload-overlay') close(); }}>
      <div id="livery-upload-box" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('livery_upload_title')}>
        <div id="livery-upload-header">
          <h2>
            {t('livery_upload_title')}
            {info && info.publishedFileId ? ` — ${t('livery_upload_new_version')}` : ''}
          </h2>
          <button onClick={close} disabled={uploading} aria-label={t('livery_cancel')}>✕</button>
        </div>
        <div id="livery-upload-body">
          {staleMain && <p className="livery-upload-error">{t('livery_upload_stale_main')}</p>}
          {loading && <p>{t('livery_upload_loading')}</p>}
          {!loading && loadError && (
            <>
              <p className="livery-upload-error">{loadError}</p>
              {loadErrorExtra && <p className="livery-upload-detail">{loadErrorExtra}</p>}
            </>
          )}
          {!loading && !loadError && (
            <>
              {unavailable && (
                <p className="livery-upload-error">{unavailableText}</p>
              )}
              <label className="livery-upload-field">
                <span>{t('livery_upload_field_title')}</span>
                <input
                  type="text"
                  value={title}
                  maxLength={128}
                  disabled={uploading || unavailable}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="livery-upload-field">
                <span>{t('livery_upload_field_description')}</span>
                <textarea
                  value={description}
                  rows={5}
                  disabled={uploading || unavailable}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <div className="livery-upload-row">
                <label className="livery-upload-field">
                  <span>{t('livery_upload_field_visibility')}</span>
                  <select
                    value={visibility}
                    disabled={uploading || unavailable}
                    onChange={(e) => setVisibility(Number(e.target.value))}
                  >
                    {VISIBILITY_KEYS.map((key, value) => (
                      <option key={key} value={value}>{t(key)}</option>
                    ))}
                  </select>
                </label>
                <label className="livery-upload-field">
                  <span>{t('livery_upload_field_tags')}</span>
                  <input
                    type="text"
                    value={tagsText}
                    disabled={uploading || unavailable}
                    onChange={(e) => setTagsText(e.target.value)}
                  />
                </label>
              </div>
              {info && info.publishedFileId && info.url && (
                <p className="livery-upload-url">
                  <a href={info.url} onClick={(e) => { e.preventDefault(); openExternal(info.url); }}>
                    {info.url}
                  </a>
                </p>
              )}
              <div className="livery-upload-field">
                <span>{t('livery_upload_field_preview')}</span>
                <div className="livery-upload-preview-row">
                  {previewDataUrl && <img src={previewDataUrl} alt="" />}
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={uploading || unavailable}
                    onClick={handleChoosePreview}
                  >
                    {t('livery_upload_choose_preview')}
                  </button>
                </div>
              </div>
              <p className="livery-upload-help">{t('livery_upload_help')}</p>
              {(uploading || pct != null) && (
                <div className="livery-upload-progress">
                  <span>{t('livery_upload_progress')}{pct != null ? ` ${pct}%` : ''}</span>
                  <progress value={pct != null ? pct : undefined} max={100} />
                </div>
              )}
              {error && (
                <>
                  <p className="livery-upload-error">{error}</p>
                  {errorExtra && <p className="livery-upload-detail">{errorExtra}</p>}
                  <div className="livery-upload-preview-row">
                    <button type="button" className="btn-sm" onClick={openLog}>
                      {t('livery_upload_view_log')}
                    </button>
                  </div>
                </>
              )}
              {result && (
                <div className="livery-upload-success">
                  <p>{t('livery_upload_success')}</p>
                  {result.url && (
                    <p className="livery-upload-url">
                      <a href={result.url} onClick={(e) => { e.preventDefault(); openExternal(result.url); }}>
                        {result.url}
                      </a>
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div id="livery-upload-actions">
          {!result ? (
            <>
              <button className="btn-cancel" disabled={uploading} onClick={close}>{t('modal_btn_cancel')}</button>
              <button className="btn-confirm" disabled={submitDisabled} onClick={doUpload}>
                {t('livery_upload')}
              </button>
            </>
          ) : (
            <button className="btn-confirm" onClick={close}>{t('modal_btn_ok')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
