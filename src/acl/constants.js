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
const APPROACH_MIN_TTL = 25;

module.exports = {
  NET_EPOCH_OFFSET, TICKS_PER_SECOND, TICKS_PER_DAY, FALLBACK_BASE_DATE_TICKS,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
  APPROACH_MIN_TTL,
};
