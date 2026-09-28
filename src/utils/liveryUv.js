// ─── Livery UV regions (renderer, no DOM/three) ─────────────
// The painter edits a flat 2048² BaseMap per aircraft part, but only the texels
// a mesh triangle actually samples are visible on the 3D model. Everything here
// is the pure geometry core of the "UV regions" lock:
//
//   • segmentUvIslands  — split a part's triangles into UV islands (charts) by
//     welding vertices that share a UV position, so a panel/list can name them.
//   • buildPartUvRegion — rasterize every triangle into a per-texel island-id
//     map (0 = nothing maps here) and remember each island's texel bounds.
//   • regionMask        — turn an id map into an editable mask: all islands, or
//     one island, optionally grown a couple of texels so bilinear/mip filtering
//     at a chart edge does not visibly clip the paint.
//   • hitTestRegion     — reverse-map a texel back to its island (flat → region).
//   • maskToImageData   — RGBA wrapper (white = editable) for an offscreen mask
//     canvas / the border tracer.
//
// No DOM, no three.js, so it is unit-testable and usable from either process.

export const UV_MASK_SIZE = 2048;

// Texels of growth past a chart edge. The GPU samples with bilinear/mip
// filtering, so a texel just OUTSIDE the UV boundary still tints the surface;
// without a small margin the user's paint is visibly clipped at every seam.
export const UV_GROW_PX = 2;

// Gap (fraction of the texture) bridged when grouping texels into a panel. The
// game's meshes split one artist "panel" (a tail fin, a wing half) into hundreds
// of hairline UV charts, so contiguous coverage alone is too fine; closing a
// ~0.2% gap merges the slivers of one atlas block without bridging the (larger)
// gutters between distinct blocks. At 2048² this is ~4 texels.
export const PANEL_CLOSE_RATIO = 0.002;

// UV → texel. The painter's PNG is sampled by three/WebGL with the default
// flipY, so v = 0 is the BOTTOM row of the image: texel y counts down from the
// top of the PNG.
export function uvToTexel(u, v, size = UV_MASK_SIZE) {
  return { x: u * size, y: (1 - v) * size };
}

// Union-find helpers (array-backed, no closures over the data).
function findRoot(parent, i) {
  let r = i;
  while (parent[r] !== r) r = parent[r];
  while (parent[i] !== r) { const n = parent[i]; parent[i] = r; i = n; }
  return r;
}
function unionRoots(parent, a, b) {
  const ra = findRoot(parent, a);
  const rb = findRoot(parent, b);
  if (ra !== rb) parent[rb] = ra;
}

/**
 * Split `indices` triangles into UV islands. Two triangles join when they share
 * a vertex whose UV position matches (quantized to `quant`); the game's meshes
 * duplicate seam vertices with identical UVs, so exact-position welding is
 * enough. Triangles that only touch along an edge at a T-junction stay split —
 * acceptable, and never merges two charts.
 *
 * @param {Float32Array|number[]} uvs      per-vertex u,v pairs (2n)
 * @param {Uint32Array|number[]} indices   triangle corner vertex indices (3m)
 * @param {{quant?:number}} [opts]
 * @returns {{triIsland:Int32Array, islands:Array<{tris:number[], minU:number, minV:number, maxU:number, maxV:number}>}}
 */
export function segmentUvIslands(uvs, indices, { quant = 1 / 4096 } = {}) {
  const vertexCount = (uvs.length / 2) | 0;
  const triangleCount = (indices.length / 3) | 0;
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const q = (v) => Math.round(v / quant);
  const seen = new Map();
  for (let i = 0; i < vertexCount; i++) {
    const key = q(uvs[i * 2]) + ':' + q(uvs[i * 2 + 1]);
    const first = seen.get(key);
    if (first === undefined) seen.set(key, i);
    else unionRoots(parent, first, i);
  }
  const rootToIsland = new Map();
  const triIsland = new Int32Array(triangleCount);
  const islands = [];
  for (let t = 0; t < triangleCount; t++) {
    const v0 = indices[t * 3];
    const v1 = indices[t * 3 + 1];
    const v2 = indices[t * 3 + 2];
    // A triangle is one connected chart regardless of its corners, so force
    // its three vertices into the same component before reading the island.
    // Without this a triangle whose shared seam vertex is v1/v2 (not v0) would
    // look like a separate island.
    unionRoots(parent, v0, v1);
    unionRoots(parent, v1, v2);
    const root = findRoot(parent, v0);
    let isl = rootToIsland.get(root);
    if (isl === undefined) {
      isl = islands.length;
      rootToIsland.set(root, isl);
      islands.push({ tris: [], minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity });
    }
    triIsland[t] = isl;
    const island = islands[isl];
    island.tris.push(t);
    for (const v of [v0, v1, v2]) {
      const u = uvs[v * 2];
      const w = uvs[v * 2 + 1];
      if (u < island.minU) island.minU = u;
      if (u > island.maxU) island.maxU = u;
      if (w < island.minV) island.minV = w;
      if (w > island.maxV) island.maxV = w;
    }
  }
  // A degenerate part (no triangles) leaves -Infinity bounds; normalize to 0 so
  // callers can compare/clamp without special cases.
  for (const island of islands) {
    if (!isFinite(island.minU)) { island.minU = island.minV = island.maxU = island.maxV = 0; }
  }
  return { triIsland, islands };
}

// Rasterize one triangle (texel-space, inclusive edges so shared borders are
// covered by both) into `idMap`, writing `id` wherever a texel centre is inside.
// A triangle is rasterized at u-shifts of −size, 0 and +size so charts whose UVs
// wrap past the tile edge (the game samples the BaseMap Repeat) still land
// inside it instead of being dropped as dead space.
function fillTriangle(idMap, uvs, indices, t, size, id) {
  const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
  // Texel space, same mapping as uvToTexel: x = u·size, y = (1−v)·size.
  const ax = uvs[a * 2] * size, bx = uvs[b * 2] * size, cx = uvs[c * 2] * size;
  const y0 = (1 - uvs[a * 2 + 1]) * size;
  const y1 = (1 - uvs[b * 2 + 1]) * size;
  const y2 = (1 - uvs[c * 2 + 1]) * size;
  for (const shift of [-size, 0, size]) {
    const x0 = ax + shift, x1 = bx + shift, x2 = cx + shift;
    let minX = Math.floor(Math.min(x0, x1, x2));
    let maxX = Math.ceil(Math.max(x0, x1, x2));
    let minY = Math.floor(Math.min(y0, y1, y2));
    let maxY = Math.ceil(Math.max(y0, y1, y2));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > size - 1) maxX = size - 1;
    if (maxY > size - 1) maxY = size - 1;
    if (minX > maxX || minY > maxY) continue;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      const row = y * size;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const d1 = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
        const d2 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
        const d3 = (x0 - x2) * (py - y2) - (y0 - y2) * (px - x2);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(hasNeg && hasPos)) idMap[row + x] = id;
      }
    }
  }
}

// Label 4-connected components of `mask` (nonzero = inside). Returns a map whose
// entries are `component + 1` (0 = outside) plus the component count.
function labelComponents(mask, size) {
  const n = size * size;
  const idMap = new Int32Array(n);
  const stack = new Int32Array(n);
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (!mask[start] || idMap[start]) continue;
    count++;
    let sp = 0;
    stack[sp++] = start;
    idMap[start] = count;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % size;
      const y = (i / size) | 0;
      if (x > 0 && mask[i - 1] && !idMap[i - 1]) { idMap[i - 1] = count; stack[sp++] = i - 1; }
      if (x < size - 1 && mask[i + 1] && !idMap[i + 1]) { idMap[i + 1] = count; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - size] && !idMap[i - size]) { idMap[i - size] = count; stack[sp++] = i - size; }
      if (y < size - 1 && mask[i + size] && !idMap[i + size]) { idMap[i + size] = count; stack[sp++] = i + size; }
    }
  }
  return { idMap, count };
}

/**
 * Group a part's texels into artist-scale PANELS. The game's meshes split one
 * visible panel into hundreds of hairline UV charts, so UV-island connectivity
 * is far too fine; instead this rasterizes the coverage, closes a small gap
 * (`gap` texels) to bridge those hairlines, and labels the 4-connected
 * components — one component per contiguous atlas block (a tail fin, a wing
 * half, an engine, …). `idMap[i]` is `panel + 1`, or `0` for dead UV space.
 *
 * @param {Float32Array|number[]} uvs
 * @param {Uint32Array|number[]} indices
 * @param {number} [size]
 * @param {{gap?:number}} [opts]  gap in texels (default `size * PANEL_CLOSE_RATIO`)
 * @returns {{size:number, idMap:Int32Array, islands:Array<{count:number,minX:number,minY:number,maxX:number,maxY:number}>}}
 */
export function buildPartUvRegion(uvs, indices, size = UV_MASK_SIZE, { gap } = {}) {
  const closeGap = gap == null ? Math.max(1, Math.round(size * PANEL_CLOSE_RATIO)) : Math.max(0, gap | 0);
  const triangleCount = (indices.length / 3) | 0;
  const coverage = new Uint8Array(size * size);
  for (let t = 0; t < triangleCount; t++) fillTriangle(coverage, uvs, indices, t, size, 1);
  const closed = closeGap > 0 ? dilateMask(coverage, size, closeGap) : coverage;
  const { idMap, count } = labelComponents(closed, size);
  const islands = [];
  for (let i = 0; i < count; i++) islands.push({ count: 0, minX: size, minY: size, maxX: -1, maxY: -1 });
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const id = idMap[row + x];
      if (!id) continue;
      const g = islands[id - 1];
      g.count++;
      if (x < g.minX) g.minX = x;
      if (x > g.maxX) g.maxX = x;
      if (y < g.minY) g.minY = y;
      if (y > g.maxY) g.maxY = y;
    }
  }
  return { size, idMap, islands };
}

/**
 * Grow an editable mask by `radius` texels into pixels where `blocked` is falsy.
 * `blocked` (optional) is an id map so an island's margin never swallows a
 * neighbouring chart.
 */
export function dilateMask(mask, size, radius, blocked = null) {
  if (radius <= 0) return mask;
  const n = size * size;
  let cur = mask;
  for (let r = 0; r < radius; r++) {
    const next = new Uint8Array(n);
    next.set(cur);
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const i = row + x;
        if (cur[i]) continue;
        if (blocked && blocked[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < size - 1 && cur[i + 1]) ||
            (y > 0 && cur[i - size]) || (y < size - 1 && cur[i + size])) {
          next[i] = 255;
        }
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Editable mask for a region: every mapped texel (`island < 0`) or exactly one
 * island, optionally grown by `grow` texels (into dead space only, never over a
 * different island).
 * @returns {Uint8Array} 0 = locked, 255 = editable
 */
export function regionMask(region, { island = -1, grow = 0 } = {}) {
  if (!region || !region.idMap) return null;
  const { idMap, size } = region;
  const n = size * size;
  const mask = new Uint8Array(n);
  if (island >= 0) {
    const id = island + 1;
    for (let i = 0; i < n; i++) if (idMap[i] === id) mask[i] = 255;
    return grow > 0 ? dilateMask(mask, size, grow, idMap) : mask;
  }
  for (let i = 0; i < n; i++) if (idMap[i] !== 0) mask[i] = 255;
  return grow > 0 ? dilateMask(mask, size, grow, null) : mask;
}

/** Reverse-map a texel to its island index (0-based) or -1 when unmapped. */
export function hitTestRegion(region, x, y) {
  if (!region || !region.idMap) return -1;
  const size = region.size;
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= size || yi >= size) return -1;
  const id = region.idMap[yi * size + xi];
  return id === 0 ? -1 : id - 1;
}

/** RGBA ImageData-like wrapper: opaque white where `mask`, transparent elsewhere. */
export function maskToImageData(mask, size, { r = 255, g = 255, b = 255 } = {}) {
  const n = size * size;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
  }
  return { data, width: size, height: size };
}
