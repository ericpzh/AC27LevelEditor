import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import BrowserScreen from '../../../src/components/BrowserScreen/BrowserScreen';
import { BUTTONS } from '../../../src/components/BrowserScreen/BrowserHelpOverlay';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderBrowser() {
  return render(
    <I18nProvider>
      <BrowserScreen />
      <Modal />
      <Toast />
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
      case 'get-system-info':
        return Promise.resolve({ success: true, platform: 'win32', isPackaged: false });
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
    // Debug Mode now lives inside the Settings (gear) dropdown menu.
    async function openSettingsMenu() {
      fireEvent.click(screen.getByText('Setting'));
      await waitFor(() => {
        expect(screen.getByText('Debug Mode')).toBeInTheDocument();
      });
    }

    it('renders debug mode toggle button in the settings menu', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      await openSettingsMenu();
      expect(screen.getByText('Debug Mode')).toBeInTheDocument();
    });

    it('shows active state when BepInEx is installed', async () => {
      setupDefaultMocks({
        'check-bepinex': Promise.resolve({ installed: true }),
      });
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      await openSettingsMenu();
      const debugBtn = screen.getByText('Debug Mode').closest('button');
      expect(debugBtn.className).toContain('active');
    });

    it('has tooltip text on hover', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      await openSettingsMenu();
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
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Setting'));
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

  describe('Livery Button', () => {
    it('renders livery button in the header', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      expect(screen.getByText('Livery')).toBeInTheDocument();
    });

    it('has tooltip text on hover', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      const liveryBtn = screen.getByText('Livery').closest('button');
      fireEvent.mouseEnter(liveryBtn);

      const tip = document.body.querySelector('.tooltip-popup');
      expect(tip).not.toBeNull();
      expect(tip.textContent).toContain('Aircraft Livery');
    });

    it('navigates to livery screen on click and shows no overlay', async () => {
      setupDefaultMocks();
      const user = userEvent.setup();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      const liveryBtn = screen.getByText('Livery').closest('button');
      await user.click(liveryBtn);

      expect(useAppStore.getState().screen).toBe('livery');
      expect(document.getElementById('livery-overlay')).toBeNull();
    });
  });

  describe('Tooltips', () => {
    it('shows current directory instantly on the Change Folder menu item hover', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('No level files found')).toBeInTheDocument();
      });

      // The full path is no longer displayed outright in the header …
      expect(document.querySelector('.browser-root-path')).toBeNull();

      // … it shows instantly on hover, fed by the cached store value.
      fireEvent.click(screen.getByText('Setting'));
      const changeDirBtn = await screen.findByText('Change Folder');
      fireEvent.mouseEnter(changeDirBtn.closest('button'));

      const tip = document.body.querySelector('.tooltip-popup');
      expect(tip).not.toBeNull();
      expect(tip.textContent).toBe('Change Folder, current directory: D:\\Games\\Airport Control 27');
    });

    it('hides tooltip on mouse leave', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('No level files found')).toBeInTheDocument();
      });

      const liveryBtn = screen.getByText('Livery').closest('button');
      fireEvent.mouseEnter(liveryBtn);
      expect(document.body.querySelector('.tooltip-popup')).not.toBeNull();

      fireEvent.mouseLeave(liveryBtn);
      expect(document.body.querySelector('.tooltip-popup')).toBeNull();
    });

    it('shows tooltip on language menu item hover', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('No level files found')).toBeInTheDocument();
      });

      // Language toggle now lives inside the Settings menu; in en mode
      // the item is labeled with the other language's name.
      fireEvent.click(screen.getByText('Setting'));
      const langItem = await screen.findByText('中文');
      fireEvent.mouseEnter(langItem.closest('button'));

      const tip = document.body.querySelector('.tooltip-popup');
      expect(tip).not.toBeNull();
      expect(tip.textContent).toBe("Switch the UI language (the button shows the other language's name).");
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

  describe('Settings Menu', () => {
    it('shows only Livery, Restore All, Setting and help in the header', async () => {
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      expect(screen.getByText('Livery')).toBeInTheDocument();
      expect(screen.getByText('Restore All')).toBeInTheDocument();
      expect(screen.getByText('Setting')).toBeInTheDocument();
      // Collapsed items stay hidden until the menu opens
      expect(screen.queryByText('Change Folder')).toBeNull();
      expect(screen.queryByText('Background Video')).toBeNull();
      expect(screen.queryByText('Debug Mode')).toBeNull();
    });

    it('opens a floating menu with named items', async () => {
      const user = userEvent.setup();
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Setting'));

      expect(document.querySelector('.browser-settings-menu')).toBeInTheDocument();
      expect(screen.getByText('Change Folder')).toBeInTheDocument();
      expect(screen.getByText('Background Video')).toBeInTheDocument();
      expect(screen.getByText('Debug Mode')).toBeInTheDocument();
      expect(screen.getByText('Report Bug')).toBeInTheDocument();
      // en mode → the language item offers 中文
      expect(screen.getByText('中文')).toBeInTheDocument();
    });

    it('labels the language item with the other language name', async () => {
      const user = userEvent.setup();
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      // en mode offers 中文; switching flips the label to English.
      await user.click(screen.getByText('Setting'));
      await user.click(await screen.findByText('中文'));

      await user.click(screen.getByText('设置'));
      expect(screen.getByText('English')).toBeInTheDocument();
    });

    it('closes the menu when clicking outside of it', async () => {
      const user = userEvent.setup();
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Setting'));
      await waitFor(() => {
        expect(screen.getByText('Change Folder')).toBeInTheDocument();
      });

      fireEvent.mouseDown(document.body);
      await waitFor(() => {
        expect(screen.queryByText('Change Folder')).toBeNull();
      });
    });

    it('closes the menu on Escape', async () => {
      const user = userEvent.setup();
      setupDefaultMocks();
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Levels')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Setting'));
      await waitFor(() => {
        expect(screen.getByText('Change Folder')).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByText('Change Folder')).toBeNull();
      });
    });
  });

  describe('Demo File Filtering', () => {
    const nonWhitelistedDemo = {
      filename: 'KJFK_20-22.demo.acl',
      path: 'D:\\Games\\Airport Control 27\\KJFK\\KJFK_20-22.demo.acl',
      isDemo: false,
      isEmer: false,
      startTime: '20:00',
      endTime: '22:00',
      arrivals: 8,
      departures: 2,
    };

    // In both PROD_VISIBLE_BASES and DEMO_VISIBLE_BASES.
    // isDemo: true mirrors _isDemoFile() in electron/main.js (the file is in
    // DEMO_VISIBLE_BASES, so it gets the demo-window flag) — but it must still
    // appear in the prod browser list.
    const prodFile = {
      filename: 'ZSJN_leisure_1.acl',
      path: 'D:\\Games\\Airport Control 27\\ZSJN\\ZSJN_leisure_1.acl',
      isDemo: true,
      isEmer: false,
      startTime: '06:00',
      endTime: '08:00',
      arrivals: 10,
      departures: 0,
    };

    const demoFile = {
      filename: 'ZSJN_peakdeparture.demo.acl',
      path: 'D:\\Games\\Airport Control 27\\ZSJN\\ZSJN_peakdeparture.demo.acl',
      isDemo: true,
      isEmer: false,
      startTime: '06:50',
      endTime: '07:20',
      arrivals: 5,
      departures: 0,
    };

    it('hides whitelisted .demo files in non-demo mode', async () => {
      setupDefaultMocks({
        'get-airport-files-info': Promise.resolve([prodFile, demoFile]),
      });
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Relax Time')).toBeInTheDocument();
      });
      expect(screen.queryByText('Peak Departure')).toBeNull();
    });

    it('hides non-whitelisted .demo files in non-demo mode', async () => {
      setupDefaultMocks({
        'get-airport-files-info': Promise.resolve([prodFile, nonWhitelistedDemo]),
      });
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Relax Time')).toBeInTheDocument();
      });
      expect(screen.queryByText('KJFK 20-22.demo')).toBeNull();
    });

    it('shows whitelisted .demo files in demo mode', async () => {
      useAppStore.setState({
        rootPath: 'D:\\Games\\Airport Control 27 Demo',
      });
      setupDefaultMocks({
        'get-airport-files-info': Promise.resolve([prodFile, demoFile]),
      });
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Peak Departure')).toBeInTheDocument();
      });
      // Regular .acl files in the demo whitelist are also visible
      expect(screen.getByText('Relax Time')).toBeInTheDocument();
    });

    it('sorts levels by whitelist order, not start time', async () => {
      // Given in reverse whitelist order with arbitrary start times — the
      // display order must follow PROD_VISIBLE_BASES, not time.
      const files = [
        { ...prodFile, filename: 'ZSJN_taixwayclosed.acl', path: 'D:\\Games\\Airport Control 27\\ZSJN\\ZSJN_taixwayclosed.acl', startTime: '06:00' },
        { ...prodFile, filename: 'ZSJN_peakdeparture.acl', path: 'D:\\Games\\Airport Control 27\\ZSJN\\ZSJN_peakdeparture.acl', startTime: '05:00' },
        { ...prodFile, filename: 'ZSJN_runwaychange.acl', path: 'D:\\Games\\Airport Control 27\\ZSJN\\ZSJN_runwaychange.acl', startTime: '10:00' },
        { ...prodFile, filename: 'ZSJN_leisure_2.acl', path: 'D:\\Games\\Airport Control 27\\ZSJN\\ZSJN_leisure_2.acl', startTime: '20:00' },
        prodFile,
      ];
      setupDefaultMocks({
        'get-airport-files-info': Promise.resolve(files),
      });
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Relax Time')).toBeInTheDocument();
      });
      const names = document.querySelectorAll('.level-tod');
      expect([...names].map(n => n.textContent)).toEqual([
        'Relax Time',      // ZSJN_leisure_1
        'Busy Time',       // ZSJN_leisure_2
        'Runway Change',   // ZSJN_runwaychange
        'Peak Departure',  // ZSJN_peakdeparture
        'Taxiway Closed',  // ZSJN_taixwayclosed
      ]);
      // Time range and small filename columns are still shown per row
      // (startTimes from the fixtures; endTime inherited from prodFile)
      const ranges = document.querySelectorAll('.level-timerange');
      expect([...ranges].map(n => n.textContent)).toEqual([
        '06:00-08:00', '20:00-08:00', '10:00-08:00', '05:00-08:00', '06:00-08:00',
      ]);
      const filenames = document.querySelectorAll('.level-name');
      expect([...filenames].map(n => n.textContent)).toEqual([
        'ZSJN leisure 1', 'ZSJN leisure 2', 'ZSJN runwaychange',
        'ZSJN peakdeparture', 'ZSJN taixwayclosed',
      ]);
    });
  });

  describe('Collapsible Airport Cards', () => {
    const zsjnFile = {
      filename: 'ZSJN_leisure_1.acl',
      path: 'D:\\Games\\Airport Control 27\\ZSJN\\ZSJN_leisure_1.acl',
      isDemo: false,
      isEmer: false,
      startTime: '06:00',
      endTime: '08:00',
      arrivals: 10,
      departures: 2,
    };

    // Installs fake layout metrics so the auto-collapse fit pass has real
    // geometry to work with (jsdom reports 0 for everything by default).
    // The returned setHeight() lets a test simulate a window resize.
    function mockCardGeometry(initialHeight) {
      const proto = window.HTMLElement.prototype;
      const saved = {};
      const state = { height: initialHeight };
      const install = (name, getter) => {
        saved[name] = Object.getOwnPropertyDescriptor(proto, name) || null;
        Object.defineProperty(proto, name, { configurable: true, get: getter });
      };
      install('clientHeight', function () {
        return this.classList && this.classList.contains('browser-content') ? state.height : 0;
      });
      install('offsetHeight', function () {
        if (!this.classList) return 0;
        if (this.classList.contains('airport-card-header')) return 48;
        if (this.classList.contains('airport-card')) {
          if (this.getAttribute('data-expanded') === 'false') return 50;
          return 50 + this.querySelectorAll('.level-row').length * 37;
        }
        return 0;
      });
      return {
        setHeight(h) { state.height = h; },
        restore() {
          for (const name of Object.keys(saved)) {
            if (saved[name]) Object.defineProperty(proto, name, saved[name]);
            else delete proto[name];
          }
        },
      };
    }

    // Four airports, five levels each — enough content to force auto-collapse.
    function setupFourAirports() {
      const icaos = ['ZSJN', 'KJFK', 'ZGSZ', 'KDCA'];
      const filesFor = (icao) => [
        `${icao}_leisure_1.acl`,
        `${icao}_leisure_2.acl`,
        `${icao}_runwaychange.acl`,
        `${icao}_peakdeparture.acl`,
        `${icao}_taixwayclosed.acl`,
      ].map(filename => ({ ...zsjnFile, filename, path: `D:\\Games\\Airport Control 27\\${icao}\\${filename}` }));

      useAppStore.setState({ airports: icaos.map(icao => ({ icao, name: icao })) });
      mockIpcInvoke.mockImplementation((channel, ...args) => {
        switch (channel) {
          case 'get-app-version': return Promise.resolve('1.0.10');
          case 'check-bepinex': return Promise.resolve({ installed: false });
          case 'get-airport-files-info': return Promise.resolve(filesFor(args[0]));
          default: return Promise.resolve({});
        }
      });
    }

    it('collapses an airport card when its header is clicked, and expands it again', async () => {
      const user = userEvent.setup();
      setupDefaultMocks({
        'get-airport-files-info': Promise.resolve([zsjnFile]),
      });
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Relax Time')).toBeInTheDocument();
      });

      const header = document.querySelector('.airport-card-header');
      expect(header.getAttribute('aria-expanded')).toBe('true');

      await user.click(header);
      expect(screen.queryByText('Relax Time')).toBeNull();
      expect(header.getAttribute('aria-expanded')).toBe('false');

      await user.click(header);
      expect(screen.getByText('Relax Time')).toBeInTheDocument();
      expect(header.getAttribute('aria-expanded')).toBe('true');
    });

    it('shows the radar/flight-strip toggle buttons', async () => {
      setupDefaultMocks({
        'get-airport-files-info': Promise.resolve([zsjnFile]),
      });
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Relax Time')).toBeInTheDocument();
      });

      expect(screen.getByText('Surface Radar')).toBeInTheDocument();
      expect(screen.getByText('Approach Radar')).toBeInTheDocument();
      expect(screen.getByText('Flight Strips')).toBeInTheDocument();
      expect(document.querySelector('.airport-card-actions button')).not.toBeNull();
    });

    // MD5 matches the release reference → open, never install.
    it('opens the radar without installing when the DLL MD5 matches the release', async () => {
      setupDefaultMocks({
        'check-bepinex': Promise.resolve({ installed: true }),
        'get-cache-flag': Promise.resolve({ success: true, value: true }),
        'get-system-info': Promise.resolve({ success: true, platform: 'win32', isPackaged: true }),
        'check-command-capability': Promise.resolve({ pluginInstalled: true, pluginUpToDate: true }),
        'get-airport-files-info': Promise.resolve([zsjnFile]),
      });
      renderBrowser();
      await waitFor(() => expect(screen.getByText('Relax Time')).toBeInTheDocument());
      mockIpcInvoke.mockClear();

      await userEvent.click(screen.getByText('Surface Radar'));

      await waitFor(() => expect(mockIpcInvoke.mock.calls.map(c => c[0])).toContain('open-ground-map'));
      const channels = mockIpcInvoke.mock.calls.map(c => c[0]);
      expect(channels).not.toContain('download-approach-dll');
      expect(channels).not.toContain('install-approach-dll');
    });

    // Packaged build + MD5 mismatch → update from the release reference
    // (bundled Workshop DLL on Steam, R2 object on a normal build).
    it('installs when the packaged DLL MD5 is out of date', async () => {
      setupDefaultMocks({
        'check-bepinex': Promise.resolve({ installed: true }),
        'get-cache-flag': Promise.resolve({ success: true, value: true }),
        'get-system-info': Promise.resolve({ success: true, platform: 'win32', isPackaged: true }),
        'check-command-capability': Promise.resolve({ pluginInstalled: true, pluginUpToDate: false }),
        'download-approach-dll': Promise.resolve({ success: true, filePath: 'C:/tmp/AC27Approach.dll' }),
        'install-approach-dll': Promise.resolve({ success: true }),
        'get-airport-files-info': Promise.resolve([zsjnFile]),
      });
      renderBrowser();
      await waitFor(() => expect(screen.getByText('Relax Time')).toBeInTheDocument());
      mockIpcInvoke.mockClear();

      await userEvent.click(screen.getByText('Surface Radar'));

      await waitFor(() => expect(mockIpcInvoke.mock.calls.map(c => c[0])).toContain('download-approach-dll'));
    });

    // Dev (unpackaged) never enforces the release MD5 — the dev loop mutates the DLL.
    it('does not update in dev even when the DLL is out of date', async () => {
      setupDefaultMocks({
        'check-bepinex': Promise.resolve({ installed: true }),
        'get-cache-flag': Promise.resolve({ success: true, value: true }),
        'get-system-info': Promise.resolve({ success: true, platform: 'win32', isPackaged: false }),
        'check-command-capability': Promise.resolve({ pluginInstalled: true, pluginUpToDate: false }),
        'get-airport-files-info': Promise.resolve([zsjnFile]),
      });
      renderBrowser();
      await waitFor(() => expect(screen.getByText('Relax Time')).toBeInTheDocument());
      mockIpcInvoke.mockClear();

      await userEvent.click(screen.getByText('Surface Radar'));

      await waitFor(() => expect(mockIpcInvoke.mock.calls.map(c => c[0])).toContain('open-ground-map'));
      expect(mockIpcInvoke.mock.calls.map(c => c[0])).not.toContain('download-approach-dll');
    });

    // Debug Mode off → instruct the user, never install, never open.
    it('instructs enabling Debug Mode when it is off (no install, no window)', async () => {
      setupDefaultMocks({
        'check-bepinex': Promise.resolve({ installed: false }),
        'get-cache-flag': Promise.resolve({ success: true, value: false }),
        'get-airport-files-info': Promise.resolve([zsjnFile]),
      });
      renderBrowser();
      await waitFor(() => expect(screen.getByText('Relax Time')).toBeInTheDocument());
      mockIpcInvoke.mockClear();

      await userEvent.click(screen.getByText('Surface Radar'));

      await waitFor(() => expect(screen.getByText(/Shut down the game and enable debug mode in setting/)).toBeInTheDocument());
      const channels = mockIpcInvoke.mock.calls.map(c => c[0]);
      expect(channels).not.toContain('download-approach-dll');
      expect(channels).not.toContain('open-ground-map');
    });

    it('auto-collapses trailing airports so every airport header stays visible', async () => {
      setupFourAirports();
      const geo = mockCardGeometry(560);
      try {
        renderBrowser();

        await waitFor(() => {
          expect(document.querySelectorAll('.airport-card').length).toBe(4);
        });

        await waitFor(() => {
          const cards = document.querySelectorAll('.airport-card');
          // Trailing airports are collapsed first; the leading one stays open.
          expect(cards[0].getAttribute('data-expanded')).toBe('true');
          expect(cards[cards.length - 1].getAttribute('data-expanded')).toBe('false');
        });

        // Every airport remains represented by a visible header.
        expect(document.querySelectorAll('.airport-card-header').length).toBe(4);
        // Only the leading (expanded) airport renders its level rows.
        expect(document.querySelectorAll('.airport-card[data-expanded="false"] .level-row').length).toBe(0);
      } finally {
        geo.restore();
      }
    });

    it('does not re-run auto-collapse after load, even when the window resizes', async () => {
      setupFourAirports();
      const geo = mockCardGeometry(560);
      try {
        renderBrowser();

        await waitFor(() => {
          const cards = document.querySelectorAll('.airport-card');
          expect(cards.length).toBe(4);
          expect(cards[3].getAttribute('data-expanded')).toBe('false');
        });

        const collapsedCount = () =>
          document.querySelectorAll('.airport-card[data-expanded="false"]').length;
        expect(collapsedCount()).toBe(3);

        // Give the window plenty of room and fire a resize — the auto-collapse
        // decision is frozen at load time and must not re-expand anything.
        geo.setHeight(2000);
        fireEvent(window, new Event('resize'));
        await new Promise(r => setTimeout(r, 0));
        expect(collapsedCount()).toBe(3);
      } finally {
        geo.restore();
      }
    });

    it('remembers the collapse state when returning to the browser (same session)', async () => {
      setupFourAirports();
      const geo = mockCardGeometry(560);
      try {
        const first = renderBrowser();
        await waitFor(() => {
          expect(document.querySelectorAll('.airport-card[data-expanded="false"]').length).toBe(3);
        });
        first.unmount();

        // Simulate returning from a level: the screen remounts, but the
        // session guard means auto-collapse does not run again — and the
        // previous collapse state is restored from the store.
        renderBrowser();
        await waitFor(() => {
          expect(document.querySelectorAll('.airport-card').length).toBe(4);
        });
        expect(document.querySelectorAll('.airport-card[data-expanded="false"]').length).toBe(3);
        expect(document.querySelectorAll('.airport-card[data-expanded="true"]').length).toBe(1);
      } finally {
        geo.restore();
      }
    });

    it('remembers a manual collapse choice when returning to the browser', async () => {
      const user = userEvent.setup();
      setupDefaultMocks({
        'get-airport-files-info': Promise.resolve([zsjnFile]),
      });
      const first = renderBrowser();

      await waitFor(() => {
        expect(screen.getByText('Relax Time')).toBeInTheDocument();
      });

      await user.click(document.querySelector('.airport-card-header'));
      expect(screen.queryByText('Relax Time')).toBeNull();
      first.unmount();

      // Returning to the browser keeps the user's explicit collapse.
      renderBrowser();
      await waitFor(() => {
        expect(document.querySelectorAll('.airport-card-header').length).toBe(1);
      });
      expect(document.querySelector('.airport-card-header').getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByText('Relax Time')).toBeNull();
    });
  });

  describe('Level-scan loading overlay', () => {
    const zsjnFile = {
      filename: 'ZSJN_leisure_1.acl',
      path: 'D:\\Games\\Airport Control 27\\ZSJN\\ZSJN_leisure_1.acl',
      isDemo: false,
      isEmer: false,
      startTime: '06:00',
      endTime: '08:00',
      arrivals: 10,
      departures: 2,
    };

    it('covers the whole screen while the scan is in flight and clears once it resolves', async () => {
      let resolveScan;
      mockIpcInvoke.mockImplementation((channel) => {
        if (channel === 'get-app-version') return Promise.resolve('1.0.10');
        if (channel === 'check-bepinex') return Promise.resolve({ installed: false });
        if (channel === 'get-airport-files-info') {
          return new Promise((resolve) => { resolveScan = resolve; });
        }
        return Promise.resolve({});
      });
      renderBrowser();

      // Scan in flight: global overlay + spinner + message, and the inline
      // list loading state is gone (the overlay replaces it).
      await waitFor(() => {
        expect(document.querySelector('.browser-scan-overlay')).toBeTruthy();
      });
      expect(document.querySelector('.browser-scan-overlay .spinner')).toBeTruthy();
      expect(screen.getByText('Scanning level files…')).toBeInTheDocument();
      expect(document.querySelector('.browser-content > .loading-state')).toBeNull();

      resolveScan([zsjnFile]);
      await waitFor(() => {
        expect(document.querySelector('.browser-scan-overlay')).toBeNull();
        expect(screen.getByText('Relax Time')).toBeInTheDocument();
      });
    });
  });
