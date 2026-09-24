import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PttShortcutModal from '../../../src/components/MapWindows/PttShortcutModal';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function setupMocks(overrides = {}) {
  mockIpcInvoke.mockImplementation((channel, ...args) => {
    if (overrides[channel] !== undefined) {
      const v = overrides[channel];
      return typeof v === 'function' ? v(...args) : v;
    }
    switch (channel) {
      case 'get-ptt-shortcut':
        return Promise.resolve({ success: true, shortcut: 'Shift+Space', defaultShortcut: 'Shift+Space' });
      case 'set-ptt-shortcut':
        return Promise.resolve({ success: true, shortcut: args[0] || '' });
      default:
        return Promise.resolve({});
    }
  });
}

function renderModal(onClose = () => {}) {
  return render(
    <I18nProvider>
      <PttShortcutModal onClose={onClose} />
    </I18nProvider>
  );
}

function captureBox() {
  return screen.getByRole('textbox', { name: 'Update PTT shortcut' });
}

beforeEach(() => {
  setLang('en');
});

describe('PttShortcutModal', () => {
  it('loads and shows the current shortcut', async () => {
    setupMocks();
    renderModal();
    await waitFor(() => {
      expect(captureBox()).toHaveTextContent('Shift+Space');
    });
  });

  it('captures a new combo and persists it', async () => {
    setupMocks();
    renderModal();
    await waitFor(() => expect(captureBox()).toHaveTextContent('Shift+Space'));
    fireEvent.keyDown(captureBox(), { key: 'p', code: 'KeyP', ctrlKey: true, altKey: true });
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('set-ptt-shortcut', 'Ctrl+Alt+P');
    });
    await waitFor(() => {
      expect(captureBox()).toHaveTextContent('Ctrl+Alt+P');
    });
  });

  it('Backspace disables the hotkey', async () => {
    setupMocks();
    renderModal();
    await waitFor(() => expect(captureBox()).toHaveTextContent('Shift+Space'));
    fireEvent.keyDown(captureBox(), { key: 'Backspace', code: 'Backspace' });
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('set-ptt-shortcut', '');
    });
    await waitFor(() => {
      expect(captureBox()).toHaveTextContent('Off');
    });
  });

  it('Escape closes the modal', async () => {
    setupMocks();
    const onClose = vi.fn();
    renderModal(onClose);
    await waitFor(() => expect(captureBox()).toBeInTheDocument());
    fireEvent.keyDown(captureBox(), { key: 'Escape', code: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('flashes the box red when the combo cannot be registered', async () => {
    setupMocks({
      'set-ptt-shortcut': Promise.resolve({ success: false, error: 'REGISTER_FAILED' }),
    });
    renderModal();
    await waitFor(() => expect(captureBox()).toHaveTextContent('Shift+Space'));
    fireEvent.keyDown(captureBox(), { key: 'F9', code: 'F9' });
    await waitFor(() => {
      expect(captureBox()).toHaveClass('ptt-capture-error');
    });
    // Attempted combo is echoed, then release settles back to the saved value
    expect(captureBox()).toHaveTextContent('F9');
    fireEvent.keyUp(captureBox());
    await waitFor(() => {
      expect(captureBox()).toHaveTextContent('Shift+Space');
    });
  });

  it('echoes held modifiers live without saving', async () => {
    setupMocks();
    mockIpcInvoke.mockClear();
    renderModal();
    await waitFor(() => expect(captureBox()).toHaveTextContent('Shift+Space'));
    fireEvent.keyDown(captureBox(), { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    expect(captureBox()).toHaveTextContent('Shift+…');
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('set-ptt-shortcut', expect.anything());
    fireEvent.keyUp(captureBox());
    await waitFor(() => {
      expect(captureBox()).toHaveTextContent('Shift+Space');
    });
  });

  it('echoes a bare key live and flags it without saving', async () => {
    setupMocks();
    mockIpcInvoke.mockClear();
    renderModal();
    await waitFor(() => expect(captureBox()).toHaveTextContent('Shift+Space'));
    fireEvent.keyDown(captureBox(), { key: 'a', code: 'KeyA' });
    expect(captureBox()).toHaveTextContent('A');
    expect(captureBox()).toHaveClass('ptt-capture-error');
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('set-ptt-shortcut', expect.anything());
  });

  it('backdrop click closes, inner-box click does not', async () => {
    setupMocks();
    const onClose = vi.fn();
    const { container } = renderModal(onClose);
    await waitFor(() => expect(captureBox()).toBeInTheDocument());
    fireEvent.click(captureBox()); // stopPropagation — stays open
    expect(onClose).not.toHaveBeenCalled();
    const overlay = container.querySelector('#map-help-overlay');
    fireEvent.click(overlay); // backdrop — closes
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('X button closes the modal', async () => {
    setupMocks();
    const onClose = vi.fn();
    renderModal(onClose);
    await waitFor(() => expect(captureBox()).toBeInTheDocument());
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows Off when the saved shortcut cannot be loaded', async () => {
    setupMocks({ 'get-ptt-shortcut': () => Promise.reject(new Error('no bridge')) });
    renderModal();
    await waitFor(() => {
      expect(captureBox()).toHaveTextContent('Off');
    });
  });

  it('flashes red and logs when persisting throws', async () => {
    setupMocks({ 'set-ptt-shortcut': () => Promise.reject(new Error('IPC gone')) });
    mockIpcInvoke.mockClear();
    // Re-apply overrides after the clear (clear keeps the implementation).
    renderModal();
    await waitFor(() => expect(captureBox()).toHaveTextContent('Shift+Space'));
    fireEvent.keyDown(captureBox(), { key: 'F9', code: 'F9' });
    await waitFor(() => {
      expect(captureBox()).toHaveClass('ptt-capture-error');
    });
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith(
        'debug-log', expect.arrayContaining([expect.stringContaining('[PTT-SHORTCUT]')])
      );
    });
  });

  it('ignores further keys while a save is in flight', async () => {
    let resolveSave;
    setupMocks({
      'set-ptt-shortcut': (...args) => new Promise((resolve) => {
        resolveSave = () => resolve({ success: true, shortcut: args[0] || '' });
      }),
    });
    mockIpcInvoke.mockClear();
    renderModal();
    await waitFor(() => expect(captureBox()).toHaveTextContent('Shift+Space'));
    fireEvent.keyDown(captureBox(), { key: 'F9', code: 'F9' });
    fireEvent.keyDown(captureBox(), { key: 'F10', code: 'F10' }); // saving — ignored
    resolveSave();
    await waitFor(() => {
      expect(captureBox()).toHaveTextContent('F9');
    });
    const sets = mockIpcInvoke.mock.calls.filter(([ch]) => ch === 'set-ptt-shortcut');
    expect(sets).toHaveLength(1);
  });

  it('flags red when the bridge has no setter', async () => {
    const api = window.electronAPI;
    const saved = api.setPttShortcut;
    try {
      delete api.setPttShortcut;
      setupMocks();
      renderModal();
      await waitFor(() => expect(captureBox()).toHaveTextContent('Shift+Space'));
      fireEvent.keyDown(captureBox(), { key: 'F9', code: 'F9' });
      await waitFor(() => {
        expect(captureBox()).toHaveClass('ptt-capture-error');
      });
    } finally {
      api.setPttShortcut = saved;
    }
  });

  it('tolerates a missing onClose', async () => {
    setupMocks();
    const { container } = render(
      <I18nProvider>
        <PttShortcutModal onClose={null} />
      </I18nProvider>
    );
    await waitFor(() => expect(captureBox()).toBeInTheDocument());
    fireEvent.keyDown(captureBox(), { key: 'Escape', code: 'Escape' }); // no throw
    fireEvent.click(container.querySelector('#map-help-overlay')); // no throw
  });

  it('modifier-only with no mods held falls back to the saved value', async () => {
    setupMocks();
    mockIpcInvoke.mockClear();
    renderModal();
    await waitFor(() => expect(captureBox()).toHaveTextContent('Shift+Space'));
    // Synthetic modifier keypress without the modifier flag set.
    fireEvent.keyDown(captureBox(), { key: 'Control', code: 'ControlLeft' });
    expect(captureBox()).toHaveTextContent('Shift+Space');
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('set-ptt-shortcut', expect.anything());
  });
});
