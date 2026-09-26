// @vitest-environment jsdom

/**
 * Unit tests for src/utils/livery3d.js — the shared pack parser, the camera
 * framing math and the singleton offscreen snapshot renderer.
 *
 * jsdom has no WebGL, so `three`'s WebGLRenderer and TextureLoader are replaced
 * with recording fakes; everything else (Scene, Mesh, BufferGeometry, Box3,
 * PerspectiveCamera, the framing math) is the REAL three.js, so the render
 * setup, geometry and camera framing are genuinely exercised.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  readPart, toBytes, computeCameraFit, renderLiverySnapshot, disposeLiverySnapshots,
} from '../../src/utils/livery3d';

const H = vi.hoisted(() => ({
  renderers: [],
  textures: [],
  events: [],
  throwOnCreate: false,
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal();
  class FakeWebGLRenderer {
    constructor() {
      if (H.throwOnCreate) throw new Error('no webgl');
      this.domElement = document.createElement('canvas');
      this.domElement.toDataURL = () => 'data:image/png;base64,FAKE';
      this.capabilities = { getMaxAnisotropy: () => 8 };
      this.renders = [];
      this.disposed = 0;
      this.contextLost = false;
      H.renderers.push(this);
    }
    setPixelRatio() {}
    setSize(w, h) { this.lastSize = [w, h]; }
    setClearColor() {}
    render(scene, camera) { this.renders.push({ scene, camera, children: scene.children.slice() }); H.events.push('render'); }
    dispose() { this.disposed += 1; }
    forceContextLoss() { this.contextLost = true; }
  }
  class FakeTextureLoader {
    load(url) {
      const tex = { isTexture: true, colorSpace: null, anisotropy: 0, url, disposed: 0, dispose() { this.disposed += 1; } };
      H.textures.push(tex);
      H.events.push(`load:${url}`);
      return tex;
    }
    loadAsync(url) { return Promise.resolve(this.load(url)); }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer, TextureLoader: FakeTextureLoader };
});

// ── Fixtures ──────────────────────────────────────────────────────────────

/** Pack parts exactly like the extractor writes them: f32 pos[3n]·f32 uv[2n]·u32 idx[m]. */
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

// A 1×1 quad in the z=0 plane, split into two triangles (3+3 unique verts across parts).
const TRI = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  uvs: [0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
};
const TRI2 = {
  positions: [1, 1, 0, 1, 0, 0, 0, 1, 0],
  uvs: [1, 1, 1, 0, 0, 1],
  indices: [0, 1, 2],
};

const PARTS = [
  { name: 'Body', livery: true, vertexCount: 3, indexCount: 3 },
  { name: '_static', livery: false, vertexCount: 3, indexCount: 3 },
];
const BIN = packParts([TRI, TRI2]);

function reset() {
  disposeLiverySnapshots();
  H.renderers.length = 0;
  H.textures.length = 0;
  H.events.length = 0;
  H.throwOnCreate = false;
}

beforeEach(reset);
afterEach(reset);

// ── Parser ────────────────────────────────────────────────────────────────

describe('readPart', () => {
  it('decodes positions, uvs and indices and reports the next offset', () => {
    const bytes = packParts([TRI]);
    const part = readPart(bytes, 0, 3, 3);
    expect(Array.from(part.positions)).toEqual(TRI.positions);
    expect(Array.from(part.uvs)).toEqual(TRI.uvs);
    expect(Array.from(part.indices)).toEqual(TRI.indices);
    expect(part.next).toBe(bytes.length);
  });

  it('honours a non-zero offset (concatenated parts)', () => {
    const bytes = packParts([TRI, TRI2]);
    const first = readPart(bytes, 0, 3, 3);
    const second = readPart(bytes, first.next, 3, 3);
    expect(Array.from(second.positions)).toEqual(TRI2.positions);
    expect(second.next).toBe(bytes.length);
  });
});

describe('toBytes', () => {
  it('normalizes Uint8Array / ArrayBuffer / typed-array views', () => {
    const u8 = new Uint8Array([1, 2, 3]);
    expect(toBytes(u8)).toBe(u8);
    expect(Array.from(toBytes(u8.buffer))).toEqual([1, 2, 3]);
    const view = new Uint8Array(u8.buffer, 1, 2);
    expect(Array.from(toBytes(view))).toEqual([2, 3]);
  });

  it('returns null for empty/unknown input', () => {
    expect(toBytes(null)).toBeNull();
    expect(toBytes(undefined)).toBeNull();
    expect(toBytes('nope')).toBeNull();
  });
});

// ── Camera framing ────────────────────────────────────────────────────────

describe('computeCameraFit', () => {
  const cube = { x: 2, y: 2, z: 2 };

  it('places the camera along dir at the fitted distance', () => {
    const fit = computeCameraFit({ dims: cube, aspect: 2, fov: 40, margin: 1, dir: [0.58, 0.32, 0.75] });
    expect(fit.dist).toBeGreaterThan(0);
    expect(fit.position.length()).toBeCloseTo(fit.dist, 10);
    const dir = new THREE.Vector3(0.58, 0.32, 0.75).normalize();
    const got = fit.position.clone().normalize();
    expect(got.distanceTo(dir)).toBeLessThan(1e-9);
  });

  it('sets near/far clip planes around the model', () => {
    const fit = computeCameraFit({ dims: cube, aspect: 1, fov: 45, margin: 1 });
    expect(fit.near).toBeCloseTo(fit.dist * 0.01, 6);
    expect(fit.far).toBeCloseTo(fit.dist * 4 + 4, 6);
    expect(fit.far).toBeGreaterThan(fit.near);
  });

  it('scales linearly with margin (MARGIN < 1 zooms in)', () => {
    const full = computeCameraFit({ dims: cube, aspect: 1, fov: 40, margin: 1 });
    const zoomed = computeCameraFit({ dims: cube, aspect: 1, fov: 40, margin: 0.5 });
    expect(zoomed.dist).toBeCloseTo(full.dist * 0.5, 9);
  });

  it('frames a bigger model further out', () => {
    const small = computeCameraFit({ dims: { x: 1, y: 1, z: 1 }, aspect: 1, fov: 40, margin: 1 });
    const big = computeCameraFit({ dims: { x: 10, y: 10, z: 10 }, aspect: 1, fov: 40, margin: 1 });
    expect(big.dist).toBeGreaterThan(small.dist);
  });

  it('accounts for the viewport aspect (wide boxes frame by height on a tall viewport)', () => {
    const tall = computeCameraFit({ dims: { x: 20, y: 1, z: 1 }, aspect: 0.5, fov: 40, margin: 1 });
    const wide = computeCameraFit({ dims: { x: 20, y: 1, z: 1 }, aspect: 4, fov: 40, margin: 1 });
    expect(tall.dist).toBeGreaterThan(wide.dist);
  });
});

// ── Offscreen snapshot renderer ───────────────────────────────────────────

describe('renderLiverySnapshot', () => {
  it('renders the model and returns the canvas data URL', async () => {
    const url = await renderLiverySnapshot({ key: 'k1', planeId: 'P1', parts: PARTS, bin: BIN, textureUrl: 'data:image/png;base64,TEX' });
    expect(url).toBe('data:image/png;base64,FAKE');

    const renderer = H.renderers.at(-1);
    expect(renderer.renders.length).toBeGreaterThan(0);
    const { camera, children } = renderer.renders.at(-1);
    const group = children.find((c) => c.isGroup);
    expect(group.children).toHaveLength(2);
    expect(camera.aspect).toBeCloseTo(640 / 320, 6);
  });

  it('textures livery parts and leaves static parts flat grey', async () => {
    await renderLiverySnapshot({ key: 'k2', planeId: 'P2', parts: PARTS, bin: BIN, textureUrl: 'data:image/png;base64,FUS' });
    const group = H.renderers.at(-1).renders.at(-1).children.find((c) => c.isGroup);
    const [livery, stat] = group.children;
    expect(livery.material.color.getHex()).toBe(0xffffff);
    expect(stat.material.color.getHex()).toBe(0x8a9099);
    expect(livery.material.map).toBeTruthy();
    expect(livery.material.map.url).toBe('data:image/png;base64,FUS');
    expect(stat.material.map).toBeNull();
  });

  it('renders untextured when no textureUrl is given', async () => {
    await renderLiverySnapshot({ key: 'k3', planeId: 'P3', parts: PARTS, bin: BIN });
    const group = H.renderers.at(-1).renders.at(-1).children.find((c) => c.isGroup);
    expect(group.children[0].material.map).toBeNull();
  });

  it('frames the camera from the model bounding box (matches computeCameraFit)', async () => {
    await renderLiverySnapshot({ key: 'k4', planeId: 'P4', parts: PARTS, bin: BIN });
    const { camera } = H.renderers.at(-1).renders.at(-1);
    const expected = computeCameraFit({
      dims: { x: 1, y: 1, z: 0 }, aspect: 640 / 320, fov: 40, margin: 0.72, dir: [0.58, 0.32, 0.75],
    });
    expect(camera.position.length()).toBeCloseTo(expected.dist, 6);
    expect(camera.near).toBeCloseTo(expected.near, 6);
    expect(camera.far).toBeCloseTo(expected.far, 6);
  });

  it('caches the rendered URL by key (no second render)', async () => {
    const a = await renderLiverySnapshot({ key: 'same', planeId: 'P5', parts: PARTS, bin: BIN });
    const renderer = H.renderers.at(-1);
    const renders = renderer.renders.length;
    const b = await renderLiverySnapshot({ key: 'same', planeId: 'P5', parts: PARTS, bin: BIN });
    expect(b).toBe(a);
    expect(renderer.renders.length).toBe(renders);
  });

  it('reuses the parsed geometry for repeat planes', async () => {
    await renderLiverySnapshot({ key: 'g1', planeId: 'SHARED', parts: PARTS, bin: BIN });
    const geo1 = H.renderers.at(-1).renders.at(-1).children.find((c) => c.isGroup).children[0].geometry;
    await renderLiverySnapshot({ key: 'g2', planeId: 'SHARED', parts: PARTS, bin: BIN });
    const geo2 = H.renderers.at(-1).renders.at(-1).children.find((c) => c.isGroup).children[0].geometry;
    expect(geo2).toBe(geo1);
  });

  it('serializes concurrent renders through one GL context, in order', async () => {
    H.events.length = 0;
    await Promise.all([
      renderLiverySnapshot({ key: 's1', planeId: 'S', parts: PARTS, bin: BIN, textureUrl: 'T1' }),
      renderLiverySnapshot({ key: 's2', planeId: 'S', parts: PARTS, bin: BIN, textureUrl: 'T2' }),
    ]);
    // Only one renderer is ever created, and the second render starts only
    // after the first finished loading its texture.
    expect(H.renderers).toHaveLength(1);
    expect(H.events).toEqual(['load:T1', 'render', 'load:T2', 'render']);
  });

  it('returns null for empty geometry and does not render', async () => {
    const url = await renderLiverySnapshot({ key: 'empty', planeId: 'E', parts: [], bin: new Uint8Array(0) });
    expect(url).toBeNull();
    expect(H.renderers.reduce((n, r) => n + r.renders.length, 0)).toBe(0);
  });

  it('returns null (and stays null) when WebGL is unavailable', async () => {
    H.throwOnCreate = true;
    expect(await renderLiverySnapshot({ key: 'f1', planeId: 'F', parts: PARTS, bin: BIN })).toBeNull();
    expect(H.renderers).toHaveLength(0);
    // Sticky failure: no further renderer creation attempts until disposal.
    H.throwOnCreate = false;
    expect(await renderLiverySnapshot({ key: 'f2', planeId: 'F', parts: PARTS, bin: BIN })).toBeNull();
    expect(H.renderers).toHaveLength(0);
  });

  it('reports a failed WebGL context as null without throwing', async () => {
    H.throwOnCreate = true;
    await expect(renderLiverySnapshot({ key: 'x', planeId: 'X', parts: PARTS, bin: BIN })).resolves.toBeNull();
    H.throwOnCreate = false;
  });
});

describe('disposeLiverySnapshots', () => {
  it('disposes the renderer, clears caches and allows a fresh context', async () => {
    await renderLiverySnapshot({ key: 'd1', planeId: 'D', parts: PARTS, bin: BIN });
    const first = H.renderers.at(-1);
    disposeLiverySnapshots();
    expect(first.disposed).toBeGreaterThan(0);
    expect(first.contextLost).toBe(true);

    // Caches cleared: the same key renders again, on a brand-new renderer.
    await renderLiverySnapshot({ key: 'd1', planeId: 'D', parts: PARTS, bin: BIN });
    expect(H.renderers).toHaveLength(2);
    expect(H.renderers[1]).not.toBe(first);
  });

  it('is safe to call with nothing rendered', () => {
    expect(() => disposeLiverySnapshots()).not.toThrow();
  });
});
