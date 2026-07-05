// ─── Newtonsoft.Json DateTime ticks ──────────────────────
export const NET_EPOCH_OFFSET = 621355968000000000n;
export const TICKS_PER_SECOND = 10000000n;
export const TICKS_PER_DAY = 86400n * TICKS_PER_SECOND;
export const FALLBACK_BASE_DATE_TICKS = 630822816000000000;
export const MINUTES_PER_DAY = 1440;

// Number-form equivalents (for non-BigInt code paths)
export const TICKS_PER_SECOND_NUM = 10000000;
export const TICKS_PER_DAY_NUM = 864000000000;

// ─── CACHE_VERSION — bump when cache.json schema changes ───
export const CACHE_VERSION = 12;

// ─── Map-window on-hover button tooltips (air/ground radar + flight strips) ──
// Set to true to enable portal-based hover tooltips on all radar/strip buttons.
// Tooltip text is extracted from the Map Help overlay content (i18n-aware).
// The help/witch-mode toggle button is always excluded.
export const MAP_TOOLTIPS_ENABLED = false;

// ─── Nautical mile → game units (1852 m ÷ 100 m/unit) ──────
export const NM_TO_GU = 18.52;

// ─── Airport Hardcoded Display Names & Sort Order ──────────
export const AIRPORT_META = {
  ZSJN: { id: 0, name: '济南遥墙机场' },
  KJFK: { id: 1, name: '约翰·肯尼迪国际机场' },
};

// ─── Airline Name → Airline Code mapping ──────────────
export const AIRLINE_CODE_MAP = {
  'Air China': 'CCA',           '中国国航': 'CCA',
  'China Eastern': 'CES',       '中国东方航空': 'CES',
  'China Southern': 'CSN',       '中国南方航空': 'CSN',
  'Hainan Airlines': 'CHH',     '海南航空': 'CHH',
  'Shenzhen Airlines': 'CSZ',   '深圳航空': 'CSZ',
  'Sichuan Airlines': 'CSC',    '四川航空': 'CSC',
  'Xiamen Airlines': 'CXA',     '厦门航空': 'CXA',
  'Shandong Airlines': 'CDG',   '山东航空': 'CDG',
  'Spring Airlines': 'CQH',     '春秋航空': 'CQH',
  'Okay Airways': 'CJX',        '奥凯航空': 'CJX',
  'Tibet Airlines': 'UEA',      '西藏航空': 'UEA',
  'American Airlines': 'AAL',   'Delta Air Lines': 'DAL',
  'United Airlines': 'UAL',     'JetBlue': 'JBU',
  'British Airways': 'BAW',     'Air France': 'AFR',
  'Lufthansa': 'DLH',           'Qantas': 'QFA',
  'Qatar Airways': 'QTR',       'Cathay Pacific': 'CPA',
  'Singapore Airlines': 'SIA',  'Air New Zealand': 'ANZ',
  'Alaska Airlines': 'ASA',     'Etihad Airways': 'ETD',
  'Gulf Air': 'GFA',            'Air Arabia': 'AAR',
  'Virgin Atlantic': 'VIR',     'Avianca': 'AVA',
  'Asiana Airlines': 'AAR',     'Korean Air': 'AAR',
  'Emirates': 'UAE',            'Turkish Airlines': 'THY',
  'Air Canada': 'ACA',          'Japan Airlines': 'JAL',
  'All Nippon Airways': 'ANA',  'Ethiopian Airlines': 'ETH',
  'KLM': 'KLM',                 'Swiss': 'SWR',
  'Aeroflot': 'AFL',            'China Airlines': 'CAL',
  'EVA Air': 'EVA',
};

export function getAirlineCode(airlineName) {
  if (!airlineName) return 'NEW';
  if (/^[A-Z]{3}$/.test(airlineName)) return airlineName;
  const code = AIRLINE_CODE_MAP[airlineName];
  if (code) return code;
  return airlineName.substring(0, 3).toUpperCase();
}

export function airportDisplayName(icao, t) {
  if (t) {
    const key = 'airport_' + icao;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  const meta = AIRPORT_META[icao];
  return meta ? `${icao} — ${meta.name}` : icao;
}

export function airportSortOrder(icao) {
  const meta = AIRPORT_META[icao];
  return meta ? meta.id : 9999;
}

// ─── Field Definitions (single source of truth) ────────────────
export const FIELDS = [
  ['CallSign', 'string'], ['DepartureAirport', 'string'], ['ArrivalAirport', 'string'],
  ['Stand', 'string'], ['Runway', 'string'],
  ['OffBlockTime', 'time'], ['TakeoffTime', 'time'], ['LandingTime', 'time'], ['InBlockTime', 'time'],
  ['AirlineName', 'string'], ['AircraftType', 'string'], ['Airway', 'string'],
  ['Registration', 'string'], ['Voice', 'string'], ['Language', 'string'],
];

/** @deprecated — use FIELDS instead */
export const ALL_FIELDS = FIELDS;

export const FIELD_LABELS = {
  AirlineCode: '航司代码', FlightNum: '航班号',
  CallSign: '呼号', DepartureAirport: '出发', ArrivalAirport: '到达',
  Stand: '停机位', Runway: '跑道', OffBlockTime: '推出', TakeoffTime: '起飞',
  LandingTime: '落地', InBlockTime: '入位', AirlineName: '航司',
  AircraftType: '机型', Airway: '进场程序',
  Registration: '注册号', Voice: '语音', Language: '语言',
};

export const TIME_FIELDS = new Set(['LandingTime', 'InBlockTime', 'OffBlockTime', 'TakeoffTime']);

export const DROPDOWN_FIELDS = new Set([
  'AircraftType', 'AirlineCode', 'Stand', 'Runway',
  'Language', 'Registration', 'Airway', 'Voice',
]);

export const COL_CLASSES = {
  AirlineCode: 'col-airline-code', FlightNum: 'col-flight-num',
  CallSign: 'col-callsign', DepartureAirport: 'col-dep',
  ArrivalAirport: 'col-arr', Stand: 'col-stand', Runway: 'col-runway',
  OffBlockTime: 'col-time', TakeoffTime: 'col-time', LandingTime: 'col-time',
  InBlockTime: 'col-time', AirlineName: 'col-airline', AircraftType: 'col-ac',
  Airway: 'col-airway', Registration: 'col-reg',
  Voice: 'col-voice', Language: 'col-lang',
};

export const ARRIVAL_FIELDS = ['AirlineCode', 'FlightNum', 'DepartureAirport', 'Stand', 'Runway', 'LandingTime', 'InBlockTime', 'AircraftType', 'Airway', 'Registration', 'Voice', 'Language'];
export const DEPARTURE_FIELDS = ['AirlineCode', 'FlightNum', 'ArrivalAirport', 'Stand', 'Runway', 'OffBlockTime', 'TakeoffTime', 'AircraftType', 'Registration', 'Voice', 'Language'];

export function getActiveColumns(flights, fieldList) {
  const cols = ['AirlineCode', 'FlightNum'];
  for (const [fn] of FIELDS) {
    if (fn === 'AirlineCode' || fn === 'FlightNum') continue;
    if (fieldList.includes(fn)) cols.push(fn);
  }
  return cols;
}

// ─── Wind speed ───────────────────────────────────────────
export const KTS_TO_MS = 0.514444;
export const MPS_TO_KNOTS = 1 / KTS_TO_MS;  // ~1.94384
export const WIND_UNITS = { KNOTS: 'knots', MPS: 'mps' };

// ─── Approach & aviation math ─────────────────────────────
export const APPROACH_MIN_TTL = 30;
export const GLIDESLOPE_DEG = 3;
export const TAN_3_DEG = Math.tan(GLIDESLOPE_DEG * Math.PI / 180);   // ~0.052408
export const RAD_TO_DEG = 180 / Math.PI;
export const APPROACH_SPEED_KTS = 240;
export const APPROACH_SPEED_MS = APPROACH_SPEED_KTS * KTS_TO_MS;  // 123.47 m/s
// DEPRECATED: replaced by physics-based APPROACH_SPEED_MS. Kept as fallback.
export const APPROACH_EFFECTIVE_SPEED = 12.5;

// ─── Coordinate scale ─────────────────────────────────────
//
// All axes (XYZ) use a uniform 100 m/unit scale. Confirmed by original
// game files using Y=15.24 (=5000ft) at every airport regardless of runway
// geometry.
export const DEFAULT_AIRPORT_SCALE = 100;

// ─── Approach altitude ceiling ─────────────────────────────
//
// Standard ILS approach ceiling in real-world units (5000ft AGL).
//   approachCap = APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE = 15.24
export const APPROACH_CEILING_FT = 5000;
export const FT_TO_M = 0.3048;
export const APPROACH_CEILING_M = APPROACH_CEILING_FT * FT_TO_M;  // 1524m

// ─── Approach fallback values ──────────────────────────────
export const DEFAULT_TAT = 1600;           // default totalApproachTime (seconds)
export const TD_FALLBACK_EXTEND = 50;      // game-units to extend past last path point

// ─── Game timing / scenario ────────────────────────────────
export const WARMUP_SEC = 780;             // 13-minute game warmup
export const GRACE_TTL = -10;              // max seconds-past-landing filter
export const DEMO_WINDOW_SEC = 1800;       // 30-minute demo window
export const DEMO_WINDOW_MIN = 30;
export const MIDNIGHT_CROSS_THRESHOLD_MIN = 360;  // 6AM in minutes
export const MIDNIGHT_CROSS_START_HOUR = 18;      // 6PM

// ─── ACL format structure ──────────────────────────────────
// Unity JSON special metadata keys
export const SPECIAL_KEYS = new Set([
  '$id', '$type', '$ref', '$rcontent', '$rlength', '$values', '__v',
]);
// Known ACL top-level section names
export const TOP_LEVEL_SECTIONS = [
  'SceneryData', 'WorldState', 'GameTime', 'Config', 'Channels',
  'WeatherFrames', 'WindFrames', 'RunwayTimeline', 'Jetways',
];
// WorldState sub-sections
export const WORLD_STATE_SUB = ['Aircrafts', 'AircraftAnimators', 'FlightPlans'];

// ─── $id offsets for generated entries ─────────────────────
export const ID_OFFSET_FLIGHTPLAN = 90000;
export const ID_OFFSET_AIRCRAFT = 70000;
export const ID_OFFSET_ANIMATOR = 80000;
export const ID_OFFSET_DYNAMICS = 100000;
export const TYPE_NUM_FALLBACK_START = 100;
export const DEFAULT_SNAPSHOT_ID_START = 5001;

// ─── Specification defaults ────────────────────────────────
export const DEFAULT_AERODROME_CODE = 67;
export const DEFAULT_WAKE_CATEGORY = 77;
export const DEFAULT_RUNWAY_VR_SPEED = 140;
export const DEFAULT_RUNWAY_TAKEOFF_LENGTH = 2000;
export const DEFAULT_MODEL_OFFSET = { x: 0.19, y: -0.05, z: -0.20 };

// ─── Dynamics defaults ─────────────────────────────────────
export const TAXI_SPEED = 240;
export const POSITIVE_TAXI_ACCEL = 1;
export const NEGATIVE_TAXI_ACCEL = -2;
export const DYNAMICS_STATE_FLYING = 1;      // State=30
export const DYNAMICS_STATE_APPROACH = 2;    // State=5

// ─── Command / channel type numbers ────────────────────────
export const CMD_CONTACT_TOWER = 22;
export const CMD_CLEARED_TO_LAND = 23;
export const CMD_GO_AROUND = 24;
export const CMD_CONTINUE_APPROACH = 25;
export const CMD_CLEAR_FOR_TAKEOFF = 26;
export const CMD_LINE_UP_WAIT = 27;
export const CMD_HOLD_SHORT = 28;         // hold short of runway
export const CMD_PUSH_BACK = 31;
export const CMD_CONTACT_GROUND = 33;
export const CMD_HOLD_SHORT_TAXI = 39;    // hold short at taxiway
export const CMD_HOLD_POSITION = 40;
export const CMD_TAXI_VIA = 41;
export const CMD_CONTACT_DEP = 42;
export const CMD_CHANGE_RWY = 43;
export const CMD_DISPATCH_TOW = 44;
export const CMD_SELECT_EXIT = 45;
export const CMD_STAND_BY = 46;
export const CMD_CROSS_RWY = 47;
export const CHANNEL_TYPE_APPROACH = 5;
export const CHANNEL_TYPE_TOWER = 3;

// ─── Vector epsilon thresholds ─────────────────────────────
export const EPSILON_NORMALIZE = 1e-12;      // zero-vector guard
export const EPSILON_PR = 0.001;
export const EPSILON_IAF_JOIN = 0.1;

// ─── UI timing ─────────────────────────────────────────────
export const TOAST_DURATION_MS = 2500;

// ─── Default flight creation time offsets (minutes) ────────
export const FALLBACK_BASE_MINUTES = 360;   // 06:00
export const DEFAULT_TIME_OFFSET_MIN = 10;
export const DEFAULT_TAXI_MINUTES = 5;

// ─── Stand occupancy window (minutes) ──────────────────────
export const STAND_DEP_BEFORE_ESTIMATE_MIN = 20;
export const STAND_ARR_AFTER_ESTIMATE_MIN = 20;
export const STAND_LANDING_BEFORE_INBLOCK_MIN = 5;
export const STAND_OCCUPANCY_START_OFFSET_MIN = 30;
export const STAND_OCCUPANCY_END_OFFSET_MIN = 60;

// ─── Map overlay layout (shared by StandMap + StarMap) ─────
export const MAP_PAD_RATIO = 0.10;
export const MAP_GAP = 8;
export const MAP_HEADER_H = 38;
export const MAP_LEGEND_H = 40;
export const MAP_SVG_FRAC = 0.48;
export const MAP_MIN_SVG = 680;
export const MAP_TARGET_RATIO = 1.35;

// ─── Per-airport approach-radar background image config ──────
// `w` = image width in viewBox units when height = 3000
// `bg` = color for area OUTSIDE the map image (within data bounds)
// `bgUnder` = color BEHIND the semi-transparent map image
// dx/dy = fine-tune position offset
export const AIR_MAP_BG_OFFSETS = {
  ZSJN: { dx: 0, dy: 0, bg: '#232323', bgUnder: '#000000' },
  KJFK: { dx: -890, dy: -160, w: 5600, bg:'#0c0c0c', bgUnder: '#000000' },
};

// Witch mode map background offsets (independent of normal mode)
export const WITCH_MAP_BG_OFFSETS = {
  ZSJN: { dx: 0, dy: 0, w: 0 },
  KJFK: { dx: -900, dy: 0, w: 0 },
};

// Per-airport default zoom scale: 1.0 = full dataBounds, <1 = tighter initial view
export const GROUND_MAP_DEFAULT_ZOOM = {
  ZSJN: 0.75,
  KJFK: 1.0,
  KDCA: 0.5,
};
// Per-airport center offset in game units: { x, z } shift from (0, 0)
export const GROUND_MAP_CENTER_OFFSET = {
  ZSJN: { x: 0, z: -3 },
  KJFK: { x: -3, z: 0 },
};
export const AIR_MAP_DEFAULT_ZOOM = {
  ZSJN: 1.0,
  KJFK: 1.0,
};

// Ground radar: max distance (game units) from aircraft to assigned stand
// midpoint to be considered "at stand". 0.5 GU ≈ 50 m.
export const GROUND_RADAR_STAND_PROXIMITY = 0.5;
export const GROUND_MAP_TAXIWAY_LABEL_SPACING = 10.0; // min GU between same-name taxiway labels
export const GROUND_MAP_STAND_ACCESS_WIDTH_MULT = 1.0; // stand-access taxiway line width multiplier

export const MAP_PLANE_VB = 512;
// IoAirplane icon path
export const MAP_ICON_PATH = "M186.62 464H160a16 16 0 0 1-14.57-22.6l64.46-142.25L113.1 297l-35.3 42.77C71.07 348.23 65.7 352 52 352H34.08a17.66 17.66 0 0 1-14.7-7.06c-2.38-3.21-4.72-8.65-2.44-16.41l19.82-71c.15-.53.33-1.06.53-1.58a.38.38 0 0 0 0-.15 14.82 14.82 0 0 1-.53-1.59l-19.84-71.45c-2.15-7.61.2-12.93 2.56-16.06a16.83 16.83 0 0 1 13.6-6.7H52c10.23 0 20.16 4.59 26 12l34.57 42.05 97.32-1.44-64.44-142A16 16 0 0 1 160 48h26.91a25 25 0 0 1 19.35 9.8l125.05 152 57.77-1.52c4.23-.23 15.95-.31 18.66-.31C463 208 496 225.94 496 256c0 9.46-3.78 27-29.07 38.16-14.93 6.6-34.85 9.94-59.21 9.94-2.68 0-14.37-.08-18.66-.31l-57.76-1.54-125.36 152a25 25 0 0 1-19.32 9.75z";

// ─── Drag panel ────────────────────────────────────────────
export const DRAG_MIN_VISIBLE_X = 40;
export const DRAG_MIN_VISIBLE_Y = 38;

// ─── localStorage keys ─────────────────────────────────────
export const STORAGE_KEY_LANG = 'ac27_lang';
export const STORAGE_KEY_THEME = 'ac27_theme';

// ─── Valid languages ───────────────────────────────────────
export const VALID_LANGUAGES = new Set(['en', 'zh']);

// ─── Weather presets ───────────────────────────────────────
export const WEATHER_PRESETS = ['Sunny', 'FewCloudy', 'MidCloudy', 'PartlyCloudy', 'OvercastSky', 'AfterRain'];

// ─── Compass directions ────────────────────────────────────
export const COMPASS_DIRS = ['N', '', '', 'E', '', '', 'S', '', '', 'W', '', ''];
export const COMPASS_CARDINAL = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// ─── File filtering ────────────────────────────────────────
export const RE_HIDDEN = /tutorial|bench|test|crossrunway|dev|endless|\.prod/i;

/**
 * Full filenames (with extension) that are visible in demo mode.
 * Only levels in this set appear when browsing the demo game root,
 * and only these files get the 30-minute demo window treatment.
 * Update this set when demo levels are added or removed.
 */
export const DEMO_VISIBLE_BASES = new Set([
  'ZSJN-Morning_120min.demo.acl',
  'ZSJN_17-19_emerg.acl',
  'KJFK_07-09_emerg.acl',
  'KJFK_20-22.demo.acl',
]);

// ─── Toast types ───────────────────────────────────────────
export const TOAST_TYPES = { SUCCESS: 'success', ERROR: 'error' };
