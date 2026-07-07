import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import BrowserScreen from '../../../src/components/BrowserScreen/BrowserScreen';
import { BUTTONS } from '../../../src/components/BrowserScreen/BrowserHelpOverlay';
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
      case 'check-bepinex':
        return Promise.resolve({ installed: false });
      case 'get-cache-state':
        return Promise.resolve({ state: 'ready', gameRoot: 'D:\\Games\\Airport Control 27', lang: null, airports: ['ZSJN'] });
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
  it('does NOT show version mismatch modal when cache version matches', async () => {
    setupDefaultMocks();

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('Levels')).toBeInTheDocument();
    });

    // The mismatch modal title should NOT be present
    expect(screen.queryByText('App Updated')).toBeNull();
  });

  it('shows version mismatch modal when cache version differs', async () => {
    setupDefaultMocks({
      'get-cache-state': Promise.resolve({ state: 'mismatch', gameRoot: 'D:\\Games\\Airport Control 27', lang: null, airports: ['ZSJN'], cachedVersion: 0, expectedVersion: 1 }),
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

  it('re-scan button triggers refresh and dismisses modal', async () => {
    const user = userEvent.setup();

    setupDefaultMocks({
      'get-cache-state': Promise.resolve({ state: 'mismatch', gameRoot: 'D:\\Games\\Airport Control 27', lang: null, airports: ['ZSJN'], cachedVersion: 0, expectedVersion: 1 }),
      'refresh-root-scan': Promise.resolve({ success: true, airports: [{ icao: 'ZSJN', name: 'Jinan' }], totalFiles: 1 }),
    });
    mockIpcInvoke.mockClear();

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('App Updated')).toBeInTheDocument();
    });

    await user.click(document.querySelector('#modal-actions .btn-confirm'));

    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('refresh-root-scan', expect.any(String));
    });

    // Modal should be dismissed after click
    await waitFor(() => {
      expect(screen.queryByText('App Updated')).toBeNull();
    });
  });

  it('shows error toast when re-scan fails', async () => {
    const user = userEvent.setup();

    setupDefaultMocks({
      'get-cache-state': Promise.resolve({ state: 'mismatch', gameRoot: 'D:\\Games\\Airport Control 27', lang: null, airports: ['ZSJN'], cachedVersion: 0, expectedVersion: 1 }),
      'refresh-root-scan': Promise.resolve({ success: false, error: 'Disk full' }),
    });
    mockIpcInvoke.mockClear();

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText('App Updated')).toBeInTheDocument();
    });

    await user.click(document.querySelector('#modal-actions .btn-confirm'));

    // Wait for scan to complete
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('refresh-root-scan', expect.any(String));
    });
  });

  describe('Help Button', () => {
    it('renders help button in the header', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      // Help button is the last btn-icon-only button (after theme toggle)
      const iconOnlyButtons = document.querySelectorAll('.btn-icon-only');
      const helpBtn = iconOnlyButtons[iconOnlyButtons.length - 1];
      expect(helpBtn).toBeInTheDocument();
      expect(helpBtn.querySelector('svg')).toBeTruthy();
    });

    it('clicking help button opens the overlay', async () => {
      const user = userEvent.setup();
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      const iconOnlyButtons = document.querySelectorAll('.btn-icon-only');
      const helpBtn = iconOnlyButtons[iconOnlyButtons.length - 1];
      await user.click(helpBtn);

      await waitFor(() => {
        expect(screen.getByText('Header Buttons')).toBeInTheDocument();
      });
    });

    it('Escape closes the help overlay', async () => {
      const user = userEvent.setup();
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      // Open the overlay
      const iconOnlyButtons = document.querySelectorAll('.btn-icon-only');
      await user.click(iconOnlyButtons[iconOnlyButtons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText('Header Buttons')).toBeInTheDocument();
      });

      // Close via Escape
      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByText('Header Buttons')).toBeNull();
      });
    });

    it('backdrop click closes the help overlay', async () => {
      const user = userEvent.setup();
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      const iconOnlyButtons = document.querySelectorAll('.btn-icon-only');
      await user.click(iconOnlyButtons[iconOnlyButtons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText('Header Buttons')).toBeInTheDocument();
      });

      // Click the backdrop
      fireEvent.click(document.getElementById('browser-help-overlay'));

      await waitFor(() => {
        expect(screen.queryByText('Header Buttons')).toBeNull();
      });
    });

    it('close button in overlay header works', async () => {
      const user = userEvent.setup();
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      const iconOnlyButtons = document.querySelectorAll('.btn-icon-only');
      await user.click(iconOnlyButtons[iconOnlyButtons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText('Header Buttons')).toBeInTheDocument();
      });

      // Click the X close button in overlay header
      const closeBtn = document.querySelector('#browser-help-header button');
      fireEvent.click(closeBtn);

      await waitFor(() => {
        expect(screen.queryByText('Header Buttons')).toBeNull();
      });
    });
  });

  describe('Debug Mode Toggle', () => {
    it('renders debug mode toggle button in the header', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      expect(screen.getByText('Debug Mode')).toBeInTheDocument();
    });

    it('shows active state when BepInEx is installed', async () => {
      setupDefaultMocks({
        'check-bepinex': Promise.resolve({ installed: true }),
      });
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Debug Mode')).toBeInTheDocument();
      });

      const debugBtn = screen.getByText('Debug Mode').closest('button');
      expect(debugBtn.className).toContain('btn-debug-active');
    });

    it('has tooltip text on hover', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      const debugBtn = screen.getByText('Debug Mode').closest('button');
      fireEvent.mouseEnter(debugBtn);

      const tip = document.body.querySelector('.tooltip-popup');
      expect(tip).not.toBeNull();
      expect(tip.textContent).toContain('BepInEx');
    });

    it('is disabled while loading', async () => {
      setupDefaultMocks({
        'check-bepinex': Promise.resolve({ installed: true }),
        'uninstall-bepinex': new Promise(() => {}), // never resolves
      });
      const user = userEvent.setup();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Debug Mode')).toBeInTheDocument();
      });

      const debugBtn = screen.getByText('Debug Mode').closest('button');
      await user.click(debugBtn);

      // Button should now be disabled while uninstall is in progress
      await waitFor(() => {
        expect(debugBtn.disabled).toBe(true);
      });
    });
  });

  describe('Tooltips', () => {
    it('shows tooltip on Change Folder button hover', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('No level files found')).toBeInTheDocument();
      });

      // Hover the Change Folder button (first .btn-sm)
      const changeDirBtn = document.querySelector('.btn-sm');
      expect(changeDirBtn).toBeInTheDocument();
      fireEvent.mouseEnter(changeDirBtn);

      const tip = document.body.querySelector('.tooltip-popup');
      expect(tip).not.toBeNull();
      expect(tip.textContent).toBe('Change the game directory. Select a different installation path.');
    });

    it('hides tooltip on mouse leave', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('No level files found')).toBeInTheDocument();
      });

      const changeDirBtn = document.querySelector('.btn-sm');
      fireEvent.mouseEnter(changeDirBtn);
      expect(document.body.querySelector('.tooltip-popup')).not.toBeNull();

      fireEvent.mouseLeave(changeDirBtn);
      expect(document.body.querySelector('.tooltip-popup')).toBeNull();
    });

    it('shows tooltip on language toggle hover', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('No level files found')).toBeInTheDocument();
      });

      // Language toggle button (now icon-only, but still has btn-lang-toggle-top)
      const langBtn = document.querySelectorAll('.btn-lang-toggle-top')[1];
      expect(langBtn).toBeInTheDocument();
      fireEvent.mouseEnter(langBtn);

      const tip = document.body.querySelector('.tooltip-popup');
      expect(tip).not.toBeNull();
      expect(tip.textContent).toBe('Switch the UI language.');
    });

    it('help button shows its own tooltip', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('No level files found')).toBeInTheDocument();
      });

      // The help button is the last .btn-icon-only button
      const iconOnlyButtons = document.querySelectorAll('.btn-icon-only');
      const helpBtn = iconOnlyButtons[iconOnlyButtons.length - 1];
      fireEvent.mouseEnter(helpBtn);

      const tip = document.body.querySelector('.tooltip-popup');
      expect(tip).not.toBeNull();
      expect(tip.textContent).toBe('View help and shortcuts.');
    });

    it('changing hover between buttons updates tooltip text', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('No level files found')).toBeInTheDocument();
      });

      const headerButtons = document.querySelectorAll('.browser-actions button');
      expect(headerButtons.length).toBeGreaterThan(2);

      // Hover first button
      fireEvent.mouseEnter(headerButtons[0]);
      const text1 = document.body.querySelector('.tooltip-popup').textContent;
      fireEvent.mouseLeave(headerButtons[0]);

      // Hover second button
      fireEvent.mouseEnter(headerButtons[1]);
      const text2 = document.body.querySelector('.tooltip-popup').textContent;

      // Each button should have different tooltip text
      expect(text1).not.toBe(text2);
    });
  });

});
