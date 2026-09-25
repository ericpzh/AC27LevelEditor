import { describe, it, expect } from 'vitest';
import {
  OWN_PACK_NAME,
  SHORT_CODE_TO_PLANE_ID,
  PLANE_ID_TO_SHORT_CODE,
  LIVERY_FOLDER_SAFE_RE,
  TEXTURE_SIZE,
  PANEL_GAP,
  baseFileName,
  buildManifest,
  folderFor,
} from '../../src/utils/constants/livery';

describe('livery constants', () => {
  it('own pack name is a single-line const', () => {
    expect(OWN_PACK_NAME).toBe('AC27 Custom Liveries');
  });

  it('short-code table has all 20 built-in aircraft rows', () => {
    expect(Object.keys(SHORT_CODE_TO_PLANE_ID)).toHaveLength(20);
    expect(SHORT_CODE_TO_PLANE_ID.A20N).toBe('AIRBUS A-320neo');
    expect(SHORT_CODE_TO_PLANE_ID.B38M).toBe('BOEING 737 MAX 8');
    expect(SHORT_CODE_TO_PLANE_ID.C919).toBe('COMAC C-919');
    expect(SHORT_CODE_TO_PLANE_ID.CRJ7).toBe('BOMBARDIER CRJ700');
    expect(SHORT_CODE_TO_PLANE_ID.C750).toBe('CESSNA CITATION X');
    expect(SHORT_CODE_TO_PLANE_ID.GLF6).toBe('GULFSTREAM 650');
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
      variant: 'default',
      targetPlaneId: 'AIRBUS A-320neo',
      liveryType: 'airline',
      liverySource: 'user',
      targetModelVer: '1',
      parts: [{ partName: 'Body', textures: [{ property: 'BaseMap', fileName: 'base.png' }] }],
    });
  });

  it('buildManifest folds the variant into the id (defaulted when missing)', () => {
    const base = {
      folder: 'A20N_CCA', shortCode: 'A20N', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
    };
    // Missing / empty / explicitly default all resolve to "default".
    for (const variant of [undefined, null, '', 'default']) {
      const m = buildManifest({ ...base, variant });
      expect(m.variant).toBe('default');
      expect(m.id).toBe('a20n_cca_default');
    }
    // A future variant is normalized and becomes the id suffix.
    expect(buildManifest({ ...base, variant: 'Retro' })).toMatchObject({
      id: 'a20n_cca_retro', variant: 'retro',
    });
    // Unsafe characters collapse to a token; a fully-unsafe value is default.
    expect(buildManifest({ ...base, variant: 'special edition' })).toMatchObject({
      id: 'a20n_cca_special_edition', variant: 'special_edition',
    });
    expect(buildManifest({ ...base, variant: '***' }).variant).toBe('default');
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

  it('buildManifest binds the partName the caller passes (multi-part types)', () => {
    // Single-part types default to Body...
    const body = buildManifest({
      folder: 'A20N_CCA', shortCode: 'A20N', airline: 'CCA', targetPlaneId: 'AIRBUS A-320neo',
    });
    expect(body.parts).toEqual([{ partName: 'Body', textures: [{ property: 'BaseMap', fileName: 'base.png' }] }]);
    // ...while multi-part A388/B38M pass the built-in main part (Fuselage),
    // since the game ignores a texture bound to the wrong mesh part.
    const multi = buildManifest({
      folder: 'A388_SIA', shortCode: 'A388', airline: 'SIA', targetPlaneId: 'AIRBUS A-380-800', partName: 'Fuselage',
    });
    expect(multi.parts).toEqual([{ partName: 'Fuselage', textures: [{ property: 'BaseMap', fileName: 'base.png' }] }]);
    expect(multi.name).toBe('A388 SIA Default Livery');
  });

  it('buildManifest carries an explicit targetModelVer (C919 model bump)', () => {
    // The main process resolves this from the built-in manifest; the pure
    // helper just carries the value through (numeric vers coerce to string).
    const v2 = buildManifest({
      folder: 'C919_CCA',
      shortCode: 'C919',
      airline: 'CCA',
      targetPlaneId: 'COMAC C-919',
      targetModelVer: '2',
    });
    expect(v2.targetModelVer).toBe('2');
    expect(v2.variant).toBe('default');
    const numeric = buildManifest({
      folder: 'C919_CCA',
      shortCode: 'C919',
      airline: 'CCA',
      targetPlaneId: 'COMAC C-919',
      targetModelVer: 2,
    });
    expect(numeric.targetModelVer).toBe('2');
  });

  it('buildManifest defaults targetModelVer to 1 when missing/empty', () => {
    // Omitted, null and '' all mean "unknown" — the game treats every type
    // but C919 as 1, so the helper must never emit undefined/''.
    for (const targetModelVer of [undefined, null, '']) {
      const m = buildManifest({
        folder: 'A20N_CCA',
        shortCode: 'A20N',
        airline: 'CCA',
        targetPlaneId: 'AIRBUS A-320neo',
        targetModelVer,
      });
      expect(m.targetModelVer).toBe('1');
    }
  });

  it('texture size is 2048 and the panel gap is 128', () => {
    expect(TEXTURE_SIZE).toBe(2048);
    expect(PANEL_GAP).toBe(128);
  });

  it('baseFileName keeps base.png for single-part and suffixes multi-part', () => {
    expect(baseFileName('Body', 1)).toBe('base.png');
    expect(baseFileName('Fuselage', undefined)).toBe('base.png');
    expect(baseFileName('Fuselage', 2)).toBe('base_Fuselage.png');
    expect(baseFileName('Wing', 2)).toBe('base_Wing.png');
    expect(baseFileName('Wingtip', 2)).toBe('base_Wingtip.png');
    // Filesystem-unsafe part names collapse to a safe token; an empty one
    // falls back to the legacy name.
    expect(baseFileName('A B', 2)).toBe('base_AB.png');
    expect(baseFileName('', 2)).toBe('base.png');
  });

  it('buildManifest emits one part per painted panel', () => {
    const m = buildManifest({
      folder: 'A388_SIA',
      shortCode: 'A388',
      airline: 'SIA',
      targetPlaneId: 'AIRBUS A-380-800',
      parts: [
        { partName: 'Fuselage', fileName: 'base_Fuselage.png' },
        { partName: 'Wing', fileName: 'base_Wing.png' },
      ],
    });
    expect(m.parts).toEqual([
      { partName: 'Fuselage', textures: [{ property: 'BaseMap', fileName: 'base_Fuselage.png' }] },
      { partName: 'Wing', textures: [{ property: 'BaseMap', fileName: 'base_Wing.png' }] },
    ]);
  });
});
