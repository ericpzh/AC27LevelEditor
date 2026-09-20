import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UploadLiveryDialog from '../../../src/components/LiveryScreen/UploadLiveryDialog';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke, mockIpcListeners } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderDialog(props = {}) {
  return render(
    <I18nProvider>
      <UploadLiveryDialog folder="A20N_CCA" onClose={() => {}} {...props} />
    </I18nProvider>
  );
}

const INFO = {
  success: true,
  available: true,
  appId: '3328490',
  folder: 'A20N_CCA',
  publishedFileId: null,
  url: null,
  title: 'A20N CCA Default Livery',
  description: 'Aircraft: AIRBUS A-320neo',
  airline: 'CCA',
  targetPlaneId: 'AIRBUS A-320neo',
  visibility: 2,
  tags: ['Livery'],
  previewDataUrl: 'data:image/png;base64,X',
  author: 'Tester',
};

function setupMocks(overrides = {}) {
  mockIpcInvoke.mockImplementation((channel, ...args) => {
    if (overrides[channel] !== undefined) {
      return typeof overrides[channel] === 'function' ? overrides[channel](...args) : overrides[channel];
    }
    switch (channel) {
      case 'get-workshop-publish-info':
        return Promise.resolve({ ...INFO });
      case 'publish-livery':
        return Promise.resolve({ success: true, publishedFileId: '123', url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=123' });
      default:
        return Promise.resolve({});
    }
  });
}

function fireProgress(data) {
  // NB: the setup.js mock stores the subscriber directly (no (_event, data)
  // wrapper like the real preload), so invoke with the payload alone.
  for (const cb of mockIpcListeners['workshop-upload-progress'] || []) {
    cb(data);
  }
}

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  for (const k of Object.keys(mockIpcListeners)) delete mockIpcListeners[k];
});

describe('UploadLiveryDialog', () => {
  it('shows a spinner while the publish info loads', () => {
    setupMocks({ 'get-workshop-publish-info': new Promise(() => {}) });
    renderDialog();
    expect(screen.getByText('Loading publish info…')).toBeInTheDocument();
  });

  it('prefills title/description/visibility/tags from publish info', async () => {
    setupMocks();
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('A20N CCA Default Livery')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Aircraft: AIRBUS A-320neo')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Livery')).toBeInTheDocument();
    // Private default.
    expect(document.querySelector('#livery-upload-body select').value).toBe('2');
    // New item: no change note (the item id is recorded automatically after
    // upload, so there is no link field to fill in).
    expect(screen.queryByText('Change note')).toBeNull();
    expect(screen.getByText('After uploading, please go to the Steam Workshop page to edit it.')).toBeInTheDocument();
  });

  it('defaults the title to the localized airline + aircraft type', async () => {
    setupMocks({
      'get-workshop-publish-info': Promise.resolve({ ...INFO, title: '', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo' }),
    });
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('Air China A-320neo Livery')).toBeInTheDocument());
  });

  it('defaults the title in Chinese when the UI language is zh', async () => {
    setLang('zh');
    try {
      setupMocks({
        'get-workshop-publish-info': Promise.resolve({ ...INFO, title: '', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo' }),
      });
      renderDialog();
      await waitFor(() => expect(screen.getByDisplayValue('中国国航 A-320neo 涂装')).toBeInTheDocument());
    } finally {
      setLang('en');
    }
  });

  it('disables submit when Steam is unavailable and shows the reason', async () => {
    setupMocks({
      'get-workshop-publish-info': Promise.resolve({
        ...INFO, available: false, reason: 'STEAM_UNAVAILABLE',
      }),
    });
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText(/Steam is not running/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });

  it('shows the known item URL and keeps the Upload button label', async () => {
    setupMocks({
      'get-workshop-publish-info': Promise.resolve({
        ...INFO, publishedFileId: '999', url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=999',
      }),
    });
    renderDialog();
    // The already-published item's URL is shown up front (clickable).
    await waitFor(() => {
      expect(screen.getByText('https://steamcommunity.com/sharedfiles/filedetails/?id=999')).toBeInTheDocument();
    });
    // No change-note input, and the submit button never renames itself.
    expect(screen.queryByText('Change note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish new version' })).toBeNull();
  });

  it('renders progress and success with the item URL', async () => {
    let resolvePublish;
    setupMocks({
      'publish-livery': new Promise((resolve) => { resolvePublish = resolve; }),
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('A20N CCA Default Livery')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    // Progress events drive the bar.
    await waitFor(() => {
      fireProgress({ status: 3, progress: 50, total: 100 });
      expect(screen.getByText(/Uploading… 50%/)).toBeInTheDocument();
    });
    resolvePublish({ success: true, publishedFileId: '123', url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=123' });
    await waitFor(() => {
      expect(screen.getByText('Upload succeeded')).toBeInTheDocument();
      expect(screen.getByText('https://steamcommunity.com/sharedfiles/filedetails/?id=123')).toBeInTheDocument();
    });
    // The URL itself is the only affordance (no separate Open-in-Steam button).
    expect(screen.queryByRole('button', { name: 'Open in Steam' })).toBeNull();
    // The URL is a real link (opens externally); no delete-note text.
    const link = document.querySelector('.livery-upload-url a');
    expect(link.getAttribute('href')).toBe('https://steamcommunity.com/sharedfiles/filedetails/?id=123');
    expect(screen.queryByText('Deleting the livery locally does not remove the Steam item.')).toBeNull();
    await user.click(link);
    expect(mockIpcInvoke).toHaveBeenCalledWith(
      'open-external', 'https://steamcommunity.com/sharedfiles/filedetails/?id=123',
    );
  });

  it('keeps the typed input on error so the user can retry', async () => {
    let fail = true;
    setupMocks({
      'publish-livery': (...args) => (fail
        ? Promise.resolve({ success: false, error: 'UPLOAD_FAILED' })
        : Promise.resolve({ success: true, publishedFileId: '123', url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=123' })),
    });
    const user = userEvent.setup();
    renderDialog();
    const titleInput = await screen.findByDisplayValue('A20N CCA Default Livery');
    await user.clear(titleInput);
    await user.type(titleInput, 'My custom title');
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => {
      expect(screen.getByText(/Upload failed/)).toBeInTheDocument();
    });
    // Input survived the failure.
    expect(screen.getByDisplayValue('My custom title')).toBeInTheDocument();
    // Retry succeeds.
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => {
      expect(screen.getByText('Upload succeeded')).toBeInTheDocument();
    });
  });

  it('falls back to generic text for unknown codes and shows the detail', async () => {
    setupMocks({
      'publish-livery': Promise.resolve({
        success: false, error: 'SomethingWeird', detail: 'raw native text',
      }),
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('A20N CCA Default Livery')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => {
      // Mapped generic text, never the raw key…
      expect(screen.getByText('Upload failed — restart Steam and retry.')).toBeInTheDocument();
      expect(screen.queryByText('livery_err_SomethingWeird')).toBeNull();
      // …with the raw code + detail underneath for diagnosis.
      expect(screen.getByText('SomethingWeird — raw native text')).toBeInTheDocument();
    });
    // The error view offers the log file in one click (packaged builds have
    // no visible console).
    await user.click(screen.getByRole('button', { name: 'View log' }));
    expect(mockIpcInvoke).toHaveBeenCalledWith('open-workshop-log');
  });

  it('shows a stale-main banner when the debug handshake is missing', async () => {
    setupMocks({
      'workshop-debug-info': () => Promise.reject(new Error('No handler was registered')),
    });
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('Editor core is outdated — quit the editor fully and restart it.')).toBeInTheDocument();
    });
    expect(mockIpcInvoke).toHaveBeenCalledWith('workshop-debug-info');
  });

  it('never sends a link id — association is recorded automatically', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('A20N CCA Default Livery')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('publish-livery', expect.objectContaining({ folder: 'A20N_CCA' }));
    });
    const payload = mockIpcInvoke.mock.calls.find(c => c[0] === 'publish-livery')[1];
    expect(payload.linkItemId).toBeUndefined();
  });

  it('choosing a preview image updates the preview', async () => {
    setupMocks({
      'select-livery-preview': Promise.resolve({
        canceled: false, success: true, filePath: '/tmp/p.jpg', imageDataUrl: 'data:image/jpeg;base64,Y',
      }),
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('A20N CCA Default Livery')).toBeInTheDocument());
    const before = document.querySelector('.livery-upload-preview-row img').getAttribute('src');
    expect(before).toBe('data:image/png;base64,X');
    await user.click(screen.getByRole('button', { name: 'Choose image' }));
    await waitFor(() => {
      expect(document.querySelector('.livery-upload-preview-row img').getAttribute('src')).toBe('data:image/jpeg;base64,Y');
    });
    // The picked file travels with the publish payload.
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('publish-livery', expect.objectContaining({ previewPath: '/tmp/p.jpg' }));
    });
  });
});
