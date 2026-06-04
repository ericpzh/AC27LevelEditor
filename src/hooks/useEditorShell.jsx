import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { useTranslation } from './useTranslation';

export function useEditorShell({ onSave }) {
  const { t } = useTranslation();
  const showModal = useAppStore(s => s.showModal);
  const hideModal = useAppStore(s => s.hideModal);

  useEffect(() => {
    const onKeyDown = (e) => {
      const st = useAppStore.getState();
      if (st.screen !== 'editor') return;
      if (st.editingWidget) return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.shiftKey && e.key === 'N') { e.preventDefault(); st.addDepartureFlight(); }
      else if (mod && e.key === 's') { e.preventDefault(); if (onSave) onSave(); }
      else if (mod && e.key === 'n') { e.preventDefault(); st.addArrivalFlight(); }
      else if (mod && e.key === 'b') { e.preventDefault(); const hasMod=st.modified||st.timelineModified.weather||st.timelineModified.wind||st.timelineModified.runway; if(hasMod){showModal(t('modal_unsaved_title'),<p>{t('modal_unsaved_body')}</p>,<div style={{display:'flex',gap:8,justifyContent:'flex-end'}}><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button><button className="btn-confirm" onClick={()=>{hideModal();useAppStore.setState({modified:false,timelineModified:{weather:false,wind:false,runway:false},selectedIndices:new Set()});st.setScreen('browser');}}>{t('modal_btn_discard')}</button></div>);}else{st.setScreen('browser');} }
      else if (mod && e.key === 'd') { e.preventDefault(); st.copySelected(); }
      else if (e.key === 'Delete') { e.preventDefault(); if (st.selectedIndices.size > 0) st.deleteSelected(); }
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
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
              <button className="btn-confirm" onClick={() => { hideModal(); useAppStore.setState({ modified: false, selectedIndices: new Set(), timelineModified: {weather:false,wind:false,runway:false} }); st.setScreen('browser'); }}>{t('modal_btn_discard')}</button>
            </div>);
        } else if (st.screen === 'editor') { useAppStore.setState({ selectedIndices: new Set() }); st.setScreen('browser'); }
      });
    }

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [t, showModal, hideModal, onSave]);
}
