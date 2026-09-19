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
  useAppStore.setState(useAppStore.getInitialState());
});

describe('SetupScreen — game root auto-detection', () => {
  it('offers the detected folder and starts the cache build on confirm', async () => {
    const user = userEvent.setup();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'detect-game-root') {
        return Promise.resolve({
          found: true,
          rootPath: 'D:\\SteamLibrary\\steamapps\\common\\Airport Control 25 Playtest',
          airports: [{ icao: 'ZSJN', name: 'Jinan' }],
          totalFiles: 3,
          steam: true,
        });
      }
      return Promise.resolve({});
    });

    renderSetup();

    await waitFor(() => {
      expect(screen.getByText(/Game folder detected via Steam/)).toBeInTheDocument();
    });
    expect(screen.getByText('D:\\SteamLibrary\\steamapps\\common\\Airport Control 25 Playtest')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Use this folder/ }));

    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('init-airport-cache', 'D:\\SteamLibrary\\steamapps\\common\\Airport Control 25 Playtest');
    });
    expect(useAppStore.getState().screen).toBe('browser');
    expect(useAppStore.getState().rootPath).toBe('D:\\SteamLibrary\\steamapps\\common\\Airport Control 25 Playtest');
  });

  it('shows no detected panel when nothing is found, falling back to the picker', async () => {
    const user = userEvent.setup();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'detect-game-root') return Promise.resolve({ found: false });
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
