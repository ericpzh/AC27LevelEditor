import { useCallback } from 'react';
import { useAppStore } from '../store/appStore';
import { useTranslation } from './useTranslation';
import { useElectronAPI } from './useElectronAPI';

// Reuse legacy validation functions (still in global scope)
function validateCallsigns() {
  return window.validateCallsigns ? window.validateCallsigns() : [];
}
function runTripleValidation() {
  return window.runTripleValidation ? window.runTripleValidation() : [];
}

export function useSaveAcl() {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();

  const doSaveAcl = useCallback(async (createBackup, silent) => {
    const store = useAppStore.getState();
    try {
      const result = await electronAPI.saveAcl({
        filePath: store.currentPath,
        flights: store.flights,
        before: store.before,
        after: store.after,
        arrayContent: store.arrayContent,
        originalBlocks: store.originalBlocks,
        earliestTime: store._earliestTime,
        _saveSec: store._saveSec,
        createBackup,
        weatherTimeline: store.weatherTimeline,
        windTimeline: store.windTimeline,
        runwayTimeline: store.runwayTimeline,
      });

      if (!result.success) {
        store.showModal(t('modal_save_failed'), result.error || 'Unknown error', <div className="modal-actions-row"><button className="btn-confirm" onClick={() => store.hideModal()}>{t('modal_btn_ok')}</button></div>);
        return false;
      }

      // Save timelines
      const tlErrors = [];
      if (store.weatherPath && store.timelineModified.weather) {
        const wr = await electronAPI.saveWeatherTimeline({ filePath: store.weatherPath, data: store.weatherTimeline });
        if (!wr.success) tlErrors.push(t('tl_weather') + ': ' + wr.error);
        else store.setTimelineModified('weather', false);
      }
      if (store.windPath && store.timelineModified.wind) {
        const wr = await electronAPI.saveWindTimeline({ filePath: store.windPath, data: store.windTimeline });
        if (!wr.success) tlErrors.push(t('tl_wind') + ': ' + wr.error);
        else store.setTimelineModified('wind', false);
      }
      if (store.runwayTimelinePath && store.timelineModified.runway) {
        const rr = await electronAPI.saveRunwayTimeline({ filePath: store.runwayTimelinePath, data: store.runwayTimeline });
        if (!rr.success) tlErrors.push(t('tl_runway') + ': ' + rr.error);
        else store.setTimelineModified('runway', false);
      }

      useAppStore.setState({ modified: false });

      if (silent) return true;

      store.showModal(
        t('modal_save_success'),
        '',
        <div className="modal-actions-row"><button className="btn-confirm" onClick={() => store.hideModal()}>{t('modal_btn_ok')}</button></div>
      );
      return true;
    } catch (err) {
      store.showModal(t('modal_save_failed'), err.message, <div className="modal-actions-row"><button className="btn-confirm" onClick={() => store.hideModal()}>{t('modal_btn_ok')}</button></div>);
      return false;
    }
  }, [t, electronAPI]);

  const handleSave = useCallback(async () => {
    const store = useAppStore.getState();
    if (!store.currentPath) { store.showToast(t('toast_no_file'), 'error'); return; }
    if (store.flights.length === 0) { store.showToast(t('toast_no_flight_data'), 'error'); return; }

    const dupes = validateCallsigns();
    if (dupes.length > 0) {
      store.showModal(
        t('modal_duplicate_title'),
        <span>{t('modal_duplicate_body')}<br /><br />{dupes.map((d, i) => [i > 0 && <br key={`sep-${d}`} />, <strong key={d} className="callsign-link">{d}</strong>])}<br /><br /><span className="modal-hint-error">{t('modal_duplicate_save_cancelled')}</span></span>,
        <div className="modal-actions-row"><button className="btn-cancel" onClick={() => store.hideModal()}>{t('modal_btn_close')}</button></div>
      );
      return;
    }

    const issues = runTripleValidation();
    if (issues.length > 0) {
      store.showModal(
        t('modal_issues_title', { n: issues.length }),
        <div className="modal-issues-body">
          {issues.map((issue, i) => <p key={i} className="modal-issue-item">{issue}</p>)}
          <p className="modal-hint-error">{t('modal_issues_fix_hint_save')}</p>
        </div>,
        <div className="modal-actions-row"><button className="btn-cancel" onClick={() => store.hideModal()}>{t('modal_btn_close')}</button></div>
      );
      return;
    }

    store.showModal(
      t('modal_backup_title'),
      <label className="modal-checkbox-row">
        <input type="checkbox" id="chk-create-backup" defaultChecked className="modal-checkbox" />
        <span>{t('modal_backup_checkbox')}</span>
      </label>,
      <div className="modal-actions-row">
        <button className="btn-cancel" onClick={() => store.hideModal()}>{t('modal_btn_cancel')}</button>
        <button className="btn-confirm" onClick={async () => {
          const cb = document.getElementById('chk-create-backup');
          store.hideModal();
          await doSaveAcl(cb ? cb.checked : true, false);
        }}>{t('modal_btn_confirm_save')}</button>
      </div>
    );
  }, [t, doSaveAcl]);

  const handleBackup = useCallback(async () => {
    const store = useAppStore.getState();
    if (!store.currentPath) { store.showToast(t('toast_no_file'), 'error'); return; }
    const result = await electronAPI.manualBackup(store.currentPath);
    if (result.canceled) return;
    if (result.error) { store.showModal(t('modal_backup_failed'), result.error, <div className="modal-actions-row"><button className="btn-confirm" onClick={() => store.hideModal()}>{t('modal_btn_ok')}</button></div>); return; }
    store.showToast(t('toast_backup_saved', { name: result.path.split(/[/\\]/).pop() }), 'success');
  }, [t, electronAPI]);

  const handleSaveAs = useCallback(async () => {
    const store = useAppStore.getState();
    if (!store.currentPath) { store.showToast(t('toast_no_file'), 'error'); return; }
    if (store.flights.length === 0) { store.showToast(t('toast_no_flight_data'), 'error'); return; }

    const dupes = validateCallsigns();
    if (dupes.length > 0) {
      store.showModal(
        t('modal_duplicate_title'),
        <span>{t('modal_duplicate_body')}<br /><br /><span className="modal-hint-error">{t('modal_duplicate_export_cancelled')}</span></span>,
        <div className="modal-actions-row"><button className="btn-cancel" onClick={() => store.hideModal()}>{t('modal_btn_close')}</button></div>
      );
      return;
    }
    const issues = runTripleValidation();
    if (issues.length > 0) {
      store.showModal(
        t('modal_issues_export_title', { n: issues.length }),
        <div className="modal-issues-body">
          {issues.map((issue, i) => <p key={i} className="modal-issue-item">{issue}</p>)}
          <p className="modal-hint-error">{t('modal_issues_fix_hint_export')}</p>
        </div>,
        <div className="modal-actions-row"><button className="btn-cancel" onClick={() => store.hideModal()}>{t('modal_btn_close')}</button></div>
      );
      return;
    }

    await doSaveAcl(false, true);
    const result = await electronAPI.exportZip({ aclPath: store.currentPath });
    if (result.canceled) return;
    if (result.error) { store.showModal(t('modal_export_failed'), result.error, <div className="modal-actions-row"><button className="btn-confirm" onClick={() => store.hideModal()}>{t('modal_btn_ok')}</button></div>); return; }
    store.showToast(t('toast_exported', { name: result.path.split(/[/\\]/).pop() }), 'success');
  }, [t, electronAPI, doSaveAcl]);

  return { handleSave, handleSaveAs, handleBackup, doSaveAcl };
}
