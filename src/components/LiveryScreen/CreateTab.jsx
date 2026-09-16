import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { PLANE_ID_TO_SHORT_CODE, LIVERY_FOLDER_SAFE_RE, folderFor } from '../../utils/constants/livery';
import { AIRLINE_CODE_MAP, airlineDisplayName } from '../../utils/constants/airlines';
import { fileToDataUrl, normalizeToTexture } from '../../utils/liveryImage';
import useTooltip from '../BrowserScreen/useTooltip';
import {
  IoLockClosed,
  IoArrowBack,
  IoImageOutline,
  IoSaveOutline,
  IoHelpCircleOutline,
} from 'react-icons/io5';
import { MdSaveAs } from 'react-icons/md';
import { FaFileImport, FaFileExport } from 'react-icons/fa6';
import LiveryCanvas from './LiveryCanvas';

function errKey(code) {
  return 'livery_err_' + String(code || 'unknown');
}

const PLANE_IDS = Object.keys(PLANE_ID_TO_SHORT_CODE);

// Naming dialog shared by Save / Save As: the typed name is used verbatim
// as the livery folder name (free-form, filesystem-safe only — see
// LIVERY_FOLDER_SAFE_RE). Airline + aircraft are NOT parsed out of it; they
// come from the manifest/origin and only feed the manifest. Buttons live
// inside the body (instead of #modal-actions) so the input and the confirm
// button share one state.
function SaveNameDialog({ initial, isSaveAs, onConfirm }) {
  const { t } = useTranslation();
  const hideModal = useAppStore(s => s.hideModal);
  const [name, setName] = useState(initial);
  const folder = String(name || '').trim();
  const valid = LIVERY_FOLDER_SAFE_RE.test(folder);
  const doConfirm = () => {
    if (!valid) return;
    onConfirm(folder);
  };
  return (
    <div>
      <label>
        <input
          type="text"
          aria-label={t('livery_folder_name')}
          value={name}
          maxLength={64}
          autoFocus
          placeholder="A20N_CCA"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doConfirm(); }}
        />
      </label>
      {!valid && <p style={{ color: 'var(--red)', fontWeight: 600 }}>{t('livery_err_BAD_FOLDER')}</p>}
      <div className="modal-actions-row">
        <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
        <button className="btn-confirm" disabled={!valid} onClick={doConfirm}>{t(isSaveAs ? 'livery_save_as' : 'livery_save')}</button>
      </div>
    </div>
  );
}

function AirlineAircraftFields({ airline, setAirline, planeId, setPlaneId }) {
  const { t, lang } = useTranslation();
  const airlineOptions = useMemo(() => {
    const set = new Set(Object.values(AIRLINE_CODE_MAP));
    return [...set].sort();
  }, []);
  // Custom dropdown: always renders the FULL airline list when open —
  // never filtered by the typed text (native <datalist> filters options
  // by the input value, hiding non-matching airlines).
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);
  return (
    <>
      <label className="lp-inline">
        <span className="lp-inline-label">{t('livery_airline')}</span>
        <span className="lp-airline-wrap" ref={wrapRef}>
          <input
            type="text"
            value={airline}
            maxLength={3}
            placeholder="CCA"
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls="livery-airline-list"
            onChange={(e) => setAirline(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
            onFocus={() => setOpen(true)}
          />
          <button
            type="button"
            className="lp-airline-toggle"
            aria-label="airlines"
            onClick={() => setOpen((v) => !v)}
          >
            ▾
          </button>
          {open && (
            <ul id="livery-airline-list" className="lp-airline-list" role="listbox">
              {airlineOptions.map(c => (
                <li key={c} role="option" aria-selected={c === airline}>
                  <button
                    type="button"
                    className={'lp-airline-option' + (c === airline ? ' selected' : '')}
                    onClick={() => { setAirline(c); setOpen(false); }}
                  >
                    <strong>{c}</strong>
                    <span>{airlineDisplayName(c, lang)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </span>
      </label>
      <label className="lp-inline">
        <span className="lp-inline-label">{t('livery_aircraft')}</span>
        <select value={planeId} onChange={(e) => setPlaneId(e.target.value)}>
          <option value="">—</option>
          {PLANE_IDS.map(id => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
      </label>
    </>
  );
}

/**
 * CreateTab — the livery "painter" page.
 *
 * Always shows the paint canvas primed with the clicked livery's actual
 * picture (mine or reference). Bottom action bar mirrors the map editor
 * (GroundPainter .gp-actions style): Cancel | Save As | Save.
 *
 * - Save pops up a naming dialog (prefilled with the origin folder) and
 *   saves the canvas under the typed folder name (free-form). The origin's
 *   airline/aircraft are kept — renaming never reassigns the plane.
 *   Disabled for reference (locked) origins — only Save As.
 * - Save As pops up a naming dialog (prefilled with the conventional
 *   {aircraft}_{airline} folder) and saves the canvas under the typed name
 *   with the live form's airline/aircraft.
 * - Cancel discards (with an unsaved-changes guard) and returns to the list.
 */
export default function CreateTab({ onCreated, onCancel, onHelp }) {
  const { t, lang } = useTranslation();
  const electronAPI = useElectronAPI();
  const prefill = CreateTab.prefill || null;

  // Origin snapshot: what was clicked. pack is 'mine' | 'reference' | null.
  // Everything comes from the manifest (read off disk by listLiveries); the
  // folder is only the storage key. This snapshot keeps the origin's parts
  // even if the user renames the folder on Save.
  const origin = useMemo(() => {
    if (!prefill || !prefill.folder) return null;
    return {
      folder: String(prefill.folder),
      airline: String(prefill.airline || '').toUpperCase(),
      planeId: prefill.targetPlaneId || '',
      pack: prefill.pack || 'mine',
      imageDataUrl: prefill.imageDataUrl || null,
    };
  }, [prefill]);
  const isReference = origin && origin.pack === 'reference';

  const [airline, setAirline] = useState(origin?.airline || prefill?.airline || '');
  const [planeId, setPlaneId] = useState(origin?.planeId || prefill?.targetPlaneId || '');
  const airlineValid = /^[A-Z]{3}$/.test(airline);
  const folderPreview = planeId && airline ? folderFor(planeId, airline) : '';
  const formValid = Boolean(folderPreview && airlineValid && PLANE_ID_TO_SHORT_CODE[planeId]);

  // Paint state — primed with the clicked picture when available. The canvas
  // background is always transparent (no base fill).
  const [base, setBase] = useState(
    origin?.imageDataUrl ? { imageDataUrl: origin.imageDataUrl } : null,
  );
  const [canvasKey, setCanvasKey] = useState(0);
  const canvasRef = useRef(null);
  const dirtyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef(null);
  const { bind, TooltipPortal } = useTooltip();

  // Save targets the origin folder; Save As targets the live form folder.
  // Reference (locked) origins can never Save — only Save As.
  const canSaveAs = formValid && !busy;
  const canSave = isReference
    ? false
    : origin
      ? Boolean(origin.planeId && origin.airline && PLANE_ID_TO_SHORT_CODE[origin.planeId]) && !busy
      : formValid && !busy;

  // Unsaved-changes guard consulted by LiveryScreen tab-leave/back.
  useEffect(() => {
    window.__liveryPaintGuard = { isDirty: () => dirtyRef.current };
    return () => { window.__liveryPaintGuard = null; };
  }, []);
  const markDirty = (v) => { dirtyRef.current = v; };

  // Lazy-load the origin picture when the thumbnail was not ready yet
  // (e.g. clicked before thumbnails finished loading).
  useEffect(() => {
    if (!origin || origin.imageDataUrl || base) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await electronAPI.readLiveryImage(origin.folder, origin.pack);
        if (!cancelled && res && res.success && res.imageDataUrl) {
          setBase({ imageDataUrl: res.imageDataUrl });
          setCanvasKey(k => k + 1);
        }
      } catch (_) {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin?.folder, origin?.pack]);

  const confirmDiscard = (proceed) => {
    if (!dirtyRef.current) { proceed(); return; }
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t('livery_unsaved_title'),
      () => <p>{t('livery_unsaved_body')}</p>,
      () => (
        <>
          <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
          <button className="btn-danger" onClick={() => { hideModal(); dirtyRef.current = false; proceed(); }}>{t('livery_unsaved_discard')}</button>
        </>
      )
    );
  };

  // A name that already exists on disk clobbers another livery, so ask before
  // saving. Only plain Save re-writing the current livery's own folder stays
  // silent — Save As is an explicit "write this name", so it always asks (its
  // prefill is the origin folder for an existing livery). Lookup is
  // best-effort: an unreadable list falls through to the save.
  const confirmOverride = async (folder, isSaveAs, proceed) => {
    // Windows paths are case-insensitive — a case-only rename is the same folder.
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const ownFolder = !isSaveAs && origin && origin.pack !== 'reference' ? origin.folder : null;
    if (ownFolder && same(folder, ownFolder)) { await proceed(); return; }
    let exists = false;
    try {
      const res = await electronAPI.listLiveries();
      exists = Boolean(res && res.success && Array.isArray(res.mine) &&
        res.mine.some(r => r && same(r.folder, folder)));
    } catch (_) { exists = false; }
    if (!exists) { await proceed(); return; }
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t('livery_override_title'),
      () => <p>{t('livery_override_body', { folder })}</p>,
      () => (
        <>
          <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
          <button className="btn-danger" onClick={() => { hideModal(); proceed(); }}>{t('modal_btn_overwrite')}</button>
        </>
      )
    );
  };

  const loadBaseUrl = (file) => {
    confirmDiscard(async () => {
      if (!file) return;
      setBusy(true);
      try {
        const raw = await fileToDataUrl(file);
        const normalized = await normalizeToTexture(raw, 'transparent');
        setBase({ imageDataUrl: normalized });
        setCanvasKey(k => k + 1);
      } catch (err) {
        useAppStore.getState().showToast(t(errKey(err && err.message)), 'error');
      } finally {
        setBusy(false);
      }
    });
  };

  const paintBaseUrl = base ? base.imageDataUrl || null : null;

  // Post-save nudge: a saved livery only shows up in-game once its mod is
  // enabled on the in-game "More Liveries" page. Shown after every successful
  // Save / Save As unless the user ticked "Don't show again" (persisted as the
  // `liveryModHintDismissed` flag in cache.json).
  const showModHint = async () => {
    let dismissed = false;
    try {
      const st = await electronAPI.getCacheFlag('liveryModHintDismissed');
      dismissed = Boolean(st && st.success && st.value);
    } catch (_) { dismissed = false; }
    if (dismissed) return;
    const { showModal, hideModal } = useAppStore.getState();
    let dontShow = false;
    showModal(
      () => t('livery_mod_hint_title'),
      () => (
        <div>
          <p>{t('livery_mod_hint_body')}</p>
          <label className="modal-checkbox-row">
            <input type="checkbox" className="modal-checkbox" onChange={(e) => { dontShow = e.target.checked; }} />
            <span>{t('livery_mod_hint_dont_show')}</span>
          </label>
        </div>
      ),
      () => (
        <button
          className="btn-confirm"
          onClick={() => {
            hideModal();
            if (dontShow) Promise.resolve(electronAPI.setCacheFlag('liveryModHintDismissed', true)).catch(() => {});
          }}
        >{t('modal_btn_ok')}</button>
      )
    );
  };

  // Only manifest-truth fields are sent (airline + targetPlaneId) plus the
  // free-form folder name; the backend derives everything else.
  const submitCreate = async (imageDataUrl, targetAirline, targetPlaneId, targetFolder) => {
    const folder = String(targetFolder || '').trim();
    if (!imageDataUrl || !/^[A-Z]{3}$/.test(targetAirline) || !PLANE_ID_TO_SHORT_CODE[targetPlaneId] || !LIVERY_FOLDER_SAFE_RE.test(folder) || busy) return false;
    setBusy(true);
    try {
      const res = await electronAPI.createLivery({
        imageDataUrl,
        airline: targetAirline,
        targetPlaneId,
        folder,
      });
      const { showToast } = useAppStore.getState();
      if (res && res.success) {
        CreateTab.prefill = null;
        dirtyRef.current = false;
        showToast(t('livery_created'), 'success');
        if (onCreated) onCreated();
        showModHint();
        return true;
      }
      showToast(t(errKey(res && res.error)), 'error');
      return false;
    } catch (err) {
      useAppStore.getState().showToast(err.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Save / Save As share one naming dialog: the typed name becomes the
  // livery folder name verbatim (free-form). Airline + aircraft come from the
  // caller (origin snapshot for Save, live form for Save As) and only feed
  // the manifest.
  const openSaveDialog = (initialFolder, isSaveAs, targetAirline, targetPlaneId) => {
    if (!canvasRef.current || busy || !initialFolder) return;
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t(isSaveAs ? 'livery_save_as' : 'livery_save'),
      <SaveNameDialog
        initial={initialFolder}
        isSaveAs={isSaveAs}
        onConfirm={(folder) => {
          const imageDataUrl = canvasRef.current.exportPNG();
          hideModal();
          confirmOverride(folder, isSaveAs, () => submitCreate(imageDataUrl, targetAirline, targetPlaneId, folder));
        }}
      />,
    );
  };

  // Save: name prefilled with the origin folder (new liveries: current form).
  // Keeps the origin's airline/aircraft — renaming the folder never reassigns
  // the livery to a different plane.
  const handleSave = () => {
    if (isReference) return;
    const useOrigin = Boolean(origin);
    openSaveDialog(
      origin ? origin.folder : folderPreview,
      false,
      useOrigin ? origin.airline : airline,
      useOrigin ? origin.planeId : planeId,
    );
  };

  // Save As: name prefilled with the conventional form folder; airline +
  // aircraft come from the live form.
  const handleSaveAs = () => {
    if (!formValid) return;
    openSaveDialog(folderPreview, true, airline, planeId);
  };

  const handleCancel = () => {
    confirmDiscard(() => {
      CreateTab.prefill = null;
      dirtyRef.current = false;
      if (onCancel) onCancel();
      else if (onCreated) onCreated();
    });
  };

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
      const normalized = await normalizeToTexture(res.imageDataUrl, 'transparent');
      confirmDiscard(() => {
        setBase({ imageDataUrl: normalized });
        setCanvasKey(k => k + 1);
      });
      if (res.manifest && res.manifest.airline) setAirline(String(res.manifest.airline).toUpperCase());
      if (res.manifest && PLANE_ID_TO_SHORT_CODE[res.manifest.targetPlaneId]) setPlaneId(res.manifest.targetPlaneId);
      showToast(t('livery_loadzip_loaded', { folder: res.folder || '' }), 'success');
    } catch (err) {
      useAppStore.getState().showToast(t(errKey(err && err.message)), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Export: save the current canvas to its target folder, then zip it to a
  // user-chosen directory (folder picker). Existing liveries keep their
  // folder; new ones use the conventional default.
  const handleExport = async () => {
    if (!canvasRef.current || exporting || busy) return;
    const useOrigin = Boolean(origin) && !isReference;
    const targetAirline = useOrigin ? origin.airline : airline;
    const targetPlaneId = useOrigin ? origin.planeId : planeId;
    const targetFolder = useOrigin ? origin.folder : folderPreview;
    if (!/^[A-Z]{3}$/.test(targetAirline) || !PLANE_ID_TO_SHORT_CODE[targetPlaneId] || !targetFolder) return;
    setExporting(true);
    const { showToast } = useAppStore.getState();
    try {
      const res = await electronAPI.createLivery({
        imageDataUrl: canvasRef.current.exportPNG(),
        airline: targetAirline,
        targetPlaneId,
        folder: targetFolder,
      });
      if (!res || !res.success) {
        showToast(t(errKey(res && res.error)), 'error');
        return;
      }
      dirtyRef.current = false;
      const folder = res.folder || targetFolder;
      const exp = await electronAPI.exportLiveryToDir(folder);
      if (!exp || exp.canceled) return;
      if (!exp.success) {
        showToast(t(errKey(exp.error)), 'error');
        return;
      }
      showToast(t('livery_exported', { name: folder + '.zip' }), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setExporting(false);
    }
  };

  const canExport = formValid && !busy && !exporting;

  return (
    <div className="lp-root">
      <div className="lp-topbar">
        <div className="lp-group">
          <button className="lp-tool" {...bind(t('livery_tip_cancel'))} aria-label={t('livery_back')} onClick={handleCancel}>
            <IoArrowBack size={18} />
          </button>
          {onHelp && (
            <button className="lp-tool" onClick={onHelp}><IoHelpCircleOutline size={18} /></button>
          )}
          {isReference && (
            <span className="lp-lock" {...bind(t('livery_tip_readonly'))}>
              <IoLockClosed size={13} />
            </span>
          )}
          <span className="lp-sep" />
          <AirlineAircraftFields airline={airline} setAirline={setAirline} planeId={planeId} setPlaneId={setPlaneId} />
        </div>

        <div className="lp-group lp-group-end">
          <span className="lp-tipwrap" {...bind(t('livery_import_image'))}>
            <button className="lp-tool" aria-label={t('livery_import_image')} disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}>
              <IoImageOutline size={18} />
            </button>
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".png,.jpg,.jpeg"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; loadBaseUrl(f); }}
          />
          <span className="lp-tipwrap" {...bind(t('livery_import_zip'))}>
            <button className="lp-tool" aria-label={t('livery_import_zip')} disabled={busy} onClick={handleLoadZip}>
              <FaFileImport size={18} />
            </button>
          </span>
          <span className="lp-tipwrap" {...bind(t('livery_export_zip'))}>
            <button className="lp-tool" aria-label={t('livery_export_zip')} disabled={!canExport} onClick={handleExport}>
              <FaFileExport size={18} />
            </button>
          </span>
          <span className="lp-sep" />
          <span className="lp-tipwrap" {...bind(t('livery_tip_save_as'))}>
            <button className="lp-tool" aria-label={t('livery_save_as')} disabled={!formValid || busy} onClick={handleSaveAs}><MdSaveAs size={18} /></button>
          </span>
          <span className="lp-tipwrap" {...bind(isReference ? t('livery_tip_readonly') : t('livery_tip_save'))}>
            <button className="lp-tool lp-primary" aria-label={t('livery_save')} disabled={!canSave || busy} onClick={handleSave}><IoSaveOutline size={18} /></button>
          </span>
        </div>
      </div>

      <LiveryCanvas
        key={canvasKey}
        ref={canvasRef}
        initialImageDataUrl={paintBaseUrl}
        onDirty={markDirty}
      />
      {TooltipPortal}
    </div>
  );
}
CreateTab.prefill = null;
