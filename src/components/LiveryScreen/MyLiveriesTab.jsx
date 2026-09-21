import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { airlineDisplayName } from '../../utils/constants/airlines';
import { IoChevronForward, IoChevronDown, IoFolderOutline, IoLockClosed } from 'react-icons/io5';
import { FaSteam } from 'react-icons/fa6';
import { MdAdd } from 'react-icons/md';
import useTooltip from '../BrowserScreen/useTooltip';

function errKey(code) {
  return 'livery_err_' + String(code || 'unknown');
}

export default function MyLiveriesTab({ onEdit, onCreate, onUpload, search = '', cmdRef, scrollRef, onBarState }) {
  const { t, lang } = useTranslation();
  const electronAPI = useElectronAPI();
  const [mine, setMine] = useState([]);
  const [reference, setReference] = useState([]);
  // Steam Workshop liveries (read-only, discovered on disk). Empty on a
  // non-Steam install (the backend resolver is best-effort).
  const [workshop, setWorkshop] = useState([]);
  // Every aircraft type the game ships (source for empty folders). Rows whose
  // type is missing from the scan are still shown (union below).
  const [allTypes, setAllTypes] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [loading, setLoading] = useState(true);
  // Collapsed aircraft groups, keyed by targetPlaneId ('' = unknown).
  // Mine + reference share one folder set; reference rows are read-only.
  const [collapsed, setCollapsed] = useState(new Set());
  // Selected own-pack folders (reference never selectable). The card checkbox
  // drives export / delete in the header bar via cmdRef.
  const [selected, setSelected] = useState(new Set());
  const { bind, TooltipPortal } = useTooltip();

  // Live mirrors for the imperative cmdRef commands (published below in a
  // passive effect). Those handles are invoked from outside React's render /
  // event cycle — the header bar, keyboard shortcuts, and tests calling
  // cmdRef.current right after a commit — so a handle captured by an earlier
  // render's closure could still see the pre-load list (mine=[]) and silently
  // act on nothing. Updated during render, the refs make every published
  // handle operate on the latest state regardless of which render it came from.
  const mineRef = useRef(mine);
  const selectedRef = useRef(selected);
  mineRef.current = mine;
  selectedRef.current = selected;

  // One folder set across all packs (mine rows carry pack:'mine' for
  // thumbnails/actions, reference + workshop rows are read-only).
  const allRows = useMemo(() => [
    ...mine.map(r => ({ ...r, pack: 'mine' })),
    ...reference.map(r => ({ ...r, pack: 'reference' })),
    ...workshop.map(r => ({ ...r, pack: 'workshop' })),
  ], [mine, reference, workshop]);

  // Header search filter: folder, airline code/name, aircraft, manifest name.
  const filteredRows = useMemo(() => {
    const q = String(search || '').trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(r => (
      [r.folder, r.airline, airlineDisplayName(r.airline, lang), r.targetPlaneId, r.name]
        .some(v => String(v || '').toLowerCase().includes(q))
    ));
  }, [allRows, search, lang]);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await electronAPI.listLiveries();
      if (res && res.success) {
        setMine(res.mine || []);
        setReference(res.reference || []);
        setWorkshop(res.workshop || []);
      } else {
        const { showToast } = useAppStore.getState();
        showToast(t(errKey(res && res.error)), 'error');
      }
    } catch (err) {
      const { showToast } = useAppStore.getState();
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
    // Aircraft-type scan is best-effort: a failed scan just means empty
    // folders are not shown (row-backed groups still render).
    try {
      const typeRes = await electronAPI.listAircraftTypes();
      if (typeRes && typeRes.success && Array.isArray(typeRes.types)) {
        setAllTypes(typeRes.types.map(x => x && x.planeId).filter(Boolean));
      }
    } catch (_) {}
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy low-res thumbnails (mine + reference). The list never pulls the
  // full 2048×2048 texture — `read-livery-thumbnail` serves a ~256px JPEG
  // (≈20KB vs several MB). Only expanded, currently-filtered rows are
  // fetched, 4 at a time, so opening the page with a big reference pack
  // stays instant. The painter loads the full texture on demand (it
  // lazy-loads via readLiveryImage when prefill carries no imageDataUrl).
  // Keys already fetched. A dedicated Set — NEVER a mirror of the state
  // object: writing into the mirrored object mutates state in place, which
  // makes the setThumbs updater below see prev[key] set and bail out, so
  // the list would never re-render (all cards stuck empty).
  const fetchedRef = useRef(new Set());
  useEffect(() => {
    let cancelled = false;
    const visible = filteredRows.filter(r => !collapsed.has(r.targetPlaneId || ''));
    const missing = visible.filter(r => !fetchedRef.current.has(r.pack + ':' + r.folder));
    if (missing.length === 0) return () => { cancelled = true; };
    // Per-call fallback: if the thumbnail channel is missing (e.g. the
    // running Electron main/preload predates it — Vite HMR only hot-swaps
    // the renderer, main + preload need an app restart), `invoke` rejects.
    // Fall back to the full image so cards never stay empty.
    const readThumb = async (folder, pack) => {
      if (electronAPI.readLiveryThumbnail) {
        try {
          const res = await electronAPI.readLiveryThumbnail(folder, pack);
          if (res && res.success && res.imageDataUrl) return res;
        } catch (_) {}
      }
      return electronAPI.readLiveryImage(folder, pack);
    };
    (async () => {
      const CONCURRENCY = 4;
      for (let i = 0; i < missing.length; i += CONCURRENCY) {
        if (cancelled) return;
        const batch = missing.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (row) => {
          const key = row.pack + ':' + row.folder;
          if (fetchedRef.current.has(key)) return;
          try {
            const res = await readThumb(row.folder, row.pack);
            if (!cancelled && res && res.success && res.imageDataUrl) {
              fetchedRef.current.add(key);
              setThumbs(prev => (prev[key] ? prev : { ...prev, [key]: res.imageDataUrl }));
            }
          } catch (_) {}
        }));
      }
    })();
    return () => { cancelled = true; };
  }, [filteredRows, collapsed]); // eslint-disable-line react-hooks/exhaustive-deps

  // After an in-place delete shrinks the list, keep the current scroll offset
  // but cap it to the new content maximum (deleting too much would otherwise
  // leave scrollTop past the end). Runs before paint so there is no jump.
  useLayoutEffect(() => {
    const el = scrollRef && scrollRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop > max) el.scrollTop = max;
  }, [mine, scrollRef]);

  const toggleGroup = (planeId) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(planeId)) next.delete(planeId);
      else next.add(planeId);
      return next;
    });
  };

  // One confirm/delete path shared by the header delete button (acts on the
  // one or many selected folders). Cards no longer carry their own actions.
  const confirmDelete = (folders) => {
    if (!folders || folders.length === 0) return;
    const single = folders.length === 1;
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t('livery_delete_confirm_title'),
      () => <p>{single
        ? t('livery_delete_confirm_body', { folder: folders[0] })
        : t('livery_delete_multi_body', { n: folders.length })}</p>,
      () => (
        <>
          <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
          <button className="btn-danger" onClick={async () => {
            hideModal();
            const { showToast } = useAppStore.getState();
            const deleted = [];
            for (const folder of folders) {
              try {
                const res = await electronAPI.deleteLivery(folder);
                if (res && res.success) deleted.push(folder);
                else showToast(t(errKey(res && res.error)), 'error');
              } catch (err) {
                showToast(err.message, 'error');
              }
            }
            setSelected(prev => {
              const next = new Set(prev);
              folders.forEach(f => next.delete(f));
              return next;
            });
            // Drop only the deleted rows in place: a full list refresh would
            // toggle the loading placeholder, unmounting the list and losing
            // the scroll position. Removing rows shrinks the content and the
            // layout effect below caps scrollTop to the new maximum.
            if (deleted.length > 0) {
              const gone = new Set(deleted);
              setMine(prev => prev.filter(r => !gone.has(r.folder)));
              showToast(single ? t('livery_deleted') : t('livery_deleted_multi', { n: deleted.length }), 'success');
            }
          }}>{t('livery_delete')}</button>
        </>
      )
    );
  };

  const handleExport = async (folder) => {
    try {
      const exp = await electronAPI.exportLivery(folder);
      const { showToast } = useAppStore.getState();
      if (!exp || !exp.success) {
        showToast(t(errKey(exp && exp.error)), 'error');
        return;
      }
      const saved = await electronAPI.saveLiveryDialog({ sourcePath: exp.filePath, suggestedName: folder + '.zip' });
      if (!saved || saved.canceled) return; // save-dialog cancel path: stay silent
      if (saved.success) showToast(t('livery_exported', { name: folder + '.zip' }), 'success');
      else showToast(t(errKey(saved.error)), 'error');
    } catch (err) {
      useAppStore.getState().showToast(err.message, 'error');
    }
  };

  const groupTitle = (planeId) => {
    return planeId || t('livery_unknown_aircraft');
  };

  const renderMineCard = (row) => (
    <div
      className={'livery-card clickable' + (selected.has(row.folder) ? ' selected' : '')}
      key={'mine:' + row.folder}
      onClick={(e) => {
        if (e.target.closest('button, input, select, a, label')) return;
        // Pass no pixels — the painter lazy-loads the full 2048 texture.
        // (thumbs[] is only a 256px list preview, never paintable data.)
        if (onEdit) onEdit({ ...row, pack: 'mine', imageDataUrl: null });
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, select, a, label') && onEdit) {
          e.preventDefault();
          onEdit({ ...row, pack: 'mine', imageDataUrl: null });
        }
      }}
      tabIndex={0}
      title={t('livery_tip_edit')}
    >
      <div className="livery-thumb">
        {thumbs['mine:' + row.folder] && <img src={thumbs['mine:' + row.folder]} alt={row.folder} />}
        <label className="livery-check" {...bind(t('livery_tip_select'))} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="livery-select"
            checked={selected.has(row.folder)}
            onChange={() => toggleSelect(row.folder)}
          />
        </label>
      </div>
      <div className="livery-meta">
        <strong>{airlineDisplayName(row.airline, lang)}</strong>
      </div>
      {row.error && <div className="livery-meta">{t(errKey(row.error))}</div>}
    </div>
  );

  const renderRefCard = (row) => (
    <div
      className="livery-card clickable"
      key={'ref:' + row.folder}
      onClick={(e) => {
        if (e.target.closest('button, input, select, a')) return;
        // Pass no pixels — the painter lazy-loads the full 2048 texture.
        if (onEdit) onEdit({ ...row, pack: 'reference', imageDataUrl: null });
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, select, a') && onEdit) {
          e.preventDefault();
          onEdit({ ...row, pack: 'reference', imageDataUrl: null });
        }
      }}
      tabIndex={0}
      title={t('livery_tip_edit')}
    >
      <div className="livery-thumb">
        {thumbs['reference:' + row.folder] && <img src={thumbs['reference:' + row.folder]} alt={row.folder} />}
      </div>
      <div className="livery-meta">
        <strong>{airlineDisplayName(row.airline, lang)}</strong>
        {' '}
        <span className="livery-readonly" {...bind(t('livery_tip_readonly'))}>
          <IoLockClosed size={12} />
        </span>
      </div>
    </div>
  );

  // Steam Workshop livery: read-only, click to open in the painter (Save As
  // only). `folder` is the path relative to the Workshop content root.
  const renderWorkshopCard = (row) => (
    <div
      className="livery-card clickable"
      key={'ws:' + row.folder}
      onClick={(e) => {
        if (e.target.closest('button, input, select, a')) return;
        if (onEdit) onEdit({ ...row, pack: 'workshop', imageDataUrl: null });
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, select, a') && onEdit) {
          e.preventDefault();
          onEdit({ ...row, pack: 'workshop', imageDataUrl: null });
        }
      }}
      tabIndex={0}
      title={t('livery_tip_readonly_workshop')}
    >
      <div className="livery-thumb">
        {thumbs['workshop:' + row.folder] && <img src={thumbs['workshop:' + row.folder]} alt={row.folder} />}
      </div>
      <div className="livery-meta">
        <strong>{airlineDisplayName(row.airline, lang)}</strong>
        {' '}
        <span className="livery-readonly livery-workshop" {...bind(t('livery_tip_readonly_workshop'))}>
          <IoLockClosed size={12} />
        </span>
      </div>
    </div>
  );

  // New-livery shortcut for one aircraft folder: prefers the explicit
  // onCreate(planeId) prop, falls back to onEdit({ targetPlaneId }) which
  // CreateTab treats as a brand-new livery with the type pre-selected
  // (no folder => origin is null => form initialises from prefill).
  const handleAdd = (planeId) => {
    if (onCreate) { onCreate(planeId); return; }
    if (onEdit) onEdit({ targetPlaneId: planeId });
  };

  const renderAddCard = (planeId) => {
    if (!planeId) return null;
    return (
      <button
        type="button"
        key={'add:' + planeId}
        className="livery-card livery-add-card"
        onClick={() => handleAdd(planeId)}
        title={t('livery_tip_add_for_type')}
        aria-label={t('livery_tip_add_for_type')}
      >
        <span className="livery-add-icon" aria-hidden="true">
          <MdAdd size={28} />
        </span>
        <span className="livery-add-text">{t('livery_add_livery')}</span>
      </button>
    );
  };

  // Collapsible folder-like group per aircraft type. Mine + reference +
  // workshop rows share one folder set; reference/workshop cards are
  // read-only (lock / Steam badge).
  // Every known aircraft type gets a folder — even with zero liveries — so
  // the trailing add-card is always reachable for that type.
  const renderGroups = (groups) => (
    <div className="livery-groups">
      {groups.map(([planeId, items]) => {
        const isCollapsed = collapsed.has(planeId);
        return (
          <div className="livery-group" key={planeId || 'unknown'}>
            <div
              className="livery-group-header"
              onClick={() => toggleGroup(planeId)}
            >
              <span className="livery-group-caret">
                {isCollapsed
                  ? <IoChevronForward size={14} />
                  : <IoChevronDown size={14} />}
              </span>
              <IoFolderOutline size={15} className="livery-group-icon" />
              <span className="livery-group-title">{groupTitle(planeId)}</span>
              <span className="livery-group-count">{t('livery_aircraft_count', { n: items.length })}</span>
            </div>
            {!isCollapsed && (
              <div className="livery-grid">
                {items.map(row => (
                  row.pack === 'reference' ? renderRefCard(row)
                    : row.pack === 'workshop' ? renderWorkshopCard(row)
                      : renderMineCard(row)
                ))}
                {renderAddCard(planeId)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // Full folder set: union of the scanned aircraft types and every type
  // present in the rows (covers types added after the scan). Empty folders
  // are kept so their add-card stays reachable. Under an active search, an
  // empty folder is kept only when its type name matches the query.
  const groups = useMemo(() => {
    const byPlane = new Map();
    for (const r of filteredRows) {
      const key = r.targetPlaneId || '';
      if (!byPlane.has(key)) byPlane.set(key, []);
      byPlane.get(key).push(r);
    }
    const typeSet = new Set(allTypes);
    for (const r of allRows) {
      if (r.targetPlaneId) typeSet.add(r.targetPlaneId);
    }
    const q = String(search || '').trim().toLowerCase();
    let ids = [...typeSet].sort((a, b) => a.localeCompare(b));
    if (q) {
      ids = ids.filter(id => (byPlane.has(id) && byPlane.get(id).length > 0) || id.toLowerCase().includes(q));
    }
    const out = ids.map(id => [id, byPlane.get(id) || []]);
    if (byPlane.has('')) out.push(['', byPlane.get('')]);
    return out;
  }, [filteredRows, allRows, allTypes, search]);

  const toggleSelect = (folder) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const allSelected = mine.length > 0 && mine.every(r => selected.has(r.folder));

  // Publish header-bar state + commands (select-all / export / delete all live
  // in the LiveryScreen header now, not on the cards).
  useEffect(() => {
    if (onBarState) onBarState({
      mineCount: mine.length,
      selectedCount: selected.size,
      allSelected,
      oneSelected: selected.size === 1,
    });
  }, [mine, selected, allSelected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (cmdRef) cmdRef.current = { toggleSelectAll, deleteSelected, exportSelected, uploadSelected };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSelectAll = () => {
    setSelected(prev => {
      const rows = mineRef.current;
      const all = rows.length > 0 && rows.every(r => prev.has(r.folder));
      return all ? new Set() : new Set(rows.map(r => r.folder));
    });
  };

  const singleSelected = () => (selectedRef.current.size === 1 ? [...selectedRef.current][0] : null);

  const deleteSelected = () => confirmDelete([...selectedRef.current]);

  const exportSelected = () => {
    const folder = singleSelected();
    if (folder) handleExport(folder);
  };

  // Header Upload button: opens the Workshop dialog for the single selected
  // `mine` folder (reference/workshop rows are never selectable, so they can
  // never reach here).
  const uploadSelected = () => {
    const folder = singleSelected();
    if (folder && onUpload) onUpload(folder);
  };

  if (loading) return <div className="livery-placeholder">{t('editor_loading')}</div>;

  return (
    <div className="livery-mine-wrap">
      {groups.length > 0
        ? renderGroups(groups)
        : (!loading && (
          <div className="livery-placeholder">
            {String(search || '').trim() ? t('livery_search_empty') : t('livery_empty_mine')}
          </div>
        ))}
      {TooltipPortal}
    </div>
  );
}
