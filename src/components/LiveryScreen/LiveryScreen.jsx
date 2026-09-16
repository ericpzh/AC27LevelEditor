import React, { useState } from 'react';
import './LiveryScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useAppStore } from '../../store/appStore';
import { IoArrowBackOutline, IoHelpCircleOutline } from 'react-icons/io5';
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
  const { bind, TooltipPortal } = useTooltip();

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

  const goTab = (next) => {
    if (next === tab) return;
    guardLeave(() => {
      if (next !== 'create') CreateTab.prefill = null;
      setTab(next);
    });
  };

  const goBack = () => guardLeave(() => { CreateTab.prefill = null; setScreen('browser'); });

  return (
    <div id="screen-livery" className="screen">
      <header className="browser-header">
        <div className="browser-title"><span>{t('livery_title')}</span></div>
        <div className="browser-actions">
          <button className="btn-sm" {...bind(t('livery_back'))} onClick={goBack}>
            <IoArrowBackOutline size={14} className="btn-icon" />{t('livery_back')}
          </button>
          <button className="btn-lang-toggle-top btn-icon-only" {...bind(t('livery_help_btn'))} onClick={() => setHelpOpen(true)}>
            <IoHelpCircleOutline size={14} />
          </button>
        </div>
      </header>
      <div className="livery-tabbar">
        <button
          className={'livery-tab' + (tab === 'mine' ? ' active' : '')}
          {...bind(t('livery_help_mine'))}
          onClick={() => goTab('mine')}
        >{t('livery_tab_mine')}</button>
        <button
          className={'livery-tab' + (tab === 'create' ? ' active' : '')}
          {...bind(t('livery_help_create'))}
          onClick={() => goTab('create')}
        >{t('livery_tab_create')}</button>
        <button
          className={'livery-tab' + (tab === 'install' ? ' active' : '')}
          {...bind(t('livery_help_install'))}
          onClick={() => goTab('install')}
        >{t('livery_tab_install')}</button>
      </div>
      <main className="livery-content">
        {tab === 'mine' && <MyLiveriesTab onEdit={(row) => { CreateTab.prefill = row; setTab('create'); }} onCreate={() => setTab('create')} />}
        {tab === 'create' && <CreateTab key={tab + JSON.stringify(CreateTab.prefill && CreateTab.prefill.folder)} onCreated={() => setTab('mine')} />}
        {tab === 'install' && <InstallPackTab />}
      </main>
      {helpOpen && <LiveryHelpOverlay onClose={() => setHelpOpen(false)} />}
      {TooltipPortal}
    </div>
  );
}
