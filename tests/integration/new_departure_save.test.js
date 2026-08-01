/**
 * Regression test: a NEW departure flight must save as InitialDeparture
 * (not InitialArrival) with the airline code in AirlineName.
 *
 * Root cause (fixed): _rebuildStaticDataSections decided the leg solely via
 * `fl.isDeparture === true`, but newly created flights (UI factory / MCP
 * create_flights) did not carry the flag — only the ACL parser set it on
 * load. So a fresh departure was serialized as an arrival with zeroed times.
 * Creation paths now set the flag, and the serializer falls back to
 * OffBlockTime so even a flag-less departure cannot be misclassified.
 *
 * AirlineName defaults to the callsign's 3-letter airline code — the game
 * stores codes there (e.g. "CDG", "UAL"), not display names.
 *
 * The synthetic flights below are deliberately built WITHOUT isDeparture
 * and WITHOUT AirlineName, so this test exercises the serializer fallbacks
 * (the strongest regression guard).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { generateFullAcl, loadFlights, _extractConfig } = require('../../src/acl/parser');
const { buildApproachCache } = require('../../src/acl/approach');
const { readAclText } = require('../../src/acl/gatcarc');

const LEVEL_DIR = path.join(__dirname, '..', 'fixtures', 'game-root', 'GroundATC_Data',
  'StreamingAssets', 'Airports', 'ZSJN', 'Levels');
const FIXTURE_ACL = path.join(LEVEL_DIR, 'ZSJN-Morning_120min.v4.acl');
const TMP_ACL = path.join(__dirname, '_tmp_newdep.acl');

if (!fs.existsSync(FIXTURE_ACL)) {
  throw new Error('fixture missing: ' + FIXTURE_ACL);
}

// Real cache built from the fixture level dir — same as the app's save path.
const cache = buildApproachCache(LEVEL_DIR);
const fixtureText = readAclText(FIXTURE_ACL);
const { flights: baseFlights, sceneryMaps } = loadFlights(FIXTURE_ACL);
const cfg = _extractConfig(fixtureText) || {};

// Clone a real fixture departure/arrival (keeps valid stand, runway, STAR,
// aircraft type, voice, language), but strip the parser-set isDeparture flag
// and AirlineName so the serializer fallbacks must classify from times alone.
// Note: the parser stores the registration on the internal _Registration key
// (same convention the serializer uses: fl._Registration || fl.Registration).
const depSrc = baseFlights.find(f => f.isDeparture === true && f.OffBlockTime && f.Stand && (f._Registration || f.Registration) && f.ArrivalAirport);
const arrSrc = baseFlights.find(f => f.isDeparture === false && f.LandingTime && f.Stand && (f._Registration || f.Registration) && f.Airway);
if (!depSrc || !arrSrc) {
  throw new Error('fixture lacks both a departure and an arrival to clone');
}

// Keep the original stand/runway/STAR/times — stand sequences stay exactly
// as valid as the fixture. Only the callsign, the AirlineName, and the
// isDeparture flag change.
const depClone = {
  ...depSrc,
  CallSign: 'CSC9999',
  AirlineName: '',
};
delete depClone.isDeparture;

const arrClone = {
  ...arrSrc,
  CallSign: 'CCA8888',
  AirlineName: '',
};
delete arrClone.isDeparture;

const depReg = depClone._Registration || depClone.Registration;
const arrReg = arrClone._Registration || arrClone.Registration;

const flights = baseFlights.map(f => (f === depSrc ? depClone : f === arrSrc ? arrClone : f));

// Substring from a flight-plan entry's $k marker to the next entry's marker
// (static items are contiguous in the array; a 4000-char cap covers the
// hypothetical last entry).
function entryWindow(reg, savedText) {
  const key = '"$k": "flight-plan:' + reg + '"';
  const idx = savedText.indexOf(key);
  expect(idx).toBeGreaterThan(-1);
  const nextIdx = savedText.indexOf('"$k": "flight-plan:', idx + key.length);
  const end = nextIdx > -1 ? nextIdx : Math.min(idx + 4000, savedText.length);
  return savedText.substring(idx, end);
}

afterAll(() => {
  if (fs.existsSync(TMP_ACL)) fs.unlinkSync(TMP_ACL);
});

describe('new departure save', () => {
  let savedText;

  beforeAll(() => {
    fs.copyFileSync(FIXTURE_ACL, TMP_ACL);
    // Mirrors the app save path (main.js): 9-arg generateFullAcl.
    generateFullAcl(TMP_ACL, flights, '', '', [], sceneryMaps, cache, cfg.startTime || null, null);
    savedText = readAclText(TMP_ACL);
  });

  it('writes the departure as InitialDeparture with AirlineName = code', () => {
    const depEntry = entryWindow(depReg, savedText);
    expect(depEntry).toContain('"InitialArrival": null');
    expect(depEntry).toContain('"InitialDeparture": {');
    expect(depEntry).toContain('"CallSign": "CSC9999"');
    expect(depEntry).toContain('"OffBlockTime"');
    expect(depEntry).toContain('"DestinationAirport": "' + depClone.ArrivalAirport + '"');
    expect(depEntry).toContain('"AirlineName": "CSC"');
  });

  it('writes the arrival as InitialArrival with AirlineName = code', () => {
    const arrEntry = entryWindow(arrReg, savedText);
    expect(arrEntry).toContain('"InitialArrival": {');
    expect(arrEntry).toContain('"InitialDeparture": null');
    expect(arrEntry).toContain('"CallSign": "CCA8888"');
    expect(arrEntry).toContain('"LandingTime"');
    expect(arrEntry).toContain('"STAR"');
    expect(arrEntry).toContain('"AirlineName": "CCA"');
  });

  it('roundtrips: reload classifies them as departure/arrival with codes', () => {
    const { flights: reloaded } = loadFlights(TMP_ACL);
    const dep = reloaded.find(f => f.CallSign === 'CSC9999');
    const arr = reloaded.find(f => f.CallSign === 'CCA8888');
    expect(dep).toBeDefined();
    expect(arr).toBeDefined();
    expect(dep.isDeparture).toBe(true);
    expect(dep.AirlineName).toBe('CSC');
    expect(arr.isDeparture).toBe(false);
    expect(arr.AirlineName).toBe('CCA');
  });
});
