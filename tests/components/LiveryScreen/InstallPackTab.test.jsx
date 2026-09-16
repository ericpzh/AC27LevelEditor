import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InstallPackTab from '../../../src/components/LiveryScreen/InstallPackTab';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderTab() {
  return render(
    <I18nProvider>
      <InstallPackTab />
      <Modal />
      <Toast />
    </I18nProvider>
  );
}

function setupMocks(overrides = {}) {
  mockIpcInvoke.mockImplementation((channel) => {
    if (overrides[channel] !== undefined) return overrides[channel];
    return Promise.resolve({});
  });
}

const installBtn = () => screen.getByText('Install pack').closest('button');

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  mockIpcInvoke.mockReset();
});

describe('InstallPackTab', () => {
  it('renders the explanatory panel without a target when no rootPath is set', () => {
    setupMocks();
    renderTab();
    expect(screen.getByText(/extract it into the game Mods\/ folder/)).toBeInTheDocument();
    expect(screen.queryByText('Install target')).toBeNull();
    expect(installBtn()).toBeInTheDocument();
  });

  it('shows the Mods install target derived from rootPath (backslash and slash)', () => {
    setupMocks();
    useAppStore.setState({ rootPath: 'D:\\Games\\Airport Control 27\\' });
    const { unmount } = renderTab();
    expect(screen.getByText('Install target')).toBeInTheDocument();
    expect(document.querySelector('.livery-install-path').textContent).toBe('D:\\Games\\Airport Control 27\\Mods');
    unmount();
    useAppStore.setState({ rootPath: '/games/ac27/' });
    renderTab();
    expect(document.querySelector('.livery-install-path').textContent).toBe('/games/ac27/Mods');
  });

  it('Install opens the download overlay and starts the download', async () => {
    setupMocks({ 'download-livery': new Promise(() => {}) });
    const user = userEvent.setup();
    renderTab();
    await user.click(installBtn());
    await waitFor(() => {
      expect(document.getElementById('livery-overlay')).toBeInTheDocument();
    });
    expect(mockIpcInvoke).toHaveBeenCalledWith('download-livery');
    expect(installBtn().disabled).toBe(true);
  });

  it('a successful download installs the zip and toasts success', async () => {
    setupMocks({
      'download-livery': Promise.resolve({ success: true, filePath: '/dl/pack.zip' }),
      'install-livery': Promise.resolve({ success: true }),
    });
    const user = userEvent.setup();
    renderTab();
    await user.click(installBtn());
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('install-livery', '/dl/pack.zip');
    });
    await waitFor(() => {
      expect(screen.getByText('Livery installed successfully')).toBeInTheDocument();
    });
    expect(document.getElementById('livery-overlay')).toBeNull();
    await waitFor(() => expect(installBtn().disabled).toBe(false));
  });

  it('maps a NO_GAME_ROOT install failure to its dedicated message', async () => {
    setupMocks({
      'download-livery': Promise.resolve({ success: true, filePath: '/dl/pack.zip' }),
      'install-livery': Promise.resolve({ success: false, error: 'NO_GAME_ROOT' }),
    });
    const user = userEvent.setup();
    renderTab();
    await user.click(installBtn());
    await waitFor(() => {
      expect(screen.getByText('Game root not configured. Please select the game directory first.')).toBeInTheDocument();
    });
  });

  it('surfaces a generic install failure verbatim', async () => {
    setupMocks({
      'download-livery': Promise.resolve({ success: true, filePath: '/dl/pack.zip' }),
      'install-livery': Promise.resolve({ success: false, error: 'BAD_ZIP' }),
    });
    const user = userEvent.setup();
    renderTab();
    await user.click(installBtn());
    await waitFor(() => {
      expect(screen.getByText('BAD_ZIP')).toBeInTheDocument();
    });
  });

  it('a failed download falls back to the local ZIP picker and installs it', async () => {
    setupMocks({
      'download-livery': Promise.resolve({ success: false }),
      'select-livery-zip': Promise.resolve({ canceled: false, filePath: '/pick/local.zip' }),
      'install-livery': Promise.resolve({ success: true }),
    });
    const user = userEvent.setup();
    renderTab();
    await user.click(installBtn());
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('select-livery-zip');
    });
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('install-livery', '/pick/local.zip');
    });
    await waitFor(() => {
      expect(screen.getByText('Livery installed successfully')).toBeInTheDocument();
    });
  });

  it('a cancelled fallback picker stays silent', async () => {
    setupMocks({
      'download-livery': Promise.resolve({ success: false }),
      'select-livery-zip': Promise.resolve({ canceled: true }),
    });
    const user = userEvent.setup();
    renderTab();
    await user.click(installBtn());
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('select-livery-zip');
    });
    await new Promise(r => setTimeout(r, 30));
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('install-livery', expect.anything());
    expect(screen.queryByText(/installed successfully/)).toBeNull();
    await waitFor(() => expect(installBtn().disabled).toBe(false));
  });

  it('the Close button dismisses the modal', async () => {
    setupMocks();
    useAppStore.getState().showModal(() => 'Pack', <InstallPackTab />);
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Modal />
      </I18nProvider>
    );
    await waitFor(() => expect(document.querySelector('#modal-box')).toBeInTheDocument());
    await user.click(screen.getByText('Close'));
    await waitFor(() => expect(document.querySelector('#modal-box')).toBeNull());
  });
});
