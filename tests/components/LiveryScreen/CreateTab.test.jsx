import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateTab from '../../../src/components/LiveryScreen/CreateTab';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';
import { fileToDataUrl, normalizeToTexture } from '../../../src/utils/liveryImage';
import { CURATED_AIRLINE_CODES } from '../../../src/utils/constants/airlines';

const DEFAULT_AIRLINE = CURATED_AIRLINE_CODES[0];

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
    fill: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), arc: vi.fn(), clip: vi.fn(),
    strokeRect: vi.fn(), setLineDash: vi.fn(),
    fillText: vi.fn(), putImageData: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(),
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
  const input = screen.getByPlaceholderText('CCA');
  await user.clear(input);
  await user.type(input, airline);
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
  it('defaults to the first airline + A-319neo (valid out of the box)', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();

    // Defaults: first airline code + A-319neo, no blank/placeholder option.
    const airlineInput = screen.getByPlaceholderText('CCA');
    expect(airlineInput.value).toBe(DEFAULT_AIRLINE);
    const select = document.querySelector('.lp-root select');
    expect(select.value).toBe('AIRBUS A-319neo');
    expect([...select.options].some(o => o.value === '')).toBe(false);

    // The form is immediately valid.
    await waitFor(() => expect(saveAsBtn().disabled).toBe(false));
    expect(saveBtn().disabled).toBe(false);

    // Editing the code still validates + uppercases; full list stays available.
    await user.clear(airlineInput);
    await user.type(airlineInput, 'cca');
    expect(airlineInput.value).toBe('CCA');
    expect(screen.getAllByText('Air China').length).toBeGreaterThanOrEqual(1);
    const dropdownOptions = document.querySelectorAll('#livery-airline-list .lp-airline-option');
    expect(dropdownOptions.length).toBeGreaterThan(10);
    const codes = [...dropdownOptions].map(o => o.textContent);
    expect(codes.some(t => t.includes('CCA'))).toBe(true);
    expect(codes.some(t => t.includes('UAL'))).toBe(true);
    expect(codes.some(t => t.includes('CES'))).toBe(true);
  });

  it('compiles the aircraft list from the scanned built-in liveries', async () => {
    setupMocks({
      'list-aircraft-types': Promise.resolve({
        success: true,
        types: [
          { planeId: 'BOMBARDIER CRJ700', shortCode: 'CRJ7' },
          { planeId: 'AIRBUS A-320neo', shortCode: 'A20N' },
        ],
      }),
    });
    const user = userEvent.setup();
    renderCreate();

    const select = document.querySelector('.lp-root select');
    await waitFor(() => expect([...select.options].some(o => o.value === 'BOMBARDIER CRJ700')).toBe(true));
    // The current value is kept even when the scan does not include it.
    expect([...select.options].some(o => o.value === 'AIRBUS A-319neo')).toBe(true);

    await user.selectOptions(select, 'BOMBARDIER CRJ700');
    expect(select.value).toBe('BOMBARDIER CRJ700');
    // A scanned type that is not in the table is still form-valid; the Save As
    // prefill uses the table short code for it.
    await waitFor(() => expect(saveAsBtn().disabled).toBe(false));
    await user.click(saveAsBtn());
    const input = await screen.findByLabelText('Folder name');
    expect(input.value).toBe(`CRJ7_${DEFAULT_AIRLINE}`);
  });

  it('pre-selects an explicitly requested aircraft type for a new livery', async () => {
    // The list's add-card passes { targetPlaneId } with no folder. Even when
    // the built-in scan is unavailable (list-aircraft-types returns nothing),
    // the requested type is kept and the form is valid.
    CreateTab.prefill = { targetPlaneId: 'AIRBUS A-220-300' };
    setupMocks();
    const user = userEvent.setup();
    renderCreate();

    const select = document.querySelector('.lp-root select');
    await waitFor(() => expect(select.value).toBe('AIRBUS A-220-300'));
    await waitFor(() => expect(saveAsBtn().disabled).toBe(false));

    await user.click(saveAsBtn());
    const input = await screen.findByLabelText('Folder name');
    // Unknown to the table, so folderFor falls back to the raw plane id.
    expect(input.value).toBe(`AIRBUS A-220-300_${DEFAULT_AIRLINE}`);
  });

  it('rejects short airline codes', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();
    const airlineInput = screen.getByPlaceholderText('CCA');
    await user.clear(airlineInput);
    await user.type(airlineInput, 'CC');
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
      { images: expect.any(Array), airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', folder: 'A20N_CCA' },
    ));
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
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
      { images: expect.any(Array), airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', folder: 'My First CCA Livery' },
    ));
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
  });

  it('H/V shortcuts keep the active panel (no reset on flip)', async () => {
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 512, height: 512, right: 512, bottom: 512, x: 0, y: 0, toJSON() {},
    });
    try {
      setupMocks({ 'get-aircraft-template': Promise.resolve({ success: true, parts: [{ partName: 'Fuselage' }, { partName: 'Wing' }] }) });
      renderCreate();
      const stage = () => document.querySelector('.lp-canvas-stage');
      await waitFor(() => expect(document.querySelector('.livery-canvas-wrap canvas').width).toBe(4224));
      await waitFor(() => expect(stage().dataset.activePanel).toBe('0'));
      // Click panel 1 (texture centre x=3200 over the 512px stub rect). Events
      // go to the chrome canvas (the pointer interaction surface).
      const cv = document.querySelector('.livery-canvas-wrap canvas[data-layer="chrome"]');
      fireEvent.pointerDown(cv, { clientX: 3200 * (512 / 4224), clientY: 1024 * (512 / 2048), button: 0, pointerId: 1 });
      fireEvent.pointerUp(cv, { pointerId: 1 });
      await waitFor(() => expect(stage().dataset.activePanel).toBe('1'));
      fireEvent.keyDown(window, { key: 'h' });
      fireEvent.keyDown(window, { key: 'v' });
      expect(stage().dataset.activePanel).toBe('1');
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('Ctrl+S opens Save; Ctrl+Shift+S opens Save As', async () => {
    setupMocks();
    renderCreate();
    // Ctrl+S → the Save dialog (its confirm button is exactly "Save").
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await screen.findByLabelText('Folder name');
    const modal = document.querySelector('#modal-box');
    expect(within(modal).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    // Close it, then Ctrl+Shift+S → the Save As dialog.
    const user = userEvent.setup();
    await user.click(within(modal).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.querySelector('#modal-box')).toBeNull());
    fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true });
    await screen.findByLabelText('Folder name');
    const modal2 = document.querySelector('#modal-box');
    expect(within(modal2).getByRole('button', { name: 'Save As' })).toBeInTheDocument();
  });

  it('Ctrl+S is ignored while typing in a field or while a dialog is open', async () => {
    setupMocks();
    renderCreate();
    // Typing in the airline field: the shortcut must not hijack the key.
    const airlineInput = screen.getByPlaceholderText('CCA');
    fireEvent.keyDown(airlineInput, { key: 's', ctrlKey: true });
    expect(document.querySelector('#modal-box')).toBeNull();
    // With the Save dialog already open, Ctrl+Shift+S must not swap it for As.
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await screen.findByLabelText('Folder name');
    const modal = document.querySelector('#modal-box');
    expect(within(modal).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true });
    const still = document.querySelector('#modal-box');
    expect(within(still).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(within(still).queryByRole('button', { name: 'Save As' })).toBeNull();
  });

  it('Save As adopts the saved folder so a later Save overwrites it in place', async () => {
    setupMocks({
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
      'list-liveries': Promise.resolve({ success: true, mine: [], reference: [] }),
    });
    const user = userEvent.setup();
    renderCreate();
    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save As');
    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith(
      'create-livery',
      expect.objectContaining({ folder: 'A20N_CCA' }),
    ));
    // The painter stayed open and adopted the saved folder as its origin.
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
    expect(CreateTab.prefill).toMatchObject({
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', pack: 'mine',
    });

    // A following Save rewrites that same folder in place (no overwrite prompt).
    mockIpcInvoke.mockClear();
    const save = saveBtn();
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);
    const input = await screen.findByLabelText('Folder name');
    expect(input.value).toBe('A20N_CCA');
    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith(
      'create-livery',
      expect.objectContaining({ folder: 'A20N_CCA' }),
    ));
    expect(screen.queryByText('Overwrite Existing Livery')).toBeNull();
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
        images: expect.any(Array),
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

  it('open folder reveals the origin folder, or the own pack for a new livery', async () => {
    setupMocks({ 'reveal-livery-folder': Promise.resolve({ success: true, path: 'X' }) });
    const user = userEvent.setup();
    const first = renderCreate();
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('reveal-livery-folder', null, 'mine'));
    first.unmount();

    // A saved origin reveals its own folder + pack (workshop/reference/mine).
    CreateTab.prefill = { folder: '3328490/111/A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', pack: 'workshop' };
    mockIpcInvoke.mockClear();
    setupMocks({ 'reveal-livery-folder': Promise.resolve({ success: true, path: 'X' }) });
    renderCreate();
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('reveal-livery-folder', '3328490/111/A20N_CCA', 'workshop'));
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

describe('CreateTab aircraft template', () => {
  it('primes a new canvas with the selected type built-in UV template', async () => {
    mockIpcInvoke.mockClear();
    setupMocks({
      'get-aircraft-template': Promise.resolve({ success: true, imageDataUrl: FAKE_PNG, partName: 'Body' }),
    });
    const user = userEvent.setup();
    renderCreate();
    // The default type (A-319neo) loads its template right away.
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('get-aircraft-template', 'AIRBUS A-319neo');
    });
    await user.selectOptions(document.querySelector('.lp-root select'), 'AIRBUS A-320neo');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('get-aircraft-template', 'AIRBUS A-320neo');
    });
  });

  it('fetches the type template for a saved livery so Clear can restore it (base stays the origin image)', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    mockIpcInvoke.mockClear();
    setupMocks({
      'get-aircraft-template': Promise.resolve({ success: true, imageDataUrl: FAKE_PNG }),
    });
    renderCreate();
    await waitFor(() => expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument());
    // Template is fetched for the origin's aircraft type (used by Clear), but
    // the canvas base is still the saved livery image.
    expect(mockIpcInvoke).toHaveBeenCalledWith('get-aircraft-template', 'AIRBUS A-320neo');
  });

  it('lays out both panels for a multi-image type and saves both', async () => {
    const TWO_PARTS = [
      { partName: 'Fuselage', imageDataUrl: FAKE_PNG },
      { partName: 'Wing', imageDataUrl: FAKE_PNG },
    ];
    setupMocks({
      'get-aircraft-template': Promise.resolve({ success: true, parts: TWO_PARTS }),
      'create-livery': Promise.resolve({ success: true, folder: 'A388_CCA' }),
    });
    const user = userEvent.setup();
    renderCreate();
    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('get-aircraft-template', 'AIRBUS A-319neo'));

    // Switching to the A380 (multi-image built-in) makes the canvas a
    // 2-panel store (2×2048 + 128 gutter) — there is no tab strip anymore.
    await user.selectOptions(document.querySelector('.lp-root select'), 'AIRBUS A-380-800');
    await waitFor(() => {
      expect(document.querySelector('.livery-canvas-wrap canvas').width).toBe(4224);
    });

    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    const input = await screen.findByLabelText('Folder name');
    // Default airline (first alphabetically) + the A380 short code.
    expect(input.value).toBe(`A388_${DEFAULT_AIRLINE}`);
    await confirmNameDialog(user, 'Save As');

    await waitFor(() => {
      const call = mockIpcInvoke.mock.calls.find(c => c[0] === 'create-livery');
      expect(call).toBeTruthy();
      expect(call[1].images).toHaveLength(2);
      expect(call[1].images.map(i => i.partName)).toEqual(['Fuselage', 'Wing']);
    });
  });
});

describe('CreateTab airline/aircraft dropdowns just close', () => {
  beforeEach(() => { mockIpcInvoke.mockClear(); });

  function dirtyCanvas() {
    const cv = document.querySelector('.livery-canvas-wrap canvas[data-layer="chrome"]');
    fireEvent.pointerDown(cv, { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 50, clientY: 50, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
  }

  async function settleInitialTemplate() {
    setupMocks({
      'get-aircraft-template': Promise.resolve({ success: true, imageDataUrl: FAKE_PNG }),
    });
    renderCreate();
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('get-aircraft-template', 'AIRBUS A-319neo');
    });
    // Let the initial priming remount settle before capturing the canvas node.
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  }

  it('changing the aircraft type on an untouched canvas re-primes the template', async () => {
    await settleInitialTemplate();
    const user = userEvent.setup();
    const wrapBefore = document.querySelector('.livery-canvas-wrap');
    await user.selectOptions(document.querySelector('.lp-root select'), 'AIRBUS A-320neo');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('get-aircraft-template', 'AIRBUS A-320neo');
    });
    await waitFor(() => {
      expect(document.querySelector('.livery-canvas-wrap')).not.toBe(wrapBefore);
    });
  });

  it('changing the aircraft type after painting does not reset the canvas', async () => {
    await settleInitialTemplate();
    const user = userEvent.setup();
    const wrapBefore = document.querySelector('.livery-canvas-wrap');
    dirtyCanvas();
    await user.selectOptions(document.querySelector('.lp-root select'), 'AIRBUS A-320neo');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('get-aircraft-template', 'AIRBUS A-320neo');
    });
    // No remount: the painted canvas survives the type pick.
    expect(document.querySelector('.livery-canvas-wrap')).toBe(wrapBefore);
  });

  it('selecting an airline never remounts the canvas', async () => {
    await settleInitialTemplate();
    const user = userEvent.setup();
    const wrapBefore = document.querySelector('.livery-canvas-wrap');
    await user.click(screen.getByPlaceholderText('CCA'));
    const list = document.querySelector('#livery-airline-list');
    const ual = [...list.querySelectorAll('.lp-airline-option')].find(o => o.textContent.includes('UAL'));
    await user.click(ual);
    expect(screen.getByPlaceholderText('CCA').value).toBe('UAL');
    expect(document.querySelector('#livery-airline-list')).toBeNull();
    expect(document.querySelector('.livery-canvas-wrap')).toBe(wrapBefore);
  });

  it('a painted canvas still prompts on Back after picking a type', async () => {
    await settleInitialTemplate();
    const user = userEvent.setup();
    dirtyCanvas();
    await user.selectOptions(document.querySelector('.lp-root select'), 'AIRBUS A-320neo');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Unsaved Changes')).toBeInTheDocument();
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
    // Own liveries keep the airline/aircraft fields editable.
    expect(screen.getByPlaceholderText('CCA').disabled).toBe(false);
    expect(document.querySelector('.lp-root select').disabled).toBe(false);
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
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
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
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
  });

  it('changing airline + aircraft updates the Save default name and the manifest', async () => {
    // Once saved, the form's Airline/Aircraft are the livery's identity — a
    // change must re-derive the default name (and the manifest's airline/
    // targetPlaneId/name), not stay pinned to the stale origin folder.
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'B738_AAL' }) });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await fillForm(user, 'AAL', 'BOEING 737-800');
    const btn = saveBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    // Default name follows the live form, not the origin folder.
    const saveInput = await screen.findByLabelText('Folder name');
    expect(saveInput.value).toBe('B738_AAL');
    await confirmNameDialog(user, 'Save');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
        airline: 'AAL',
        targetPlaneId: 'BOEING 737-800',
        folder: 'B738_AAL',
      }));
    });
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
  });

  it('changing only the airline re-derives the default name from the form', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'A20N_AAL' }) });
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });

    await fillForm(user, 'AAL', 'AIRBUS A-320neo');
    const btn = saveBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    const saveInput = await screen.findByLabelText('Folder name');
    expect(saveInput.value).toBe('A20N_AAL');
    await confirmNameDialog(user, 'Save');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
        airline: 'AAL', targetPlaneId: 'AIRBUS A-320neo', folder: 'A20N_AAL',
      }));
    });
  });

  it('changing only the aircraft re-derives the default name from the form', async () => {
    // Symmetric to the airline-only case: the OR in the Save prefill covers
    // either half of the identity changing.
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'B738_CCA' }) });
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });

    await fillForm(user, 'CCA', 'BOEING 737-800');
    const btn = saveBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    const saveInput = await screen.findByLabelText('Folder name');
    expect(saveInput.value).toBe('B738_CCA');
    await confirmNameDialog(user, 'Save');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
        airline: 'CCA', targetPlaneId: 'BOEING 737-800', folder: 'B738_CCA',
      }));
    });
  });

  it('changing airline/aircraft then keeping the origin folder updates the manifest in place', async () => {
    // The user decides the final name: typing the origin folder back rewrites
    // that same livery with the new airline/type instead of creating a new one.
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }) });
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });

    await fillForm(user, 'AAL', 'BOEING 737-800');
    const btn = saveBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    const saveInput = await screen.findByLabelText('Folder name');
    expect(saveInput.value).toBe('B738_AAL');
    await user.clear(saveInput);
    await user.type(saveInput, 'A20N_CCA');
    await confirmNameDialog(user, 'Save');
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
        airline: 'AAL', targetPlaneId: 'BOEING 737-800', folder: 'A20N_CCA',
      }));
    });
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
    // Airline + aircraft are greyed out / display-only for a locked reference.
    expect(screen.getByPlaceholderText('CCA').disabled).toBe(true);
    expect(document.querySelector('.lp-root select').disabled).toBe(true);
    expect(document.querySelector('.lp-airline-toggle').disabled).toBe(true);
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

describe('CreateTab overwrite confirm (Save As onto an existing folder)', () => {
  // mockIpcInvoke keeps its call history across tests; scope it here so the
  // "nothing written yet" assertions stay meaningful.
  beforeEach(() => { mockIpcInvoke.mockClear(); });

  const mineList = (folders) => Promise.resolve({
    success: true,
    mine: folders.map(folder => ({ folder, id: '', name: '', airline: '', targetPlaneId: '', hasBasePng: true, mtime: 0 })),
    reference: [],
  });

  it('asks before overwriting a same-named folder, then saves on Overwrite', async () => {
    setupMocks({
      'list-liveries': mineList(['A20N_CCA']),
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
    });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save As');

    // Collision → confirm first, nothing written yet.
    expect(await screen.findByText('Overwrite Existing Livery')).toBeInTheDocument();
    expect(screen.getByText(/A livery named A20N_CCA already exists/)).toBeInTheDocument();
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('create-livery', expect.anything());

    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith(
      'create-livery',
      { images: expect.any(Array), airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', folder: 'A20N_CCA' },
    ));
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
  });

  it('cancel on the overwrite pop-up aborts the save', async () => {
    setupMocks({
      'list-liveries': mineList(['A20N_CCA']),
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
    });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save As');

    const modal = await waitFor(() => {
      const box = document.querySelector('#modal-box');
      expect(box).toBeInTheDocument();
      return box;
    });
    await user.click(within(modal).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Overwrite Existing Livery')).toBeNull());
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('create-livery', expect.anything());
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByText('Livery created')).toBeNull();
  });

  it('Save As still asks when the prefilled name equals the origin folder', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({
      'list-liveries': mineList(['A20N_CCA']),
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
    });
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });

    const asBtn = saveAsBtn();
    await waitFor(() => expect(asBtn.disabled).toBe(false));
    await user.click(asBtn);
    // Prefill is the conventional form folder — same as the origin here.
    const input = await screen.findByLabelText('Folder name');
    expect(input.value).toBe('A20N_CCA');
    await confirmNameDialog(user, 'Save As');

    expect(await screen.findByText('Overwrite Existing Livery')).toBeInTheDocument();
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('create-livery', expect.anything());
    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
      folder: 'A20N_CCA',
    })));
  });

  it('matches the folder name case-insensitively (Windows paths)', async () => {
    setupMocks({
      'list-liveries': mineList(['A20N_CCA']),
      'create-livery': Promise.resolve({ success: true, folder: 'a20n_cca' }),
    });
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });

    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    const input = await screen.findByLabelText('Folder name');
    await user.clear(input);
    await user.type(input, 'a20n_cca');
    await confirmNameDialog(user, 'Save As');

    expect(await screen.findByText('Overwrite Existing Livery')).toBeInTheDocument();
  });

  it('a fresh name skips the pop-up', async () => {
    setupMocks({
      'list-liveries': mineList(['SOMETHING_ELSE']),
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
    });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save As');

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.anything()));
    expect(screen.queryByText('Overwrite Existing Livery')).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
  });

  it('Save re-writing the current livery’s own folder is exempt', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({
      'list-liveries': mineList(['A20N_CCA']),
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
    });
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });

    const btn = saveBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save');

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
      folder: 'A20N_CCA',
    })));
    expect(screen.queryByText('Overwrite Existing Livery')).toBeNull();
  });

  it('an unreadable livery list falls through to the save', async () => {
    const rejected = Promise.reject(new Error('boom'));
    rejected.catch(() => {}); // mark handled — the component swallows it
    setupMocks({
      'list-liveries': rejected,
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
    });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save As');

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.anything()));
    expect(screen.queryByText('Overwrite Existing Livery')).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
  });

  it('a failed list result falls through to the save', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: false, error: 'NO_GAME_ROOT' }),
      'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }),
    });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save As');

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.anything()));
    expect(screen.queryByText('Overwrite Existing Livery')).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
  });
});

describe('CreateTab post-save mod hint', () => {
  beforeEach(() => { mockIpcInvoke.mockClear(); });

  const saveSuccess = { 'create-livery': Promise.resolve({ success: true, folder: 'A20N_CCA' }) };

  // Save As a fresh livery and wait for the success path to settle.
  async function saveAs(user) {
    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save As');
    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.anything()));
  }

  it('prompts to enable the mod in game after a successful save', async () => {
    setupMocks(saveSuccess);
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });
    await saveAs(user);

    expect(await screen.findByText('Enable the Mod in Game')).toBeInTheDocument();
    expect(screen.getByText(/More Liveries/)).toBeInTheDocument();
    expect(screen.getByText(/Refresh list/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: "Don't show again" })).not.toBeChecked();
    expect(mockIpcInvoke).toHaveBeenCalledWith('get-cache-flag', 'liveryModHintDismissed');
  });

  it('OK without ticking closes the prompt and writes no flag', async () => {
    setupMocks(saveSuccess);
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });
    await saveAs(user);

    await screen.findByText('Enable the Mod in Game');
    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(screen.queryByText('Enable the Mod in Game')).toBeNull());
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('set-cache-flag', expect.anything(), expect.anything());
  });

  it('"Don\'t show again" persists the cache flag on OK', async () => {
    setupMocks(saveSuccess);
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });
    await saveAs(user);

    await user.click(await screen.findByRole('checkbox', { name: "Don't show again" }));
    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith(
      'set-cache-flag', 'liveryModHintDismissed', true,
    ));
  });

  it('stays hidden once the dismissed flag is set', async () => {
    setupMocks({ ...saveSuccess, 'get-cache-flag': Promise.resolve({ success: true, value: true }) });
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });
    await saveAs(user);

    expect(mockIpcInvoke).toHaveBeenCalledWith('get-cache-flag', 'liveryModHintDismissed');
    expect(screen.queryByText('Enable the Mod in Game')).toBeNull();
  });

  it('shows the hint when the dismissed-flag read fails', async () => {
    const rejected = Promise.reject(new Error('boom'));
    rejected.catch(() => {}); // mark handled — the component swallows it
    setupMocks({ ...saveSuccess, 'get-cache-flag': rejected });
    const user = userEvent.setup();
    renderCreate({ onCreated: vi.fn() });
    await saveAs(user);

    expect(await screen.findByText('Enable the Mod in Game')).toBeInTheDocument();
  });

  it('a failed save never reads the flag or shows the hint', async () => {
    setupMocks({ 'create-livery': Promise.resolve({ success: false, error: 'BAD_FOLDER' }) });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await fillForm(user);
    const btn = saveAsBtn();
    await waitFor(() => expect(btn.disabled).toBe(false));
    await user.click(btn);
    await confirmNameDialog(user, 'Save As');

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.anything()));
    expect(screen.queryByText('Enable the Mod in Game')).toBeNull();
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('get-cache-flag', expect.anything());
    expect(onCreated).not.toHaveBeenCalled();
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
    const cv = document.querySelector('.livery-canvas-wrap canvas[data-layer="chrome"]');
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

describe('CreateTab delete (true folder delete)', () => {
  beforeEach(() => { mockIpcInvoke.mockClear(); });

  function deleteBtn() {
    return screen.getByRole('button', { name: 'Delete' });
  }

  it('is disabled for a brand-new unsaved livery (no folder yet)', async () => {
    setupMocks();
    renderCreate();
    expect(deleteBtn().disabled).toBe(true);
  });

  it('is disabled for a read-only reference origin', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CES', airline: 'CES', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'reference', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks();
    renderCreate();
    expect(deleteBtn().disabled).toBe(true);
  });

  it('deletes the origin folder after confirm and returns to the list', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'delete-livery': Promise.resolve({ success: true }) });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await user.click(deleteBtn());
    expect(await screen.findByText('Confirm Delete')).toBeInTheDocument();
    expect(screen.getByText('Delete livery A20N_CCA?')).toBeInTheDocument();
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('delete-livery', expect.anything());

    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockIpcInvoke).toHaveBeenCalledWith('delete-livery', 'A20N_CCA'));
    expect(onCreated).toHaveBeenCalled();
  });

  it('cancel on the delete pop-up keeps the livery', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'delete-livery': Promise.resolve({ success: true }) });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await user.click(deleteBtn());
    await screen.findByText('Confirm Delete');
    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Confirm Delete')).toBeNull());
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('delete-livery', expect.anything());
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('toasts the mapped error when delete fails', async () => {
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      pack: 'mine', imageDataUrl: 'data:image/png;base64,BASE',
    };
    setupMocks({ 'delete-livery': Promise.resolve({ success: false, error: 'BAD_FOLDER' }) });
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderCreate({ onCreated });

    await user.click(deleteBtn());
    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByText('Invalid folder name.')).toBeInTheDocument());
    expect(onCreated).not.toHaveBeenCalled();
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

  it('lazy-loads every origin panel through read-livery-images', async () => {
    CreateTab.prefill = {
      folder: 'A388_SIA', airline: 'SIA', targetPlaneId: 'AIRBUS A-380-800', pack: 'mine',
      // no imageDataUrl - clicked before the thumbnail finished loading
    };
    setupMocks({
      'read-livery-images': Promise.resolve({ success: true, parts: [
        { partName: 'Fuselage', imageDataUrl: 'data:image/png;base64,FUSE' },
        { partName: 'Wing', imageDataUrl: 'data:image/png;base64,WING' },
      ] }),
    });
    renderCreate();
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('read-livery-images', 'A388_SIA', 'mine');
    });
    // The per-panel channel wins; the single-image fallback is not needed.
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('read-livery-image', 'A388_SIA', 'mine');
    // Both parts render as one wide 2-panel store (no tab strip).
    await waitFor(() => {
      expect(document.querySelector('.livery-canvas-wrap canvas').width).toBe(4224);
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

  it('keeps the airline list closed after a pick (not wrapped in a <label>)', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderCreate();
    const input = screen.getByPlaceholderText('CCA');
    // A <button> inside a <label> makes Chromium refocus the labelled input,
    // which re-fires onFocus and reopened the list right after a pick.
    expect(input.closest('label')).toBeNull();
    await user.click(input);
    const ual = [...document.querySelectorAll('.lp-airline-option')].find(o => o.textContent.includes('UAL'));
    await user.click(ual);
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

describe('CreateTab workshop upload button', () => {
  function uploadBtn() {
    return screen.getByRole('button', { name: 'Upload' });
  }

  it('is disabled for a brand-new unsaved livery', async () => {
    setupMocks();
    renderCreate({ onUpload: vi.fn() });
    await waitFor(() => expect(saveAsBtn().disabled).toBe(false));
    expect(uploadBtn().disabled).toBe(true);
  });

  it('is disabled for read-only reference/workshop origins', async () => {
    for (const pack of ['reference', 'workshop']) {
      CreateTab.prefill = { folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', pack };
      setupMocks();
      const { unmount } = renderCreate({ onUpload: vi.fn() });
      await waitFor(() => expect(uploadBtn().disabled).toBe(true));
      unmount();
      CreateTab.prefill = null;
    }
  });

  it('opens the upload dialog for a clean saved mine livery without re-saving', async () => {
    CreateTab.prefill = { folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', pack: 'mine' };
    setupMocks();
    const onUpload = vi.fn();
    const user = userEvent.setup();
    renderCreate({ onUpload });
    await waitFor(() => expect(uploadBtn().disabled).toBe(false));
    await user.click(uploadBtn());
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload).toHaveBeenCalledWith('A20N_CCA');
    // Untouched canvas: no silent save before the dialog.
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('create-livery', expect.anything());
  });

  it('grayed-out upload button tooltip appends Save first; enabled does not', async () => {
    setupMocks();
    renderCreate({ onUpload: vi.fn() });
    const uploadWrap = screen.getByRole('button', { name: 'Upload' }).closest('.lp-tipwrap');
    // Brand-new livery: grayed out, hover explains why.
    await waitFor(() => expect(uploadBtn().disabled).toBe(true));
    fireEvent.mouseEnter(uploadWrap);
    expect(document.body.querySelector('.tooltip-popup').textContent)
      .toBe('Upload to the Steam Workshop. Save first.');
    fireEvent.mouseLeave(uploadWrap);
    expect(document.body.querySelector('.tooltip-popup')).toBeNull();
  });

  it('saved mine livery upload tooltip has no Save-first suffix', async () => {
    CreateTab.prefill = { folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', pack: 'mine' };
    setupMocks();
    renderCreate({ onUpload: vi.fn() });
    const uploadWrap = screen.getByRole('button', { name: 'Upload' }).closest('.lp-tipwrap');
    await waitFor(() => expect(uploadBtn().disabled).toBe(false));
    fireEvent.mouseEnter(uploadWrap);
    expect(document.body.querySelector('.tooltip-popup').textContent)
      .toBe('Upload to the Steam Workshop.');
    fireEvent.mouseLeave(uploadWrap);
  });

  it('Ctrl+S is ignored while the workshop upload dialog overlays the painter', async () => {
    CreateTab.prefill = { folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo', pack: 'mine' };
    setupMocks();
    renderCreate({ onUpload: vi.fn() });
    await waitFor(() => expect(saveBtn().disabled).toBe(false));
    const overlay = document.createElement('div');
    overlay.id = 'livery-upload-overlay';
    document.body.appendChild(overlay);
    try {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      expect(screen.queryByLabelText('Folder name')).toBeNull();
    } finally {
      overlay.remove();
    }
    // Guard gone: the shortcut works again.
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(await screen.findByLabelText('Folder name')).toBeInTheDocument();
  });
});
