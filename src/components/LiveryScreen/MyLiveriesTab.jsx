import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { airlineDisplayName } from '../../utils/constants/airlines';
import { IoChevronForward, IoChevronDown, IoFolderOutline, IoLockClosed } from 'react-icons/io5';
import useTooltip from '../BrowserScreen/useTooltip';

function errKey(code) {
  return 'livery_err_' + String(code || 'unknown');
}

// Group rows by aircraft type, sorted by plane id (unknown last).
function groupByAircraft(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.targetPlaneId || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.entries()].sort((a, b) => {
    if (!a[0]) return 1;
    if (!b[0]) return -1;
    return a[0].localeCompare(b[0]);
  });
}

export default function MyLiveriesTab({ onEdit, search = '', cmdRef, onBarState }) {
  const { t, lang } = useTranslation();
  const electronAPI = useElectronAPI();
  const [mine, setMine] = useState([]);
  const [reference, setReference] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [loading, setLoading] = useState(true);
  // Collapsed aircraft groups, keyed by targetPlaneId ('' = unknown).
  // Mine + reference share one folder set; reference rows are read-only.
  const [collapsed, setCollapsed] = useState(new Set());
  // Selected own-pack folders (reference never selectable). The card checkbox
  // drives export / delete in the header bar via cmdRef.
  const [selected, setSelected] = useState(new Set());
  const { bind, TooltipPortal } = useTooltip();

  // One folder set across both packs (mine rows carry pack:'mine' for
  // thumbnails/actions, reference rows pack:'reference' + lock mark).
  const allRows = useMemo(() => [
    ...mine.map(r => ({ ...r, pack: 'mine' })),
    ...reference.map(r => ({ ...r, pack: 'reference' })),
  ], [mine, reference]);

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
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy thumbnails (mine + reference).
  useEffect(() => {
    let cancelled = false;
    const rows = [...mine.map(r => ({ ...r, pack: 'mine' })), ...reference.map(r => ({ ...r, pack: 'reference' }))];
    (async () => {
      for (const row of rows) {
        if (thumbs[row.pack + ':' + row.folder]) continue;
        try {
          const res = await electronAPI.readLiveryImage(row.folder, row.pack);
          if (!cancelled && res && res.success) {
            setThumbs(prev => ({ ...prev, [row.pack + ':' + row.folder]: res.imageDataUrl }));
          }
        } catch (_) {}
      }
    })();
    return () => { cancelled = true; };
  }, [mine, reference]); // eslint-disable-line react-hooks/exhaustive-deps

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
            let ok = 0;
            for (const folder of folders) {
              try {
                const res = await electronAPI.deleteLivery(folder);
                if (res && res.success) ok++;
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
            if (ok > 0) showToast(single ? t('livery_deleted') : t('livery_deleted_multi', { n: ok }), 'success');
            refresh();
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
        if (onEdit) onEdit({ ...row, pack: 'mine', imageDataUrl: thumbs['mine:' + row.folder] || null });
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, select, a, label') && onEdit) {
          e.preventDefault();
          onEdit({ ...row, pack: 'mine', imageDataUrl: thumbs['mine:' + row.folder] || null });
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
        if (onEdit) onEdit({ ...row, pack: 'reference', imageDataUrl: thumbs['reference:' + row.folder] || null });
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, input, select, a') && onEdit) {
          e.preventDefault();
          onEdit({ ...row, pack: 'reference', imageDataUrl: thumbs['reference:' + row.folder] || null });
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

  // Collapsible folder-like group per aircraft type. Mine + reference rows
  // share one folder set; reference cards carry a read-only lock mark.
  const renderGroups = (rows) => (
    <div className="livery-groups">
      {groupByAircraft(rows).map(([planeId, items]) => {
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
                {items.map(row => (row.pack === 'reference' ? renderRefCard(row) : renderMineCard(row)))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

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
    if (cmdRef) cmdRef.current = { toggleSelectAll, deleteSelected, exportSelected };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(mine.map(r => r.folder)));
  };

  const singleSelected = () => (selected.size === 1 ? [...selected][0] : null);

  const deleteSelected = () => confirmDelete([...selected]);

  const exportSelected = () => {
    const folder = singleSelected();
    if (folder) handleExport(folder);
  };

  if (loading) return <div className="livery-placeholder">{t('editor_loading')}</div>;

  return (
    <div className="livery-mine-wrap">
      {filteredRows.length > 0
        ? renderGroups(filteredRows)
        : (!loading && (
          <div className="livery-placeholder">
            {String(search || '').trim() ? t('livery_search_empty') : t('livery_empty_mine')}
          </div>
        ))}
      {TooltipPortal}
    </div>
  );
}
