import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { PLANE_ID_TO_SHORT_CODE, LIVERY_FOLDER_SAFE_RE, folderFor } from '../../utils/constants/livery';
import { CURATED_AIRLINE_CODES, airlineDisplayName } from '../../utils/constants/airlines';
import { fileToDataUrl, normalizeToTexture } from '../../utils/liveryImage';
import useTooltip from '../BrowserScreen/useTooltip';
import {
  IoLockClosed,
  IoArrowBack,
  IoImageOutline,
  IoSaveOutline,
  IoHelpCircleOutline,
  IoTrashOutline,
} from 'react-icons/io5';
import { FaSteam } from 'react-icons/fa';
import { MdSaveAs } from 'react-icons/md';
import { FaFileImport, FaFileExport } from 'react-icons/fa6';
import { FaRegFolderOpen } from 'react-icons/fa';
import LiveryCanvas from './LiveryCanvas';

function errKey(code) {
  return 'livery_err_' + String(code || 'unknown');
}

// Fallback aircraft list used until (or if) the game's built-in default
// liveries are scanned — see `list-aircraft-types`.
const PLANE_IDS = Object.keys(PLANE_ID_TO_SHORT_CODE);
// Sensible form defaults for a brand-new livery: the first airline (alphabetical
// code) and the A-319neo, so the painter is usable without touching the form.
const DEFAULT_AIRLINE = CURATED_AIRLINE_CODES[0];
const DEFAULT_PLANE_ID = 'AIRBUS A-319neo';

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

function AirlineAircraftFields({ airline, setAirline, planeId, setPlaneId, locked, planeIds }) {
  const { t, lang } = useTranslation();
  const airlineOptions = useMemo(() => {
    return [...CURATED_AIRLINE_CODES];
  }, []);
  // Scanned built-in types, plus the current value if it is not in the scan
  // (e.g. an imported zip / reference row for a type added after the scan).
  const aircraftOptions = useMemo(() => {
    const list = Array.isArray(planeIds) ? [...planeIds] : [];
    if (planeId && !list.includes(planeId)) list.unshift(planeId);
    return list;
  }, [planeIds, planeId]);
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
      {/* A <span>, not a <label>: a <button> inside a <label> makes Chromium
          re-focus the labelled input on click, which fired onFocus and
          immediately reopened the list right after an airline was picked. */}
      <span className={'lp-inline' + (locked ? ' lp-locked' : '')}>
        <span className="lp-inline-label">{t('livery_airline')}</span>
        <span className="lp-airline-wrap" ref={wrapRef}>
          <input
            type="text"
            value={airline}
            maxLength={3}
            placeholder="CCA"
            autoComplete="off"
            role="combobox"
            aria-label={t('livery_airline')}
            aria-expanded={open}
            aria-controls="livery-airline-list"
            disabled={locked}
            onChange={(e) => setAirline(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
            onFocus={() => { if (!locked) setOpen(true); }}
            onClick={() => { if (!locked) setOpen(true); }}
          />
          <button
            type="button"
            className="lp-airline-toggle"
            aria-label="airlines"
            disabled={locked}
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
                    onMouseDown={(e) => e.preventDefault()}
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
      </span>
      <label className={'lp-inline' + (locked ? ' lp-locked' : '')}>
        <span className="lp-inline-label">{t('livery_aircraft')}</span>
        <select value={planeId} disabled={locked} onChange={(e) => setPlaneId(e.target.value)}>
          {aircraftOptions.map(id => (
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
export default function CreateTab({ onCreated, onCancel, onHelp, onUpload, uploadOpen = false }) {
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
      // Manifest variant ("default" for every livery written so far). Carried
      // through so a future non-default variant survives Save As / export; a
      // blank value lets the main process read it off the folder's manifest.
      variant: String(prefill.variant || ''),
      pack: prefill.pack || 'mine',
      imageDataUrl: prefill.imageDataUrl || null,
    };
  }, [prefill]);
  const isReference = origin && origin.pack === 'reference';
  // Steam Workshop liveries are also read-only (Save/Delete disabled; use
  // Save As). Their folder lives in the Workshop content directory, which
  // must never be overwritten in place.
  const isWorkshop = origin && origin.pack === 'workshop';
  const isReadOnly = Boolean(isReference || isWorkshop);
  const readOnlyTip = isWorkshop ? t('livery_tip_readonly_workshop') : t('livery_tip_readonly');

  const [airline, setAirline] = useState(origin?.airline || prefill?.airline || DEFAULT_AIRLINE);
  const [planeId, setPlaneId] = useState(origin?.planeId || prefill?.targetPlaneId || DEFAULT_PLANE_ID);
  // Manifest variant (no UI yet — it flows through from a loaded zip/origin;
  // blank means "let the backend resolve it from the folder's manifest").
  const [variant, setVariant] = useState(origin?.variant || '');

  // Aircraft types are collected from the game's built-in default liveries;
  // the hardcoded table is the fallback if the scan is unavailable.
  const [planeOptions, setPlaneOptions] = useState(PLANE_IDS);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await electronAPI.listAircraftTypes();
        if (cancelled || !res || !res.success || !Array.isArray(res.types)) return;
        const ids = res.types.map(x => x && x.planeId).filter(Boolean);
        if (ids.length) setPlaneOptions(ids);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A type is valid when the table knows it, the game ships a built-in livery
  // for it, it is the origin/import of the livery currently open, or it was
  // explicitly requested as the pre-selected type for a new livery
  // (folder add-card passes { targetPlaneId } with no folder).
  const knownPlanes = useMemo(() => {
    const set = new Set(PLANE_IDS);
    for (const id of planeOptions) set.add(id);
    if (origin?.planeId) set.add(origin.planeId);
    if (prefill?.targetPlaneId) set.add(prefill.targetPlaneId);
    return set;
  }, [planeOptions, origin, prefill]);

  const airlineValid = /^[A-Z]{3}$/.test(airline);
  const folderPreview = planeId && airline ? folderFor(planeId, airline) : '';
  const formValid = Boolean(folderPreview && airlineValid && knownPlanes.has(planeId));

  // Paint state. The canvas is split into one 2048² panel per BaseMap part the
  // aircraft type ships (A388 → Fuselage + Wing, B38M → Fuselage + Wingtip,
  // everything else a single panel). Panels are primed, in priority order:
  // a user import → the saved livery's own part → the built-in UV template.
  const [templates, setTemplates] = useState([]);       // built-in parts (Clear + defaults)
  const [originImages, setOriginImages] = useState([]); // the opened livery's own parts
  const [overrides, setOverrides] = useState({});        // partName -> imported base
  const [activePanel, setActivePanel] = useState(0);
  const [canvasKey, setCanvasKey] = useState(0);
  const canvasRef = useRef(null);
  const dirtyRef = useRef(false);
  // Folder we just saved to. Save/Save As adopt the saved folder as the origin
  // (so a later Save overwrites in place), but the origin effect would then
  // re-read the freshly written FLATTENED PNGs and remount the canvas, baking
  // every live movable into the locked base — after which the eraser can no
  // longer remove them. This ref lets that one origin change skip the reload:
  // the live canvas is already the authoritative, unflattened state.
  const skipOriginReloadRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef(null);
  const { bind, TooltipPortal } = useTooltip();

  // Panel layout: the built-in parts are the source of truth; an opened livery
  // (or a zip that had no built-in scan) falls back to its own parts.
  const panels = useMemo(() => {
    const base = templates.length
      ? templates
      : (originImages.length ? originImages : [{ partName: 'Body' }]);
    return base.map(p => (p && p.partName) || 'Body');
  }, [templates, originImages]);
  const panelSig = panels.join('\u0001');
  const activeIdx = Math.min(Math.max(0, activePanel), panels.length - 1);

  const panelSigRef = useRef('');
  useEffect(() => { panelSigRef.current = panelSig; });
  const initialParts = useMemo(() => panels.map((partName, i) => {
    if (overrides[partName]) return { partName, imageDataUrl: overrides[partName] };
    // A prefill that already carries pixels (tests / direct callers) seeds the
    // primary panel without waiting on the async read.
    if (i === 0 && origin && origin.imageDataUrl) return { partName, imageDataUrl: origin.imageDataUrl };
    const own = originImages.find(p => ((p && p.partName) || 'Body') === partName);
    if (own && own.imageDataUrl) return { partName, imageDataUrl: own.imageDataUrl };
    // Legacy single-image origin (no per-part match) seeds the primary panel.
    if (i === 0 && originImages.length === 1 && originImages[0].imageDataUrl) {
      return { partName, imageDataUrl: originImages[0].imageDataUrl };
    }
    const tmpl = templates.find(p => ((p && p.partName) || 'Body') === partName);
    if (tmpl && tmpl.imageDataUrl) return { partName, imageDataUrl: tmpl.imageDataUrl };
    return { partName, imageDataUrl: null };
  }), [panelSig, overrides, originImages, templates]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultParts = useMemo(() => panels.map(partName => {
    const tmpl = templates.find(p => ((p && p.partName) || 'Body') === partName);
    return { partName, imageDataUrl: tmpl ? tmpl.imageDataUrl : null };
  }), [panelSig, templates]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save targets the live form (its Airline/Aircraft are the livery's identity,
  // and it prefills the new conventional folder when they changed); Save As
  // targets the live form folder too. Reference (locked) origins can never
  // Save — only Save As.
  const canSaveAs = formValid && !busy;
  const canSave = !isReadOnly && formValid && !busy;

  // Unsaved-changes guard consulted by LiveryScreen tab-leave/back.
  useEffect(() => {
    window.__liveryPaintGuard = { isDirty: () => dirtyRef.current };
    return () => { window.__liveryPaintGuard = null; };
  }, []);
  const markDirty = (v) => { dirtyRef.current = v; };

  // Load the opened livery's own paintable parts (all panels for a multi-image
  // A388/B38M; a single part otherwise), falling back to the single main-part
  // image for an older main process.
  useEffect(() => {
    if (!origin || !origin.folder) return;
    // The origin just changed to a folder WE saved to: keep the live canvas
    // (base + rasters + moveable objects) instead of reloading the flattened
    // PNGs from disk. Consume the marker either way so a stale folder name can
    // never suppress a genuine reload later.
    if (skipOriginReloadRef.current !== null) {
      const skip = skipOriginReloadRef.current === origin.folder;
      skipOriginReloadRef.current = null;
      if (skip) return;
    }
    let cancelled = false;
    (async () => {
      try {
        let parts = null;
        try {
          const res = await electronAPI.readLiveryImages(origin.folder, origin.pack);
          if (res && res.success && Array.isArray(res.parts) && res.parts.length) {
            parts = res.parts.map(p => ({ partName: (p && p.partName) || 'Body', imageDataUrl: p && p.imageDataUrl }));
          }
        } catch (_) {}
        if (!parts) {
          const res = await electronAPI.readLiveryImage(origin.folder, origin.pack);
          if (res && res.success && res.imageDataUrl) parts = [{ partName: 'Body', imageDataUrl: res.imageDataUrl }];
        }
        if (!cancelled && parts) {
          setOriginImages(parts);
          // Never clobber a canvas the user has already painted on.
          if (!dirtyRef.current) setCanvasKey(k => k + 1);
        }
      } catch (_) {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin?.folder, origin?.pack]);

  // Aircraft type's built-in UV template parts (the game's own default livery).
  // Fetched whenever a type is known — including when editing a saved livery —
  // so the painter can lay out the right number of panels and Clear can always
  // restore the type default. The template only seeds panels the opened livery
  // (or an import) does not already fill.
  useEffect(() => {
    if (!planeId) { setTemplates([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await electronAPI.getAircraftTemplate(planeId);
        if (cancelled || !res || !res.success) return;
        const parts = Array.isArray(res.parts) && res.parts.length
          ? res.parts.map(p => ({ partName: (p && p.partName) || 'Body', imageDataUrl: p && p.imageDataUrl }))
          : (res.imageDataUrl ? [{ partName: res.partName || 'Body', imageDataUrl: res.imageDataUrl }] : []);
        if (!parts.length) return;
        const nextSig = parts.map(p => p.partName || 'Body').join('\u0001');
        const layoutChanged = nextSig !== panelSigRef.current;
        setTemplates(parts);
        // Re-seed the canvas only when the panel layout changed (single ↔
        // multi-image type) or the canvas is still untouched (new livery).
        // A painted canvas keeps its pixels when only the form type changes.
        if (layoutChanged || (!origin && !dirtyRef.current)) setCanvasKey(k => k + 1);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planeId]);

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
    const ownFolder = !isSaveAs && origin && origin.pack !== 'reference' && origin.pack !== 'workshop' ? origin.folder : null;
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

  // Import an image into the ACTIVE panel only (multi-image aircraft); for a
  // single-panel type that is the whole canvas, exactly as before. The base is
  // swapped IN PLACE (no canvas remount) so the pen/fill rasters, live objects
  // and every other panel survive — the import replaces only this panel's base.
  // It therefore never needs the unsaved-changes guard: nothing is discarded.
  const loadBaseUrl = (file) => {
    if (!file) return;
    (async () => {
      setBusy(true);
      try {
        const raw = await fileToDataUrl(file);
        const normalized = await normalizeToTexture(raw);
        // Keep the override map current so a later remount (e.g. an aircraft
        // type change) still re-primes this panel with the imported base.
        setOverrides(prev => ({ ...prev, [panels[activeIdx] || 'Body']: normalized }));
        const canvas = canvasRef.current;
        if (canvas && typeof canvas.setPanelBase === 'function') {
          canvas.setPanelBase(activeIdx, normalized);
        } else {
          // Fallback for a canvas without the in-place API (should not happen).
          setCanvasKey(k => k + 1);
        }
      } catch (err) {
        useAppStore.getState().showToast(t(errKey(err && err.message)), 'error');
      } finally {
        setBusy(false);
      }
    })();
  };

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
  // free-form folder name and the per-panel images; the backend derives the
  // file names, part bindings and manifest id.
  const submitCreate = async (images, targetAirline, targetPlaneId, targetFolder, targetVariant) => {
    const folder = String(targetFolder || '').trim();
    if (!Array.isArray(images) || images.length === 0 || !/^[A-Z]{3}$/.test(targetAirline) || !knownPlanes.has(targetPlaneId) || !LIVERY_FOLDER_SAFE_RE.test(folder) || busy) return false;
    setBusy(true);
    try {
      // The variant is omitted when blank: the backend then keeps the folder's
      // existing variant (or defaults it), which is the common path.
      const reqVariant = String(targetVariant || '').trim();
      const res = await electronAPI.createLivery({
        images,
        airline: targetAirline,
        targetPlaneId,
        folder,
        ...(reqVariant ? { variant: reqVariant } : {}),
      });
      const { showToast } = useAppStore.getState();
      if (res && res.success) {
        // Stay in the painter after Save / Save As: adopt the saved folder as
        // the current livery (so a later Save overwrites it in place) and do
        // NOT call onCreated (which navigates back to the list).
        // Mark this origin change so the origin effect keeps the live canvas
        // rather than reloading the flattened PNGs it just wrote (which would
        // rasterise every movable into the locked base).
        skipOriginReloadRef.current = folder;
        CreateTab.prefill = { folder, airline: targetAirline, targetPlaneId, variant: reqVariant || '', pack: 'mine' };
        dirtyRef.current = false;
        showToast(t('livery_created'), 'success');
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
  const openSaveDialog = (initialFolder, isSaveAs, targetAirline, targetPlaneId, targetVariant) => {
    if (!canvasRef.current || busy || !initialFolder) return;
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t(isSaveAs ? 'livery_save_as' : 'livery_save'),
      <SaveNameDialog
        initial={initialFolder}
        isSaveAs={isSaveAs}
        onConfirm={(folder) => {
          const images = canvasRef.current.exportParts();
          hideModal();
          confirmOverride(folder, isSaveAs, () => submitCreate(images, targetAirline, targetPlaneId, folder, targetVariant));
        }}
      />,
    );
  };

  // Save: the form's Airline/Aircraft ARE the livery's identity, so they always
  // feed the manifest. The dialog's default name follows them: while they match
  // the origin it stays the origin folder (preserving a free-form name and
  // overwriting in place); once either changed it prefills the new conventional
  // {TYPE}_{AIRLINE} folder so the config file's name/airline/targetPlaneId can
  // be updated — the user still decides the final name (typing the origin folder
  // back saves in place). New liveries prefill with the form folder.
  const handleSave = () => {
    if (isReadOnly) return;
    const formChanged = Boolean(origin) && (origin.airline !== airline || origin.planeId !== planeId);
    openSaveDialog(
      origin && !formChanged ? origin.folder : folderPreview,
      false,
      airline,
      planeId,
      variant,
    );
  };

  // Save As: name prefilled with the conventional form folder; airline +
  // aircraft come from the live form.
  const handleSaveAs = () => {
    if (!formValid) return;
    openSaveDialog(folderPreview, true, airline, planeId, variant);
  };

  // Ctrl+S = Save, Ctrl+Shift+S = Save As (the toolbar buttons). Ignored while
  // typing, while a modal (e.g. the naming dialog) is open, or while the
  // Workshop upload dialog overlays the painter (it owns the keyboard —
  // popping a save prompt over it would strand both dialogs).
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
      try { if (document.getElementById('livery-upload-overlay')) return; } catch (_) {}
      const el = e.target;
      const tag = (el && el.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
      if (useAppStore.getState().modal && useAppStore.getState().modal.open) return;
      e.preventDefault();
      if (e.shiftKey) { if (canSaveAs) handleSaveAs(); }
      else if (canSave) handleSave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSave, canSaveAs, handleSave, handleSaveAs]);

  const handleCancel = () => {
    confirmDiscard(() => {
      CreateTab.prefill = null;
      dirtyRef.current = false;
      if (onCancel) onCancel();
      else if (onCreated) onCreated();
    });
  };

  // True delete: only an existing custom livery can be removed (reference +
  // workshop are read-only; a brand-new unsaved livery has no folder yet).
  // Removes the folder entirely — the same action as the list page's Delete.
  const canDelete = Boolean(origin) && !isReadOnly && !busy;
  const handleDelete = () => {
    if (!canDelete) return;
    const folder = origin.folder;
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t('livery_delete_confirm_title'),
      () => <p>{t('livery_delete_confirm_body', { folder })}</p>,
      () => (
        <>
          <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
          <button className="btn-danger" onClick={async () => {
            hideModal();
            const { showToast } = useAppStore.getState();
            try {
              const res = await electronAPI.deleteLivery(folder);
              if (!res || !res.success) { showToast(t(errKey(res && res.error)), 'error'); return; }
              CreateTab.prefill = null;
              dirtyRef.current = false;
              showToast(t('livery_deleted'), 'success');
              if (onCreated) onCreated();
              else if (onCancel) onCancel();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }}>{t('livery_delete')}</button>
        </>
      )
    );
  };

  // Open the livery's folder in the OS file explorer. A saved livery opens its
  // own folder (mine/reference/workshop); a brand-new unsaved livery opens the
  // own pack dir — the backend resolves that fallback.
  const handleOpenFolder = async () => {
    try {
      const res = await electronAPI.revealLiveryFolder(origin?.folder || null, origin?.pack || 'mine');
      if (!res || !res.success) {
        const code = res && res.error;
        const known = typeof code === 'string' && /^[A-Z_]+$/.test(code);
        useAppStore.getState().showToast(t(known ? errKey(code) : 'livery_open_folder_failed'), 'error');
      }
    } catch (err) {
      useAppStore.getState().showToast(err.message, 'error');
    }
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
      const srcParts = (Array.isArray(res.parts) && res.parts.length)
        ? res.parts
        : [{ partName: 'Body', imageDataUrl: res.imageDataUrl }];
      const parts = [];
      for (const p of srcParts) {
        const normalized = await normalizeToTexture(p.imageDataUrl);
        parts.push({ partName: (p && p.partName) || 'Body', imageDataUrl: normalized });
      }
      confirmDiscard(() => {
        setOriginImages(parts);
        setOverrides({});
        setCanvasKey(k => k + 1);
      });
      if (res.manifest && res.manifest.airline) setAirline(String(res.manifest.airline).toUpperCase());
      if (res.manifest && knownPlanes.has(res.manifest.targetPlaneId)) setPlaneId(res.manifest.targetPlaneId);
      if (res.manifest) setVariant(res.manifest.variant != null ? String(res.manifest.variant) : '');
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
    const useOrigin = Boolean(origin) && !isReadOnly;
    const targetAirline = useOrigin ? origin.airline : airline;
    const targetPlaneId = useOrigin ? origin.planeId : planeId;
    const targetFolder = useOrigin ? origin.folder : folderPreview;
    const targetVariant = useOrigin ? origin.variant : variant;
    if (!/^[A-Z]{3}$/.test(targetAirline) || !knownPlanes.has(targetPlaneId) || !targetFolder) return;
    setExporting(true);
    const { showToast } = useAppStore.getState();
    try {
      const reqVariant = String(targetVariant || '').trim();
      const res = await electronAPI.createLivery({
        images: canvasRef.current.exportParts(),
        airline: targetAirline,
        targetPlaneId,
        folder: targetFolder,
        ...(reqVariant ? { variant: reqVariant } : {}),
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

  // Workshop upload: saved `mine` liveries only (not reference/workshop, not
  // a brand-new unsaved livery). A dirty canvas is silently saved in place
  // first, then the upload dialog opens for the folder.
  const canUpload = Boolean(origin) && !isReadOnly && origin.pack === 'mine' && formValid && !busy;
  // Grayed-out (and not read-only) means there is nothing saved to upload
  // yet — the hover tip says so.
  const uploadTip = isReadOnly
    ? readOnlyTip
    : (canUpload ? t('livery_upload_tip') : `${t('livery_upload_tip')} ${t('livery_upload_tip_save_first')}`);
  const handleUpload = async () => {
    if (!canUpload || !canvasRef.current) return;
    if (dirtyRef.current) {
      const ok = await submitCreate(canvasRef.current.exportParts(), origin.airline, origin.planeId, origin.folder);
      if (!ok) return;
    }
    if (onUpload) onUpload(origin.folder);
  };

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
          {isReadOnly && (
            <span className="lp-lock" {...bind(readOnlyTip)}>
              <IoLockClosed size={13} />
            </span>
          )}
          <span className="lp-sep" />
          <AirlineAircraftFields airline={airline} setAirline={setAirline} planeId={planeId} setPlaneId={setPlaneId} locked={isReadOnly} planeIds={planeOptions} />
        </div>

        <div className="lp-group lp-group-end">
          <span className="lp-tipwrap" {...bind(t('livery_open_folder'))}>
            <button className="lp-tool" aria-label={t('livery_open_folder')} disabled={busy} onClick={handleOpenFolder}>
              <FaRegFolderOpen size={18} />
            </button>
          </span>
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
          <span className="lp-tipwrap" {...bind(uploadTip)}>
            <button className="lp-tool" aria-label={t('livery_upload')} disabled={!canUpload} onClick={handleUpload}>
              <FaSteam size={18} />
            </button>
          </span>
          <span className="lp-sep" />
          <span className="lp-tipwrap" {...bind(isReadOnly ? readOnlyTip : t('livery_tip_delete'))}>
            <button className="lp-tool" aria-label={t('livery_delete')} disabled={!canDelete} onClick={handleDelete}><IoTrashOutline size={18} /></button>
          </span>
          <span className="lp-tipwrap" {...bind(t('livery_tip_save_as'))}>
            <button className="lp-tool" aria-label={t('livery_save_as')} disabled={!formValid || busy} onClick={handleSaveAs}><MdSaveAs size={18} /></button>
          </span>
          <span className="lp-tipwrap" {...bind(isReadOnly ? readOnlyTip : t('livery_tip_save'))}>
            <button className="lp-tool lp-primary" aria-label={t('livery_save')} disabled={!canSave || busy} onClick={handleSave}><IoSaveOutline size={18} /></button>
          </span>
        </div>
      </div>

      <LiveryCanvas
        key={`${canvasKey}:${panelSig}`}
        ref={canvasRef}
        panels={panels}
        initialParts={initialParts}
        defaultParts={defaultParts}
        activePanel={activeIdx}
        onActivePanel={setActivePanel}
        onDirty={markDirty}
        inputDisabled={uploadOpen}
      />
      {TooltipPortal}
    </div>
  );
}
CreateTab.prefill = null;
