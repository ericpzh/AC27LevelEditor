import React, { useEffect, useRef, useState } from 'react';
import './LiveryScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useAppStore } from '../../store/appStore';
import { STEAM_DEMO_DIR_NAME } from '../../utils/constants/steam';
import {
  IoArrowBack,
  IoHelpCircleOutline,
  IoCloudDownloadOutline,
  IoCheckmarkDone,
  IoTrashOutline,
  IoSearchOutline,
} from 'react-icons/io5';
import { FaSteam } from 'react-icons/fa';
import { MdAdd } from 'react-icons/md';
import { FaFileExport } from 'react-icons/fa6';
import useTooltip from '../BrowserScreen/useTooltip';
import MyLiveriesTab from './MyLiveriesTab';
import CreateTab from './CreateTab';
import InstallPackTab from './InstallPackTab';
import UploadLiveryDialog from './UploadLiveryDialog';
import LiveryHelpOverlay from './LiveryHelpOverlay';

export default function LiveryScreen() {
  const { t } = useTranslation();
  const setScreen = useAppStore(s => s.setScreen);
  const rootPath = useAppStore(s => s.rootPath);
  // The realistic livery pack is only offered in the demo game root (same
  // root-level detection as BrowserScreen). Full-game roots hide the button.
  const isDemo = rootPath && rootPath.includes(STEAM_DEMO_DIR_NAME);
  const [tab, setTab] = useState('mine');
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Workshop upload dialog target: the single selected `mine` folder.
  const [uploadFolder, setUploadFolder] = useState(null);
  const searchRef = useRef(null);
  const { bind, TooltipPortal } = useTooltip();
  // Mine-list commands + bar state, published by MyLiveriesTab.
  const mineCmdRef = useRef({});
  // The list's scroll container — MyLiveriesTab clamps scrollTop here after
  // an in-place delete shrinks the content (no full-list refresh).
  const contentRef = useRef(null);
  const [barState, setBarState] = useState({ mineCount: 0, selectedCount: 0, allSelected: false, oneSelected: false });

  // Unsaved painter guard: CreateTab paint mode registers
  // window.__liveryPaintGuard = { isDirty() }. Tab-leave/back prompts via
  // showModal; component-local state only (no store change).
  const guardLeave = (proceed) => {
    try {
      if (window.__liveryPaintGuard && window.__liveryPaintGuard.isDirty()) {
        const { showModal, hideModal } = useAppStore.getState();
        showModal(
          () => t('livery_unsaved_title'),
          () => <p>{t('livery_unsaved_body')}</p>,
          () => (
            <>
              <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
              <button className="btn-danger" onClick={() => {
                hideModal();
                CreateTab.prefill = null;
                window.__liveryPaintGuard = null;
                proceed();
              }}>{t('livery_unsaved_discard')}</button>
            </>
          )
        );
        return;
      }
    } catch (_) {}
    proceed();
  };

  const goCreate = () => {
    if (tab === 'create') return;
    guardLeave(() => {
      setTab('create');
    });
  };

  // Header back: create view → mine list; mine list → browser.
  const goBack = () => guardLeave(() => {
    if (tab === 'create') { CreateTab.prefill = null; window.__liveryPaintGuard = null; setTab('mine'); return; }
    CreateTab.prefill = null; setScreen('browser');
  });

  // Install pack opens in a modal (moved up from the old bottom bar so the
  // header button works in both views).
  const handleInstallPack = () => {
    const { showModal } = useAppStore.getState();
    showModal(
      () => t('livery_tab_install'),
      <InstallPackTab />,
    );
  };

  const isMine = tab === 'mine';
  const isCreate = tab === 'create';

  // Ctrl+F / Cmd+F focuses the list search box. Ignored while typing, while a
  // modal is open, or on the painter page (no search box there).
  useEffect(() => {
    if (!isMine) return;
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return;
      const el = e.target;
      const tag = (el && el.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
      if (useAppStore.getState().modal && useAppStore.getState().modal.open) return;
      e.preventDefault();
      if (searchRef.current) searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMine]);

  return (
    <div id="screen-livery" className={'screen' + (isCreate ? ' livery-screen--painter' : '')}>
      {!isCreate && (
        <header className="browser-header">
          <div className="browser-actions">
            <button className="btn-sm" {...bind(t('livery_back'))} onClick={goBack}>
              <IoArrowBack size={14} className="btn-icon" />{t('livery_back')}
            </button>
            <button
              id="livery-help-btn"
              className="btn-lang-toggle-top btn-icon-only"
              aria-label={t('livery_help_short')}
              onClick={() => setHelpOpen(true)}
            >
              <IoHelpCircleOutline size={14} />
            </button>
            {isDemo && (
              <button className="btn-sm" {...bind(t('livery_tip_install'))} onClick={handleInstallPack}>
                <IoCloudDownloadOutline size={14} className="btn-icon" />{t('livery_tab_install')}
              </button>
            )}
          </div>
          <div className="browser-actions">
            {isMine && (
              <>
                <button className="btn-sm" onClick={goCreate}>
                  <MdAdd size={14} className="btn-icon" />{t('livery_tab_create')}
                </button>
                <button
                  className="btn-sm"
                  {...bind(t('livery_tip_select_all'))}
                  onClick={() => mineCmdRef.current.toggleSelectAll && mineCmdRef.current.toggleSelectAll()}
                  disabled={barState.mineCount === 0}
                >
                  <IoCheckmarkDone size={14} className="btn-icon" />{barState.allSelected ? t('toolbar_deselect_all') : t('toolbar_select_all')}
                </button>
                <button
                  className="btn-sm"
                  {...bind(t('livery_tip_export'))}
                  onClick={() => mineCmdRef.current.exportSelected && mineCmdRef.current.exportSelected()}
                  disabled={!barState.oneSelected}
                >
                  <FaFileExport size={14} className="btn-icon" />{t('livery_export')}
                </button>
                <button
                  className="btn-sm"
                  {...bind(t('livery_upload_tip'))}
                  onClick={() => mineCmdRef.current.uploadSelected && mineCmdRef.current.uploadSelected()}
                  disabled={!barState.oneSelected}
                >
                  <FaSteam size={14} className="btn-icon" />{t('livery_upload')}
                </button>
                <button
                  className="btn-sm"
                  {...bind(t('livery_tip_delete_selected'))}
                  onClick={() => mineCmdRef.current.deleteSelected && mineCmdRef.current.deleteSelected()}
                  disabled={barState.selectedCount === 0}
                >
                  <IoTrashOutline size={14} className="btn-icon" />{t('toolbar_delete_selected')}
                </button>
                <span className="livery-search">
                  <IoSearchOutline size={14} className="livery-search-icon" />
                  <input
                    ref={searchRef}
                    type="text"
                    value={search}
                    placeholder={t('livery_search')}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </span>
              </>
            )}
          </div>
        </header>
      )}
      <main ref={contentRef} className={'livery-content' + (isCreate ? ' livery-content--painter' : '')}>
        {isMine && (
          <MyLiveriesTab
            search={search}
            cmdRef={mineCmdRef}
            scrollRef={contentRef}
            onBarState={setBarState}
            onEdit={(row) => { CreateTab.prefill = row; setTab('create'); }}
            onCreate={(planeId) => { CreateTab.prefill = { targetPlaneId: planeId }; setTab('create'); }}
            onUpload={(folder) => setUploadFolder(folder)}
          />
        )}
        {isCreate && (
          <CreateTab
            key={tab + JSON.stringify(CreateTab.prefill && { folder: CreateTab.prefill.folder, pack: CreateTab.prefill.pack, targetPlaneId: CreateTab.prefill.targetPlaneId })}
            onCreated={() => { CreateTab.prefill = null; window.__liveryPaintGuard = null; setTab('mine'); }}
            onCancel={() => { CreateTab.prefill = null; window.__liveryPaintGuard = null; setTab('mine'); }}
            onHelp={() => setHelpOpen(true)}
            onUpload={(folder) => setUploadFolder(folder)}
            uploadOpen={Boolean(uploadFolder)}
          />
        )}
      </main>
      {uploadFolder && <UploadLiveryDialog folder={uploadFolder} onClose={() => setUploadFolder(null)} />}
      {helpOpen && <LiveryHelpOverlay page={isCreate ? 'painter' : 'list'} isDemo={isDemo} onClose={() => setHelpOpen(false)} />}
      {TooltipPortal}
    </div>
  );
}
