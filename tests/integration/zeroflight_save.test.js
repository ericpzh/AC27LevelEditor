/**
 * Regression test: a level may have ZERO flights (e.g. a scenery-only level or
 * a schedule that was fully cleared) and must still be saveable AND reloadable.
 *
 * Previously "saving" a 0-flight ACL was a silent no-op (the pipeline returned
 * early without writing the file), the UI blocked Save/Save As on an empty
 * flight array, and `loadFlights` threw "No flight data found in ACL" — so a
 * cleared level could not round-trip.  The 0-flight path now runs the rebuild
 * with an empty flight set, which clears every flight-plan / aircraft /
 * aircraft-animator runtime entity while preserving jetways, radio channels,
 * singletons, and scenery, and still calls writeAcl at the end.
 *
 * Also covers the lazy blobdoc type resolution needed for the flight-less
 * StaticData scope: after clearing, DateTime / FlightPlanDepartureLeg /
 * FlightPlanStaticItem are stripped by the game's type table, so the eager
 * `_assertBdTn` must only fire when a flight-plan entry will actually be
 * emitted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { buildApproachCache } = require('../../src/acl/approach');
const { _rebuildStaticDataSections } = require('../../src/acl/flight_plans');
const { readAclText } = require('../../src/acl/gatcarc');
const { loadFlights } = require('../../src/acl/parser');

const LEVEL_DIR = path.join(__dirname, '..', 'fixtures', 'game-root', 'GroundATC_Data',
  'StreamingAssets', 'Airports', 'ZSJN', 'Levels');
const FIXTURE_ACL = path.join(LEVEL_DIR, 'ZSJN_leisure_1.acl');

if (!fs.existsSync(FIXTURE_ACL)) {
  throw new Error('fixture missing: ' + FIXTURE_ACL);
}

let cache;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-zeroflight-'));
let zeroAcl;

const countKeys = (text, prefix) =>
  [...text.matchAll(new RegExp('"\\$k":\\s*"' + prefix + ':[^"]*"', 'g'))].length;

beforeAll(() => {
  cache = buildApproachCache(LEVEL_DIR);
  zeroAcl = path.join(tmpDir, 'zero.acl');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('0-flight ACL save', () => {
  it('clears flight entities but keeps jetways, and re-encodes (no throw)', () => {
    fs.copyFileSync(FIXTURE_ACL, zeroAcl);
    // Save with an empty flight array — must NOT be a silent no-op and must not throw.
    expect(() => _rebuildStaticDataSections(zeroAcl, [], 0n, cache, null, 0, null)).not.toThrow();

    const t = readAclText(zeroAcl);
    expect(countKeys(t, 'flight-plan')).toBe(0);
    expect(countKeys(t, 'aircraft')).toBe(0);                 // aircraft:REG runtime entities
    expect(countKeys(t, 'aircraft-animator')).toBe(0);
    expect(countKeys(t, 'jetway')).toBeGreaterThan(0);        // scenery/jetways preserved
    expect(countKeys(t, 'radio-channel')).toBeGreaterThan(0); // radio channels preserved
  });

  it('reloads the 0-flight ACL as an empty schedule (previously threw)', () => {
    const r = loadFlights(zeroAcl);
    expect(r.flights).toHaveLength(0);
  });

  it('re-saves a flight-less file without throwing (lazy blobdoc type resolution)', () => {
    expect(() => _rebuildStaticDataSections(zeroAcl, [], 0n, cache, null, 0, null)).not.toThrow();
    const t = readAclText(zeroAcl);
    expect(countKeys(t, 'flight-plan')).toBe(0);
  });
});
