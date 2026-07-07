import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Must run before any module that uses window.electronAPI ──
vi.hoisted(() => {
  let _checkResult = { success: true, exists: false };

  Object.defineProperty(window, 'electronAPI', {
    value: {
      checkVideoBackupExists: vi.fn(() => Promise.resolve(_checkResult)),
    },
    writable: true,
    configurable: true,
  });

  // Expose helpers for tests
  window.__vbgTest = {
    setCheckResult: (result) => {
      _checkResult = result;
      window.electronAPI.checkVideoBackupExists = vi.fn(() => Promise.resolve(result));
    },
  };
});

import VideoBackgroundModal from '../../../src/components/BrowserScreen/VideoBackgroundModal';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderOverlay(props = {}) {
  return render(
    <I18nProvider>
      <VideoBackgroundModal
        onClose={props.onClose || vi.fn()}
        onReplace={props.onReplace || vi.fn()}
        onRestore={props.onRestore || vi.fn()}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  setLang('en');
  vi.clearAllMocks();
  // Reset to default: no backup exists
  window.__vbgTest.setCheckResult({ success: true, exists: false });
});

describe('VideoBackgroundModal', () => {
  // ── Rendering ──────────────────────────────────────────
  it('renders the title', () => {
    renderOverlay();
    const title = document.querySelector('#vbg-modal-header h2');
    expect(title).toHaveTextContent('Replace In-Game Title Page Background Video');
  });

  it('renders the description', () => {
    renderOverlay();
    expect(screen.getByText(/Select a video to replace the title screen/)).toBeInTheDocument();
  });

  it('renders Replace Video button', () => {
    renderOverlay();
    const btn = screen.getByText('Replace Background Video');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('renders Restore button', () => {
    renderOverlay();
    expect(screen.getByText('Restore Original')).toBeInTheDocument();
  });

  // ── Close mechanics ────────────────────────────────────
  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    fireEvent.click(document.getElementById('vbg-modal-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close when content box is clicked', () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    fireEvent.click(document.getElementById('vbg-modal-box'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('close button calls onClose', () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    const closeBtn = document.querySelector('#vbg-modal-header button');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Action buttons ─────────────────────────────────────
  it('Replace button calls onReplace', () => {
    const onReplace = vi.fn();
    renderOverlay({ onReplace });
    fireEvent.click(screen.getByText('Replace Background Video'));
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it('Restore button calls onRestore when backup exists', async () => {
    window.__vbgTest.setCheckResult({ success: true, exists: true });
    const onRestore = vi.fn();
    renderOverlay({ onRestore });
    await waitFor(() => {
      expect(screen.getByText('Restore Original')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByText('Restore Original'));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('Restore button is disabled when backup does not exist', async () => {
    window.__vbgTest.setCheckResult({ success: true, exists: false });
    renderOverlay();
    await waitFor(() => {
      expect(screen.getByText('Restore Original')).toBeDisabled();
    });
  });

  it('Restore button shows tooltip when disabled', async () => {
    window.__vbgTest.setCheckResult({ success: true, exists: false });
    renderOverlay();
    await waitFor(() => {
      const btn = screen.getByText('Restore Original');
      expect(btn).toHaveAttribute('title', 'Backup not available');
    });
  });

  // ── Localization ───────────────────────────────────────
  it('renders in Chinese when lang is zh', async () => {
    setLang('zh');
    renderOverlay();
    expect(screen.getByText('替换游戏背景动画')).toBeInTheDocument();
    expect(screen.getByText('替换背景动画')).toBeInTheDocument();
    expect(screen.getByText('还原备份')).toBeInTheDocument();
  });
});
