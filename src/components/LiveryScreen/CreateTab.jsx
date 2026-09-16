import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { SHORT_CODE_TO_PLANE_ID, OWN_PACK_NAME, folderFor } from '../../utils/constants/livery';
import { AIRLINE_CODE_MAP } from '../../utils/constants/airlines';
import { fileToDataUrl, normalizeToTexture } from '../../utils/liveryImage';
import useTooltip from '../BrowserScreen/useTooltip';
import LiveryCanvas from './LiveryCanvas';

function errKey(code) {
  return 'livery_err_' + String(code || 'unknown');
}

function AirlineAircraftFields({ airline, setAirline, shortCode, setShortCode }) {
  const { t } = useTranslation();
  const airlineOptions = useMemo(() => {
    const set = new Set(Object.values(AIRLINE_CODE_MAP));
    return [...set].sort();
  }, []);
  const planeId = SHORT_CODE_TO_PLANE_ID[shortCode] || '';
  return (
    <>
      <div className="livery-form-row">
        <label>{t('livery_airline')}</label>
        <input
          type="text"
          value={airline}
          maxLength={3}
          placeholder="CCA"
          list="livery-airline-codes"
          onChange={(e) => setAirline(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
        />
        <datalist id="livery-airline-codes">
          {airlineOptions.map(c => <option key={c} value={c} />)}
        </datalist>
      </div>
      <div className="livery-form-row">
        <label>{t('livery_aircraft')}</label>
        <select value={shortCode} onChange={(e) => setShortCode(e.target.value)}>
          <option value="">—</option>
          {Object.entries(SHORT_CODE_TO_PLANE_ID).map(([code, id]) => (
            <option key={code} value={code}>{code} — {id}</option>
          ))}
        </select>
        {planeId && <span className="livery-folder-preview">{shortCode} ↔ {planeId}</span>}
      </div>
    </>
  );
}

export default function CreateTab({ onCreated }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
  const prefill = CreateTab.prefill || null;
  const [mode, setMode] = useState(prefill ? 'paint' : 'upload');
  const [airline, setAirline] = useState(prefill?.airline || '');
  const [shortCode, setShortCode] = useState(
    prefill?.folder ? String(prefill.folder).split('_')[0] : ''
  );
  const planeId = SHORT_CODE_TO_PLANE_ID[shortCode] || '';
  const airlineValid = /^[A-Z]{3}$/.test(airline);
  const folderPreview = shortCode && airline ? folderFor(shortCode, airline) : '';

  // Upload-mode state.
  const [fillColor, setFillColor] = useState('#ffffff');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  // Paint-mode state.
  const [base, setBase] = useState(
    prefill?.imageDataUrl
      ? { kind: 'prefill', imageDataUrl: prefill.imageDataUrl }
      : { kind: 'blank' },
  );
  const [baseFill, setBaseFill] = useState('#ffffff');
  const [baseList, setBaseList] = useState([]);
  const [baseFolder, setBaseFolder] = useState('');
  const [canvasKey, setCanvasKey] = useState(0);
  const canvasRef = useRef(null);
  const dirtyRef = useRef(false);
  const { bind, TooltipPortal } = useTooltip();

  // Unsaved-changes guard consulted by LiveryScreen tab-leave/back.
  useEffect(() => {
    window.__liveryPaintGuard = { isDirty: () => dirtyRef.current };
    return () => { window.__liveryPaintGuard = null; };
  }, []);
  const markDirty = (v) => { dirtyRef.current = v; };

  // Load own liveries once for the existing-base picker.
  useEffect(() => {
    if (mode !== 'paint' || prefill?.imageDataUrl || baseList.length) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await electronAPI.listLiveries();
        if (!cancelled && res && res.success) setBaseList(res.mine || []);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const switchMode = (next) => {
    if (next === mode) return;
    if (dirtyRef.current && canvasRef.current && canvasRef.current.isDirty()) {
      const { showModal, hideModal } = useAppStore.getState();
      showModal(
        () => t('livery_unsaved_title'),
        () => <p>{t('livery_unsaved_body')}</p>,
        () => (
          <>
            <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
            <button className="btn-danger" onClick={() => { hideModal(); dirtyRef.current = false; setMode(next); }}>{t('livery_unsaved_discard')}</button>
          </>
        )
      );
      return;
    }
    setMode(next);
  };

  const ingestFile = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const raw = await fileToDataUrl(file);
      const normalized = await normalizeToTexture(raw, fillColor);
      setPreview(normalized);
    } catch (err) {
      useAppStore.getState().showToast(t(errKey(err && err.message)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async (imageDataUrl) => {
    if (!imageDataUrl || !airlineValid || !planeId || busy) return;
    setBusy(true);
    try {
      const res = await electronAPI.createLivery({
        imageDataUrl,
        airline,
        targetPlaneId: planeId,
        shortCode,
      });
      const { showToast } = useAppStore.getState();
      if (res && res.success) {
        CreateTab.prefill = null;
        dirtyRef.current = false;
        showToast(t('livery_created'), 'success');
        if (onCreated) onCreated();
      } else {
        showToast(t(errKey(res && res.error)), 'error');
      }
    } catch (err) {
      useAppStore.getState().showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePaintSave = async () => {
    if (!canvasRef.current) return;
    await submitCreate(canvasRef.current.exportPNG());
  };

  const [zipFolder, setZipFolder] = useState('');
  const handleLoadZip = async () => {
    setBusy(true);
    try {
      const res = await electronAPI.loadLiveryZip();
      const { showToast } = useAppStore.getState();
      if (!res || res.canceled) return;
      if (!res.success) {
        showToast(t(errKey(res.error)), 'error');
        return;
      }
      // Install preview: normalize (already 2048 → kept as-is), prefill
      // airline/aircraft; the Create button reuses create-livery.
      const normalized = await normalizeToTexture(res.imageDataUrl, '#ffffff');
      setPreview(normalized);
      if (res.manifest && res.manifest.airline) setAirline(String(res.manifest.airline).toUpperCase());
      if (res.shortCode && SHORT_CODE_TO_PLANE_ID[res.shortCode]) setShortCode(res.shortCode);
      setZipFolder(res.folder || '');
      showToast(t('livery_loadzip_loaded', { folder: res.folder || '' }), 'success');
    } catch (err) {
      useAppStore.getState().showToast(t(errKey(err && err.message)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const applyBase = async () => {
    if (base.kind === 'blank') {
      setCanvasKey(k => k + 1);
    } else if (base.kind === 'existing' && baseFolder) {
      setBusy(true);
      try {
        const res = await electronAPI.readLiveryImage(baseFolder, 'mine');
        if (res && res.success) {
          setBase({ kind: 'loaded', imageDataUrl: res.imageDataUrl });
          setCanvasKey(k => k + 1);
        } else {
          useAppStore.getState().showToast(t(errKey(res && res.error)), 'error');
        }
      } catch (err) {
        useAppStore.getState().showToast(err.message, 'error');
      } finally {
        setBusy(false);
      }
    }
  };

  const paintBaseUrl =
    base.kind === 'blank' ? null : base.imageDataUrl || null;

  const changeBaseFill = (v) => {
    setBaseFill(v);
    if (dirtyRef.current && canvasRef.current && canvasRef.current.isDirty()) {
      const { showModal, hideModal } = useAppStore.getState();
      showModal(
        () => t('livery_unsaved_title'),
        () => <p>{t('livery_unsaved_body')}</p>,
        () => (
          <>
            <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
            <button className="btn-danger" onClick={() => { hideModal(); dirtyRef.current = false; setCanvasKey(k => k + 1); }}>{t('livery_unsaved_discard')}</button>
          </>
        )
      );
      return;
    }
    setCanvasKey(k => k + 1);
  };

  return (
    <div>
      <div className="livery-toolbar" style={{ marginBottom: 12 }}>
        <button className={'btn-sm' + (mode === 'upload' ? ' tool-active' : '')} onClick={() => switchMode('upload')}>{t('livery_mode_upload')}</button>
        <button className={'btn-sm' + (mode === 'paint' ? ' tool-active' : '')} onClick={() => switchMode('paint')}>{t('livery_mode_paint')}</button>
        {prefill?.folder && <span className="livery-folder-preview">{t('livery_editing_folder', { folder: prefill.folder })}</span>}
      </div>

      <AirlineAircraftFields airline={airline} setAirline={setAirline} shortCode={shortCode} setShortCode={setShortCode} />
      <div className="livery-form-row">
        <span>{t('livery_folder_preview')}: </span>
        <span className="livery-folder-preview"><strong>{folderPreview || '—'}</strong></span>
      </div>

      {mode === 'upload' && (
        <>
          <div
            className="livery-dropzone"
            onClick={() => fileRef.current && fileRef.current.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); ingestFile(e.dataTransfer.files && e.dataTransfer.files[0]); }}
            style={dragOver ? { borderColor: 'var(--accent)' } : null}
          >
            {t('livery_upload_drop')}
            <div style={{ marginTop: 8 }}>
              <button className="btn-sm" {...bind(t('livery_tip_browse'))} onClick={(e) => { e.stopPropagation(); fileRef.current && fileRef.current.click(); }}>
                {t('livery_upload_browse')}
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".png,.jpg,.jpeg"
              style={{ display: 'none' }}
              onChange={(e) => ingestFile(e.target.files && e.target.files[0])}
            />
          </div>

          {preview && (
            <div className="livery-preview">
              <img src={preview} alt="preview" />
            </div>
          )}

          <div className="livery-form-row">
            <label>{t('livery_base_fill')}</label>
            <input type="color" value={fillColor} onChange={(e) => setFillColor(e.target.value)} />
          </div>

          <p className="livery-folder-preview">{t('livery_fit_note')}</p>

          <div className="livery-form-row">
            <button className="btn-sm" {...bind(t('livery_tip_create'))} disabled={!preview || !airlineValid || !planeId || busy} onClick={() => submitCreate(preview)}>
              {t('livery_create')}
            </button>
            <button className="btn-sm" {...bind(t('livery_tip_loadzip'))} disabled={busy} onClick={handleLoadZip}>
              {t('livery_loadzip')}
            </button>
            {zipFolder && <span className="livery-folder-preview">{t('livery_loadzip_loaded', { folder: zipFolder })}</span>}
          </div>
          <p className="livery-folder-preview">{t('livery_share_help', { pack: OWN_PACK_NAME })}</p>
        </>
      )}

      {mode === 'paint' && (
        <>
          {!prefill?.imageDataUrl && (
            <div className="livery-form-row">
              <span>{t('livery_paint_base_source')}: </span>
              <label><input type="radio" checked={base.kind === 'blank'} onChange={() => setBase({ kind: 'blank' })} />{t('livery_paint_base_blank')}</label>
              <label><input type="radio" checked={base.kind === 'existing' || base.kind === 'loaded'} onChange={() => setBase({ kind: 'existing' })} />{t('livery_paint_base_existing')}</label>
              {base.kind === 'blank' && (
                <input type="color" value={baseFill} onChange={(e) => changeBaseFill(e.target.value)} />
              )}
              {base.kind === 'existing' && (
                <>
                  <select value={baseFolder} onChange={(e) => setBaseFolder(e.target.value)}>
                    <option value="">—</option>
                    {baseList.map(r => <option key={r.folder} value={r.folder}>{r.folder}</option>)}
                  </select>
                  <button className="btn-sm" disabled={!baseFolder || busy} onClick={applyBase}>{t('livery_paint_pick_base')}</button>
                </>
              )}
            </div>
          )}
          <LiveryCanvas
            key={canvasKey}
            ref={canvasRef}
            initialImageDataUrl={paintBaseUrl}
            baseFill={base.kind === 'blank' ? baseFill : '#ffffff'}
            onDirty={markDirty}
          />
          <div className="livery-form-row" style={{ marginTop: 10 }}>
            <button className="btn-sm" {...bind(t('livery_tip_create'))} disabled={!airlineValid || !planeId || busy} onClick={handlePaintSave}>
              {t('livery_create')}
            </button>
          </div>
        </>
      )}
      {TooltipPortal}
    </div>
  );
}
CreateTab.prefill = null;
