/**
 * Render tests for the floating 3D window (src/components/LiveryScreen/
 * Livery3DPreview.jsx). jsdom has no WebGL, so `three`'s WebGLRenderer and
 * TextureLoader are recording fakes; the Scene/Mesh/Material/BufferGeometry/
 * Box3/PerspectiveCamera and the framing math are the REAL three.js. This
 * exercises the actual model build, the livery-texture mapping + live update,
 * the camera fit/reset, disposal, and the window move/resize logic.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import * as THREE from 'three';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';
import { mockIpcInvoke } from '../../setup';
import { computeCameraFit } from '../../../src/utils/livery3d';
import Livery3DPreview, { __resetSavedRectForTests } from '../../../src/components/LiveryScreen/Livery3DPreview';

const H = vi.hoisted(() => ({ renderers: [], textures: [], throwOnCreate: false }));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal();
  class FakeWebGLRenderer {
    constructor() {
      if (H.throwOnCreate) throw new Error('no webgl');
      this.domElement = document.createElement('canvas');
      this.capabilities = { getMaxAnisotropy: () => 8 };
      this.renders = [];
      this.disposed = 0;
      this.contextLost = false;
      H.renderers.push(this);
    }
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render(scene, camera) { this.renders.push({ scene, camera, children: scene.children.slice() }); }
    dispose() { this.disposed += 1; }
    forceContextLoss() { this.contextLost = true; }
  }
  class FakeTextureLoader {
    load(url) {
      const tex = { isTexture: true, colorSpace: null, anisotropy: 0, url, disposed: 0, dispose() { this.disposed += 1; } };
      H.textures.push(tex);
      return tex;
    }
    loadAsync(url) { return Promise.resolve(this.load(url)); }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer, TextureLoader: FakeTextureLoader };
});

// ── Fixtures ──────────────────────────────────────────────────────────────

function packParts(parts) {
  const chunks = [];
  for (const p of parts) {
    const size = p.positions.length * 4 + p.uvs.length * 4 + p.indices.length * 4;
    const dv = new DataView(new ArrayBuffer(size));
    let o = 0;
    for (const v of p.positions) { dv.setFloat32(o, v, true); o += 4; }
    for (const v of p.uvs) { dv.setFloat32(o, v, true); o += 4; }
    for (const v of p.indices) { dv.setUint32(o, v, true); o += 4; }
    chunks.push(new Uint8Array(dv.buffer));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const L = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
const S = { positions: [1, 1, 0, 1, 0, 0, 0, 1, 0], uvs: [1, 1, 1, 0, 0, 1], indices: [0, 1, 2] };
const PARTS = [
  { name: 'Fuselage', livery: true, vertexCount: 3, indexCount: 3 },
  { name: '_static', livery: false, vertexCount: 3, indexCount: 3 },
];
const BIN = packParts([L, S]);

function setupBin(overrides = {}) {
  mockIpcInvoke.mockImplementation((channel) => {
    if (channel === 'livery-3d-bin') return Promise.resolve({ success: true, parts: PARTS, bin: BIN, ...overrides });
    // Never resolve the provider's language bootstrap so it can't setState
    // outside act during the synchronous window-geometry tests.
    if (channel === 'get-cached-lang') return new Promise(() => {});
    return Promise.resolve({});
  });
}

function renderPreview(props = {}) {
  return render(
    <I18nProvider>
      <Livery3DPreview planeId="AIRBUS A-350-900" images={[]} onHide={props.onHide || (() => {})} {...props} />
    </I18nProvider>
  );
}

function liveScene() {
  const r = H.renderers[0];
  return r && r.renders.length ? r.renders.at(-1).scene : null;
}
function liveGroup() {
  const scene = liveScene();
  return scene ? scene.children.find((c) => c.isGroup) : null;
}
async function waitForGroup() {
  await waitFor(() => expect(liveGroup()).toBeTruthy());
  return liveGroup();
}
function liveCamera() {
  const r = H.renderers[0];
  return r && r.renders.length ? r.renders.at(-1).camera : null;
}

beforeEach(() => {
  setLang('en');
  __resetSavedRectForTests();
  H.renderers.length = 0;
  H.textures.length = 0;
  H.throwOnCreate = false;
  mockIpcInvoke.mockReset();
});

afterEach(() => {
  H.throwOnCreate = false;
});

// ── Model build / materials / images ──────────────────────────────────────

describe('Livery3DPreview rendering', () => {
  it('builds one mesh per part with the right materials', async () => {
    setupBin();
    renderPreview();
    const group = await waitForGroup();
    expect(group.children).toHaveLength(2);
    const [livery, stat] = group.children;
    expect(livery.material.color.getHex()).toBe(0xffffff);
    expect(stat.material.color.getHex()).toBe(0x8a9099);
    for (const m of group.children) {
      expect(m.geometry.getAttribute('position').count).toBe(3);
      expect(m.geometry.getAttribute('uv').count).toBe(3);
      expect(m.geometry.getIndex().count).toBe(3);
    }
  });

  it('maps the painter panel images onto the livery parts by partName', async () => {
    setupBin();
    const images = [
      { partName: 'Fuselage', imageDataUrl: 'data:image/png;base64,FUS' },
      { partName: '_static', imageDataUrl: 'data:image/png;base64,STAT' },
    ];
    renderPreview({ images });
    const group = await waitForGroup();
    await waitFor(() => expect(group.children[0].material.map).toBeTruthy());
    expect(group.children[0].material.map.url).toBe('data:image/png;base64,FUS');
    // static parts never take a livery texture
    expect(group.children[1].material.map).toBeNull();
  });

  it('live-updates the livery texture when the painter pushes new images', async () => {
    setupBin();
    const view = renderPreview({ images: [{ partName: 'Fuselage', imageDataUrl: 'data:image/png;base64,ONE' }] });
    const group = await waitForGroup();
    await waitFor(() => expect(group.children[0].material.map?.url).toBe('data:image/png;base64,ONE'));
    const first = group.children[0].material.map;

    view.rerender(
      <I18nProvider>
        <Livery3DPreview planeId="AIRBUS A-350-900" images={[{ partName: 'Fuselage', imageDataUrl: 'data:image/png;base64,TWO' }]} onHide={() => {}} />
      </I18nProvider>
    );
    await waitFor(() => expect(group.children[0].material.map?.url).toBe('data:image/png;base64,TWO'));
    expect(group.children[0].material.map).not.toBe(first);
    expect(first.disposed).toBeGreaterThan(0); // old texture released
  });

  it('frames the camera from the model bounding box', async () => {
    setupBin();
    renderPreview();
    const group = await waitForGroup();
    const camera = liveCamera();
    const dims = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    const expected = computeCameraFit({ dims, aspect: camera.aspect, fov: 45, margin: 0.7, dir: [1.05, 0.45, 1.15] });
    expect(camera.position.length()).toBeCloseTo(expected.dist, 6);
    expect(camera.near).toBeCloseTo(expected.near, 6);
    expect(camera.far).toBeCloseTo(expected.far, 6);
    expect(camera.fov).toBe(45);
  });

  it('reset view restores the framed camera position', async () => {
    setupBin();
    renderPreview();
    await waitForGroup();
    const camera = liveCamera();
    const home = camera.position.clone();
    act(() => { camera.position.set(999, 999, 999); });
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(camera.position.distanceTo(home)).toBeLessThan(1e-6);
  });

  it('shows an error and hides the reset button when the pack lacks the plane', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'livery-3d-bin') return Promise.resolve({ success: false, error: 'NO_PLANE' });
      if (channel === 'get-cached-lang') return new Promise(() => {});
      return Promise.resolve({});
    });
    renderPreview();
    expect(await screen.findByText(/No 3D model is available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset view' })).toBeNull();
  });

  it('reports a WebGL failure instead of crashing the painter', async () => {
    H.throwOnCreate = true;
    setupBin();
    renderPreview();
    expect(await screen.findByText(/no webgl/)).toBeInTheDocument();
  });

  it('hide button calls onHide', async () => {
    setupBin();
    const onHide = vi.fn();
    renderPreview({ onHide });
    fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('uses full-resolution canvas textures and re-uploads them in place', async () => {
    setupBin();
    const canvasA = document.createElement('canvas');
    canvasA.width = 2048; canvasA.height = 2048;
    const view = renderPreview({ images: [{ partName: 'Fuselage', canvas: canvasA }] });
    const group = await waitForGroup();
    await waitFor(() => expect(group.children[0].material.map).toBeTruthy());
    const tex = group.children[0].material.map;
    expect(tex.isCanvasTexture).toBe(true);
    expect(tex.image).toBe(canvasA);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);

    // A repeat update with the SAME canvas element re-uses the texture and just
    // re-flags it for upload (setting needsUpdate bumps `version`; no new
    // texture object, no re-encode).
    const version = tex.version;
    view.rerender(
      <I18nProvider>
        <Livery3DPreview planeId="AIRBUS A-350-900" images={[{ partName: 'Fuselage', canvas: canvasA }]} onHide={() => {}} />
      </I18nProvider>
    );
    await waitFor(() => expect(tex.version).toBeGreaterThan(version));
    expect(group.children[0].material.map).toBe(tex);
  });

  it('replaces the texture and releases the old one when the panel canvas changes', async () => {
    setupBin();
    const a = document.createElement('canvas');
    a.width = 2048; a.height = 2048;
    const b = document.createElement('canvas');
    b.width = 2048; b.height = 2048;
    const view = renderPreview({ images: [{ partName: 'Fuselage', canvas: a }] });
    const group = await waitForGroup();
    await waitFor(() => expect(group.children[0].material.map?.image).toBe(a));
    const first = group.children[0].material.map;
    const disposeSpy = vi.spyOn(first, 'dispose');
    view.rerender(
      <I18nProvider>
        <Livery3DPreview planeId="AIRBUS A-350-900" images={[{ partName: 'Fuselage', canvas: b }]} onHide={() => {}} />
      </I18nProvider>
    );
    await waitFor(() => expect(group.children[0].material.map?.image).toBe(b));
    expect(group.children[0].material.map).not.toBe(first);
    expect(disposeSpy).toHaveBeenCalled();
  });

  it('disposes the renderer and textures on unmount', async () => {
    setupBin();
    const view = renderPreview({ images: [{ partName: 'Fuselage', imageDataUrl: 'data:image/png;base64,X' }] });
    const group = await waitForGroup();
    await waitFor(() => expect(group.children[0].material.map).toBeTruthy());
    const renderer = H.renderers[0];
    const tex = group.children[0].material.map;
    view.unmount();
    expect(renderer.disposed).toBeGreaterThan(0);
    expect(renderer.contextLost).toBe(true);
    expect(tex.disposed).toBeGreaterThan(0);
  });
});

// ── Window move / resize / persistence ────────────────────────────────────

describe('Livery3DPreview window geometry', () => {
  function win() { return document.querySelector('.lp-3dwin'); }

  beforeEach(() => { setupBin(); });

  it('opens at a centered default rect (1024×768)', () => {
    renderPreview();
    const el = win();
    // vw=1024, vh=768 → w=min(758,1040)=758, h=min(584,760)=584.
    expect(el.style.width).toBe('758px');
    expect(el.style.height).toBe('584px');
    expect(el.style.left).toBe('133px');
    expect(el.style.top).toBe('92px');
  });

  it('moves with a header drag', () => {
    renderPreview();
    const head = win().querySelector('.lp-3dwin-head');
    fireEvent.pointerDown(head, { button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 140 });
    fireEvent.pointerUp(window);
    expect(win().style.left).toBe('193px');
    expect(win().style.top).toBe('132px');
    expect(win().style.width).toBe('758px');
  });

  it('does not move when the drag starts on a button', () => {
    renderPreview();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hide' }), { button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(window);
    expect(win().style.left).toBe('133px');
  });

  it('resizes from the south-east handle', () => {
    renderPreview();
    const se = win().querySelector('.lp-3dwin-rz--se');
    fireEvent.pointerDown(se, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 50 });
    fireEvent.pointerUp(window);
    expect(win().style.width).toBe('858px');
    expect(win().style.height).toBe('634px');
  });

  it('enforces the minimum size from the east handle', () => {
    renderPreview();
    const e = win().querySelector('.lp-3dwin-rz--e');
    fireEvent.pointerDown(e, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: -1000, clientY: 0 });
    expect(win().style.width).toBe('380px');
    expect(win().style.left).toBe('133px');
  });

  it('keeps the opposite edge fixed when dragging the west handle', () => {
    renderPreview();
    const w = win().querySelector('.lp-3dwin-rz--w');
    fireEvent.pointerDown(w, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 0 });
    expect(win().style.left).toBe('183px');
    expect(win().style.width).toBe('708px');
    expect(183 + 708).toBe(133 + 758); // right edge unchanged
  });

  it('keeps the bottom edge fixed when clamping the north handle', () => {
    renderPreview();
    const n = win().querySelector('.lp-3dwin-rz--n');
    fireEvent.pointerDown(n, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 1000 });
    expect(win().style.height).toBe('280px');
    expect(win().style.top).toBe('396px'); // 92 + (584 - 280)
  });

  it('remembers the size + position across unmount/remount', () => {
    const first = renderPreview();
    const se = win().querySelector('.lp-3dwin-rz--se');
    fireEvent.pointerDown(se, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 60 });
    fireEvent.pointerUp(window);
    const head = win().querySelector('.lp-3dwin-head');
    fireEvent.pointerDown(head, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 30 });
    fireEvent.pointerUp(window);
    const remembered = { left: '173px', top: '122px', width: '878px', height: '644px' };
    expect({ left: win().style.left, top: win().style.top, width: win().style.width, height: win().style.height }).toEqual(remembered);

    first.unmount();
    renderPreview();
    const el2 = win();
    expect({ left: el2.style.left, top: el2.style.top, width: el2.style.width, height: el2.style.height }).toEqual(remembered);
  });
});
