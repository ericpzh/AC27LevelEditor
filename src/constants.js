/**
 * Shared constants used across the ACL parser and renderer.
 */

// ─── Newtonsoft.Json DateTime ticks ──────────────────────
const NET_EPOCH_OFFSET = 621355968000000000n;
const TICKS_PER_SECOND = 10000000n;
const TICKS_PER_DAY = 86400n * TICKS_PER_SECOND;

// Fallback base date ticks: ~2000-01-01 midnight UTC
const FALLBACK_BASE_DATE_TICKS = 630822816000000000;

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
  'Stand', 'Runway', 'DepartureAirport', 'ArrivalAirport',
  'Voice', 'Language', 'Registration', 'Airway',
];

module.exports = {
  NET_EPOCH_OFFSET, TICKS_PER_SECOND, TICKS_PER_DAY,
  FALLBACK_BASE_DATE_TICKS,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
};
