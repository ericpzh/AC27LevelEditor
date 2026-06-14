import React, { useEffect, useState } from 'react';
import { I18nProvider } from './hooks/useTranslation';
import { useAppStore } from './store/appStore';
import { useElectronAPI } from './hooks/useElectronAPI';
import SetupScreen from './components/SetupScreen/SetupScreen';
import BrowserScreen from './components/BrowserScreen/BrowserScreen';
import EditorScreen from './components/EditorScreen/EditorScreen';
import GroundMapWindow from './components/MapWindows/GroundMapWindow';
import AirMapWindow from './components/MapWindows/AirMapWindow';
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

  // Restore last root on startup — runs once per app load
  useEffect(() => {
    if (didInit) return;
    didInit = true;
    (async () => {
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

  if (booting) return <div className="screen"><div className="loading-state"><div className="spinner" /></div></div>;

  switch (screen) {
    case 'setup':   return <SetupScreen />;
    case 'browser': return <BrowserScreen />;
    case 'editor':  return <EditorScreen />;
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
