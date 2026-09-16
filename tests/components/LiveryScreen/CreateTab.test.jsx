import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
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

// ── Canvas stubs (jsdom has no 2d context; the painter always mounts one) ──
function makeCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
    fillRect: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fill: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), arc: vi.fn(),
    strokeRect: vi.fn(), setLineDash: vi.fn(),
    fillText: vi.fn(), putImageData: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    getImageData: vi.fn((x, y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
      width: w, height: h,
    })),
  };
}

const FAKE_PNG = 'data:image/png;base64,FAKE2048';

let getCtxSpy;
let toDataSpy;

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

function saveAsBtn() {
  return screen.getByRole('button', { name: 'Save As' });
}

function saveBtn() {
  // Exact 'Save' — 'Save As' is a different string so this is unambiguous.
  return screen.getByRole('button', { name: 'Save' });
}

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  CreateTab.prefill = null;
  vi.mocked(fileToDataUrl).mockReset();
  vi.mocked(normalizeToTexture).mockReset();
  vi.mocked(normalizeToTexture).mockResolvedValue(FAKE_PNG);
  getCtxSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => makeCtx());
  toDataSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(FAKE_PNG);
});

afterEach(() => {
  getCtxSpy.mockRestore();
  toDataSpy.mockRestore();
});

async function fillForm(user, airline = 'CCA', planeId = 'AIRBUS A-320neo') {
  await user.type(screen.getByPlaceholderText('CCA'), airline);
  await user.selectOptions(document.querySelector('.lp-root select'), planeId);
}

// Clicks a modal confirm button by its exact label and returns the dialog input.
async function confirmNameDialog(user, confirmName) {
  const input = await screen.findByLabelText('Folder name');
  const modal = document.querySelector('#modal-box');
  expect(modal).toBeInTheDocument();
  await user.click(within(modal).getByRole('button', { name: confirmName }));
  return input;
}

describe('CreateTab painter validation', () => {
  it('save/save-as are disabled until airline + aircraft are valid', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();

    expect(saveAsBtn().disabled).toBe(true);
    // New livery: Save tracks the form too.
    expect(saveBtn().disabled).toBe(true);

    const airlineInput = screen.getByPlaceholderText('CCA');
    await user.type(airlineInput, 'cca');
    expect(airlineInput.value).toBe('CCA');
    // Human-readable airline name hint.
    expect(screen.getAllByText('Air China').length).toBeGreaterThanOrEqual(1);
    // Dropdown always displays ALL airlines, even with CCA typed.
    const dropdownOptions = document.querySelectorAll('#livery-airline-list .lp-airline-option');
    expect(dropdownOptions.length).toBeGreaterThan(10);
    const codes = [...dropdownOptions].map(o => o.textContent);
    expect(codes.some(t => t.includes('CCA'))).toBe(true);
    expect(codes.some(t => t.includes('UAL'))).toBe(true);
    expect(codes.some(t => t.includes('CES'))).toBe(true);

    const select = document.querySelector('.lp-root select');
    await user.selectOptions(select, 'AIRBUS A-320neo');

    await waitFor(() => expect(saveAsBtn().disabled).toBe(false));
    await waitFor(() => expect(saveBtn().disabled).toBe(false));
  });

  it('rejects short airline codes', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();
    const airlineInput = screen.getByPlaceholderText('CCA');
    await user.type(airlineInput, 'CC');
    const select = document.querySelector('.lp-root select');
    await user.selectOptions(select, 'AIRBUS A-320neo');
    expect(saveAsBtn().disabled).toBe(true);
    expect(saveBtn().disabled).toBe(true);
  });

  it('save-as calls createLivery and switches to Mine on success', async () => {
    const onCreated = vi.fn();
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }) });
    const user = userEvent.setup();
    renderCreate({ onCreated });

    await fillForm(user);

    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);

    // Naming dialog is prefilled with the form folder; confirm it.
    const input = await screen.findByLabelText('Folder name');
    expect(input.value).toBe('A20N_CCA');
    await confirmNameDialog(user, 'Save As');

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith(
      'create-livery',
      { imageDataUrl: FAKE_PNG, airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', folder: 'A20N_CCA' },
    ));
    expect(onCreated).toHaveBeenCalled();
    expect(screen.getByText('Livery created')).toBeInTheDocument();
  });

  it('save-as dialog accepts a free-form folder name verbatim', async () => {
    const onCreated = vi.fn();
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'My First CCA Livery' }) });
    const user = userEvent.setup();
    renderCreate({ onCreated });

    await fillForm(user);

    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);

    const input = await screen.findByLabelText('Folder name');
    expect(input.value).toBe('A20N_CCA');
    await user.clear(input);
    await user.type(input, 'My First CCA Livery');
    expect(input.value).toBe('My First CCA Livery');
    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'Save As' }));

    // Airline/aircraft come from the form — never parsed out of the folder.
    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith(
      'create-livery',
      { imageDataUrl: FAKE_PNG, airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', folder: 'My First CCA Livery' },
    ));
    expect(onCreated).toHaveBeenCalled();
  });

  it('save dialog blocks filesystem-unsafe folder names only', async () => {
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }) });
    mockIpcInvoke.mockClear();
    const user = userEvent.setup();
    renderCreate();

    await fillForm(user);

    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);

    const input = await screen.findByLabelText('Folder name');
    const modal = document.querySelector('#modal-box');
    const confirm = () => within(modal).getByRole('button', { name: 'Save As' });

    // Traversal attempt → blocked with the invalid-name error, nothing sent.
    await user.clear(input);
    await user.type(input, '../evil');
    expect(confirm().disabled).toBe(true);
    expect(within(modal).getByText('Invalid folder name.')).toBeInTheDocument();
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('create-livery', expect.anything());

    // Empty → blocked too.
    await user.clear(input);
    expect(confirm().disabled).toBe(true);

    // Free-form but safe → allowed.
    await user.type(input, 'My Livery 01');
    await waitFor(() => expect(confirm().disabled).toBe(false));
  });

  it('shows mapped error toast on BAD_AIRLINE', async () => {
    setupMocks({ 'create-livery': Promise.resolve({ success: false, error: 'BAD_AIRLINE' }) });
    const user = userEvent.setup();
    renderCreate();

    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save As');

    await waitFor(() => {
      expect(screen.getByText('Airline code must be 3 uppercase letters.')).toBeInTheDocument();
    });
  });

  it('load from zip primes the canvas + form and installs via save-as', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Import livery' }));
    await waitFor(() => {
      // Inline hint + success toast share the same string.
      expect(screen.getAllByText('Loaded B738_AAL').length).toBeGreaterThanOrEqual(1);
    });
    // Airline/aircraft prefilled from the zip.
    expect(screen.getByPlaceholderText('CCA').value).toBe('AAL');
    expect(document.querySelector('.lp-root select').value).toBe('BOEING 737-800');
    // Install reuses create-livery via Save As (naming dialog prefilled).
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    const zipInput = await screen.findByLabelText('Folder name');
    expect(zipInput.value).toBe('B738_AAL');
    await confirmNameDialog(user, 'Save As');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', {
        imageDataUrl: FAKE_PNG,
        airline: 'AAL',
        targetPlaneId: 'BOEING 737-800',
        folder: 'B738_AAL',
      });
    });
  });

  it('import image loads the file into the canvas base', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();

    vi.mocked(fileToDataUrl).mockResolvedValue('data:image/png;base64,RAW');
    const file = new File(['x'], 'paint.png', { type: 'image/png' });
    const input = document.querySelector('.lp-root input[type="file"]');
    await user.upload(input, file);
    await waitFor(() => expect(vi.mocked(normalizeToTexture)).toHaveBeenCalled());
  });

  it('cancel returns to the list via onCancel', async () => {
    setupMocks();
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderCreate({ onCancel });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('CreateTab edit origins (mine vs reference)', () => {
  it('mine origin primes the form and Save overwrites the origin folder', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }) });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    expect(screen.getByPlaceholderText('CCA').value).toBe('CCA');
    const btn = saveBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    // Save naming dialog is prefilled with the origin folder.
    const saveInput = await screen.findByLabelText('Folder name');
    expect(saveInput.value).toBe('A20N_CCA');
    await confirmNameDialog(user, 'Save');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
        airline: 'CCA',
        targetPlaneId: 'AIRBUS A-320neo',
        folder: 'A20N_CCA',
      }));
    });
    expect(onCreated).toHaveBeenCalled();
  });

  it('mine origin with a free-form folder still Saves with the origin parts', async () => {
    CreateTab.prefill = {
      folder: 'My Custom Livery', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'My Custom Livery' }) });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    // Aircraft resolves from the manifest plane id, not the folder text.
    expect(document.querySelector('.lp-root select').value).toBe('AIRBUS A-320neo');
    const btn = saveBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    // Dialog prefilled with the free-form origin folder — confirm enabled.
    const saveInput = await screen.findByLabelText('Folder name');
    expect(saveInput.value).toBe('My Custom Livery');
    await confirmNameDialog(user, 'Save');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
        airline: 'CCA',
        targetPlaneId: 'AIRBUS A-320neo',
        folder: 'My Custom Livery',
      }));
    });
    expect(onCreated).toHaveBeenCalled();
  });

  it('reference (locked) origin disables Save but allows Save As', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CES', airline: 'CES', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'reference', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'A20N_CES' }) });
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });

    expect(screen.getByPlaceholderText('CCA').value).toBe('CES');
    // Locked notice.
    expect(document.querySelector('.lp-lock')).toBeInTheDocument();
    // Save blocked, Save As open (form primed from the reference).
    expect(saveBtn().disabled).toBe(true);
    const asBtn = saveAsBtn();
    await waitFor(() => expect(asBtn.disabled).toBe(false));
    await user.click(asBtn);
    await confirmNameDialog(user, 'Save As');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
        airline: 'CES',
        targetPlaneId: 'AIRBUS A-320neo',
        folder: 'A20N_CES',
      }));
    });
  });
});

describe('CreateTab export + load ZIP flows', () => {
  it('export saves the canvas then writes a ZIP to the chosen directory', async () => {
    setupMocks({
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
      'export-livery-to-dir': Promise.resolve({ success: true, filePath: '/dl/A20N_CCA.zip' }),
    });
    mockIpcInvoke.mockClear();
    const user = userEvent.setup();
    renderCreate();
    await fillForm(user);

    const exportBtn = screen.getByRole('button', { name: 'Export livery' });
    await waitFor(() => expect(exportBtn.disabled).toBe(false));
    await user.click(exportBtn);

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith(
      'create-livery',
      expect.objectContaining({ airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', folder: 'A20N_CCA' }),
    ));
    expect(mockIpcInvoke).toHaveBeenCalledWith('export-livery-to-dir', 'A20N_CCA');
    await waitFor(() => {
      expect(screen.getByText('Livery exported: A20N_CCA.zip')).toBeInTheDocument();
    });
  });

  it('export failure toasts the mapped error', async () => {
    setupMocks({
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
      'export-livery-to-dir': Promise.resolve({ success: false, error: 'ZIP_MISSING' }),
    });
    const user = userEvent.setup();
    renderCreate();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Export livery' }));
    await waitFor(() => {
      expect(screen.getByText('livery_err_ZIP_MISSING')).toBeInTheDocument();
    });
  });

  it('a cancelled export directory picker stays silent', async () => {
    setupMocks({
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
      'export-livery-to-dir': Promise.resolve({ canceled: true }),
    });
    const user = userEvent.setup();
    renderCreate();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Export livery' }));
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('export-livery-to-dir', 'A20N_CCA');
    });
    expect(screen.queryByText(/Livery exported/)).toBeNull();
  });

  it('load-from-ZIP failure toasts and cancel is silent', async () => {
    setupMocks({ 'load-livery-zip': Promise.resolve({ canceled: false, success: false, error: 'BAD_MANIFEST' }) });
    const user = userEvent.setup();
    renderCreate();
    await user.click(screen.getByRole('button', { name: 'Import livery' }));
    await waitFor(() => {
      expect(screen.getByText('Corrupt livery manifest.')).toBeInTheDocument();
    });
    // Cancelled picker: no toast, no state change.
    setupMocks({ 'load-livery-zip': Promise.resolve({ canceled: true }) });
    await user.click(screen.getByRole('button', { name: 'Import livery' }));
    await new Promise(r => setTimeout(r, 30));
    expect(screen.queryByText(/Loaded/)).toBeNull();
  });
});

describe('CreateTab unsaved-changes guard', () => {
  function dirtyCanvas() {
    const cv = document.querySelector('.livery-canvas-wrap canvas');
    fireEvent.pointerDown(cv, { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 50, clientY: 50, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
  }

  it('importing over a dirty canvas prompts, then loads on Discard', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();
    dirtyCanvas();

    vi.mocked(fileToDataUrl).mockResolvedValue('data:image/png;base64,RAW');
    const file = new File(['x'], 'paint.png', { type: 'image/png' });
    await user.upload(document.querySelector('.lp-root input[type="file"]'), file);

    await waitFor(() => expect(screen.getByText('Unsaved Changes')).toBeInTheDocument());
    expect(vi.mocked(fileToDataUrl)).not.toHaveBeenCalled();
    await user.click(screen.getByText('Discard').closest('button'));
    await waitFor(() => expect(vi.mocked(fileToDataUrl)).toHaveBeenCalled());
  });

  it('Cancel on a dirty canvas prompts, then discards', async () => {
    setupMocks();
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderCreate({ onCancel });
    dirtyCanvas();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByText('Unsaved Changes')).toBeInTheDocument());
    await user.click(screen.getByText('Discard').closest('button'));
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it('Cancel with a clean canvas returns immediately', async () => {
    setupMocks();
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderCreate({ onCancel });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(onCancel).toHaveBeenCalled();
    expect(screen.queryByText('Unsaved Changes')).toBeNull();
  });
});

describe('CreateTab lazy origin + chrome', () => {
  it('lazy-loads the origin picture when the prefill has no thumbnail', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', pack: 'mine',
      // no imageDataUrl - clicked before the thumbnail finished loading
    };
    setupMocks({ 'read-livery-image': Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,LATE' }) });
    renderCreate();
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('read-livery-image', 'A20N_CCA', 'mine');
    });
  });

  it('help button invokes onHelp', async () => {
    setupMocks();
    const onHelp = vi.fn();
    const user = userEvent.setup();
    renderCreate({ onHelp });
    // Top-left group: [Back, Help] (help is the icon-only second button).
    const helpBtn = document.querySelectorAll('.lp-topbar .lp-group')[0].querySelectorAll('button')[1];
    await user.click(helpBtn);
    expect(onHelp).toHaveBeenCalled();
  });

  it('airline combobox lists every airline and selects on click', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();
    const input = screen.getByPlaceholderText('CCA');
    await user.click(input);
    const list = document.querySelector('#livery-airline-list');
    expect(list).toBeInTheDocument();
    const ual = [...list.querySelectorAll('.lp-airline-option')].find(o => o.textContent.includes('UAL'));
    await user.click(ual);
    expect(screen.getByPlaceholderText('CCA').value).toBe('UAL');
    expect(document.querySelector('#livery-airline-list')).toBeNull();
  });

  it('Escape closes the airline combobox', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();
    await user.click(screen.getByPlaceholderText('CCA'));
    expect(document.querySelector('#livery-airline-list')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('#livery-airline-list')).toBeNull());
  });

  it('a failed import-image normalization toasts the error', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();
    vi.mocked(fileToDataUrl).mockResolvedValue('data:image/png;base64,RAW');
    vi.mocked(normalizeToTexture).mockRejectedValue(new Error('BAD_IMAGE'));
    const file = new File(['x'], 'bad.png', { type: 'image/png' });
    await user.upload(document.querySelector('.lp-root input[type="file"]'), file);
    await waitFor(() => expect(screen.getByText(/Invalid image/)).toBeInTheDocument());
  });
});
