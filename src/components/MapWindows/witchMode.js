/**
 * Witch mode — shared utilities for animated sprite aircraft display.
 * Consumed by both AirMapWindow and GroundMapWindow.
 */

/**
 * Map a nose direction vector (Unity coords) to a cardinal sprite direction.
 * Unity: +z = north, +x = east.  SVG Y is flipped (svgY(z) = -z).
 *
 * @param {{x:number, z:number}|null} noseDir
 * @returns {'up'|'down'|'left'|'right'}
 */
export function witchDirection(noseDir) {
  if (!noseDir) return 'right';
  const az = Math.abs(noseDir.z);
  const ax = Math.abs(noseDir.x);
  if (az > ax) {
    // Dominant z-axis: north (z > 0 → up in SVG) or south (z < 0 → down)
    return noseDir.z > 0 ? 'up' : 'down';
  }
  // Dominant x-axis: east (x > 0 → right) or west (x < 0 → left)
  return noseDir.x > 0 ? 'right' : 'left';
}

/**
 * Return true when the aircraft is parked (no active control seat).
 * An aircraft with a known control seat (1-7) is under active control and not parked.
 * None (0) and Unknown (255) indicate the aircraft is parked / out of active control.
 *
 * @param {object} ac — UDP aircraft record (controlSeat)
 * @returns {boolean}
 */
export function isParked(ac) {
  // Active control seat (1-7) → not parked
  if (ac.controlSeat != null && ac.controlSeat !== 0 && ac.controlSeat !== 255) return false;
  // None (0), Unknown (255), or missing → parked
  return true;
}

// ─── Sprite sheet lookup ───────────────────────────────────────────

export const SPRITE_CELL = 256;
export const SPRITE_SHEET_W = 1536;
export const SPRITE_SHEET_H = 768;

/** Available character sheets. */
const SHEETS = [
  'elaina', 'marisa', 'kowata', 'patchouli', 'atsuko',
  'lisa', 'nene', 'echidna', 'roxy', 'ranni',
  'sherry', 'nikaido', 'ema', 'natsume', 'npa',
];

/**
 * djb2 hash — deterministic, cross-window consistent fallback when spriteIdx
 * is not provided by the main process (e.g. standalone / testing).
 */
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Return the sprite sheet filename for an aircraft.
 *
 * When `spriteIdx` (0–SPRITE_SHEET_COUNT-1) is provided by the main process,
 * it is used directly — this guarantees every window shows the same character
 * for the same callsign.
 *
 * Without `spriteIdx` (standalone / testing), falls back to a deterministic
 * djb2 hash of the callsign so behaviour is still stable.
 */
export function getSpriteSheet(callSign, spriteIdx) {
  if (spriteIdx != null) return `witch/${SHEETS[spriteIdx]}.png`;
  // Fallback deterministic hash for backward compat / standalone use
  return `witch/${SHEETS[hashString(callSign) % SHEETS.length]}.png`;
}

// Grid layout in elaina.png (col,row) — 6 cols × 3 rows
const GRID = {
  stand:     { 1: [0,0], 2: [1,0] },
  walkup:    { 1: [2,0], 2: [3,0] },
  walkdown:  { 1: [4,0], 2: [5,0] },
  walkleft:  { 1: [0,1], 2: [1,1] },
  walkright: { 1: [2,1], 2: [3,1] },
  flyup:     { 1: [4,1], 2: [5,1] },
  flydown:   { 1: [0,2], 2: [1,2] },
  flyleft:   { 1: [2,2], 2: [3,2] },
  flyright:  { 1: [4,2], 2: [5,2] },
};

/**
 * Return the viewBox for a sprite cell.
 * @param {'stand'|'walk'|'fly'} action
 * @param {'up'|'down'|'left'|'right'|''} dir
 * @param {1|2} frame
 * @returns {string} "x y w h" for SVG viewBox
 */
export function getSpriteViewBox(action, dir, frame) {
  const c = getSpriteCell(action, dir, frame);
  return `${c.x} ${c.y} ${SPRITE_CELL} ${SPRITE_CELL}`;
}

/**
 * Return {x, y} of a cell in the sprite sheet (pixel coords).
 * @param {'stand'|'walk'|'fly'} action
 * @param {'up'|'down'|'left'|'right'|''} dir
 * @param {1|2} frame
 * @returns {{x: number, y: number}}
 */
export function getSpriteCell(action, dir, frame) {
  const key = action === 'stand' ? 'stand' : `${action}${dir}`;
  const c = GRID[key]?.[frame];
  if (!c) return { x: 0, y: 0 };
  return { x: c[0] * SPRITE_CELL, y: c[1] * SPRITE_CELL };
}
