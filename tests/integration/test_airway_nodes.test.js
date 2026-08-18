/**
 * Integration test: airway-node extraction (fixes/waypoints) in buildApproachCache.
 *
 * AirwayNode PK entities (e.g. "airway-node:-244674" / PANKI) provide the
 * fix positions + names displayed by the AirMap "Waypoints" layer. Only nodes
 * with an ICAO-style all-uppercase 3-5 letter name are fixes; turn points
 * ("TurnPoint19", "TP19W1"), numbered nodes ("JN210") and unnamed nodes are
 * filtered out at extraction. The remaining fixes must survive the
 * approach-cache serialize → deserialize round-trip used by cache.json.
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
const FIXTURE_ACL = path.join(LEVEL_DIR, 'ZSJN_leisure_1.acl');

if (!fs.existsSync(FIXTURE_ACL)) {
  throw new Error('fixture missing: ' + FIXTURE_ACL);
}

const cache = buildApproachCache(LEVEL_DIR);
const airwayNodes = cache.airwayNodes || [];

describe('buildApproachCache airwayNodes', () => {
  it('extracts only ICAO-style fixes from the ZSJN v4 fixture (16 of 213 nodes)', () => {
    // The fixture has 213 airway-node entities, but only 16 have valid
    // all-uppercase 3-5 letter fix names (PANKI, METOG, ...).
    expect(airwayNodes.length).toBe(16);
  });

  it('every node has finite x/z and a pk', () => {
    for (const n of airwayNodes) {
      expect(Number.isFinite(n.x), `node ${n.pk} x=${n.x} should be finite`).toBe(true);
      expect(Number.isFinite(n.z), `node ${n.pk} z=${n.z} should be finite`).toBe(true);
      expect(typeof n.pk).toBe('string');
      expect(n.pk.startsWith('airway-node:')).toBe(true);
    }
  });

  it('every fix name is all-uppercase 3-5 letters (turn points filtered out)', () => {
    for (const n of airwayNodes) {
      expect(n.name, `node ${n.pk} name ${n.name} should match /^[A-Z]{3,5}$/`).toMatch(/^[A-Z]{3,5}$/);
    }
    // Turn points / numbered nodes must not survive the filter
    expect(airwayNodes.find(n => n.name === 'TurnPoint19')).toBeUndefined();
    expect(airwayNodes.find(n => n.name === 'TP19W1')).toBeUndefined();
    expect(airwayNodes.find(n => n.name === 'JN210')).toBeUndefined();
    expect(airwayNodes.find(n => n.name === 'PointInTheTrees')).toBeUndefined();
  });

  it('PANKI matches the known airway-node:-244674 entry', () => {
    const panki = airwayNodes.find(n => n.name === 'PANKI');
    expect(panki).toBeDefined();
    expect(panki.pk).toBe('airway-node:-244674');
    expect(panki.osmId).toBe(-244674);
    expect(panki.x).toBeCloseTo(-191.74353, 3);
    expect(panki.z).toBeCloseTo(487.024719, 3);
  });
});

describe('airwayNodes serialize/deserialize round-trip', () => {
  it('preserves length and first entry through serialize → deserialize', () => {
    const roundTripped = deserializeApproachCache(serializeApproachCache(cache));
    expect(roundTripped.airwayNodes.length).toBe(airwayNodes.length);
    expect(roundTripped.airwayNodes[0]).toEqual(airwayNodes[0]);
  });
});
