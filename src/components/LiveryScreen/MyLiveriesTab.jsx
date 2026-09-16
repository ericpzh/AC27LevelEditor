import React, { useEffect, useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { OWN_PACK_NAME, PLANE_ID_TO_SHORT_CODE } from '../../utils/constants/livery';
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

export default function MyLiveriesTab({ onEdit, onCreate }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
  const [mine, setMine] = useState([]);
  const [reference, setReference] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [loading, setLoading] = useState(true);
  // Collapsed aircraft groups, keyed by targetPlaneId ('' = unknown).
  // Mine + reference share one folder set; reference rows are read-only.
  const [collapsed, setCollapsed] = useState(new Set());
  const { bind, TooltipPortal } = useTooltip();

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

  const handleDelete = (folder) => {
    const { showModal, hideModal } = useAppStore.getState();
    showModal(
      () => t('livery_delete_confirm_title'),
      () => <p>{t('livery_delete_confirm_body', { folder })}</p>,
      () => (
        <>
          <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
          <button className="btn-danger" onClick={async () => {
            hideModal();
            try {
              const res = await electronAPI.deleteLivery(folder);
              const { showToast } = useAppStore.getState();
              if (res && res.success) {
                showToast(t('livery_deleted'), 'success');
                refresh();
              } else {
                showToast(t(errKey(res && res.error)), 'error');
              }
            } catch (err) {
              useAppStore.getState().showToast(err.message, 'error');
            }
          }}>{t('livery_delete')}</button>
        </>
      )
    );
  };

  if (loading) return <div className="livery-placeholder">{t('editor_loading')}</div>;

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

  const handleCopyName = async (folder) => {
    const { showToast } = useAppStore.getState();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(folder);
        showToast(t('livery_copied', { folder }), 'success');
      } else {
        showToast(folder, '');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const groupTitle = (planeId) => {
    const code = PLANE_ID_TO_SHORT_CODE[planeId];
    const name = planeId || t('livery_unknown_aircraft');
    return code ? `${code} · ${name}` : name;
  };

  const renderMineCard = (row) => (
    <div className="livery-card" key={'mine:' + row.folder}>
      {thumbs['mine:' + row.folder] && <img src={thumbs['mine:' + row.folder]} alt={row.folder} />}
      <div className="livery-meta"><strong>{row.folder}</strong></div>
      <div className="livery-meta">{row.airline} · {row.targetPlaneId}</div>
      {row.error && <div className="livery-meta">{t(errKey(row.error))}</div>}
      <div className="livery-actions">
        <button className="btn-sm" {...bind(t('livery_tip_edit'))} onClick={() => onEdit && onEdit({ ...row, imageDataUrl: thumbs['mine:' + row.folder] || null })}>{t('livery_edit')}</button>
        <button className="btn-sm" {...bind(t('livery_tip_export'))} onClick={() => handleExport(row.folder)}>{t('livery_export')}</button>
        <button className="btn-sm" {...bind(t('livery_tip_copy'))} onClick={() => handleCopyName(row.folder)}>{t('livery_copy_name')}</button>
        <button className="btn-sm" {...bind(t('livery_tip_delete'))} onClick={() => handleDelete(row.folder)}>{t('livery_delete')}</button>
      </div>
    </div>
  );

  const renderRefCard = (row) => (
    <div className="livery-card" key={'ref:' + row.folder}>
      {thumbs['reference:' + row.folder] && <img src={thumbs['reference:' + row.folder]} alt={row.folder} />}
      <div className="livery-meta">
        <strong>{row.folder}</strong>
        {' '}
        <span className="livery-readonly" {...bind(t('livery_tip_readonly'))}>
          <IoLockClosed size={12} />
        </span>
      </div>
      <div className="livery-meta">{row.airline} · {row.targetPlaneId}</div>
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

  // One folder set across both packs (mine rows carry pack:'mine' for
  // thumbnails/actions, reference rows pack:'reference' + lock mark).
  const allRows = [
    ...mine.map(r => ({ ...r, pack: 'mine' })),
    ...reference.map(r => ({ ...r, pack: 'reference' })),
  ];

  return (
    <div>
      {mine.length === 0 && (
        <div className="livery-placeholder">
          <p>{t('livery_empty_mine')}</p>
          <button className="btn-sm" onClick={onCreate}>{t('livery_tab_create')}</button>
        </div>
      )}
      {allRows.length > 0 && renderGroups(allRows)}
      <p className="livery-folder-preview">{t('livery_share_help', { pack: OWN_PACK_NAME })}</p>
      {TooltipPortal}
    </div>
  );
}
