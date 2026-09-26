// ─── Shared 3D livery helpers ───────────────────────────────
// The pack parser (used by the floating preview window AND the offscreen list
// snapshots) plus the singleton offscreen renderer that turns a livery into a
// small 3D thumbnail for the livery list.

import * as THREE from 'three';

const DEFAULT_W = 640;
const DEFAULT_H = 320; // 2:1 — matches the card's .livery-thumb aspect-ratio
const STATIC_COLOR = 0x8a9099;

/**
 * Read one concatenated model part out of the pack binary.
 * Layout per part: f32 positions[3n] · f32 uvs[2n] · u32 indices[m].
 */
export function readPart(bytes, offset, vertexCount, indexCount) {
  const posBytes = vertexCount * 3 * 4;
  const uvBytes = vertexCount * 2 * 4;
  const idxBytes = indexCount * 4;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = view.getFloat32(offset + i * 4, true);

  const uvs = new Float32Array(vertexCount * 2);
  const uvStart = offset + posBytes;
  for (let i = 0; i < uvs.length; i++) uvs[i] = view.getFloat32(uvStart + i * 4, true);

  const indices = new Uint32Array(indexCount);
  const idxStart = uvStart + uvBytes;
  for (let i = 0; i < indexCount; i++) indices[i] = view.getUint32(idxStart + i * 4, true);

  return { positions, uvs, indices, next: idxStart + idxBytes };
}

export function toBytes(bin) {
  if (!bin) return null;
  if (bin instanceof Uint8Array) return bin;
  if (bin instanceof ArrayBuffer) return new Uint8Array(bin);
  if (ArrayBuffer.isView(bin)) return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  return null;
}

/**
 * Fit an axis-aligned bounding box (centred on the origin, in world units) to a
 * viewport, returning the camera position + clip planes. The camera looks at the
 * origin along `dir`; MARGIN < 1 zooms past a bounding-box fit so the aircraft
 * fills more of the frame (the loose box corners clip, not the aircraft).
 *
 * Pure (no renderer) so the framing math is unit-testable.
 * @param {{dims:{x:number,y:number,z:number}, aspect:number, fov:number,
 *          margin?:number, dir?:number[]}} o
 * @returns {{position: THREE.Vector3, dist:number, near:number, far:number}}
 */
export function computeCameraFit({ dims, aspect, fov, margin = 1, dir = [0.58, 0.32, 0.75] }) {
  const camDir = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const forward = camDir.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const camUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * aspect;
  let maxRight = 0;
  let maxUp = 0;
  let maxDepth = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p = new THREE.Vector3((sx * dims.x) / 2, (sy * dims.y) / 2, (sz * dims.z) / 2);
        maxRight = Math.max(maxRight, Math.abs(p.dot(right)));
        maxUp = Math.max(maxUp, Math.abs(p.dot(camUp)));
        maxDepth = Math.max(maxDepth, p.dot(forward));
      }
    }
  }
  const dist = (Math.max(maxUp / tanV, maxRight / tanH) + maxDepth) * margin;
  return {
    position: camDir.multiplyScalar(dist),
    dist,
    near: Math.max(dist * 0.01, 0.01),
    far: dist * 4 + Math.max(dims.x, dims.y, dims.z) * 2,
  };
}

// ─── Offscreen snapshot renderer ────────────────────────────
let _renderer = null;
let _scene = null;
let _camera = null;
let _failed = false;
let _size = { w: 0, h: 0 };
const _geoCache = new Map(); // planeId -> [{ livery, geometry }]
const _urlCache = new Map(); // cacheKey -> data URL
let _chain = Promise.resolve(); // serializes renders (one shared GL context)

function serialize(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.catch(() => {});
  return run;
}

function ensureRenderer(w, h) {
  if (_failed) return null;
  try {
    if (!_renderer) {
      if (typeof document === 'undefined') { _failed = true; return null; }
      const canvas = document.createElement('canvas');
      _renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      _renderer.setSize(w, h, false);
      _renderer.outputColorSpace = THREE.SRGBColorSpace;
      _renderer.setClearColor(0x000000, 0);
      _scene = new THREE.Scene();
      _camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 1e6);
      _scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2f37, 2.4));
      const d1 = new THREE.DirectionalLight(0xffffff, 2.6); d1.position.set(6, 10, 8); _scene.add(d1);
      const d2 = new THREE.DirectionalLight(0xffffff, 1.2); d2.position.set(-7, -5, -9); _scene.add(d2);
      _size = { w, h };
    } else if (_size.w !== w || _size.h !== h) {
      _renderer.setSize(w, h, false);
      _size = { w, h };
    }
    return _renderer;
  } catch (_) {
    _failed = true;
    _renderer = null;
    return null;
  }
}

function getGeometries(planeId, parts, bin) {
  if (_geoCache.has(planeId)) return _geoCache.get(planeId);
  const bytes = toBytes(bin);
  if (!bytes || !Array.isArray(parts)) return null;
  const out = [];
  let offset = 0;
  for (const part of parts) {
    const g = readPart(bytes, offset, part.vertexCount, part.indexCount);
    offset = g.next;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    out.push({ livery: Boolean(part.livery), name: String(part.name || ''), geometry: geo });
  }
  _geoCache.set(planeId, out);
  return out;
}

/**
 * Render `planeId` (with `textureUrl` on its livery parts) to a PNG data URL at
 * the given size (default 640×320 = the card's 2:1 box). Returns null when
 * WebGL is unavailable or anything fails. Cached by `key`.
 */
export function renderLiverySnapshot({ key, planeId, parts, bin, textureUrl, width = DEFAULT_W, height = DEFAULT_H }) {
  if (_urlCache.has(key)) return Promise.resolve(_urlCache.get(key));
  return serialize(async () => {
    if (_urlCache.has(key)) return _urlCache.get(key);
    const renderer = ensureRenderer(width, height);
    if (!renderer) return null;
    const geos = getGeometries(planeId, parts, bin);
    if (!geos || !geos.length) return null;

    let texture = null;
    const materials = [];
    const group = new THREE.Group();
    const box = new THREE.Box3();
    try {
      if (textureUrl) {
        try {
          texture = await new THREE.TextureLoader().loadAsync(textureUrl);
          texture.colorSpace = THREE.SRGBColorSpace;
        } catch (_) { texture = null; }
      }
      for (const g of geos) {
        const useMap = g.livery && texture;
        const mat = new THREE.MeshStandardMaterial({
          color: useMap ? 0xffffff : STATIC_COLOR,
          metalness: 0.05,
          roughness: 0.65,
          side: THREE.DoubleSide,
        });
        if (useMap) mat.map = texture;
        materials.push(mat);
        group.add(new THREE.Mesh(g.geometry, mat));
        if (g.geometry.boundingBox) box.union(g.geometry.boundingBox);
      }
      const dims = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(dims);
      box.getCenter(center);
      group.position.sub(center);
      _scene.add(group);

      // Frame the (origin-centered) bounding box for this viewport aspect.
      // MARGIN < 1 zooms past a bounding-box fit (~1/1.5) so the aircraft fills
      // more of the card — the loose box corners clip, not the aircraft.
      const FOV = 40;
      const MARGIN = 0.72;
      const fit = computeCameraFit({ dims, aspect: width / height, fov: FOV, margin: MARGIN, dir: [0.58, 0.32, 0.75] });
      _camera.fov = FOV;
      _camera.aspect = width / height;
      _camera.position.copy(fit.position);
      _camera.lookAt(0, 0, 0);
      _camera.near = fit.near;
      _camera.far = fit.far;
      _camera.updateProjectionMatrix();
      renderer.render(_scene, _camera);
      const url = renderer.domElement.toDataURL('image/png');
      _urlCache.set(key, url);
      return url;
    } catch (_) {
      return null;
    } finally {
      try { _scene.remove(group); } catch (_) {}
      for (const mat of materials) { try { mat.dispose(); } catch (_) {} }
      try { if (texture) texture.dispose(); } catch (_) {}
    }
  });
}

/** Tear down the offscreen renderer + caches (leaving the livery page). */
export function disposeLiverySnapshots() {
  try { if (_renderer) { _renderer.dispose(); _renderer.forceContextLoss && _renderer.forceContextLoss(); } } catch (_) {}
  for (const geos of _geoCache.values()) {
    for (const g of geos) { try { g.geometry.dispose(); } catch (_) {} }
  }
  _geoCache.clear();
  _urlCache.clear();
  _renderer = null;
  _scene = null;
  _camera = null;
  _failed = false;
}
