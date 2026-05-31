// ─── Navigation (back to browser, with unsaved check) ────

window.electronAPI.onNavBrowser(() => {
  const hasAnyMod = appState.modified || appState.timelineModified.weather
    || appState.timelineModified.wind || appState.timelineModified.runway;
  if (appState.screen === 'editor' && hasAnyMod) {
    showModal('未保存的更改', '<p>当前文件有未保存的更改，确定要返回吗？</p>',
      `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-confirm" id="modal-confirm">放弃更改</button>`);
    document.getElementById('modal-cancel').onclick = hideModal;
    document.getElementById('modal-confirm').onclick = () => {
      hideModal();
      appState.modified = false;
      appState.timelineModified = { weather: false, wind: false, runway: false };
      appState.selectedIndices = new Set();
      showBrowser();
    };
  } else if (appState.screen === 'editor') {
    appState.selectedIndices = new Set();
    showBrowser();
  }
});

// ─── Collapsible Sections & Timeline Blocks ──────────────

document.getElementById('table-container').addEventListener('click', (e) => {
  // Timeline block collapse
  const embHdr = e.target.closest('.tl-embed-header');
  if (embHdr) {
    const block = embHdr.closest('.tl-embed-block');
    block.classList.toggle('collapsed');
    const arrow = embHdr.querySelector('.tl-embed-arrow');
    arrow.textContent = block.classList.contains('collapsed') ? '▸' : '▾';
    return;
  }

  // Flight section collapse
  const secHdr = e.target.closest('.collapse-header');
  if (secHdr) {
    const section = secHdr.closest('.section-block');
    section.classList.toggle('collapsed');
    const arrow = secHdr.querySelector('.collapse-arrow');
    arrow.textContent = section.classList.contains('collapsed') ? '▸' : '▾';
    return;
  }
});

// ─── Timeline Status ─────────────────────────────────────

function updateTimelineStatus() {
  // No visual dot indicators — kept as hook for future use
}

// ─── Editor Status Bar ───────────────────────────────────

function updateStatusBar() {
  const fp = appState.currentPath;
  document.getElementById('editor-filename').textContent = fp ? stripSuffixes(fp.split(/[/\\]/).pop()) : '—';
  document.getElementById('editor-airport').textContent = appState.currentAirport || '';

  let arr = 0, dep = 0;
  appState.flights.forEach(fl => {
    if ((fl.LandingTime || '').trim()) arr++;
    else dep++;
  });
  document.getElementById('flight-stats').innerHTML = `
    <span class="stat-item"><span class="stat-dot arrival"></span>进港 ${arr}</span>
    <span class="stat-item"><span class="stat-dot departure"></span>离港 ${dep}</span>
    <span>总计 ${appState.flights.length}</span>
  `;
}

// ─── Back Button ─────────────────────────────────────────

document.getElementById('btn-back').addEventListener('click', () => {
  const hasAnyMod = appState.modified || appState.timelineModified.weather
    || appState.timelineModified.wind || appState.timelineModified.runway;
  if (hasAnyMod) {
    showModal('未保存的更改', '<p>当前文件有未保存的更改（航班或时间线），确定要返回关卡列表吗？</p>',
      `<button class="btn-cancel" id="modal-cancel">取消</button><button class="btn-confirm" id="modal-confirm">放弃更改</button>`);
    document.getElementById('modal-cancel').onclick = hideModal;
    document.getElementById('modal-confirm').onclick = () => {
      hideModal();
      appState.modified = false;
      appState.timelineModified = { weather: false, wind: false, runway: false };
      showBrowser();
    };
  } else {
    showBrowser();
  }
});

// ─── Keyboard Shortcuts ──────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (appState.screen !== 'editor') return;
  if (appState.editingWidget) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.key === 'N') { e.preventDefault(); addDepartureFlight(); }
  else if (mod && e.key === 's') { e.preventDefault(); handleSave(); }
  else if (mod && e.key === 'n') { e.preventDefault(); addArrivalFlight(); }
  else if (mod && e.key === 'b') { e.preventDefault(); showBrowser(); }
  else if (mod && e.key === 'd') { e.preventDefault(); copyHighlighted(); }
  else if (e.key === 'Delete') { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape') {
    appState.highlightedIdx = -1;
    appState.selectedIndices = new Set();
    renderAllSections();
  }
});

// ─── Root Path Persistence (via localStorage) ────────────

function getLastRootLocal() {
  try { return localStorage.getItem('ac27_lastRoot'); } catch (_) { return null; }
}

function saveLastRootLocal(rootPath) {
  try { localStorage.setItem('ac27_lastRoot', rootPath); } catch (_) {}
}

// ─── Init ────────────────────────────────────────────────

(async function init() {
  const lastRoot = getLastRootLocal();
  if (lastRoot) {
    const scan = await window.electronAPI.scanAcls(lastRoot);
    if (!scan.error && scan.totalFiles > 0) {
      appState.rootPath = lastRoot;
      appState.airports = scan.airports || [];
      // Phase 0: Initialize airport cache (scan all CSV + audio per airport)
      await window.electronAPI.initAirportCache(lastRoot).catch(err => {
        console.error('Airport cache init error:', err);
      });
      showBrowser();
      return;
    }
  }
  showScreen('setup');
})();
