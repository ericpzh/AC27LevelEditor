import { describe, it, expect } from 'vitest';
import { readPart } from '../../../src/components/LiveryScreen/Livery3DPreview';

/** Pack a part buffer exactly like scripts/extract-aircraft-models.py writes it. */
function partBytes({ positions, uvs, indices }) {
  const size = positions.length * 4 + uvs.length * 4 + indices.length * 4;
  const dv = new DataView(new ArrayBuffer(size));
  let o = 0;
  for (const v of positions) { dv.setFloat32(o, v, true); o += 4; }
  for (const v of uvs) { dv.setFloat32(o, v, true); o += 4; }
  for (const v of indices) { dv.setUint32(o, v, true); o += 4; }
  return new Uint8Array(dv.buffer);
}

describe('Livery3DPreview readPart', () => {
  it('decodes positions, uvs and indices and reports the next offset', () => {
    const positions = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const uvs = [0, 0, 1, 0, 0, 1];
    const indices = [0, 1, 2, 0, 2, 2];
    const bytes = partBytes({ positions, uvs, indices });

    const part = readPart(bytes, 0, 3, 6);
    expect(Array.from(part.positions)).toEqual(positions);
    expect(Array.from(part.uvs)).toEqual(uvs);
    expect(Array.from(part.indices)).toEqual(indices);
    expect(part.next).toBe(bytes.length);
  });

  it('honours a non-zero part offset (concatenated parts)', () => {
    const first = partBytes({ positions: [9, 9, 9], uvs: [0, 0], indices: [0, 0, 0] });
    const second = partBytes({ positions: [1, 2, 3], uvs: [0.5, 0.5], indices: [0, 0, 0] });
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first, 0);
    combined.set(second, first.length);

    const part = readPart(combined, first.length, 1, 3);
    expect(Array.from(part.positions)).toEqual([1, 2, 3]);
    expect(Array.from(part.uvs)).toEqual([0.5, 0.5]);
    expect(part.next).toBe(combined.length);
  });
});
