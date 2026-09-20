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
  CRJ7: 'BOMBARDIER CRJ700',
  CRJ9: 'BOMBARDIER CRJ900',
  C750: 'CESSNA CITATION X',
  C919: 'COMAC C-919',
  E170: 'EMBRAER E-JET 170',
  E190: 'EMBRAER E-JET 190',
  GLF6: 'GULFSTREAM 650',
};

export const PLANE_ID_TO_SHORT_CODE = Object.fromEntries(
  Object.entries(SHORT_CODE_TO_PLANE_ID).map(([k, v]) => [v, k]),
);

// Manufacturer words prefixed to the game's aircraft type ids.
const AIRCRAFT_MANUFACTURERS = ['AIRBUS', 'BOEING', 'BOMBARDIER', 'EMBRAER', 'CESSNA', 'GULFSTREAM', 'COMAC'];

// Compact display label for an aircraft type: drops the manufacturer word
// ("AIRBUS A-320neo" → "A-320neo"). A remainder that is only digits
// ("GULFSTREAM 650" → "650") is left whole; anything unrecognized passes through.
export function shortAircraftType(planeId) {
  const s = String(planeId == null ? '' : planeId).trim();
  const m = /^([A-Z]+)\s+(.+)$/.exec(s);
  if (m && AIRCRAFT_MANUFACTURERS.includes(m[1])) {
    const rest = m[2].trim();
    if (rest && !/^\d+$/.test(rest)) return rest;
  }
  return s;
}

// Free-form folder names: anything filesystem-safe. Excludes Windows-reserved
// characters (< > : " / \ | ? *) + control chars, rejects leading/trailing
// dots/spaces (Windows mangles those), caps at 64 chars. Path traversal is
// additionally rejected by containmentCheck in electron/livery.js — the folder
// is used verbatim and is NOT parsed back into parts.
export const LIVERY_FOLDER_SAFE_RE = /^(?![.\s])(?!.*[.\s]$)(?!.*[<>:"/\\|?*\x00-\x1f]).{1,64}$/;

export const TEXTURE_SIZE = 2048;

// Horizontal space (texture px) between the panels of a multi-image aircraft
// (A388/B38M). Only applied when a type's built-in default livery carries more
// than one paintable BaseMap. Mirrors the gap used by LiveryCanvas.
export const PANEL_GAP = 128;

// On-disk BaseMap file name for a painted panel. Single-part liveries keep the
// legacy `base.png`; multi-image types use the game's own `base_<Part>.png`
// convention (base_Fuselage.png + base_Wing.png / base_Wingtip.png).
// Mirrors electron/livery.js:baseFileName.
export function baseFileName(partName, totalParts) {
  if (!totalParts || totalParts <= 1) return 'base.png';
  const safe = String(partName || '').replace(/[^A-Za-z0-9]/g, '');
  return safe ? `base_${safe}.png` : 'base.png';
}

// Conventional default name suggested in the Save As dialog (the layout the
// game's own reference pack uses). Purely a label — nothing is ever parsed
// back out of a folder name.
export function folderFor(planeId, airline) {
  const shortCode = PLANE_ID_TO_SHORT_CODE[planeId] || planeId;
  return `${shortCode}_${airline}`;
}

// Build the game's livery manifest. `parts` (when given) is an ordered list of
// `{partName, fileName}` BaseMap bindings — one per painted panel; otherwise a
// single part from `partName`/`base.png` is emitted. Mirrors electron/livery.js.
export function buildManifest({ folder, shortCode, airline, targetPlaneId, partName, parts, targetModelVer }) {
  // Mirrors electron/livery.js: sanitize free-form folders for the id.
  const safeId = String(folder).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'livery';
  // Must match the aircraft's built-in model version (C919 is 2, the rest 1)
  // or the game flags the livery as broken. The renderer has no fs access,
  // so the main process resolves this from the built-in manifest and the
  // renderer copy just carries an explicit value through; default '1'.
  const ver = targetModelVer == null || targetModelVer === '' ? '1' : String(targetModelVer);
  const manifestParts = Array.isArray(parts) && parts.length
    ? parts.map(p => ({
      partName: (p && p.partName) || 'Body',
      textures: [{ property: 'BaseMap', fileName: (p && p.fileName) || 'base.png' }],
    }))
    : [{ partName: partName || 'Body', textures: [{ property: 'BaseMap', fileName: 'base.png' }] }];
  return {
    id: `${safeId}_default`,
    name: `${shortCode} ${airline} Default Livery`,
    airline,
    targetPlaneId,
    liveryType: 'airline',
    liverySource: 'user',
    targetModelVer: ver,
    parts: manifestParts,
  };
}
