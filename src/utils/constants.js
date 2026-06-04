// ─── Newtonsoft.Json DateTime ticks ──────────────────────
export const NET_EPOCH_OFFSET = 621355968000000000n;
export const TICKS_PER_SECOND = 10000000n;
export const TICKS_PER_DAY = 86400n * TICKS_PER_SECOND;
export const FALLBACK_BASE_DATE_TICKS = 630822816000000000;

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

// ─── Field Definitions ────────────────
export const ALL_FIELDS = [
  ['CallSign', 'string'], ['DepartureAirport', 'string'], ['ArrivalAirport', 'string'],
  ['Stand', 'string'], ['Runway', 'string'],
  ['OffBlockTime', 'time'], ['TakeoffTime', 'time'], ['LandingTime', 'time'], ['InBlockTime', 'time'],
  ['AirlineName', 'string'], ['AircraftType', 'string'], ['Airway', 'string'],
  ['Registration', 'string'], ['Voice', 'string'], ['Language', 'string'],
];

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

/**
 * Return columns that have non-empty values in at least one flight,
 * plus AirlineCode/FlightNum which are always shown.
 */
export function getActiveColumns(flights, fieldList) {
  const cols = [];
  for (const [fn] of ALL_FIELDS) {
    if (!fieldList.includes(fn)) continue;
    if (fn === 'AirlineCode' || fn === 'FlightNum') cols.push(fn);
    else if (flights.some(fl => (fl[fn] || '').trim())) cols.push(fn);
  }
  return cols;
}
