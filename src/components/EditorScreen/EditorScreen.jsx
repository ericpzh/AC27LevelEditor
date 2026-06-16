import React, { useState, useEffect, useMemo, useRef } from 'react';
import './EditorScreen.css';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { useAppStore } from '../../store/appStore';
import { useEditorShell } from '../../hooks/useEditorShell';
import { validateCallsigns, runTripleValidation } from '../../utils/validators';
import { ALL_FIELDS, ARRIVAL_FIELDS, DEPARTURE_FIELDS, FIELD_LABELS, COL_CLASSES, TIME_FIELDS, DROPDOWN_FIELDS, getActiveColumns, MPS_TO_KNOTS, WIND_UNITS } from '../../utils/constants';
import { stripSuffixes } from '../../utils/htmlUtils';
import { IoArrowBack, IoAirplane, IoCopyOutline, IoTrashOutline, IoCheckmarkDone, IoCloudUploadOutline, IoCloudDownloadOutline, IoDownloadOutline, IoShareOutline, IoSave, IoLanguage, IoHelpCircleOutline, IoSearchOutline, IoMapOutline, IoNavigateOutline } from 'react-icons/io5';

function convertWindSpeed(entries, fromUnit, toUnit) {
  if (!entries || !entries.length) return entries;
  if (fromUnit === toUnit) return entries;
  // Only mps ↔ knots conversion is needed; both other cases are identity
  const factor = (fromUnit === WIND_UNITS.MPS && toUnit === WIND_UNITS.KNOTS) ? MPS_TO_KNOTS
    : (fromUnit === WIND_UNITS.KNOTS && toUnit === WIND_UNITS.MPS) ? (1 / MPS_TO_KNOTS)
    : 1;
  if (factor === 1) return entries;
  // To avoid mutating readonly JSON-parsed objects (that may be frozen or reused
  // across restore/import flows), always return copies.
  return entries.map(e => ({ ...e, speed: Math.round(e.speed * factor) }));
}
import { IoSunnyOutline, IoMoonOutline } from 'react-icons/io5';
import FlightTable from './FlightTable/FlightTable';
import WeatherEditor from './TimelineEditors/WeatherEditor';
import WindEditor from './TimelineEditors/WindEditor';
import RunwayEditor from './TimelineEditors/RunwayEditor';
import SearchBar, { searchAPI } from './SearchBar';
import TutorialOverlay from './TutorialOverlay';
import StandMap from './StandMap/StandMap';
import StarMap from './StarMap/StarMap';

// ─── Sub-components ────────────────────────────────────────

function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function computeOccupiedStands(flights, currentIdx) {
  const flight = flights[currentIdx];
  if (!flight || flight.Stand == null || flight.Stand === '') return {};
  let keyTimeMin = null;
  if (flight.LandingTime) {
    keyTimeMin = timeToMinutes(flight.InBlockTime || flight.LandingTime);
  } else if (flight.OffBlockTime) {
    keyTimeMin = timeToMinutes(flight.OffBlockTime);
  }
  if (keyTimeMin === null) return {};
  const windowStart = keyTimeMin - 30;
  const windowEnd = keyTimeMin + 60;
  const occupied = {};
  for (let i = 0; i < flights.length; i++) {
    if (i === currentIdx) continue;
    const other = flights[i];
    if (!other.Stand) continue;
    let otherStart = null, otherEnd = null;
    if (other.LandingTime) {
      const t = timeToMinutes(other.InBlockTime || other.LandingTime);
      if (t !== null) { otherStart = t; otherEnd = t + 60; }
    } else if (other.OffBlockTime) {
      const t = timeToMinutes(other.OffBlockTime);
      if (t !== null) { otherStart = t - 30; otherEnd = t; }
    }
    if (otherStart !== null && otherEnd !== null) {
      if (otherStart < windowEnd && otherEnd > windowStart) {
        occupied[other.Stand] = { callsign: other.CallSign };
      }
    }
  }
  return occupied;
}

function MapOverlays({ standBtnRef, starBtnRef }) {
  const t = useTranslation();
  const updateFlight = useAppStore(s => s.updateFlight);
  const showStandMap = useAppStore(s => s.showStandMap);
  const showStarMap = useAppStore(s => s.showStarMap);
  const mapFlightIdx = useAppStore(s => s.mapFlightIdx);
  const flights = useAppStore(s => s.flights);
  const currentAirport = useAppStore(s => s.currentAirport);
  const closeStandMap = useAppStore(s => s.closeStandMap);
  const closeStarMap = useAppStore(s => s.closeStarMap);

  const airportValues = useAppStore(s => s.airportValues);
  const vals = airportValues[currentAirport] || {};

  // StandMap props
  const standPositions = vals._standPositions || null;
  const occupiedStands = useMemo(() => {
    if (!showStandMap || mapFlightIdx < 0) return {};
    return computeOccupiedStands(flights, mapFlightIdx);
  }, [showStandMap, mapFlightIdx, flights]);
  const flightForMap = flights[mapFlightIdx] || {};
  const selectedStand = flightForMap.Stand || null;
  const callsign = flightForMap.CallSign || '';
  const isDeparture = flightForMap.isDeparture || false;

  // StarMap props
  const starPaths = vals._starPaths || null;
  const starRunwayMap = vals._starRunwayMap || null;
  const runwayStarMap = vals._runwayStarMap || null;
  const runwayThresholds = vals._runwayThresholds || null;
  const selectedStar = flightForMap.Airway || null;
  const selectedRunway = flightForMap.Runway || null;
  const saveSec = useAppStore(s => s._saveSec);

  const arrivalFlights = useMemo(() => {
    if (!showStarMap) return [];
    return flights
      .filter(f => !f.isDeparture && f.Airway && f.Runway && f.LandingTime)
      .map(f => ({
        CallSign: f.CallSign,
        Airway: f.Airway,
        Runway: f.Runway,
        LandingTime: f.LandingTime,
      }));
  }, [showStarMap, flights]);

  console.log('[MapOverlays] render', { showStandMap, showStarMap, mapFlightIdx, hasStands: !!(standPositions && Object.keys(standPositions).length > 0) });

  return (
    <>
      {showStandMap && standPositions && Object.keys(standPositions).length > 0 && (
        <StandMap
          stands={standPositions}
          selectedStand={selectedStand}
          occupiedStands={occupiedStands}
          onSelect={(standId) => { updateFlight(mapFlightIdx, { Stand: standId }); }}
          onShrink={() => closeStandMap()}
          buttonRef={standBtnRef}
          airportIcao={currentAirport}
          callsign={callsign}
          taxiwayPaths={vals._taxiwayPaths}
          runwayData={vals._runwayData}
          areaData={vals._areaData}
        />
      )}
      {showStarMap && (
        <StarMap
          starPaths={starPaths}
          selectedStar={selectedStar}
          selectedRunway={selectedRunway}
          starRunwayMap={starRunwayMap}
          runwayThresholds={runwayThresholds}
          onSelect={(starName) => { updateFlight(mapFlightIdx, { Airway: starName }); }}
          onShrink={() => closeStarMap()}
          buttonRef={starBtnRef}
          airportIcao={currentAirport}
          callsign={callsign}
          isDeparture={isDeparture}
          arrivalFlights={arrivalFlights}
          saveSec={saveSec}
        />
      )}
    </>
  );
}

function ConfigBar() {
  const { t } = useTranslation();
  const _saveSec = useAppStore(s => s._saveSec);
  const _cs = useAppStore(s => s._configStartTime);
  const _e = useAppStore(s => s._configEndTime);
  // Resolve display start: _saveSec first, fall back to config.startTime + 13min warmup
  let saveSec = _saveSec;
  if (saveSec == null && _cs) {
    const p = String(_cs).split(':');
    saveSec = parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (parseInt(p[2]) || 0) + 780;
  }
  if (saveSec == null || !_e) return <span id="toolbar-time-range">{t('editor_time_range')}-</span>;
  const h = Math.floor(saveSec / 3600) % 24;
  const m = Math.floor((saveSec % 3600) / 60);
  const start = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  return <span id="toolbar-time-range">{t('editor_time_range')}{start} ~ {String(_e).substring(0, 5)}</span>;
}

function StatusBar() {
  const { t } = useTranslation();
  const flights = useAppStore(s => s.flights);
  const currentPath = useAppStore(s => s.currentPath);
  const currentAirport = useAppStore(s => s.currentAirport);
  const arr = flights.filter(f => (f.LandingTime || '').trim()).length;
  const dep = flights.length - arr;
  const fn = currentPath ? stripSuffixes(currentPath.split(/[/\\]/).pop()) : '—';
  return (
    <footer id="statusbar">
      <span id="editor-filename">{fn}</span>
      <span id="editor-airport" className="editor-airport">{currentAirport || ''}</span>
      <span id="flight-stats">
        <span className="stat-item"><span className="stat-dot arrival" />{t('status_arrivals')} {arr}</span>
        <span className="stat-item"><span className="stat-dot departure" />{t('status_departures')} {dep}</span>
        <span>{t('status_total')} {flights.length}</span>
      </span>
    </footer>
  );
}

// ─── Main Editor ────────────────────────────────────────────

export default function EditorScreen() {
  const { t, toggleLang } = useTranslation();
  const electronAPI = useElectronAPI();
  const theme = useAppStore(s => s.theme);
  const toggleTheme = useAppStore(s => s.toggleTheme);
  const showToast = useAppStore(s => s.showToast);
  const showModal = useAppStore(s => s.showModal);
  const hideModal = useAppStore(s => s.hideModal);
  const setScreen = useAppStore(s => s.setScreen);
  const rootPath = useAppStore(s => s.rootPath);
  const flights = useAppStore(s => s.flights);
  const selectedIndices = useAppStore(s => s.selectedIndices);
  const allSelected = flights.length > 0 && selectedIndices.size === flights.length;
  const _configStartTime = useAppStore(s => s._configStartTime);
  const _configEndTime = useAppStore(s => s._configEndTime);

  const [loading, setLoading] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);

  // ── Map toggle button refs (for expand/shrink animation origin) ──
  const standBtnRef = useRef(null);
  const starBtnRef = useRef(null);

  // ── Map toggle handlers ──
  const toggleStandMap = useAppStore(s => s.toggleStandMap);
  const toggleStarMap = useAppStore(s => s.toggleStarMap);
  const showStandMap = useAppStore(s => s.showStandMap);
  const showStarMap = useAppStore(s => s.showStarMap);

  // Load data on mount
  useEffect(() => {
    const pending = window._pendingEditor;
    if (!pending) return;
    window._pendingEditor = null;
    (async () => {
      setLoading(true);
      const { filePath, airportIcao } = pending;
      const data = await electronAPI.loadAcl(filePath);
      if (!data.success) { showModal(t('editor_load_failed'), data.error, <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>); setLoading(false); return; }
      const st = useAppStore.getState();
      st.setLegacyState({ currentPath: filePath, currentAirport: airportIcao, flights: data.flights, modified: false, highlightedIdx: -1, selectedIndices: new Set(), _configStartTime: data.config?.startTime || null, _configEndTime: data.config?.endTime || null, _earliestTime: data.earliestTime || null, _saveSec: data._saveSec, _currentDateTime: data._currentDateTime || null, isDemo: data.isDemo || false });
      if (rootPath && airportIcao) {
        const [vals, audio, tl, rp] = await Promise.all([electronAPI.collectValues(rootPath, airportIcao), electronAPI.loadAudioCallsigns(rootPath, airportIcao), electronAPI.loadTimelines(filePath), electronAPI.scanRunwayPairs(rootPath, airportIcao)]);
        console.log('[Editor] loaded aux data', { airportIcao, valsKeys: Object.keys(vals||{}), dropdowns: { Stand: vals?.Stand?.length, Runway: vals?.Runway?.length, AircraftType: vals?.AircraftType?.length } });
        // Auto-remove runway timeline entries outside the level time range
        // (mirrors the demo flight auto-removal in load-acl IPC for consistency)
        if (data.config && data.config.startTime && data.config.endTime && tl.success && tl.runwayTimeline && tl.runwayTimeline.timeline) {
          console.log('[Editor] runway filter: config.startTime=' + data.config.startTime + ' config.endTime=' + data.config.endTime + ' timeline.length=' + tl.runwayTimeline.timeline.length + ' isDemo=' + data.isDemo);
          const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
          const startMin = toMin(data.config.startTime), endMin = toMin(data.config.endTime);
          const before = tl.runwayTimeline.timeline.length;
          tl.runwayTimeline.timeline = tl.runwayTimeline.timeline.filter(entry => {
            if (!entry.time) return false;
            const t = toMin(entry.time);
            return t >= startMin && t <= endMin;
          });
          const removed = before - tl.runwayTimeline.timeline.length;
          if (removed > 0) {
            console.log('[Editor] Auto-removed ' + removed + ' runway timeline entries outside [' + data.config.startTime + ' ~ ' + data.config.endTime + ']');
          }
        }
        const wsu = tl.success ? (tl.windSpeedUnit || WIND_UNITS.KNOTS) : WIND_UNITS.KNOTS;
        st.setLegacyState({ airportValues: { ...st.airportValues, [airportIcao]: vals }, audioCallsigns: audio, weatherTimeline: tl.success ? (tl.weatherTimeline || []) : [], windTimeline: tl.success ? convertWindSpeed(tl.windTimeline || [], wsu, WIND_UNITS.KNOTS) : [], runwayTimeline: tl.success ? (tl.runwayTimeline || { initialRunways: [], timeline: [] }) : { initialRunways: [], timeline: [] }, _runwayPairs: (rp?.success) ? (rp.pairs || []) : [], weatherPath: tl.weatherPath, windPath: tl.windPath, runwayTimelinePath: tl.runwayTimelinePath, _windSpeedUnit: wsu });
      }
      setLoading(false);
      showToast(t('editor_loaded_n', { n: data.flights.length }), 'success');
    })();
  }, []);

  // Toolbar actions
  const addArrival = () => { useAppStore.getState().addArrivalFlight(); showToast(t('toast_added_arrival',{cs:useAppStore.getState().flights.slice(-1)[0]?.CallSign||''}),'success'); };
  const addDeparture = () => { useAppStore.getState().addDepartureFlight(); showToast(t('toast_added_departure',{cs:useAppStore.getState().flights.slice(-1)[0]?.CallSign||''}),'success'); };
  const copy = () => { const st=useAppStore.getState(); if(!st.selectedIndices.size&&st.highlightedIdx<0){showToast(t('toast_select_to_copy'),'error');return;} st.copySelected(); showToast(t('toast_copied_n',{n:st.selectedIndices.size||1}),'success'); };
  const del = () => { const st=useAppStore.getState(); if(!st.selectedIndices.size){showToast(t('toast_no_flights_selected'),'error');return;} const n=st.selectedIndices.size; const bodyText=t('modal_delete_confirm_body',{n:String(n)}); const m=bodyText.match(/^(.*?)<strong>(.*?)<\/strong>(.*)$/); showModal(t('modal_delete_confirm'),<div><p>{m?[m[1],<strong key="n">{m[2]}</strong>,m[3]]:bodyText}</p><p className="modal-hint-error">{t('modal_delete_irreversible')}</p></div>,<div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button><button className="btn-confirm" onClick={()=>{hideModal();useAppStore.getState().deleteSelected();showToast(t('toast_deleted_n',{n}),'success');}}>{t('modal_delete_btn',{n})}</button></div>); };
  const handleSelectAll = () => { const st=useAppStore.getState(); if(!st.flights.length){showToast(t('toast_no_flight_data'),'error');return;} st.toggleSelectAll(); };

  const handleFind = () => { const api = searchAPI.current; if (api) { api.setOpen(true); setTimeout(() => api.inputRef?.current?.focus(), 0); } };

  const doSave = async (createBackup, silent) => {
    const st = useAppStore.getState();
    try {
      const nativeWind = convertWindSpeed(st.windTimeline, WIND_UNITS.KNOTS, st._windSpeedUnit || WIND_UNITS.KNOTS);
      const result = await electronAPI.saveAcl({ filePath: st.currentPath, flights: st.flights, before: st.before, after: st.after, arrayContent: st.arrayContent, originalBlocks: st.originalBlocks, earliestTime: st._earliestTime, createBackup, weatherTimeline: st.weatherTimeline, windTimeline: nativeWind, runwayTimeline: st.runwayTimeline });
      if (!result.success) { showModal(t('modal_save_failed'), result.error, <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>); return false; }
      if (st.weatherPath && st.timelineModified.weather) { await electronAPI.saveWeatherTimeline({ filePath: st.weatherPath, data: st.weatherTimeline }); useAppStore.getState().setTimelineModified('weather', false); }
      if (st.windPath && st.timelineModified.wind) { await electronAPI.saveWindTimeline({ filePath: st.windPath, data: nativeWind }); useAppStore.getState().setTimelineModified('wind', false); }
      if (st.runwayTimelinePath && st.timelineModified.runway) { await electronAPI.saveRunwayTimeline({ filePath: st.runwayTimelinePath, data: st.runwayTimeline }); useAppStore.getState().setTimelineModified('runway', false); }
      useAppStore.setState({ modified: false });
      if (!silent) {
        showModal(
          t('modal_save_success'),
          '',
          <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>
        );
      }
      return true;
    } catch (err) { showModal(t('modal_save_failed'), err.message, <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>); return false; }
  };

  const jumpToCallsign = (callsign) => {
    hideModal();
    const api = searchAPI.current;
    if (!api) return;
    api.setTerm(callsign);
    api.setOpen(true);
    api.doSearch(callsign);
    setTimeout(() => api.inputRef?.current?.focus(), 0);
  };

  const renderCallsignLink = (text) => {
    const pattern = /\b([A-Z]{3}\d+[A-Z]?)\b/g;
    const parts = [];
    let lastIndex = 0, match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push({ type: 'text', content: text.substring(lastIndex, match.index) });
      parts.push({ type: 'callsign', content: match[1] });
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) parts.push({ type: 'text', content: text.substring(lastIndex) });
    if (parts.length === 0) return <span>{text}</span>;
    return (
      <span>
        {parts.map((part, i) =>
          part.type === 'callsign'
            ? <span key={i} className="callsign-link" onClick={() => { hideModal(); jumpToCallsign(part.content); }}>{part.content}</span>
            : <span key={i}>{part.content}</span>
        )}
      </span>
    );
  };

  const handleSave = async () => {
    const st = useAppStore.getState();
    if (!st.currentPath) { showToast(t('toast_no_file'),'error'); return; }
    if (!st.flights.length) { showToast(t('toast_no_flight_data'),'error'); return; }
    const dupes = validateCallsigns(st.flights);
    if (dupes.length > 0) {
      showModal(
        t('modal_duplicate_title'),
        <div>{t('modal_duplicate_body')}<br/><br/>{dupes.map((d, i) => [i > 0 && <br key={`sep-${d}`} />, <strong key={d} className="callsign-link" onClick={() => { hideModal(); jumpToCallsign(d); }}>{d}</strong>])}<br/><br/><span className="modal-hint-error">{t('modal_duplicate_save_cancelled')}</span></div>,
        <div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_close')}</button></div>
      );
      return;
    }
    const issues = runTripleValidation(st.flights, st.airportValues, st.currentAirport, st.audioCallsigns, st._saveSec, st._configStartTime, st._configEndTime, st.runwayTimeline);
    if (issues.length > 0) { showModal(t('modal_issues_title',{n:issues.length}), <div className="modal-issues-body">{issues.map((issue,i)=><p key={i} className="modal-issue-item">{renderCallsignLink(issue)}</p>)}<p className="modal-hint-error">{t('modal_issues_fix_hint_save')}</p></div>, <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_close')}</button></div>); return; }
    showModal(t('modal_backup_title'), <label className="modal-checkbox-row"><input type="checkbox" id="chk-save-backup" defaultChecked className="modal-checkbox" /><span>{t('modal_backup_checkbox')}</span></label>,
      <div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button><button className="btn-confirm" onClick={async()=>{const cb=document.getElementById('chk-save-backup');hideModal();await doSave(cb?cb.checked:true);}}>{t('modal_btn_confirm_save')}</button></div>);
  };

  const handleSaveAs = async () => {
    const st = useAppStore.getState();
    if (!st.currentPath) { showToast(t('toast_no_file'),'error'); return; }
    if (!st.flights.length) { showToast(t('toast_no_flight_data'),'error'); return; }
    const dupes = validateCallsigns(st.flights);
    if (dupes.length > 0) {
      showModal(
        t('modal_duplicate_title'),
        <span>{t('modal_duplicate_body')}<br/><br/><span className="modal-hint-error">{t('modal_duplicate_export_cancelled')}</span></span>,
        <div className="modal-actions-row"><button className="btn-cancel" onClick={hideModal}>{t('modal_btn_close')}</button></div>
      );
      return;
    }
    const issues = runTripleValidation(st.flights, st.airportValues, st.currentAirport, st.audioCallsigns, st._saveSec, st._configStartTime, st._configEndTime, st.runwayTimeline);
    if (issues.length > 0) { showModal(t('modal_issues_export_title',{n:issues.length}), <div className="modal-issues-body">{issues.map((i,idx)=><p key={idx} className="modal-issue-item">{i}</p>)}<p className="modal-hint-error">{t('modal_issues_fix_hint_export')}</p></div>, <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_close')}</button></div>); return; }
    await doSave(false, true);
    const result = await electronAPI.exportZip({ aclPath: st.currentPath });
    if (result.canceled) return;
    if (result.error) { showModal(t('modal_export_failed'), result.error, <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>); return; }
    showToast(t('toast_exported', { name: result.path.split(/[/\\]/).pop() }), 'success');
  };

  const handleBack = () => {
    const st = useAppStore.getState();
    // Close any open map overlays
    st.closeStandMap();
    st.closeStarMap();
    const hasMod = st.modified || st.timelineModified.weather || st.timelineModified.wind || st.timelineModified.runway;
    if (!hasMod) { setScreen('browser'); return; }
    showModal(t('modal_unsaved_title'), <p>{t('modal_unsaved_body')}</p>,
      <div className="modal-actions-row">
        <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
        <button className="btn-confirm" onClick={() => { hideModal(); useAppStore.setState({ modified: false, timelineModified: { weather: false, wind: false, runway: false }, selectedIndices: new Set() }); setScreen('browser'); }}>{t('modal_btn_discard')}</button>
      </div>);
  };

  const handleBackup = async () => {
    const st = useAppStore.getState();
    if (!st.currentPath) { showToast(t('toast_no_file'), 'error'); return; }
    const doBackup = async () => {
      const r = await electronAPI.manualBackup(st.currentPath);
      if (r.canceled) return;
      if (r.error) showModal(t('modal_backup_failed'), r.error, <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>);
      else showToast(t('toast_backup_saved', { name: r.path.split(/[/\\]/).pop() }), 'success');
    };
    const check = await electronAPI.checkBackupExists(st.currentPath);
    if (check.success && check.exists) {
      showModal(
        t('modal_backup_overwrite_title'),
        <p className="modal-warning-text" dangerouslySetInnerHTML={{ __html: t('modal_backup_overwrite_body', { name: st.currentPath.split(/[/\\]/).pop() + '.bak' }) }} />,
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
    // Check backup exists before showing confirmation modal
    const check = await electronAPI.checkBackupExists(st.currentPath);
    if (!check.success || !check.exists) {
      showModal(t('modal_restore_failed'), t('modal_restore_no_backup'),
        <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>
      );
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
          if (!r.success) { showModal(t('modal_restore_failed'), r.error, <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>); return; }
          st.setLegacyState({ flights: r.flights, modified: false, highlightedIdx: -1, selectedIndices: new Set(), _configStartTime: r.config?.startTime || null, _configEndTime: r.config?.endTime || null, _earliestTime: r.earliestTime || null, _saveSec: r._saveSec, _currentDateTime: r._currentDateTime || null, isDemo: r.isDemo || false });

          const tl = await electronAPI.loadTimelines(st.currentPath);
          if (tl.success) { const wsu2 = tl.windSpeedUnit || WIND_UNITS.KNOTS; st.setLegacyState({ weatherTimeline: tl.weatherTimeline || [], windTimeline: convertWindSpeed(tl.windTimeline || [], wsu2, WIND_UNITS.KNOTS), runwayTimeline: tl.runwayTimeline || { initialRunways: [], timeline: [] }, _windSpeedUnit: wsu2 }); }
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
    showModal(
      t('modal_import_backup_title'),
      <div>
        <label className="modal-checkbox-row">
          <input type="checkbox" id="chk-import-backup" defaultChecked className="modal-checkbox" />
          <span>{t('modal_import_checkbox')}</span>
        </label>
      </div>,
      <div className="modal-actions-row">
        <button className="btn-cancel" onClick={hideModal}>{t('modal_btn_cancel')}</button>
        <button className="btn-confirm" onClick={async () => {
          const cb = document.getElementById('chk-import-backup');
          hideModal();
          if (cb?.checked) { try { await doSave(true); } catch (_) {} }
          const r = await electronAPI.importZip({ aclPath: st.currentPath, createBackup: cb?.checked ?? true });
          if (r.canceled) return;
          if (r.error) { showModal(t('modal_import_failed'), r.error === 'Level mismatch' ? t('modal_import_level_mismatch') : r.error, <div className="modal-actions-row"><button className="btn-confirm" onClick={hideModal}>{t('modal_btn_ok')}</button></div>); return; }
          st.setLegacyState({ flights: r.flights, modified: false, highlightedIdx: -1, selectedIndices: new Set(), _configStartTime: r.config?.startTime || null, _configEndTime: r.config?.endTime || null, _earliestTime: r.earliestTime || null, _saveSec: r._saveSec, _currentDateTime: r._currentDateTime || null, isDemo: r.isDemo || false });

          const tl = await electronAPI.loadTimelines(st.currentPath);
          if (tl.success) { const wsu3 = tl.windSpeedUnit || WIND_UNITS.KNOTS; st.setLegacyState({ weatherTimeline: tl.weatherTimeline || [], windTimeline: convertWindSpeed(tl.windTimeline || [], wsu3, WIND_UNITS.KNOTS), runwayTimeline: tl.runwayTimeline || { initialRunways: [], timeline: [] }, _windSpeedUnit: wsu3 }); }
          const rp = await electronAPI.scanRunwayPairs(rootPath, st.currentAirport);
          if (rp?.success) st.setLegacyState({ _runwayPairs: rp.pairs || [] });
          showToast(t('toast_imported_n', { n: r.flights.length }), 'success');
        }}>{t('modal_btn_import')}</button>
      </div>
    );
  };

  // Keyboard shortcuts
  useEditorShell({ onSave: handleSave });

  // Compute table data
  const arrivals = useMemo(() => flights.filter(fl => (fl.LandingTime || '').trim()).sort((a, b) => (a.LandingTime || '').localeCompare(b.LandingTime || '')), [flights]);
  const departures = useMemo(() => flights.filter(fl => !(fl.LandingTime || '').trim()).sort((a, b) => (a.OffBlockTime || '99:99').localeCompare(b.OffBlockTime || '99:99')), [flights]);
  const arrCols = useMemo(() => getActiveColumns(arrivals, ARRIVAL_FIELDS), [arrivals]);
  const depCols = useMemo(() => getActiveColumns(departures, DEPARTURE_FIELDS), [departures]);

  if (loading) return <div className="screen"><div className="loading-state"><div className="spinner" /><p>{t('editor_loading')}</p></div></div>;

  return (
    <div id="screen-editor" className="screen">
      <header id="toolbar">
        <div className="toolbar-group">
          <button onClick={handleBack}><IoArrowBack size={14} className="btn-icon" /> {t('toolbar_back')}</button>
          <button onClick={() => setTutorialOpen(true)} title={t('toolbar_help')}><IoHelpCircleOutline size={14} className="btn-icon" /> {t('toolbar_help')}</button>
          <button onClick={toggleLang}><IoLanguage size={14} className="btn-icon" /> {t('lang_switch_to')}</button>
          <button onClick={toggleTheme}>
            {theme === 'dark' ? <IoSunnyOutline size={14} /> : <IoMoonOutline size={14} />}
          </button>
        </div>
        <div className="toolbar-spacer" />
        <div className="toolbar-group">
          <button onClick={handleBackup}><IoCloudUploadOutline size={14} className="btn-icon" /> {t('toolbar_backup')}</button>
          <button onClick={handleRestore}><IoCloudDownloadOutline size={14} className="btn-icon" /> {t('toolbar_restore')}</button>
          <button onClick={handleImport}><IoDownloadOutline size={14} className="btn-icon" /> {t('toolbar_import')}</button>
          <button onClick={handleSaveAs}><IoShareOutline size={14} className="btn-icon" /> {t('toolbar_save_as')}</button>
          <button className="btn-primary-sm" onClick={handleSave}><IoSave size={14} className="btn-icon" /> {t('toolbar_save')}</button>
        </div>
      </header>
      <main id="table-container">
        <div id="tab-flights" className="tab-panel">
          <WeatherEditor />
          <WindEditor />
          <RunwayEditor />
          <div id="sections-container">
            <FlightTable type="arrivals" flights={arrivals} columns={arrCols} />
            <FlightTable type="departures" flights={departures} columns={depCols} />
          </div>
        </div>
      </main>
      <SearchBar />
      <div id="secondary-toolbar">
        <div className="toolbar-group secondary-left">
          <button ref={starBtnRef} onClick={toggleStarMap} className={showStarMap ? 'btn-map-active' : ''} title={t('starmap_title')}><IoNavigateOutline size={14} className="btn-icon" /> {t('toolbar_star_map')}</button>
          <button ref={standBtnRef} onClick={toggleStandMap} className={showStandMap ? 'btn-map-active' : ''} title={t('standmap_title')}><IoMapOutline size={14} className="btn-icon" /> {t('toolbar_stand_map')}</button>
          <button onClick={addArrival}><span className="btn-icon-wrap" style={{borderBottom:'1.5px solid var(--text-secondary)',paddingBottom:'1px',display:'inline-block',lineHeight:1}}><IoAirplane size={14} style={{transform:'rotate(45deg)',display:'block'}} /></span> {t('toolbar_add_arrival')}</button>
          <button onClick={addDeparture}><span className="btn-icon-wrap" style={{borderBottom:'1.5px solid var(--text-secondary)',paddingBottom:'1px',display:'inline-block',lineHeight:1}}><IoAirplane size={14} style={{transform:'rotate(-45deg)',display:'block'}} /></span> {t('toolbar_add_departure')}</button>
        </div>
        <div className="toolbar-time-wrap"><ConfigBar /></div>
        <div className="toolbar-group secondary-right">
          <button onClick={copy}><IoCopyOutline size={14} className="btn-icon" /> {t('toolbar_copy')}</button>
          <button onClick={handleSelectAll} title={allSelected ? t('toolbar_deselect_all') : t('toolbar_select_all')}><IoCheckmarkDone size={14} className="btn-icon" /> {allSelected ? t('toolbar_deselect_all') : t('toolbar_select_all')}</button>
          <button onClick={del}><IoTrashOutline size={14} className="btn-icon" /> {t('toolbar_delete_selected')}</button>
          <button onClick={handleFind}><IoSearchOutline size={14} className="btn-icon" /> {t('toolbar_find')}</button>
        </div>
      </div>
      <MapOverlays standBtnRef={standBtnRef} starBtnRef={starBtnRef} />
      <StatusBar />
      {tutorialOpen && <TutorialOverlay onClose={() => setTutorialOpen(false)} />}
    </div>
  );
}
