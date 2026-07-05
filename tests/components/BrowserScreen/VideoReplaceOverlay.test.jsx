import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Must run before any module that uses window.electronAPI ──
const { setMocks } = vi.hoisted(() => {
  const m = {
    discover: { folders: [{ icao: 'KJFK', dirPath: '/fake/KJFK.webm', files: [{ name: 'Kjfk01.webm', size: 1000 }], totalSize: 1000, backupExists: true }] },
    convert: { success: true, outputPath: '/fake/converted.webm', size: 75000000 },
    replace: { success: true, replaced: [{ icao: 'KJFK', fileCount: 1 }] },
  };

  Object.defineProperty(window, 'electronAPI', {
    value: {
      discoverMenuVideos: () => Promise.resolve(m.discover),
      convertVideo: () => Promise.resolve(m.convert),
      replaceMenuVideos: () => Promise.resolve(m.replace),
      onVideoConvertProgress: vi.fn(),
      offVideoConvertProgress: vi.fn(),
      onVideoReplaceProgress: vi.fn(),
      offVideoReplaceProgress: vi.fn(),
    },
    writable: true,
    configurable: true,
  });

  return {
    setMocks: (opts = {}) => {
      if (opts.folders !== undefined) m.discover = opts.folders;
      if (opts.convertResult !== undefined) m.convert = opts.convertResult;
      if (opts.replaceResult !== undefined) m.replace = opts.replaceResult;
    },
  };
});

import VideoReplaceOverlay from '../../../src/components/BrowserScreen/VideoReplaceOverlay';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { ElectronAPIProvider } from '../../../src/hooks/useElectronAPI';
import { setLang } from '../../../src/utils/i18n';

function renderOverlay(props = {}) {
  return render(
    <ElectronAPIProvider>
      <I18nProvider>
        <VideoReplaceOverlay sourcePath="/fake/test.mp4" onClose={vi.fn()} {...props} />
      </I18nProvider>
    </ElectronAPIProvider>
  );
}

beforeEach(() => {
  setLang('en');
  vi.clearAllMocks();
  setMocks({
    folders: { folders: [{ icao: 'KJFK', dirPath: '/fake/KJFK.webm', files: [{ name: 'Kjfk01.webm', size: 1000 }], totalSize: 1000, backupExists: true }] },
    convertResult: { success: true, outputPath: '/fake/converted.webm', size: 75000000 },
    replaceResult: { success: true, replaced: [{ icao: 'KJFK', fileCount: 1 }] },
  });
});

describe('VideoReplaceOverlay', () => {
  it('renders progress bar and percentage', () => {
    renderOverlay();
    expect(document.querySelector('.vr-progress-bar')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('closes immediately on successful completion', async () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
  });

  it('shows error when conversion fails', async () => {
    setMocks({ convertResult: { success: false, error: 'ffmpeg crashed' } });
    renderOverlay();
    await waitFor(() => {
      expect(screen.getByText('ffmpeg crashed')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText('Original files were not modified.')).toBeInTheDocument();
  });

  it('shows error when no folders found', async () => {
    setMocks({ folders: { folders: [] } });
    renderOverlay();
    await waitFor(() => {
      expect(screen.getByText(/No MainMenuVideos folders/)).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('escape key closes error overlay', async () => {
    const onClose = vi.fn();
    setMocks({ convertResult: { success: false, error: 'fail' } });
    renderOverlay({ onClose });
    await waitFor(() => {
      expect(screen.getByText('fail')).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders progress bar in Chinese', () => {
    setLang('zh');
    renderOverlay();
    expect(document.querySelector('.vr-progress-bar')).toBeInTheDocument();
  });
});
