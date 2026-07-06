// ─── Map-window on-hover button tooltips (air/ground radar + flight strips) ──
// Set to true to enable portal-based hover tooltips on all radar/strip buttons.
// Tooltip text is extracted from the Map Help overlay content (i18n-aware).
// The help/witch-mode toggle button is always excluded.
export const MAP_TOOLTIPS_ENABLED = false;

// ─── Map overlay layout (shared by StandMap + StarMap) ─────
export const MAP_PAD_RATIO = 0.10;
export const MAP_GAP = 8;
export const MAP_HEADER_H = 38;
export const MAP_LEGEND_H = 40;
export const MAP_SVG_FRAC = 0.48;
export const MAP_MIN_SVG = 680;
export const MAP_TARGET_RATIO = 1.35;

// ─── Per-airport approach-radar background image config ──────
// `w` = image width in viewBox units when height = 3000
// `bg` = color for area OUTSIDE the map image (within data bounds)
// `bgUnder` = color BEHIND the semi-transparent map image
// dx/dy = fine-tune position offset
export const AIR_MAP_BG_OFFSETS = {
  ZSJN: { dx: 0, dy: 0, bg: '#232323', bgUnder: '#000000' },
  KJFK: { dx: -890, dy: -160, w: 5600, bg:'#0c0c0c', bgUnder: '#000000' },
};

// Witch mode map background offsets (independent of normal mode)
export const WITCH_MAP_BG_OFFSETS = {
  ZSJN: { dx: 0, dy: 0, w: 0 },
  KJFK: { dx: -900, dy: 0, w: 0 },
};

// Per-airport default zoom scale: 1.0 = full dataBounds, <1 = tighter initial view
export const GROUND_MAP_DEFAULT_ZOOM = {
  ZSJN: 0.75,
  KJFK: 1.0,
  KDCA: 0.5,
};
// Per-airport center offset in game units: { x, z } shift from (0, 0)
export const GROUND_MAP_CENTER_OFFSET = {
  ZSJN: { x: 0, z: -3 },
  KJFK: { x: -3, z: 0 },
};
export const AIR_MAP_DEFAULT_ZOOM = {
  ZSJN: 1.0,
  KJFK: 1.0,
};

// Ground radar: max distance (game units) from aircraft to assigned stand
// midpoint to be considered "at stand". 0.5 GU ≈ 50 m.
export const GROUND_RADAR_STAND_PROXIMITY = 0.5;
export const GROUND_MAP_TAXIWAY_LABEL_SPACING = 10.0; // min GU between same-name taxiway labels
export const GROUND_MAP_STAND_ACCESS_WIDTH_MULT = 1.0; // stand-access taxiway line width multiplier

export const MAP_PLANE_VB = 512;
// IoAirplane icon path
export const MAP_ICON_PATH = "M186.62 464H160a16 16 0 0 1-14.57-22.6l64.46-142.25L113.1 297l-35.3 42.77C71.07 348.23 65.7 352 52 352H34.08a17.66 17.66 0 0 1-14.7-7.06c-2.38-3.21-4.72-8.65-2.44-16.41l19.82-71c.15-.53.33-1.06.53-1.58a.38.38 0 0 0 0-.15 14.82 14.82 0 0 1-.53-1.59l-19.84-71.45c-2.15-7.61.2-12.93 2.56-16.06a16.83 16.83 0 0 1 13.6-6.7H52c10.23 0 20.16 4.59 26 12l34.57 42.05 97.32-1.44-64.44-142A16 16 0 0 1 160 48h26.91a25 25 0 0 1 19.35 9.8l125.05 152 57.77-1.52c4.23-.23 15.95-.31 18.66-.31C463 208 496 225.94 496 256c0 9.46-3.78 27-29.07 38.16-14.93 6.6-34.85 9.94-59.21 9.94-2.68 0-14.37-.08-18.66-.31l-57.76-1.54-125.36 152a25 25 0 0 1-19.32 9.75z";

// ─── Drag panel ────────────────────────────────────────────
export const DRAG_MIN_VISIBLE_X = 40;
export const DRAG_MIN_VISIBLE_Y = 38;
