// ═══════════ SCREEN 0: SETUP ═══════════════════════════

document.getElementById('btn-select-root').addEventListener('click', async () => {
  const result = await window.electronAPI.selectGameRoot();
  if (result.canceled) return;

  if (result.error) {
    document.getElementById('setup-error').textContent = result.error;
    document.getElementById('setup-error').classList.remove('hidden');
    return;
  }

  document.getElementById('setup-error').classList.add('hidden');
  appState.rootPath = result.rootPath;
  appState.airports = result.airports || [];
  saveLastRootLocal(result.rootPath);

  // Phase 0: Initialize airport cache (scan all CSV + audio per airport)
  await window.electronAPI.initAirportCache(result.rootPath).catch(err => {
    console.error('Airport cache init error:', err);
  });

  showBrowser();
});
