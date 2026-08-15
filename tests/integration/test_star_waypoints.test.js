/**
 * Integration test: STAR waypoint extraction (the composer's "Fly Waypoint"
 * picker target set) in buildApproachCache.
 *
 * A STAR route's AirwayNodes $irefs resolve to airway-node entities that
 * carry both a Name and a Position — those names, in route order (entry →
 * IAF), are what the patch composer displays left to right when "Fly
 * Waypoint" is picked for an aircraft on that STAR. The lists must survive
 * the approach-cache serialize → deserialize round-trip used by cache.json.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { buildApproachCache, serializeApproachCache, deserializeApproachCache } = require('../../src/acl/approach');

const LEVEL_DIR = path.join(__dirname, '..', 'fixtures', 'game-root', 'GroundATC_Data',
  'StreamingAssets', 'Airports', 'ZSJN', 'Levels');

if (!fs.existsSync(LEVEL_DIR)) {
  throw new Error('fixture missing: ' + LEVEL_DIR);
}

const cache = buildApproachCache(LEVEL_DIR);
const starWaypoints = cache.starWaypoints || {};

describe('buildApproachCache starWaypoints', () => {
  it('resolves each STAR route to ordered named waypoints', () => {
    // UBSS6W on runway 19: the STAR route order — entry fix first, IAF last.
    expect(starWaypoints['UBSS6W|19'].map((w) => w.name)).toEqual(['UBSIS', 'SUNOK', 'JN213', 'METOG', 'JN108']);
    // PANK8X on runway 01 starts at its entry fix PANKI.
    expect(starWaypoints['PANK8X|01'].map((w) => w.name)).toEqual(['PANKI', 'JN107', 'JN108', 'METOG', 'JN210']);
    expect(starWaypoints['OKAL6W|19'].map((w) => w.name)).toEqual(['OKALI', 'JN112', 'JN111', 'JN110']);
  });

  it('every waypoint has a name and finite x/z', () => {
    for (const [key, list] of Object.entries(starWaypoints)) {
      expect(key, 'key ' + key + ' should be STAR|runway').toContain('|');
      expect(list.length).toBeGreaterThan(0);
      for (const w of list) {
        expect(typeof w.name).toBe('string');
        expect(w.name.length).toBeGreaterThan(0);
        expect(Number.isFinite(w.x), `${key} ${w.name} x=${w.x} should be finite`).toBe(true);
        expect(Number.isFinite(w.z), `${key} ${w.name} z=${w.z} should be finite`).toBe(true);
      }
    }
  });

  it('covers every STAR↔runway combination in starRunwayMap', () => {
    const starRunwayMap = cache.starRunwayMap || {};
    for (const [star, runways] of Object.entries(starRunwayMap)) {
      for (const runway of runways) {
        expect(starWaypoints[star + '|' + runway], `${star}|${runway} missing`).toBeDefined();
      }
    }
  });
});

describe('starWaypoints serialize/deserialize round-trip', () => {
  it('preserves the full map through serialize → deserialize', () => {
    const roundTripped = deserializeApproachCache(serializeApproachCache(cache));
    expect(roundTripped.starWaypoints).toEqual(starWaypoints);
  });
});