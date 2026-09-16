import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveryCanvas from '../../../src/components/LiveryScreen/LiveryCanvas';
import CreateTab from '../../../src/components/LiveryScreen/CreateTab';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

// ── Canvas stubs (jsdom has no 2d context) ───────────────────
let ctxs = [];
function makeCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
    fillRect: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fill: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), arc: vi.fn(),
    strokeRect: vi.fn(), setLineDash: vi.fn(),
    fillText: vi.fn(), putImageData: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(),
    getImageData: vi.fn((x, y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
      width: w, height: h,
    })),
  };
}

class MockImage {
  constructor() { this._src = ''; this.onload = null; this.onerror = null; }
  set src(v) {
    this._src = v;
    setTimeout(() => {
      this.naturalWidth = 100; this.naturalHeight = 50;
      this.width = 100; this.height = 50;
      if (this.onload) this.onload();
    }, 0);
  }
  get src() { return this._src; }
}

const FAKE_SAVE = 'data:image/png;base64,SAVE2048';

let getCtxSpy;
let toDataSpy;
let rectSpy;

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  CreateTab.prefill = null;
  ctxs = [];
  getCtxSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const c = makeCtx();
    ctxs.push(c);
    return c;
  });
  toDataSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(FAKE_SAVE);
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 512, height: 512, right: 512, bottom: 512, x: 0, y: 0, toJSON() {},
  });
  vi.stubGlobal('Image', MockImage);
  mockIpcInvoke.mockImplementation(() => Promise.resolve({}));
});

afterEach(() => {
  getCtxSpy.mockRestore();
  toDataSpy.mockRestore();
  rectSpy.mockRestore();
  vi.unstubAllGlobals();
});

function renderCanvas(props = {}) {
  return render(
    <I18nProvider>
      <LiveryCanvas {...props} />
      <Modal />
      <Toast />
    </I18nProvider>
  );
}

function mainCanvas() {
  return document.querySelector('.livery-canvas-wrap canvas');
}

describe('LiveryCanvas tools', () => {
  it('switches the active tool one at a time', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const brushBtn = screen.getByRole('button', { name: 'Brush' });
    expect(brushBtn.className).toContain('lp-active');
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    expect(screen.getByRole('button', { name: 'Eraser' }).className).toContain('lp-active');
    expect(brushBtn.className).not.toContain('lp-active');
    await user.click(screen.getByRole('button', { name: 'Text' }));
    expect(screen.getByRole('button', { name: 'Text' }).className).toContain('lp-active');
  });

  it('a brush stroke changes pixels (ctx.stroke called)', async () => {
    renderCanvas();
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const main = ctxs[0];
    expect(main.getImageData).toHaveBeenCalled(); // undo snapshot
    expect(main.stroke).toHaveBeenCalled();
    expect(main.lineTo).toHaveBeenCalled();
  });

  it('text commit flattens to raster (fillText called)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Text' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    const input = screen.getByPlaceholderText('Type text, Enter to commit…');
    await user.type(input, 'hello');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ctxs[0].fillText).toHaveBeenCalledWith('hello', expect.any(Number), expect.any(Number));
  });

  it('sticker import creates a live object flattened into the export', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    // The live sticker is drawn on the overlay.
    await waitFor(() => {
      const draws = ctxs.flatMap(c => c.drawImage.mock.calls);
      expect(draws.some(call => call.length === 5)).toBe(true);
    });
    // Export flattens it over a transparent background.
    act(() => { ref.current.exportPNG(); });
    const exportCtx = ctxs[ctxs.length - 1];
    expect(exportCtx.drawImage.mock.calls.some(call => call.length === 5)).toBe(true);
    expect(exportCtx.fillRect).not.toHaveBeenCalled();
  });
});

describe('options bar layout stability', () => {
  it('stays visible with fixed height for tools without options', async () => {
    const user = userEvent.setup();
    renderCanvas();
    // Brush (default): bar with controls.
    expect(document.querySelector('.lp-optionsbar')).toBeInTheDocument();
    // Select has no extra controls, but the bar must stay mounted so the
    // canvas viewport never shifts.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const bar = document.querySelector('.lp-optionsbar');
    expect(bar).toBeInTheDocument();
    expect(bar.textContent).toContain('Select');
    await user.click(screen.getByRole('button', { name: 'Picker' }));
    expect(document.querySelector('.lp-optionsbar')).toBeInTheDocument();
  });
});

describe('brush cursor ring', () => {
  it('shows a true-size ring for brush/eraser, none for select', async () => {
    const user = userEvent.setup();
    renderCanvas();
    // Default tool is brush: ring rendered, native cursor hidden.
    const ring = document.querySelector('.lp-cursor-ring');
    expect(ring).toBeInTheDocument();
    expect(mainCanvas().style.cursor).toBe('none');
    // Ring follows the pointer and hides on leave.
    const stage = document.querySelector('.lp-canvas-stage');
    fireEvent.pointerMove(stage, { clientX: 100, clientY: 120 });
    expect(ring.style.display).toBe('block');
    expect(ring.style.transform).toContain('translate(100px, 120px)');
    fireEvent.pointerLeave(stage);
    expect(ring.style.display).toBe('none');
    // Select tool: no ring.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(document.querySelector('.lp-cursor-ring')).not.toBeInTheDocument();
    // Eraser: ring again.
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    expect(document.querySelector('.lp-cursor-ring')).toBeInTheDocument();
  });

  it('ring diameter tracks brush size × zoom', async () => {
    renderCanvas();
    const ring = document.querySelector('.lp-cursor-ring');
    const before = parseFloat(ring.style.width);
    // Crank size to max via the options-bar slider.
    const slider = screen.getByRole('slider', { name: /Size/ });
    fireEvent.change(slider, { target: { value: '200' } });
    const after = parseFloat(document.querySelector('.lp-cursor-ring').style.width);
    expect(after).toBeGreaterThan(before);
    // jsdom viewport falls back to 512px, so fit = (512 - 24) / 2048.
    expect(after).toBeCloseTo(200 * ((512 - 24) / 2048), 5);
  });
});

describe('sticker duplicate', () => {
  it('stamps the sticker onto the base and keeps a live copy', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const ref = React.createRef();
    render(
      <I18nProvider>
        <LiveryCanvas ref={ref} />
        <Modal />
        <Toast />
      </I18nProvider>
    );
    await waitFor(() => expect(ref.current).toBeTruthy());
    const dupBtn = () => screen.getByRole('button', { name: 'Duplicate Sticker' });
    // No sticker yet: duplicate disabled.
    expect(dupBtn().disabled).toBe(true);
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(dupBtn().disabled).toBe(false));
    // Duplicate via the real button: stamps 5-arg drawImage onto the base
    // canvas and retains a live (still removable) copy.
    await user.click(dupBtn());
    const baseCtx = ctxs[0];
    expect(baseCtx.drawImage).toHaveBeenCalledWith(
      expect.anything(), expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    );
    expect(dupBtn().disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false);
  });
});

describe('sticker flip', () => {
  it('flip buttons reflect the sticker transform and disable without one', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const ref = React.createRef();
    render(
      <I18nProvider>
        <LiveryCanvas ref={ref} />
        <Modal />
        <Toast />
      </I18nProvider>
    );
    await waitFor(() => expect(ref.current).toBeTruthy());
    const hBtn = () => screen.getByRole('button', { name: 'Flip Horizontal' });
    const vBtn = () => screen.getByRole('button', { name: 'Flip Vertical' });
    expect(hBtn().disabled).toBe(true);
    expect(vBtn().disabled).toBe(true);
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(hBtn().disabled).toBe(false));
    ctxs.length = 0;
    await user.click(hBtn());
    await waitFor(() => {
      expect(ctxs.some(c => c.scale.mock.calls.some(([x, y]) => x === -1 && y === 1))).toBe(true);
    });
  });
});

describe('LiveryCanvas tools — paint operations', () => {
  it('eyedropper picks the pixel colour and switches back to brush', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Picker' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    // Mock pixel is transparent black → #000000.
    expect(screen.getByLabelText('Color').value).toBe('#000000');
    expect(screen.getByRole('button', { name: 'Brush' }).className).toContain('lp-active');
  });

  it('fill floods the region and commits pixels', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const main = ctxs[0];
    // Small synthetic surface so the real flood fill stays cheap.
    main.getImageData.mockReturnValue({ data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 });
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    expect(main.putImageData).toHaveBeenCalled();
  });

  it('fill tolerance slider readout updates', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    const slider = screen.getByRole('slider', { name: /Tolerance/ });
    fireEvent.change(slider, { target: { value: '128' } });
    expect(slider.value).toBe('128');
    expect(document.querySelector('.lp-optionsbar').textContent).toContain('128');
  });

  it('line / rect / ellipse tools draw the matching shape on pointer up', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const cv = mainCanvas();
    for (const [tool, probe] of [['Line', 'lineTo'], ['Rect', 'rect'], ['Ellipse', 'ellipse']]) {
      await user.click(screen.getByRole('button', { name: tool }));
      fireEvent.pointerDown(cv, { clientX: 40, clientY: 40, button: 0, pointerId: 1 });
      fireEvent.pointerMove(cv, { clientX: 160, clientY: 120, button: 0, pointerId: 1 });
      fireEvent.pointerUp(cv, { pointerId: 1 });
      expect(ctxs.some(c => c[probe].mock.calls.length > 0)).toBe(true);
    }
  });

  it('shape width + fill toggle controls render for shape tools', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    const width = screen.getByRole('slider', { name: /Width/ });
    fireEvent.change(width, { target: { value: '50' } });
    expect(document.querySelector('.lp-optionsbar').textContent).toContain('50');
    const fillToggle = screen.getByRole('checkbox');
    expect(fillToggle.checked).toBe(true);
    fireEvent.click(fillToggle);
    expect(fillToggle.checked).toBe(false);
  });

  it('brush opacity slider and hard/soft toggle work', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const opacity = screen.getByRole('slider', { name: /Opacity/ });
    fireEvent.change(opacity, { target: { value: '0.5' } });
    expect(document.querySelector('.lp-optionsbar').textContent).toContain('50%');
    // Soft edge sets a shadow blur on the next stroke.
    await user.click(screen.getByRole('button', { name: 'Soft' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 60, clientY: 60, button: 0, pointerId: 1 });
    fireEvent.pointerMove(mainCanvas(), { clientX: 80, clientY: 80, button: 0, pointerId: 1 });
    expect(ctxs[0].shadowBlur).toBeGreaterThan(0);
  });

  it('text options expose font, size, bold and italic', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Text' }));
    expect(screen.getByRole('combobox', { name: /Font/ })).toBeInTheDocument();
    const bold = screen.getByRole('button', { name: 'Bold' });
    const italic = screen.getByRole('button', { name: 'Italic' });
    await user.click(bold);
    await user.click(italic);
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    expect(italic.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('LiveryCanvas undo/redo + clear', () => {
  it('undo/redo buttons replay snapshots after a stroke', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const undoBtn = () => screen.getByRole('button', { name: 'Undo' });
    const redoBtn = () => screen.getByRole('button', { name: 'Redo' });
    expect(undoBtn().disabled).toBe(true);
    expect(redoBtn().disabled).toBe(true);
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 30, clientY: 30, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 50, clientY: 50, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    await waitFor(() => expect(undoBtn().disabled).toBe(false));
    const before = ctxs[0].putImageData.mock.calls.length;
    await user.click(undoBtn());
    expect(ctxs[0].putImageData.mock.calls.length).toBeGreaterThan(before);
    // Redo via keyboard (Ctrl+Y) — the button's enabled state is ref-derived
    // and only re-renders on a dirty change, so drive the handler directly.
    expect(redoBtn()).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    expect(ctxs[0].putImageData.mock.calls.length).toBeGreaterThan(before + 1);
  });

  it('clear asks for confirmation and wipes the canvas', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const clearRect = ctxs[0].clearRect;
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByText('Confirm Clear')).toBeInTheDocument());
    await user.click(screen.getByText('Clear', { selector: '.btn-danger' }).closest('button'));
    await waitFor(() => expect(clearRect.mock.calls.length).toBeGreaterThan(0));
  });

  it('clear cancel keeps the canvas untouched', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByText('Confirm Clear')).toBeInTheDocument());
    const before = ctxs[0].clearRect.mock.calls.length;
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Confirm Clear')).toBeNull());
    expect(ctxs[0].clearRect.mock.calls.length).toBe(before);
  });

  it('keyboard shortcuts switch tools and drive undo', () => {
    renderCanvas();
    fireEvent.keyDown(window, { key: 'e' });
    expect(screen.getByRole('button', { name: 'Eraser' }).className).toContain('lp-active');
    fireEvent.keyDown(window, { key: 'g' });
    expect(screen.getByRole('button', { name: 'Fill' }).className).toContain('lp-active');
    fireEvent.keyDown(window, { key: 'b' });
    expect(screen.getByRole('button', { name: 'Brush' }).className).toContain('lp-active');
    // Ctrl+Z after a stroke restores a snapshot.
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 20, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 40, clientY: 40, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const before = ctxs[0].putImageData.mock.calls.length;
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(ctxs[0].putImageData.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('LiveryCanvas zoom + stickers', () => {
  it('zoom in/out/fit update the zoom readout', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const pct = () => document.querySelector('.lp-zoom-pct').textContent;
    expect(pct()).toBe('24%'); // fit scale from the 512px jsdom fallback
    await user.click(screen.getByRole('button', { name: 'Zoom In' }));
    expect(pct()).toBe('25%');
    await user.click(screen.getByRole('button', { name: 'Zoom In' }));
    expect(pct()).toBe('50%');
    await user.click(screen.getByRole('button', { name: 'Zoom Out' }));
    expect(pct()).toBe('25%');
    await user.click(screen.getByRole('button', { name: 'Fit' }));
    expect(pct()).toBe('24%');
  });

  it('remove sticker button is enabled only while a sticker exists', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const removeBtn = () => screen.getByRole('button', { name: 'Remove Sticker' });
    expect(removeBtn().disabled).toBe(true);
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(removeBtn().disabled).toBe(false));
    await act(async () => { ref.current.removeSticker(); });
    await waitFor(() => expect(removeBtn().disabled).toBe(true));
  });

  it('Escape deselects an imported sticker without removing it', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false));
    fireEvent.keyDown(window, { key: 'Escape' });
    // Still present (just deselected), so removal stays possible.
    expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false);
  });

  it('a failed sticker read toasts the backend error', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: false, error: 'BAD_IMAGE' });
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(screen.getByText('BAD_IMAGE')).toBeInTheDocument());
  });
});

describe('paint save payload', () => {
  it('save calls createLivery with a 2048 PNG data-URL', async () => {
    const user = userEvent.setup();
    CreateTab.prefill = {
      folder: 'A20N_CCA', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
      imageDataUrl: 'data:image/png;base64,BASE',
    };
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'create-livery') return Promise.resolve({ success: true, folder: 'A20N_CCA' });
      return Promise.resolve({ success: true, mine: [], reference: [] });
    });
    render(
      <I18nProvider>
        <CreateTab onCreated={() => {}} />
        <Modal />
        <Toast />
      </I18nProvider>
    );
    // Paint mode is default with a prefill; airline/aircraft prefilled.
    const saveBtn = await screen.findByRole('button', { name: 'Save' });
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    await user.click(saveBtn);
    // Save opens the naming dialog prefilled with the origin folder.
    const input = await screen.findByLabelText('Folder name');
    expect(input.value).toBe('A20N_CCA');
    const modal = document.querySelector('#modal-box');
    await user.click(within(modal).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('create-livery', expect.objectContaining({
        airline: 'CCA',
        targetPlaneId: 'AIRBUS A-320neo',
        folder: 'A20N_CCA',
      }));
    });
    const payload = mockIpcInvoke.mock.calls.find(c => c[0] === 'create-livery')[1];
    expect(payload.imageDataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});
