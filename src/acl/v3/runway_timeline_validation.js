'use strict';

/**
 * Candidate-archive v3 Runway Timeline Membership Validation
 * (`src/acl/v3/runway_timeline_validation.js`).
 *
 * Inspects a decoded/mutated v3 container's `metaData.RunwayTimeline` and
 * every `flight-plan:*` in `staticData.StaticItems` (`InitialArrival` and
 * `InitialDeparture` legs) at the write boundary before committing to disk.
 */

const { TARGET_SCHEMA_HASH, getSchemaForHash } = require('./schema_registry');
const { dictEntries, indexDocumentGraph, resolveGraphNode } = require('./graph');
const {
  validateFlightRunwayTimelineMembership,
  formatRunwayTimelineMembershipIssue,
} = require('../runway_timeline_membership');

class RunwayTimelineMembershipError extends Error {
  constructor(message, { issues = [], timelineRunways = [] } = {}) {
    super(message);
    this.name = 'RunwayTimelineMembershipError';
    this.code = 'V3_RUNWAY_TIMELINE_MEMBERSHIP';
    this.issues = issues;
    this.timelineRunways = timelineRunways;
  }
}

/**
 * Extract normalized static flight plans (preserving both `InitialArrival` and
 * `InitialDeparture` legs if both exist on a single `FlightPlanStaticItem`).
 */
function extractV3StaticPlansForTimeline(container, schema = null) {
  const siDict = container?.staticData?.StaticItems;
  if (!siDict) return [];
  const effectiveSchema = (schema && typeof schema.getType === 'function')
    ? schema
    : getSchemaForHash(container?.header?.schemaHash || TARGET_SCHEMA_HASH);
  const g = indexDocumentGraph(
    container.staticData,
    'ContextCross.Saves.StaticField',
    effectiveSchema,
  );

  const plans = [];
  for (const [pk, rawVal] of dictEntries(siDict)) {
    if (!pk.startsWith('flight-plan:')) continue;
    const item = resolveGraphNode(rawVal, g);
    if (!item || typeof item !== 'object') continue;
    const arrLeg = item.InitialArrival ? resolveGraphNode(item.InitialArrival, g) : null;
    const depLeg = item.InitialDeparture ? resolveGraphNode(item.InitialDeparture, g) : null;
    if (!arrLeg && !depLeg) continue;
    plans.push({
      pk,
      Registration: String(item.Registration || pk.slice('flight-plan:'.length) || '').trim(),
      InitialArrival: arrLeg
        ? {
            CallSign: String(arrLeg.CallSign || '').trim(),
            Runway: String(arrLeg.Runway || '').trim(),
          }
        : null,
      InitialDeparture: depLeg
        ? {
            CallSign: String(depLeg.CallSign || '').trim(),
            Runway: String(depLeg.Runway || '').trim(),
          }
        : null,
    });
  }
  return plans;
}

/**
 * Validate a candidate v3 container's static flight plans against its
 * `metaData.RunwayTimeline`.
 *
 * @param {object} container
 * @param {object|null} [schema]
 * @param {{ throwOnError?: boolean }} [opts]
 */
function validateV3ContainerRunwayTimelineMembership(container, schema = null, opts = {}) {
  let effectiveSchema = schema;
  let effectiveOpts = opts;
  if (schema && typeof schema === 'object' && typeof schema.getType !== 'function' && 'throwOnError' in schema) {
    effectiveSchema = null;
    effectiveOpts = schema;
  }
  const throwOnError = effectiveOpts?.throwOnError !== false;
  const runwayTimeline = container?.metaData?.RunwayTimeline ?? null;
  const plans = extractV3StaticPlansForTimeline(container, effectiveSchema);
  const res = validateFlightRunwayTimelineMembership(plans, runwayTimeline, {
    skipEmptyRunway: false,
  });

  if (res.issues.length > 0 && throwOnError) {
    const preview = res.issues
      .slice(0, 5)
      .map((iss) => formatRunwayTimelineMembershipIssue(iss))
      .join(' | ');
    const more = res.issues.length > 5 ? ` (+${res.issues.length - 5} more)` : '';
    throw new RunwayTimelineMembershipError(
      `Cannot save v3 level — ${res.issues.length} flight leg(s) reference runway(s) absent from MetaData.RunwayTimeline: ${preview}${more}`,
      { issues: res.issues, timelineRunways: res.timelineRunways },
    );
  }

  return {
    ok: res.issues.length === 0,
    enforced: res.enforced,
    timelineRunways: res.timelineRunways,
    invalidChanges: res.invalidChanges,
    issues: res.issues,
  };
}

module.exports = {
  RunwayTimelineMembershipError,
  extractV3StaticPlansForTimeline,
  validateV3ContainerRunwayTimelineMembership,
};
