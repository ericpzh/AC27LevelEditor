/**
 * Shared constants used across the ACL parser.
 * Re-exports tick constants from ../utils/constants.js.
 */

const { NET_EPOCH_OFFSET, TICKS_PER_SECOND, TICKS_PER_DAY, FALLBACK_BASE_DATE_TICKS } = require('../utils/constants.js');

// ─── CSV field definitions ─────────────────────────────
const FIELDS = [
  ['CallSign', 'string'],
  ['DepartureAirport', 'string'],
  ['ArrivalAirport', 'string'],
  ['Stand', 'string'],
  ['Runway', 'string'],
  ['OffBlockTime', 'time'],
  ['TakeoffTime', 'time'],
  ['LandingTime', 'time'],
  ['InBlockTime', 'time'],
  ['AirlineName', 'string'],
  ['AircraftType', 'string'],
  ['Airway', 'string'],
  ['Voice', 'string'],
  ['Language', 'string'],
];

const FIELD_LABELS = {
  CallSign: '呼号', DepartureAirport: '出发', ArrivalAirport: '到达',
  Stand: '停机位', Runway: '跑道', OffBlockTime: '推出', TakeoffTime: '起飞',
  LandingTime: '落地', InBlockTime: '入位', AirlineName: '航司',
  AircraftType: '机型', Airway: '进场程序',
  Registration: '注册号', Voice: '语音', Language: '语言',
};

const DROPDOWN_FIELDS = [
  'AircraftType', 'AirlineCode',
  'Runway',
  'Voice', 'Language', 'Registration', 'Airway',
];

// Minimum time-to-landing clamp (seconds). Aircraft closer than this to landing
// are clamped so they still show on approach and the user has time to interact.
const APPROACH_MIN_TTL = 30;

// Effective approach speed (m/s) for converting SceneryData path length to
// totalApproachTime. Calibrated so ~20km path ≈ 1600s TAT. This is the "effective"
// speed for the linear time-based PR formula PR = 1 - timeToLanding/TAT — much
// slower than real ground speed because aircraft decelerate along the approach.
// DEPRECATED: replaced by the physics-based formula using APPROACH_SPEED_MS and
// per-airport coordinate scale. Kept as fallback for airports without runway data.
const APPROACH_EFFECTIVE_SPEED = 12.5;

// Aircraft approach speed (from TargetTaxiSpeed: 240 in DynamicsParams).
// This is the game's constant airspeed for all aircraft on approach.
const APPROACH_SPEED_KTS = 240;
const KTS_TO_MS = 0.514444;
const APPROACH_SPEED_MS = APPROACH_SPEED_KTS * KTS_TO_MS;  // 123.47 m/s

// ─── Coordinate scale ──────────────────────────────────────
//
// All axes (XYZ) use a uniform 100 m/unit scale. Confirmed by original
// game files using Y=15.24 (=5000ft) at every airport regardless of runway
// geometry. The per-airport runway-length ratio was a mistaken assumption.
const DEFAULT_AIRPORT_SCALE = 100;

// ─── Approach altitude ceiling ─────────────────────────────

// Standard ILS approach ceiling in real-world units (5000ft AGL).
//   approachCap = APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE = 15.24
const APPROACH_CEILING_FT = 5000;
const FT_TO_M = 0.3048;
const APPROACH_CEILING_M = APPROACH_CEILING_FT * FT_TO_M;  // 1524m

module.exports = {
  NET_EPOCH_OFFSET, TICKS_PER_SECOND, TICKS_PER_DAY, FALLBACK_BASE_DATE_TICKS,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
  APPROACH_MIN_TTL, APPROACH_EFFECTIVE_SPEED,
  APPROACH_SPEED_KTS, KTS_TO_MS, APPROACH_SPEED_MS,
  DEFAULT_AIRPORT_SCALE,
  APPROACH_CEILING_FT, FT_TO_M, APPROACH_CEILING_M,
};
