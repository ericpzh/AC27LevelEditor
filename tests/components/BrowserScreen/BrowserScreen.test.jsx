import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BrowserScreen from '../../../src/components/BrowserScreen/BrowserScreen';
import Modal from '../../../src/components/common/Modal';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderBrowser() {
  return render(
    <I18nProvider>
      <BrowserScreen />
      <Modal />
    </I18nProvider>
  );
}

// Default mocks: version match, empty file list
function setupDefaultMocks(overrides = {}) {
  mockIpcInvoke.mockImplementation((channel, ...args) => {
    if (overrides[channel] !== undefined) return overrides[channel];
    switch (channel) {
      case 'get-app-version':
        return Promise.resolve('1.0.10');
      case 'check-version-mismatch':
        return Promise.resolve({ mismatch: false, currentVersion: '1.0.10' });
      case 'get-airport-files-info':
        return Promise.resolve([]);
      default:
        return Promise.resolve({});
    }
  });
}

beforeEach(() => {
  // Set language to English for predictable text matchers
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState({
    rootPath: 'D:\\Games\\Airport Control 27',
    airports: [{ icao: 'ZSJN', name: 'Jinan' }],
  });
});

describe('Version Mismatch Detection', () => {
  it('does NOT show version mismatch modal when versions match', async () => {
    setupDefaultMocks();

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('Levels')).toBeInTheDocument();
    });

    // The mismatch modal title should NOT be present
    expect(screen.queryByText('App Updated')).toBeNull();
  });

  it('shows version mismatch modal when version differs', async () => {
    setupDefaultMocks({
      'get-app-version': Promise.resolve('1.1.0'),
      'check-version-mismatch': Promise.resolve({ mismatch: true, currentVersion: '1.1.0', cachedVersion: '1.0.10' }),
    });

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('App Updated')).toBeInTheDocument();
    });

    // The modal Re-Scan button must be present (use class selector to distinguish from toolbar button)
    const modalRescanBtn = document.querySelector('#modal-actions .btn-confirm');
    expect(modalRescanBtn).toBeInTheDocument();
    expect(modalRescanBtn.textContent).toBe('Re-Scan');
  });

  it('re-scan button triggers refresh and updates cached version', async () => {
    const user = userEvent.setup();

    setupDefaultMocks({
      'get-app-version': Promise.resolve('1.1.0'),
      'check-version-mismatch': Promise.resolve({ mismatch: true, currentVersion: '1.1.0', cachedVersion: '1.0.10' }),
      'refresh-root-scan': Promise.resolve({ success: true, airports: [{ icao: 'ZSJN', name: 'Jinan' }], totalFiles: 1 }),
      'update-cached-version': Promise.resolve({ success: true }),
    });
    mockIpcInvoke.mockClear();

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('App Updated')).toBeInTheDocument();
    });

    await user.click(document.querySelector('#modal-actions .btn-confirm'));

    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('refresh-root-scan', expect.any(String));
      expect(mockIpcInvoke).toHaveBeenCalledWith('update-cached-version');
    });

    // Modal should be dismissed after click
    await waitFor(() => {
      expect(screen.queryByText('App Updated')).toBeNull();
    });
  });

  it('does NOT update cached version when re-scan fails', async () => {
    const user = userEvent.setup();

    setupDefaultMocks({
      'get-app-version': Promise.resolve('1.1.0'),
      'check-version-mismatch': Promise.resolve({ mismatch: true, currentVersion: '1.1.0', cachedVersion: '1.0.10' }),
      'refresh-root-scan': Promise.resolve({ success: false, error: 'Disk full' }),
      'update-cached-version': Promise.resolve({ success: true }),
    });
    mockIpcInvoke.mockClear();

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('App Updated')).toBeInTheDocument();
    });

    await user.click(document.querySelector('#modal-actions .btn-confirm'));

    // Wait for scan to complete, then verify updateCachedVersion was NOT called
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('refresh-root-scan', expect.any(String));
    });
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('update-cached-version');
  });
});
