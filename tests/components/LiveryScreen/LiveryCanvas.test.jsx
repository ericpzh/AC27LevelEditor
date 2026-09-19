import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveryCanvas, { reorderObjects, brushRgba, frameOf, scaleErase, scaleErasePolys, scaleFrame, flipOffset, worldFromLocal, localFromWorld, objectLocal, resizeFactors, panelLayout, isTextEntry, TEXTURE, OVERLAY_PAD } from '../../../src/components/LiveryScreen/LiveryCanvas';
import CreateTab from '../../../src/components/LiveryScreen/CreateTab';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang, T } from '../../../src/utils/i18n';

// ── Canvas stubs (jsdom has no 2d context) ───────────────────
let ctxs = [];
let imageSrcs = [];
// Every `globalCompositeOperation` assignment, in order. `destination-in` is
// set by the stamped-movable clip (`paintObjectMasked`), so a count of it
// tracks those
// clip/erase paths — never a plain object draw.
let gcoSets = [];
function makeCtx() {
  return {
    save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
    fillRect: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), arc: vi.fn(), clip: vi.fn(),
    strokeRect: vi.fn(), setLineDash: vi.fn(),
    fillText: vi.fn(), putImageData: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(),
    getImageData: vi.fn((x, y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)),
      width: w, height: h,
    })),
    _gco: 'source-over',
    get globalCompositeOperation() { return this._gco; },
    set globalCompositeOperation(v) { this._gco = v; gcoSets.push(v); },
  };
}

class MockImage {
  constructor() { this._src = ''; this.onload = null; this.onerror = null; }
  set src(v) {
    this._src = v;
    imageSrcs.push(v);
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
  imageSrcs = [];
  gcoSets = [];
  getCtxSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    const c = makeCtx();
    // Tag the context with the owning layer (data-layer on the canvas) so tests
    // can target the paint / base / objects / chrome layer unambiguously.
    c._layer = this && this.dataset ? this.dataset.layer : undefined;
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

// The chrome canvas is the pointer interaction surface (topmost layer); all
// other layers are pointer-events:none. Firing events here drives the tool
// handlers like a real click on the stage.
function mainCanvas() {
  return document.querySelector('.livery-canvas-wrap canvas[data-layer="chrome"]');
}
// The layered canvas elements (base image / movables / paint / chrome).
function layerCanvas(layer) {
  return document.querySelector(`.livery-canvas-wrap canvas[data-layer="${layer}"]`);
}
// Layer contexts, matched by the owning canvas's data-layer attribute.
function layerCtx(layer) {
  return ctxs.find(c => c._layer === layer);
}
function paintCtx() { return layerCtx('paint'); }

// Give every canvas context a synthetic readback for the OBJECT MEASUREMENT
// reads (`getImageData` over a sub-texture box), which the eraser uses to decide
// what is left of an object: alternate calls are the clean render (always fully
// visible) and the holed render (whatever `paintHoled` fills in). Full-texture
// reads (base / mask / undo) keep the default transparent stub.
function stubEraseReadback(paintHoled) {
  // Shared across contexts: the scratch canvas hands out a fresh stub context
  // per getContext call, so the clean/holed alternation cannot live per-context.
  let measureCalls = 0;
  getCtxSpy.mockImplementation(() => {
    const c = makeCtx();
    const fallback = c.getImageData.getMockImplementation();
    c.getImageData.mockImplementation((x, y, w, h) => {
      if (w < 1024 && h < 1024) {
        const clean = (measureCalls++ % 2) === 0;
        const data = new Uint8ClampedArray(Math.max(4, w * h * 4));
        if (clean) {
          for (let i = 3; i < data.length; i += 4) data[i] = 255;
        } else {
          paintHoled(data, w, h);
        }
        return { data, width: w, height: h };
      }
      return fallback
        ? fallback(x, y, w, h)
        : { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h };
    });
    ctxs.push(c);
    return c;
  });
}

// Full-texture mask readback for the marquee eraser. jsdom has no rasterizer,
// so the real mask is always transparent and `traceMaskBorder` yields no loops;
// return an opaque block for every 2048² read instead. Sub-texture reads
// (object measurement) stay transparent, unless `dropObjects` makes the holed
// render vanish so a touched movable is "fully consumed".
function stubMaskBlock(x0, y0, x1, y1, dropObjects = false) {
  let measureCalls = 0;
  getCtxSpy.mockImplementation(function () {
    const c = makeCtx();
    c._layer = this && this.dataset ? this.dataset.layer : undefined;
    const fallback = c.getImageData.getMockImplementation();
    c.getImageData.mockImplementation((x, y, w, h) => {
      if (w >= 1024 && h >= 1024) {
        const data = new Uint8ClampedArray(w * h * 4);
        const xa = Math.max(0, x0), xb = Math.min(w, x1);
        const ya = Math.max(0, y0), yb = Math.min(h, y1);
        for (let yy = ya; yy < yb; yy++) {
          for (let xx = xa; xx < xb; xx++) data[(yy * w + xx) * 4 + 3] = 255;
        }
        return { data, width: w, height: h };
      }
      if (dropObjects && w < 1024 && h < 1024) {
        const clean = (measureCalls++ % 2) === 0;
        const data = new Uint8ClampedArray(Math.max(4, w * h * 4));
        if (clean) for (let i = 3; i < data.length; i += 4) data[i] = 255;
        return { data, width: w, height: h };
      }
      return fallback
        ? fallback(x, y, w, h)
        : { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h };
    });
    ctxs.push(c);
    return c;
  });
}

// The rail RGBA colour well (its hex + alpha live in data attributes).
// Queried by role: the picker dialog itself also carries the "Color" label.
function swatch() {
  return screen.getByRole('button', { name: 'Color' });
}

// Open the custom RGBA picker from the swatch, drag the alpha rail, close it.
async function setAlphaViaPicker(user, value) {
  await user.click(swatch());
  const alpha = screen.getByRole('slider', { name: /Opacity/ });
  fireEvent.change(alpha, { target: { value } });
  fireEvent.keyDown(window, { key: 'Escape' });
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
    // Dabs land on the per-stroke layer...
    expect(ctxs.some(c => c.stroke.mock.calls.length > 0)).toBe(true);
    expect(ctxs.some(c => c.lineTo.mock.calls.length > 0)).toBe(true);
    // ...and the stroke is composited back onto the base (9-arg drawImage).
    expect(main.drawImage.mock.calls.some(a => a.length === 9)).toBe(true);
  });

  it('a click without a drag deposits one brush dab', async () => {
    renderCanvas();
    const cv = mainCanvas();
    // pointerdown + pointerup only — no pointermove at all.
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const main = ctxs[0];
    expect(main.getImageData).toHaveBeenCalled(); // undo snapshot
    // The zero-length round-cap dab was stroked...
    expect(ctxs.some(c => c.stroke.mock.calls.length > 0)).toBe(true);
    expect(ctxs.some(c => c.lineTo.mock.calls.length > 0)).toBe(true);
    // ...and composited back to the base.
    expect(main.drawImage.mock.calls.some(a => a.length === 9)).toBe(true);
  });

  it('text commit creates a selectable live object, not rasterised', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Text' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    const input = screen.getByPlaceholderText('Type text, Enter to commit…');
    await user.type(input, 'hello');
    fireEvent.keyDown(input, { key: 'Enter' });
    // The text becomes a live object: object actions light up and the base
    // canvas stays untouched (no raster fillText).
    const removeBtn = screen.getByRole('button', { name: 'Remove Sticker' });
    await waitFor(() => expect(removeBtn.disabled).toBe(false));
    expect(screen.getByRole('button', { name: 'Flip Horizontal' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Duplicate Sticker' }).disabled).toBe(false);
    expect(ctxs[0].fillText).not.toHaveBeenCalled();
    // Export flattens the text into the output.
    act(() => { ref.current.exportPNG(); });
    const exportCtx = ctxs[ctxs.length - 1];
    expect(exportCtx.fillText).toHaveBeenCalledWith('hello', 0, 0);
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
    // Export flattens it over the (opaque) base.
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

describe('brush size shortcuts + Shift-click straight lines', () => {
  it('[ / ] shrink and grow the brush/eraser size by 5 (clamped 1–200)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const slider = () => screen.getByRole('slider', { name: /Size/ });
    expect(slider().value).toBe('12');
    fireEvent.keyDown(window, { key: ']' });
    expect(slider().value).toBe('17');
    fireEvent.keyDown(window, { key: ']' });
    expect(slider().value).toBe('22');
    fireEvent.keyDown(window, { key: '[' });
    expect(slider().value).toBe('17');
    // Applies to the eraser too (same shared size).
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    fireEvent.keyDown(window, { key: '[' });
    expect(slider().value).toBe('12');
    // Clamps at the slider minimum.
    for (let i = 0; i < 10; i++) fireEvent.keyDown(window, { key: '[' });
    expect(slider().value).toBe('1');
    for (let i = 0; i < 50; i++) fireEvent.keyDown(window, { key: ']' });
    expect(slider().value).toBe('200');
  });

  it('[ / ] leave the size alone for a tool without a brush size', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const slider = () => screen.getByRole('slider', { name: /Size/ });
    expect(slider().value).toBe('12');
    // Records / shapes have no brush size — the keys must be inert.
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: ']' });
    fireEvent.keyDown(window, { key: '[' });
    await user.click(screen.getByRole('button', { name: 'Brush' }));
    expect(slider().value).toBe('12');
  });

  it('a click then Shift-click draws a straight brush line, chaining further points', () => {
    renderCanvas();
    const cv = mainCanvas();
    // Plain click drops the anchor and deposits one dab.
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ctxs.some(c => c.stroke.mock.calls.length > 0)).toBe(true);
    // Shift-click: one straight segment (400,400) → (800,800) in texture space.
    fireEvent.pointerDown(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ctxs.some(c => c.moveTo.mock.calls.some(a => a[0] === 400 && a[1] === 400)
      && c.lineTo.mock.calls.some(a => a[0] === 800 && a[1] === 800))).toBe(true);
    // A third Shift-click chains from the 2nd point → (1200,1200).
    fireEvent.pointerDown(cv, { clientX: 300, clientY: 300, button: 0, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ctxs.some(c => c.moveTo.mock.calls.some(a => a[0] === 800 && a[1] === 800)
      && c.lineTo.mock.calls.some(a => a[0] === 1200 && a[1] === 1200))).toBe(true);
  });

  it('a click then Shift-click erases a straight line', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    fireEvent.pointerDown(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const base = paintCtx();
    expect(base).toBeTruthy();
    // The eraser stroke (destination-out) runs the Shift-click segment (paint layer).
    expect(base.moveTo.mock.calls.some(a => a[0] === 400 && a[1] === 400)).toBe(true);
    expect(base.lineTo.mock.calls.some(a => a[0] === 800 && a[1] === 800)).toBe(true);
  });

  it('brush size accepts a typed number (slider follows, clamped)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const slider = () => screen.getByRole('slider', { name: /Size/ });
    const field = () => screen.getByRole('textbox', { name: /Size/ });
    expect(slider().value).toBe('12');
    await user.clear(field());
    await user.type(field(), '87');
    fireEvent.blur(field());
    expect(slider().value).toBe('87');
    expect(field().value).toBe('87');
    // Out-of-range clamps to the slider maximum.
    fireEvent.change(field(), { target: { value: '500' } });
    fireEvent.blur(field());
    expect(slider().value).toBe('200');
    expect(field().value).toBe('200');
    // Minimum clamps to 1.
    fireEvent.change(field(), { target: { value: '0' } });
    fireEvent.blur(field());
    expect(slider().value).toBe('1');
    expect(field().value).toBe('1');
  });
});

describe('sticker duplicate', () => {
  it('duplicates the sticker and keeps the original selectable', async () => {
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
    const before = ref.current.getObjectIds();
    await user.click(dupBtn());
    const after = ref.current.getObjectIds();
    // A true copy: original + copy both live, nothing stamped onto the base.
    expect(after).toHaveLength(2);
    expect(after).toContain(before[0]);
    expect(ctxs[0].drawImage).not.toHaveBeenCalled();
    expect(dupBtn().disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false);
  });

  it('I imports a sticker (Import Sticker shortcut)', async () => {
    let called = false;
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') { called = true; return Promise.resolve({ canceled: true }); }
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    fireEvent.keyDown(window, { key: 'i' });
    await waitFor(() => expect(called).toBe(true));
  });

  it('Ctrl+C duplicates the selected object like the rail button', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    const before = ref.current.getObjectIds();
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    const after = ref.current.getObjectIds();
    // A true copy: the original stays plus the duplicated copy.
    expect(after).toHaveLength(2);
    expect(after).toContain(before[0]);
    expect(ctxs[0].drawImage).not.toHaveBeenCalled();
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

  it('H / V keyboard shortcuts flip the selected object horizontally / vertically', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    fireEvent.keyDown(window, { key: 'h' });
    expect(ref.current.getObjectInfo().flipX).toBe(true);
    expect(ref.current.getObjectInfo().flipY).toBe(false);
    fireEvent.keyDown(window, { key: 'v' });
    expect(ref.current.getObjectInfo().flipY).toBe(true);
    // A second press toggles the axis back off.
    fireEvent.keyDown(window, { key: 'h' });
    expect(ref.current.getObjectInfo().flipX).toBe(false);
  });

  it('rail tooltips advertise the keyboard shortcuts', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    const tipFor = (name) => {
      const btn = screen.getByRole('button', { name });
      fireEvent.mouseEnter(btn);
      const tip = document.body.querySelector('.tooltip-popup');
      const text = tip ? tip.textContent : '';
      fireEvent.mouseLeave(btn);
      return text;
    };
    expect(tipFor('Import Sticker')).toContain('(I)');
    expect(tipFor('Duplicate Sticker')).toContain('(Ctrl+C)');
    expect(tipFor('Flip Horizontal')).toContain('(H)');
    expect(tipFor('Flip Vertical')).toContain('(V)');
    expect(tipFor('Undo')).toContain('(Ctrl+Z)');
    // Redo is disabled with an empty future (disabled buttons don't hover), so
    // assert the enabled Delete button instead.
    expect(tipFor('Remove Sticker')).toContain('(Del)');
    // The Eyedropper has no shortcut (right-click picks); I is Import Sticker.
    expect(tipFor('Picker')).not.toContain('(I)');
  });
});

describe('live-object handles survive a flip', () => {
  // The Select box + handles are always drawn in the UNFLIPPED frame
  // (`drawOverlay`), so the grab zones must stay exactly where they are drawn
  // after a flip. Regression: the grab points were mirrored through the object
  // (`flipLocal`), which moved the bottom-right dot's hit zone to the opposite
  // corner — so a flipped sticker/shape could not be scaled at all (dragging
  // the visible dot just moved the object), and the rotate dot only worked on
  // the far side of the box.
  //
  // jsdom canvas rect is stubbed 512×512 → client = texture / 4.
  const CX = 1024, CY = 1024; // TEXTURE / 2
  // texture → client: the jsdom canvas rect is stubbed 512×512 (2048 / 512 = 4).
  const toClient = (o, lx, ly) => ({
    clientX: (o.x + lx) / 4,
    clientY: (o.y + ly) / 4,
  });
  const drag = (from, to) => {
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { ...from, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { ...to, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
  };
  const importSticker = async (user, ref) => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    return ref.current.getObjectInfo();
  };

  it('scales a sticker by the drawn bottom-right dot after flipping both axes', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const before = await importSticker(user, ref);
    await user.click(screen.getByRole('button', { name: 'Flip Horizontal' }));
    await user.click(screen.getByRole('button', { name: 'Flip Vertical' }));
    const o = ref.current.getObjectInfo();
    expect([o.flipX, o.flipY]).toEqual([true, true]);
    drag(toClient(o, o.frame.x1, o.frame.y1), toClient(o, o.frame.x1 * 2, o.frame.y1 * 2));
    const after = ref.current.getObjectInfo();
    expect(after.w).toBeCloseTo(before.w * 2, 0);
    expect(after.h).toBeCloseTo(before.h * 2, 0);
    // Scaling, NOT a body drag to the pointer.
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
  });

  it('a scale drag keeps registering past the 2048 canvas edge', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const before = await importSticker(user, ref);
    const o = ref.current.getObjectInfo();
    // Drag the bottom-right handle far outside the canvas (2800, 2600).
    drag(toClient(o, o.frame.x1, o.frame.y1), { clientX: 2800 / 4, clientY: 2600 / 4 });
    const after = ref.current.getObjectInfo();
    // No canvas-edge clamp: the object can grow past 2048.
    expect(after.w).toBeGreaterThan(2048);
    expect(after.h).toBeGreaterThan(2048);
  });

  it('Ctrl+Z reverts a scaling drag', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const before = await importSticker(user, ref);
    const o = ref.current.getObjectInfo();
    drag(toClient(o, o.frame.x1, o.frame.y1), toClient(o, o.frame.x1 * 2, o.frame.y1 * 2));
    const scaled = ref.current.getObjectInfo();
    expect(scaled.w).toBeGreaterThan(before.w);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    const after = ref.current.getObjectInfo();
    expect(after.w).toBeCloseTo(before.w, 5);
    expect(after.h).toBeCloseTo(before.h, 5);
  });

  it('scales a shape by the drawn bottom-right dot after flipping both axes', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    // Commit a 240×160 rect centred on the canvas.
    drag(
      { clientX: (CX - 120) / 4, clientY: (CY - 80) / 4 },
      { clientX: (CX + 120) / 4, clientY: (CY + 80) / 4 },
    );
    const before = ref.current.getObjectInfo();
    expect(before.kind).toBe('rect');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Flip Horizontal' }).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Flip Horizontal' }));
    await user.click(screen.getByRole('button', { name: 'Flip Vertical' }));
    const o = ref.current.getObjectInfo();
    expect([o.flipX, o.flipY]).toEqual([true, true]);
    // The shape tool stays active after a commit — select the object so the
    // handles are actually drawn/grabbable.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    drag(toClient(o, o.frame.x1, o.frame.y1), toClient(o, o.frame.x1 * 2, o.frame.y1 * 2));
    const after = ref.current.getObjectInfo();
    expect(ref.current.getObjectCount()).toBe(1);
    expect(after.w).toBeCloseTo(before.w * 2, 0);
    expect(after.h).toBeCloseTo(before.h * 2, 0);
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
  });

  it('rotates a flipped sticker by the handle drawn above the box', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await importSticker(user, ref);
    await user.click(screen.getByRole('button', { name: 'Flip Horizontal' }));
    await user.click(screen.getByRole('button', { name: 'Flip Vertical' }));
    const o = ref.current.getObjectInfo();
    expect(o.rot).toBe(0);
    // Fit scale from the 512px jsdom fallback: (512-24)/2048.
    const gap = 40 / (488 / 2048);
    const ly = o.frame.y0 - gap;
    drag(toClient(o, 0, ly), toClient(o, 80, ly));
    const after = ref.current.getObjectInfo();
    expect(after.rot).toBeCloseTo(Math.atan2(ly, 80) + Math.PI / 2, 3);
    expect(after.x).toBe(o.x);
    expect(after.y).toBe(o.y);
  });
});

describe('sticker opacity slider', () => {
  const importSticker = async (user, ref) => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
  };
  const opacitySlider = () => screen.getByRole('slider', { name: /Opacity/ });

  it('exposes a 100% alpha slider for the selected sticker and stores the value', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await importSticker(user, ref);
    expect(opacitySlider().value).toBe('100');
    expect(screen.getByRole('textbox', { name: /Opacity/ }).value).toBe('100');

    ctxs.length = 0;
    fireEvent.change(opacitySlider(), { target: { value: '40' } });
    expect(ref.current.getObjectInfo().opacity).toBeCloseTo(0.4, 6);
    expect(opacitySlider().value).toBe('40');
    expect(screen.getByRole('textbox', { name: /Opacity/ }).value).toBe('40');
    // The overlay redraws the sticker with that alpha (overlay + base share the
    // same paint path, so the export carries it too).
    await waitFor(() => expect(ctxs.some(c => c.globalAlpha === 0.4)).toBe(true));

    // Re-selecting keeps the stored value (it is the object's own alpha).
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('slider', { name: /Opacity/ })).toBeNull();
    fireEvent.pointerDown(mainCanvas(), { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(mainCanvas(), { pointerId: 1 });
    await waitFor(() => expect(opacitySlider().value).toBe('40'));
  });

  it('flattens the sticker with the chosen alpha on export', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await importSticker(user, ref);
    fireEvent.change(opacitySlider(), { target: { value: '25' } });
    ctxs.length = 0;
    const url = ref.current.exportPNG();
    expect(url).toBe(FAKE_SAVE);
    // The sticker draw went out at 25% alpha.
    expect(ctxs.some(c => c.globalAlpha === 0.25 && c.drawImage.mock.calls.length > 0)).toBe(true);
  });

  it('sticker opacity accepts a typed number (slider follows)', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await importSticker(user, ref);
    const field = screen.getByRole('textbox', { name: /Opacity/ });
    await user.clear(field);
    await user.type(field, '60');
    fireEvent.blur(field);
    expect(opacitySlider().value).toBe('60');
    expect(field.value).toBe('60');
    expect(ref.current.getObjectInfo().opacity).toBeCloseTo(0.6, 6);
  });

  it('is only offered for a selected sticker', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    // Nothing selected.
    expect(screen.queryByRole('slider', { name: /Opacity/ })).toBeNull();
    // A selected text object shows the text options, not the sticker alpha.
    await user.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    await user.type(screen.getByPlaceholderText('Type text, Enter to commit…'), 'hi');
    fireEvent.keyDown(screen.getByPlaceholderText('Type text, Enter to commit…'), { key: 'Enter' });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    expect(screen.queryByRole('slider', { name: /Opacity/ })).toBeNull();
    expect(screen.getByRole('slider', { name: /Size/ })).toBeInTheDocument();
  });
});

describe('free stretch vs Shift aspect-locked resize', () => {
  // jsdom canvas rect is stubbed 512×512 → client = texture / 4.
  const CX = 1024, CY = 1024;
  const toClient = (o, lx, ly) => ({
    clientX: (o.x + lx) / 4,
    clientY: (o.y + ly) / 4,
  });
  const drag = (from, to, opts = {}) => {
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { ...from, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { ...to, button: 0, pointerId: 1, ...opts });
    fireEvent.pointerUp(cv, { pointerId: 1 });
  };
  const importSticker = async (ref) => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
  };
  async function makeText(user, ref, text = 'hi') {
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    const input = screen.getByPlaceholderText('Type text, Enter to commit…');
    await user.type(input, text);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(ctxs.some(c => c.translate.mock.calls.length > 0)).toBe(true));
  }

  it('stretches a sticker without Shift: w and h follow the pointer independently', async () => {
    const ref = React.createRef();
    await importSticker(ref);
    const before = ref.current.getObjectInfo();
    expect([before.w, before.h]).toEqual([100, 50]);
    // Bottom-right handle out to twice the width and half the height.
    drag(toClient(before, before.w / 2, before.h / 2), toClient(before, before.w, before.h / 4));
    const after = ref.current.getObjectInfo();
    expect(after.w).toBeCloseTo(200, 3);
    expect(after.h).toBeCloseTo(25, 3);
    // Scaling about the centre, not a body drag.
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
  });

  it('keeps the aspect ratio when Shift is held', async () => {
    const ref = React.createRef();
    await importSticker(ref);
    const before = ref.current.getObjectInfo();
    drag(toClient(before, before.w / 2, before.h / 2), toClient(before, before.w, before.h / 4), { shiftKey: true });
    const after = ref.current.getObjectInfo();
    // One factor for both axes: the 2:1 box stays 2:1 (and is NOT the free
    // stretch above, which would have quartered h).
    expect(after.w / after.h).toBeCloseTo(before.w / before.h, 6);
    const k = after.w / before.w;
    expect(after.h).toBeCloseTo(before.h * k, 6);
    expect(k).toBeCloseTo(Math.hypot(100, 12.5) / Math.hypot(50, 25), 6);
    expect(after.h).not.toBeCloseTo(25, 0);
  });

  it('stretches a shape object the same way', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    drag(
      { clientX: (CX - 120) / 4, clientY: (CY - 80) / 4 },
      { clientX: (CX + 120) / 4, clientY: (CY + 80) / 4 },
    );
    const before = ref.current.getObjectInfo();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    drag(toClient(before, before.w / 2, before.h / 2), toClient(before, before.w * 1.5, before.h / 4));
    const after = ref.current.getObjectInfo();
    expect(ref.current.getObjectCount()).toBe(1);
    expect(after.w).toBeCloseTo(720, 3);
    expect(after.h).toBeCloseTo(80, 3);
  });

  it('stretches a text box and its glyphs while keeping the font size', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await makeText(user, ref, 'hi');
    const before = ref.current.getObjectInfo();
    expect(before.kind).toBe('text');
    ctxs.length = 0;
    // Corner out to 3x the width, half the height.
    drag(toClient(before, before.w / 2, before.h / 2), toClient(before, before.w * 1.5, before.h / 4));
    const after = ref.current.getObjectInfo();
    expect(after.w).toBeCloseTo(before.w * 3, 3);
    expect(after.h).toBeCloseTo(before.h * 0.5, 3);
    // The font is untouched; the glyphs are scaled to fill the stretched box.
    expect(after.size).toBe(before.size);
    expect(after.stretch.sx).toBeCloseTo(3, 6);
    expect(after.stretch.sy).toBeCloseTo(0.5, 6);
    await waitFor(() => {
      expect(ctxs.some(c => c.scale.mock.calls.some(([x, y]) =>
        Math.abs(x - 3) < 1e-6 && Math.abs(y - 0.5) < 1e-6))).toBe(true);
    });
    // A later font/size change keeps the stretch (box re-measured, still stretched).
    fireEvent.change(screen.getByRole('slider', { name: /Size/ }), { target: { value: String(before.size * 2) } });
    const resized = ref.current.getObjectInfo();
    expect(resized.size).toBe(before.size * 2);
    expect(resized.stretch.sx).toBeCloseTo(3, 6);
    expect(resized.stretch.sy).toBeCloseTo(0.5, 6);
    expect(resized.w / resized.h).toBeCloseTo(6, 6);
  });

  it('keeps a text box aspect-locked when Shift is held', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await makeText(user, ref, 'hi');
    const before = ref.current.getObjectInfo();
    drag(toClient(before, before.w / 2, before.h / 2), toClient(before, before.w, before.h / 4), { shiftKey: true });
    const after = ref.current.getObjectInfo();
    expect(after.stretch).toBeNull();
    expect(after.w / after.h).toBeCloseTo(1, 6);
    const k = after.w / before.w;
    expect(after.size).toBeCloseTo(before.size * k, 6);
  });
});

describe('text object (selectable, flippable)', () => {
  async function commitText(user, ref, text = 'hi') {
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    const input = screen.getByPlaceholderText('Type text, Enter to commit…');
    await user.type(input, text);
    fireEvent.keyDown(input, { key: 'Enter' });
    // Select tool is active after commit; wait for the overlay box to draw.
    // (Each draw calls overlay.getContext, so scan all mocked contexts.)
    await waitFor(() => expect(ctxs.some(c => c.translate.mock.calls.length > 0)).toBe(true));
  }

  it('is selectable and moveable with the Select tool', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await commitText(user, ref);
    const overlayCtx = ctxs.find(c => c.translate.mock.calls.length > 0);
    const committedX = overlayCtx.translate.mock.calls[0][0];
    // Escape deselects but keeps the object around.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false);
    // Click inside the box and drag right: re-selects and moves the object.
    ctxs.length = 0;
    fireEvent.pointerDown(mainCanvas(), { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(mainCanvas(), { clientX: 344, clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerUp(mainCanvas(), { pointerId: 1 });
    await waitFor(() => {
      expect(ctxs.some(c => c.translate.mock.calls.some(([x]) => x > committedX + 10))).toBe(true);
    });
  });

  it('commits the draft when switching tools', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    await user.type(screen.getByPlaceholderText('Type text, Enter to commit…'), 'bye');
    await user.click(screen.getByRole('button', { name: 'Brush' }));
    // The draft became a live object and the tool switch went through.
    expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Brush' }).className).toContain('lp-active');
    expect(ctxs[0].fillText).not.toHaveBeenCalled();
  });

  it('commits the draft when clicking away on the canvas', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    await user.type(screen.getByPlaceholderText('Type text, Enter to commit…'), 'bye');
    // Click elsewhere on the canvas while the Text tool is still active.
    fireEvent.pointerDown(mainCanvas(), { clientX: 400, clientY: 400, button: 0, pointerId: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false));
    expect(screen.getByRole('button', { name: 'Duplicate Sticker' }).disabled).toBe(false);
    // Handed over to Select and no empty box is left open.
    expect(screen.getByRole('button', { name: 'Select' }).className).toContain('lp-active');
    expect(screen.queryByPlaceholderText('Type text, Enter to commit…')).toBeNull();
    expect(ctxs[0].fillText).not.toHaveBeenCalled();
  });

  it('commits the draft when the input loses focus', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    const input = screen.getByPlaceholderText('Type text, Enter to commit…');
    await user.type(input, 'bye');
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false));
    expect(ctxs[0].fillText).not.toHaveBeenCalled();
  });

  it('flips horizontally then vertically', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await commitText(user, ref);
    ctxs.length = 0;
    await user.click(screen.getByRole('button', { name: 'Flip Horizontal' }));
    await waitFor(() => {
      expect(ctxs.some(c => c.scale.mock.calls.some(([x, y]) => x === -1 && y === 1))).toBe(true);
    });
    ctxs.length = 0;
    await user.click(screen.getByRole('button', { name: 'Flip Vertical' }));
    await waitFor(() => {
      expect(ctxs.some(c => c.scale.mock.calls.some(([x, y]) => x === -1 && y === -1))).toBe(true);
    });
  });
});

describe('text object re-editing (Select tool)', () => {
  async function makeText(user, ref, text = 'hi') {
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    const input = screen.getByPlaceholderText('Type text, Enter to commit…');
    await user.type(input, text);
    fireEvent.keyDown(input, { key: 'Enter' });
    // Select tool is active and the overlay box has been drawn.
    await waitFor(() => expect(ctxs.some(c => c.translate.mock.calls.length > 0)).toBe(true));
  }

  it('exposes font/size/bold/italic for the selected text and edits it in place', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await makeText(user, ref, 'hi');
    // Select tool + selected text → the text options show without the Text tool.
    expect(screen.getByRole('combobox', { name: /Font/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('slider', { name: /Size/ }), { target: { value: '200' } });
    await user.click(screen.getByRole('button', { name: 'Bold' }));
    await user.click(screen.getByRole('button', { name: 'Italic' }));
    expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe('true');
    // The style lands on the existing object (no new one is created).
    act(() => { ref.current.exportPNG(); });
    const exportCtx = ctxs[ctxs.length - 1];
    expect(exportCtx.font).toBe('italic bold 200px sans-serif');
    expect(ref.current.getObjectCount()).toBe(1);
  });

  it('double-click re-opens the editor prefilled and updates the content', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await makeText(user, ref, 'hi');
    // Double-click the text centre (texture ≈1272,1272 at 4× → client 318).
    fireEvent.doubleClick(mainCanvas(), { clientX: 318, clientY: 318, button: 0, pointerId: 1 });
    const input = await screen.findByPlaceholderText('Type text, Enter to commit…');
    expect(input.value).toBe('hi');
    await user.clear(input);
    await user.type(input, 'hello world');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByPlaceholderText('Type text, Enter to commit…')).toBeNull();
    act(() => { ref.current.exportPNG(); });
    const exportCtx = ctxs[ctxs.length - 1];
    expect(exportCtx.fillText).toHaveBeenCalledWith('hello world', 0, 0);
    expect(ref.current.getObjectCount()).toBe(1);
  });

  it('Enter exits the selection instead of re-opening the text editor', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await makeText(user, ref, 'hi');
    const [textId] = ref.current.getObjectIds();
    // Add a second (topmost) object so Delete can prove the text was deselected.
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 400, clientY: 400, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 500, clientY: 500, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    // Re-select the text, then press Enter.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.pointerDown(cv, { clientX: 318, clientY: 318, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    fireEvent.keyDown(window, { key: 'Enter' });
    // No editor opens; the selection is cleared, so Delete takes the topmost
    // rect and the text survives.
    expect(screen.queryByPlaceholderText('Type text, Enter to commit…')).toBeNull();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(ref.current.getObjectIds()).toEqual([textId]);
  });
});

describe('LiveryCanvas tools — paint operations', () => {
  it('eyedropper picks the pixel colour and switches back to brush', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Picker' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    // Mock pixel is transparent black → #000000.
    expect(swatch().dataset.color).toBe('#000000');
    expect(screen.getByRole('button', { name: 'Brush' }).className).toContain('lp-active');
  });

  it('eyedropper picks a live object (sticker) colour, not just the base', async () => {
    const user = userEvent.setup();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    // The 1×1 eyedropper composite returns the object's pixel.
    getCtxSpy.mockImplementation(() => {
      const c = makeCtx();
      c.getImageData.mockImplementation((x, y, w, h) => {
        const data = new Uint8ClampedArray(Math.max(4, w * h * 4));
        if (w === 1 && h === 1) { data[0] = 0x12; data[1] = 0x34; data[2] = 0x56; data[3] = 255; }
        return { data, width: w, height: h };
      });
      ctxs.push(c);
      return c;
    });
    await user.click(screen.getByRole('button', { name: 'Picker' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    expect(swatch().dataset.color).toBe('#123456');
  });

  it('right-click picks the pixel colour without switching tools', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const color = () => swatch().dataset.color;
    expect(color()).toBe('#ff0000');
    fireEvent.pointerDown(mainCanvas(), { clientX: 10, clientY: 10, button: 2, pointerId: 1 });
    // Mock pixel is transparent black → #000000, and Select stays active.
    expect(color()).toBe('#000000');
    expect(screen.getByRole('button', { name: 'Select' }).className).toContain('lp-active');
  });

  it('suppresses the native context menu on the canvas', () => {
    renderCanvas();
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    mainCanvas().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('prevents the canvas mousedown default so an open text box keeps focus', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    const input = screen.getByPlaceholderText('Type text, Enter to commit…');
    // A real browser would move focus to the focusable wrapper on mousedown,
    // blurring the just-mounted input; canceling the default keeps it open.
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    mainCanvas().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(input).toBeInTheDocument();
    await user.type(input, 'hi');
    expect(input.value).toBe('hi');
  });

  it('fill floods the region and commits pixels to the fill layer', async () => {
    const user = userEvent.setup();
    renderCanvas();
    // The fill lives on its own layer (data-layer="fill"), under all movables.
    const fill = layerCtx('fill');
    expect(fill).toBeTruthy();
    // Small synthetic surface so the real flood fill stays cheap.
    fill.getImageData.mockReturnValue({ data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 });
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    expect(fill.putImageData).toHaveBeenCalled();
  });

  it('fill tolerance slider readout updates', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    const slider = screen.getByRole('slider', { name: /Tolerance/ });
    fireEvent.change(slider, { target: { value: '128' } });
    expect(slider.value).toBe('128');
    expect(screen.getByRole('textbox', { name: /Tolerance/ }).value).toBe('128');
  });

  it('fill tolerance accepts a typed number (commit on blur, clamped, invalid reverts)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    const field = screen.getByRole('textbox', { name: /Tolerance/ });
    const slider = screen.getByRole('slider', { name: /Tolerance/ });
    // Type an exact value: the slider follows on commit.
    await user.clear(field);
    await user.type(field, '200');
    fireEvent.blur(field);
    expect(slider.value).toBe('200');
    expect(field.value).toBe('200');
    // Out-of-range clamps to 255.
    fireEvent.change(field, { target: { value: '999' } });
    fireEvent.blur(field);
    expect(slider.value).toBe('255');
    expect(field.value).toBe('255');
    // Empty reverts to the live value.
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(slider.value).toBe('255');
    expect(field.value).toBe('255');
  });

  it('tolerance Escape discards the draft without touching the value', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    const field = screen.getByRole('textbox', { name: /Tolerance/ });
    const slider = screen.getByRole('slider', { name: /Tolerance/ });
    field.focus();
    fireEvent.change(field, { target: { value: '99' } });
    expect(field.value).toBe('99');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field.value).toBe('32');
    expect(slider.value).toBe('32');
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
      // The shape is previewed on the overlay (rAF) before it commits.
      await waitFor(() => expect(ctxs.some(c => c[probe].mock.calls.length > 0)).toBe(true));
    }
  });

  it('shape width + fill toggle controls render for shape tools', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    const width = screen.getByRole('slider', { name: /Width/ });
    fireEvent.change(width, { target: { value: '50' } });
    expect(screen.getByRole('textbox', { name: /Width/ }).value).toBe('50');
    // Icon-only fill toggle (scoped: the rail Fill tool shares the name).
    const bar = within(document.querySelector('.lp-optionsbar'));
    const fillToggle = bar.getByRole('button', { name: 'Fill' });
    expect(fillToggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(fillToggle);
    expect(fillToggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('shape width accepts a typed number (slider follows)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    const width = screen.getByRole('slider', { name: /Width/ });
    const field = screen.getByRole('textbox', { name: /Width/ });
    await user.clear(field);
    await user.type(field, '33');
    fireEvent.blur(field);
    expect(width.value).toBe('33');
    expect(field.value).toBe('33');
  });

  it('brush hard/soft toggle sets a shadow blur on the next stroke', async () => {
    const user = userEvent.setup();
    renderCanvas();
    expect(document.querySelector('.lp-optionsbar').textContent).not.toContain('%');
    // Soft edge sets a shadow blur on the next stroke.
    await user.click(screen.getByRole('button', { name: 'Soft' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 60, clientY: 60, button: 0, pointerId: 1 });
    fireEvent.pointerMove(mainCanvas(), { clientX: 80, clientY: 80, button: 0, pointerId: 1 });
    // The blur lands on the stroke-layer context the dabs are painted into.
    expect(ctxs.some(c => c.shadowBlur > 0)).toBe(true);
  });

  it('brush strokes paint opaque into the layer, then composite once with the picker alpha', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await setAlphaViaPicker(user, '0.5');
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const main = ctxs[0];
    // Dabs are opaque (#ff0000) so overlapping round caps cannot pile up...
    expect(ctxs.some(c => c.strokeStyle === '#ff0000')).toBe(true);
    // ...and the composite applies the 50% alpha exactly once per flush.
    expect(main.globalAlpha).toBe(0.5);
    expect(main.drawImage.mock.calls.some(a => a.length === 9)).toBe(true);
  });

  it('text commits carry the picker alpha and export translucent', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await setAlphaViaPicker(user, '0.5');
    await user.click(screen.getByRole('button', { name: 'Text' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    const input = screen.getByPlaceholderText('Type text, Enter to commit…');
    await user.type(input, 'hi');
    fireEvent.keyDown(input, { key: 'Enter' });
    act(() => { ref.current.exportPNG(); });
    const exportCtx = ctxs[ctxs.length - 1];
    expect(exportCtx.fillText).toHaveBeenCalledWith('hi', 0, 0);
    expect(exportCtx.globalAlpha).toBe(0.5);
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

  it('font size accepts a typed number (slider follows)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Text' }));
    const slider = screen.getByRole('slider', { name: /Size/ });
    const field = screen.getByRole('textbox', { name: /Size/ });
    await user.clear(field);
    await user.type(field, '150');
    fireEvent.blur(field);
    expect(slider.value).toBe('150');
    expect(field.value).toBe('150');
  });
});

describe('shape objects (selectable, movable)', () => {
  it('rect / ellipse / line commit as live objects, not rasterised', async () => {
    const user = userEvent.setup();
    renderCanvas();
    const cv = mainCanvas();
    for (const tool of ['Rect', 'Ellipse', 'Line']) {
      await user.click(screen.getByRole('button', { name: tool }));
      fireEvent.pointerDown(cv, { clientX: 40, clientY: 40, button: 0, pointerId: 1 });
      fireEvent.pointerMove(cv, { clientX: 200, clientY: 160, button: 0, pointerId: 1 });
      fireEvent.pointerUp(cv, { pointerId: 1 });
      // The shape became a selected live object; the shape tool stays active
      // so several shapes can be drawn in a row (no auto-switch to Select).
      expect(screen.getByRole('button', { name: tool }).className).toContain('lp-active');
      expect(screen.getByRole('button', { name: 'Select' }).className).not.toContain('lp-active');
      expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false);
      expect(screen.getByRole('button', { name: 'Duplicate Sticker' }).disabled).toBe(false);
    }
  });

  it('a committed shape can be picked up and moved with the Select tool', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    const cv = mainCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    await waitFor(() => expect(ctxs.some(c => c.translate.mock.calls.length > 0)).toBe(true));
    const startX = ctxs.find(c => c.translate.mock.calls.length > 0).translate.mock.calls[0][0];
    // Hand over to Select (the shape tool no longer auto-switches), then
    // Escape deselects; clicking the centre re-selects and drags it right.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    ctxs.length = 0;
    fireEvent.pointerDown(cv, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 190, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    await waitFor(() => {
      expect(ctxs.some(c => c.translate.mock.calls.some(([x]) => x > startX + 10))).toBe(true);
    });
  });

  it('"A" selects the Select tool', () => {
    renderCanvas();
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByRole('button', { name: 'Select' }).className).toContain('lp-active');
  });

  it('keeps previously drawn shapes selectable after a new one is drawn', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    const draw = async (tool, a, b) => {
      await user.click(screen.getByRole('button', { name: tool }));
      fireEvent.pointerDown(cv, { clientX: a[0], clientY: a[1], button: 0, pointerId: 1 });
      fireEvent.pointerMove(cv, { clientX: b[0], clientY: b[1], button: 0, pointerId: 1 });
      fireEvent.pointerUp(cv, { pointerId: 1 });
    };
    // Drawing a second shape must not flatten the first.
    await draw('Rect', [100, 100], [200, 200]);
    await draw('Ellipse', [400, 400], [500, 500]);
    expect(ref.current.getObjectCount()).toBe(2);
    // The first still responds to Select (click its centre and drag it right).
    await user.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.pointerDown(cv, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 190, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ref.current.getObjectCount()).toBe(2);
    // Removing the selected shape leaves the other one in place.
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(ref.current.getObjectCount()).toBe(1);
  });

  it('duplicate copies the selected shape without stamping the base', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    const draw = async (tool, a, b) => {
      await user.click(screen.getByRole('button', { name: tool }));
      fireEvent.pointerDown(cv, { clientX: a[0], clientY: a[1], button: 0, pointerId: 1 });
      fireEvent.pointerMove(cv, { clientX: b[0], clientY: b[1], button: 0, pointerId: 1 });
      fireEvent.pointerUp(cv, { pointerId: 1 });
    };
    await draw('Rect', [100, 100], [200, 200]);
    await draw('Ellipse', [400, 400], [500, 500]);
    // Select the rect, then duplicate it.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.pointerDown(cv, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const baseCtx = ctxs[0];
    const stamped = baseCtx.fill.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Duplicate Sticker' }));
    // Rect + ellipse + the copy all remain live; nothing is stamped on the base.
    expect(ref.current.getObjectCount()).toBe(3);
    expect(baseCtx.fill.mock.calls.length).toBe(stamped);
  });
});

describe('line curve mode', () => {
  async function selectCurve(user) {
    await user.click(screen.getByRole('button', { name: 'Line' }));
    await user.click(screen.getByRole('button', { name: 'Curve' }));
  }
  const clickPoint = (cv, x, y) => {
    fireEvent.pointerDown(cv, { clientX: x, clientY: y, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
  };

  it('offers a Straight/Curve toggle only for the Line tool', async () => {
    const user = userEvent.setup();
    renderCanvas();
    expect(screen.queryByRole('button', { name: 'Curve' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Line' }));
    expect(screen.getByRole('button', { name: 'Straight' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Curve' })).toBeInTheDocument();
    // Straight is the default sub-mode.
    expect(screen.getByRole('button', { name: 'Straight' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('commits clicked control points as a selectable curve object on Enter', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await selectCurve(user);
    clickPoint(cv, 100, 100);
    clickPoint(cv, 200, 200);
    clickPoint(cv, 300, 120);
    expect(ref.current.getObjectCount()).toBe(0); // still a draft
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(ref.current.getObjectCount()).toBe(1);
    // The line tool stays in curve mode for the next curve.
    expect(screen.getByRole('button', { name: 'Line' }).className).toContain('lp-active');
    expect(screen.getByRole('button', { name: 'Curve' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('commits a curve on double-click too', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await selectCurve(user);
    clickPoint(cv, 100, 100);
    clickPoint(cv, 200, 200);
    fireEvent.doubleClick(cv, { clientX: 250, clientY: 150 });
    expect(ref.current.getObjectCount()).toBe(1);
  });

  it('Escape cancels the draft and a degenerate draft never commits', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await selectCurve(user);
    clickPoint(cv, 100, 100);
    clickPoint(cv, 200, 200);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(ref.current.getObjectCount()).toBe(0);
    // A single control point is not enough to commit.
    clickPoint(cv, 120, 120);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(ref.current.getObjectCount()).toBe(0);
  });

  it('right-click pops the last control point, then cancels a lone one', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await selectCurve(user);
    clickPoint(cv, 100, 100);
    clickPoint(cv, 200, 200);
    // First right-press drops the second point; the draft still has one and
    // Enter is a no-op.
    fireEvent.pointerDown(cv, { clientX: 200, clientY: 200, button: 2, pointerId: 1 });
    fireEvent.contextMenu(cv, { clientX: 200, clientY: 200, button: 2 });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(ref.current.getObjectCount()).toBe(0);
    // Second right-press cancels the lone point outright.
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 2, pointerId: 1 });
    fireEvent.contextMenu(cv, { clientX: 100, clientY: 100, button: 2 });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(ref.current.getObjectCount()).toBe(0);
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

  it('undo removes a just-drawn object (objects ride along in the snapshots)', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ref.current.getObjectCount()).toBe(1);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(ref.current.getObjectCount()).toBe(0);
    // Redo restores it.
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    expect(ref.current.getObjectCount()).toBe(1);
  });

  it('clear asks for confirmation and resets the canvas to the default base', async () => {
    const user = userEvent.setup();
    renderCanvas();
    // The default base is painted on the base layer.
    const fillRect = layerCtx('base').fillRect;
    const before = fillRect.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByText('Confirm Clear')).toBeInTheDocument());
    await user.click(screen.getByText('Clear', { selector: '.btn-danger' }).closest('button'));
    await waitFor(() => expect(fillRect.mock.calls.length).toBeGreaterThan(before));
  });

  it('clear re-draws the aircraft default-livery base image when one is primed', async () => {
    const user = userEvent.setup();
    renderCanvas({ initialImageDataUrl: 'data:image/png;base64,TEMPLATE' });
    // Mount primed the base image on the base layer (async image load).
    await waitFor(() => {
      expect(layerCtx('base').drawImage.mock.calls.some(c => c.length === 5)).toBe(true);
    });
    const before = layerCtx('base').drawImage.mock.calls.filter(c => c.length === 5).length;
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByText('Confirm Clear')).toBeInTheDocument());
    await user.click(screen.getByText('Clear', { selector: '.btn-danger' }).closest('button'));
    await waitFor(() => {
      const after = layerCtx('base').drawImage.mock.calls.filter(c => c.length === 5).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('clear restores the aircraft default livery even when a saved origin image is open', async () => {
    const user = userEvent.setup();
    renderCanvas({
      initialImageDataUrl: 'data:image/png;base64,SAVEDORIGIN',
      defaultLiveryDataUrl: 'data:image/png;base64,DEFAULTLIVERY',
    });
    await waitFor(() => expect(imageSrcs).toContain('data:image/png;base64,SAVEDORIGIN'));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByText('Confirm Clear')).toBeInTheDocument());
    await user.click(screen.getByText('Clear', { selector: '.btn-danger' }).closest('button'));
    await waitFor(() => {
      expect(imageSrcs[imageSrcs.length - 1]).toBe('data:image/png;base64,DEFAULTLIVERY');
    });
  });

  it('clear cancel keeps the canvas untouched', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByText('Confirm Clear')).toBeInTheDocument());
    const before = ctxs[0].fillRect.mock.calls.length;
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Confirm Clear')).toBeNull());
    expect(ctxs[0].fillRect.mock.calls.length).toBe(before);
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

  it('tool shortcuts still fire while the size slider has focus', () => {
    renderCanvas();
    fireEvent.keyDown(window, { key: 'e' });
    expect(screen.getByRole('button', { name: 'Eraser' }).className).toContain('lp-active');
    // The eraser size is a range input, so its focus is where it lands after a
    // drag — every shortcut used to be swallowed there, including A→Select.
    const slider = document.querySelector('.lp-optionsbar input[type="range"]');
    expect(slider).toBeTruthy();
    slider.focus();
    fireEvent.keyDown(slider, { key: 'a', bubbles: true });
    expect(screen.getByRole('button', { name: 'Select' }).className).toContain('lp-active');
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

  it('wheel zooms using the cursor position as the anchor', async () => {
    renderCanvas();
    const wrap = document.querySelector('.livery-canvas-wrap');
    const pct = () => document.querySelector('.lp-zoom-pct').textContent;
    expect(pct()).toBe('24%'); // fit
    fireEvent.wheel(wrap, { deltaY: -120, clientX: 120, clientY: 120 });
    await waitFor(() => expect(pct()).toBe('25%'));
    fireEvent.wheel(wrap, { deltaY: 120, clientX: 120, clientY: 120 });
    await waitFor(() => expect(pct()).toBe('13%'));
  });

  it('shows a hand icon following the pointer while Space is held', async () => {
    renderCanvas();
    const hand = () => document.querySelector('.lp-hand-cursor');
    expect(hand().style.display).toBe('none');
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(hand().style.display).toBe('block'));
    expect(mainCanvas().style.cursor).toBe('none');
    fireEvent.pointerMove(document.querySelector('.livery-canvas-wrap'), { clientX: 60, clientY: 70 });
    expect(hand().style.transform).toContain('60px');
    expect(hand().style.transform).toContain('70px');
    fireEvent.keyUp(window, { key: ' ' });
    await waitFor(() => expect(hand().style.display).toBe('none'));
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

  it('keys pressed while a save popup is open keep the movable selected', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getSelectedId()).not.toBeNull());
    // Simulate the post-save popup (save naming / overwrite / mod hint).
    await act(async () => { useAppStore.getState().showModal('title', 'body'); });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Delete' });
    fireEvent.keyDown(window, { key: 'e' });
    // Selection survived and nothing was removed or mutated behind the popup.
    expect(ref.current.getSelectedId()).not.toBeNull();
    expect(ref.current.getObjectCount()).toBe(1);
    // After the popup closes the shortcuts work again.
    await act(async () => { useAppStore.getState().hideModal(); });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(ref.current.getSelectedId()).toBeNull();
    expect(ref.current.getObjectCount()).toBe(1);
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
    expect(Array.isArray(payload.images)).toBe(true);
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].imageDataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('custom RGBA colour picker', () => {
  it('opens from the swatch with hue, alpha and hex controls', async () => {
    const user = userEvent.setup();
    renderCanvas();
    expect(screen.queryByRole('dialog', { name: 'Color' })).toBeNull();
    await user.click(swatch());
    const dialog = screen.getByRole('dialog', { name: 'Color' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('slider', { name: 'Hue' })).toBeInTheDocument();
    expect(within(dialog).getByRole('slider', { name: 'Opacity' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Hex colour').value).toBe('#ff0000');
    expect(swatch().getAttribute('aria-expanded')).toBe('true');
  });

  it('updates the swatch hex, alpha and the stroke from the popover', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(swatch());
    const dialog = screen.getByRole('dialog', { name: 'Color' });
    fireEvent.change(within(dialog).getByLabelText('Hex colour'), { target: { value: '#00ff00' } });
    fireEvent.blur(within(dialog).getByLabelText('Hex colour'));
    fireEvent.change(within(dialog).getByRole('slider', { name: 'Opacity' }), { target: { value: '0.5' } });
    expect(swatch().dataset.color).toBe('#00ff00');
    expect(within(dialog).getByText('50%')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Color' })).toBeNull();
    // The next stroke uses the picked colour + alpha.
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ctxs.some(c => c.strokeStyle === '#00ff00')).toBe(true);
    expect(ctxs[0].globalAlpha).toBe(0.5);
  });

  it('dragging the saturation/value square picks a dimmed colour', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(swatch());
    const dialog = screen.getByRole('dialog', { name: 'Color' });
    const sv = within(dialog).getByRole('slider', { name: 'Colour area' });
    // The jsdom rect is 512×512, so the centre is s=0.5, v=0.5 → half-red grey.
    fireEvent.pointerDown(sv, { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerMove(sv, { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sv, { pointerId: 1 });
    expect(swatch().dataset.color).toBe('#804040');
  });

  it('a saturation/value pick changes the hue-derived colour', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(swatch());
    const dialog = screen.getByRole('dialog', { name: 'Color' });
    // Hue rail at 240° → blue (the SV square keeps its own s/v).
    fireEvent.change(within(dialog).getByRole('slider', { name: 'Hue' }), { target: { value: '240' } });
    expect(swatch().dataset.color).toBe('#0000ff');
  });

  it('clicking the backdrop closes the picker without changing the colour', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(swatch());
    fireEvent.pointerDown(document.querySelector('.lp-color-backdrop'), { button: 0 });
    expect(screen.queryByRole('dialog', { name: 'Color' })).toBeNull();
    expect(swatch().dataset.color).toBe('#ff0000');
  });

  it('toggling the swatch again closes the picker', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(swatch());
    expect(screen.getByRole('dialog', { name: 'Color' })).toBeInTheDocument();
    await user.click(swatch());
    expect(screen.queryByRole('dialog', { name: 'Color' })).toBeNull();
  });
});

describe('brushRgba (rail RGBA colour helper)', () => {
  it('bakes the rail alpha into an rgba() style', () => {
    expect(brushRgba({ color: '#ff0000', opacity: 1 })).toBe('rgba(255,0,0,1)');
    expect(brushRgba({ color: '#00ff00', opacity: 0.5 })).toBe('rgba(0,255,0,0.5)');
    expect(brushRgba({ color: '#0000ff' })).toBe('rgba(0,0,255,1)');
  });
});

describe('multi-image panels (A388/B38M)', () => {
  const panels = [{ partName: 'Fuselage' }, { partName: 'Wing' }];
  const initialParts = [
    { partName: 'Fuselage', imageDataUrl: 'data:image/png;base64,FUSE' },
    { partName: 'Wing', imageDataUrl: 'data:image/png;base64,WING' },
  ];

  it('lays out two 2048 squares with a 128px gap', async () => {
    const onActivePanel = vi.fn();
    renderCanvas({ panels, initialParts, defaultParts: initialParts, activePanel: 0, onActivePanel });
    const cv = layerCanvas('base');
    // 2 × 2048 + a 128px gutter.
    expect(cv.width).toBe(4224);
    expect(cv.height).toBe(2048);
    // No tab strip — the active panel is chosen by clicking on the canvas.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('clicking inside a panel makes it the active one (all tools)', async () => {
    const onActivePanel = vi.fn();
    renderCanvas({ panels, initialParts, defaultParts: initialParts, activePanel: 0, onActivePanel });
    const cv = mainCanvas();
    // Panel 1 centre: texture x = 2176 + 1024 → client /4.
    fireEvent.pointerDown(cv, { clientX: (2176 + 1024) / 4, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(onActivePanel).toHaveBeenCalledWith(1);
    expect(onActivePanel).not.toHaveBeenCalledWith(0);
  });

  it('one click on another panel both activates it and paints the brush dab', async () => {
    const onActivePanel = vi.fn();
    renderCanvas({ panels, initialParts, defaultParts: initialParts, activePanel: 0, onActivePanel });
    const cv = mainCanvas();
    // A single pointerdown/up on panel 1 — no drag, no second click.
    fireEvent.pointerDown(cv, { clientX: (2176 + 1024) / 4, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(onActivePanel).toHaveBeenCalledWith(1);
    // The same click deposited the brush dab (zero-length round-cap stroke).
    expect(ctxs.some(c => c.stroke.mock.calls.length > 0)).toBe(true);
    expect(ctxs[0].drawImage.mock.calls.some(a => a.length === 9)).toBe(true);
  });

  it('a click in the gutter activates the nearest panel', () => {
    const onActivePanel = vi.fn();
    renderCanvas({ panels, initialParts, defaultParts: initialParts, activePanel: 0, onActivePanel });
    const cv = mainCanvas();
    // Gutter spans x=2048..2176; x=2140 is nearer panel 1 (origin 2176).
    fireEvent.pointerDown(cv, { clientX: 2140 / 4, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(onActivePanel).toHaveBeenCalledWith(1);
  });

  it('confines a lasso selection to the active panel', async () => {
    const user = userEvent.setup();
    renderCanvas({ panels, initialParts, defaultParts: initialParts, activePanel: 1 });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Lasso' }));
    const cv = mainCanvas();
    // Lasso a triangle inside panel 1 (texture 2176..4224).
    fireEvent.pointerDown(cv, { clientX: (2176 + 400) / 4, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: (2176 + 800) / 4, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: (2176 + 600) / 4, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { clientX: (2176 + 600) / 4, clientY: 200, button: 0, pointerId: 1 });
    // The mask fill is clipped to the ACTIVE panel's 2048² rect (x=2176), so the
    // selection can never bleed across the gutter into panel 0.
    expect(ctxs.some(c => c.rect.mock.calls.some(a => a[0] === 2176 && a[2] === TEXTURE && a[3] === TEXTURE))).toBe(true);
    expect(ctxs.some(c => c.clip.mock.calls.length > 0)).toBe(true);
  });

  it('keyboard shortcuts never change the active panel', async () => {
    const onActivePanel = vi.fn();
    const ref = React.createRef();
    renderCanvas({ panels, initialParts, defaultParts: initialParts, activePanel: 0, onActivePanel, ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    // Flips (H/V), tool switches (A/B/E/G/L/R/O/T) and import (I) must not
    // touch the active panel — only a canvas click does.
    for (const key of ['h', 'v', 'b', 'a', 'e', 'g', 'l', 'r', 'o', 't']) {
      fireEvent.keyDown(window, { key });
    }
    expect(onActivePanel).not.toHaveBeenCalled();
  });

  it('exports one 2048 PNG per panel, in order', async () => {
    const ref = React.createRef();
    renderCanvas({ panels, initialParts, defaultParts: initialParts, ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const parts = ref.current.exportParts();
    expect(parts.map(p => p.partName)).toEqual(['Fuselage', 'Wing']);
    expect(parts[0].imageDataUrl).toBe(FAKE_SAVE);
    expect(parts[1].imageDataUrl).toBe(FAKE_SAVE);
    // exportPNG still returns the whole flattened (wide) texture.
    expect(ref.current.exportPNG()).toBe(FAKE_SAVE);
  });

  it('a single-panel canvas exports a one-entry Body list', async () => {
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const parts = ref.current.exportParts();
    expect(parts).toHaveLength(1);
    expect(parts[0].partName).toBe('Body');
  });

  it('imports a sticker onto the active panel', async () => {
    const ref = React.createRef();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    renderCanvas({ panels, initialParts, defaultParts: initialParts, activePanel: 1, ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    const info = ref.current.getObjectInfo();
    // The second panel starts after 2048 + the 128px gutter; the sticker
    // centres on that panel, not on the whole wide store.
    expect(info.x).toBe(2176 + 1024);
    expect(info.y).toBe(1024);
  });

  it('lets an object move outside the active panel (overflow is not clamped)', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ panels, initialParts, defaultParts: initialParts, activePanel: 0, ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    // A big rect on panel 0 (its centre is well clear of the corner handles).
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    const cv = mainCanvas();
    // Multi-panel store is 4224×2048 over the stubbed 512×512 rect.
    const cx = (tx) => tx * (512 / 4224);
    const cy = (ty) => ty * (512 / 2048);
    fireEvent.pointerDown(cv, { clientX: cx(400), clientY: cy(400), button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: cx(1200), clientY: cy(1200), button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const before = ref.current.getObjectInfo();
    expect(before.x).toBe(800);
    // Select it and drag its centre over panel 1 (texture x=3000).
    await user.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.pointerDown(cv, { clientX: cx(before.x), clientY: cy(before.y), button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: cx(3000), clientY: cy(before.y), button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const after = ref.current.getObjectInfo();
    // Movement is NOT bounded: the centre follows the pointer past the panel.
    expect(after.x).toBeGreaterThan(2048);
    // The object renders in ITS panel (panel 1 → x=2176) even though the active
    // panel is still 0 — unselected movables show on every panel they occupy.
    await waitFor(() => {
      expect(ctxs.some(c => c.rect.mock.calls.some(a => a[0] === 2176 && a[2] === 2048))).toBe(true);
    });
    // The overflow is clipped (not rendered) to that panel.
    await waitFor(() => expect(ctxs.some(c => c.clip.mock.calls.length > 0)).toBe(true));
    // SAVING must clip the object to ITS panel (panel 1 → x=2176), NOT the
    // active one (0) — otherwise a save would move/lose a sticker.
    const seen = new Set(ctxs);
    act(() => { ref.current.exportParts(); });
    const fresh = ctxs.filter(c => !seen.has(c));
    expect(fresh.some(c => c.rect.mock.calls.some(a => a[0] === 2176 && a[2] === 2048))).toBe(true);
    expect(fresh.some(c => c.rect.mock.calls.some(a => a[0] === 0 && a[2] === 2048))).toBe(false);
  });
});

describe('overlay padding (selection chrome outside the canvas)', () => {
  it('sizes the overlay canvas past the store so an off-canvas selection box shows', () => {
    renderCanvas();
    const stage = document.querySelector('.lp-canvas-stage');
    const canvases = stage.querySelectorAll('canvas');
    expect(canvases.length).toBeGreaterThanOrEqual(2);
    const overlay = layerCanvas('chrome');
    expect(overlay.width).toBe(TEXTURE + OVERLAY_PAD * 2);
    expect(overlay.height).toBe(TEXTURE + OVERLAY_PAD * 2);
    // Negative offset parks the padded area around the base bitmap.
    expect(parseFloat(overlay.style.left)).toBeLessThan(0);
    expect(parseFloat(overlay.style.top)).toBeLessThan(0);
  });

  it('pads the overlay for a multi-image canvas too', () => {
    const panels = [{ partName: 'Fuselage' }, { partName: 'Wing' }];
    renderCanvas({ panels });
    const overlay = layerCanvas('chrome');
    // 2 × 2048 + a 128px gutter, plus the pad on both sides.
    expect(overlay.width).toBe(4224 + OVERLAY_PAD * 2);
  });
});

describe('panelLayout (pure multi-image helper)', () => {
  it('lays out one full-width panel and adds a gutter for more', () => {
    const one = panelLayout(1);
    expect(one).toMatchObject({ count: 1, gap: 0, width: 2048, height: 2048 });
    expect(one.x(0)).toBe(0);
    const two = panelLayout(2);
    expect(two).toMatchObject({ count: 2, gap: 128, width: 4224, height: 2048 });
    expect(two.x(0)).toBe(0);
    expect(two.x(1)).toBe(2176);
    expect(two.x(2)).toBe(4352);
    // Never fewer than one panel (0/undefined/negative).
    expect(panelLayout(0).count).toBe(1);
    expect(panelLayout(undefined).count).toBe(1);
  });
});

describe('reorderObjects (pure layer-order helper)', () => {
  const objs = () => [{ id: 1 }, { id: 2 }, { id: 3 }];

  it('front moves an object to the top end', () => {
    expect(reorderObjects(objs(), 1, 'front').map(o => o.id)).toEqual([2, 3, 1]);
    expect(reorderObjects(objs(), 2, 'front').map(o => o.id)).toEqual([1, 3, 2]);
  });

  it('back moves an object to the bottom start', () => {
    expect(reorderObjects(objs(), 3, 'back').map(o => o.id)).toEqual([3, 1, 2]);
    expect(reorderObjects(objs(), 2, 'back').map(o => o.id)).toEqual([2, 1, 3]);
  });

  it('forward / backward swap exactly one step', () => {
    expect(reorderObjects(objs(), 1, 'forward').map(o => o.id)).toEqual([2, 1, 3]);
    expect(reorderObjects(objs(), 2, 'backward').map(o => o.id)).toEqual([2, 1, 3]);
    expect(reorderObjects(objs(), 3, 'backward').map(o => o.id)).toEqual([1, 3, 2]);
    expect(reorderObjects(objs(), 2, 'forward').map(o => o.id)).toEqual([1, 3, 2]);
  });

  it('moves past the ends are no-ops returning the same array', () => {
    const top = objs();
    expect(reorderObjects(top, 3, 'front')).toBe(top);
    expect(reorderObjects(top, 3, 'forward')).toBe(top);
    expect(reorderObjects(top, 1, 'back')).toBe(top);
    expect(reorderObjects(top, 1, 'backward')).toBe(top);
  });

  it('an unknown id returns the input untouched', () => {
    const input = objs();
    expect(reorderObjects(input, 99, 'front')).toBe(input);
  });

  it('an unknown direction returns the input untouched', () => {
    const input = objs();
    expect(reorderObjects(input, 2, 'sideways')).toBe(input);
  });

  it('does not mutate the input array', () => {
    const input = objs();
    reorderObjects(input, 1, 'front');
    expect(input.map(o => o.id)).toEqual([1, 2, 3]);
  });
});

describe('layer-order menu (right-click)', () => {
  // Two non-overlapping rects: A at client (100,100)-(200,200), B at
  // (400,400)-(500,500). Bottom→top stack is [A, B]; A-centre = (150,150).
  async function drawTwoRects(user, ref) {
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    const draw = async (a, b) => {
      await user.click(screen.getByRole('button', { name: 'Rect' }));
      fireEvent.pointerDown(cv, { clientX: a[0], clientY: a[1], button: 0, pointerId: 1 });
      fireEvent.pointerMove(cv, { clientX: b[0], clientY: b[1], button: 0, pointerId: 1 });
      fireEvent.pointerUp(cv, { pointerId: 1 });
    };
    await draw([100, 100], [200, 200]);
    await draw([400, 400], [500, 500]);
    expect(ref.current.getObjectCount()).toBe(2);
    // The order menu is a Select-tool (object sub-mode) affordance now.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    return ref.current.getObjectIds();
  }

  it('right-click on a shape opens the menu; Send to top reorders and closes it', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const [idA, idB] = await drawTwoRects(user, ref);
    fireEvent.contextMenu(mainCanvas(), { clientX: 150, clientY: 150, button: 2 });
    await screen.findByRole('menu');
    // A is the bottom object: upward moves enabled, downward moves disabled.
    expect(screen.getByRole('menuitem', { name: 'Send to top' }).disabled).toBe(false);
    expect(screen.getByRole('menuitem', { name: 'Bring forward' }).disabled).toBe(false);
    expect(screen.getByRole('menuitem', { name: 'Send backward' }).disabled).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Send to bottom' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send to top' }));
    expect(ref.current.getObjectIds()).toEqual([idB, idA]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a topmost target disables the upward moves; a lone object disables all four', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await drawTwoRects(user, ref);
    // B-centre (450,450): B is topmost.
    fireEvent.contextMenu(mainCanvas(), { clientX: 450, clientY: 450, button: 2 });
    await screen.findByRole('menu');
    expect(screen.getByRole('menuitem', { name: 'Send to top' }).disabled).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Bring forward' }).disabled).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Send backward' }).disabled).toBe(false);
    expect(screen.getByRole('menuitem', { name: 'Send to bottom' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send to bottom' }));
    expect(screen.queryByRole('menu')).toBeNull();
    // Back down to a single object: every move is a no-op, all disabled.
    // (The survivor is B at 450,450 — Delete took the reordered tail A.)
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(ref.current.getObjectCount()).toBe(1);
    fireEvent.contextMenu(mainCanvas(), { clientX: 450, clientY: 450, button: 2 });
    await screen.findByRole('menu');
    for (const name of ['Send to top', 'Bring forward', 'Send backward', 'Send to bottom']) {
      expect(screen.getByRole('menuitem', { name }).disabled).toBe(true);
    }
  });

  it('Escape dismisses the menu without touching the stack', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const before = await drawTwoRects(user, ref);
    fireEvent.contextMenu(mainCanvas(), { clientX: 150, clientY: 150, button: 2 });
    await screen.findByRole('menu');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(ref.current.getObjectIds()).toEqual(before);
  });

  it('backdrop pointerdown dismisses the menu', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await drawTwoRects(user, ref);
    fireEvent.contextMenu(mainCanvas(), { clientX: 150, clientY: 150, button: 2 });
    await screen.findByRole('menu');
    fireEvent.pointerDown(document.querySelector('.lp-order-backdrop'), { button: 0 });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(ref.current.getObjectCount()).toBe(2);
  });

  it('right-click on empty canvas dismisses the menu (and keeps the colour pick)', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await drawTwoRects(user, ref);
    const cv = mainCanvas();
    fireEvent.contextMenu(cv, { clientX: 150, clientY: 150, button: 2 });
    await screen.findByRole('menu');
    // A full right-click is pointerdown (colour pick on empty canvas) +
    // contextmenu (menu dismissal when nothing is hit).
    fireEvent.pointerDown(cv, { clientX: 10, clientY: 10, button: 2, pointerId: 1 });
    fireEvent.contextMenu(cv, { clientX: 10, clientY: 10, button: 2 });
    expect(screen.queryByRole('menu')).toBeNull();
    // Empty-canvas right-click still picks the pixel colour (transparent black).
    expect(swatch().dataset.color).toBe('#000000');
  });

  it('left-click dismisses an open menu', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await drawTwoRects(user, ref);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const cv = mainCanvas();
    fireEvent.contextMenu(cv, { clientX: 150, clientY: 150, button: 2 });
    await screen.findByRole('menu');
    fireEvent.pointerDown(cv, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('right pointer press selects the object under the cursor without opening the menu', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const [, idB] = await drawTwoRects(user, ref);
    const cv = mainCanvas();
    fireEvent.keyDown(window, { key: 'Escape' }); // deselect (B was selected)
    fireEvent.pointerDown(cv, { clientX: 150, clientY: 150, button: 2, pointerId: 1 });
    expect(screen.queryByRole('menu')).toBeNull();
    // The bottom object (not the topmost) is now selected: Delete takes it.
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(ref.current.getObjectIds()).toEqual([idB]);
  });

  it('Delete with no selection removes the topmost object', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const [idA] = await drawTwoRects(user, ref);
    fireEvent.keyDown(window, { key: 'Escape' }); // deselect
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(ref.current.getObjectCount()).toBe(1);
    expect(ref.current.getObjectIds()).toEqual([idA]);
  });

  it('right-click outside Select mode picks the colour, never the movable menu', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await drawTwoRects(user, ref);
    await user.click(screen.getByRole('button', { name: 'Lasso' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 150, clientY: 150, button: 2, pointerId: 1 });
    fireEvent.contextMenu(cv, { clientX: 150, clientY: 150, button: 2 });
    expect(screen.queryByRole('menu')).toBeNull();
    // The pen tool's right-click is a colour pick (transparent base → black).
    expect(swatch().dataset.color).toBe('#000000');
  });

  it('Ctrl+D with no selection mask clears the selected object', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const [idA] = await drawTwoRects(user, ref);
    const cv = mainCanvas();
    // Select the bottom object A explicitly (B is selected after drawing).
    fireEvent.pointerDown(cv, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    // Ctrl+D dropped the selection, so Delete takes the topmost B — not A.
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(ref.current.getObjectIds()).toEqual([idA]);
  });

  it('a keyboard tool shortcut dismisses the menu and switches tool', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    await drawTwoRects(user, ref);
    fireEvent.contextMenu(mainCanvas(), { clientX: 150, clientY: 150, button: 2 });
    await screen.findByRole('menu');
    fireEvent.keyDown(window, { key: 'b' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Brush' }).className).toContain('lp-active');
  });

  it('reorderObject via ref moves the named object without a menu', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const [idA, idB] = await drawTwoRects(user, ref);
    act(() => { ref.current.reorderObject('backward', idB); });
    expect(ref.current.getObjectIds()).toEqual([idB, idA]);
    act(() => { ref.current.reorderObject('forward', idB); });
    expect(ref.current.getObjectIds()).toEqual([idA, idB]);
  });

  it('undo restores the order after a reorder', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    const [idA, idB] = await drawTwoRects(user, ref);
    act(() => { ref.current.reorderObject('front', idA); });
    expect(ref.current.getObjectIds()).toEqual([idB, idA]);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(ref.current.getObjectIds()).toEqual([idA, idB]);
  });

  it('a keyboard tool shortcut commits an in-progress shape drag', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    expect(ref.current.getObjectCount()).toBe(0); // still a preview
    fireEvent.keyDown(window, { key: 'b' });
    expect(ref.current.getObjectCount()).toBe(1);
    expect(screen.getByRole('button', { name: 'Brush' }).className).toContain('lp-active');
  });
});

describe('selection mask', () => {
  // Draw a pen lasso triangle (down + two moves + up) with Select active.
  async function selectPen(user) {
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Lasso' }));
  }
  function lassoTriangle() {
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 150, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { clientX: 150, clientY: 200, button: 0, pointerId: 1 });
  }
  // The main canvas is mounted first, so its context leads ctxs; double-check
  // via the opaque base fill no other canvas performs.
  function mainCtx() {
    // The paint layer is where raster paints and the mask clip read/write.
    const found = paintCtx();
    expect(found).toBeTruthy();
    return found;
  }

  it('selection keys resolve in zh + en', () => {
    const keys = [
      'livery_paint_select_mode', 'livery_paint_select_object', 'livery_paint_select_pen',
      'livery_paint_select_wand', 'livery_paint_mask_mode', 'livery_paint_mask_combine',
      'livery_paint_mask_erase', 'livery_paint_mask_replace', 'livery_paint_deselect',
      'livery_help_d_select',
    ];
    setLang('en');
    for (const k of keys) expect(T(k)).not.toBe(k);
    setLang('zh');
    for (const k of keys) expect(T(k)).not.toBe(k);
    setLang('en');
  });

  it('offers Object/Pen/Wand modes defaulting to Object + Combine', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getByRole('button', { name: 'Object' }).getAttribute('aria-pressed')).toBe('true');
    // No combine row in object mode.
    expect(screen.queryByRole('button', { name: 'Combine' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Lasso' }));
    expect(screen.getByRole('button', { name: 'Lasso' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Object' }).getAttribute('aria-pressed')).toBe('false');
    // Combine row appears, defaulting to Combine.
    expect(screen.getByRole('button', { name: 'Combine' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Erase' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Replace' }).getAttribute('aria-pressed')).toBe('false');
    // Erase / Replace switch the op.
    await user.click(screen.getByRole('button', { name: 'Erase' }));
    expect(screen.getByRole('button', { name: 'Erase' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Combine' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('wand mode shows the tolerance slider', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Magic Wand' }));
    // The wand reuses the fill tolerance control (label carries the value).
    const slider = screen.getByRole('slider', { name: /Tolerance/ });
    expect(slider.value).toBe('32');
    expect(slider.parentElement.textContent).toContain('Tolerance');
  });

  it('wand tolerance accepts a typed number via Enter', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Magic Wand' }));
    const field = screen.getByRole('textbox', { name: /Tolerance/ });
    const slider = screen.getByRole('slider', { name: /Tolerance/ });
    field.focus();
    fireEvent.change(field, { target: { value: '64' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(slider.value).toBe('64');
    expect(field.value).toBe('64');
  });

  it('sub-mode shortcuts A / L / W work and show in the tooltips', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const tipFor = (name) => {
      const btn = screen.getByRole('button', { name });
      fireEvent.mouseEnter(btn);
      const tip = document.body.querySelector('.tooltip-popup');
      const text = tip ? tip.textContent : '';
      fireEvent.mouseLeave(btn);
      return text;
    };
    expect(tipFor('Object')).toContain('(A)');
    expect(tipFor('Lasso')).toContain('(L)');
    expect(tipFor('Magic Wand')).toContain('(W)');
    // Shortcuts switch the sub-mode while Select is active.
    fireEvent.keyDown(window, { key: 'l' });
    expect(screen.getByRole('button', { name: 'Lasso' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'w' });
    expect(screen.getByRole('button', { name: 'Magic Wand' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByRole('button', { name: 'Object' }).getAttribute('aria-pressed')).toBe('true');
    // Reachable from another tool: from Brush, L jumps to Select + Lasso.
    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'l' });
    expect(screen.getByRole('button', { name: 'Lasso' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Select' }).className).toContain('lp-active');
    // Line moved to U, circle (ellipse) to M.
    expect(tipFor('Line')).toContain('(U)');
    expect(tipFor('Ellipse')).toContain('(M)');
    fireEvent.keyDown(window, { key: 'u' });
    expect(screen.getByRole('button', { name: 'Line' }).className).toContain('lp-active');
  });

  it('pen lasso creates a selection with a dotted outline + Deselect', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await selectPen(user);
    // Deselect is always visible, disabled until a selection exists.
    expect(screen.getByRole('button', { name: 'Deselect' })).toBeDisabled();
    lassoTriangle();
    // Region painted into the mask (closed path fill — closePath is only
    // used by the selection overlay paths).
    expect(ctxs.some(c => c.closePath.mock.calls.length > 0)).toBe(true);
    // Dotted outline: a dashed (non-empty) setLineDash on the overlay (rAF).
    await waitFor(() => expect(
      ctxs.some(c => c.setLineDash.mock.calls.some(a => Array.isArray(a[0]) && a[0].length > 0))
    ).toBe(true));
    // Deselect appears once a selection exists.
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeDisabled();
  });

  it('Deselect drops the selection', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await selectPen(user);
    lassoTriangle();
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Deselect' }));
    expect(screen.getByRole('button', { name: 'Deselect' })).toBeDisabled();
  });

  it('Ctrl+D drops the selection (Deselect shortcut)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await selectPen(user);
    lassoTriangle();
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeDisabled();
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Deselect' })).toBeDisabled();
  });

  it('a tap lasso selects nothing', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await selectPen(user);
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    expect(ctxs.every(c => c.closePath.mock.calls.length === 0)).toBe(true);
    expect(screen.getByRole('button', { name: 'Deselect' })).toBeDisabled();
  });

  it('Escape cancels an in-progress lasso', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await selectPen(user);
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    expect(ctxs.every(c => c.closePath.mock.calls.length === 0)).toBe(true);
    expect(screen.getByRole('button', { name: 'Deselect' })).toBeDisabled();
  });

  it('wand click floods the connected base region into the mask', async () => {
    const user = userEvent.setup();
    renderCanvas();
    // 5x5 white base: the seed floods everything (5 one-pixel-high spans).
    const white = new Uint8ClampedArray(5 * 5 * 4).fill(255);
    mainCtx().getImageData.mockReturnValue({ data: white, width: 5, height: 5 });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Magic Wand' }));
    // Near-origin click: texture (4,4) lands inside the 5x5 stub.
    fireEvent.pointerDown(mainCanvas(), { clientX: 1, clientY: 1, button: 0, pointerId: 1 });
    // Region runs painted (height-1 fillRects — the base fill is 2048 high).
    expect(ctxs.some(c => c.fillRect.mock.calls.some(a => a[3] === 1))).toBe(true);
    // Composited into the mask.
    expect(ctxs.some(c => c.drawImage.mock.calls.length > 0)).toBe(true);
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeNull();
  });

  it('wand samples the composited movable layer, not just the base', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ref.current.getObjectCount()).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Magic Wand' }));
    // Clear the histories after the last render, then flood: the wand must
    // render the live rectangle into its sample buffer before reading it
    // (rect/fill are the object draw; the region spans only use fillRect).
    ctxs.forEach((c) => { c.rect.mockClear(); c.fill.mockClear(); c.stroke.mockClear(); });
    fireEvent.pointerDown(cv, { clientX: 1, clientY: 1, button: 0, pointerId: 1 });
    expect(ctxs.some(c => c.rect.mock.calls.length > 0 || c.fill.mock.calls.length > 0)).toBe(true);
    expect(ctxs.some(c => c.fillRect.mock.calls.some(a => a[3] === 1))).toBe(true);
  });

  it('draws the selection outline as white dots with a black border', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await selectPen(user);
    lassoTriangle();
    const dotted = () => ctxs.find(c => c.setLineDash.mock.calls
      .some(a => Array.isArray(a[0]) && a[0][0] === 0 && a[0][1] > 0));
    await waitFor(() => expect(dotted()).toBeTruthy());
    // Zero-length dash + round cap = dots; the white pass is drawn last, over
    // the black underlay that borders each dot.
    expect(dotted().strokeStyle).toBe('#ffffff');
    expect(dotted().lineCap).toBe('round');
  });

  it('Delete with a selection clears the region instead of removing the object', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ref.current.getObjectCount()).toBe(1);
    await selectPen(user);
    lassoTriangle();
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeDisabled();
    const before = mainCtx().drawImage.mock.calls.length;
    fireEvent.keyDown(window, { key: 'Delete' });
    // The marquee-eraser path punches the paint layer and keeps the
    // object (the no-selection branch would have removed it).
    expect(mainCtx().drawImage.mock.calls.length).toBeGreaterThan(before);
    expect(ref.current.getObjectCount()).toBe(1);
  });

  it('Delete with a selection punches the region out of a touched movable', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    // The mask readback needs real selected pixels for the border trace; the
    // object measurement stays transparent, so the movable survives.
    stubMaskBlock(400, 400, 800, 800);
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ref.current.getObjectCount()).toBe(1);
    await selectPen(user);
    lassoTriangle();
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeDisabled();
    fireEvent.keyDown(window, { key: 'Delete' });
    // The selection border was mapped into the object's local frame and stored
    // as a hole, so the object keeps a clipped shape instead of being removed.
    expect(ref.current.getObjectCount()).toBe(1);
    const info = ref.current.getObjectInfo();
    expect(Array.isArray(info.erasePolys)).toBe(true);
    expect(info.erasePolys.length).toBeGreaterThan(0);
    expect(info.erasePolys[0].length).toBeGreaterThanOrEqual(3);
  });

  it('Delete with a selection drops a fully-consumed movable', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    // Selected mask region + a holed render that is fully transparent: the
    // marquee eraser wipes the object out entirely.
    stubMaskBlock(400, 400, 800, 800, true);
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ref.current.getObjectCount()).toBe(1);
    await selectPen(user);
    lassoTriangle();
    fireEvent.keyDown(window, { key: 'Delete' });
    // Nothing visible remains -> the object is gone, not an invisible frame.
    expect(ref.current.getObjectCount()).toBe(0);
  });

  it('Delete with a selection trims the sticker transparent instead of baking background paint', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    // Mask readback: an opaque block overlapping the sticker (imported at the
    // panel centre), so the border trace yields hole loops; the object
    // measurement stays visible, so the sticker survives trimmed.
    stubMaskBlock(900, 900, 1200, 1200);
    const ref = React.createRef();
    renderCanvas({ ref, initialParts: [{ partName: 'Body', imageDataUrl: 'data:image/png;base64,BASE' }] });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    // The template background resolves async (MockImage); Del must take the
    // transparency-punch branch, not the no-base white fallback.
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    const user = userEvent.setup();
    await selectPen(user);
    lassoTriangle();
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeDisabled();
    gcoSets = [];
    const paintBefore = mainCtx().drawImage.mock.calls.length;
    fireEvent.keyDown(window, { key: 'Delete' });
    // The sticker survives with a transparent hole in its own layer...
    expect(ref.current.getObjectCount()).toBe(1);
    const info = ref.current.getObjectInfo();
    expect(Array.isArray(info.erasePolys)).toBe(true);
    expect(info.erasePolys.length).toBeGreaterThan(0);
    // ...and the paint layer was punched (destination-out), never painted with
    // background pixels (no destination-in restore blit to bury the hole or
    // bake a ghost that stays behind when the sticker moves).
    expect(mainCtx().drawImage.mock.calls.length).toBeGreaterThan(paintBefore);
    expect(gcoSets).toContain('destination-out');
    expect(gcoSets).not.toContain('destination-in');
  });

  it('a duplicate of a selection-stamped movable inherits the clip shape', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await selectPen(user);
    lassoTriangle(); // the live selection
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 400, clientY: 400, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ref.current.getObjectInfo().clipMask).toBe(true);
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    expect(ref.current.getObjectCount()).toBe(2);
    // The copy carries the same stamped shape (not re-clipped to nothing).
    expect(ref.current.getObjectInfo().clipMask).toBe(true);
  });

  it('a brush stroke with an active selection is clipped (putImageData)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await selectPen(user);
    lassoTriangle();
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeNull();
    const main = mainCtx();
    const zeros = () => ({ data: new Uint8ClampedArray(2048 * 2048 * 4), width: 2048, height: 2048 });
    const red = () => {
      const d = new Uint8ClampedArray(2048 * 2048 * 4);
      d[0] = 255; d[3] = 255; // painted pixel the empty (mock) mask rejects
      return { data: d, width: 2048, height: 2048 };
    };
    // Snapshot (pre-stroke) then post-stroke pixels for the clip check.
    main.getImageData.mockReturnValueOnce(zeros()).mockReturnValueOnce(red());
    await user.click(screen.getByRole('button', { name: 'Brush' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 320, clientY: 320, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { clientX: 320, clientY: 320, button: 0, pointerId: 1 });
    expect(main.putImageData.mock.calls.length).toBeGreaterThan(0);
  });

  it('a brush stroke without a selection never constrains', async () => {
    const user = userEvent.setup();
    renderCanvas();
    expect(screen.queryByRole('button', { name: 'Deselect' })).toBeNull();
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 320, clientY: 320, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { clientX: 320, clientY: 320, button: 0, pointerId: 1 });
    // Strokes draw directly; putImageData only serves fill + mask clipping.
    expect(ctxs.every(c => c.putImageData.mock.calls.length === 0)).toBe(true);
  });

  it('a live selection never masks movables (full objects render and export)', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    const draw = async (a, b) => {
      await user.click(screen.getByRole('button', { name: 'Rect' }));
      fireEvent.pointerDown(cv, { clientX: a[0], clientY: a[1], button: 0, pointerId: 1 });
      fireEvent.pointerMove(cv, { clientX: b[0], clientY: b[1], button: 0, pointerId: 1 });
      fireEvent.pointerUp(cv, { pointerId: 1 });
    };
    await draw([100, 100], [200, 200]);
    await draw([400, 400], [500, 500]);
    expect(ref.current.getObjectCount()).toBe(2);
    // Select the bottom object A at (150,150): it becomes the active movable.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.pointerDown(cv, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
    // Lasso a selection overlapping A (switching to Lasso drops the movable
    // selection, per the single-select cancel rule).
    await user.click(screen.getByRole('button', { name: 'Lasso' }));
    lassoTriangle();
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeDisabled();
    // A selection is treated as already-placed background: every movable
    // flattens in full, with no presentation mask clip (`destination-in`).
    gcoSets = [];
    act(() => { ref.current.exportParts(); });
    expect(gcoSets.filter(v => v === 'destination-in')).toHaveLength(0);
    // Still no mask clip after deselecting.
    await user.click(screen.getByRole('button', { name: 'Deselect' }));
    gcoSets = [];
    act(() => { ref.current.exportParts(); });
    expect(gcoSets.filter(v => v === 'destination-in')).toHaveLength(0);
  });

  it('shows movable chrome only in Object mode, and drops it entering pen/wand', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    // Object mode: the blue box (strokeRect) is drawn for the selected movable.
    await waitFor(() => expect(ctxs.some(c => c.strokeRect.mock.calls.length > 0)).toBe(true));
    // Entering wand mode drops the movable selection, so no box is drawn.
    ctxs.forEach(c => c.strokeRect.mockClear());
    await user.click(screen.getByRole('button', { name: 'Magic Wand' }));
    await waitFor(() => expect(ctxs.every(c => c.strokeRect.mock.calls.length === 0)).toBe(true));
  });

  it('keeps the pen/wand mask when switching back to Object mode', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await selectPen(user);
    lassoTriangle();
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeDisabled();
    // Leaving the wand/pen does NOT cancel the selection mask.
    await user.click(screen.getByRole('button', { name: 'Object' }));
    expect(screen.getByRole('button', { name: 'Deselect' })).not.toBeDisabled();
  });

  it('leaving the Select tool in Object mode drops the movable selection', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await waitFor(() => expect(ctxs.some(c => c.strokeRect.mock.calls.length > 0)).toBe(true));
    // Brush then back to Select: the selection was cancelled on leaving.
    await user.click(screen.getByRole('button', { name: 'Brush' }));
    ctxs.forEach(c => c.strokeRect.mockClear());
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await waitFor(() => expect(ctxs.every(c => c.strokeRect.mock.calls.length === 0)).toBe(true));
  });

  it('bounds only movables added AFTER the selection, not before', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    const drawRect = async (a, b) => {
      await user.click(screen.getByRole('button', { name: 'Rect' }));
      fireEvent.pointerDown(cv, { clientX: a[0], clientY: a[1], button: 0, pointerId: 1 });
      fireEvent.pointerMove(cv, { clientX: b[0], clientY: b[1], button: 0, pointerId: 1 });
      fireEvent.pointerUp(cv, { pointerId: 1 });
    };
    await drawRect([100, 100], [200, 200]); // BEFORE the selection
    await selectPen(user);
    lassoTriangle();                         // selection exists
    await drawRect([300, 300], [400, 400]); // AFTER the selection
    expect(ref.current.getObjectCount()).toBe(2);
    // The newest (last) object captured the selection shape at creation.
    expect(ref.current.getObjectInfo().clipMask).toBe(true);
    // Export: exactly ONE mask clip - the clipped object. The pre-selection one
    // flattens in full.
    gcoSets = [];
    act(() => { ref.current.exportParts(); });
    expect(gcoSets.filter(v => v === 'destination-in')).toHaveLength(1);
    // Ctrl+D clears the live selection, but the object keeps its stamped shape.
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    gcoSets = [];
    act(() => { ref.current.exportParts(); });
    expect(gcoSets.filter(v => v === 'destination-in')).toHaveLength(1);
  });

  it('wand samples only visible colour — a clipped movable is clipped while sampling', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    const drawRect = async (a, b) => {
      await user.click(screen.getByRole('button', { name: 'Rect' }));
      fireEvent.pointerDown(cv, { clientX: a[0], clientY: a[1], button: 0, pointerId: 1 });
      fireEvent.pointerMove(cv, { clientX: b[0], clientY: b[1], button: 0, pointerId: 1 });
      fireEvent.pointerUp(cv, { pointerId: 1 });
    };
    await drawRect([100, 100], [200, 200]);
    await selectPen(user);
    lassoTriangle();
    await drawRect([300, 300], [400, 400]); // stamped with the selection
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Magic Wand' }));
    // Flushing the sample must draw the stamped movable through destination-in,
    // i.e. only its visible pixels are considered.
    gcoSets = [];
    fireEvent.pointerDown(cv, { clientX: 1, clientY: 1, button: 0, pointerId: 1 });
    expect(gcoSets.filter(v => v === 'destination-in').length).toBeGreaterThan(0);
  });
});

describe('layer order (fill under movables, pen above)', () => {
  it('stacks base < fill < objects < paint < chrome', () => {
    renderCanvas({ panels: [{ partName: 'Fuselage' }, { partName: 'Wing' }] });
    const layers = [...document.querySelectorAll('.lp-canvas-stage canvas')].map(c => c.dataset.layer);
    expect(layers).toEqual(['base', 'fill', 'objects', 'paint', 'chrome']);
  });

  it('keeps movables live when brushed over; the stroke lands on the paint layer', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ref.current.getObjectCount()).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Brush' }));
    fireEvent.pointerDown(cv, { clientX: 150, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 160, clientY: 160, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    // The movable is NOT baked away — it stays live and movable.
    expect(ref.current.getObjectCount()).toBe(1);
    // The stroke composited onto the paint layer; the locked base never stroked.
    expect(paintCtx().drawImage.mock.calls.some(a => a.length === 9)).toBe(true);
    expect(layerCtx('base').stroke).not.toHaveBeenCalled();
  });

  it('export composites base → fill → movables → pen', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const cv = mainCanvas();
    // Paint a movable, then run a fill — both must appear in the export.
    await user.click(screen.getByRole('button', { name: 'Rect' }));
    fireEvent.pointerDown(cv, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    await user.click(within(document.querySelector('.lp-rail')).getByRole('button', { name: 'Fill' }));
    fireEvent.pointerDown(cv, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    ctxs.length = 0;
    act(() => { ref.current.exportParts(); });
    // `flattenToCanvas` allocates its output canvas first, so its context leads
    // the newly-created ones; the per-panel canvases follow.
    const exportCtx = ctxs[0];
    const tags = exportCtx.drawImage.mock.calls
      .map(a => (a[0] && a[0].dataset ? a[0].dataset.layer : null))
      .filter(Boolean);
    // The fill underlay is drawn before the pen layer, both over the base.
    expect(tags[0]).toBe('base');
    expect(tags[1]).toBe('fill');
    expect(tags[tags.length - 1]).toBe('paint');
  });

  it('undo restores the fill layer alongside the pen', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const fill = layerCtx('fill');
    fill.getImageData.mockReturnValue({ data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 });
    await user.click(within(document.querySelector('.lp-rail')).getByRole('button', { name: 'Fill' }));
    fireEvent.pointerDown(mainCanvas(), { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    expect(fill.putImageData).toHaveBeenCalled();
    // Ctrl+Z puts the pre-fill fill image back (raster snapshots carry both).
    fill.putImageData.mockClear();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(fill.putImageData).toHaveBeenCalled();
  });
});

describe('eraser', () => {
  function baseCtx() {
    // The eraser punches the PAINT layer (above movables).
    const found = paintCtx();
    expect(found).toBeTruthy();
    return found;
  }

  it('punches transparency (destination-out) so the opaque base shows through', async () => {
    const user = userEvent.setup();
    renderCanvas({ defaultLiveryDataUrl: 'data:image/png;base64,BG' });
    await waitFor(() => expect(mainCanvas()).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    const cv = mainCanvas();
    const main = baseCtx();
    const before = main.stroke.mock.calls.length;
    gcoSets = [];
    fireEvent.pointerDown(cv, { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 320, clientY: 320, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(main.stroke.mock.calls.length).toBeGreaterThan(before);
    // The eraser is not a pen: it removes paint via destination-out, never
    // paints background-coloured pixels over the region. It cuts BOTH raster
    // layers, so a fill under the trail is removed too.
    expect(gcoSets).toContain('destination-out');
    expect(main.globalCompositeOperation).toBe('destination-out');
    expect(layerCtx('fill').globalCompositeOperation).toBe('destination-out');
  });

  it('erases a sticker but keeps it selectable and movable', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    // Erase across the sticker centre (texture 1024 = client 256 on the 512 stage).
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 276, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    // The object survives with its frame/border: still counted + removable.
    expect(ref.current.getObjectCount()).toBe(1);
    expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(false);
    // The erased object moves as before (holes ride along, no node updates).
    await user.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.pointerDown(cv, { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    expect(ref.current.getObjectCount()).toBe(1);
    act(() => { ref.current.exportPNG(); });
    const exportCtx = ctxs[ctxs.length - 1];
    expect(exportCtx.drawImage.mock.calls.length).toBeGreaterThan(0);
  });

  it('defers the erase — a long drag only previews and the base is written once on release', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    const cv = mainCanvas();
    // The eraser punches the PAINT layer; the drag must never write through it
    // (that per-frame pass was the drag cost).
    const base = paintCtx();
    const baseStrokes = () => base.stroke.mock.calls.length;
    const atDown = baseStrokes();
    fireEvent.pointerDown(cv, { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    // ~40 moves of +2 client px (8 texture px) each, letting each frame land.
    for (let i = 1; i <= 40; i++) {
      fireEvent.pointerMove(cv, { clientX: 256 + i * 2, clientY: 256, button: 0, pointerId: 1 });
      await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    }
    // Mid-drag: nothing on the base yet — the trail is only a dark preview.
    expect(baseStrokes()).toBe(atDown);
    fireEvent.pointerUp(cv, { pointerId: 1 });
    // Release commits the whole trail as ONE base stroke, not one per frame.
    expect(baseStrokes()).toBe(atDown + 1);
  });

  it('blits an erased object 1:1 — the scratch is never rescaled into the frame', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 276, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    // The per-object scratch is a canvas sized in 256px steps, so its width and
    // height are normally LARGER than the object frame (sw/sh). A 5-arg blit
    // would map the whole scratch into the frame: the shape shrinks, shifts and
    // re-filters a multi-megapixel canvas every overlay frame. Only images (the
    // sticker payload, the base template) may be drawn scaled, never a canvas.
    const scaledCanvasBlits = ctxs
      .flatMap(c => c.drawImage.mock.calls)
      .filter(a => a.length === 5 && a[0] && a[0].tagName === 'CANVAS');
    expect(scaledCanvasBlits).toHaveLength(0);
  });

  it('deletes a movable object the eraser consumed entirely', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    // The object renders TWICE per release (clean, then with holes). Report the
    // clean render as fully visible and the holed one as fully transparent —
    // i.e. the eraser wiped it out.
    stubEraseReadback(() => {});
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 250, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 262, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    // Gone, not left as an invisible-but-selectable frame.
    expect(ref.current.getObjectCount()).toBe(0);
    expect(screen.getByRole('button', { name: 'Remove Sticker' }).disabled).toBe(true);
  });

  it('re-frames a part-erased object to what is left, and scales it on resize', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    // Clean render fully visible; holed render keeps only the bottom-right
    // quadrant of the 100x50 sticker (local 0,0 -> 50,25).
    stubEraseReadback((data, w, h) => {
      const pad = 8;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const inside = x >= pad + 50 && x < pad + 100 && y >= pad + 25 && y < pad + 50;
          if (inside) data[(y * w + x) * 4 + 3] = 255;
        }
      }
    });
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 250, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 262, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    // The object survives, but its Select boundary is the remainder.
    expect(ref.current.getObjectCount()).toBe(1);
    const afterErase = ref.current.getObjectInfo();
    expect(afterErase.frame.x0).toBeCloseTo(0, 0);
    expect(afterErase.frame.y0).toBeCloseTo(0, 0);
    expect(afterErase.frame.x1).toBeCloseTo(50, 0);
    expect(afterErase.frame.y1).toBeCloseTo(25, 0);
    // Resize by grabbing the boundary's bottom-right handle (local 50,25 ->
    // client 268.5,262.25) and dragging to double the distance from the object
    // centre, i.e. local 100,50 -> client 281,268.5.
    await user.click(screen.getByRole('button', { name: 'Select' }));
    // Switching tools dropped the movable selection (object sub-mode); click
    // the object's centre to re-select it before grabbing its handle.
    fireEvent.pointerDown(cv, { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    const holes = afterErase.erase[0].pts.map(q => ({ x: q.x, y: q.y }));
    fireEvent.pointerDown(cv, { clientX: 268.5, clientY: 262.25, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 281, clientY: 268.5, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const resized = ref.current.getObjectInfo();
    expect(resized.w).toBeCloseTo(200, 0);
    expect(resized.h).toBeCloseTo(100, 0);
    // Boundary and holes scaled with the frame, so the remaining quadrant still
    // looks like the same quadrant (a half circle would stay a half circle).
    expect(resized.frame.x1 - resized.frame.x0).toBeCloseTo(100, 0);
    expect(resized.frame.y1 - resized.frame.y0).toBeCloseTo(50, 0);
    expect(resized.erase[0].pts.map(q => ({ x: q.x, y: q.y }))).toEqual(holes.map(q => ({ x: q.x * 2, y: q.y * 2 })));
  });

  it('keeps a part-erased boundary when flipping', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
      if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    stubEraseReadback((data, w, h) => {
      const pad = 8;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const inside = x >= pad + 50 && x < pad + 100 && y >= pad + 25 && y < pad + 50;
          if (inside) data[(y * w + x) * 4 + 3] = 255;
        }
      }
    });
    await user.click(screen.getByRole('button', { name: 'Eraser' }));
    const cv = mainCanvas();
    fireEvent.pointerDown(cv, { clientX: 250, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerMove(cv, { clientX: 262, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(cv, { pointerId: 1 });
    const before = ref.current.getObjectInfo();
    await user.click(screen.getByRole('button', { name: 'Flip Horizontal' }));
    const after = ref.current.getObjectInfo();
    expect(after.flipX).toBe(true);
    // The boundary centre is the pivot, so the box and the object stay put.
    expect(after.frame).toEqual(before.frame);
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(ref.current.getObjectCount()).toBe(1);
  });
});

describe('part-erase boundary helpers', () => {
  it('frameOf falls back to the geometry box and prefers an explicit frame', () => {
    expect(frameOf({ w: 100, h: 50 })).toEqual({ x0: -50, y0: -25, x1: 50, y1: 25 });
    const frame = { x0: -50, y0: 0, x1: 0, y1: 25 };
    expect(frameOf({ w: 100, h: 50, frame })).toBe(frame);
  });

  it('scales holes and the boundary together so a part shape keeps its shape', () => {
    expect(scaleErase(2, [{ size: 10, pts: [{ x: 3, y: -4 }] }]))
      .toEqual([{ size: 20, pts: [{ x: 6, y: -8 }] }]);
    expect(scaleFrame(0.5, { x0: -10, y0: -6, x1: 10, y1: 6 }))
      .toEqual({ x0: -5, y0: -3, x1: 5, y1: 3 });
    expect(scaleErase(2, undefined)).toBeUndefined();
    expect(scaleFrame(2, null)).toBeUndefined();
    // Selection-hole polygons scale per axis too (free stretch of a hole).
    expect(scaleErasePolys(2, [[{ x: 3, y: -4 }]]))
      .toEqual([[{ x: 6, y: -8 }]]);
    expect(scaleErasePolys(2, [[{ x: 3, y: -4 }]], 0.5))
      .toEqual([[{ x: 6, y: -2 }]]);
    expect(scaleErasePolys(2, undefined)).toBeUndefined();
    // A free stretch takes both axes: the hole points follow x/y, while the
    // single brush width keeps the geometric mean (2 x 0.5 -> 1).
    expect(scaleErase(2, [{ size: 10, pts: [{ x: 3, y: -4 }] }], 0.5))
      .toEqual([{ size: 10, pts: [{ x: 6, y: -2 }] }]);
    expect(scaleFrame(2, { x0: -10, y0: -6, x1: 10, y1: 6 }, 0.5))
      .toEqual({ x0: -20, y0: -3, x1: 20, y1: 3 });
  });

  it('maps a pointer into the drawn local frame and derives stretch factors', () => {
    const o = { x: 100, y: 200, rot: 0, w: 100, h: 50 };
    expect(objectLocal(o, { x: 150, y: 225 })).toEqual({ x: 50, y: 25 });
    const rot = { x: 0, y: 0, rot: Math.PI / 2, w: 100, h: 50 };
    const L = objectLocal(rot, { x: -25, y: 50 });
    expect(L.x).toBeCloseTo(50, 6);
    expect(L.y).toBeCloseTo(25, 6);
    // Shift: one factor for both axes, measured from the object's centre.
    const shifted = resizeFactors(o, { x: 150, y: 225 }, { x: 200, y: 212.5 }, true);
    expect(shifted.kx).toBe(shifted.ky);
    expect(shifted.kx).toBeCloseTo(Math.hypot(100, 12.5) / Math.hypot(50, 25), 6);
    // Free: each axis follows the pointer, so the box stretches.
    const free = resizeFactors(o, { x: 150, y: 225 }, { x: 200, y: 212.5 }, false);
    expect(free.kx).toBeCloseTo(2, 6);
    expect(free.ky).toBeCloseTo(0.5, 6);
    // Dragging through the centre never yields a negative factor: the box
    // shrinks (floor 0.02) instead of mirroring through the centre.
    const shrunk = resizeFactors(o, { x: 150, y: 225 }, { x: 90, y: 195 }, false);
    expect(shrunk.kx).toBeCloseTo(0.2, 6);
    expect(shrunk.ky).toBeCloseTo(0.2, 6);
    const centred = resizeFactors(o, { x: 150, y: 225 }, { x: 100, y: 200 }, false);
    expect(centred.kx).toBe(0.02);
    expect(centred.ky).toBe(0.02);
    // A degenerate axis (grabbed on the centre line) is left alone.
    const thin = resizeFactors(o, { x: 100, y: 225 }, { x: 100, y: 250 }, false);
    expect(thin.kx).toBe(1);
    expect(thin.ky).toBeCloseTo(2, 6);
  });

  it('flips a part-erased object about its boundary centre, not the origin', () => {    // Remainder occupies local x 0..50, y 0..25 (boundary centre 25, 12.5).
    const part = { x: 0, y: 0, rot: 0, w: 100, h: 50, flipX: true, frame: { x0: 0, y0: 0, x1: 50, y1: 25 } };
    // Mirror axis is x = 25, so the remainder mirrors IN PLACE: the boundary
    // maps onto itself instead of jumping to -50..0.
    expect(flipOffset(part)).toEqual({ x: 50, y: 0 });
    expect(worldFromLocal(part, { x: 0, y: 0 })).toEqual({ x: 50, y: 0 });
    expect(worldFromLocal(part, { x: 50, y: 25 })).toEqual({ x: 0, y: 25 });
    // World ⇄ local still round-trips through the pivot.
    const q = { x: 12, y: -7 };
    const back = localFromWorld(part, worldFromLocal(part, q));
    expect(back.x).toBeCloseTo(q.x, 6);
    expect(back.y).toBeCloseTo(q.y, 6);
    // A whole object is centred on the origin, so nothing changes for it.
    expect(flipOffset({ x: 0, y: 0, w: 100, h: 50, flipX: true, flipY: true })).toEqual({ x: 0, y: 0 });
  });
});

describe('keyboard target filtering', () => {
  it('treats only real text fields as text entry', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTextEntry({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'SELECT' })).toBe(true);
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntry(null)).toBe(false);
  });
});
