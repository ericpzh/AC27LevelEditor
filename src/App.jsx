import React, { useEffect, useState } from 'react';
import { I18nProvider } from './hooks/useTranslation';
import { useAppStore } from './store/appStore';
import { useElectronAPI } from './hooks/useElectronAPI';
import SetupScreen from './components/SetupScreen/SetupScreen';
import BrowserScreen from './components/BrowserScreen/BrowserScreen';
import EditorScreen from './components/EditorScreen/EditorScreen';
import Modal from './components/common/Modal';
import Toast from './components/common/Toast';

function ScreenRouter() {
  const screen = useAppStore(s => s.screen);
  const electronAPI = useElectronAPI();
  const [booting, setBooting] = useState(true);

  // Restore last root on startup
  useEffect(() => {
    (async () => {
      try {
        const lastRoot = await electronAPI.getLastRoot();
        if (!lastRoot) return;
        const scan = await electronAPI.scanAcls(lastRoot);
        if (scan.error || !scan.totalFiles) return;
        const st = useAppStore.getState();
        st.setRootPath(lastRoot, scan.airports || []);
        await electronAPI.initAirportCache(lastRoot).catch(() => {});
        await electronAPI.captureDynamicsTemplates(lastRoot).catch(() => {});
        st.setScreen('browser');
      } catch (_) {} finally { setBooting(false); }
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
  return (
    <I18nProvider>
      <ScreenRouter />
      <Modal />
      <Toast />
    </I18nProvider>
  );
}
