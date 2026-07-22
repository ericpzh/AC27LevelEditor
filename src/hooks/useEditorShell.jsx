import React, { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { useTranslation } from './useTranslation';

export function useEditorShell({ onSave, onBeforeNavigate }) {
  const { t } = useTranslation();
  const showModal = useAppStore(s => s.showModal);
  const hideModal = useAppStore(s => s.hideModal);

  const goToBrowser = (st) => {
    if (onBeforeNavigate) onBeforeNavigate();
    st.setScreen('browser');
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      const st = useAppStore.getState();
      if (st.screen !== 'editor') return;
      if (st.editingWidget) return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.shiftKey && e.key === 'N') { e.preventDefault(); st.addDepartureFlight(); }
      else if (mod && e.key === 's') { e.preventDefault(); if (onSave) onSave(); }
      else if (mod && e.key === 'n') { e.preventDefault(); st.addArrivalFlight(); }
      else if (mod && e.key === 'b') { e.preventDefault(); const hasMod=st.modified||st.timelineModified.weather||st.timelineModified.wind||st.timelineModified.runway; if(hasMod){showModal(t('modal_unsaved_title'),<p>{t('modal_unsaved_body')}</p>,<div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button><button className="btn-confirm" onClick={()=>{hideModal();useAppStore.setState({modified:false,timelineModified:{weather:false,wind:false,runway:false},selectedIndices:new Set()});goToBrowser(st);}}>{t('modal_btn_discard')}</button></div>);}else{goToBrowser(st);} }
      else if (mod && e.key === 'd') { e.preventDefault(); st.copySelected(); }
      else if (e.key === 'Delete') { e.preventDefault(); if (st.selectedIndices.size > 0) { const n = st.selectedIndices.size; const bodyText = t('modal_delete_confirm_body', { n: String(n) }); const m = bodyText.match(/^(.*?)<strong>(.*?)<\/strong>(.*)$/); showModal(t('modal_delete_confirm'), <div><p>{m ? [m[1], <strong key="n">{m[2]}</strong>, m[3]] : bodyText}</p><p className="modal-hint-error">{t('modal_delete_irreversible')}</p></div>, <div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button><button className="btn-confirm" onClick={()=>{hideModal();useAppStore.getState().deleteSelected();}}>{t('modal_delete_btn',{n})}</button></div>); } }
      else if (e.key === 'Escape') { useAppStore.setState({ highlightedIdx: -1, selectedIndices: new Set() }); }
    };
    document.addEventListener('keydown', onKeyDown);

    // Nav browser (native menu)
    if (window.electronAPI?.onNavBrowser) {
      window.electronAPI.onNavBrowser(() => {
        const st = useAppStore.getState();
        const hasMod = st.modified || st.timelineModified.weather || st.timelineModified.wind || st.timelineModified.runway;
        if (st.screen === 'editor' && hasMod) {
          showModal(t('modal_unsaved_title'),
            <p>{t('modal_unsaved_body')}</p>,
            <div className="modal-actions-row">
              <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
              <button className="btn-confirm" onClick={() => { hideModal(); useAppStore.setState({ modified: false, selectedIndices: new Set(), timelineModified: {weather:false,wind:false,runway:false} }); goToBrowser(st); }}>{t('modal_btn_discard')}</button>
            </div>);
        } else if (st.screen === 'editor') { useAppStore.setState({ selectedIndices: new Set() }); goToBrowser(st); }
      });
    }

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [t, showModal, hideModal, onSave, onBeforeNavigate]);
}
