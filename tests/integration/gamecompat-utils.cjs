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

const fs = require('fs');
const path = require('path');
const { readJson } = require('../../src/acl/odin/json_reader');
const { readBinary } = require('../../src/acl/odin/binary_reader');
const { detectAclFormat } = require('../../src/acl/archive');
const { readAclText } = require('../../src/acl/gatcarc');
const { parseV3Container } = require('../../src/acl/v3/framing');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const {
  dictEntries,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapReactive,
} = require('../../src/acl/v3/graph');
const { parseIsoWallClock, UNSET_DATETIME_ISO } = require('../../src/acl/v3/q32');
const { formatRunwayTimelineMembershipIssue } = require('../../src/acl/runway_timeline_membership');
const { validateV3ContainerRunwayTimelineMembership } = require('../../src/acl/v3/runway_timeline_validation');
const { validateV3ApproachRoutes, formatApproachValidationIssue } = require('../../src/acl/v3/approach_validation');
const { peekAclFormat } = require('../../src/acl/v3/audio');
const {
  verifyV3AudioCapabilities,
  validateV3CallsignAllocation,
  formatCallsignAllocationIssue,
} = require('../../src/acl/v3/callsign_validation');
const gamePaths = require('../../src/utils/gamePaths');

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
              // Voice/Language live on the FlightPlanState (sibling of
              // InitialArrival/InitialDeparture), NOT on the leg node.
              voice: getVal(fp, 'Voice'),
              language: getVal(fp, 'Language'),
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
    // Frame layout: v5+ is CheckpointPayload { RuntimeData, RecentMessages } directly;
    // older fixtures used CheckpointPayload { Snapshot { RuntimeData } }. Handle both.
    const snapshotNode = b.root.fields.Snapshot || b.root;
    const runtimeDataField = snapshotNode.fields.RuntimeData || b.root.fields.RuntimeData;
    if (!runtimeDataField) throw new Error('frame has no RuntimeData (neither Snapshot.RuntimeData nor RuntimeData)');
    const rf = runtimeDataField.fields.$blob;
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

function isoToSecOrNull(isoStr) {
  if (!isoStr || typeof isoStr !== 'string' || isoStr === UNSET_DATETIME_ISO) return null;
  const parsed = parseIsoWallClock(isoStr);
  if (!parsed || parsed.isUnset) return null;
  return parsed.secSinceMidnight;
}

/**
 * Parse a GATCARC4 v3 buffer (or parsed container) into the exact same
 * structures `analyze(text)` produces so `runChecks(a, opts)` works identically
 * across v1/v2 Odin archives and v3 archives.
 */
function analyzeV3(bufOrContainer, opts = {}) {
  const container = Buffer.isBuffer(bufOrContainer)
    ? parseV3Container(bufOrContainer)
    : bufOrContainer;
  const schema = getSchemaForHash(container.header.schemaHash);

  const cfg = container.metaData && container.metaData.Config;
  const config = {
    startSec: cfg && cfg.startTime ? timeStrToSec(cfg.startTime) : null,
    endSec: cfg && cfg.endTime ? timeStrToSec(cfg.endTime) : null,
  };

  const planKeys = new Map();
  const doc0Plans = [];
  const sIdx = indexDocumentGraph(container.staticData, schema.roots.static, schema);
  const siDict = resolveGraphNode(container.staticData && container.staticData.StaticItems, sIdx);
  if (siDict) {
    for (const [k, rawVal] of dictEntries(siDict)) {
      if (!k.startsWith('flight-plan:')) continue;
      const reg = k.substring('flight-plan:'.length);
      planKeys.set(reg, (planKeys.get(reg) || 0) + 1);
      const fp = resolveGraphNode(rawVal, sIdx);
      if (!fp) continue;
      const arr = fp.InitialArrival ? resolveGraphNode(fp.InitialArrival, sIdx) : null;
      const dep = fp.InitialDeparture ? resolveGraphNode(fp.InitialDeparture, sIdx) : null;
      doc0Plans.push({
        reg,
        leg: arr ? 'A' : (dep ? 'D' : '?'),
        stand: arr ? (arr.Stand ?? null) : (dep ? (dep.Stand ?? null) : null),
        tSec: arr ? isoToSecOrNull(arr.LandingTime) : (dep ? isoToSecOrNull(dep.OffBlockTime) : null),
        arrCs: arr ? (arr.CallSign ?? null) : null,
        depCs: dep ? (dep.CallSign ?? null) : null,
        star: arr ? (arr.STAR ?? null) : null,
        voice: fp.Voice ?? null,
        language: fp.Language ?? null,
      });
    }
  }

  const frameDocked = [];
  const frameAircraftRegs = [];
  const frameAircraftMap = new Map();
  const frameFp = new Map();

  if (Array.isArray(container.frames) && container.frames.length > 0) {
    const lastFrame = container.frames[container.frames.length - 1];
    const rIdx = indexDocumentGraph(lastFrame.runtimeData, schema.roots.runtime, schema);
    const reDict = resolveGraphNode(lastFrame.runtimeData && lastFrame.runtimeData.RuntimeEntities, rIdx);
    if (!reDict) {
      throw new Error('v3 frame has no RuntimeEntities');
    }
    for (const [k, rawV] of dictEntries(reDict)) {
      if (k.startsWith('aircraft:') && !k.startsWith('aircraft-animator')) {
        const reg = k.substring('aircraft:'.length);
        frameAircraftRegs.push(reg);
        const acNode = resolveGraphNode(rawV, rIdx);
        const irefTarget = acNode && acNode.$id != null ? Number(acNode.$id) : null;
        frameAircraftMap.set(reg, { irefTarget });
      } else if (k.startsWith('jetway:')) {
        const jw = resolveGraphNode(rawV, rIdx);
        if (!jw || Number(jw.Status) !== 2) continue;
        const dockRaw = unwrapReactive(jw.DockingAircraft, rIdx);
        const acNode = resolveGraphNode(dockRaw, rIdx);
        if (!acNode) continue;
        const fpNode = resolveGraphNode(acNode._flightPlan, rIdx);
        const siRef = fpNode && fpNode.StaticItem && fpNode.StaticItem.$ref;
        const m = typeof siRef === 'string' ? siRef.match(/flight-plan:(.+)$/) : null;
        const reg = m ? m[1] : null;
        if (!reg) continue;
        frameDocked.push({
          reg,
          stand: fpNode ? (fpNode._departureStand ?? null) : null,
          takeoffSec: fpNode ? isoToSecOrNull(fpNode._departureTakeoffTime) : null,
          acId: acNode.$id != null ? Number(acNode.$id) : null,
        });
      } else if (k.startsWith('flight-plan:')) {
        const reg = k.substring('flight-plan:'.length);
        const fpNode = resolveGraphNode(rawV, rIdx);
        if (fpNode) {
          frameFp.set(reg, {
            arrStand: fpNode._arrivalStand ?? null,
            depStand: fpNode._departureStand ?? null,
            arrRwy: fpNode._arrivalRunway ?? null,
            depRwy: fpNode._departureRunway ?? null,
          });
        }
      }
    }

    const depPlanByReg = new Map(doc0Plans.filter((p) => p.leg === 'D').map((p) => [p.reg, p]));
    for (const d of frameDocked) {
      const p = depPlanByReg.get(d.reg);
      d.offBlockSec = p ? p.tSec : null;
    }
  }

  const levelPath = opts.levelPath || null;
  const airportIcao = opts.airportIcao
    || (levelPath ? gamePaths.airportIcaoFromLevelPath(levelPath) : null)
    || container.header?.airportIcao
    || (cfg && cfg.prototypeName)
    || null;

  const v3TimelineCheck = validateV3ContainerRunwayTimelineMembership(container, schema, {
    throwOnError: false,
  });
  const v3ApproachCheck = validateV3ApproachRoutes(container.staticData, schema, {
    throwOnError: false,
  });
  const v3CallsignCheck = validateV3CallsignAllocation(container, schema, {
    levelPath,
    gameRoot: opts.gameRoot,
    airportIcao,
    v3Audio: opts.v3Audio,
    requireAudioMetadata: Boolean(opts.requireV3Audio),
  });

  return {
    isV3: true,
    container,
    schema,
    levelPath,
    airportIcao,
    config,
    doc0Plans,
    frameDocked,
    frameAircraftRegs,
    frameAircraftMap,
    frameFp,
    planKeys,
    v3TimelineCheck,
    v3ApproachCheck,
    v3CallsignCheck,
  };
}

/**
 * Format-auto-dispatching game-compat analyzer for any `.acl` file on disk
 * (GATCARC4 v3, v2, v1, or legacy text).
 */
function analyzeAclFile(aclPath, opts = {}) {
  const bytes = fs.readFileSync(aclPath);
  const fmt = detectAclFormat(bytes);
  if (fmt === 'gatcarc4-v3') {
    return analyzeV3(bytes, { ...opts, levelPath: opts.levelPath || aclPath });
  }
  return analyze(readAclText(aclPath));
}

/**
 * @returns {{ issues: {code: string, msg: string}[], messages: string[] }}
 *   `issues` carries stable machine-readable codes:
 *     'dup-plan-key', 'docked-missing-entity', 'docked-entity-wrong-target',
 *     'arr-dep-cross-reg', 'docked-stand-blocked',
 *     'docked-stand-before-offblock', 'arr-arr-close',
 *     'arrival-no-star', 'resolution-missing-leg', 'voice-language-mismatch',
 *     'airline-language-mismatch'
 *
 *   `voiceLanguages` (optional) is the install's voice_catalog map
 *   (name -> language); when supplied, flights whose captain voice declares a
 *   different language than the flight are reported — the game's VoiceCatalog
 *   throws InvalidOperationException on that at level load.
 *
 *   `airlineCountries` (optional) is the install's airline_country_registry map
 *   (airline code -> country) and `languages` the airport's available languages;
 *   when supplied, flights whose Language does not follow their airline
 *   (CN → zh, every other carrier → en) are reported — the game's CallsignService
 *   throws "failed to allocate callsign … for crew voice …" on that at load.
 */
function runChecks(
  a,
  {
    minGapSec = STAND_MIN_GAP,
    voiceLanguages = null,
    airlineCountries = null,
    languages = null,
    gameRoot = undefined,
    airportIcao = null,
    v3Audio = null,
    requireV3Audio = false,
  } = {},
) {
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

  // Resolve v3 callsign/voice audio allocation check against explicit
  // destination gameRoot / v3Audio when supplied, else pre-computed check.
  let v3CallsignCheck = a.v3CallsignCheck || null;
  if (
    a.isV3 &&
    a.container &&
    (gameRoot !== undefined || v3Audio != null || airportIcao != null || requireV3Audio)
  ) {
    v3CallsignCheck = validateV3CallsignAllocation(a.container, a.schema, {
      levelPath: a.levelPath || null,
      gameRoot,
      airportIcao: airportIcao || a.airportIcao || null,
      v3Audio,
      requireAudioMetadata: Boolean(requireV3Audio),
    });
  }
  const v3CatalogChecked = Boolean(
    a.isV3 &&
    v3CallsignCheck &&
    !v3CallsignCheck.metadataUnavailable &&
    (gameRoot || v3Audio || (a.levelPath && gamePaths.gameRootFromLevelPath(a.levelPath))),
  );

  // 5. voice/language consistency (only when the catalog map is supplied and
  //    v3 callsign check has not already verified voice_catalog.json).
  //    The game's VoiceCatalog throws InvalidOperationException at level load
  //    when an aircraft's captain voice language != the flight's Language.
  if (!v3CatalogChecked && voiceLanguages && typeof voiceLanguages === 'object') {
    for (const p of a.doc0Plans) {
      const declared = p.voice ? voiceLanguages[p.voice] : null;
      if (p.voice && p.language && declared && declared !== p.language) {
        issues.push({
          code: 'voice-language-mismatch',
          msg: `${p.leg === 'A' ? 'arrival' : 'departure'} ${p.reg}: voice "${p.voice}" (catalog ${declared}) does not match language "${p.language}"`,
        });
      }
    }
  }

  // 6. Legacy/v2 airline/language consistency (only on pre-v3 archives when the
  //    registry map is supplied — GATCARC4 v3 uses radio_clip_durations.json +
  //    voice_catalog.json + radio_channel_config.json instead).
  if (!a.isV3 && airlineCountries && typeof airlineCountries === 'object') {
    const hasZh = Array.isArray(languages) ? languages.includes('zh') : true;
    for (const p of a.doc0Plans) {
      const cs = String(p.arrCs || p.depCs || '');
      const code = cs.substring(0, 3).toUpperCase();
      const country = code ? airlineCountries[code] : null;
      if (!country) continue;
      const expected = country === 'CN' ? (hasZh ? 'zh' : 'en') : 'en';
      if (p.language && p.language !== expected) {
        issues.push({
          code: 'airline-language-mismatch',
          msg: `${p.leg === 'A' ? 'arrival' : 'departure'} ${p.reg} (${code}, ${country}): language "${p.language}" must be "${expected}"`,
        });
      }
    }
  }

  // 7. v3 Runway timeline membership (FlightPlanSessionValidator.ValidateRunways)
  if (a.v3TimelineCheck && Array.isArray(a.v3TimelineCheck.issues)) {
    for (const iss of a.v3TimelineCheck.issues) {
      issues.push({
        code: 'runway-not-in-timeline',
        msg: formatRunwayTimelineMembershipIssue(iss),
      });
    }
  }

  // 8. v3 Arrival approach route resolution (AirwayRouteService.GetRoute('APP'))
  if (a.v3ApproachCheck && Array.isArray(a.v3ApproachCheck.issues)) {
    for (const iss of a.v3ApproachCheck.issues) {
      issues.push({
        code: 'arrival-missing-approach',
        msg: iss.message || formatApproachValidationIssue(iss),
      });
    }
  }

  // 9. v3 Callsign/voice audio allocation (FlightScheduleManager.TryAllocateCallsignReservation / CallsignService)
  if (v3CallsignCheck && Array.isArray(v3CallsignCheck.issues)) {
    const codeByKind = {
      audio_metadata_unavailable: 'v3-audio-metadata-unavailable',
      missing_captain_clip: 'v3-missing-captain-clip',
      missing_atc_clip: 'v3-missing-atc-clip',
      unknown_captain_voice: 'v3-unknown-captain-voice',
      invalid_captain_voice: 'v3-invalid-captain-voice',
      voice_language_mismatch: 'voice-language-mismatch',
      unsupported_language: 'v3-unsupported-language',
      duplicate_pair_callsign: 'v3-duplicate-pair-callsign',
      duplicate_callsign: 'v3-duplicate-callsign',
      missing_voice: 'v3-missing-audio-field',
      missing_language: 'v3-missing-audio-field',
      missing_callsign: 'v3-missing-audio-field',
    };
    for (const iss of v3CallsignCheck.issues) {
      issues.push({
        code: codeByKind[iss.kind] || `v3-${iss.kind}`,
        kind: iss.kind,
        registration: iss.registration || null,
        callSign: iss.callSign || null,
        voice: iss.voice || null,
        language: iss.language || null,
        direction: iss.direction || null,
        ...(iss.compatibleCaptainVoices ? { compatibleCaptainVoices: iss.compatibleCaptainVoices } : {}),
        ...(iss.missingAtcVoices ? { missingAtcVoices: iss.missingAtcVoices } : {}),
        ...(iss.missingResources ? { missingResources: iss.missingResources } : {}),
        msg: iss.message || formatCallsignAllocationIssue(iss),
      });
    }
  }

  return { issues, messages: issues.map(i => i.msg) };
}

function _readVoiceLanguagesForRoot(root) {
  const out = {};
  if (!root) return out;
  try {
    const p = gamePaths.voiceCatalogPath(root);
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const v of (json.voices || [])) {
      if (v && v.name) out[v.name] = v.language || '';
    }
  } catch (_) {}
  return out;
}

function _readAirlineCountriesForRoot(root) {
  const out = {};
  if (!root) return out;
  try {
    const p = gamePaths.airlineCountryRegistryPath(root);
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z]{2})\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const country = m[1].toUpperCase();
      for (const raw of m[2].split(',')) {
        const code = raw.trim().toUpperCase();
        if (code) out[code] = country;
      }
    }
  } catch (_) {}
  return out;
}

function persistGcFailArtifact(aclPath, {
  base = path.basename(aclPath, '.acl'),
  seed = null,
  filteredIssues = [],
  allIssues = [],
  gcA = null,
  debugDir = path.join(__dirname, '..', '_debug'),
} = {}) {
  if (debugDir === false) return null;
  try {
    const targetDir = debugDir || path.join(__dirname, '..', '_debug');
    fs.mkdirSync(targetDir, { recursive: true });
    const aclOut = path.join(targetDir, `fuzz-gc-fail-${base}.acl`);
    const jsonOut = path.join(targetDir, `fuzz-gc-fail-${base}.json`);
    fs.copyFileSync(aclPath, aclOut);
    const detail = {
      seed,
      issues: filteredIssues,
      allIssues,
      config: gcA?.config || null,
      docked: gcA?.frameDocked || [],
      doc0Plans: gcA?.doc0Plans || [],
      v3CallsignCheck: gcA?.v3CallsignCheck || null,
    };
    fs.writeFileSync(jsonOut, JSON.stringify(detail, null, 2), 'utf-8');
    return { aclOut, jsonOut };
  } catch (_) {
    return null;
  }
}

/**
 * Flight Fuzz `--replace` safety gate: verifies audio capability flags and
 * decoded game-compatibility invariants (including v3 callsign/voice clips
 * against the destination install's audio data) BEFORE copying `.acl`,
 * `.acl.bak`, or `flight_schedule_<level>.csv`.
 */
function verifyAndCopyReplacedLevel(tmpAclPath, opts = {}) {
  const baseTmpDir = opts.tmpDir || process.env.E2E_TMP_DIR;
  const gameRoot = opts.gameRoot || process.env.E2E_GAME_ROOT;
  if (!gameRoot) throw new Error('FUZZ_REPLACE requires E2E_GAME_ROOT to be set');
  if (!baseTmpDir) throw new Error('FUZZ_REPLACE requires E2E_TMP_DIR to be set');

  const rel = path.relative(baseTmpDir, tmpAclPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`sandbox file outside E2E_TMP_DIR, refusing to map: ${tmpAclPath}`);
  }
  const dest = path.join(gameRoot, rel);
  const bakSrc = tmpAclPath + '.bak';
  if (!fs.existsSync(bakSrc)) throw new Error(`no .acl.bak to copy: ${bakSrc}`);
  if (!fs.existsSync(dest)) {
    throw new Error(`destination missing (is this level installed in E2E_GAME_ROOT?): ${dest}`);
  }

  const icao = gamePaths.airportIcaoFromLevelPath(dest)
    || path.basename(path.dirname(path.dirname(tmpAclPath)));
  const baseName = path.basename(tmpAclPath, '.acl');
  const isV3 = peekAclFormat(tmpAclPath) === 'gatcarc4-v3' || peekAclFormat(dest) === 'gatcarc4-v3';

  if (isV3) {
    const destCap = verifyV3AudioCapabilities({
      targetRoot: gameRoot,
      icao,
      sourceRoot: gameRoot,
      requireUsable: false,
    });
    if (destCap.sourceShipsV3Audio && !destCap.ok) {
      throw new Error(`[replace-gate] withholding replacement for ${baseName}: ${destCap.message}`);
    }
    const stagedCap = verifyV3AudioCapabilities({
      targetRoot: baseTmpDir,
      icao,
      sourceRoot: gameRoot,
      requireUsable: Boolean(destCap.sourceShipsV3Audio),
    });
    if (!stagedCap.ok) {
      throw new Error(`[replace-gate] withholding replacement for ${baseName} (staged sandbox incomplete): ${stagedCap.message}`);
    }

    const gcA = analyzeAclFile(tmpAclPath, {
      gameRoot,
      airportIcao: icao,
      requireV3Audio: Boolean(destCap.sourceShipsV3Audio),
    });
    const gc = runChecks(gcA, {
      voiceLanguages: _readVoiceLanguagesForRoot(gameRoot),
      airlineCountries: _readAirlineCountriesForRoot(gameRoot),
      gameRoot,
      airportIcao: icao,
      requireV3Audio: Boolean(destCap.sourceShipsV3Audio),
    });
    const blockingIssues = gc.issues.filter((i) => !['docked-stand-before-offblock'].includes(i.code));
    if (blockingIssues.length > 0) {
      const artifact = persistGcFailArtifact(tmpAclPath, {
        base: baseName,
        seed: opts.seed ?? null,
        filteredIssues: blockingIssues,
        allIssues: gc.issues,
        gcA,
        debugDir: opts.debugDir,
      });
      const err = new Error(
        `[replace-gate] withholding replacement for ${baseName}: ` +
        blockingIssues.map((i) => `[${i.code}] ${i.msg}`).join(' | '),
      );
      err.issues = blockingIssues;
      err.artifact = artifact;
      throw err;
    }
  }

  fs.copyFileSync(tmpAclPath, dest);
  fs.copyFileSync(bakSrc, dest + '.bak');

  let bgCopied = null;
  if (opts.syncBgSidecar) {
    const bgSrc = tmpAclPath + '.bg.json';
    const bgDest = dest + '.bg.json';
    if (fs.existsSync(bgSrc)) {
      fs.copyFileSync(bgSrc, bgDest);
      bgCopied = bgDest;
    } else if (fs.existsSync(bgDest)) {
      fs.unlinkSync(bgDest);
    }
  }

  const levelSuffix = baseName.startsWith(icao + '_') ? baseName.slice(icao.length + 1) : baseName;
  const csvSrc = path.join(path.dirname(tmpAclPath), 'flight_schedule_' + levelSuffix + '.csv');
  let csvCopied = null;
  if (fs.existsSync(csvSrc)) {
    const csvDest = path.join(path.dirname(dest), path.basename(csvSrc));
    fs.copyFileSync(csvSrc, csvDest);
    if (fs.existsSync(csvSrc + '.bak')) fs.copyFileSync(csvSrc + '.bak', csvDest + '.bak');
    csvCopied = csvDest;
  }

  return { dest, bakDest: dest + '.bak', bgDest: bgCopied, csvDest: csvCopied };
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
  analyzeV3,
  analyzeAclFile,
  runChecks,
  persistGcFailArtifact,
  verifyAndCopyReplacedLevel,
};
