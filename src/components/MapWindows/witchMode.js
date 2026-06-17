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
 * Return true when the aircraft is stationary (parked or speed ≈ 0).
 * Uses taxiSpeed for ground aircraft; also checks stand proximity when a stand is assigned.
 *
 * @param {object} ac — UDP aircraft record (position, stand, taxiSpeed, airSpeedKnot)
 * @param {object} standPositions — { [standId]: {x, y} } where y is game Z
 * @param {number} proximity — max distance in game units (e.g. GROUND_RADAR_STAND_PROXIMITY)
 * @returns {boolean}
 */
export function isParked(ac, standPositions, proximity) {
  // Stationary — taxiSpeed near zero (use taxiSpeed, not airSpeedKnot)
  const taxiSpd = ac.taxiSpeed ?? ac.airSpeedKnot ?? 0;
  const stopped = taxiSpd < 1;
  // Also check if at assigned stand
  let atStand = false;
  if (ac.stand && standPositions && standPositions[ac.stand] && ac.position) {
    const sp = standPositions[ac.stand];
    const dx = ac.position.x - sp.x;
    const dz = ac.position.z - sp.y; // sp.y stores game Z (same convention as GroundMapWindow)
    atStand = dx * dx + dz * dz <= proximity * proximity;
  }
  return stopped || atStand;
}

// ─── Sprite sheet lookup ───────────────────────────────────────────

export const SPRITE_CELL = 256;
export const SPRITE_SHEET_W = 1536;
export const SPRITE_SHEET_H = 768;

/** Available character sheets. */
const SHEETS = [
  'elaina', 'marisa', 'kowata', 'patchouli', 'atsuko',
  'lisa', 'nene', 'echidna', 'roxy', 'ranni',
];

/** Round-robin assignment: callsign → sheet index. */
const _assignments = new Map();
let _nextIdx = 0;

/**
 * Return the sprite sheet filename for an aircraft.
 * Round-robin: each new callsign gets the next unused sheet, cycling through all 10.
 * Assignment is stable — same callsign always gets the same sheet.
 */
export function getSpriteSheet(callSign) {
  if (!_assignments.has(callSign)) {
    _assignments.set(callSign, SHEETS[_nextIdx % SHEETS.length]);
    _nextIdx++;
  }
  return `witch/${_assignments.get(callSign)}.png`;
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
  const key = action === 'stand' ? 'stand' : `${action}${dir}`;
  const c = GRID[key]?.[frame];
  if (!c) return '0 0 256 256';
  return `${c[0] * SPRITE_CELL} ${c[1] * SPRITE_CELL} ${SPRITE_CELL} ${SPRITE_CELL}`;
}
