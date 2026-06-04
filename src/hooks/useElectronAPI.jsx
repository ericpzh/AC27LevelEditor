import { createContext, useContext } from 'react';

const ElectronAPIContext = createContext(window.electronAPI);

export function ElectronAPIProvider({ children }) {
  return (
    <ElectronAPIContext.Provider value={window.electronAPI}>
      {children}
    </ElectronAPIContext.Provider>
  );
}

export function useElectronAPI() {
  return useContext(ElectronAPIContext);
}
