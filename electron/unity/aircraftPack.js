'use strict';

// ─── Aircraft 3D model pack builder (pure JS, main process) ──────────────
// Walks the installed game's `resources.assets` and writes the livery-preview
// geometry pack (manifest.json + per-plane .bin). This is the primary extractor;
// scripts/extract-aircraft-models.py is kept as a dev-time reference and a
// last-resort fallback for game updates that change Unity's serialization.
//
// The game ships stripped type trees, so field layouts come from
// electron/unity/typetrees.json (see scripts/export-unity-typetrees.py).
//
// Pack layout (unchanged):
//   manifest.json   { version:1, planes:{ id:{ bin, parts:[{name,livery,
//                     vertexCount,indexCount,bbox}] } } }
//   <safe>.bin      per part: f32 positions[3n] · f32 uvs[2n] · u32 indices[m]

const fs = require('fs');
const path = require('path');
const { SerializedFile, CLASS_ID } = require('./serializedFile');
const { parseUnityVersion, readMeshData, buildPart } = require('./mesh');

// Cache key for the produced pack. Bump when the mapping/geometry changes so
// electron/aircraftModels.js rejects an old cached pack and rebuilds. The
// manifest/bin LAYOUT is unchanged; consumers ignore this value.
const PACK_VERSION = 2;

// parts:  ordered livery panels — the SAME order/names the painter shows.
// static: non-livery meshes/groups (engines/fans) rendered in flat grey.
const PLANES = {
  'AIRBUS A-319ceo': { parts: [{ name: 'Body', meshes: [['A319FCFM_a', 'all']] }], static: [['A319FCFM_b', 'all']] },
  'AIRBUS A-319neo': { parts: [{ name: 'Body', meshes: [['A19NCFM_a', 'all']] }], static: [['A19NCFM_b', 'all']] },
  'AIRBUS A-320ceo': { parts: [{ name: 'Body', meshes: [['A320CEO_A01_Body', 'all']] }], static: [] },
  'AIRBUS A-320neo': { parts: [{ name: 'Body', meshes: [['A20N_A01_Body', [0, 1]]] }], static: [['A20N_A01_Body', [2]]] },
  'AIRBUS A-321neo': { parts: [{ name: 'Body', meshes: [['A321_A01_Body', [0, 1]]] }], static: [['A321_A01_Body', [2]]] },
  'AIRBUS A-330-300': { parts: [{ name: 'Body', meshes: [['A333_A01_Body', 'all']] }], static: [] },
  'AIRBUS A-350-900': {
    parts: [{ name: 'Body', meshes: [['A359_A01_Body', [0, 1]]] }],
    static: [['A359_A01_Body', [2]], ['A359_A01_Fan_High', 'all'], ['A359_A01_Fan_Low', 'all']],
  },
  'AIRBUS A-380-800': {
    parts: [{ name: 'Fuselage', meshes: [['A380_a', 'all']] }, { name: 'Wing', meshes: [['A380_b', 'all']] }],
    static: [['A380_c', 'all']],
  },
  // The 737 MAX ships TWO livery parts (Fuselage + Wingtip). The game binds
  // `Wingtip` to the *engine* material, which is submesh 1 of the body mesh
  // (verified against the aircraft's AircraftHD LiverySlots: Fuselage→B737Max_mat
  // = submesh 0, Wingtip→Engine_mat = submesh 1); the fan is a separate mesh.
  'BOEING 737 MAX 8': {
    parts: [
      { name: 'Fuselage', meshes: [['B737Max_A01_Body', [0]]] },
      { name: 'Wingtip', meshes: [['B737Max_A01_Body', [1]]] },
    ],
    static: [['B737Max_A01_Fan', 'all']],
  },
  'BOEING 737-800': {
    parts: [{ name: 'Body', meshes: [['B738_A01_Body_UVFix', [0, 1, 2]]] }],
    static: [['B738_A01_Body_UVFix', [3]]],
  },
  'BOEING 747-8I': {
    parts: [{ name: 'Body', meshes: [['B748_A01_Body', [0, 1]]] }],
    static: [['B748_A01_Body', [2]], ['B748_A01_Fan_High', 'all'], ['B748_A01_Fan_Low', 'all']],
  },
  'BOEING 777-300ER': { parts: [{ name: 'Body', meshes: [['777-300ER_a', 'all']] }], static: [['777-300ER_b', 'all']] },
  'BOEING 787-9': { parts: [{ name: 'Body', meshes: [['B789_a', 'all']] }], static: [['B789_b', 'all']] },
  'BOMBARDIER CRJ700': { parts: [{ name: 'Body', meshes: [['CRJ700_a', 'all']] }], static: [['CRJ700_b', 'all']] },
  'BOMBARDIER CRJ900': { parts: [{ name: 'Body', meshes: [['CRJ900_a', 'all']] }], static: [['CRJ900_b', 'all']] },
  'COMAC C-919': { parts: [{ name: 'Body', meshes: [['C919_a', 'all']] }], static: [['C919_b', 'all']] },
  'EMBRAER E-JET 170': { parts: [{ name: 'Body', meshes: [['E170M_a', 'all']] }], static: [['E170M_b', 'all']] },
  'EMBRAER E-JET 190': { parts: [{ name: 'Body', meshes: [['E190M_a', 'all']] }], static: [['E190M_b', 'all']] },
  'GULFSTREAM 650': { parts: [{ name: 'Body', meshes: [['GS650_a', 'all']] }], static: [['GS650_b', 'all']] },
};

function safeName(planeId) { return String(planeId).replace(/[^A-Za-z0-9_.-]/g, '_'); }

// ── Transform math ────────────────────────────────────────────────────────

function quatToMatrix(x, y, z, w) {
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}

function vec3(v, dx, dy, dz) { return v ? [v.x != null ? v.x : dx, v.y != null ? v.y : dy, v.z != null ? v.z : dz] : [dx, dy, dz]; }

function localMatrix(tr) {
  const [px, py, pz] = vec3(tr.m_LocalPosition, 0, 0, 0);
  const q = tr.m_LocalRotation || { x: 0, y: 0, z: 0, w: 1 };
  let [sx, sy, sz] = vec3(tr.m_LocalScale, 1, 1, 1);
  if (sx === 0 && sy === 0 && sz === 0) { sx = sy = sz = 1; }
  const R = quatToMatrix(q.x || 0, q.y || 0, q.z || 0, q.w == null ? 1 : q.w);
  return [
    R[0] * sx, R[1] * sy, R[2] * sz, px,
    R[3] * sx, R[4] * sy, R[5] * sz, py,
    R[6] * sx, R[7] * sy, R[8] * sz, pz,
    0, 0, 0, 1,
  ];
}

function mulMat(a, b) {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return out;
}

/** Compose a Transform's world matrix up its m_Father chain, with a per-run cache. */
function worldMatrix(sf, pptr, cache) {
  const key = String(pptr.m_PathID);
  if (cache.has(key)) return cache.get(key);
  const entry = sf.resolvePPtr(pptr);
  if (!entry || entry.classId !== CLASS_ID.Transform) return null;
  const tr = sf.parseObject(entry, false).value;
  let m = localMatrix(tr);
  const parent = sf.resolvePPtr(tr.m_Father);
  if (parent) {
    const pm = worldMatrix(sf, tr.m_Father, cache);
    if (pm) m = mulMat(pm, m);
  }
  cache.set(key, m);
  return m;
}

function findTransformEntry(sf, go) {
  for (const c of (go.m_Component || [])) {
    const e = sf.resolvePPtr(c.component);
    if (e && e.classId === CLASS_ID.Transform) return e;
  }
  return null;
}

// ── Resource (.resS) reading ──────────────────────────────────────────────

function readResource(assetsPath, resPath, offset, size) {
  const dir = path.dirname(assetsPath);
  const base = path.basename(String(resPath).replace(/\\/g, '/'));
  const dot = base.lastIndexOf('.');
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const candidates = [base, `${stem}.resource`, `${stem}.assets.resS`, `${stem}.resS`];
  for (const cand of candidates) {
    const p = path.join(dir, cand);
    if (!fs.existsSync(p)) continue;
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(size);
      const read = fs.readSync(fd, buf, 0, size, offset);
      return read === size ? buf : buf.subarray(0, read);
    } catch (_) {
      return null;
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }
  return null;
}

function resolveVertexData(sf, assetsPath, mesh) {
  const sd = mesh.m_StreamData;
  if (!sd || !sd.path) return null;
  const offset = Number(sd.offset);
  const size = Number(sd.size);
  if (!size) return null;
  return readResource(assetsPath, sd.path, offset, size);
}

// ── Extraction ────────────────────────────────────────────────────────────

const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Build the pack for every (or `only`) plane in PLANES.
 * @param {object} o
 * @param {string} o.assetsPath   absolute path to resources.assets
 * @param {string} o.outDir       pack output directory (created if absent)
 * @param {string[]} [o.only]     restrict to these plane IDs
 * @param {(s:string)=>void} [o.onLog]
 * @param {(info:{phase:string, plane?:string, done:number, total:number})=>void} [o.onProgress]
 * @returns {Promise<{manifest:object, planes:number, parts:number, bytes:number}>}
 */
async function extract(o) {
  const { assetsPath, outDir, only, onLog, onProgress } = o;
  const log = (s) => { if (onLog) { try { onLog(s); } catch (_) {} } };
  fs.mkdirSync(outDir, { recursive: true });

  log(`[3d] reading ${assetsPath}\n`);
  const sf = SerializedFile.open(assetsPath);
  const major = parseUnityVersion(sf.unityVersion).major;
  log(`[3d] Unity ${sf.unityVersion} (format v${sf.version}, ${sf.objects.size} objects)\n`);

  try {
    // 1. Mesh objects by name (last wins, matching the Python extractor).
    const meshEntries = sf.objectsOfClass(CLASS_ID.Mesh);
    const meshByName = new Map();
    for (let i = 0; i < meshEntries.length; i++) {
      try { const n = sf.peekName(meshEntries[i]); if (n) meshByName.set(n, meshEntries[i]); } catch (_) {}
      if ((i & 63) === 0) await yieldTick();
    }

    // 2. SkinnedMeshRenderer → mesh name → world matrix.
    const rendererByMesh = new Map();
    const trCache = new Map();
    const smrs = sf.objectsOfClass(CLASS_ID.SkinnedMeshRenderer);
    for (let i = 0; i < smrs.length; i++) {
      try {
        const r = sf.parseObject(smrs[i], false).value;
        const meshEntry = sf.resolvePPtr(r.m_Mesh);
        const meshName = meshEntry ? sf.peekName(meshEntry) : null;
        if (meshName) {
          const goEntry = sf.resolvePPtr(r.m_GameObject);
          if (goEntry) {
            const go = sf.parseObject(goEntry, false).value;
            const tEntry = findTransformEntry(sf, go);
            if (tEntry) {
              const m = worldMatrix(sf, { m_FileID: 0, m_PathID: tEntry.pathId }, trCache);
              if (m) rendererByMesh.set(meshName, m);
            }
          }
        }
      } catch (_) { /* skip malformed renderer */ }
      if ((i & 31) === 0) await yieldTick();
    }

    const wanted = Object.keys(PLANES).filter((p) => !only || !only.length || only.indexOf(p) >= 0);

    // Meshes are parsed lazily and cached (a mesh can be a livery part and a
    // static part at once — A20N/A321/A359/B738/B748).
    const meshCache = new Map();
    const getMeshData = (meshName) => {
      if (meshCache.has(meshName)) return meshCache.get(meshName);
      const entry = meshByName.get(meshName);
      if (!entry) { meshCache.set(meshName, null); return null; }
      try {
        const mesh = sf.parseObject(entry, false).value;
        const streamed = resolveVertexData(sf, assetsPath, mesh);
        const data = readMeshData(mesh, { major, endian: sf.endian, vertexData: streamed || undefined });
        meshCache.set(meshName, data);
        return data;
      } catch (err) {
        log(`[3d] mesh ${meshName} failed: ${err.message}\n`);
        meshCache.set(meshName, null);
        return null;
      }
    };

    const manifest = { version: PACK_VERSION, planes: {} };
    let partTotal = 0;
    let byteTotal = 0;

    for (let pi = 0; pi < wanted.length; pi++) {
      const planeId = wanted[pi];
      const cfg = PLANES[planeId];
      const partsOut = [];
      const binChunks = [];

      const addPart = (name, livery, meshName, groups) => {
        const md = getMeshData(meshName);
        if (!md) return;
        const matrix = rendererByMesh.get(meshName) || null;
        const built = buildPart(md, groups, matrix);
        if (!built) return;
        partsOut.push({
          name, livery,
          vertexCount: built.positions.length / 3,
          indexCount: built.indices.length,
          bbox: built.bbox,
        });
        binChunks.push(Buffer.from(built.positions.buffer, built.positions.byteOffset, built.positions.byteLength));
        binChunks.push(Buffer.from(built.uvs.buffer, built.uvs.byteOffset, built.uvs.byteLength));
        binChunks.push(Buffer.from(built.indices.buffer, built.indices.byteOffset, built.indices.byteLength));
      };

      for (const part of cfg.parts) {
        for (const [meshName, groups] of part.meshes) addPart(part.name, true, meshName, groups);
      }
      for (const [meshName, groups] of cfg.static) addPart('_static', false, meshName, groups);

      if (!partsOut.length) { log(`[3d] no geometry for ${planeId}\n`); continue; }

      const fname = `${safeName(planeId)}.bin`;
      const bin = Buffer.concat(binChunks);
      fs.writeFileSync(path.join(outDir, fname), bin);
      manifest.planes[planeId] = { bin: fname, parts: partsOut };
      partTotal += partsOut.length;
      byteTotal += bin.length;
      log(`[3d]   ${planeId.padEnd(22)} ${partsOut.length} part(s), ${Math.round(bin.length / 1024)} KB\n`);
      if (onProgress) { try { onProgress({ phase: 'plane', plane: planeId, done: pi + 1, total: wanted.length }); } catch (_) {} }
      await yieldTick();
    }

    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    log(`[3d] wrote ${Object.keys(manifest.planes).length} plane(s), ${partTotal} part(s)\n`);
    return { manifest, planes: Object.keys(manifest.planes).length, parts: partTotal, bytes: byteTotal };
  } finally {
    sf.close();
  }
}

module.exports = { PACK_VERSION, PLANES, safeName, extract, quatToMatrix, localMatrix, mulMat, worldMatrix, readResource, resolveVertexData };