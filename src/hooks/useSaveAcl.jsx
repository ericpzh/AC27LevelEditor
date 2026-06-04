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
        createBackup,
        weatherTimeline: store.weatherTimeline,
        windTimeline: store.windTimeline,
        runwayTimeline: store.runwayTimeline,
      });

      if (!result.success) {
        store.showModal(t('modal_save_failed'), result.error || 'Unknown error');
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

      store.showModal(t('modal_save_success'), '', null);
      return true;
    } catch (err) {
      store.showModal(t('modal_save_failed'), err.message);
      return false;
    }
  }, [t, electronAPI]);

  const handleSave = useCallback(async () => {
    const store = useAppStore.getState();
    if (!store.currentPath) { store.showToast(t('toast_no_file'), 'error'); return; }
    if (store.flights.length === 0) { store.showToast(t('toast_no_flight_data'), 'error'); return; }

    const dupes = validateCallsigns();
    if (dupes.length > 0) {
      const dupesHtml = dupes.map(d => '<strong>' + d + '</strong>').join('<br>');
      store.showModal(
        t('modal_duplicate_title'),
        <span>{t('modal_duplicate_body')}<br /><br /><span dangerouslySetInnerHTML={{ __html: dupesHtml }} /><br /><br /><span style={{ color: 'var(--red)' }}>{t('modal_duplicate_save_cancelled')}</span></span>
      );
      return;
    }

    const issues = runTripleValidation();
    if (issues.length > 0) {
      store.showModal(
        t('modal_issues_title', { n: issues.length }),
        <div style={{ maxHeight: 400, overflow: 'auto', textAlign: 'left' }}>
          {issues.map((issue, i) => <p key={i} style={{ margin: '4px 0', fontSize: 13 }}>{issue}</p>)}
          <p style={{ color: 'var(--red)', fontSize: 13 }}>{t('modal_issues_fix_hint_save')}</p>
        </div>
      );
      return;
    }

    store.showModal(
      t('modal_backup_title'),
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
        <input type="checkbox" id="chk-create-backup" defaultChecked />
        <span>{t('modal_backup_checkbox')}</span>
      </label>,
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
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
    if (result.error) { store.showModal(t('modal_backup_failed'), result.error); return; }
    store.showToast(t('toast_backup_saved', { name: result.path.split(/[/\\]/).pop() }), 'success');
  }, [t, electronAPI]);

  const handleSaveAs = useCallback(async () => {
    const store = useAppStore.getState();
    if (!store.currentPath) { store.showToast(t('toast_no_file'), 'error'); return; }
    if (store.flights.length === 0) { store.showToast(t('toast_no_flight_data'), 'error'); return; }

    const dupes = validateCallsigns();
    if (dupes.length > 0) {
      store.showModal(t('modal_duplicate_title'), <span>{t('modal_duplicate_body')}<br /><br /><span style={{ color: 'var(--red)' }}>{t('modal_duplicate_export_cancelled')}</span></span>);
      return;
    }
    const issues = runTripleValidation();
    if (issues.length > 0) {
      store.showModal(t('modal_issues_export_title', { n: issues.length }),
        <div style={{ maxHeight: 400, overflow: 'auto' }}>
          {issues.map((issue, i) => <p key={i}>{issue}</p>)}
          <p style={{ color: 'var(--red)' }}>{t('modal_issues_fix_hint_export')}</p>
        </div>
      );
      return;
    }

    await doSaveAcl(false, true);
    const result = await electronAPI.exportZip({ aclPath: store.currentPath });
    if (result.canceled) return;
    if (result.error) { store.showModal(t('modal_export_failed'), result.error); return; }
    store.showToast(t('toast_exported', { name: result.path.split(/[/\\]/).pop() }), 'success');
  }, [t, electronAPI, doSaveAcl]);

  return { handleSave, handleSaveAs, handleBackup, doSaveAcl };
}
