// ─── IMPORT EXTERNAL ACL ─────────────────────────────────
document.getElementById('btn-import-acl').addEventListener('click', handleImportAcl);

async function handleImportAcl() {
  const result = await window.electronAPI.importAcl();
  if (result.canceled) return;
  if (result.error) { showAlert('导入失败', result.error); return; }

  appState.currentPath = result.path;
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
  appState.modified = true;
  appState.highlightedIdx = -1;
  appState.selectedIndices = new Set();
  appState.editingWidget = null;

  const parts = result.path.split(/[/\\]/);
  const levelsIdx = parts.indexOf('Levels');
  if (levelsIdx > 1) appState.currentAirport = parts[levelsIdx - 1];

  autoSort();
  renderAllSections();
  updateStatusBar();
  showToast(`已导入 ${result.flights.length} 个航班`, 'success');
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

    autoSort();
    renderAllSections();
    updateStatusBar();
    showToast(`已还原 ${result.flights.length} 个航班（${result.restored.join('、')}）`, 'success');
  };
}
