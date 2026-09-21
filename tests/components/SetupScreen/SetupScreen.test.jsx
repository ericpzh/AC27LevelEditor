import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SetupScreen from '../../../src/components/SetupScreen/SetupScreen';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderSetup() {
  return render(
    <I18nProvider>
      <SetupScreen />
    </I18nProvider>
  );
}

beforeEach(() => {
  setLang('en');
  mockIpcInvoke.mockClear();
  useAppStore.setState(useAppStore.getInitialState());
});

describe('SetupScreen — game root auto-detection', () => {
  it('offers the detected folder and starts the cache build on confirm', async () => {
    const user = userEvent.setup();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'detect-game-root') {
        return Promise.resolve({
          found: true,
          rootPath: 'D:\\SteamLibrary\\steamapps\\common\\Airport Control 27',
          airports: [{ icao: 'ZSJN', name: 'Jinan' }],
          totalFiles: 3,
          steam: true,
        });
      }
      if (channel === 'is-workshop-build') return Promise.resolve(true);
      return Promise.resolve({});
    });

    renderSetup();

    await waitFor(() => {
      expect(screen.getByText(/Game folder detected via Steam/)).toBeInTheDocument();
    });
    expect(screen.getByText('D:\\SteamLibrary\\steamapps\\common\\Airport Control 27')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Use this folder/ }));

    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('init-airport-cache', 'D:\\SteamLibrary\\steamapps\\common\\Airport Control 27');
    });
    expect(useAppStore.getState().screen).toBe('browser');
    expect(useAppStore.getState().rootPath).toBe('D:\\SteamLibrary\\steamapps\\common\\Airport Control 27');
  });

  it('never auto-detects on the normal (non-Workshop) build', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'is-workshop-build') return Promise.resolve(false);
      if (channel === 'detect-game-root') {
        return Promise.resolve({ found: true, rootPath: 'D:\\should-not-be-used', airports: [], totalFiles: 0, steam: true });
      }
      return Promise.resolve({});
    });

    renderSetup();

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('is-workshop-build'));
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('detect-game-root');
    expect(document.querySelector('.setup-detected')).toBeNull();
    expect(screen.getByRole('button', { name: /Select Game Root/ })).toBeInTheDocument();
  });

  it('shows no detected panel when nothing is found, falling back to the picker', async () => {
    const user = userEvent.setup();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'detect-game-root') return Promise.resolve({ found: false });
      if (channel === 'is-workshop-build') return Promise.resolve(true);
      if (channel === 'select-game-root') return Promise.resolve({ canceled: true });
      return Promise.resolve({});
    });

    renderSetup();

    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('detect-game-root');
    });
    expect(document.querySelector('.setup-detected')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Select Game Root/ }));
    expect(mockIpcInvoke).toHaveBeenCalledWith('select-game-root');
  });

  it('uses the manual picker result when detection was not found', async () => {
    const user = userEvent.setup();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'detect-game-root') return Promise.resolve({ found: false });
      if (channel === 'is-workshop-build') return Promise.resolve(true);
      if (channel === 'select-game-root') {
        return Promise.resolve({
          canceled: false,
          rootPath: 'C:\\Games\\AC27',
          airports: [{ icao: 'KJFK', name: 'JFK' }],
          totalFiles: 1,
        });
      }
      return Promise.resolve({});
    });

    renderSetup();
    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('detect-game-root'));

    await user.click(screen.getByRole('button', { name: /Select Game Root/ }));

    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('init-airport-cache', 'C:\\Games\\AC27');
    });
    expect(useAppStore.getState().screen).toBe('browser');
  });
});

describe('SetupScreen — Steam Workshop build layout', () => {
  function mockWorkshop() {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'detect-game-root') {
        return Promise.resolve({
          found: true,
          rootPath: 'D:\\SteamLibrary\\steamapps\\common\\Airport Control 27',
          airports: [{ icao: 'ZSJN', name: 'Jinan' }],
          totalFiles: 3,
          steam: true,
        });
      }
      if (channel === 'is-workshop-build') return Promise.resolve(true);
      return Promise.resolve({});
    });
  }

  it('drops the setup subtitle and manual hint, and puts the detected panel above the Steam block with parallel buttons', async () => {
    mockWorkshop();
    renderSetup();

    await waitFor(() => {
      expect(screen.getByText(/Game folder detected via Steam/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/Select the game installation directory/)).toBeNull();
    expect(screen.queryByText(/select it manually below/)).toBeNull();

    const actions = document.querySelector('.setup-detected-actions');
    expect(actions).not.toBeNull();
    expect(actions.querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Use this folder/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Select Game Root/ })).toBeInTheDocument();

    const steamHint = document.querySelector('.steam-hint');
    expect(steamHint).not.toBeNull();
    expect(
      actions.compareDocumentPosition(steamHint) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('keeps the standalone picker button when no folder is detected', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'detect-game-root') return Promise.resolve({ found: false });
      if (channel === 'is-workshop-build') return Promise.resolve(true);
      return Promise.resolve({});
    });
    renderSetup();

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('is-workshop-build'));
    expect(document.querySelector('.setup-detected')).toBeNull();
    expect(screen.getByRole('button', { name: /Select Game Root/ })).toBeInTheDocument();
  });
});
