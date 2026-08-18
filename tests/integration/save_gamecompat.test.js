/**
 * Save-pipeline game-compatibility regression suite.
 *
 * These tests reproduce the four "broken save" conditions that the fuzz
 * campaign generated and the game then rejected on load, and pin the
 * invariants a saved .acl must satisfy for the game to accept it.
 *
 * THE CONDITIONS (all confirmed against real game crashes):
 *
 *  1. SAME-REGISTRATION ARR+DEP PAIR
 *     The fuzz assigns one registration to an arrival AND a departure
 *     (the editor validator only checks duplicates within each group).
 *     Saving that state emits:
 *       a) TWO `"$k": "flight-plan:B-XXXX"` entries in StaticItems — the
 *          game resolves the docked aircraft's StaticItem to the wrong leg:
 *          InvalidOperationException "Aircraft 'aircraft:B-XXXX' has no
 *          call sign for active flight direction 'Departure'".
 *       b) NO `aircraft:B-XXXX` runtime entity for the docked departure —
 *          the frame rebuild's turnaround logic (regFlights Map +
 *          turnaroundWinner) keeps only one side. The game then runs
 *          JetwayHD.SetDockingTarget on a never-activated Aircraft:
 *          NullReferenceException during GameStateRegistry.InitAll.
 *
 *  2. STAND SHARED WITH A DOCKED AIRCRAFT THAT DEPARTS AFTER THE
 *     SCENARIO ENDS
 *     A docked aircraft whose scheduled takeoff lies beyond the scenario
 *     end blocks its stand for the whole session. An arrival assigned to
 *     that stand throws: InvalidOperationException "Stand 'X' is already
 *     allocated to owner 'B-YYYY' from 0001-01-01 until 9999-12-31".
 *     (Arrivals that land AFTER a docked aircraft's off-block are fine —
 *     game-authored files hand stands over with 2-minute gaps.)
 *
 *  3. TWO ARRIVALS ON ONE STAND CLOSE TOGETHER
 *     Arrival claims overlap when their landings are within ~15 min.
 *     Game-authored files never place two arrivals on one stand at all;
 *     fuzz files with 1-14 min gaps were rejected on load.
 *
 *  4. ARR→DEP SAME-STAND, DIFFERENT REGISTRATION
 *     An arrival landing before another aircraft's departure off-block at
 *     the same stand (the editor's _validateStandConflicts already rejects
 *     this — kept here as a regression guard).
 *
 * Each test drives the REAL save pipeline (parser.generateFullAcl → the
 * v4 static-data + checkpoint-frame rebuild + writeAcl) against a copy of
 * a game-authored level fixture, then asserts the saved output satisfies
 * the invariants in gamecompat-utils.cjs.
 *
 * EXPECTED: the four condition tests FAIL against the current editor
 * (reproducing the broken saves) and PASS once the save pipeline enforces
 * the invariants.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const parser = require('../../src/acl/parser');
const { readAclText } = require('../../src/acl/gatcarc');
const { buildApproachCache } = require('../../src/acl/approach');
const { analyze, runChecks, timeStrToSec } =
  require('./gamecompat-utils.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  __dirname,
  '../fixtures/game-root/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/ZSJN_leisure_1.acl'
);
const FIXTURE_LEVEL_DIR = path.dirname(FIXTURE);

// Approach cache built once from the fixture level dir — the same input the
// app's real save path receives (spec DB, designator map, approach data).
const approachCache = buildApproachCache(FIXTURE_LEVEL_DIR);

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── helpers ────────────────────────────────────────────────────────

/** Copy the fixture into a temp <root>/Airports/ZSJN/Levels/ dir (so the
 *  save pipeline's ICAO regex matches) and return the copy path. */
function tmpLevel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac27-gamecompat-'));
  tmpDirs.push(root);
  const levelDir = path.join(root, 'Airports', 'ZSJN', 'Levels');
  fs.mkdirSync(levelDir, { recursive: true });
  const aclPath = path.join(levelDir, 'ZSJN_leisure_1.acl');
  fs.copyFileSync(FIXTURE, aclPath);
  return aclPath;
}

/** Run the real save pipeline and return the decoded saved text. */
function saveWith(aclPath, flights) {
  parser.generateFullAcl(aclPath, flights, undefined, undefined, undefined, undefined, approachCache, undefined, undefined);
  return readAclText(aclPath);
}

const secToTime = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

function fixtureFlights(aclPath) {
  const r = parser.loadFlights(aclPath);
  if (!r || !r.flights || !r.flights.length) throw new Error('fixture flights could not be loaded');
  return r.flights;
}

function isDepOf(f) {
  return f.isDeparture === true || !!(f.OffBlockTime || '').trim();
}

/** Pick a docked departure flight + its frame info from the fixture whose
 *  stand has NO arrival plans at all (so moving the departure's times past
 *  the scenario end cannot trip the existing ARR→DEP save gate). */
function pickDockedDep(aclPath) {
  const a = analyze(readAclText(FIXTURE));
  const depPlanByReg = new Map(a.doc0Plans.filter(p => p.leg === 'D').map(p => [p.reg, p]));
  const flights0 = fixtureFlights(aclPath);
  for (const d of a.frameDocked) {
    if (d.offBlockSec == null || d.takeoffSec == null) continue;
    const plan = depPlanByReg.get(d.reg);
    if (!plan) continue;
    const arrsAtStand = a.doc0Plans.filter(p => p.stand === d.stand && p.leg === 'A' && p.reg !== d.reg);
    if (arrsAtStand.length) continue;
    const fl = flights0.find(f => (f._Registration || f.Registration || '') === d.reg && isDepOf(f));
    if (fl) return { fl, docked: d };
  }
  throw new Error('no docked departure flight with an arrival-free stand found in fixture');
}

/** A stand used by NO docked aircraft and (optionally) only by DEP flights. */
function pickFreeStand(a, { depOnly = true } = {}) {
  const dockedStands = new Set(a.frameDocked.map(d => d.stand));
  const byStand = new Map();
  for (const p of a.doc0Plans) {
    if (!p.stand) continue;
    if (!byStand.has(p.stand)) byStand.set(p.stand, []);
    byStand.get(p.stand).push(p);
  }
  const candidates = [...byStand.entries()]
    .filter(([s]) => !dockedStands.has(s))
    .filter(([s, list]) => !depOnly || list.every(p => p.leg === 'D'))
    .map(([s]) => s);
  if (candidates.length) return candidates[0];
  // fall back to any non-docked stand
  const used = new Set(byStand.keys());
  for (const s of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '201', '203', '301', '302', '303', '304', '305', '306', '307', '308', '309', '311', '313', '314', '321', '322', '323', '324']) {
    if (!dockedStands.has(s) && !used.has(s)) return s;
  }
  throw new Error('no free stand available');
}

/** Clone an arrival flight from an existing ARR row with fresh values. */
function makeArrival(templateArr, { reg, stand, landingTime }) {
  const f = { ...templateArr };
  f.Registration = reg;
  f._Registration = reg;
  f.Stand = stand;
  f.LandingTime = landingTime;
  f.InBlockTime = '';
  f.OffBlockTime = '';
  f.TakeoffTime = '';
  f.isDeparture = false;
  f.Airway = f.Airway || '';
  return f;
}

/** Unique registration not present in the current flights. */
function freshReg(flights, base) {
  const regs = new Set(flights.map(f => (f._Registration || f.Registration || '').trim()).filter(Boolean));
  for (const suffix of 'ABCDEFGHJKLMNPQRSTUVWXYZ') {
    const cand = base + suffix;
    if (!regs.has(cand)) return cand;
  }
  throw new Error('cannot allocate a fresh registration');
}

const codes = (issues) => issues.map(i => i.code);
void codes;

// ── tests ──────────────────────────────────────────────────────────

describe('save pipeline game-compatibility invariants', () => {
  it('control: saving the unmodified game-authored level keeps every invariant', () => {
    const aclPath = tmpLevel();
    const flights = fixtureFlights(aclPath);
    const saved = saveWith(aclPath, flights);
    const a = analyze(saved);
    const { issues } = runChecks(a);
    expect(issues, issues.map(i => `[${i.code}] ${i.msg}`).join('\n')).toEqual([]);
  });

  it('same-registration ARR+DEP pair: unique plan keys and a runtime entity for the docked aircraft', () => {
    const aclPath = tmpLevel();
    const { fl: dep, docked } = pickDockedDep(aclPath);
    const flights = fixtureFlights(aclPath);
    const a0 = analyze(readAclText(FIXTURE));

    // an arrival sharing the docked departure's registration, landing 10 min
    // BEFORE the departure off-blocks (turnaroundWinner then favours the ARR
    // and the docked DEP loses its entity)
    const landingSec = Math.max(docked.offBlockSec - 10 * 60, (timeStrToSec('00:00:00') || 0) + 60);
    const arrStand = pickFreeStand(a0);
    const arr = makeArrival(
      flights.find(f => !isDepOf(f)) || flights[0],
      { reg: dep._Registration || dep.Registration, stand: arrStand, landingTime: secToTime(landingSec) }
    );
    flights.push(arr);

    const saved = saveWith(aclPath, flights);
    const a = analyze(saved);
    const { issues } = runChecks(a);
    const bad = issues.filter(i =>
      i.code === 'dup-plan-key' || i.code === 'docked-missing-entity' ||
      i.code === 'docked-entity-wrong-target' || i.code === 'resolution-missing-leg');
    expect(bad, bad.map(i => `[${i.code}] ${i.msg}`).join('\n')).toEqual([]);
  });

  it('arrival at a stand whose docked departure leaves after scenario end: stand not double-booked', () => {
    const aclPath = tmpLevel();
    const { docked } = pickDockedDep(aclPath);
    const flights = fixtureFlights(aclPath);
    const a0 = analyze(readAclText(FIXTURE));
    const endSec = a0.config.endSec;

    // push the docked departure's off-block/takeoff beyond the scenario end
    const dep = flights.find(f => (f._Registration || f.Registration || '') === docked.reg && isDepOf(f));
    const newOb = secToTime(endSec + 10 * 60);
    dep.OffBlockTime = newOb;
    dep.TakeoffTime = secToTime(endSec + 12 * 60);

    // a different aircraft's arrival at the SAME stand, landing after the
    // (moved) off-block — DEP→ARR order, so the editor validator passes it,
    // but the game blocks the stand because the docked aircraft never
    // departs in-session.
    const arr = makeArrival(
      flights.find(f => !isDepOf(f)) || flights[0],
      { reg: freshReg(flights, dep._Registration || dep.Registration), stand: docked.stand, landingTime: secToTime(endSec + 15 * 60) }
    );
    flights.push(arr);

    const saved = saveWith(aclPath, flights);
    const a = analyze(saved);
    const { issues } = runChecks(a);
    const bad = issues.filter(i => i.code === 'docked-stand-blocked' || i.code === 'docked-stand-before-offblock');
    expect(bad, bad.map(i => `[${i.code}] ${i.msg}`).join('\n')).toEqual([]);
  });

  it('two arrivals on one stand within the minimum gap: stands separated', () => {
    const aclPath = tmpLevel();
    const flights = fixtureFlights(aclPath);
    const a0 = analyze(readAclText(FIXTURE));

    // a DEP-only stand (no docked aircraft) — the editor validator ignores
    // ARR→ARR adjacencies, so both arrivals pass the save gate.
    const stand = pickFreeStand(a0);
    const depsAtStand = a0.doc0Plans.filter(p => p.stand === stand && p.leg === 'D');
    const lastDepSec = depsAtStand.length ? Math.max(...depsAtStand.map(p => p.tSec ?? 0)) : a0.config.startSec || 0;
    const t0 = lastDepSec + 10 * 60;
    const template = flights.find(f => !isDepOf(f)) || flights[0];
    const regBase = (template._Registration || template.Registration || 'B-9999').slice(0, 4);
    const arr1 = makeArrival(template, { reg: freshReg(flights, regBase), stand, landingTime: secToTime(t0) });
    flights.push(arr1);
    const arr2 = makeArrival(template, {
      reg: freshReg(flights, regBase),
      stand,
      landingTime: secToTime(t0 + 5 * 60), // 5 min later — inside STAND_MIN_GAP
    });
    flights.push(arr2);

    const saved = saveWith(aclPath, flights);
    const a = analyze(saved);
    const { issues } = runChecks(a);
    const bad = issues.filter(i => i.code === 'arr-arr-close');
    expect(bad, bad.map(i => `[${i.code}] ${i.msg}`).join('\n')).toEqual([]);
  });

  it('guard: every frame aircraft resolves its plan leg with a callsign after a healthy save', () => {
    const aclPath = tmpLevel();
    const flights = fixtureFlights(aclPath);
    const saved = saveWith(aclPath, flights);
    const a = analyze(saved);
    const { issues } = runChecks(a);
    const bad = issues.filter(i => i.code === 'resolution-missing-leg');
    expect(bad, bad.map(i => `[${i.code}] ${i.msg}`).join('\n')).toEqual([]);
  });

  it('arrival with an empty STAR: STAR filled from the runway map (game FlightPlan.Init drops STAR-less legs)', () => {
    const aclPath = tmpLevel();
    const flights = fixtureFlights(aclPath);
    const a0 = analyze(readAclText(FIXTURE));
    const stand = pickFreeStand(a0); // DEP-only stand — no ARR→DEP conflicts
    const depsAtStand = a0.doc0Plans.filter(p => p.stand === stand && p.leg === 'D');
    const lastDepSec = depsAtStand.length ? Math.max(...depsAtStand.map(p => p.tSec ?? 0)) : a0.config.startSec || 0;
    const template = flights.find(f => !isDepOf(f)) || flights[0];
    const regBase = (template._Registration || template.Registration || 'B-9999').slice(0, 4);
    const arr = makeArrival(template, {
      reg: freshReg(flights, regBase),
      stand,
      landingTime: secToTime(lastDepSec + 10 * 60),
    });
    arr.Airway = ''; // empty STAR — the exact condition that crashed KJFK on flight-plan:HL0680
    flights.push(arr);

    const saved = saveWith(aclPath, flights);
    const a = analyze(saved);
    const { issues } = runChecks(a);
    const bad = issues.filter(i => i.code === 'arrival-no-star');
    expect(bad, bad.map(i => `[${i.code}] ${i.msg}`).join('\n')).toEqual([]);
    const plan = a.doc0Plans.find(p => p.reg === arr.Registration);
    expect(plan && plan.star, 'saved arrival leg must carry a non-empty STAR').toBeTruthy();
  });

  it('arrival on a runway with no STAR data: moved to an arrival-capable runway with a STAR', () => {
    const aclPath = tmpLevel();
    const flights = fixtureFlights(aclPath);
    const a0 = analyze(readAclText(FIXTURE));
    const stand = pickFreeStand(a0);
    const depsAtStand = a0.doc0Plans.filter(p => p.stand === stand && p.leg === 'D');
    const lastDepSec = depsAtStand.length ? Math.max(...depsAtStand.map(p => p.tSec ?? 0)) : a0.config.startSec || 0;
    const template = flights.find(f => !isDepOf(f)) || flights[0];
    const regBase = (template._Registration || template.Registration || 'B-9999').slice(0, 4);
    const arr = makeArrival(template, {
      reg: freshReg(flights, regBase),
      stand,
      landingTime: secToTime(lastDepSec + 10 * 60),
    });
    arr.Airway = '';
    arr.Runway = '99'; // runway with no STAR data anywhere in the airport
    flights.push(arr);

    const saved = saveWith(aclPath, flights);
    const a = analyze(saved);
    const { issues } = runChecks(a);
    const bad = issues.filter(i => i.code === 'arrival-no-star');
    expect(bad, bad.map(i => `[${i.code}] ${i.msg}`).join('\n')).toEqual([]);
    const plan = a.doc0Plans.find(p => p.reg === arr.Registration);
    expect(plan && plan.star, 'saved arrival must have a STAR (runway fallback)').toBeTruthy();
  });

  it('guard: ARR→DEP same-stand pairs with different registrations never reach the file', () => {
    const aclPath = tmpLevel();
    const flights = fixtureFlights(aclPath);
    const a0 = analyze(readAclText(FIXTURE));
    const stand = pickFreeStand(a0, { depOnly: false });
    const template = flights.find(f => !isDepOf(f)) || flights[0];
    const regBase = (template._Registration || template.Registration || 'B-9999').slice(0, 4);
    const t0 = (a0.config.startSec || 0) + 5 * 60;
    const arr = makeArrival(template, { reg: freshReg(flights, regBase), stand, landingTime: secToTime(t0) });
    flights.push(arr);
    // a departure of a DIFFERENT registration at the same stand right after
    const depTemplate = flights.find(f => isDepOf(f)) || flights[0];
    const dep2 = { ...depTemplate };
    dep2.Registration = freshReg(flights, regBase);
    dep2._Registration = dep2.Registration;
    dep2.Stand = stand;
    dep2.OffBlockTime = secToTime(t0 + 5 * 60);
    dep2.TakeoffTime = secToTime(t0 + 10 * 60);
    dep2.LandingTime = '';
    dep2.InBlockTime = '';
    dep2.isDeparture = true;
    flights.push(dep2);

    // The editor's own save gate must reject this (throws "Save aborted").
    let aborted = false;
    try {
      saveWith(aclPath, flights);
    } catch (e) {
      aborted = /Stand .* conflict|Save aborted/i.test(e.message);
      expect(e.message).toMatch(/Stand .* conflict|Save aborted/i);
    }
    expect(aborted, 'expected the editor save gate to reject the ARR→DEP stand conflict').toBe(true);

    // And if it did not abort, the invariant check must catch it.
    if (!aborted) {
      const a = analyze(readAclText(aclPath));
      const { issues } = runChecks(a);
      const bad = issues.filter(i => i.code === 'arr-dep-cross-reg');
      expect(bad, bad.map(i => `[${i.code}] ${i.msg}`).join('\n')).toEqual([]);
    }
  });
});
