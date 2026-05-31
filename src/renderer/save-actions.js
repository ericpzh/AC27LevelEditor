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
    await doSaveAcl(createBackup);
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

  if (appState._configStartTime && appState._configEndTime) {
    const toHHMM = (s) => {
      const parts = String(s).split(':');
      return parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);
    };
    const startTime = toHHMM(appState._configStartTime);
    let endTime = toHHMM(appState._configEndTime);
    endTime += 15;

    appState.flights.forEach((fl, i) => {
      for (const col of ['OffBlockTime', 'TakeoffTime', 'LandingTime', 'InBlockTime']) {
        const timeVal = fl[col];
        if (!timeVal) continue;
        const parts = String(timeVal).split(':');
        if (parts.length < 2) continue;
        const t = parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);
        if (t < startTime || t > endTime) {
          issues.push(`航班 #${i+1} (${fl.CallSign || '?'}): ${FIELD_LABELS[col] || col} "${timeVal}" 超出有效时间范围`);
        }
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

async function doSaveAcl(createBackup) {
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
      createBackup,
    });

    if (!result.success) { showAlert('保存失败', result.error || '未知错误'); return; }

    const tlErrors = [];
    if (appState.weatherPath && appState.timelineModified.weather) {
      const wr = await window.electronAPI.saveWeatherTimeline({ filePath: appState.weatherPath, data: appState.weatherTimeline });
      if (!wr.success) tlErrors.push('天气: ' + wr.error);
      else appState.timelineModified.weather = false;
    }
    if (appState.windPath && appState.timelineModified.wind) {
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

    const tlMsg = tlErrors.length > 0
      ? `<br><br><span style="color:var(--orange)">时间线保存警告：${tlErrors.join(', ')}</span>`
      : '';
    const csvMsg = result.csvSynced
      ? `<p style="font-size:12px;color:var(--green)">CSV 航班表已同步更新（游戏将读取最新数据）</p>`
      : '';
    const backupMsg = createBackup
      ? `<p style="font-size:12px;color:var(--text-muted)">.bak 备份已创建（覆盖式）</p>`
      : '';
    showModal('保存成功', `<p>文件已成功保存。</p>${backupMsg}${tlMsg}${csvMsg}`, `<button class="btn-confirm" id="modal-ok">确定</button>`);
    document.getElementById('modal-ok').onclick = hideModal;
  } catch (err) {
    showAlert('保存失败', err.message);
  }
}

// ─── SAVE AS ─────────────────────────────────────────────
document.getElementById('btn-save-as').addEventListener('click', handleSaveAs);

async function handleSaveAs() {
  if (appState.flights.length === 0) { showToast('没有航班数据', 'error'); return; }

  const result = await window.electronAPI.saveAsAcl({
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
    suggestedName: appState.currentPath ? appState.currentPath.split(/[/\\]/).pop() : 'edited_level.acl',
  });

  if (result.canceled) return;
  if (result.error) { showAlert('保存失败', result.error); return; }

  appState.currentPath = result.path;
  appState.modified = false;
  updateStatusBar();
  renderAllSections();
  showToast('已另存为: ' + result.path.split(/[/\\]/).pop(), 'success');
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
