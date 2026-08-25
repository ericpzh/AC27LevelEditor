/**
 * gamecompat-utils — analysis helpers for the save-pipeline game-compat
 * regression suite (tests/integration/save_gamecompat.test.js).
 *
 * These encode the empirically derived invariants a saved .acl must satisfy
 * for the game to load it without errors. Derived from four crash classes:
 *
 *  1. DOCKED ENTITY LOSS — when an arrival and a departure share a
 *     registration and the arrival lands first, the frame rebuild's
 *     turnaround logic drops the docked departure's `aircraft:REG` runtime
 *     entity. The game then runs SetDockingTarget on a never-activated
 *     Aircraft → NullReferenceException (JetwayHD.SetDockingTarget).
 *     Invariant: every docked jetway's registration has an `aircraft:REG`
 *     entity in RuntimeEntities.
 *
 *  2. DUPLICATE PLAN KEYS — the same registration in an ARR and a DEP emits
 *     two `"$k": "flight-plan:B-XXXX"` entries in StaticItems. The game
 *     resolves an aircraft's StaticItem to the wrong leg →
 *     InvalidOperationException "has no call sign for active flight
 *     direction 'Departure'".
 *     Invariant: StaticItems flight-plan keys are unique.
 *
 *  3. STAND CONFLICTS — the game's StandManager rejects overlapping stand
 *     claims at level init (frame-linked claims only; doc0-only flights
 *     allocate later at spawn time):
 *       - a DOCKED aircraft occupies its stand from scenario start until its
 *         off-block (pushback). If its scheduled takeoff lies beyond the
 *         scenario end, the stand is blocked for the whole session
 *         (observed rejects: landing 58s after takeoff where takeoff was
 *         out-of-scenario — peakdep B-5129@5; landing 11min after off-block
 *         where takeoff was out-of-scenario — taxiclosed B-31B3@36).
 *         → other-reg arrivals must not land at a docked stand unless the
 *           docked aircraft's takeoff is within the scenario AND the arrival
 *           lands after the docked aircraft's off-block.
 *       - ARR→DEP same-stand pairs must share the registration (the editor
 *         validator already enforces this; asserted here for regression).
 *       - two ARR claims at the same stand must be ≥ STAND_MIN_GAP apart
 *         (observed accept: +16 min; conservative test threshold: 20 min).
 *     DEP→ARR pairs of different aircraft are ALLOWED at any gap (the
 *     game-authored files contain 2-minute DEP→ARR handovers).
 *
 *  4. LEG RESOLUTION — every frame aircraft must resolve its plan to the
 *     leg matching its direction with a CallSign (guaranteed by #2).
 */
'use strict';

const { readJson } = require('../../src/acl/odin/json_reader');
const { readBinary } = require('../../src/acl/odin/binary_reader');

const SENT = /\r?\n\$\$\$ GATCARC4 CHECKPOINT FRAME \$\$\$\r?\n/;

// ── Odin JSON tree builder (same sink vocabulary as the editor pipeline) ──
class TB {
  constructor() { this.root = null; this.stack = []; }
  node() { return this.stack[this.stack.length - 1]; }
  push(n) { const cur = this.node(); if (cur) { if (Array.isArray(cur.value)) cur.value.push(n); else cur.fields[n.name] = n; } else if (!this.root) this.root = n; this.stack.push(n); }
  pop() { this.stack.pop(); }
  mkNode(name) { return { name, kind: 'node', value: null, type: null, id: null, fields: {} }; }
  mkArray() { return { name: null, kind: 'array', value: [], type: null, id: null, fields: {} }; }
  mkValue(name, value) { return { name, kind: 'value', value, type: null, id: null, fields: {} }; }
  beginReferenceNode(name, typeRef, refId) { const n = this.mkNode(name); n.type = typeRef && typeRef.name; n.id = refId; this.push(n); }
  beginStructNode(name, typeRef) { const n = this.mkNode(name); n.type = typeRef && typeRef.name; this.push(n); }
  endNode() { this.pop(); }
  beginArrayNode() { this.push(this.mkArray()); }
  endArrayNode() { this.pop(); }
  writePrimitiveArray(len, size, raw) { const cur = this.node(); if (cur) { if (Array.isArray(cur.value)) cur.value.push(this.mkValue(null, { __blob: raw })); else cur.fields['$blob'] = this.mkValue('$blob', { __blob: raw }); } }
  writeSByte(n, v) { this.leaf(n, v); } writeByte(n, v) { this.leaf(n, v); } writeInt16(n, v) { this.leaf(n, v); }
  writeUInt16(n, v) { this.leaf(n, v); } writeInt32(n, v) { this.leaf(n, v); } writeUInt32(n, v) { this.leaf(n, v); }
  writeInt64(n, v) { this.leaf(n, v); } writeUInt64(n, v) { this.leaf(n, v); } writeSingle(n, v) { this.leaf(n, v); }
  writeDouble(n, v) { this.leaf(n, v); } writeDecimal(n, v) { this.leaf(n, v); } writeChar(n, v) { this.leaf(n, v); }
  writeString(n, v) { this.leaf(n, v); } writeGuid(n, v) { this.leaf(n, v); } writeBoolean(n, v) { this.leaf(n, v); }
  writeNull(n) { this.leaf(n, null); }
  writeInternalReference(n, id) { this.leaf(n, { __iref: id }); }
  writeExternalIndex(n, id) { this.leaf(n, { __eref: id }); }
  writeExternalGuid(n, g) { this.leaf(n, { __guidref: g }); }
  writeExternalString(n, s) { this.leaf(n, { __fstrref: s }); }
  leaf(n, v) { const cur = this.node(); if (!cur) return; if (Array.isArray(cur.value)) cur.value.push(this.mkValue(null, v)); else cur.fields[n] = this.mkValue(n, v); }
}
function decodeBlobs(node) {
  if (!node) return;
  if (node.kind === 'value' && node.value && node.value.__blob) {
    const b = new TB();
    try { readBinary(node.value.__blob, b); node.value = b.root; node.kind = 'node'; node.fields = b.root.fields; }
    catch (_) { /* keep raw */ }
  }
  for (const f of Object.values(node.fields || {})) decodeBlobs(f);
  if (Array.isArray(node.value)) for (const c of node.value) if (c && typeof c === 'object') decodeBlobs(c);
}
function unwrap(n) {
  if (!n) return undefined;
  if (n.kind === 'value') return n.value;
  if (n.fields && n.fields['null']) return unwrap(n.fields['null']);
  return undefined;
}
function getVal(node, name) { return unwrap(node && node.fields ? node.fields[name] : undefined); }

const ticksToSec = (t) => (typeof t === 'bigint' && t !== 0n) ? Number((t % 864000000000n) / 10000000n) : null;
const timeStrToSec = (t) => {
  if (!t) return null;
  const p = String(t).split(':');
  if (p.length < 2) return null;
  return +p[0] * 3600 + +p[1] * 60 + (+p[2] || 0);
};

/** Thresholds (empirical, documented above). */
const STAND_MIN_GAP = 20 * 60; // seconds — ARR-ARR same-stand separation

/**
 * Parse a decoded .acl text into the structures the checks need.
 * @returns {{
 *   config: {startSec, endSec},
 *   doc0Plans: {reg, leg, stand, tSec, arrCs, depCs}[],
 *   frameDocked: {reg, stand, offBlockSec, takeoffSec}[],
 *   frameAircraftRegs: string[],
 *   frameFp: Map<reg, {arrStand, depStand, arrRwy, depRwy}>,
 *   planKeys: Map<reg, number>
 * }}
 */
function analyze(text) {
  const docs = text.split(SENT);
  const doc0 = docs[0];
  const frame = docs[docs.length - 1];

  const config = { startSec: null, endSec: null };
  {
    const m = doc0.match(/"startTime":\s*"([^"]+)"/);
    const m2 = doc0.match(/"endTime":\s*"([^"]+)"/);
    if (m) config.startSec = timeStrToSec(m[1]);
    if (m2) config.endSec = timeStrToSec(m2[1]);
  }

  const planKeys = new Map();
  const doc0Plans = [];
  {
    const b = new TB(); readJson(doc0, b); decodeBlobs(b.root);
    (function walk(n) {
      if (!n) return;
      if (n.fields && n.fields.$k) {
        const k = unwrap(n.fields.$k);
        if (typeof k === 'string' && k.startsWith('flight-plan:')) {
          const reg = k.substring('flight-plan:'.length);
          planKeys.set(reg, (planKeys.get(reg) || 0) + 1);
          const v = n.fields.$v;
          const fp = v && (v.kind === 'node' ? v : (v.fields && v.fields['null']));
          if (fp) {
            const arrN = fp.fields.InitialArrival;
            const depN = fp.fields.InitialDeparture;
            const arr = arrN && arrN.kind === 'node' ? (arrN.fields['null'] || arrN) : null;
            const dep = depN && depN.kind === 'node' ? (depN.fields['null'] || depN) : null;
            doc0Plans.push({
              reg,
              leg: arr ? 'A' : (dep ? 'D' : '?'),
              stand: arr ? getVal(arr, 'Stand') : (dep ? getVal(dep, 'Stand') : null),
              tSec: arr ? ticksToSec(getVal(arr, 'LandingTime')) : ticksToSec(getVal(dep, 'OffBlockTime')),
              arrCs: arr ? getVal(arr, 'CallSign') : null,
              depCs: dep ? getVal(dep, 'CallSign') : null,
              star: arr ? getVal(arr, 'STAR') : null,
            });
          }
        }
        return;
      }
      for (const f of Object.values(n.fields || {})) walk(f);
      if (Array.isArray(n.value)) for (const c of n.value) walk(c);
    })(b.root);
  }

  const frameDocked = [];
  const frameAircraftRegs = [];
  const frameAircraftMap = new Map(); // reg -> { irefTarget }
  const frameFp = new Map();
  if (docs.length > 1) {
    const b = new TB(); readJson(frame, b); decodeBlobs(b.root);
    const rf = b.root.fields.Snapshot.fields.RuntimeData.fields.$blob;
    const ents = rf.fields.RuntimeEntities;
    const content = ents.fields.$rcontent || ents.fields['null'];
    for (const entry of content.value) {
      const k = unwrap(entry.fields.$k);
      if (typeof k !== 'string') continue;
      const v = entry.fields.$v;
      if (k.startsWith('aircraft:') && !k.startsWith('aircraft-animator')) {
        const reg = k.substring('aircraft:'.length);
        frameAircraftRegs.push(reg);
        // $v is either an $iref leaf or an inline Aircraft node
        let irefTarget = null;
        if (v.kind === 'value' && v.value && v.value.__iref != null) irefTarget = v.value.__iref;
        else if (v.kind === 'node') {
          const inner = v.fields && v.fields['null'];
          if (inner && inner.kind === 'value' && inner.value && inner.value.__iref != null) irefTarget = inner.value.__iref;
          else irefTarget = v.id != null ? v.id : null;
        }
        frameAircraftMap.set(reg, { irefTarget });
      } else if (k.startsWith('jetway:')) {
        if (getVal(v, 'Status') !== 2) continue;
        const da = v.fields.DockingAircraft;
        const inner = da && da.fields && da.fields['null'];
        if (!inner || inner.kind !== 'node') continue;
        const si = getVal(inner.fields._flightPlan, 'StaticItem');
        const reg = si && si.__fstrref ? si.__fstrref.replace(/^flight-plan:/, '') : null;
        if (!reg) continue;
        frameDocked.push({
          reg,
          stand: getVal(inner.fields._flightPlan, '_departureStand'),
          takeoffSec: ticksToSec(getVal(inner.fields._flightPlan, '_departureTakeoffTime')),
          acId: inner.id != null ? inner.id : null, // inline Aircraft object id
        });
      } else if (k.startsWith('flight-plan:')) {
        const reg = k.substring('flight-plan:'.length);
        const inner = v && (v.kind === 'node' && !v.fields['null'] ? v : (v.fields && v.fields['null']));
        frameFp.set(reg, {
          arrStand: getVal(inner, '_arrivalStand'),
          depStand: getVal(inner, '_departureStand'),
          arrRwy: getVal(inner, '_arrivalRunway'),
          depRwy: getVal(inner, '_departureRunway'),
        });
      }
    }
    // docked aircraft off-block comes from their doc0 DEP plan
    const depPlanByReg = new Map(doc0Plans.filter(p => p.leg === 'D').map(p => [p.reg, p]));
    for (const d of frameDocked) {
      const p = depPlanByReg.get(d.reg);
      d.offBlockSec = p ? p.tSec : null;
    }
  }

  return { config, doc0Plans, frameDocked, frameAircraftRegs, frameAircraftMap, frameFp, planKeys };
}

/**
 * @returns {{ issues: {code: string, msg: string}[], messages: string[] }}
 *   `issues` carries stable machine-readable codes:
 *     'dup-plan-key', 'docked-missing-entity', 'docked-entity-wrong-target',
 *     'arr-dep-cross-reg', 'docked-stand-blocked',
 *     'docked-stand-before-offblock', 'arr-arr-close',
 *     'arrival-no-star', 'resolution-missing-leg'
 */
function runChecks(a, { minGapSec = STAND_MIN_GAP } = {}) {
  const issues = [];

  // 1. unique flight-plan keys
  for (const [reg, n] of a.planKeys) {
    if (n > 1) issues.push({ code: 'dup-plan-key', msg: `duplicate flight-plan key: flight-plan:${reg} appears ${n}x` });
  }

  // 2. docked entity completeness — the aircraft:REG entry must exist AND
  //    reference the SAME Aircraft object the jetway's DockingAircraft holds
  //    (a standalone duplicate for the same reg does not activate the docked
  //    instance → SetDockingTarget NullReferenceException).
  for (const d of a.frameDocked) {
    const entry = a.frameAircraftMap.get(d.reg);
    if (!entry) {
      issues.push({ code: 'docked-missing-entity', msg: `docked aircraft ${d.reg} (stand ${d.stand}) has no aircraft:${d.reg} runtime entity` });
    } else if (d.acId != null && entry.irefTarget != null && entry.irefTarget !== d.acId) {
      issues.push({ code: 'docked-entity-wrong-target', msg: `docked aircraft ${d.reg}: aircraft:${d.reg} entity references $id ${entry.irefTarget}, but the jetway holds the inline Aircraft $id ${d.acId}` });
    }
  }

  // 3a. ARR→DEP same-stand cross-reg (time-ordered)
  {
    const byStand = new Map();
    for (const p of a.doc0Plans) {
      if (!p.stand) continue;
      if (!byStand.has(p.stand)) byStand.set(p.stand, []);
      byStand.get(p.stand).push(p);
    }
    for (const [stand, list] of byStand) {
      const withT = list.filter(p => p.tSec != null);
      withT.sort((x, y) => x.tSec - y.tSec);
      for (let i = 0; i + 1 < withT.length; i++) {
        const cur = withT[i], nxt = withT[i + 1];
        if (cur.leg === 'A' && nxt.leg === 'D' && cur.reg !== nxt.reg) {
          issues.push({ code: 'arr-dep-cross-reg', msg: `stand ${stand}: arrival ${cur.reg} at ${cur.tSec}s followed by departure ${nxt.reg} at ${nxt.tSec}s (different registrations)` });
        }
      }
    }
  }

  // 3b. ARR at a docked stand (other reg): allowed only when the docked
  //     aircraft's departure (off-block / takeoff) is within the scenario AND
  //     the arrival lands after the docked aircraft's off-block.
  {
    const dockedByStand = new Map();
    for (const d of a.frameDocked) dockedByStand.set(d.stand, d);
    for (const p of a.doc0Plans) {
      if (p.leg !== 'A' || !p.stand || p.tSec == null) continue;
      const d = dockedByStand.get(p.stand);
      if (!d || d.reg === p.reg) continue;
      const DEPARTURE_GRACE_SEC = 30 * 60;
      const outOfScenario =
        (d.offBlockSec != null && a.config.endSec != null && d.offBlockSec > a.config.endSec + DEPARTURE_GRACE_SEC) ||
        (d.takeoffSec != null && a.config.endSec != null && d.takeoffSec > a.config.endSec + DEPARTURE_GRACE_SEC);
      const landsBeforeOffBlock = p.tSec < (d.offBlockSec ?? 0);
      if (outOfScenario) {
        issues.push({ code: 'docked-stand-blocked', msg: `stand ${p.stand}: arrival ${p.reg} uses the stand of docked ${d.reg}, whose departure is beyond the scenario end (stand blocked all session)` });
      } else if (landsBeforeOffBlock) {
        issues.push({ code: 'docked-stand-before-offblock', msg: `stand ${p.stand}: arrival ${p.reg} lands ${Math.round((p.tSec - (d.offBlockSec ?? 0)) / 60)}min before docked ${d.reg}'s off-block (docked still at stand)` });
      }
    }
  }

  // 3c. ARR-ARR same-stand separation
  {
    const byStand = new Map();
    for (const p of a.doc0Plans) {
      if (p.leg !== 'A' || !p.stand) continue;
      if (!byStand.has(p.stand)) byStand.set(p.stand, []);
      byStand.get(p.stand).push(p);
    }
    for (const [stand, list] of byStand) {
      const withT = list.filter(p => p.tSec != null).sort((x, y) => x.tSec - y.tSec);
      for (let i = 0; i + 1 < withT.length; i++) {
        const gap = withT[i + 1].tSec - withT[i].tSec;
        if (gap < minGapSec) {
          issues.push({ code: 'arr-arr-close', msg: `stand ${stand}: arrivals ${withT[i].reg} and ${withT[i + 1].reg} are ${Math.round(gap / 60)}min apart (need ≥ ${Math.round(minGapSec / 60)}min)` });
        }
      }
    }
  }

  // 3d. arrival legs must carry a STAR — the game's FlightPlan.Init() drops
  //     a STAR-less arrival leg and throws "Flight plan '...' has neither an
  //     arrival nor a departure leg" (observed: KJFK_leisure_1 crashed on
  //     flight-plan:HL0680 with STAR ""; game-authored arrivals ALWAYS have
  //     a STAR such as "SIE.CAMRM5" / "PAWLN.PAWLN1").
  for (const p of a.doc0Plans) {
    if (p.leg !== 'A') continue;
    if (!p.star || !String(p.star).trim()) {
      issues.push({ code: 'arrival-no-star', msg: `arrival ${p.reg} (stand ${p.stand}) has no STAR (game drops STAR-less arrival legs at FlightPlan.Init)` });
    }
  }

  // 4. leg resolution for every frame aircraft
  {
    const planByReg = new Map();
    for (const p of a.doc0Plans) {
      if (!planByReg.has(p.reg)) planByReg.set(p.reg, []);
      planByReg.get(p.reg).push(p);
    }
    const dirOf = new Map();
    for (const d of a.frameDocked) dirOf.set(d.reg, 'D');
    for (const [reg, fp] of a.frameFp) {
      if (dirOf.has(reg)) continue;
      if (fp.arrRwy != null || fp.arrStand != null) dirOf.set(reg, 'A');
      else if (fp.depRwy != null || fp.depStand != null) dirOf.set(reg, 'D');
    }
    for (const reg of a.frameAircraftRegs) {
      const dir = dirOf.get(reg);
      if (!dir) continue; // direction unknown — skip
      const plans = planByReg.get(reg) || [];
      const ok = plans.some(p => dir === 'A' ? !!p.arrCs : !!p.depCs);
      if (!ok) {
        issues.push({ code: 'resolution-missing-leg', msg: `frame aircraft ${reg} (direction ${dir}) has no plan leg with a CallSign` });
      }
    }
  }

  return { issues, messages: issues.map(i => i.msg) };
}

module.exports = {
  SENT,
  TB,
  decodeBlobs,
  unwrap,
  getVal,
  ticksToSec,
  timeStrToSec,
  STAND_MIN_GAP,
  analyze,
  runChecks,
};
