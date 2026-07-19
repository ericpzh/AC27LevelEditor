import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Must run before any module that uses window.electronAPI ──
vi.hoisted(() => {
  let onProgressCb = null;

  Object.defineProperty(window, 'electronAPI', {
    value: {
      installBepInEx: vi.fn(() => Promise.resolve({ success: true, version: '6.0.0-test' })),
      onBepInExInstallProgress: vi.fn((cb) => { onProgressCb = cb; }),
      offBepInExInstallProgress: vi.fn(() => { onProgressCb = null; }),
    },
    writable: true,
    configurable: true,
  });

  // Expose helpers for tests
  window.__bepTest = {
    setInstallResult: (result) => {
      window.electronAPI.installBepInEx = vi.fn(() => Promise.resolve(result));
    },
    emitProgress: (data) => {
      if (onProgressCb) onProgressCb(data);
    },
  };
});

import BepInExInstallOverlay from '../../../src/components/BrowserScreen/BepInExInstallOverlay';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { ElectronAPIProvider } from '../../../src/hooks/useElectronAPI';
import { setLang } from '../../../src/utils/i18n';

function renderOverlay(props = {}) {
  return render(
    <ElectronAPIProvider>
      <I18nProvider>
        <BepInExInstallOverlay onClose={vi.fn()} {...props} />
      </I18nProvider>
    </ElectronAPIProvider>
  );
}

beforeEach(() => {
  setLang('en');
  vi.clearAllMocks();
  // Reset to default success
  window.electronAPI.installBepInEx = vi.fn(() => Promise.resolve({ success: true, version: '6.0.0-test' }));
});

describe('BepInExInstallOverlay', () => {
  it('renders progress bar and percentage', () => {
    renderOverlay();
    expect(document.querySelector('.bepinex-progress-bar')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('closes with success on successful install', async () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledWith(true);
    }, { timeout: 3000 });
  });

  it('shows error when install fails', async () => {
    window.electronAPI.installBepInEx = vi.fn(() => Promise.resolve({ success: false, error: 'Download failed' }));
    renderOverlay();
    await waitFor(() => {
      expect(screen.getByText('Download failed')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('escape key closes error overlay', async () => {
    const onClose = vi.fn();
    window.electronAPI.installBepInEx = vi.fn(() => Promise.resolve({ success: false, error: 'fail' }));
    renderOverlay({ onClose });
    await waitFor(() => {
      expect(screen.getByText('fail')).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('close button in error state works', async () => {
    const onClose = vi.fn();
    window.electronAPI.installBepInEx = vi.fn(() => Promise.resolve({ success: false, error: 'fail' }));
    renderOverlay({ onClose });
    await waitFor(() => {
      expect(screen.getByText('fail')).toBeInTheDocument();
    }, { timeout: 3000 });
    // Find the Close button (btn-sm) in the error body and click it
    const closeBtn = document.querySelector('#bepinex-body .btn-sm');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('shows localized error for NO_GAME_ROOT', async () => {
    setLang('en');
    window.electronAPI.installBepInEx = vi.fn(() => Promise.resolve({ success: false, error: 'NO_GAME_ROOT' }));
    renderOverlay();
    await waitFor(() => {
      const body = document.getElementById('bepinex-body');
      expect(body.textContent).toContain('game directory');
    }, { timeout: 3000 });
  });

  it('updates progress bar on progress events', async () => {
    renderOverlay();
    // Emit progress before the install resolves
    window.__bepTest.emitProgress({ percent: 42 });
    await waitFor(() => {
      expect(screen.getByText('42%')).toBeInTheDocument();
    });
  });
});
