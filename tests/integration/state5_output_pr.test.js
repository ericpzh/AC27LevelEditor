/**
 * Regression test: state=5 (final approach) aircraft write a constant
 * ProgressRatio=0 in the saved ACL output, while position/direction are
 * still computed from the real time-based PR.
 *
 * The game recalculates path-based PR from PathPointList for state=5
 * aircraft, so the stored DynamicsParams.ProgressRatio is pinned to the
 * constant STATE5_OUTPUT_PROGRESS_RATIO (0) — the same value the legacy
 * buildState5AircraftBlock builder has always emitted. Internal position/
 * direction math must keep using the real computed PR.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { _buildStandaloneAircraftEntry } = require('../../src/acl/flight_plans');
const {
  buildApproachCache, computePosition, computeDirection,
  computePathLength, resolveFlyApproachPoints, computeApproachCap,
} = require('../../src/acl/approach');
const { readAclText } = require('../../src/acl/gatcarc');
const { loadFlights } = require('../../src/acl/parser');
const { STATE5_OUTPUT_PROGRESS_RATIO } = require('../../src/utils/constants');
const { CANONICAL_SCOPE } = require('./_canonical_scope.cjs');

const LEVEL_DIR = path.join(__dirname, '..', 'fixtures', 'game-root', 'GroundATC_Data',
  'StreamingAssets', 'Airports', 'ZSJN', 'Levels');
const FIXTURE_ACL = path.join(LEVEL_DIR, 'ZSJN-Morning_120min.v4.acl');

if (!fs.existsSync(FIXTURE_ACL)) {
  throw new Error('fixture missing: ' + FIXTURE_ACL);
}

// Real cache built from the fixture level dir — same as the app's save path.
const cache = buildApproachCache(LEVEL_DIR);
const text = readAclText(FIXTURE_ACL);
const { flights } = loadFlights(FIXTURE_ACL);

// Pick the first fixture arrival whose STAR|runway has a full procedure in
// the cache (appPointMap + totalApproachTimes + state5ParamsMap), so the
// STAR resolves in the fixture text and the builder hits the state=5 branch.
function pickArrival() {
  for (const f of flights) {
    if (f.isDeparture || !f.LandingTime || !f.Airway || !f.Runway) continue;
    const appKey = f.Airway + '|' + f.Runway;
    if (!cache.appPointMap.has(appKey)) continue;
    if (!cache.totalApproachTimes.has(f.Airway)) continue;
    if (!cache.state5ParamsMap.has(appKey) && !cache.state5ParamsMap.has(f.Runway)) continue;
    return f;
  }
  throw new Error('no fixture arrival with a full approach procedure in the cache');
}

const ARR = pickArrival();
const STAR = ARR.Airway;
const RWY = ARR.Runway;
const APP_KEY = STAR + '|' + RWY;
const TAT = cache.totalApproachTimes.get(STAR);
const APPROACH_CAP = computeApproachCap(cache.airportScale || 100);

const flyPoints = resolveFlyApproachPoints(text, STAR, RWY);
const appPoints = cache.appPointMap.get(APP_KEY);
const tdPos = cache.state5ParamsMap.get(APP_KEY)?.touchDownPosition
  || cache.state5ParamsMap.get(RWY)?.touchDownPosition;

if (!flyPoints.length || !appPoints.length) {
  throw new Error('fixture arrival has no resolvable fly/app points for ' + APP_KEY);
}

// Mirrors the builder's totalLen (fly + app + touchdown distance).
function computeTotalLen() {
  const combined = flyPoints.concat(appPoints);
  let totalLen = computePathLength(combined);
  if (tdPos && tdPos.x != null && appPoints.length > 0) {
    const lastApp = appPoints[appPoints.length - 1];
    totalLen += Math.sqrt((lastApp.x - tdPos.x) ** 2 + (lastApp.z - tdPos.z) ** 2);
  }
  return totalLen;
}
const TOTAL_LEN = computeTotalLen();
const FLY_LEN = computePathLength(flyPoints);

// Build a standalone entry exactly like _rebuildFlightRuntimeEntities does.
function buildArrival(reg, landingTime) {
  return _buildStandaloneAircraftEntry({
    reg,
    flight: { ...ARR, Registration: reg, LandingTime: landingTime },
    entryId: 500,
    towerChannelId: null,
    apprChannelId: null,
    isDeparture: false,
    approachCache: cache,
    fullText: text,
    saveSec: 0,                    // scenario start at 00:00:00
    icao: 'ZSJN',
    baseDateTicks: 0,
    segTypeMap: CANONICAL_SCOPE,   // strict per-scope type table
    log: () => {},
    fpId: 900,
    strArrCache: null,
    recvEventsCache: null,
    waitingCmdsCache: null,
  });
}

// State decision: rawTargetDist = (1 - ttl/tat) * totalLen; past IAF when >= flyLen.
function ttlForState5() {
  const ttl = 5; // seconds to landing — deep on final approach
  if ((1 - ttl / TAT) * TOTAL_LEN < FLY_LEN) {
    throw new Error('fixture geometry degenerate: flyLen too close to totalLen for ttl=5');
  }
  return ttl;
}
const TTL5 = ttlForState5();
// Builder clamps TTL to APPROACH_MIN_TTL (30) before computing the real PR.
const REAL_PR5 = 1 - Math.max(TTL5, 30) / TAT;

describe('state=5 output ProgressRatio', () => {
  it('writes constant 0 while position/direction use the real computed PR', () => {
    const res = buildArrival('B-ST5A', '00:00:05');
    expect(res.aircraftState).toBe(5);

    const params = res.entry.$v.DynamicsData.DynamicsParams;
    expect(params).toBeDefined();
    expect(params.$type).toContain('ApproachDynamicsParams');
    // Output value is the constant — not the real PR.
    expect(params.ProgressRatio).toBe(STATE5_OUTPUT_PROGRESS_RATIO);
    expect(params.ProgressRatio).toBe(0);
    expect(REAL_PR5).toBeGreaterThan(0.9); // sanity: real PR differs from 0

    // Position/direction must still be computed from the real PR.
    const expectedPos = computePosition(flyPoints, appPoints, REAL_PR5, tdPos, APPROACH_CAP);
    const expectedDir = computeDirection(flyPoints, appPoints, REAL_PR5, tdPos);
    const pos = res.entry.$v._position.__v[0].__v;
    const dir = res.entry.$v._direction.__v[0].__v;
    expect(pos[0]).toBeCloseTo(expectedPos.x, 5);
    expect(pos[1]).toBeCloseTo(expectedPos.y, 5);
    expect(pos[2]).toBeCloseTo(expectedPos.z, 5);
    expect(dir[0]).toBeCloseTo(expectedDir.x, 5);
    expect(dir[2]).toBeCloseTo(expectedDir.z, 5);

    // …and therefore differ from a PR=0 placement (the stored value).
    const zeroPos = computePosition(flyPoints, appPoints, 0, tdPos, APPROACH_CAP);
    expect(Math.abs(pos[0] - zeroPos.x)).toBeGreaterThan(1e-3);
    expect(Math.abs(pos[2] - zeroPos.z)).toBeGreaterThan(1e-3);
  });

  it('keeps state=30 aircraft on their real stored PR', () => {
    // Early on approach: rawTargetDist = 0.2 * totalLen — before the IAF.
    const ttl30 = Math.round(0.8 * TAT);
    if ((1 - ttl30 / TAT) * TOTAL_LEN >= FLY_LEN) {
      throw new Error('fixture geometry degenerate: 20% of path already past IAF');
    }
    const res = buildArrival('B-ST3A', '00:' + String(Math.floor(ttl30 / 60)).padStart(2, '0') + ':' + String(ttl30 % 60).padStart(2, '0'));
    expect(res.aircraftState).toBe(30);

    const params = res.entry.$v.DynamicsData.DynamicsParams;
    expect(params).toBeDefined();
    expect(params.$type).toContain('FlyApproachDynamicsParams');
    const realPR30 = 1 - Math.max(ttl30, 30) / TAT;
    expect(params.ProgressRatio).toBeCloseTo(realPR30, 6);
    expect(params.ProgressRatio).not.toBe(STATE5_OUTPUT_PROGRESS_RATIO);
  });
});
