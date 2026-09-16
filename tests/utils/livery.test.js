import { describe, it, expect } from 'vitest';
import {
  OWN_PACK_NAME,
  SHORT_CODE_TO_PLANE_ID,
  PLANE_ID_TO_SHORT_CODE,
  LIVERY_FOLDER_SAFE_RE,
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

  it('safe folder regex accepts conventional + free-form names', () => {
    expect(LIVERY_FOLDER_SAFE_RE.test('A20N_CCA')).toBe(true);
    expect(LIVERY_FOLDER_SAFE_RE.test('B38M_AAL')).toBe(true);
    expect(LIVERY_FOLDER_SAFE_RE.test('My First Livery 01')).toBe(true);
    expect(LIVERY_FOLDER_SAFE_RE.test('a20n_cca')).toBe(true); // case no longer matters
    expect(LIVERY_FOLDER_SAFE_RE.test('涂装测试')).toBe(true);
  });

  it('safe folder regex rejects filesystem-unsafe names', () => {
    expect(LIVERY_FOLDER_SAFE_RE.test('')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('   ')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('../evil')).toBe(false); // traversal
    expect(LIVERY_FOLDER_SAFE_RE.test('a/b')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('a\\b')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('a:b')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('a*b')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('a?b')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('a"b')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('a<b')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('a|b')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('.hidden')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('trailing.')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('trailing ')).toBe(false);
    expect(LIVERY_FOLDER_SAFE_RE.test('x'.repeat(65))).toBe(false); // too long
  });

  it('folderFor builds the conventional default name from the plane id', () => {
    expect(folderFor('AIRBUS A-320neo', 'CCA')).toBe('A20N_CCA');
    // Unknown plane ids fall back to the id itself (never a folder parse).
    expect(folderFor('COMAC C-1000', 'CCA')).toBe('COMAC C-1000_CCA');
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

  it('buildManifest sanitizes free-form folders into the id', () => {
    const m = buildManifest({
      folder: 'My First Livery 01',
      shortCode: 'A20N',
      airline: 'CCA',
      targetPlaneId: 'AIRBUS A-320neo',
    });
    expect(m.id).toBe('my_first_livery_01_default');
    // Display name still comes from the structured parts, not the folder.
    expect(m.name).toBe('A20N CCA Default Livery');
    expect(m.airline).toBe('CCA');
  });

  it('texture size is 2048', () => {
    expect(TEXTURE_SIZE).toBe(2048);
  });
});
