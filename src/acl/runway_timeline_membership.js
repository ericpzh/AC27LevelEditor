'use strict';

/**
 * Pure v3 Runway Timeline Membership Check (`src/acl/runway_timeline_membership.js`).
 *
 * Mirrors the effective game startup contract in:
 *   - `RunwayTimelineService.LoadLevel` -> `RunwayTimelineData.TryValidateTransitions`
 *   - `FlightPlanSessionValidator.ValidateRunways`
 *
 * Rule summary:
 *   1. When `runwayTimeline == null` (no timeline metadata present), membership
 *      is not enforced (`enforced: false`), matching `ValidateRunways`'s
 *      `if (timeline == null) return;`.
 *   2. Otherwise (`enforced: true`), the initial active set starts from
 *      `initialRunways` (non-empty trimmed strings). Chronological timeline
 *      frames are swept in order; a frame's transitions are valid when each
 *      change has non-empty `source` and `dest`, no duplicate `source` within
 *      the frame, no overlap between the frame's `sources` and `dests`, and
 *      every `source` is currently in `active`. Valid changes transition
 *      `active = (active \ sources) ∪ dests` and add `dest` to `members`.
 *      Invalid/unactivated changes are recorded in `invalidChanges` and never
 *      grant membership to unactivated runways.
 *   3. Every persisted flight leg (both arrival and departure legs when a plan
 *      contains both) must reference a runway in `members`.
 *   4. This check is separate from and complements the arrival-at-landing
 *      active-set check (and its 10-minute transition grace); departures have
 *      no off-block/takeoff active-at-time check.
 */

function _parseTimeSec(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).trim().split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = parts.length >= 3 ? Number(parts[2]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  return h * 3600 + m * 60 + s;
}

/**
 * Compute the set of valid runway designators appearing in a level's runway timeline.
 *
 * @param {object|null|undefined} runwayTimeline
 * @returns {{
 *   enforced: boolean,
 *   initialRunways: string[],
 *   members: Set<string>,
 *   finalActiveSet: Set<string>,
 *   invalidChanges: Array<{ frameIndex: number, time: string, source: string, dest: string, reason: string }>
 * }}
 */
function collectRunwayTimelineMembers(runwayTimeline) {
  if (runwayTimeline == null || typeof runwayTimeline !== 'object') {
    return {
      enforced: false,
      initialRunways: [],
      members: new Set(),
      finalActiveSet: new Set(),
      invalidChanges: [],
    };
  }

  const rawInitial = Array.isArray(runwayTimeline.initialRunways)
    ? runwayTimeline.initialRunways
    : (Array.isArray(runwayTimeline.InitialRunways) ? runwayTimeline.InitialRunways : []);
  const initialRunways = [];
  const seenInit = new Set();
  for (const r of rawInitial) {
    const trimmed = String(r ?? '').trim();
    if (trimmed && !seenInit.has(trimmed)) {
      seenInit.add(trimmed);
      initialRunways.push(trimmed);
    }
  }

  const active = new Set(initialRunways);
  const members = new Set(initialRunways);
  const invalidChanges = [];

  const rawFrames = Array.isArray(runwayTimeline.timeline)
    ? runwayTimeline.timeline
    : (Array.isArray(runwayTimeline.Timeline) ? runwayTimeline.Timeline : []);

  const indexedFrames = rawFrames.map((frame, idx) => {
    const time = String(frame?.time ?? frame?.Time ?? '').trim();
    const sec = _parseTimeSec(time);
    return { frame, idx, time, sec };
  });

  indexedFrames.sort((a, b) => {
    const sa = a.sec == null ? Number.POSITIVE_INFINITY : a.sec;
    const sb = b.sec == null ? Number.POSITIVE_INFINITY : b.sec;
    if (sa !== sb) return sa - sb;
    return a.idx - b.idx;
  });

  for (const { frame, idx: frameIndex, time } of indexedFrames) {
    const rawChanges = Array.isArray(frame?.changes)
      ? frame.changes
      : (Array.isArray(frame?.Changes) ? frame.Changes : []);
    if (rawChanges.length === 0) continue;

    const frameSources = new Set();
    const frameDests = new Set();
    const parsedChanges = [];

    for (const ch of rawChanges) {
      const source = String(ch?.source ?? ch?.Source ?? '').trim();
      const dest = String(ch?.dest ?? ch?.Dest ?? '').trim();
      if (!source || !dest) {
        invalidChanges.push({ frameIndex, time, source, dest, reason: 'empty_endpoint' });
        continue;
      }
      parsedChanges.push({ source, dest });
      frameDests.add(dest);
    }

    const toRemove = [];
    const toAdd = [];
    for (const { source, dest } of parsedChanges) {
      if (frameSources.has(source)) {
        invalidChanges.push({ frameIndex, time, source, dest, reason: 'duplicate_source' });
        continue;
      }
      frameSources.add(source);

      if (frameDests.has(source)) {
        invalidChanges.push({ frameIndex, time, source, dest, reason: 'source_dest_overlap' });
        continue;
      }

      if (!active.has(source)) {
        invalidChanges.push({ frameIndex, time, source, dest, reason: 'source_not_active' });
        continue;
      }

      toRemove.push(source);
      toAdd.push(dest);
    }

    for (const r of toRemove) active.delete(r);
    for (const r of toAdd) {
      active.add(r);
      members.add(r);
    }
  }

  return {
    enforced: true,
    initialRunways,
    members,
    finalActiveSet: active,
    invalidChanges,
  };
}

function _extractLegsFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return [];

  // 1. Explicit dual-leg static plan / normalized descriptor:
  //    { registration/Registration, arrival/InitialArrival, departure/InitialDeparture }
  const hasExplicitLegs = (
    'InitialArrival' in entry ||
    'InitialDeparture' in entry ||
    'arrival' in entry ||
    'departure' in entry
  );
  if (hasExplicitLegs) {
    const registration = String(entry.Registration ?? entry.registration ?? entry._Registration ?? '').trim();
    const legs = [];
    const arr = entry.InitialArrival || entry.arrival || null;
    const dep = entry.InitialDeparture || entry.departure || null;
    if (arr && typeof arr === 'object') {
      legs.push({
        registration,
        callsign: String(arr.CallSign ?? arr.Callsign ?? arr.callsign ?? '').trim(),
        direction: 'arrival',
        runway: String(arr.Runway ?? arr.runway ?? '').trim(),
      });
    }
    if (dep && typeof dep === 'object') {
      legs.push({
        registration,
        callsign: String(dep.CallSign ?? dep.Callsign ?? dep.callsign ?? '').trim(),
        direction: 'departure',
        runway: String(dep.Runway ?? dep.runway ?? '').trim(),
      });
    }
    return legs;
  }

  // 2. Editor / MCP single-leg flight row
  const registration = String(entry.Registration || entry._Registration || '').trim();
  const callsign = String(entry.CallSign || entry.callsign || '').trim();
  const runway = String(entry.Runway ?? entry.runway ?? '').trim();
  const hasLandingTime = Boolean(String(entry.LandingTime || '').trim());
  const hasOffBlockTime = Boolean(String(entry.OffBlockTime || '').trim());
  let direction;
  if (hasLandingTime) direction = 'arrival';
  else if (hasOffBlockTime) direction = 'departure';
  else if (typeof entry.isDeparture === 'boolean') direction = entry.isDeparture ? 'departure' : 'arrival';
  else direction = 'departure';

  return [{ registration, callsign, direction, runway }];
}

/**
 * Validate flight or plan legs against a level's runway timeline membership set.
 *
 * @param {Array<object>} flightsOrPlans
 * @param {object|null|undefined} runwayTimeline
 * @param {{ skipEmptyRunway?: boolean }} [opts]
 * @returns {{
 *   enforced: boolean,
 *   timelineRunways: string[],
 *   invalidChanges: Array<object>,
 *   issues: Array<{
 *     index: number,
 *     registration: string,
 *     callsign: string,
 *     direction: 'arrival'|'departure',
 *     runway: string,
 *     timelineRunways: string[]
 *   }>
 * }}
 */
function validateFlightRunwayTimelineMembership(flightsOrPlans, runwayTimeline, opts = {}) {
  const skipEmptyRunway = Boolean(opts && opts.skipEmptyRunway);
  const membership = collectRunwayTimelineMembers(runwayTimeline);
  const timelineRunways = [...membership.members];

  if (!membership.enforced) {
    return {
      enforced: false,
      timelineRunways,
      invalidChanges: membership.invalidChanges,
      issues: [],
    };
  }

  const issues = [];
  const items = Array.isArray(flightsOrPlans) ? flightsOrPlans : [];
  for (let i = 0; i < items.length; i++) {
    const legs = _extractLegsFromEntry(items[i]);
    for (const leg of legs) {
      if (!leg.runway && skipEmptyRunway) continue;
      if (!membership.members.has(leg.runway)) {
        issues.push({
          index: i,
          registration: leg.registration,
          callsign: leg.callsign,
          direction: leg.direction,
          runway: leg.runway,
          timelineRunways,
        });
      }
    }
  }

  return {
    enforced: true,
    timelineRunways,
    invalidChanges: membership.invalidChanges,
    issues,
  };
}

/**
 * Format a concise English diagnostic for one membership issue (used by MCP,
 * write-boundary errors, and decoded-output gamecompat checks).
 */
function formatRunwayTimelineMembershipIssue(issue) {
  const who = issue.callsign && issue.registration
    ? `${issue.callsign} (${issue.registration})`
    : (issue.callsign || issue.registration || `Flight #${(issue.index ?? 0) + 1}`);
  const dirLabel = issue.direction === 'arrival' ? 'arrival' : 'departure';
  const tlList = Array.isArray(issue.timelineRunways) && issue.timelineRunways.length > 0
    ? issue.timelineRunways.join(', ')
    : 'none';
  return `${who}: ${dirLabel} runway "${issue.runway || '(empty)'}" does not appear in the level runway timeline (timeline runways: ${tlList}). Edit the flight runway assignment or add/activate "${issue.runway || ''}" in the Runway Timeline.`;
}

module.exports = {
  collectRunwayTimelineMembers,
  validateFlightRunwayTimelineMembership,
  formatRunwayTimelineMembershipIssue,
};
