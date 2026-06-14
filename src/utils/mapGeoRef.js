// Unity game-unit coordinates of _Map.png images.
// originX, originZ = top-left corner in Unity game units.
// width, height = image extent in Unity game units.
// All values use the same game-unit space as ACL data (DEFAULT_AIRPORT_SCALE = 100 m/unit).
// Values are initial estimates — calibrate against actual _Map.png images.
export const MAP_GEO_REF = {
  ZSJN: { originX: -60, originZ: 60, width: 120, height: 120 },
  KJFK: { originX: -80, originZ: 80, width: 160, height: 160 },
};

export const DEFAULT_GEO_REF = { originX: -60, originZ: 60, width: 120, height: 120 };
