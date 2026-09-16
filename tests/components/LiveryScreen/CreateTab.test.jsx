import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateTab from '../../../src/components/LiveryScreen/CreateTab';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';
import { fileToDataUrl, normalizeToTexture } from '../../../src/utils/liveryImage';

vi.mock('../../../src/utils/liveryImage', () => ({
  fileToDataUrl: vi.fn(),
  normalizeToTexture: vi.fn(),
}));

const FAKE_PNG = 'data:image/png;base64,FAKE2048';

function renderCreate(props = {}) {
  return render(
    <I18nProvider>
      <CreateTab {...props} />
      <Modal />
      <Toast />
    </I18nProvider>
  );
}

function setupMocks(overrides = {}) {
  mockIpcInvoke.mockImplementation((channel, ...args) => {
    if (overrides[channel] !== undefined) return overrides[channel];
    return Promise.resolve({});
  });
}

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  CreateTab.prefill = null;
  vi.mocked(fileToDataUrl).mockReset();
  vi.mocked(normalizeToTexture).mockReset();
  vi.mocked(normalizeToTexture).mockResolvedValue(FAKE_PNG);
});

describe('CreateTab upload validation', () => {
  it('create is disabled until image + airline + aircraft are valid', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();

    const createBtn = screen.getByText('Create Livery').closest('button');
    expect(createBtn.disabled).toBe(true);

    // Ingest an image via the hidden file input.
    vi.mocked(fileToDataUrl).mockResolvedValue('data:image/png;base64,RAW');
    const file = new File(['x'], 'paint.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]');
    await user.upload(input, file);
    await waitFor(() => expect(vi.mocked(normalizeToTexture)).toHaveBeenCalled());
    // Still disabled: airline/aircraft missing.
    expect(createBtn.disabled).toBe(true);

    // Valid airline (uppercased + stripped automatically).
    const airlineInput = screen.getByPlaceholderText('CCA');
    await user.type(airlineInput, 'cca');
    expect(airlineInput.value).toBe('CCA');

    // Valid aircraft.
    const select = document.querySelector('select');
    await user.selectOptions(select, 'A20N');

    await waitFor(() => expect(createBtn.disabled).toBe(false));
    expect(screen.getByText('A20N_CCA')).toBeInTheDocument();
  });

  it('rejects short airline codes', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();
    const createBtn = screen.getByText('Create Livery').closest('button');
    const airlineInput = screen.getByPlaceholderText('CCA');
    await user.type(airlineInput, 'CC');
    const select = document.querySelector('select');
    await user.selectOptions(select, 'A20N');
    expect(createBtn.disabled).toBe(true);
  });

  it('create calls createLivery and switches to Mine on success', async () => {
    const onCreated = vi.fn();
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }) });
    const user = userEvent.setup();
    renderCreate({ onCreated });

    vi.mocked(fileToDataUrl).mockResolvedValue('data:image/png;base64,RAW');
    const file = new File(['x'], 'paint.png', { type: 'image/png' });
    await user.upload(document.querySelector('input[type="file"]'), file);
    await waitFor(() => expect(vi.mocked(normalizeToTexture)).toHaveBeenCalled());
    await user.type(screen.getByPlaceholderText('CCA'), 'CCA');
    await user.selectOptions(document.querySelector('select'), 'A20N');

    const createBtn = screen.getByText('Create Livery').closest('button');
    await waitFor(() => expect(createBtn.disabled).toBe(false));
    await user.click(createBtn);

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith(
      'create-livery',
      { imageDataUrl: FAKE_PNG, airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', shortCode: 'A20N' },
    ));
    expect(onCreated).toHaveBeenCalled();
    expect(screen.getByText('Livery created')).toBeInTheDocument();
  });

  it('shows mapped error toast on BAD_AIRLINE', async () => {
    setupMocks({ 'create-livery': Promise.resolve({ success: false, error: 'BAD_AIRLINE' }) });
    const user = userEvent.setup();
    renderCreate();

    vi.mocked(fileToDataUrl).mockResolvedValue('data:image/png;base64,RAW');
    const file = new File(['x'], 'paint.png', { type: 'image/png' });
    await user.upload(document.querySelector('input[type="file"]'), file);
    await waitFor(() => expect(vi.mocked(normalizeToTexture)).toHaveBeenCalled());
    await user.type(screen.getByPlaceholderText('CCA'), 'CCA');
    await user.selectOptions(document.querySelector('select'), 'A20N');
    const createBtn = screen.getByText('Create Livery').closest('button');
    await waitFor(() => expect(createBtn.disabled).toBe(false));
    await user.click(createBtn);

    await waitFor(() => {
      expect(screen.getByText('Airline code must be 3 uppercase letters.')).toBeInTheDocument();
    });
  });

  it('load from zip previews airline/aircraft and installs via create-livery', async () => {
    setupMocks({
      'load-livery-zip': Promise.resolve({
        canceled: false,
        success: true,
        folder: 'B738_AAL',
        shortCode: 'B738',
        manifest: { airline: 'AAL', targetPlaneId: 'BOEING 737-800' },
        imageDataUrl: 'data:image/png;base64,ZIPBASE',
      }),
      'create-livery': Promise.resolve({ success: true, folder: 'B738_AAL' }),
    });
    const user = userEvent.setup();
    renderCreate();
    await user.click(screen.getByText('Load from ZIP'));
    await waitFor(() => {
      // Inline hint + success toast share the same string.
      expect(screen.getAllByText('Loaded B738_AAL').length).toBeGreaterThanOrEqual(1);
    });
    // Airline/aircraft prefilled from the zip.
    expect(screen.getByPlaceholderText('CCA').value).toBe('AAL');
    expect(document.querySelector('select').value).toBe('B738');
    // Install reuses create-livery.
    const createBtn = screen.getByText('Create Livery').closest('button');
    await waitFor(() => expect(createBtn.disabled).toBe(false));
    await user.click(createBtn);
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', {
        imageDataUrl: FAKE_PNG,
        airline: 'AAL',
        targetPlaneId: 'BOEING 737-800',
        shortCode: 'B738',
      });
    });
  });
});
