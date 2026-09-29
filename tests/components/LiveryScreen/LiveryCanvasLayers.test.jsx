import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveryCanvas from '../../../src/components/LiveryScreen/LiveryCanvas';
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
    closePath: vi.fn(),
    fill: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), arc: vi.fn(), clip: vi.fn(),
    strokeRect: vi.fn(), setLineDash: vi.fn(),
    fillText: vi.fn(), putImageData: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(),
    getImageData: vi.fn((x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h })),
    _gco: 'source-over',
    get globalCompositeOperation() { return this._gco; },
    set globalCompositeOperation(v) { this._gco = v; },
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

let getCtxSpy;
let toDataSpy;
let rectSpy;

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  ctxs = [];
  getCtxSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    const c = makeCtx();
    c._layer = this && this.dataset ? this.dataset.layer : undefined;
    c._layerId = this && this.dataset ? this.dataset.layerId : undefined;
    ctxs.push(c);
    return c;
  });
  toDataSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,LAYER');
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
    </I18nProvider>,
  );
}

const chrome = () => document.querySelector('.livery-canvas-wrap canvas[data-layer="chrome"]');
const headBtn = (name) => screen.getByRole('button', { name });
const layerRow = (name) => screen.getAllByRole('listitem').find(r => within(r).queryByText(name));
const rowBtn = (row, label) => within(layerRow(row)).getByRole('button', { name: label });
const folderHeader = (name) => screen.getByText(name).closest('.lp-layer-folder');
const paintCtxFor = (layerId) => ctxs.find(c => c._layer === 'paint' && c._layerId === layerId);
const layerNames = (ref) => ref.current.exportLayers().layers.map(l => l.name);
const exportPanel = (ref) => ref.current.exportLayers().panel;
const layerIdByName = (ref, name) => ref.current.exportLayers().layers.find(l => l.name === name).id;
const inFolder = (ref, name) => {
  const id = layerIdByName(ref, name);
  return exportPanel(ref).some(n => n.type === 'folder' && n.children.includes(id));
};

const dragOnto = (srcName, targetEl, clientY = 300) => {
  const src = layerRow(srcName);
  fireEvent.dragStart(src);
  fireEvent(targetEl, new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY }));
  fireEvent(targetEl, new MouseEvent('drop', { bubbles: true, cancelable: true, clientY }));
  fireEvent.dragEnd(src);
};
const dragItemOnto = (srcEl, targetEl, clientY) => {
  fireEvent.dragStart(srcEl);
  fireEvent(targetEl, new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY }));
  fireEvent(targetEl, new MouseEvent('drop', { bubbles: true, cancelable: true, clientY }));
  fireEvent.dragEnd(srcEl);
};

const stickerIpc = () => {
  mockIpcInvoke.mockImplementation((channel) => {
    if (channel === 'select-livery-image') return Promise.resolve({ canceled: false, filePath: '/tmp/s.png' });
    if (channel === 'read-disk-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
    return Promise.resolve({});
  });
};

describe('layer panel — structure', () => {
  it('starts with one editable layer + the locked base row', async () => {
    renderCanvas();
    expect(screen.getByText('Layers')).toBeInTheDocument();
    expect(screen.getByText('Layer 1')).toBeInTheDocument();
    expect(screen.getByText('Base')).toBeInTheDocument();
    expect(rowBtn('Layer 1', 'Delete layer').disabled).toBe(true);
  });

  it('adds a layer above the active one and makes it active', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    expect(screen.getByText('Layer 2')).toBeInTheDocument();
    expect(rowBtn('Layer 2', 'Delete layer').disabled).toBe(false);
    await waitFor(() => expect(document.querySelectorAll('.livery-canvas-wrap canvas[data-layer="paint"]')).toHaveLength(2));
  });

  it('renders a 50×50 preview canvas per layer plus the base', async () => {
    const user = userEvent.setup();
    renderCanvas();
    expect(document.querySelectorAll('canvas.lp-layer-thumb')).toHaveLength(2);
    await user.click(headBtn('New Layer'));
    await waitFor(() => expect(document.querySelectorAll('canvas.lp-layer-thumb')).toHaveLength(3));
  });

  it('renames a layer from the panel and pushes it back on export', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(rowBtn('Layer 1', 'Rename layer'));
    const input = screen.getByRole('textbox', { name: 'Rename layer' });
    await user.clear(input);
    await user.type(input, 'Fuselage art{Enter}');
    expect(screen.getByText('Fuselage art')).toBeInTheDocument();
    expect(layerNames(ref)).toContain('Fuselage art');
  });

  it('hides a non-active layer and toggles it back', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(headBtn('New Layer'));
    await user.click(rowBtn('Layer 1', 'Hide layer'));
    expect(rowBtn('Layer 1', 'Show layer')).toBeInTheDocument();
    const paintCanvases = [...document.querySelectorAll('.livery-canvas-wrap canvas[data-layer="paint"]')];
    expect(paintCanvases.some(c => c.style.display === 'none')).toBe(true);
    await user.click(rowBtn('Layer 1', 'Show layer'));
    expect(rowBtn('Layer 1', 'Hide layer')).toBeInTheDocument();
  });

  it('hides the last visible layer (the solo layer can be hidden)', async () => {
    const user = userEvent.setup();
    const ref = React.createRef();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(rowBtn('Layer 1', 'Hide layer'));
    // The last visible layer CAN be hidden now — only the locked base remains.
    expect(rowBtn('Layer 1', 'Show layer')).toBeInTheDocument();
    expect(rowBtn('Layer 1', 'Show layer').getAttribute('aria-pressed')).toBe('false');
    const paintCanvases = [...document.querySelectorAll('.livery-canvas-wrap canvas[data-layer="paint"]')];
    expect(paintCanvases.some(c => c.style.display === 'none')).toBe(true);
    // It stays the active layer (no visible successor), so the next stroke still
    // lands on it even while hidden.
    expect(ref.current.exportLayers().activeId).toBe(layerIdByName(ref, 'Layer 1'));
    await user.click(rowBtn('Layer 1', 'Show layer'));
    expect(rowBtn('Layer 1', 'Hide layer')).toBeInTheDocument();
  });

  it('deletes a layer (keeping the last one)', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(headBtn('New Layer'));
    expect(screen.getByText('Layer 2')).toBeInTheDocument();
    await user.click(rowBtn('Layer 2', 'Delete layer'));
    expect(screen.queryByText('Layer 2')).toBeNull();
    expect(screen.getByText('Layer 1')).toBeInTheDocument();
  });
});

describe('layer panel — folders', () => {
  it('creates a folder with the New Folder button', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(headBtn('New Folder'));
    const input = screen.getByRole('textbox', { name: 'Rename folder' });
    expect(input.value).toBe('Folder 1');
    fireEvent.blur(input);
    expect(folderHeader('Folder 1')).toBeInTheDocument();
    // No member-count badge.
    expect(within(folderHeader('Folder 1')).queryByText('0')).toBeNull();
  });

  it('drags a layer into a folder and back to the root, without moving other folders', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    // Two folders exist; dropping a layer into the first must not reorder them.
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    const orderBefore = exportPanel(ref).filter(n => n.type === 'folder').map(n => n.name);
    dragOnto('Layer 1', folderHeader('Folder 2'));   // default 300 → into Folder 2
    await waitFor(() => expect(layerRow('Layer 1').className).toContain('lp-layer-nested'));
    expect(inFolder(ref, 'Layer 1')).toBe(true);
    // Folder order is unchanged by moving a layer in.
    expect(exportPanel(ref).filter(n => n.type === 'folder').map(n => n.name)).toEqual(orderBefore);
    // Drag onto the base row → back to the root.
    dragOnto('Layer 1', screen.getByText('Base').closest('.lp-layer-row'));
    await waitFor(() => expect(layerRow('Layer 1').className).not.toContain('lp-layer-nested'));
    expect(inFolder(ref, 'Layer 1')).toBe(false);
  });

  it('drops a layer at the TOP of the first folder', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    await user.click(headBtn('New Layer'));                 // Layer 2 above Layer 1
    // Put BOTH layers in the folder, then verify the last one is the top member.
    dragOnto('Layer 1', folderHeader('Folder 1'));
    await waitFor(() => expect(inFolder(ref, 'Layer 1')).toBe(true));
    dragOnto('Layer 2', folderHeader('Folder 1'));
    await waitFor(() => expect(inFolder(ref, 'Layer 2')).toBe(true));
    // The folder node's first child is the most recently dropped layer.
    const folder = exportPanel(ref).find(n => n.type === 'folder');
    expect(folder.children[0]).toBe(layerIdByName(ref, 'Layer 2'));
    expect(folder.children).toHaveLength(2);
  });

  it('hides an entire folder (and shows it again)', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    await user.click(headBtn('New Layer'));
    dragOnto('Layer 1', folderHeader('Folder 1'));
    await waitFor(() => expect(inFolder(ref, 'Layer 1')).toBe(true));
    // Folder eye hides every layer inside.
    await user.click(within(folderHeader('Folder 1')).getByRole('button', { name: 'Hide layer' }));
    expect(within(folderHeader('Folder 1')).getByRole('button', { name: 'Show layer' })).toBeInTheDocument();
    expect(layerRow('Layer 1').className).toContain('lp-layer-hidden');
    const id = layerIdByName(ref, 'Layer 1');
    const paint = document.querySelector(`canvas[data-layer="paint"][data-layer-id="${id}"]`);
    expect(paint.style.display).toBe('none');
    expect(exportPanel(ref).find(n => n.type === 'folder').visible).toBe(false);
    // Show again clears the folder + child hidden state.
    await user.click(within(folderHeader('Folder 1')).getByRole('button', { name: 'Show layer' }));
    expect(layerRow('Layer 1').className).not.toContain('lp-layer-hidden');
    expect(paint.style.display).toBe('block');
  });

  it('renames a folder', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    fireEvent.doubleClick(screen.getByText('Folder 1'));
    const input = screen.getByRole('textbox', { name: 'Rename folder' });
    await user.clear(input);
    await user.type(input, 'Roundels{Enter}');
    expect(screen.getByText('Roundels')).toBeInTheDocument();
  });

  it('deletes an empty folder immediately', async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    await user.click(within(folderHeader('Folder 1')).getByRole('button', { name: 'Delete folder' }));
    expect(screen.queryByText('Folder 1')).toBeNull();
  });

  it('deletes a non-empty folder and every layer inside it (after confirm)', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    await user.click(headBtn('New Layer'));                 // Layer 2 stays at the root
    dragOnto('Layer 1', folderHeader('Folder 1'));          // only Layer 1 goes in
    await waitFor(() => expect(inFolder(ref, 'Layer 1')).toBe(true));
    await user.click(within(folderHeader('Folder 1')).getByRole('button', { name: 'Delete folder' }));
    // Confirm modal lists the layer count, then deletes folder + layers.
    await waitFor(() => expect(document.querySelector('#modal-box')).toBeTruthy());
    await user.click(within(document.querySelector('#modal-box')).getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => expect(screen.queryByText('Layer 1')).toBeNull());
    // The root layer is untouched.
    expect(screen.getByText('Layer 2')).toBeInTheDocument();
  });
});

describe('layer panel — drag reorder', () => {
  it('reorders layers by dragging (top half = above) and reflects the order on export', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));                 // flat bottom→top: [Layer 1, Layer 2]
    expect(layerNames(ref)).toEqual(['Layer 1', 'Layer 2']);
    dragOnto('Layer 1', layerRow('Layer 2'), 10);           // above Layer 2
    await waitFor(() => expect(layerNames(ref)).toEqual(['Layer 2', 'Layer 1']));
  });

  it('drags a whole folder (its layers move together)', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    await user.click(headBtn('New Layer'));                 // flat [Layer 1, Layer 2]
    dragOnto('Layer 1', folderHeader('Folder 1'));
    await waitFor(() => expect(inFolder(ref, 'Layer 1')).toBe(true));
    // Layer 1 must be the folder's top member and the folder sits above Layer 2's root node.
    let folder = exportPanel(ref).find(n => n.type === 'folder');
    const layer1Id = layerIdByName(ref, 'Layer 1');
    expect(folder.children[0]).toBe(layer1Id);
    // Drag the folder header down to the root; membership + block travel.
    dragItemOnto(folderHeader('Folder 1'), screen.getByText('Base').closest('.lp-layer-row'), 300);
    await waitFor(() => expect(inFolder(ref, 'Layer 1')).toBe(true));
    folder = exportPanel(ref).find(n => n.type === 'folder');
    expect(folder.children).toContain(layer1Id);
    expect(layerRow('Layer 1').className).toContain('lp-layer-nested');
  });
});

describe('layer panel — pen + selection are bounded by the active layer', () => {
  it('paints into the active layer only', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    const [layer1] = ref.current.exportLayers().layers;
    await user.click(headBtn('New Layer'));
    const layer2 = ref.current.exportLayers().layers.find(l => l.name === 'Layer 2');
    fireEvent.pointerDown(chrome(), { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(chrome(), { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    fireEvent.pointerUp(chrome(), { pointerId: 1 });
    expect(paintCtxFor(layer2.id).drawImage.mock.calls.length).toBeGreaterThan(0);
    expect(paintCtxFor(layer1.id).drawImage).not.toHaveBeenCalled();
  });

  it('creates movables on the active layer and does not select across layers', async () => {
    stickerIpc();
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.getObjectCount()).toBe(1));
    await user.click(headBtn('New Layer'));
    expect(ref.current.getObjectCount()).toBe(0);
    expect(ref.current.getSelectedId()).toBeNull();
    await user.click(headBtn('Select'));
    fireEvent.pointerDown(chrome(), { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
    fireEvent.pointerUp(chrome(), { pointerId: 1 });
    expect(ref.current.getSelectedId()).toBeNull();
    expect(ref.current.getObjectCount()).toBe(0);
    await user.click(layerRow('Layer 1'));
    expect(ref.current.getObjectCount()).toBe(1);
  });
});

describe('layer panel — clipping', () => {
  it('clips a layer to the one below: status icon, offset and masked display', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer')); // Layer 2 sits above Layer 1
    await user.click(rowBtn('Layer 2', 'Clip to layer below'));

    const row = layerRow('Layer 2');
    expect(row.className).toContain('lp-layer-clipped');
    expect(within(row).getByRole('button', { name: 'Unclip layer' })).toHaveAttribute('aria-pressed', 'true');

    const id = layerIdByName(ref, 'Layer 2');
    // The raw rasters are hidden; a masked display canvas takes their place.
    expect(document.querySelector(`canvas[data-layer="paint"][data-layer-id="${id}"]`).style.display).toBe('none');
    const clip = document.querySelector(`canvas[data-layer="clip"][data-layer-id="${id}"]`);
    expect(clip).toBeTruthy();
    expect(clip.style.display).toBe('block');
    expect(ref.current.exportLayers().layers.find(l => l.id === id).clipped).toBe(true);
  });

  it('unclips without losing the layer content or objects', async () => {
    stickerIpc();
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    await act(async () => { await ref.current.importSticker(); });
    const id = layerIdByName(ref, 'Layer 2');
    await user.click(rowBtn('Layer 2', 'Clip to layer below'));
    await user.click(rowBtn('Layer 2', 'Unclip layer'));

    const row = layerRow('Layer 2');
    expect(row.className).not.toContain('lp-layer-clipped');
    expect(document.querySelector(`canvas[data-layer="clip"][data-layer-id="${id}"]`)).toBeFalsy();
    expect(document.querySelector(`canvas[data-layer="paint"][data-layer-id="${id}"]`).style.display).toBe('block');
    const rec = ref.current.exportLayers().layers.find(l => l.id === id);
    expect(rec.clipped).toBe(false);
    expect(rec.objects).toHaveLength(1);
  });

  it('clips the bottom layer to the locked base and still exports', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(rowBtn('Layer 1', 'Clip to layer below'));
    const id = layerIdByName(ref, 'Layer 1');
    expect(document.querySelector(`canvas[data-layer="clip"][data-layer-id="${id}"]`)).toBeTruthy();
    expect(() => ref.current.exportPNG()).not.toThrow();
  });

  it('still paints on a clipped layer (edits are stored, only the display is masked)', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    await user.click(rowBtn('Layer 2', 'Clip to layer below'));
    const layer2 = ref.current.exportLayers().layers.find(l => l.name === 'Layer 2');
    fireEvent.pointerDown(chrome(), { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(chrome(), { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    fireEvent.pointerUp(chrome(), { pointerId: 1 });
    expect(paintCtxFor(layer2.id).drawImage.mock.calls.length).toBeGreaterThan(0);
  });

  it('restores clipped layers from a saved payload', async () => {
    const ref = React.createRef();
    const payload = {
      version: 2,
      activeId: 'ly2',
      base: { panels: [{ partName: 'Body', imageDataUrl: 'data:image/png;base64,QkFTRQ==' }] },
      panel: [{ type: 'layer', id: 'ly2' }, { type: 'layer', id: 'ly1' }],
      layers: [
        { id: 'ly1', name: 'Base Art', visible: true, objects: [], panels: [] },
        { id: 'ly2', name: 'Clip Art', visible: true, clipped: true, objects: [], panels: [] },
      ],
    };
    renderCanvas({ ref, initialLayers: payload });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Clip Art')).toBeInTheDocument());
    const id = layerIdByName(ref, 'Clip Art');
    expect(document.querySelector(`canvas[data-layer="clip"][data-layer-id="${id}"]`)).toBeTruthy();
    expect(layerRow('Clip Art').className).toContain('lp-layer-clipped');
    expect(ref.current.exportLayers().layers.find(l => l.id === id).clipped).toBe(true);
  });
});

describe('layer panel — opacity', () => {
  const opacitySlider = (name) => within(layerRow(name)).getByRole('slider', { name: 'Layer opacity' });

  it('renders an opacity slider per layer, defaulting to 100%', async () => {
    const user = userEvent.setup();
    renderCanvas();
    expect(opacitySlider('Layer 1').value).toBe('100');
    expect(within(layerRow('Layer 1')).getByText('100%')).toBeInTheDocument();
    await user.click(headBtn('New Layer'));
    expect(opacitySlider('Layer 2').value).toBe('100');
  });

  it('fades a layer to 0 without touching its content, and back to 100', async () => {
    stickerIpc();
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    await act(async () => { await ref.current.importSticker(); });
    const id = layerIdByName(ref, 'Layer 2');
    let before = ref.current.exportLayers().layers.find(l => l.id === id);
    await waitFor(() => {
      before = ref.current.exportLayers().layers.find(l => l.id === id);
      expect(before.objects).toHaveLength(1);
    });

    fireEvent.change(opacitySlider('Layer 2'), { target: { value: '0' } });
    await waitFor(() => expect(ref.current.exportLayers().layers.find(l => l.id === id).opacity).toBe(0));
    // Display canvases fade via CSS, but the stored rasters/objects survive.
    expect(document.querySelector(`canvas[data-layer="paint"][data-layer-id="${id}"]`).style.opacity).toBe('0');
    const faded = ref.current.exportLayers().layers.find(l => l.id === id);
    expect(faded.objects).toHaveLength(1);
    expect(faded.panels[0]).toEqual(before.panels[0]);
    expect(() => ref.current.exportPNG()).not.toThrow();

    fireEvent.change(opacitySlider('Layer 2'), { target: { value: '100' } });
    await waitFor(() => expect(ref.current.exportLayers().layers.find(l => l.id === id).opacity).toBe(1));
    expect(document.querySelector(`canvas[data-layer="paint"][data-layer-id="${id}"]`).style.opacity).toBe('1');
    const restored = ref.current.exportLayers().layers.find(l => l.id === id);
    expect(restored.objects).toHaveLength(1);
    expect(restored.panels[0]).toEqual(before.panels[0]);
  });

  it('composites a faded layer at its opacity on export (a 0% layer contributes nothing)', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    fireEvent.change(opacitySlider('Layer 1'), { target: { value: '40' } });
    await waitFor(() => expect(opacitySlider('Layer 1').value).toBe('40'));
    // The export creates its compositing context first, before any scratch.
    let before = ctxs.length;
    act(() => { ref.current.exportPNG(); });
    const exportCtx = ctxs[before];
    expect(exportCtx.globalAlpha).toBeCloseTo(0.4, 6);
    expect(exportCtx.drawImage).toHaveBeenCalled();
    // At 0% the layer is skipped outright — never composited at alpha 0.
    fireEvent.change(opacitySlider('Layer 1'), { target: { value: '0' } });
    await waitFor(() => expect(opacitySlider('Layer 1').value).toBe('0'));
    before = ctxs.length;
    act(() => { ref.current.exportPNG(); });
    expect(ctxs[before].globalAlpha).not.toBe(0);
  });

  it('keeps opacity independent from the hide/show toggle', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    fireEvent.change(opacitySlider('Layer 1'), { target: { value: '0' } });
    await waitFor(() => expect(opacitySlider('Layer 1').value).toBe('0'));
    // The eye toggle still works on a fully-faded layer and vice versa.
    await user.click(rowBtn('Layer 1', 'Hide layer'));
    expect(rowBtn('Layer 1', 'Show layer')).toBeInTheDocument();
    expect(opacitySlider('Layer 1').value).toBe('0');
    await user.click(rowBtn('Layer 1', 'Show layer'));
    expect(rowBtn('Layer 1', 'Hide layer')).toBeInTheDocument();
    expect(opacitySlider('Layer 1').value).toBe('0');
  });

  it('does not switch the active layer when adjusting another layer opacity', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer')); // Layer 2 becomes active
    const layer2Id = layerIdByName(ref, 'Layer 2');
    expect(ref.current.exportLayers().activeId).toBe(layer2Id);
    fireEvent.click(opacitySlider('Layer 1'));
    fireEvent.change(opacitySlider('Layer 1'), { target: { value: '50' } });
    expect(ref.current.exportLayers().activeId).toBe(layer2Id);
    expect(ref.current.exportLayers().layers.find(l => l.name === 'Layer 1').opacity).toBe(0.5);
  });

  it('a press starting on the opacity slider never starts a layer-reorder drag', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer')); // flat bottom→top: [Layer 1, Layer 2]
    expect(layerNames(ref)).toEqual(['Layer 1', 'Layer 2']);
    // The press begins on the slider: the row drag is cancelled, order kept.
    fireEvent.pointerDown(opacitySlider('Layer 1'));
    dragOnto('Layer 1', layerRow('Layer 2'), 10);
    expect(layerNames(ref)).toEqual(['Layer 1', 'Layer 2']);
    // After release the same drag reorders again.
    fireEvent.pointerUp(window);
    dragOnto('Layer 1', layerRow('Layer 2'), 10);
    await waitFor(() => expect(layerNames(ref)).toEqual(['Layer 2', 'Layer 1']));
  });

  it('undo reverts an opacity change in one step', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    fireEvent.change(opacitySlider('Layer 2'), { target: { value: '30' } });
    await waitFor(() => expect(opacitySlider('Layer 2').value).toBe('30'));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(opacitySlider('Layer 2').value).toBe('100'));
  });

  it('persists opacity through exportLayers and restores it from a payload', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    fireEvent.change(opacitySlider('Layer 1'), { target: { value: '35' } });
    await waitFor(() => expect(ref.current.exportLayers().layers[0].opacity).toBeCloseTo(0.35));

    const ref2 = React.createRef();
    const payload = {
      version: 2,
      activeId: 'ly1',
      base: { panels: [{ partName: 'Body', imageDataUrl: 'data:image/png;base64,QkFTRQ==' }] },
      panel: [{ type: 'layer', id: 'ly1' }],
      layers: [
        { id: 'ly1', name: 'Ghost', visible: true, opacity: 0.35, objects: [], panels: [] },
      ],
    };
    renderCanvas({ ref: ref2, initialLayers: payload });
    await waitFor(() => expect(ref2.current).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Ghost')).toBeInTheDocument());
    expect(opacitySlider('Ghost').value).toBe('35');
    expect(ref2.current.exportLayers().layers[0].opacity).toBeCloseTo(0.35);
  });

  it('defaults a legacy payload without opacity to 1', async () => {
    const ref = React.createRef();
    const payload = {
      version: 2,
      activeId: 'ly1',
      base: { panels: [{ partName: 'Body', imageDataUrl: 'data:image/png;base64,QkFTRQ==' }] },
      panel: [{ type: 'layer', id: 'ly1' }],
      layers: [
        { id: 'ly1', name: 'Legacy', visible: true, objects: [], panels: [] },
      ],
    };
    renderCanvas({ ref, initialLayers: payload });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Legacy')).toBeInTheDocument());
    expect(ref.current.exportLayers().layers[0].opacity).toBe(1);
  });
});

describe('layer panel — structural undo', () => {
  const undo = () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  const redo = () => fireEvent.keyDown(window, { key: 'y', ctrlKey: true });

  it('undo removes a newly added layer and redo brings it back', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    expect(layerNames(ref)).toEqual(['Layer 1', 'Layer 2']);
    undo();
    await waitFor(() => expect(layerNames(ref)).toEqual(['Layer 1']));
    expect(screen.queryByText('Layer 2')).toBeNull();
    redo();
    await waitFor(() => expect(layerNames(ref)).toEqual(['Layer 1', 'Layer 2']));
  });

  it('undo restores a deleted layer together with its objects', async () => {
    stickerIpc();
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    await act(async () => { await ref.current.importSticker(); });
    await waitFor(() => expect(ref.current.exportLayers().layers.find(l => l.name === 'Layer 2').objects).toHaveLength(1));
    await user.click(rowBtn('Layer 2', 'Delete layer'));
    await waitFor(() => expect(screen.queryByText('Layer 2')).toBeNull());
    undo();
    await waitFor(() => expect(screen.getByText('Layer 2')).toBeInTheDocument());
    await waitFor(() => {
      const rec = ref.current.exportLayers().layers.find(l => l.name === 'Layer 2');
      expect(rec).toBeTruthy();
      expect(rec.objects).toHaveLength(1);
    });
  });

  it('undo reverts a clip toggle', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    await user.click(rowBtn('Layer 2', 'Clip to layer below'));
    expect(layerRow('Layer 2').className).toContain('lp-layer-clipped');
    undo();
    await waitFor(() => expect(layerRow('Layer 2').className).not.toContain('lp-layer-clipped'));
  });

  it('undo reverts hiding a layer', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    await user.click(rowBtn('Layer 2', 'Hide layer'));
    expect(layerRow('Layer 2').className).toContain('lp-layer-hidden');
    undo();
    await waitFor(() => expect(layerRow('Layer 2').className).not.toContain('lp-layer-hidden'));
  });

  it('undo reverts a drag reorder', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Layer'));
    dragOnto('Layer 1', layerRow('Layer 2'), 10);
    await waitFor(() => expect(layerNames(ref)).toEqual(['Layer 2', 'Layer 1']));
    undo();
    await waitFor(() => expect(layerNames(ref)).toEqual(['Layer 1', 'Layer 2']));
  });

  it('undo reverts moving a layer into a folder (the folder stays)', async () => {
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    dragOnto('Layer 1', folderHeader('Folder 1'));
    await waitFor(() => expect(inFolder(ref, 'Layer 1')).toBe(true));
    undo();
    await waitFor(() => expect(inFolder(ref, 'Layer 1')).toBe(false));
    expect(screen.getByText('Folder 1')).toBeInTheDocument();
  });
});

describe('layer persistence', () => {
  it('exportLayers serializes the panel tree, layers, objects and panels', async () => {
    stickerIpc();
    const ref = React.createRef();
    const user = userEvent.setup();
    renderCanvas({ ref });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await act(async () => { await ref.current.importSticker(); });
    await user.click(headBtn('New Folder'));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Rename folder' }));
    dragOnto('Layer 1', folderHeader('Folder 1'));
    await waitFor(() => expect(inFolder(ref, 'Layer 1')).toBe(true));

    const payload = ref.current.exportLayers();
    expect(payload.version).toBe(2);
    expect(payload.base.panels).toHaveLength(1);
    const folder = payload.panel.find(n => n.type === 'folder');
    expect(folder.name).toBe('Folder 1');
    expect(folder.children).toContain(payload.layers[0].id);
    expect(payload.layers).toHaveLength(1);
    expect(payload.layers[0].panels[0]).toMatchObject({ partName: expect.any(String) });
    expect(payload.layers[0].objects[0]).toMatchObject({ kind: 'sticker', imageDataUrl: 'data:image/png;base64,X' });
  });

  it('restores the stack (with folders) from an initialLayers payload', async () => {
    const ref = React.createRef();
    const payload = {
      version: 2,
      activeId: 'ly2',
      base: { panels: [{ partName: 'Body', imageDataUrl: 'data:image/png;base64,QkFTRQ==' }] },
      panel: [
        { type: 'folder', id: 'fdA', name: 'Roundels', children: ['ly2'] },
        { type: 'layer', id: 'ly1' },
      ],
      layers: [
        { id: 'ly1', name: 'Background', visible: true, objects: [], panels: [{ partName: 'Body', paintDataUrl: 'data:image/png;base64,UEFJTlQ=', fillDataUrl: 'data:image/png;base64,RklMTA==' }] },
        { id: 'ly2', name: 'Decals', visible: true, objects: [{ kind: 'text', text: 'hi', font: 'sans-serif', size: 40, bold: false, italic: false, color: '#000', opacity: 1, w: 20, h: 20, x: 100, y: 100, rot: 0, flipX: false, flipY: false }], panels: [{ partName: 'Body', paintDataUrl: 'data:image/png;base64,WA==', fillDataUrl: 'data:image/png;base64,WQ==' }] },
      ],
    };
    renderCanvas({ ref, initialLayers: payload });
    await waitFor(() => expect(ref.current).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Background')).toBeInTheDocument());
    expect(screen.getByText('Decals')).toBeInTheDocument();
    expect(screen.getByText('Roundels')).toBeInTheDocument();
    expect(inFolder(ref, 'Decals')).toBe(true);
    expect(inFolder(ref, 'Background')).toBe(false);
    expect(ref.current.getObjectCount()).toBe(1);
    const ids = ref.current.exportLayers().layers.map(l => l.id);
    await waitFor(() => expect(paintCtxFor(ids[0])).toBeTruthy());
  });
});
