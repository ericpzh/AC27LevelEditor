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
