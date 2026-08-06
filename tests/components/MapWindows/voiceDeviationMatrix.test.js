import { describe, it, expect } from 'vitest';
import { parseVoiceTranscript } from '../../../src/components/MapWindows/voiceTranscriptParser';

/**
 * Human-language deviation matrix for the voice pipeline.
 *
 * The classifier is a fixed grammar — any small deviation in the spoken
 * transcript can break a parse. This file locks the behavior for every
 * reasonable deviation we might encounter: each row asserts the FULL
 * outcome (ok / callsign / command types / labels / notices / reason),
 * so a change in any stage of the pipeline fails a row.
 *
 * Rows whose name ends with "(limitation)" document cases the classifier
 * deliberately does NOT support — they must keep failing, with a reason
 * naming the stage that stopped the parse.
 */

// ─── Fixtures ──────────────────────────────────────────────────────────

const ac = (callSign) => ({
  callSign,
  controlSeat: 5,
  position: { x: 0, y: 0, z: 0 },
  noseDirection: { x: 0, y: 0, z: 1 },
  airSpeedKnot: 200,
});

const AIRCRAFT = [
  ac('DAL3401'), ac('DAL304'), ac('DLH3401'),
  ac('UAL1111'), ac('UAL111'),
  ac('CCA1234'), ac('CCA1100'),
  ac('CES5888'), ac('CSC6918'),
  ac('CSN2888'), ac('CHH1234'),
  ac('KLM631'), ac('BAW5224'), ac('AFR3661'), ac('AAL683'),
];

const types = (r) => r.commands.map(c => c.type);
const labels = (r) => r.commands.map(c => c.label);

// ─── Table-driven runner ───────────────────────────────────────────────

/**
 * Each row:
 *   name          — test title
 *   input         — raw transcript
 *   aircraft      — optional override of the aircraft list
 *   ok            — expected ok flag (default true)
 *   callsign      — expected callsign when ok
 *   commandTypes  — expected command types (default [])
 *   commandLabels — expected labels for those commands
 *   noticeIncl    — substring that must appear in some notice
 *   reasonIncl    — substring that must appear in reason (failure rows)
 */
function runRow(r) {
  const result = parseVoiceTranscript(r.input, r.aircraft || AIRCRAFT);
  if (r.ok === false) {
    expect(result.ok, `expected ok=false for "${r.input}"`).toBe(false);
    expect(result.callsign).toBeNull();
    expect(result.commands).toEqual([]);
    expect(result.reason && result.reason.length).toBeGreaterThan(0);
    if (r.reasonIncl) expect(result.reason).toContain(r.reasonIncl);
    return;
  }
  expect(result.ok, `expected ok=true for "${r.input}"`).toBe(true);
  expect(result.callsign).toBe(r.callsign);
  expect(types(result)).toEqual(r.commandTypes || []);
  if (r.commandLabels) expect(labels(result)).toEqual(r.commandLabels);
  if (r.noticeIncl) {
    expect(result.notices.some(n => n.includes(r.noticeIncl)),
      `expected a notice containing "${r.noticeIncl}" for "${r.input}" (got ${JSON.stringify(result.notices)})`
    ).toBe(true);
  }
  if (r.noNotices) expect(result.notices).toEqual([]);
}

const itRow = (rows, group) => {
  describe(group, () => {
    it.each(rows)('$name', runRow);
  });
};

// ─── 1. Airline-name forms ─────────────────────────────────────────────

itRow([
  { name: 'full airline name ("delta air lines 3401")', input: 'delta air lines 3401', callsign: 'DAL3401' },
  { name: 'short name ("delta 3401")', input: 'delta 3401', callsign: 'DAL3401' },
  { name: 'spoken 3-letter code ("DAL 3401")', input: 'DAL 3401', callsign: 'DAL3401' },
  { name: 'typed literal with colon ("DAL3401: turn left heading 360")', input: 'DAL3401: turn left heading 360', callsign: 'DAL3401', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 360'] },
  { name: 'all-caps ("DELTA 3401")', input: 'DELTA 3401', callsign: 'DAL3401' },
  { name: 'lowercase ("delta 3401")', input: 'delta 3401', callsign: 'DAL3401' },
  { name: 'code + spoken digits ("DAL three four zero one")', input: 'DAL three four zero one', callsign: 'DAL3401' },
  { name: 'longest name wins ("air china twelve thirty four")', input: 'air china twelve thirty four', callsign: 'CCA1234' },
  { name: 'multi-word airline ("british airways 5224")', input: 'british airways 5224', callsign: 'BAW5224' },
  { name: 'single-word airline ("klm 631")', input: 'klm 631', callsign: 'KLM631' },
  { name: 'qantas-like single-word name ("air france 3661")', input: 'air france 3661', callsign: 'AFR3661' },
  { name: 'lufthansa is NOT delta ("lufthansa 3401")', input: 'lufthansa 3401', callsign: 'DLH3401' },
  { name: 'airline not in dictionary (easyjet) → fail (limitation)', input: 'easyjet one two three', ok: false, reasonIncl: 'airline' },
  { name: 'airline after the number → fail, word order fixed (limitation)', input: '3401 delta', ok: false, reasonIncl: 'airline' },
  { name: 'airline present but wrong word for the flight (delta vs DLH-only list) → fail naming DAL', input: 'delta 3401', aircraft: [ac('DLH3401')], ok: false, reasonIncl: 'DAL' },
], 'deviation matrix — airline-name forms');

// ─── 2. Flight-number word forms ───────────────────────────────────────

itRow([
  { name: 'digit-by-digit ("delta three four zero one")', input: 'delta three four zero one', callsign: 'DAL3401' },
  { name: '"oh" for zero ("delta three four oh one")', input: 'delta three four oh one', callsign: 'DAL3401' },
  { name: 'bare "o" for zero ("delta three four o one")', input: 'delta three four o one', callsign: 'DAL3401' },
  { name: '"zero" ("delta three four zero one")', input: 'delta three four zero one', callsign: 'DAL3401' },
  { name: 'tens + "o" + ones ("delta thirty four o one")', input: 'delta thirty four o one', callsign: 'DAL3401' },
  { name: 'literal digits ("delta 3401")', input: 'delta 3401', callsign: 'DAL3401' },
  { name: 'literal + words ("delta 34 oh one")', input: 'delta 34 oh one', callsign: 'DAL3401' },
  { name: 'comma-separated words ("delta three, four, o, one")', input: 'delta three, four, o, one', callsign: 'DAL3401' },
  { name: 'disambiguation: "delta three oh four" picks DAL304, not DAL3401', input: 'delta three oh four', callsign: 'DAL304' },
  { name: 'teens ("united eleven eleven")', input: 'united eleven eleven', callsign: 'UAL1111' },
  { name: 'triple shorthand ("united triple one")', input: 'united triple one', callsign: 'UAL111' },
  { name: '"hundred" in a flight number → fail (limitation)', input: 'delta three hundred', ok: false, reasonIncl: 'hundred' },
  { name: 'filler inside the number → fail, reason names the token (limitation)', input: 'delta three uh four oh one', ok: false, reasonIncl: 'uh' },
], 'deviation matrix — flight-number word forms');

// ─── 3. Command aliases: heading ───────────────────────────────────────

itRow([
  { name: '"fly heading 120"', input: 'CSC6918: fly heading 120', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: '"heading 120"', input: 'CSC6918: heading 120', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: '"turn to heading 120"', input: 'CSC6918: turn to heading 120', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: '"turn left heading 120"', input: 'CSC6918: turn left heading 120', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: '"turn right heading 120"', input: 'CSC6918: turn right heading 120', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: '"left heading 120"', input: 'CSC6918: left heading 120', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: '"right heading 120"', input: 'CSC6918: right heading 120', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: '"heading 120 degrees" (unitless unit tolerated)', input: 'CSC6918: heading 120 degrees', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: 'digit words ("fly heading one two zero")', input: 'CSC6918: fly heading one two zero', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: 'bare "o" in a value ("fly heading one eight o")', input: 'CSC6918: fly heading one eight o', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 180'] },
  { name: 'slot value ("fly heading one eighty")', input: 'CSC6918: fly heading one eighty', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 180'] },
  { name: 'tens value ("turn left heading three six zero")', input: 'CSC6918: turn left heading three six zero', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 360'] },
], 'deviation matrix — heading aliases');

// ─── 4. Command aliases: altitude ──────────────────────────────────────

itRow([
  { name: '"climb and maintain 9000"', input: 'CSC6918: climb and maintain 9000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"climb to 9000"', input: 'CSC6918: climb to 9000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"descend and maintain 5000"', input: 'CSC6918: descend and maintain 5000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 5000'] },
  { name: '"descend to 5000"', input: 'CSC6918: descend to 5000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 5000'] },
  { name: '"fly altitude 9000"', input: 'CSC6918: fly altitude 9000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"altitude 9000"', input: 'CSC6918: altitude 9000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"level at 9000"', input: 'CSC6918: level at 9000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"level off at 9000"', input: 'CSC6918: level off at 9000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"level off 9000"', input: 'CSC6918: level off 9000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"maintain 9000" (bare ≥1000 → altitude)', input: 'CSC6918: maintain 9000', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"maintain 9000 feet" (unit wins)', input: 'CSC6918: maintain 9000 feet', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"flight level 90" (×100)', input: 'CSC6918: flight level 90', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '"FL 90" (bare FL)', input: 'CSC6918: FL 90', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: 'words ("climb and maintain nine thousand")', input: 'CSC6918: climb and maintain nine thousand', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: 'unit word ("descend to two thousand feet")', input: 'CSC6918: descend to two thousand feet', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 2000'] },
  { name: '"maintain 180" (bare <1000 → speed)', input: 'CSC6918: maintain 180', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
], 'deviation matrix — altitude aliases');

// ─── 5. Command aliases: speed ─────────────────────────────────────────

itRow([
  { name: '"reduce speed to 180"', input: 'CSC6918: reduce speed to 180', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: '"reduce to 180"', input: 'CSC6918: reduce to 180', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: '"increase speed to 220"', input: 'CSC6918: increase speed to 220', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 220'] },
  { name: '"slow down to 180"', input: 'CSC6918: slow down to 180', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: '"slow to 180"', input: 'CSC6918: slow to 180', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: '"fly speed 180"', input: 'CSC6918: fly speed 180', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: '"speed 180"', input: 'CSC6918: speed 180', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: '"maintain 180 knots" (unit wins)', input: 'CSC6918: maintain 180 knots', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: 'words + unit ("reduce speed to two hundred knots")', input: 'CSC6918: reduce speed to two hundred knots', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 200'] },
  { name: 'slot value ("slow down to one eighty")', input: 'CSC6918: slow down to one eighty', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: 'bare "o" in a value ("reduce speed to one eight o")', input: 'CSC6918: reduce speed to one eight o', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
], 'deviation matrix — speed aliases');

// ─── 6. Command aliases: clear for approach ────────────────────────────

itRow([
  { name: '"clear for approach"', input: 'CSC6918: clear for approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"cleared for approach"', input: 'CSC6918: cleared for approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"clear approach"', input: 'CSC6918: clear approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"cleared approach"', input: 'CSC6918: cleared approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
], 'deviation matrix — cfa aliases');

// ─── 6b. Clear for approach: flexible grammar & runway ─────────────────

itRow([
  { name: '"clear for the ILS approach"', input: 'CSC6918: clear for the ILS approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"cleared for the ils approach" (lowercase type)', input: 'CSC6918: cleared for the ils approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"cleared for ILS approach" (no "the")', input: 'CSC6918: cleared for ILS approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"clear for the rnav approach"', input: 'CSC6918: clear for the rnav approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"clear for the visual approach"', input: 'CSC6918: clear for the visual approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"clear for the approach" (type word optional)', input: 'CSC6918: clear for the approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"clear for the rnav appr" (appr abbreviation)', input: 'CSC6918: clear for the rnav appr', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: 'title case ("CSC6918: Clear For The ILS Approach")', input: 'CSC6918: Clear For The ILS Approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '"cleared for the ILS" (no approach tail) → unsupported (limitation)', input: 'CSC6918: cleared for the ILS', callsign: 'CSC6918', noticeIncl: 'unsupported' },
  { name: '"clear for the rnav appr, runway one three left" (comma segment)', input: 'CSC6918: clear for the rnav appr, runway one three left', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: '"clear for the visual appr runway one three left" (same segment)', input: 'CSC6918: clear for the visual appr runway one three left', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: '"clear for approach, runway 13 left" (typed digits)', input: 'CSC6918: clear for approach, runway 13 left', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: '"clear for the ils approach runway 13L" (attached suffix)', input: 'CSC6918: clear for the ils approach runway 13L', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: '"clear for approach, runway one eight left" (spoken suffix word)', input: 'CSC6918: clear for approach, runway one eight left', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: '"clear for the visual approach, rwy 27 right"', input: 'CSC6918: clear for the visual approach, rwy 27 right', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: '"clear for approach, runway 36" (max valid designator)', input: 'CSC6918: clear for approach, runway 36', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: '"clear for ILS approach runway three" (bare word number)', input: 'CSC6918: clear for ILS approach runway three', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: '"cleared for approach runway 31" (bare typed number)', input: 'CSC6918: cleared for approach runway 31', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: 'chain after runway superseded ("…runway 13 left, turn left heading 360")', input: 'CSC6918: clear for the rnav appr, runway one three left, turn left heading 360', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noNotices: true },
  { name: '"clear for approach, runway banana" (bad designator → unsupported)', input: 'CSC6918: clear for approach, runway banana', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noticeIncl: 'runway banana' },
  { name: '"clear for approach, runway 45" (out of range → unsupported)', input: 'CSC6918: clear for approach, runway 45', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noticeIncl: 'runway 45' },
  { name: '"clear the runway" → unsupported (no approach tail)', input: 'CSC6918: clear the runway', callsign: 'CSC6918', noticeIncl: 'unsupported' },
  { name: '"clear for approach, climb to 3000" (chain after cfa superseded)', input: 'CSC6918: clear for approach, climb to 3000', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: 'ZH: 可以进近，跑道幺三左 → runway unsupported (limitation)', input: '川航六九幺八可以进近，跑道幺三左', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'], noticeIncl: 'unsupported' },
], 'deviation matrix — cfa flexible grammar & runway');

// ─── 7. Chaining & connectors ──────────────────────────────────────────

itRow([
  { name: 'comma chain (the 2026-08-06 utterance)', input: 'delta thirty four o one, turn left heading three six zero, reduce speed to two hundred knots', callsign: 'DAL3401', commandTypes: ['update_heading', 'update_speed'], commandLabels: ['Fly Heading 360', 'Fly Speed 200'] },
  { name: '"and" connector without comma', input: 'CSC6918: turn left heading 360 and reduce speed to 200', callsign: 'CSC6918', commandTypes: ['update_heading', 'update_speed'], commandLabels: ['Fly Heading 360', 'Fly Speed 200'] },
  { name: '"then" connector', input: 'CSC6918: turn left heading 360, then reduce speed to 200', callsign: 'CSC6918', commandTypes: ['update_heading', 'update_speed'], commandLabels: ['Fly Heading 360', 'Fly Speed 200'] },
  { name: '"please" connector', input: 'CSC6918: turn left heading 360, please reduce speed to 200', callsign: 'CSC6918', commandTypes: ['update_heading', 'update_speed'], commandLabels: ['Fly Heading 360', 'Fly Speed 200'] },
  { name: 'filler connector ("and uh reduce speed…")', input: 'CSC6918: climb to 3000 and uh reduce speed to 180', callsign: 'CSC6918', commandTypes: ['altitude', 'update_speed'], commandLabels: ['Fly Altitude 3000', 'Fly Speed 180'] },
  { name: 'Chinese semicolon separator', input: 'CSC6918: turn left heading 360；reduce speed to 200', callsign: 'CSC6918', commandTypes: ['update_heading', 'update_speed'], commandLabels: ['Fly Heading 360', 'Fly Speed 200'] },
  { name: 'Chinese period separator', input: 'CSC6918: turn left heading 360。reduce speed to 200', callsign: 'CSC6918', commandTypes: ['update_heading', 'update_speed'], commandLabels: ['Fly Heading 360', 'Fly Speed 200'] },
  { name: 'cfa supersedes a composed chain', input: 'CSC6918: climb to 3000, clear for approach', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: 'duplicate type, last wins', input: 'CSC6918: heading 120, heading 240', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 240'] },
], 'deviation matrix — chaining & connectors');

// ─── 8. Range & unsupported ────────────────────────────────────────────

itRow([
  { name: 'heading 0 → out of range', input: 'CSC6918: heading 0', callsign: 'CSC6918', noticeIncl: 'out of range' },
  { name: 'heading 361 → out of range', input: 'CSC6918: heading 361', callsign: 'CSC6918', noticeIncl: 'out of range' },
  { name: 'heading 500 → out of range', input: 'CSC6918: heading 500', callsign: 'CSC6918', noticeIncl: 'out of range' },
  { name: 'altitude 400 → out of range', input: 'CSC6918: altitude 400', callsign: 'CSC6918', noticeIncl: 'out of range' },
  { name: 'altitude 61000 → out of range', input: 'CSC6918: altitude 61000', callsign: 'CSC6918', noticeIncl: 'out of range' },
  { name: 'flight level 251 → out of range', input: 'CSC6918: flight level 251', callsign: 'CSC6918', noticeIncl: 'out of range' },
  { name: 'speed 89 → out of range', input: 'CSC6918: speed 89', callsign: 'CSC6918', noticeIncl: 'out of range' },
  { name: 'speed 301 → out of range', input: 'CSC6918: speed 301', callsign: 'CSC6918', noticeIncl: 'out of range' },
  { name: '"heading" with no value → unsupported notice', input: 'CSC6918: heading', callsign: 'CSC6918', noticeIncl: 'unsupported' },
  { name: 'relative turn ("turn left 90 degrees") → unsupported', input: 'CSC6918: turn left 90 degrees', callsign: 'CSC6918', noticeIncl: 'unsupported' },
  { name: '"cleared to land" → unsupported', input: 'CSC6918: cleared to land', callsign: 'CSC6918', noticeIncl: 'unsupported' },
  { name: '"go around" → unsupported', input: 'CSC6918: go around', callsign: 'CSC6918', noticeIncl: 'unsupported' },
  { name: 'filler mid-phrase: "turn left uh heading 360" → command survives, filler noticed', input: 'CSC6918: turn left uh heading 360', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 360'], noticeIncl: 'turn left' },
], 'deviation matrix — range & unsupported');

// ─── 9. Chinese ────────────────────────────────────────────────────────

itRow([
  { name: 'airline short form (东航五八八八爬升至九千)', input: '东航五八八八爬升至九千', callsign: 'CES5888', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: 'airline full Chinese name (中国东方航空五八八八)', input: '中国东方航空五八八八', callsign: 'CES5888' },
  { name: '川航六九幺八爬升至九千', input: '川航六九幺八爬升至九千', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '国航一二三四 (一-series digit)', input: '国航一二三四', callsign: 'CCA1234' },
  { name: '两-series digit (南航两八八八爬升至三千)', input: '南航两八八八爬升至三千', callsign: 'CSN2888', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 3000'] },
  { name: '幺-series digit (海航幺二三四飞航向幺二洞)', input: '海航幺二三四飞航向幺二洞', callsign: 'CHH1234', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: '洞 for zero (国航幺幺洞洞)', input: '国航幺幺洞洞', callsign: 'CCA1100' },
  { name: '左转航向二七洞', input: '川航六九幺八左转航向二七洞', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 270'] },
  { name: '右转航向二七洞', input: '川航六九幺八右转航向二七洞', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 270'] },
  { name: '转向航向二七洞', input: '川航六九幺八转向航向二七洞', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 270'] },
  { name: '飞航向幺二洞', input: '川航六九幺八飞航向幺二洞', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: 'bare 航向幺二洞', input: '川航六九幺八航向幺二洞', callsign: 'CSC6918', commandTypes: ['update_heading'], commandLabels: ['Fly Heading 120'] },
  { name: '爬升保持九千', input: '川航六九幺八爬升保持九千', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '下降保持两千', input: '川航六九幺八下降保持两千', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 2000'] },
  { name: '下降至两千', input: '川航六九幺八下降至两千', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 2000'] },
  { name: '飞高度九千', input: '川航六九幺八飞高度九千', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: 'bare 高度九千', input: '川航六九幺八高度九千', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '平飞九千', input: '川航六九幺八平飞九千', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '高度层九零 (FL ×100)', input: '川航六九幺八高度层九零', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 9000'] },
  { name: '减速至一百八十节', input: '川航六九幺八减速至一百八十节', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: '加速至两百节', input: '川航六九幺八加速至两百节', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 200'] },
  { name: '飞速度一百八', input: '川航六九幺八飞速度一百八', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: 'bare 速度一百八', input: '川航六九幺八速度一百八', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: '保持两千 (≥1000 → altitude)', input: '川航六九幺八保持两千', callsign: 'CSC6918', commandTypes: ['altitude'], commandLabels: ['Fly Altitude 2000'] },
  { name: '保持一百八 (<1000 → speed)', input: '川航六九幺八保持一百八', callsign: 'CSC6918', commandTypes: ['update_speed'], commandLabels: ['Fly Speed 180'] },
  { name: '可以进近 → cfa', input: '川航六九幺八可以进近', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: '允许进近 → cfa', input: '川航六九幺八允许进近', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: 'bare 进近 → cfa', input: '川航六九幺八进近', callsign: 'CSC6918', commandTypes: ['clear_for_appr'], commandLabels: ['Clear for Approach'] },
  { name: 'chained with Chinese comma (，)', input: '川航六九幺八，爬升至九千，减速至一百八十节', callsign: 'CSC6918', commandTypes: ['altitude', 'update_speed'], commandLabels: ['Fly Altitude 9000', 'Fly Speed 180'] },
  { name: 'chained with 然后 connector', input: '川航六九幺八爬升至九千然后减速至一百八十节', callsign: 'CSC6918', commandTypes: ['altitude', 'update_speed'], commandLabels: ['Fly Altitude 9000', 'Fly Speed 180'] },
  { name: 'English commands after a Chinese callsign → unsupported (limitation)', input: '川航六九幺八 climb to 9000', callsign: 'CSC6918', noticeIncl: 'unsupported' },
], 'deviation matrix — Chinese');

// ─── 10. Failure diagnostics ───────────────────────────────────────────

itRow([
  { name: 'empty transcript → reason "empty transcript"', input: '   ', ok: false, reasonIncl: 'empty' },
  { name: 'no airline name → reason names the airline stage', input: 'turn left heading 360', ok: false, reasonIncl: 'airline' },
  { name: 'no aircraft data (empty list) → reason mentions aircraft', input: 'delta 3401', aircraft: [], ok: false, reasonIncl: 'aircraft' },
  { name: 'candidates not in the list → reason names them', input: 'united nine nine nine nine', ok: false, reasonIncl: 'UAL9999' },
], 'deviation matrix — failure diagnostics');

// ─── 11. Payload exactness spot-checks ─────────────────────────────────

describe('deviation matrix — payload exactness', () => {
  it('heading 360 payload is (dx 0, dy 1)', () => {
    const r = parseVoiceTranscript('CSC6918: turn left heading 360', AIRCRAFT);
    expect(r.commands[0].payload).toEqual({ type: 'update_heading', callSign: 'CSC6918', dx: 0, dy: 1, rate: 3 });
  });

  it('flight level one zero zero → targetFt 10000', () => {
    const r = parseVoiceTranscript('CSC6918: flight level one zero zero', AIRCRAFT);
    expect(r.commands[0].payload).toEqual({ type: 'altitude', callSign: 'CSC6918', targetFt: 10000, rate: 1000 });
  });

  it('speed payload is raw knots', () => {
    const r = parseVoiceTranscript('CSC6918: reduce speed to two hundred knots', AIRCRAFT);
    expect(r.commands[0].payload).toEqual({ type: 'update_speed', callSign: 'CSC6918', kts: 200 });
  });

  it('typed literal callsign end-to-end (DAL3401: …)', () => {
    const r = parseVoiceTranscript('DAL3401: turn left heading 360', AIRCRAFT);
    expect(r.callsign).toBe('DAL3401');
    expect(r.commands[0].payload).toEqual({ type: 'update_heading', callSign: 'DAL3401', dx: 0, dy: 1, rate: 3 });
  });
});
