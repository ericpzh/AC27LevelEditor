import { describe, it, expect } from 'vitest';
import {
  OWN_PACK_NAME,
  SHORT_CODE_TO_PLANE_ID,
  PLANE_ID_TO_SHORT_CODE,
  LIVERY_FOLDER_RE,
  TEXTURE_SIZE,
  buildManifest,
  folderFor,
} from '../../src/utils/constants/livery';

describe('livery constants', () => {
  it('own pack name is a single-line const', () => {
    expect(OWN_PACK_NAME).toBe('AC27 Custom Liveries');
  });

  it('short-code table has all 14 rows', () => {
    expect(Object.keys(SHORT_CODE_TO_PLANE_ID)).toHaveLength(14);
    expect(SHORT_CODE_TO_PLANE_ID.A20N).toBe('AIRBUS A-320neo');
    expect(SHORT_CODE_TO_PLANE_ID.B38M).toBe('BOEING 737 MAX 8');
    expect(SHORT_CODE_TO_PLANE_ID.C919).toBe('COMAC C-919');
  });

  it('reverse lookup resolves both directions', () => {
    for (const [code, id] of Object.entries(SHORT_CODE_TO_PLANE_ID)) {
      expect(PLANE_ID_TO_SHORT_CODE[id]).toBe(code);
    }
  });

  it('folder regex accepts valid names', () => {
    expect(LIVERY_FOLDER_RE.test('A20N_CCA')).toBe(true);
    expect(LIVERY_FOLDER_RE.test('B38M_AAL')).toBe(true);
    expect(LIVERY_FOLDER_RE.test('A333_CES')).toBe(true);
  });

  it('folder regex rejects invalid names', () => {
    expect(LIVERY_FOLDER_RE.test('A2_CCA')).toBe(false); // short code too short
    expect(LIVERY_FOLDER_RE.test('A20000_CCA')).toBe(false); // too long
    expect(LIVERY_FOLDER_RE.test('A20N_CCA1')).toBe(false);
    expect(LIVERY_FOLDER_RE.test('a20n_cca')).toBe(false); // lowercase
    expect(LIVERY_FOLDER_RE.test('../evil')).toBe(false); // traversal
    expect(LIVERY_FOLDER_RE.test('A20N-CCA')).toBe(false);
    expect(LIVERY_FOLDER_RE.test('')).toBe(false);
  });

  it('folderFor joins short code and airline', () => {
    expect(folderFor('A20N', 'CCA')).toBe('A20N_CCA');
  });

  it('buildManifest matches the on-disk template', () => {
    const m = buildManifest({
      folder: 'A20N_CCA',
      shortCode: 'A20N',
      airline: 'CCA',
      targetPlaneId: 'AIRBUS A-320neo',
    });
    expect(m).toEqual({
      id: 'a20n_cca_default',
      name: 'A20N CCA Default Livery',
      airline: 'CCA',
      targetPlaneId: 'AIRBUS A-320neo',
      liveryType: 'airline',
      liverySource: 'user',
      targetModelVer: '1',
      parts: [{ partName: 'Body', textures: [{ property: 'BaseMap', fileName: 'base.png' }] }],
    });
  });

  it('texture size is 2048', () => {
    expect(TEXTURE_SIZE).toBe(2048);
  });
});
