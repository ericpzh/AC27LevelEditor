/**
 * Shared constants used across the ACL parser and renderer.
 */

// ─── Newtonsoft.Json DateTime ticks ──────────────────────
const NET_EPOCH_OFFSET = 621355968000000000n;
const TICKS_PER_SECOND = 10000000n;
const TICKS_PER_DAY = 86400n * TICKS_PER_SECOND;

// Fallback base date ticks: ~2000-01-01 midnight UTC
const FALLBACK_BASE_DATE_TICKS = 630822816000000000;

// ─── AircraftType → Designator mapping ──────────────────
const AIRCRAFT_DESIGNATOR_MAP = {
  'BOEING 737-800': 'B738',  'B737-800': 'B738',  'B738': 'B738',
  'BOEING 737-700': 'B737',  'B737-700': 'B737',  'B737': 'B737',
  'BOEING 737-900': 'B739',  'B737-900': 'B739',  'B739': 'B739',
  'BOEING 777-300ER': 'B77W', 'B777-300ER': 'B77W', 'B77W': 'B77W',
  'BOEING 777-200': 'B772',  'B777-200': 'B772',  'B772': 'B772',
  'BOEING 777-200LR': 'B77L', 'B777-200LR': 'B77L', 'B77L': 'B77L',
  'BOEING 787-8': 'B788',   'B787-8': 'B788',   'B788': 'B788',
  'BOEING 787-9': 'B789',   'B787-9': 'B789',   'B789': 'B789',
  'BOEING 787-10': 'B78X',  'B787-10': 'B78X',  'B78X': 'B78X',
  'BOEING 747-400': 'B744', 'B747-400': 'B744', 'B744': 'B744',
  'BOEING 757-200': 'B752', 'B757-200': 'B752', 'B752': 'B752',
  'BOEING 767-300': 'B763', 'B767-300': 'B763', 'B763': 'B763',
  'AIRBUS A320': 'A320',    'A320': 'A320',
  'AIRBUS A320NEO': 'A20N', 'A320NEO': 'A20N',   'A20N': 'A20N',
  'AIRBUS A319': 'A319',    'A319': 'A319',
  'AIRBUS A321': 'A321',    'A321': 'A321',
  'AIRBUS A321NEO': 'A21N', 'A321NEO': 'A21N',   'A21N': 'A21N',
  'AIRBUS A330-300': 'A333', 'A330-300': 'A333', 'A333': 'A333',
  'AIRBUS A330-200': 'A332', 'A330-200': 'A332', 'A332': 'A332',
  'AIRBUS A350-900': 'A359', 'A350-900': 'A359', 'A359': 'A359',
  'AIRBUS A350-1000': 'A35K','A350-1000': 'A35K','A35K': 'A35K',
  'AIRBUS A380': 'A388',    'A380': 'A388',
  'EMBRAER E190': 'E190',   'E190': 'E190',
  'EMBRAER E170': 'E170',   'E170': 'E170',
  'EMBRAER E195': 'E195',   'E195': 'E195',
  'BOMBARDIER CRJ-700': 'CRJ7', 'CRJ-700': 'CRJ7', 'CRJ7': 'CRJ7',
  'BOMBARDIER CRJ-900': 'CRJ9', 'CRJ-900': 'CRJ9', 'CRJ9': 'CRJ9',
};

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
  AIRCRAFT_DESIGNATOR_MAP,
  FIELDS, FIELD_LABELS, DROPDOWN_FIELDS,
};
