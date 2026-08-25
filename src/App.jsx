import React, { useEffect, useState, useRef } from 'react';
import { I18nProvider, useTranslation } from './hooks/useTranslation';
import { useAppStore } from './store/appStore';
import { useElectronAPI } from './hooks/useElectronAPI';
import SetupScreen from './components/SetupScreen/SetupScreen';
import BrowserScreen from './components/BrowserScreen/BrowserScreen';
import EditorScreen from './components/EditorScreen/EditorScreen';
import GroundMapWindow from './components/MapWindows/GroundMapWindow';
import AirMapWindow from './components/MapWindows/AirMapWindow';
import FlightStripsWindow from './components/MapWindows/FlightStripsWindow';
import UpdateOverlay from './components/UpdateOverlay';
import Modal from './components/common/Modal';
import Toast from './components/common/Toast';

// Expose store to window for E2E tests (allows config-time fix before save)
if (typeof window !== 'undefined') window.__AC27_STORE = useAppStore;

let didInit = false; // Survives Strict Mode double-mount (AGENTS rule 8.2)

function ScreenRouter() {
  const screen = useAppStore(s => s.screen);
  const electronAPI = useElectronAPI();
  const { t } = useTranslation();
  const [booting, setBooting] = useState(true);

  // Detect map window query params (separate Electron BrowserWindow instances)
  const sp = new URLSearchParams(window.location.search);
  const mapWin = sp.get('window');
  const mapAp = sp.get('airport');
  if (mapWin === 'groundMap' && mapAp) return <I18nProvider><GroundMapWindow airportIcao={mapAp} /></I18nProvider>;
  if (mapWin === 'airMap' && mapAp)   return <I18nProvider><AirMapWindow airportIcao={mapAp} /></I18nProvider>;
  if (mapWin === 'flightStrips' && mapAp) return <I18nProvider><FlightStripsWindow airportIcao={mapAp} /></I18nProvider>;

  // Listen for store updates pushed from main process (MCP / API server)
  useEffect(() => {
    const api = window.electronAPI;
    if (!api || !api.onStoreApiUpdate) return;

    const handler = (updates) => {
      const st = useAppStore.getState();
      // Convert array fields back to Sets as needed
      if (updates.selectedIndices && Array.isArray(updates.selectedIndices)) {
        updates.selectedIndices = new Set(updates.selectedIndices);
      }
      if (updates.searchMatches && Array.isArray(updates.searchMatches)) {
        updates.searchMatches = new Set(updates.searchMatches);
      }
      if (updates.highlightedCells && Array.isArray(updates.highlightedCells)) {
        updates.highlightedCells = new Set(updates.highlightedCells);
      }
      st.setLegacyState(updates);
    };
    api.onStoreApiUpdate(handler);
    return () => {
      if (api.offStoreApiUpdate) api.offStoreApiUpdate(handler);
    };
  }, []);

  // Restore last root on startup — runs once per app load
  useEffect(() => {
    if (didInit) return;
    didInit = true;
    (async () => {
      try {
        // Check system RAM for LLM support (runs once)
        const sysInfo = await electronAPI.getSystemInfo();
        if (sysInfo && sysInfo.success) {
          useAppStore.setState({ chatTotalRamGB: sysInfo.totalRamGB });
        }
      } catch (_) {}
      try {
        const cacheState = await electronAPI.getCacheState();
        if (cacheState.state === 'no-cache') { setBooting(false); return; }

        // 'ready' or 'mismatch' — both have gameRoot
        const scan = await electronAPI.scanAcls(cacheState.gameRoot);
        if (scan.errorCode || !scan.totalFiles) { setBooting(false); return; }
        const st = useAppStore.getState();
        st.setRootPath(cacheState.gameRoot, scan.airports || []);
        await electronAPI.initAirportCache(cacheState.gameRoot).catch(() => {});
        st.setScreen('browser');
      } catch (err) {
        console.error('[App] Boot failed:', err);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // ── Auto-update state machine ──────────────────────────
  // 'idle' | 'prompt' | 'downloading' | 'installing' | 'error'
  const [updateState, setUpdateState] = useState('idle');
  const [updateInfo, setUpdateInfo] = useState(null);
  const [downloadResult, setDownloadResult] = useState(null);
  const updateCheckedRef = useRef(false);

  // Check for updates on startup.
  // Two paths: (1) main process pushes result via 'update-check-result' event,
  // (2) renderer actively calls checkForUpdate() as fallback in case the push
  // was sent before the renderer was ready (race condition). The ref prevents
  // double-processing.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const handleResult = (result, source) => {
      if (updateCheckedRef.current) {
        console.log('[App] update result via', source, 'DROPPED (already processed):', JSON.stringify(result));
        return;
      }
      updateCheckedRef.current = true;
      console.log('[App] update result via', source, 'ACCEPTED:', JSON.stringify(result));
      if (result.hasUpdate) {
        setUpdateInfo(result);
        setUpdateState('prompt');
      }
    };
    const handlePush = (result) => handleResult(result, 'push');

    // Path 1: listen for push from main process
    if (api.onUpdateCheckResult) {
      console.log('[App] registering update-check-result listener');
      api.onUpdateCheckResult(handlePush);
    }

    // Path 2: actively call (handles race condition where push was already sent)
    if (api.checkForUpdate) {
      console.log('[App] invoking checkForUpdate() fallback');
      api.checkForUpdate().then((result) => handleResult(result, 'invoke'));
    }

    return () => {
      if (api.offUpdateCheckResult) api.offUpdateCheckResult(handlePush);
    };
  }, []);

  // Show update prompt modal. The modal is a singleton — if another modal is
  // open, defer: the effect re-runs when modal.open/title change and shows the
  // prompt once the other modal closes (or if something overwrote ours).
  const modalOpen = useAppStore(s => s.modal.open);
  const modalTitle = useAppStore(s => s.modal.title);
  useEffect(() => {
    if (updateState !== 'prompt' || !updateInfo) return;
    if (modalOpen) {
      if (modalTitle === 'Update Available') return; // already showing
      console.log('[App] deferring update prompt — modal already open:', String(modalTitle));
      return;
    }

    console.log('[App] showing update prompt modal');
    useAppStore.getState().showModal(
      (t) => t('update_modal_title'),
      (t) => (
        <div>
          {updateInfo.contentLength > 0 && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
              {t('update_modal_size')}{Math.round(updateInfo.contentLength / (1024 * 1024))} {t('update_modal_mb')}
            </p>
          )}
        </div>
      ),
      (t) => (
        <div className="modal-actions-row">
          <button className="btn-cancel" onClick={() => {
            useAppStore.getState().hideModal();
setUpdateState('idle');
          }}>{t('update_modal_skip')}</button>
          <button className="btn-confirm" onClick={() => {
            useAppStore.getState().hideModal();
            setUpdateState('downloading');
          }}>{t('update_modal_download')}</button>
        </div>
      ),
      false, // not closeable — user must choose
    );
  }, [updateState, updateInfo, modalOpen, modalTitle]);

  // Trigger install when download completes
  useEffect(() => {
    if (updateState !== 'installing' || !downloadResult) return;
    console.log('[App] installing update:', JSON.stringify(downloadResult));
    window.electronAPI.installUpdate({
      updateDir: downloadResult.updateDir,
      currentExePath: downloadResult.currentExePath,
      newExePath: downloadResult.newExePath,
    });
  }, [updateState, downloadResult]);

  // ── Post-update restore-all nudge ──────────────────────
  // After the updater script relaunches the new exe, the pending flag written by
  // updater.markPostUpdatePending() is detected here and a one-time modal is shown:
  // "AC27Editor已更新，若任意存档曾经被修改，请还原所有关卡文件。"  Cancel | Continue
  // Continue opens the same restore-all warning modal used by BrowserScreen's button.
  const postUpdateCheckedRef = useRef(false);
  const triggerRestoreAll = () => {
    const { showModal, hideModal, setBrowserCache, showToast } = useAppStore.getState();
    const api = window.electronAPI;
    showModal(
      (tt) => tt('restore_all_title'),
      (tt) => (
        <>
          <p style={{ color: 'var(--red)', fontWeight: 600 }}>{tt('restore_all_warning')}</p>
          <p style={{ marginTop: 8 }}>{tt('restore_all_warning_detail')}</p>
        </>
      ),
      (tt) => (
        <>
          <button className="btn-cancel" onClick={hideModal}>{tt('modal_btn_cancel')}</button>
          <button className="btn-danger" onClick={async () => {
            hideModal();
            try {
              const result = await api.resetAllLevels();
              if (result.success) {
                setBrowserCache({}, {});
                showModal(
                  (t2) => t2('restore_all_success_title'),
                  (t2) => <p>{t2('restore_all_success_detail', { count: result.deletedCount, airports: result.airports })}</p>,
                  (t2) => <button className="btn-confirm" onClick={() => { hideModal(); api.quitApp(); }}>{t2('modal_btn_ok')}</button>
                );
              } else {
                const msg = result.error === 'NO_GAME_ROOT' ? tt('restore_all_no_game_root') : (result.error || tt('restore_all_failed'));
                showToast(msg, 'error');
              }
            } catch (err) {
              showToast(err.message, 'error');
            }
          }}>{tt('restore_all_confirm')}</button>
        </>
      )
    );
  };

  useEffect(() => {
    if (booting) return;
    if (postUpdateCheckedRef.current) return;
    if (updateState === 'prompt' || updateState === 'downloading' || updateState === 'installing') return;
    if (modalOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const api = window.electronAPI;
        if (!api?.checkPostUpdatePending) return;
        const res = await api.checkPostUpdatePending();
        if (cancelled) return;
        if (!res?.pending) {
          postUpdateCheckedRef.current = true;
          return;
        }
        postUpdateCheckedRef.current = true;
        console.log('[App] post-update pending detected:', res);
        const { showModal, hideModal } = useAppStore.getState();
        const clear = () => { if (api.clearPostUpdatePending) api.clearPostUpdatePending().catch(() => {}); };
        showModal(
          (tt) => tt('update_post_title'),
          (tt) => <p>{tt('update_post_body')}</p>,
          (tt) => (
            <div className="modal-actions-row">
              <button className="btn-cancel" onClick={() => { hideModal(); clear(); }}>{tt('modal_btn_cancel')}</button>
              <button className="btn-confirm" onClick={() => { hideModal(); clear(); triggerRestoreAll(); }}>{tt('update_post_continue')}</button>
            </div>
          ),
          false
        );
      } catch (e) {
        console.log('[App] post-update check failed:', e.message);
        postUpdateCheckedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [booting, modalOpen, modalTitle, updateState]);

  // ── End auto-update state machine ──────────────────────

  if (booting) return <div className="screen"><div className="loading-state"><div className="spinner" /></div></div>;

  switch (screen) {
    case 'setup':   return <><SetupScreen />{updateState === 'downloading' && <UpdateOverlay onComplete={(result) => { setDownloadResult(result); setUpdateState('installing'); }} onError={(errorMsg) => { setUpdateState('error'); useAppStore.getState().showToast(errorMsg, 'error'); }} />}</>;
    case 'browser': return <><BrowserScreen />{updateState === 'downloading' && <UpdateOverlay onComplete={(result) => { setDownloadResult(result); setUpdateState('installing'); }} onError={(errorMsg) => { setUpdateState('error'); useAppStore.getState().showToast(errorMsg, 'error'); }} />}</>;
    case 'editor':  return <><EditorScreen />{updateState === 'downloading' && <UpdateOverlay onComplete={(result) => { setDownloadResult(result); setUpdateState('installing'); }} onError={(errorMsg) => { setUpdateState('error'); useAppStore.getState().showToast(errorMsg, 'error'); }} />}</>;
    default:        return null;
  }
}

export default function App() {
  const theme = useAppStore(s => s.theme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <I18nProvider>
      <ScreenRouter />
      <Modal />
      <Toast />
    </I18nProvider>
  );
}
