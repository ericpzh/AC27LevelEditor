// ─── IMPORT FROM ZIP ────────────────────────────────────
document.getElementById('btn-import-acl').addEventListener('click', handleImportAcl);

async function handleImportAcl() {
  if (!appState.currentPath) { showToast('没有打开的文件', 'error'); return; }

  // 1) Save a backup first (like Save button with .bak)
  showModal('导入前备份', `
    <p style="font-size:14px;margin-bottom:12px">导入将覆盖当前所有关卡文件（.acl / .csv / 时间线）。</p>
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;white-space:nowrap">
      <input type="checkbox" id="chk-import-backup" checked style="flex-shrink:0;width:auto;margin:0">
      <span>导入前创建 .bak 备份</span>
    </label>
  `, `<button class="btn-cancel" id="modal-cancel-import">取消</button>
     <button class="btn-confirm" id="modal-confirm-import">确定导入</button>`);
  document.getElementById('modal-cancel-import').onclick = hideModal;
  document.getElementById('modal-confirm-import').onclick = async () => {
    const createBackup = document.getElementById('chk-import-backup').checked;
    hideModal();

    // Save current state with backup (best-effort)
    if (createBackup) {
      try { await doSaveAcl(true, true); } catch (_) {}
    }

    // 2) Import ZIP
    const result = await window.electronAPI.importZip({ aclPath: appState.currentPath });
    if (result.canceled) return;
    if (result.error) { showAlert('导入失败', result.error); return; }

    // 3) Apply loaded data to appState
    appState.flights = result.flights;
    initFlightNumberCounter();
    appState.before = result.before;
    appState.after = result.after;
    appState.arrayContent = result.arrayContent;
    appState.originalBlocks = result.originalBlocks;
    appState.worldStateData = result.worldStateData || null;
    appState.sceneryMaps = result.sceneryMaps || null;
    appState._fromWorldState = result._fromWorldState || false;
    appState._fromFlightPlans = result._fromFlightPlans || false;
    appState._rawText = result._rawText || '';
    appState.modified = false;
    appState.highlightedIdx = -1;
    appState.selectedIndices = new Set();
    appState.editingWidget = null;

    // 4) Reload timelines from the newly imported files
    const tl = await window.electronAPI.loadTimelines(appState.currentPath);
    if (tl.success) {
      appState.weatherTimeline = tl.weatherTimeline || [];
      appState.weatherPath = tl.weatherPath;
      appState.windTimeline = tl.windTimeline || [];
      appState.windPath = tl.windPath;
      appState.runwayTimeline = tl.runwayTimeline || { initialRunways: [], timeline: [] };
      appState.runwayTimelinePath = tl.runwayTimelinePath;
    }
    appState.timelineModified = { weather: false, wind: false, runway: false };

    // 5) Refresh runway pairs
    if (appState.rootPath && appState.currentAirport) {
      const rp = await window.electronAPI.scanRunwayPairs(appState.rootPath, appState.currentAirport);
      appState._runwayPairs = (rp && rp.success) ? (rp.pairs || []) : [];
    }

    autoSort();
    renderAllSections();
    updateStatusBar();
    showModal('导入成功 ✓', `
      <div style="font-size:14px;text-align:center">
        <p style="font-size:40px;margin:8px 0">✓</p>
        <p style="margin:8px 0">已成功导入关卡文件</p>
        <p style="color:var(--text-muted);font-size:13px;margin:4px 0">
          共 <strong style="color:var(--accent)">${result.flights.length}</strong> 个航班
        </p>
      </div>
    `, `<button class="btn-confirm" id="modal-import-ok">确定</button>`);
    document.getElementById('modal-import-ok').onclick = hideModal;
  };
}

// ─── RESTORE FROM BACKUP ─────────────────────────────────
document.getElementById('btn-restore-backup').addEventListener('click', handleRestoreBackup);

async function handleRestoreBackup() {
  if (!appState.currentPath) { showToast('没有打开的文件', 'error'); return; }

  showModal('还原备份确认', `
    <p>将从最新的 <code>.bak</code> 备份文件还原：</p>
    <ul style="text-align:left;font-size:13px;margin:8px 0;">
      <li>.acl.bak → .acl</li>
      <li>.csv.bak → .csv</li>
      <li>.json.bak → .json（天气/风力/跑道时间线）</li>
    </ul>
    <p style="color:var(--orange)">⚠ 当前未保存的更改将丢失。</p>
  `, `
    <button class="btn-cancel" id="modal-cancel">取消</button>
    <button class="btn-confirm" id="modal-confirm">确认还原</button>
  `);

  document.getElementById('modal-cancel').onclick = hideModal;
  document.getElementById('modal-confirm').onclick = async () => {
    hideModal();
    const result = await window.electronAPI.restoreBackup(appState.currentPath);
    if (!result.success) { showAlert('还原失败', result.error); return; }

    appState.flights = result.flights;
    initFlightNumberCounter();
    appState.before = result.before;
    appState.after = result.after;
    appState.arrayContent = result.arrayContent;
    appState.originalBlocks = result.originalBlocks;
    appState.worldStateData = result.worldStateData || null;
    appState.sceneryMaps = result.sceneryMaps || null;
    appState._fromWorldState = result._fromWorldState || false;
    appState._fromFlightPlans = result._fromFlightPlans || false;
    appState._rawText = result._rawText || '';
    appState.modified = false;
    appState.highlightedIdx = -1;
    appState.selectedIndices = new Set();
    appState.editingWidget = null;

    // Reload timelines from restored files
    const tl = await window.electronAPI.loadTimelines(appState.currentPath);
    if (tl.success) {
      appState.weatherTimeline = tl.weatherTimeline || [];
      appState.weatherPath = tl.weatherPath;
      appState.windTimeline = tl.windTimeline || [];
      appState.windPath = tl.windPath;
      appState.runwayTimeline = tl.runwayTimeline || { initialRunways: [], timeline: [] };
      appState.runwayTimelinePath = tl.runwayTimelinePath;
    }
    appState.timelineModified = { weather: false, wind: false, runway: false };

    // Refresh runway pairs
    if (appState.rootPath && appState.currentAirport) {
      const rp = await window.electronAPI.scanRunwayPairs(appState.rootPath, appState.currentAirport);
      appState._runwayPairs = (rp && rp.success) ? (rp.pairs || []) : [];
    }

    autoSort();
    renderAllSections();
    updateStatusBar();
    showToast(`已还原 ${result.flights.length} 个航班（${result.restored.join('、')}）`, 'success');
  };
}
