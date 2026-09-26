import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useTranslation } from '../../hooks/useTranslation';
import { useElectronAPI } from '../../hooks/useElectronAPI';
import { IoRemoveOutline } from 'react-icons/io5';
import { TbRotate3D } from 'react-icons/tb';
import { readPart, toBytes, computeCameraFit } from '../../utils/livery3d';

// Re-exported for the unit tests (the parser lives in the shared util).
export { readPart } from '../../utils/livery3d';

// Static (non-livery) parts — engines/fans — get a flat grey.
const STATIC_COLOR = 0x8a9099;

const MIN_W = 380;
const MIN_H = 280;

function defaultRect() {
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
  const w = Math.min(Math.round(vw * 0.74), 1040);
  const h = Math.min(Math.round(vh * 0.76), 760);
  return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
}

// Session-persistent window rect: hiding the preview and reopening it keeps the
// size + position (only the camera reset button touches the view, not the box).
let savedRect = null;

// Test hook: the rect persists for the whole app session by design, so tests
// reset it explicitly between cases.
export function __resetSavedRectForTests() { savedRect = null; }

/**
 * Livery3DPreview — the floating 3D window. Renders the live painter panels on
 * the game's real aircraft geometry. Orbit (drag) + zoom (wheel); the panel is
 * free-movable (header drag) and resizable (bottom-right grip); a bottom-right
 * button resets the camera; a top-right button hides it.
 */
export default function Livery3DPreview({ planeId, images, onHide }) {
  const { t } = useTranslation();
  const electronAPI = useElectronAPI();
  const mountRef = useRef(null);
  const stateRef = useRef(null);
  const homeRef = useRef(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const applyImagesRef = useRef(null);
  const [error, setError] = useState('');
  const [rect, setRect] = useState(() => savedRect || defaultRect());
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const updateRect = (next) => {
    const r = typeof next === 'function' ? next(rectRef.current) : next;
    rectRef.current = r;
    savedRect = r;
    setRect(r);
  };

  // ── Window drag (header) + resize (corner grip) ──
  const dragRef = useRef(null);
  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (d.mode === 'move') {
        const maxX = ((typeof window !== 'undefined' && window.innerWidth) || 1280) - 80;
        const maxY = ((typeof window !== 'undefined' && window.innerHeight) || 800) - 40;
        updateRect(r => ({ ...r, x: Math.max(-r.w + 120, Math.min(maxX, d.x + dx)), y: Math.max(0, Math.min(maxY, d.y + dy)) }));
      } else {
        const dir = d.dir || 'se';
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        let x = d.x;
        let y = d.y;
        let w = d.w;
        let h = d.h;
        if (dir.includes('e')) w = d.w + dx;
        if (dir.includes('s')) h = d.h + dy;
        if (dir.includes('w')) { w = d.w - dx; x = d.x + dx; }
        if (dir.includes('n')) { h = d.h - dy; y = d.y + dy; }
        // Keep the opposite edge fixed while enforcing the minimum size.
        if (w < MIN_W) {
          if (dir.includes('w')) x = d.x + (d.w - MIN_W);
          w = MIN_W;
        }
        if (h < MIN_H) {
          if (dir.includes('n')) y = d.y + (d.h - MIN_H);
          h = MIN_H;
        }
        updateRect({ x, y, w, h });
      }
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const startMove = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    dragRef.current = { mode: 'move', sx: e.clientX, sy: e.clientY, x: rectRef.current.x, y: rectRef.current.y };
  };
  const startResize = (e, dir) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      mode: 'resize',
      dir,
      sx: e.clientX,
      sy: e.clientY,
      x: rectRef.current.x,
      y: rectRef.current.y,
      w: rectRef.current.w,
      h: rectRef.current.h,
    };
  };

  const resetView = () => {
    const st = stateRef.current;
    const home = homeRef.current;
    if (!st || !home) return;
    st.camera.position.copy(home.position);
    st.controls.target.copy(home.target);
    st.controls.update();
  };

  useEffect(() => {
    let disposed = false;
    const mount = mountRef.current;
    if (!mount) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (err) {
      // No WebGL (e.g. a headless/unsupported context) — show the error, don't
      // crash the painter.
      setError(String((err && err.message) || err));
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.rotateSpeed = 0.9;
    controls.zoomSpeed = 0.9;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2f37, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(6, 10, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 1.2);
    fill.position.set(-7, -5, -9);
    scene.add(fill);

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    stateRef.current = { renderer, scene, camera, controls, group: null, textures: [], liveryMaterials: [] };

    // Fit the (origin-centered) model to the current window, zoomed in so it
    // fills the view (MARGIN < 1). Used on open and by the reset button.
    const fitCamera = (dims, margin = 0.7) => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      const aspect = w / h;
      const FOV = 45;
      const fit = computeCameraFit({ dims, aspect, fov: FOV, margin, dir: [1.05, 0.45, 1.15] });
      camera.fov = FOV;
      camera.aspect = aspect;
      camera.position.copy(fit.position);
      camera.near = fit.near;
      camera.far = fit.far;
      controls.target.set(0, 0, 0);
      controls.minDistance = fit.dist * 0.4;
      controls.maxDistance = fit.dist * 3;
      camera.updateProjectionMatrix();
      controls.update();
      homeRef.current = { position: camera.position.clone(), target: controls.target.clone() };
    };

    // Live livery layer: swap the map on each livery material when the painter
    // pushes fresh panel textures (matched by partName, then by order). A panel
    // may carry a `canvas` (full-res, no PNG — three uploads it directly and a
    // repeat update re-uploads the same texture) or a legacy `imageDataUrl`.
    const texLoader = new THREE.TextureLoader();
    const applyImages = (list) => {
      const st = stateRef.current;
      if (!st || !st.liveryMaterials) return;
      const arr = Array.isArray(list) ? list : [];
      const byName = new Map();
      arr.forEach((im, i) => {
        byName.set(String((im && im.partName) || '').toLowerCase(), { entry: im || {}, index: i });
      });
      let seen = 0;
      for (const rec of st.liveryMaterials) {
        const matched = byName.get(String(rec.name || '').toLowerCase()) || (arr[seen] ? { entry: arr[seen] } : null);
        seen += 1;
        const entry = matched && matched.entry;
        if (!entry) continue;

        if (entry.canvas) {
          if (rec.canvas === entry.canvas && rec.material.map) {
            rec.material.map.needsUpdate = true; // re-upload the same canvas
          } else {
            try {
              const tex = new THREE.CanvasTexture(entry.canvas);
              tex.colorSpace = THREE.SRGBColorSpace;
              tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
              if (rec.material.map) rec.material.map.dispose();
              rec.material.map = tex;
              rec.material.needsUpdate = true;
              rec.canvas = entry.canvas;
              rec.url = null;
              st.textures.push(tex);
            } catch (_) { /* keep the previous map */ }
          }
          continue;
        }

        const url = entry.imageDataUrl;
        if (!url || url === rec.url) continue;
        try {
          const tex = texLoader.load(url);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
          if (rec.material.map) rec.material.map.dispose();
          rec.material.map = tex;
          rec.material.needsUpdate = true;
          rec.url = url;
          rec.canvas = null;
          st.textures.push(tex);
        } catch (_) { /* keep the previous map */ }
      }
    };
    applyImagesRef.current = applyImages;

    (async () => {
      try {
        const res = await electronAPI.readAircraft3DBin(planeId);
        if (disposed) return;
        if (!res || !res.success) {
          setError(t(res && res.error ? `livery_3d_error_${res.error}` : 'livery_3d_error_unknown'));
          return;
        }
        const bytes = toBytes(res.bin);
        if (!bytes) { setError(t('livery_3d_error_unknown')); return; }

        const group = new THREE.Group();
        let offset = 0;
        const box = new THREE.Box3();

        for (const part of res.parts || []) {
          const geo = readPart(bytes, offset, part.vertexCount, part.indexCount);
          offset = geo.next;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
          g.setAttribute('uv', new THREE.BufferAttribute(geo.uvs, 2));
          g.setIndex(new THREE.BufferAttribute(geo.indices, 1));
          g.computeVertexNormals();
          g.computeBoundingBox();
          if (g.boundingBox) box.union(g.boundingBox);

          let material;
          if (part.livery) {
            material = new THREE.MeshStandardMaterial({
              color: 0xffffff, metalness: 0.05, roughness: 0.6, side: THREE.DoubleSide,
            });
            stateRef.current.liveryMaterials.push({ name: String(part.name || ''), material, url: null, canvas: null });
          } else {
            material = new THREE.MeshStandardMaterial({
              color: STATIC_COLOR, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide,
            });
          }
          const mesh = new THREE.Mesh(g, material);
          mesh.frustumCulled = false;
          group.add(mesh);
        }

        if (offset === 0) { setError(t('livery_3d_error_unknown')); return; }

        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        group.position.sub(center);
        scene.add(group);
        stateRef.current.group = group;

        applyImages(imagesRef.current);
        fitCamera(size);
      } catch (err) {
        if (!disposed) setError(String((err && err.message) || err));
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      const st = stateRef.current;
      if (st) {
        try { st.group && st.group.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); } catch (_) {}
        try { st.textures.forEach(tex => tex.dispose()); } catch (_) {}
      }
      try { controls.dispose(); } catch (_) {}
      try { renderer.dispose(); } catch (_) {}
      try { renderer.forceContextLoss(); } catch (_) {}
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      stateRef.current = null;
      homeRef.current = null;
      applyImagesRef.current = null;
    };
  }, [planeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live update: the painter pushes fresh panel images while the window is open.
  useEffect(() => {
    if (applyImagesRef.current) applyImagesRef.current(images);
  }, [images]);

  return (
    <div
      className="lp-3dwin"
      role="dialog"
      aria-label={t('livery_3d_open')}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <div className="lp-3dwin-head" onPointerDown={startMove}>
        <span className="lp-3dwin-title">{t('livery_3d_open')}</span>
        <button
          type="button"
          className="lp-tool lp-3dwin-hide"
          aria-label={t('livery_3d_hide')}
          title={t('livery_3d_hide')}
          onClick={onHide}
        >
          <IoRemoveOutline size={18} />
        </button>
      </div>
      <div className="lp-3dwin-body" ref={mountRef}>
        {error && <div className="lp-3dwin-error">{error}</div>}
        {!error && (
          <button
            type="button"
            className="lp-tool lp-3dwin-reset"
            aria-label={t('livery_3d_reset')}
            title={t('livery_3d_reset')}
            onClick={resetView}
          >
            <TbRotate3D size={20} />
          </button>
        )}
      </div>
      {['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map((dir) => (
        <div
          key={dir}
          className={`lp-3dwin-rz lp-3dwin-rz--${dir}`}
          onPointerDown={(e) => startResize(e, dir)}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
