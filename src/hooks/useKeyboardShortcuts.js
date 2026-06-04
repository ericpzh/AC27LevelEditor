import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';

export function useKeyboardShortcuts({ onSave, onSearchToggle }) {
  useEffect(() => {
    const handler = (e) => {
      const screen = useAppStore.getState().screen;
      if (screen !== 'editor') return;
      if (useAppStore.getState().editingWidget) return;

      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key === 's') { e.preventDefault(); if (onSave) onSave(); }
      else if (mod && e.key === 'f') { e.preventDefault(); if (onSearchToggle) onSearchToggle(); }
      else if (mod && e.key === 'n' && !e.shiftKey) { e.preventDefault(); useAppStore.getState().addArrivalFlight(); }
      else if (mod && e.key === 'N') { e.preventDefault(); useAppStore.getState().addDepartureFlight(); }
      else if (mod && e.key === 'd') { e.preventDefault(); useAppStore.getState().copySelected(); }
      else if (e.key === 'Delete') {
        const st = useAppStore.getState();
        if (st.selectedIndices.size > 0) st.deleteSelected();
      }
      else if (e.key === 'Escape') { /* handled by components */ }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onSave, onSearchToggle]);
}
