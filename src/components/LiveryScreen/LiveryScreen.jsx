import React, { useRef, useState } from 'react';
import './LiveryScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useAppStore } from '../../store/appStore';
import {
  IoArrowBack,
  IoHelpCircleOutline,
  IoCloudDownloadOutline,
  IoCheckmarkDone,
  IoTrashOutline,
  IoSearchOutline,
} from 'react-icons/io5';
import { MdAdd } from 'react-icons/md';
import { FaFileExport } from 'react-icons/fa6';
import useTooltip from '../BrowserScreen/useTooltip';
import MyLiveriesTab from './MyLiveriesTab';
import CreateTab from './CreateTab';
import InstallPackTab from './InstallPackTab';
import LiveryHelpOverlay from './LiveryHelpOverlay';

export default function LiveryScreen() {
  const { t } = useTranslation();
  const setScreen = useAppStore(s => s.setScreen);
  const [tab, setTab] = useState('mine');
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { bind, TooltipPortal } = useTooltip();
  // Mine-list commands + bar state, published by MyLiveriesTab.
  const mineCmdRef = useRef({});
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
            <button className="btn-sm" {...bind(t('livery_tip_install'))} onClick={handleInstallPack}>
              <IoCloudDownloadOutline size={14} className="btn-icon" />{t('livery_tab_install')}
            </button>
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
                  {...bind(t('livery_tip_delete_selected'))}
                  onClick={() => mineCmdRef.current.deleteSelected && mineCmdRef.current.deleteSelected()}
                  disabled={barState.selectedCount === 0}
                >
                  <IoTrashOutline size={14} className="btn-icon" />{t('toolbar_delete_selected')}
                </button>
                <span className="livery-search">
                  <IoSearchOutline size={14} className="livery-search-icon" />
                  <input
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
      <main className={'livery-content' + (isCreate ? ' livery-content--painter' : '')}>
        {isMine && (
          <MyLiveriesTab
            search={search}
            cmdRef={mineCmdRef}
            onBarState={setBarState}
            onEdit={(row) => { CreateTab.prefill = row; setTab('create'); }}
            onCreate={(planeId) => { CreateTab.prefill = { targetPlaneId: planeId }; setTab('create'); }}
          />
        )}
        {isCreate && (
          <CreateTab
            key={tab + JSON.stringify(CreateTab.prefill && { folder: CreateTab.prefill.folder, pack: CreateTab.prefill.pack, targetPlaneId: CreateTab.prefill.targetPlaneId })}
            onCreated={() => { CreateTab.prefill = null; window.__liveryPaintGuard = null; setTab('mine'); }}
            onCancel={() => { CreateTab.prefill = null; window.__liveryPaintGuard = null; setTab('mine'); }}
            onHelp={() => setHelpOpen(true)}
          />
        )}
      </main>
      {helpOpen && <LiveryHelpOverlay page={isCreate ? 'painter' : 'list'} onClose={() => setHelpOpen(false)} />}
      {TooltipPortal}
    </div>
  );
}
