import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { useAppStore } from '../../store/appStore';

export default function Toolbar() {
  const { t, toggleLang } = useTranslation();
  const showToast = useAppStore(s => s.showToast);

  const addArrival = () => {
    useAppStore.getState().addArrivalFlight();
    const cs = useAppStore.getState().flights.slice(-1)[0]?.CallSign || '';
    showToast(t('toast_added_arrival', { cs }), 'success');
  };
  const addDeparture = () => {
    useAppStore.getState().addDepartureFlight();
    const cs = useAppStore.getState().flights.slice(-1)[0]?.CallSign || '';
    showToast(t('toast_added_departure', { cs }), 'success');
  };
  const copy = () => {
    const st = useAppStore.getState();
    if (!st.selectedIndices.size && st.highlightedIdx < 0) { showToast(t('toast_select_to_copy'), 'error'); return; }
    st.copySelected();
    showToast(t('toast_copied_n', { n: st.selectedIndices.size || 1 }), 'success');
  };
  const del = () => {
    const st = useAppStore.getState();
    if (!st.selectedIndices.size) { showToast(t('toast_no_flights_selected'), 'error'); return; }
    const n = st.selectedIndices.size;
    st.deleteSelected();
    showToast(t('toast_deleted_n', { n }), 'success');
  };
  const delAll = () => {
    const st = useAppStore.getState();
    if (!st.flights.length) { showToast(t('toast_no_flights_to_delete'), 'error'); return; }
    const n = st.flights.length;
    st.deleteAllFlights();
    showToast(t('toast_deleted_all', { n }), 'success');
  };

  return (
    <header id="toolbar">
      <div className="toolbar-group">
        <button id="btn-back">{t('toolbar_back')}</button>
      </div>
      <div className="toolbar-sep" />
      <div className="toolbar-group">
        <button id="btn-add-arrival" onClick={addArrival}>{t('toolbar_add_arrival')}</button>
        <button id="btn-add-departure" onClick={addDeparture}>{t('toolbar_add_departure')}</button>
        <button id="btn-copy" onClick={copy}>{t('toolbar_copy')}</button>
        <button id="btn-delete-selected" onClick={del}>{t('toolbar_delete_selected')}</button>
        <button id="btn-delete-all" onClick={delAll}>{t('toolbar_delete_all')}</button>
      </div>
      <div className="toolbar-spacer toolbar-time-wrap">
        <span id="toolbar-time-range"></span>
      </div>
      <div className="toolbar-sep" />
      <div className="toolbar-group save-group">
        <button id="btn-lang-editor" className="btn-lang-toggle-top" onClick={toggleLang}>{t('lang_switch_to')}</button>
        <button id="btn-backup-only">{t('toolbar_backup')}</button>
        <button id="btn-restore-backup">{t('toolbar_restore')}</button>
        <button id="btn-import-acl">{t('toolbar_import')}</button>
        <button id="btn-save-as">{t('toolbar_save_as')}</button>
        <button id="btn-save" className="btn-primary-sm">{t('toolbar_save')}</button>
      </div>
    </header>
  );
}
