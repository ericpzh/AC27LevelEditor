// ─── Livery constants (P1.1) ───
// Own-pack + hardcoded short-code table + manifest builder. No scan, no cache.

export const OWN_PACK_NAME = 'AC27 Custom Liveries';

export const SHORT_CODE_TO_PLANE_ID = {
  A19N: 'AIRBUS A-319neo',
  A20N: 'AIRBUS A-320neo',
  A21N: 'AIRBUS A-321neo',
  A319: 'AIRBUS A-319ceo',
  A320: 'AIRBUS A-320ceo',
  A333: 'AIRBUS A-330-300',
  A359: 'AIRBUS A-350-900',
  A388: 'AIRBUS A-380-800',
  B38M: 'BOEING 737 MAX 8',
  B738: 'BOEING 737-800',
  B748: 'BOEING 747-8I',
  B77W: 'BOEING 777-300ER',
  B789: 'BOEING 787-9',
  C919: 'COMAC C-919',
};

export const PLANE_ID_TO_SHORT_CODE = Object.fromEntries(
  Object.entries(SHORT_CODE_TO_PLANE_ID).map(([k, v]) => [v, k]),
);

// Free-form folder names: anything filesystem-safe. Excludes Windows-reserved
// characters (< > : " / \ | ? *) + control chars, rejects leading/trailing
// dots/spaces (Windows mangles those), caps at 64 chars. Path traversal is
// additionally rejected by containmentCheck in electron/livery.js — the folder
// is used verbatim and is NOT parsed back into parts.
export const LIVERY_FOLDER_SAFE_RE = /^(?![.\s])(?!.*[.\s]$)(?!.*[<>:"/\\|?*\x00-\x1f]).{1,64}$/;

export const TEXTURE_SIZE = 2048;

// Conventional default name suggested in the Save As dialog (the layout the
// game's own reference pack uses). Purely a label — nothing is ever parsed
// back out of a folder name.
export function folderFor(planeId, airline) {
  const shortCode = PLANE_ID_TO_SHORT_CODE[planeId] || planeId;
  return `${shortCode}_${airline}`;
}

export function buildManifest({ folder, shortCode, airline, targetPlaneId }) {
  // Mirrors electron/livery.js: sanitize free-form folders for the id.
  const safeId = String(folder).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'livery';
  return {
    id: `${safeId}_default`,
    name: `${shortCode} ${airline} Default Livery`,
    airline,
    targetPlaneId,
    liveryType: 'airline',
    liverySource: 'user',
    targetModelVer: '1',
    parts: [
      { partName: 'Body', textures: [{ property: 'BaseMap', fileName: 'base.png' }] },
    ],
  };
}
