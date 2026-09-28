import { describe, it, expect } from 'vitest';
import {
  UV_MASK_SIZE,
  UV_GROW_PX,
  uvToTexel,
  segmentUvIslands,
  buildPartUvRegion,
  dilateMask,
  regionMask,
  hitTestRegion,
  maskToImageData,
} from '../../src/utils/liveryUv';

const SIZE = 64;

// A quad (two triangles) at the given UV rectangle.
function quad(u0, v0, u1, v1) {
  return {
    uvs: new Float32Array([u0, v0, u1, v0, u1, v1, u0, v1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function concatParts(a, b) {
  const base = a.uvs.length / 2;
  return {
    uvs: new Float32Array([...a.uvs, ...b.uvs]),
    indices: new Uint32Array([...a.indices, ...b.indices.map(i => i + base)]),
  };
}

function countMask(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

describe('uvToTexel', () => {
  it('maps v=1 to the top row and v=0 to the bottom row (flipY)', () => {
    expect(uvToTexel(0, 1, 100)).toEqual({ x: 0, y: 0 });
    expect(uvToTexel(1, 0, 100)).toEqual({ x: 100, y: 100 });
    expect(uvToTexel(0.5, 0.25, 100)).toEqual({ x: 50, y: 75 });
  });
});

describe('segmentUvIslands', () => {
  it('splits disjoint UV charts into separate islands', () => {
    const { uvs, indices } = concatParts(quad(0, 0, 0.4, 0.4), quad(0.6, 0.6, 1, 1));
    const { triIsland, islands } = segmentUvIslands(uvs, indices);
    expect(islands).toHaveLength(2);
    expect(triIsland[0]).toBe(0);
    expect(triIsland[1]).toBe(0);
    expect(triIsland[2]).toBe(1);
    expect(triIsland[3]).toBe(1);
    expect(islands[0].tris).toEqual([0, 1]);
    expect(islands[1].tris).toEqual([2, 3]);
  });

  it('joins triangles that share a UV position (seam-duplicated vertices)', () => {
    // Two quads meeting along u=0.5, but with their own (duplicate) vertices.
    const left = quad(0, 0, 0.5, 1);
    const right = quad(0.5, 0, 1, 1);
    const { uvs, indices } = concatParts(left, right);
    const { islands } = segmentUvIslands(uvs, indices);
    expect(islands).toHaveLength(1);
  });
});

describe('buildPartUvRegion', () => {
  it('maps every texel of a full-image quad and leaves no dead space', () => {
    const { uvs, indices } = quad(0, 0, 1, 1);
    const region = buildPartUvRegion(uvs, indices, SIZE);
    expect(region.islands).toHaveLength(1);
    expect(countMask(regionMask(region))).toBe(SIZE * SIZE);
    expect(hitTestRegion(region, 10, 10)).toBe(0);
  });

  it('reports dead UV space as id 0 / -1 hit', () => {
    const { uvs, indices } = quad(0, 0, 0.25, 0.25);
    const region = buildPartUvRegion(uvs, indices, SIZE);
    // UV (0,0) is the image's bottom-left corner (v is flipped), so the quad
    // occupies the bottom-left texel corner only.
    expect(region.idMap[(SIZE - 1) * SIZE]).toBe(1);
    expect(region.idMap[0]).toBe(0);
    expect(hitTestRegion(region, 0, SIZE - 1)).toBe(0);
    expect(hitTestRegion(region, SIZE - 1, 0)).toBe(-1);
    expect(countMask(regionMask(region))).toBeLessThan(SIZE * SIZE);
  });

  it('keeps two charts distinct in the id map', () => {
    const { uvs, indices } = concatParts(quad(0, 0, 0.3, 0.3), quad(0.7, 0.7, 1, 1));
    const region = buildPartUvRegion(uvs, indices, SIZE);
    expect(region.islands).toHaveLength(2);
    const maskA = regionMask(region, { island: 0 });
    const maskB = regionMask(region, { island: 1 });
    expect(countMask(maskA)).toBeGreaterThan(0);
    expect(countMask(maskB)).toBeGreaterThan(0);
    // A pixel of island B is never editable in the island-A mask.
    for (let i = 0; i < region.idMap.length; i++) {
      if (region.idMap[i] === 2) expect(maskA[i]).toBe(0);
      if (region.idMap[i] === 1) expect(maskB[i]).toBe(0);
    }
  });
});

describe('dilateMask', () => {
  it('grows the mask by one texel per 4-connected pass', () => {
    const size = 8;
    const mask = new Uint8Array(size * size);
    mask[3 * size + 3] = 255;
    const grown = dilateMask(mask, size, 1);
    expect(countMask(grown)).toBe(5); // centre + 4 orthogonal neighbours
    expect(grown[3 * size + 3 + 1]).toBe(255);
  });

  it('never grows into a blocked pixel', () => {
    const size = 8;
    const mask = new Uint8Array(size * size);
    mask[3 * size + 3] = 255;
    const blocked = new Uint8Array(size * size);
    blocked[3 * size + 4] = 1;
    const grown = dilateMask(mask, size, 1, blocked);
    expect(grown[3 * size + 4]).toBe(0);
    expect(grown[3 * size + 2]).toBe(255);
  });
});

describe('regionMask growth', () => {
  it('grows an island only into dead space, never over another island', () => {
    const { uvs, indices } = concatParts(quad(0.4, 0.4, 0.6, 0.6), quad(0.8, 0.8, 1, 1));
    const region = buildPartUvRegion(uvs, indices, SIZE);
    const tight = regionMask(region, { island: 0 });
    const grown = regionMask(region, { island: 0, grow: UV_GROW_PX });
    expect(countMask(grown)).toBeGreaterThan(countMask(tight));
    for (let i = 0; i < region.idMap.length; i++) {
      if (region.idMap[i] === 2) expect(grown[i]).toBe(0);
    }
  });
});

describe('maskToImageData', () => {
  it('produces opaque white where selected, transparent elsewhere', () => {
    const mask = new Uint8Array([0, 255]);
    const img = maskToImageData(mask, 2);
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(Array.from(img.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(img.data.slice(4, 8))).toEqual([255, 255, 255, 255]);
  });
});

describe('constants', () => {
  it('matches the painter texture size', () => {
    expect(UV_MASK_SIZE).toBe(2048);
  });
});
