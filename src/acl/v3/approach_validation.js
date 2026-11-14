'use strict';

/**
 * Candidate-archive v3 Arrival Approach Route Validation
 * (`src/acl/v3/approach_validation.js`).
 *
 * Verifies directly against the candidate `staticData` graph (never cached
 * routes from other levels) that every persisted arrival flight plan
 * (`flight-plan:*` with non-null `InitialArrival`) resolves:
 *   1. Its target `runway:<Runway>` in `PKStaticEntities`,
 *   2. Its assigned `STAR` (`RouteType === 0`) on that runway with a usable
 *      node sequence (`>= 2` resolved `AirwayNode`s with distinct finite XZ
 *      positions), and
 *   3. At least one usable `RouteType === 1` (`APP`) approach route on that
 *      runway's rebuilt `Routes` (`>= 2` resolved `AirwayNode`s with distinct
 *      finite XZ positions).
 *
 * Mirrors `RuntimeAircraftSpawnService.SpawnFlyApproachingAircraft` ->
 * `AirwayRouteService.GetRoute(runway, RouteType.APP, lastStarPos)`.
 * Departure-only runways (with zero remaining arrivals) remain valid even
 * without approach routes.
 */

const { decodePosition3ToGu } = require('./q32');
const { TARGET_SCHEMA_HASH, getSchemaForHash } = require('./schema_registry');
const {
  dictEntries,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapTypedArray,
} = require('./graph');

const COORD_EPS_GU = 1e-6;

class ApproachValidationError extends Error {
  constructor(message, { issues = [], affectedRunways = [] } = {}) {
    super(message);
    this.name = 'ApproachValidationError';
    this.code = 'V3_MISSING_APPROACH_ROUTE';
    this.issues = issues;
    this.affectedRunways = affectedRunways;
  }
}

function _resolveUsableAirwayPoints(rawAirwayRefs, g) {
  const refs = unwrapTypedArray(rawAirwayRefs, g) || [];
  const rawPoints = [];
  for (const ref of refs) {
    const node = resolveGraphNode(ref, g);
    if (!node || typeof node !== 'object' || !node.Position) continue;
    const pos = decodePosition3ToGu(node.Position);
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) continue;
    rawPoints.push({ x: pos.x, y: pos.y || 0, z: pos.z, name: String(node.Name || '') });
  }
  const distinctConsecutive = [];
  for (const pt of rawPoints) {
    const prev = distinctConsecutive[distinctConsecutive.length - 1];
    if (prev && Math.hypot(pt.x - prev.x, pt.z - prev.z) <= COORD_EPS_GU) continue;
    distinctConsecutive.push(pt);
  }
  return {
    refCount: refs.length,
    resolvedCount: rawPoints.length,
    usablePoints: distinctConsecutive,
    isUsable: distinctConsecutive.length >= 2,
  };
}

function _normalizeRunway(name) {
  if (!name) return '';
  return String(name).trim().replace(/^0+(\d)/, '$1');
}

/**
 * Inspect all `runway:*` entities in `staticData.PKStaticEntities` and classify
 * their STAR (`RouteType === 0`) and APP (`RouteType === 1`) routes directly
 * from the candidate graph.
 */
function inspectV3RunwayApproachSupport(staticData, schema = null) {
  const runways = new Map(); // exactName -> info
  const runwaysByNorm = new Map(); // normalizedName -> info

  if (!staticData || !staticData.PKStaticEntities) {
    return {
      runways,
      runwaysByNorm,
      usableApproachRunways: [],
    };
  }

  const resolvedSchema = schema && typeof schema.getType === 'function'
    ? schema
    : getSchemaForHash(schema?.header?.schemaHash || TARGET_SCHEMA_HASH);

  const g = indexDocumentGraph(
    staticData,
    'ContextCross.Saves.StaticField',
    resolvedSchema,
  );

  for (const [pk, rawVal] of dictEntries(staticData.PKStaticEntities)) {
    if (!pk.startsWith('runway:')) continue;
    const rw = resolveGraphNode(rawVal, g);
    if (!rw || typeof rw !== 'object') continue;
    const runwayName = String(rw.Name || pk.slice('runway:'.length) || '').trim();
    if (!runwayName) continue;

    const usableStars = new Map(); // starName -> usablePoints
    const brokenStars = new Map(); // starName -> { refCount, resolvedCount, usableCount }
    const usableApproaches = []; // [{ name, points }]
    const brokenApproaches = []; // [{ name, refCount, resolvedCount, usableCount }]

    const routes = unwrapTypedArray(rw.Routes, g) || [];
    for (const rawRoute of routes) {
      const route = resolveGraphNode(rawRoute, g);
      if (!route || typeof route !== 'object') continue;
      const rType = Number(route.RouteType);
      const rName = String(route.Name || '').trim();
      const check = _resolveUsableAirwayPoints(route.AirwayNodes, g);

      if (rType === 0) {
        if (!rName) continue;
        if (check.isUsable) {
          usableStars.set(rName, check.usablePoints);
        } else if (!usableStars.has(rName)) {
          brokenStars.set(rName, {
            refCount: check.refCount,
            resolvedCount: check.resolvedCount,
            usableCount: check.usablePoints.length,
          });
        }
      } else if (rType === 1) {
        if (check.isUsable) {
          usableApproaches.push({ name: rName, points: check.usablePoints });
        } else {
          brokenApproaches.push({
            name: rName,
            refCount: check.refCount,
            resolvedCount: check.resolvedCount,
            usableCount: check.usablePoints.length,
          });
        }
      }
    }

    const info = {
      pk,
      runwayName,
      usableStars,
      brokenStars,
      usableApproaches,
      brokenApproaches,
    };
    runways.set(runwayName, info);
    const norm = _normalizeRunway(runwayName);
    if (norm && !runwaysByNorm.has(norm)) runwaysByNorm.set(norm, info);
  }

  const usableApproachRunways = [...runways.values()]
    .filter((info) => info.usableApproaches.length > 0)
    .map((info) => info.runwayName)
    .sort((a, b) => a.localeCompare(b));

  return {
    runways,
    runwaysByNorm,
    usableApproachRunways,
    staticGraph: g,
  };
}

function formatApproachValidationIssue(issue) {
  const who = issue.callsign && issue.registration
    ? `${issue.callsign} (${issue.registration})`
    : (issue.callsign || issue.registration || issue.pk || 'Arrival');
  if (issue.reason === 'missing_runway') {
    return `${who}: arrival runway "${issue.runway || '(empty)'}" does not exist in PKStaticEntities`;
  }
  if (issue.reason === 'broken_star') {
    return `${who}: arrival STAR "${issue.star || '(empty)'}" on runway "${issue.runway}" has fewer than 2 distinct resolved airway nodes`;
  }
  if (issue.reason === 'missing_star') {
    return `${who}: arrival STAR "${issue.star || '(empty)'}" is missing on runway "${issue.runway}"`;
  }
  if (issue.reason === 'broken_approach') {
    return `${who}: arrival runway "${issue.runway}" (STAR "${issue.star}") has no usable RouteType=1 approach route (>= 2 distinct airway nodes required)`;
  }
  return `${who}: arrival runway "${issue.runway}" (STAR "${issue.star}") has no RouteType=1 (APPR) approach route`;
}

/**
 * Validate that every remaining arrival flight plan in `staticData.StaticItems`
 * resolves its runway, STAR (`RouteType = 0`), and at least one usable
 * `RouteType = 1` (`APP`) approach route on that runway in the candidate graph.
 *
 * @param {object} staticData
 * @param {object|null} [schemaOrContainer] - schema object (or container with header.schemaHash)
 * @param {{ throwOnError?: boolean }} [opts]
 */
function validateV3ApproachRoutes(staticData, schema = null, opts = {}) {
  let rawSchema = schema;
  let effectiveOpts = opts;
  if (schema && typeof schema === 'object' && typeof schema.getType !== 'function' && !schema.header && 'throwOnError' in schema) {
    rawSchema = null;
    effectiveOpts = schema;
  }
  const throwOnError = effectiveOpts?.throwOnError !== false;
  if (!staticData || !staticData.StaticItems) {
    return { ok: true, issues: [], affectedRunways: [], usableApproachRunways: [] };
  }

  const effectiveSchema = rawSchema && typeof rawSchema.getType === 'function'
    ? rawSchema
    : getSchemaForHash(rawSchema?.header?.schemaHash || TARGET_SCHEMA_HASH);

  const support = inspectV3RunwayApproachSupport(staticData, effectiveSchema);
  const g = support.staticGraph || indexDocumentGraph(
    staticData,
    'ContextCross.Saves.StaticField',
    effectiveSchema,
  );

  const issues = [];
  const byRunway = new Map(); // runway -> { runway, reasons: Set, flights: [] }

  for (const [pk, rawVal] of dictEntries(staticData.StaticItems)) {
    if (!pk.startsWith('flight-plan:')) continue;
    const item = resolveGraphNode(rawVal, g);
    if (!item || typeof item !== 'object') continue;
    const arrLeg = item.InitialArrival ? resolveGraphNode(item.InitialArrival, g) : null;
    if (!arrLeg || typeof arrLeg !== 'object') continue;

    const registration = String(item.Registration || pk.slice('flight-plan:'.length) || '').trim();
    const callsign = String(arrLeg.CallSign || '').trim();
    const runway = String(arrLeg.Runway || '').trim();
    const star = String(arrLeg.STAR || '').trim();

    const rwInfo = support.runways.get(runway)
      || support.runwaysByNorm.get(_normalizeRunway(runway))
      || null;

    let reason = null;
    if (!rwInfo) {
      reason = 'missing_runway';
    } else if (!star || !rwInfo.usableStars.has(star)) {
      reason = rwInfo.brokenStars.has(star) ? 'broken_star' : 'missing_star';
    } else if (rwInfo.usableApproaches.length === 0) {
      reason = rwInfo.brokenApproaches.length > 0 ? 'broken_approach' : 'missing_approach';
    }

    if (reason) {
      const issue = {
        pk,
        registration,
        callsign,
        runway,
        star,
        reason,
        usableApproachCount: rwInfo ? rwInfo.usableApproaches.length : 0,
        brokenApproachRoutes: rwInfo ? rwInfo.brokenApproaches.map((b) => b.name || '(unnamed)') : [],
      };
      issue.message = formatApproachValidationIssue(issue);
      issues.push(issue);

      const rKey = runway || '(empty)';
      if (!byRunway.has(rKey)) {
        byRunway.set(rKey, { runway: rKey, reasons: new Set(), flights: [] });
      }
      const entry = byRunway.get(rKey);
      entry.reasons.add(reason);
      entry.flights.push(callsign ? `${callsign} (${registration})` : registration);
    }
  }

  const affectedRunways = [...byRunway.values()].map((e) => ({
    runway: e.runway,
    reasons: [...e.reasons],
    flights: e.flights,
  }));

  if (issues.length > 0 && throwOnError) {
    const summaries = affectedRunways.map((ar) => {
      const flightPreview = ar.flights.slice(0, 6).join(', ')
        + (ar.flights.length > 6 ? ` (+${ar.flights.length - 6} more)` : '');
      let problemDesc;
      if (ar.reasons.includes('missing_runway')) {
        problemDesc = `runway "${ar.runway}" does not exist in PKStaticEntities`;
      } else if (ar.reasons.includes('missing_star') || ar.reasons.includes('broken_star')) {
        problemDesc = `runway "${ar.runway}" is missing a usable STAR route (RouteType = 0, >= 2 distinct airway nodes)`;
      } else if (ar.reasons.includes('broken_approach')) {
        problemDesc = `runway "${ar.runway}" has no usable approach route (RouteType = 1 requires >= 2 distinct resolved airway nodes)`;
      } else {
        problemDesc = `runway "${ar.runway}" has no approach route (RouteType = 1 / APPR)`;
      }
      return `${problemDesc} — ${ar.flights.length} affected arrival flight(s): ${flightPreview}`;
    });
    throw new ApproachValidationError(
      `Cannot save v3 level — ${summaries.join('; ')}. Restore a usable APPR approach procedure (>= 2 fixes) on the runway or reassign/remove the affected arrival flight(s).`,
      { issues, affectedRunways },
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    affectedRunways,
    usableApproachRunways: support.usableApproachRunways,
  };
}

module.exports = {
  ApproachValidationError,
  formatApproachValidationIssue,
  inspectV3RunwayApproachSupport,
  validateV3ApproachRoutes,
};
