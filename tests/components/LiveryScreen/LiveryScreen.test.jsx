import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveryScreen from '../../../src/components/LiveryScreen/LiveryScreen';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderLivery() {
  return render(
    <I18nProvider>
      <LiveryScreen />
      <Modal />
      <Toast />
    </I18nProvider>
  );
}

function setupMocks(overrides = {}) {
  mockIpcInvoke.mockImplementation((channel, ...args) => {
    if (overrides[channel] !== undefined) return overrides[channel];
    switch (channel) {
      case 'list-liveries':
        return Promise.resolve({ mine: [], reference: [] });
      default:
        return Promise.resolve({});
    }
  });
}

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState({ screen: 'livery' });
});

describe('LiveryScreen', () => {
  it('renders 3 tabs', async () => {
    setupMocks();
    renderLivery();
    expect(screen.getByText('My Liveries')).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByText('Install Pack')).toBeInTheDocument();
  });

  it('back button navigates to browser', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    await user.click(screen.getByText('Back'));
    expect(useAppStore.getState().screen).toBe('browser');
  });

  it('install tab shows download overlay on click', async () => {
    setupMocks({
      'download-livery': new Promise(() => {}),
    });
    const user = userEvent.setup();
    renderLivery();
    await user.click(screen.getByText('Install Pack'));
    const installBtn = document.querySelector('.livery-content .btn-sm');
    expect(installBtn).toBeInTheDocument();
    await user.click(installBtn);
    await waitFor(() => {
      expect(document.getElementById('livery-overlay')).toBeInTheDocument();
    });
  });

  it('install tab explains the flow and shows the Mods target', async () => {
    setupMocks();
    useAppStore.setState({ rootPath: 'D:\\Games\\Airport Control 27' });
    const user = userEvent.setup();
    renderLivery();
    await user.click(screen.getByText('Install Pack'));
    expect(screen.getByText(/extract it into the game Mods\/ folder/)).toBeInTheDocument();
    expect(screen.getByText('Install target:')).toBeInTheDocument();
    expect(document.querySelector('.livery-content code').textContent).toContain('Mods');
  });

  it('help button opens the overlay with tab and tool sections', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    const helpBtn = document.querySelector('.browser-actions .btn-icon-only');
    await user.click(helpBtn);
    await waitFor(() => {
      expect(screen.getByText('Livery Help')).toBeInTheDocument();
    });
    expect(screen.getByText('Tabs')).toBeInTheDocument();
    expect(screen.getByText('Paint tools')).toBeInTheDocument();
    expect(screen.getByText('Sharing')).toBeInTheDocument();
  });

  it('Escape closes the help overlay', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    await user.click(document.querySelector('.browser-actions .btn-icon-only'));
    await waitFor(() => {
      expect(screen.getByText('Livery Help')).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText('Livery Help')).toBeNull();
    });
  });

  it('backdrop click closes the help overlay', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    await user.click(document.querySelector('.browser-actions .btn-icon-only'));
    await waitFor(() => {
      expect(screen.getByText('Livery Help')).toBeInTheDocument();
    });
    fireEvent.click(document.getElementById('livery-help-overlay'));
    await waitFor(() => {
      expect(screen.queryByText('Livery Help')).toBeNull();
    });
  });

  it('tab buttons show tooltips on hover', async () => {
    setupMocks();
    renderLivery();
    fireEvent.mouseEnter(screen.getByText('My Liveries'));
    const tip = document.body.querySelector('.tooltip-popup');
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain('browse');
  });
});
