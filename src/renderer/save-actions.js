// ─── SAVE with validation ────────────────────────────────
document.getElementById('btn-save').addEventListener('click', handleSave);

function validateCallsigns() {
  const seen = new Map();
  const dupes = [];
  appState.flights.forEach((fl, i) => {
    const cs = (fl.CallSign || '').trim();
    if (!cs) return;
    if (seen.has(cs)) { if (!dupes.includes(cs)) dupes.push(cs); }
    else seen.set(cs, i);
  });
  return dupes;
}

async function handleSave() {
  if (!appState.currentPath) { showToast('没有打开的文件', 'error'); return; }
  if (appState.flights.length === 0) { showToast('没有航班数据可保存', 'error'); return; }

  const dupes = validateCallsigns();
  if (dupes.length > 0) {
    showAlert('呼号重复', `以下呼号出现了多次，请修正后再保存：<br><br>
      ${dupes.map(d => `<strong>${escapeHtml(d)}</strong>`).join('<br>')}
      <br><br><span style="color:var(--red)">保存已取消。</span>`);
    return;
  }

  const issues = runTripleValidation();
  if (issues.length > 0) {
    const issueHtml = issues.map((issue, i) =>
      `<p style="margin:4px 0;font-size:13px"><strong>#${i+1}</strong> ${escapeHtml(issue)}</p>`
    ).join('');
    showModal(`${issues.length} 个问题需要修复后才能保存`, `
      <div style="max-height:400px;overflow-y:auto;text-align:left;margin-bottom:12px">${issueHtml}</div>
      <p style="color:var(--red);font-size:13px">请在修复所有问题后再保存。</p>
    `, `<button class="btn-confirm" id="modal-close-issues">关闭</button>`);
    document.getElementById('modal-close-issues').onclick = hideModal;
    return;
  }

  showModal('保存前备份', `
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;white-space:nowrap">
      <input type="checkbox" id="chk-create-backup" checked style="flex-shrink:0;width:auto;margin:0">
      <span>创建 .bak 备份</span>
    </label>
  `, `<button class="btn-cancel" id="modal-cancel-backup">取消</button>
     <button class="btn-confirm" id="modal-confirm-save">确定保存</button>`);
  document.getElementById('modal-cancel-backup').onclick = hideModal;
  document.getElementById('modal-confirm-save').onclick = async () => {
    const createBackup = document.getElementById('chk-create-backup').checked;
    hideModal();
    await doSaveAcl(createBackup, false);
  };
}

/**
 * Triple validation: (a) dropdown options, (b) time range, (c) runway timeline.
 */
function runTripleValidation() {
  const issues = [];
  const values = appState.airportValues[appState.currentAirport] || {};
  const audioData = appState.audioCallsigns;
  const compat = values._compat || {};

  const airlineCodeSet = new Set(audioData.allAirlines || []);
  for (const fl of appState.flights) {
    const ac = (fl.CallSign || '').substring(0, 3);
    if (ac) airlineCodeSet.add(ac);
  }
  const validSets = {
    AirlineCode: airlineCodeSet,
    Stand: new Set(values.Stand || []),
    Runway: new Set(values.Runway || []),
    DepartureAirport: new Set(values.DepartureAirport || []),
    ArrivalAirport: new Set(values.ArrivalAirport || []),
    AircraftType: new Set(values.AircraftType || []),
    Voice: new Set(values.Voice || []),
    Language: new Set(['en', 'zh']),
  };

  appState.flights.forEach((fl, i) => {
    const airlineCode = (fl.CallSign || '').substring(0, 3);
    if (airlineCode && !validSets.AirlineCode.has(airlineCode)) {
      issues.push(`航班 #${i+1} (${fl.CallSign || '?'}): 航司代码 "${airlineCode}" 不在有效白名单中`);
    }
    const flightNum = (fl.CallSign || '').substring(3);
    if (airlineCode && flightNum) {
      const validNums = audioData.byAirline[airlineCode] || [];
      if (validNums.length > 0 && !validNums.includes(flightNum)) {
        issues.push(`航班 #${i+1} (${fl.CallSign || '?'}): 航班号 "${flightNum}" 不在航司 ${airlineCode} 的有效列表中`);
      }
    }
    for (const col of ['Stand', 'Runway', 'DepartureAirport', 'ArrivalAirport', 'AircraftType', 'Voice', 'Language']) {
      const val = fl[col];
      if (val && validSets[col] && validSets[col].size > 0 && !validSets[col].has(val)) {
        issues.push(`航班 #${i+1} (${fl.CallSign || '?'}): ${FIELD_LABELS[col] || col} "${val}" 不在有效选项中`);
      }
    }
  });

  if (appState._earliestTime && appState._configEndTime) {
    const toHHMM = (s) => {
      const parts = String(s).split(':');
      return parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);
    };
    // Arrival floor = earliest + 10 min, departure floor = earliest
    const etParts = String(appState._earliestTime).split(':');
    const etH = parseInt(etParts[0], 10);
    const etM = parseInt(etParts[1], 10);
    const depStartTime = etH * 100 + etM;
    const arrStartTime = Math.floor((etH * 60 + etM + 10) / 60) * 100 + ((etH * 60 + etM + 10) % 60);
    let endTime = toHHMM(appState._configEndTime);
    endTime += 15;

    const floorLabel = String(etH).padStart(2, '0') + ':' + String(etM).padStart(2, '0');
    const arrFloorH = Math.floor((etH * 60 + etM + 10) / 60) % 24;
    const arrFloorM = (etH * 60 + etM + 10) % 60;
    const arrFloorLabel = String(arrFloorH).padStart(2, '0') + ':' + String(arrFloorM).padStart(2, '0');
    const endTotal = Math.floor(toHHMM(appState._configEndTime) / 100) * 60 + (toHHMM(appState._configEndTime) % 100) + 15;
    const endH = Math.floor(endTotal / 60) % 24;
    const endM = endTotal % 60;
    const endLabel = String(endH).padStart(2, '0') + ':' + String(endM).padStart(2, '0');

    appState.flights.forEach((fl, i) => {
      for (const col of ['OffBlockTime', 'TakeoffTime', 'LandingTime', 'InBlockTime']) {
        const timeVal = fl[col];
        if (!timeVal) continue;
        const parts = String(timeVal).split(':');
        if (parts.length < 2) continue;
        const t = parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);
        const isDep = (col === 'OffBlockTime' || col === 'TakeoffTime');
        const minT = isDep ? depStartTime : arrStartTime;
        const rangeLabel = '≥ ' + (isDep ? floorLabel : arrFloorLabel) + ' / ≤ ' + endLabel;
        if (t < minT || t > endTime) {
          issues.push(`航班 #${i+1} (${fl.CallSign || '?'}): ${FIELD_LABELS[col] || col} "${timeVal}" 超出允许范围 (${rangeLabel})`);
        }
      }
    });
  }

  // Sort runway timeline entries by time before validation & save
  const _toSec2 = (t) => { const p = String(t || '').split(':'); return (parseInt(p[0]) || 0) * 3600 + (parseInt(p[1]) || 0) * 60 + (parseInt(p[2]) || 0); };
  if (appState.runwayTimeline.timeline && appState.runwayTimeline.timeline.length > 1) {
    appState.runwayTimeline.timeline.sort((a, b) => _toSec2(a.time) - _toSec2(b.time));
  }

  // (c) Runway timeline time validation — strictly between level start/end
  if (appState._configStartTime && appState._configEndTime && appState.runwayTimeline.timeline) {
    const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
    const startMin = toMin(appState._configStartTime);
    const endMin = toMin(appState._configEndTime);

    appState.runwayTimeline.timeline.forEach((entry, i) => {
      if (!entry.time) return;
      const t = toMin(entry.time);
      if (t <= startMin || t >= endMin) {
        issues.push(`跑道变更 #${i + 1}: 时间 "${entry.time}" 不在关卡范围内 (${appState._configStartTime} ~ ${appState._configEndTime})（须严格介于起止时间之间）`);
      }
    });
  }

  const runwayTL = appState.runwayTimeline;
  if (runwayTL && runwayTL.initialRunways && runwayTL.timeline) {
    const initialRunways = runwayTL.initialRunways || [];
    const changes = runwayTL.timeline || [];

    appState.flights.forEach((fl, i) => {
      const rwy = fl.Runway;
      if (!rwy) return;
      const checkTime = fl.LandingTime || fl.OffBlockTime;
      if (!checkTime) return;
      const parts = String(checkTime).split(':');
      if (parts.length < 2) return;
      const checkT = parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);

      let activeRunways = new Set(initialRunways);
      for (const change of changes) {
        const ct = typeof change.time === 'string' ? parseInt(change.time, 10) : change.time;
        if (ct != null && ct <= checkT) {
          const rwList = change.runways || change.activeRunways || change.Runways || [];
          if (rwList.length > 0) activeRunways = new Set(rwList);
        }
      }

      if (activeRunways.size > 0 && !activeRunways.has(rwy)) {
        issues.push(`航班 #${i+1} (${fl.CallSign || '?'}): 在 ${checkTime} 时刻，跑道 "${rwy}" 不在活跃跑道列表中`);
      }
    });
  }

  return issues;
}

async function doSaveAcl(createBackup, silent) {
  try {
    const result = await window.electronAPI.saveAcl({
      filePath: appState.currentPath,
      flights: appState.flights,
      before: appState.before,
      after: appState.after,
      arrayContent: appState.arrayContent,
      originalBlocks: appState.originalBlocks,
      worldStateData: appState.worldStateData,
      sceneryMaps: appState.sceneryMaps,
      _fromWorldState: appState._fromWorldState,
      _fromFlightPlans: appState._fromFlightPlans,
      _rawText: appState._rawText,
      earliestTime: appState._earliestTime,
      createBackup,
      weatherTimeline: appState.weatherTimeline,
      windTimeline: appState.windTimeline,
      runwayTimeline: appState.runwayTimeline,
    });

    if (!result.success) { showAlert('保存失败', result.error || '未知错误'); return false; }

    const tlErrors = [];
    // Sort by time before save so stored order is always canonical
    const _toSecSort = (t) => { const p = String(t || '').split(':'); return (parseInt(p[0]) || 0) * 3600 + (parseInt(p[1]) || 0) * 60 + (parseInt(p[2]) || 0); };
    if (appState.weatherPath && appState.timelineModified.weather) {
      appState.weatherTimeline.sort((a, b) => _toSecSort(a.time) - _toSecSort(b.time));
      const wr = await window.electronAPI.saveWeatherTimeline({ filePath: appState.weatherPath, data: appState.weatherTimeline });
      if (!wr.success) tlErrors.push('天气: ' + wr.error);
      else appState.timelineModified.weather = false;
    }
    if (appState.windPath && appState.timelineModified.wind) {
      appState.windTimeline.sort((a, b) => _toSecSort(a.time) - _toSecSort(b.time));
      const wr = await window.electronAPI.saveWindTimeline({ filePath: appState.windPath, data: appState.windTimeline });
      if (!wr.success) tlErrors.push('风力: ' + wr.error);
      else appState.timelineModified.wind = false;
    }
    if (appState.runwayTimelinePath && appState.timelineModified.runway) {
      const rr = await window.electronAPI.saveRunwayTimeline({ filePath: appState.runwayTimelinePath, data: appState.runwayTimeline });
      if (!rr.success) tlErrors.push('跑道: ' + rr.error);
      else appState.timelineModified.runway = false;
    }

    appState.modified = false;
    appState.highlightedCells.clear();
    updateStatusBar();
    renderAllSections();

    if (silent) return true;

    if (tlErrors.length > 0) {
      console.warn('[SAVE] 时间线保存警告：' + tlErrors.join(', '));
    }
    showModal('保存成功', '', `<button class="btn-confirm" id="modal-ok">确定</button>`);
    document.getElementById('modal-ok').onclick = hideModal;
    return true;
  } catch (err) {
    showAlert('保存失败', err.message);
    return false;
  }
}

// ─── SAVE AS (Export ZIP) ──────────────────────────────────
document.getElementById('btn-save-as').addEventListener('click', handleSaveAs);

async function handleSaveAs() {
  if (!appState.currentPath) { showToast('没有打开的文件', 'error'); return; }
  if (appState.flights.length === 0) { showToast('没有航班数据', 'error'); return; }

  // 1) Full save to current path (same as Save button, silent mode)
  const saved = await doSaveAcl(false, true);
  if (!saved) return;

  // 2) Package into ZIP and show save dialog
  const result = await window.electronAPI.exportZip({ aclPath: appState.currentPath });
  if (result.canceled) return;
  if (result.error) { showAlert('导出失败', result.error); return; }

  showToast('已导出: ' + result.path.split(/[/\\]/).pop(), 'success');
}

// ─── MANUAL BACKUP ───────────────────────────────────────
document.getElementById('btn-backup-only').addEventListener('click', handleManualBackup);

async function handleManualBackup() {
  if (!appState.currentPath) { showToast('没有打开的文件', 'error'); return; }
  const result = await window.electronAPI.manualBackup(appState.currentPath);
  if (result.canceled) return;
  if (result.error) { showAlert('备份失败', result.error); return; }
  showToast('备份已保存: ' + result.path.split(/[/\\]/).pop(), 'success');
}
