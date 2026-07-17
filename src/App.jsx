import React, { useEffect, useState } from 'react';
import { I18nProvider } from './hooks/useTranslation';
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

  // Listen for update-check-result pushed from main process on startup
  useEffect(() => {
    const api = window.electronAPI;
    if (!api || !api.onUpdateCheckResult) return;

    const handler = (result) => {
      if (result.hasUpdate) {
        setUpdateInfo(result);
        setUpdateState('prompt');
      }
      // Network errors or no-update: stay idle, never block the user
    };

    api.onUpdateCheckResult(handler);
    return () => {
      if (api.offUpdateCheckResult) api.offUpdateCheckResult(handler);
    };
  }, []);

  // Show update prompt modal
  useEffect(() => {
    if (updateState !== 'prompt' || !updateInfo) return;

    useAppStore.getState().showModal(
      'Update Available',
      (t) => (
        <div>
          <p>A new version of AC27 Editor is available.</p>
          <p><strong>Current:</strong> {updateInfo.currentVersion} &rarr; <strong>New:</strong> {updateInfo.remoteDate || 'latest'}</p>
          {updateInfo.contentLength > 0 && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
              Download size: {Math.round(updateInfo.contentLength / (1024 * 1024))} MB
            </p>
          )}
        </div>
      ),
      (t) => (
        <div className="modal-actions-row">
          <button className="btn-cancel" onClick={() => {
            useAppStore.getState().hideModal();
            window.electronAPI.skipUpdate(updateInfo.remoteMd5);
            setUpdateState('idle');
          }}>Skip This Version</button>
          <button className="btn-confirm" onClick={() => {
            useAppStore.getState().hideModal();
            setUpdateState('downloading');
          }}>Download &amp; Install</button>
        </div>
      ),
      false, // not closeable — user must choose
    );
  }, [updateState, updateInfo]);

  // Trigger install when download completes
  useEffect(() => {
    if (updateState !== 'installing' || !downloadResult) return;
    window.electronAPI.installUpdate({
      updateDir: downloadResult.updateDir,
      currentExePath: downloadResult.currentExePath,
      newExePath: downloadResult.newExePath,
    });
  }, [updateState, downloadResult]);

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
