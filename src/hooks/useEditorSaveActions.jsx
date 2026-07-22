/**
 * useEditorSaveActions — extracted save/load/backup/restore/import workflows
 * from EditorScreen.jsx.
 *
 * Returns action handlers that EditorScreen wires to its toolbar buttons.
 * All IPC calls and state mutations happen through the parameters passed in,
 * so the hook itself is testable and has no hidden dependencies.
 */
import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { validateCallsigns, runTripleValidation } from '../utils/validators';
import { safeHtml } from '../utils/safeHtml';

/**
 * @param {object} opts
 * @param {object} opts.electronAPI — from useElectronAPI()
 * @param {function} opts.t — i18n translate function
 * @param {function} opts.showModal — store.showModal
 * @param {function} opts.hideModal — store.hideModal
 * @param {function} opts.showToast — store.showToast
 * @param {function} opts.convertWindSpeed — wind unit conversion
 * @param {object} opts.WIND_UNITS — { KNOTS, MPS }
 * @param {string|null} opts.rootPath — game root path
 * @param {function} opts.renderCallsignLink — renders clickable callsign links for validation modals
 * @param {function} opts.jumpToCallsign — searches + jumps to a callsign
 * @param {function} opts.setScreen — store.setScreen
 * @returns {{ doSave, handleSave, handleSaveAs, handleBackup, handleRestore, handleImport, handleBack }}
 */
export function useEditorSaveActions({
  electronAPI, t, showModal, hideModal, showToast,
  convertWindSpeed, WIND_UNITS, rootPath,
  renderCallsignLink, jumpToCallsign, setScreen,
}) {
  const doSave = async (createBackup, silent) => {
    const st = useAppStore.getState();
    try {
      const nativeWind = convertWindSpeed(st.windTimeline, WIND_UNITS.KNOTS, st._windSpeedUnit || WIND_UNITS.KNOTS);
      const result = await electronAPI.saveAcl({
        filePath: st.currentPath, flights: st.flights,
        before: st.before, after: st.after,
        arrayContent: st.arrayContent, originalBlocks: st.originalBlocks,
        _saveSec: st._saveSec, createBackup,
        weatherTimeline: st.weatherTimeline, windTimeline: nativeWind,
        runwayTimeline: st.runwayTimeline,
      });
      if (!result.success) {
        showModal(t('modal_save_failed'), result.error,
          <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>);
        return false;
      }
      const store = useAppStore.getState();
      if (st.weatherPath && st.timelineModified.weather) {
        await electronAPI.saveWeatherTimeline({ filePath: st.weatherPath, data: st.weatherTimeline });
        store.setTimelineModified('weather', false);
      }
      if (st.windPath && st.timelineModified.wind) {
        await electronAPI.saveWindTimeline({ filePath: st.windPath, data: nativeWind });
        store.setTimelineModified('wind', false);
      }
      if (st.runwayTimelinePath && st.timelineModified.runway) {
        await electronAPI.saveRunwayTimeline({ filePath: st.runwayTimelinePath, data: st.runwayTimeline });
        store.setTimelineModified('runway', false);
      }
      useAppStore.setState({ modified: false });
      if (!silent) {
        showModal(t('modal_save_success'), '',
          <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>);
      }
      return true;
    } catch (err) {
      showModal(t('modal_save_failed'), err.message,
        <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>);
      return false;
    }
  };

  const handleSave = async () => {
    const st = useAppStore.getState();
    if (!st.currentPath) { showToast(t('toast_no_file'), 'error'); return; }
    if (!st.flights.length) { showToast(t('toast_no_flight_data'), 'error'); return; }
    const dupes = validateCallsigns(st.flights);
    if (dupes.length > 0) {
      showModal(
        t('modal_duplicate_title'),
        <div>{t('modal_duplicate_body')}<br/><br/>{dupes.map((d, i) => [i > 0 && <br key={`sep-${d}`} />, <strong key={d} className="callsign-link" onClick={() => { hideModal(); jumpToCallsign(d); }}>{d}</strong>])}<br/><br/><span className="modal-hint-error">{t('modal_duplicate_save_cancelled')}</span></div>,
        <div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_close')}</button></div>
      );
      return;
    }
    const issues = runTripleValidation(st.flights, st.airportValues, st.currentAirport, st.audioCallsigns, st._saveSec, st._configStartTime, st._configEndTime, st.runwayTimeline, st.isV4);
    if (issues.length > 0) {
      showModal(t('modal_issues_title', { n: issues.length }),
        <div className="modal-issues-body">{issues.map((issue, i) => <p key={i} className="modal-issue-item">{renderCallsignLink(issue)}</p>)}<p className="modal-hint-error">{t('modal_issues_fix_hint_save')}</p></div>,
        <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_close')}</button></div>);
      return;
    }
    const saveCbRef = {};
    showModal(t('modal_backup_title'),
      <label className="modal-checkbox-row"><input type="checkbox" ref={el => saveCbRef.current = el} defaultChecked className="modal-checkbox" /><span>{t('modal_backup_checkbox')}</span></label>,
      <div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button><button className="btn-confirm" onClick={async () => { hideModal(); await doSave(saveCbRef.current ? saveCbRef.current.checked : true); }}>{t('modal_btn_confirm_save')}</button></div>);
  };

  const handleSaveAs = async () => {
    const st = useAppStore.getState();
    if (!st.currentPath) { showToast(t('toast_no_file'), 'error'); return; }
    if (!st.flights.length) { showToast(t('toast_no_flight_data'), 'error'); return; }
    const dupes = validateCallsigns(st.flights);
    if (dupes.length > 0) {
      showModal(
        t('modal_duplicate_title'),
        <span>{t('modal_duplicate_body')}<br/><br/><span className="modal-hint-error">{t('modal_duplicate_export_cancelled')}</span></span>,
        <div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_close')}</button></div>
      );
      return;
    }
    const issues = runTripleValidation(st.flights, st.airportValues, st.currentAirport, st.audioCallsigns, st._saveSec, st._configStartTime, st._configEndTime, st.runwayTimeline, st.isV4);
    if (issues.length > 0) {
      showModal(t('modal_issues_export_title', { n: issues.length }),
        <div className="modal-issues-body">{issues.map((i, idx) => <p key={idx} className="modal-issue-item">{i}</p>)}<p className="modal-hint-error">{t('modal_issues_fix_hint_export')}</p></div>,
        <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_close')}</button></div>);
      return;
    }
    await doSave(false, true);
    const result = await electronAPI.exportZip({ aclPath: st.currentPath });
    if (result.canceled) return;
    if (result.error) {
      showModal(t('modal_export_failed'), result.error,
        <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>);
      return;
    }
    showToast(t('toast_exported', { name: result.path.split(/[/\\]/).pop() }), 'success');
  };

  const handleBackup = async () => {
    const st = useAppStore.getState();
    if (!st.currentPath) { showToast(t('toast_no_file'), 'error'); return; }
    const doBackup = async () => {
      const r = await electronAPI.manualBackup(st.currentPath);
      if (r.canceled) return;
      if (r.error) showModal(t('modal_backup_failed'), r.error,
        <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>);
      else showToast(t('toast_backup_saved', { name: r.path.split(/[/\\]/).pop() }), 'success');
    };
    const check = await electronAPI.checkBackupExists(st.currentPath);
    if (check.success && check.exists) {
      showModal(
        t('modal_backup_overwrite_title'),
        <p className="modal-warning-text">{safeHtml(t('modal_backup_overwrite_body', { name: st.currentPath.split(/[/\\]/).pop() + '.bak' }))}</p>,
        <div className="modal-actions-row">
          <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
          <button className="btn-confirm" onClick={() => { hideModal(); doBackup(); }}>{t('modal_btn_overwrite')}</button>
        </div>
      );
    } else {
      doBackup();
    }
  };

  const handleRestore = async () => {
    const st = useAppStore.getState();
    if (!st.currentPath) { showToast(t('toast_no_file'), 'error'); return; }
    const check = await electronAPI.checkBackupExists(st.currentPath);
    if (!check.success || !check.exists) {
      showModal(t('modal_restore_failed'), t('modal_restore_no_backup'),
        <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>);
      return;
    }
    showModal(
      t('modal_restore_title'),
      <p className="modal-warning-text">{t('modal_restore_warning')}</p>,
      <div className="modal-actions-row">
        <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
        <button className="btn-confirm" onClick={async () => {
          hideModal();
          const r = await electronAPI.restoreBackup(st.currentPath);
          if (!r.success) {
            showModal(t('modal_restore_failed'), r.error,
              <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>);
            return;
          }
          st.setLegacyState({ flights: r.flights, modified: false, highlightedIdx: -1, selectedIndices: new Set(), _configStartTime: r.config?.startTime || null, _configEndTime: r.config?.endTime || null, _saveSec: r._saveSec, _currentDateTime: r._currentDateTime || null, isDemo: r.isDemo || false, isV4: r.isV4 || false });
          const tl = await electronAPI.loadTimelines(st.currentPath);
          if (tl.success) {
            const wsu2 = tl.windSpeedUnit || WIND_UNITS.KNOTS;
            st.setLegacyState({ weatherTimeline: tl.weatherTimeline || [], windTimeline: convertWindSpeed(tl.windTimeline || [], wsu2, WIND_UNITS.KNOTS), runwayTimeline: tl.runwayTimeline || { initialRunways: [], timeline: [] }, _windSpeedUnit: wsu2 });
          }
          const rp = await electronAPI.scanRunwayPairs(rootPath, st.currentAirport);
          if (rp?.success) st.setLegacyState({ _runwayPairs: rp.pairs || [] });
          showToast(t('toast_restored_n', { n: r.flights.length }), 'success');
        }}>{t('modal_btn_restore')}</button>
      </div>
    );
  };

  const handleImport = () => {
    const st = useAppStore.getState();
    if (!st.currentPath) { showToast(t('toast_no_file'), 'error'); return; }
    const importCbRef = {};
    showModal(
      t('modal_import_backup_title'),
      <div>
        <label className="modal-checkbox-row">
          <input type="checkbox" ref={el => importCbRef.current = el} defaultChecked className="modal-checkbox" />
          <span>{t('modal_import_checkbox')}</span>
        </label>
      </div>,
      <div className="modal-actions-row">
        <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
        <button className="btn-confirm" onClick={async () => {
          hideModal();
          if (importCbRef.current?.checked) { try { await doSave(true); } catch (_) {} }
          const r = await electronAPI.importZip({ aclPath: st.currentPath, createBackup: importCbRef.current?.checked ?? true });
          if (r.canceled) return;
          if (r.error) {
            showModal(t('modal_import_failed'), r.error === 'Level mismatch' ? t('modal_import_level_mismatch') : r.error,
              <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>);
            return;
          }
          st.setLegacyState({ flights: r.flights, modified: false, highlightedIdx: -1, selectedIndices: new Set(), _configStartTime: r.config?.startTime || null, _configEndTime: r.config?.endTime || null, _saveSec: r._saveSec, _currentDateTime: r._currentDateTime || null, isDemo: r.isDemo || false, isV4: r.isV4 || false });
          const tl = await electronAPI.loadTimelines(st.currentPath);
          if (tl.success) {
            const wsu3 = tl.windSpeedUnit || WIND_UNITS.KNOTS;
            st.setLegacyState({ weatherTimeline: tl.weatherTimeline || [], windTimeline: convertWindSpeed(tl.windTimeline || [], wsu3, WIND_UNITS.KNOTS), runwayTimeline: tl.runwayTimeline || { initialRunways: [], timeline: [] }, _windSpeedUnit: wsu3 });
          }
          const rp = await electronAPI.scanRunwayPairs(rootPath, st.currentAirport);
          if (rp?.success) st.setLegacyState({ _runwayPairs: rp.pairs || [] });
          showToast(t('toast_imported_n', { n: r.flights.length }), 'success');
        }}>{t('modal_btn_import')}</button>
      </div>
    );
  };

  const patchEditedFileInfo = async () => {
    const st = useAppStore.getState();
    const { currentPath, currentAirport } = st;
    if (!currentPath || !currentAirport) return;
    // Only patch if we have cached data for this airport
    if (!st.fileInfos?.[currentAirport]) {
      console.log('[patchEditedFileInfo] SKIP: no cache for', currentAirport);
      return;
    }
    try {
      const updatedInfo = await electronAPI.getFileInfo(currentPath);
      console.log('[patchEditedFileInfo] got updated info:', updatedInfo.filename,
        'startTime=' + updatedInfo.startTime, 'endTime=' + updatedInfo.endTime);
      if (updatedInfo && !updatedInfo.error) {
        useAppStore.getState().updateSingleFileInfo(
          currentAirport, currentPath, updatedInfo
        );
        console.log('[patchEditedFileInfo] cache updated for', currentAirport, currentPath);
      }
    } catch (e) {
      console.warn('[patchEditedFileInfo] failed:', e);
    }
  };

  const handleBack = async () => {
    const st = useAppStore.getState();
    st.closeStandMap();
    st.closeStarMap();
    const hasMod = st.modified || st.timelineModified.weather || st.timelineModified.wind || st.timelineModified.runway;
    if (!hasMod) {
      await patchEditedFileInfo();
      setScreen('browser');
      return;
    }
    showModal(t('modal_unsaved_title'), <p>{t('modal_unsaved_body')}</p>,
      <div className="modal-actions-row">
        <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
        <button className="btn-confirm" onClick={async () => { hideModal(); useAppStore.setState({ modified: false, timelineModified: { weather: false, wind: false, runway: false }, selectedIndices: new Set() }); await patchEditedFileInfo(); setScreen('browser'); }}>{t('modal_btn_discard')}</button>
      </div>);
  };

  return { doSave, handleSave, handleSaveAs, handleBackup, handleRestore, handleImport, handleBack, patchEditedFileInfo };
}
