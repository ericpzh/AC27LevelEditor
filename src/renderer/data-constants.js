// ─── Airport Hardcoded Display Names & Sort Order ──────────
const AIRPORT_META = {
  ZSJN: { id: 1, name: '济南遥墙机场' },
  KJFK: { id: 2, name: '约翰·肯尼迪国际机场' },
};

// ─── Airline Name → Airline Code mapping ──────────────
// AirlineName in the game files stores ICAO 3-letter codes;
// this mapping handles cases where the name differs from the code.
const AIRLINE_CODE_MAP = {
  // Chinese airlines
  'Air China': 'CCA',
  '中国国航': 'CCA',
  'China Eastern': 'CES',
  '中国东方航空': 'CES',
  'China Southern': 'CSN',
  '中国南方航空': 'CSN',
  'Hainan Airlines': 'CHH',
  '海南航空': 'CHH',
  'Shenzhen Airlines': 'CSZ',
  '深圳航空': 'CSZ',
  'Sichuan Airlines': 'CSC',
  '四川航空': 'CSC',
  'Xiamen Airlines': 'CXA',
  '厦门航空': 'CXA',
  'Shandong Airlines': 'CDG',
  '山东航空': 'CDG',
  'Spring Airlines': 'CQH',
  '春秋航空': 'CQH',
  'Okay Airways': 'CJX',
  '奥凯航空': 'CJX',
  'Tibet Airlines': 'UEA',
  '西藏航空': 'UEA',
  // International airlines (full names → codes)
  'American Airlines': 'AAL',
  'Delta Air Lines': 'DAL',
  'United Airlines': 'UAL',
  'JetBlue': 'JBU',
  'British Airways': 'BAW',
  'Air France': 'AFR',
  'Lufthansa': 'DLH',
  'Qantas': 'QFA',
  'Qatar Airways': 'QTR',
  'Cathay Pacific': 'CPA',
  'Singapore Airlines': 'SIA',
  'Air New Zealand': 'ANZ',
  'Alaska Airlines': 'ASA',
  'Etihad Airways': 'ETD',
  'Gulf Air': 'GFA',
  'Air Arabia': 'AAR',
  'Virgin Atlantic': 'VIR',
  'Avianca': 'AVA',
  'Asiana Airlines': 'AAR',
  'Korean Air': 'AAR',
  'Emirates': 'UAE',
  'Turkish Airlines': 'THY',
  'Air Canada': 'ACA',
  'Japan Airlines': 'JAL',
  'All Nippon Airways': 'ANA',
  'Ethiopian Airlines': 'ETH',
  'KLM': 'KLM',
  'Swiss': 'SWR',
  'Aeroflot': 'AFL',
  'China Airlines': 'CAL',
  'EVA Air': 'EVA',
};

function getAirlineCode(airlineName) {
  if (!airlineName) return 'NEW';
  // If AirlineName is already a 3-letter ICAO code (e.g. "DAL"), use it directly
  if (/^[A-Z]{3}$/.test(airlineName)) return airlineName;
  // Look up in the mapping
  const code = AIRLINE_CODE_MAP[airlineName];
  if (code) return code;
  // Fallback: first 3 chars uppercased
  return airlineName.substring(0, 3).toUpperCase();
}

function airportDisplayName(icao) {
  const meta = AIRPORT_META[icao];
  return meta ? `${icao} — ${meta.name}` : icao;
}

function airportSortOrder(icao) {
  const meta = AIRPORT_META[icao];
  return meta ? meta.id : 9999;
}

// ─── Field Definitions ────────────────
const ALL_FIELDS = [
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
  ['Registration', 'string'],
  ['Voice', 'string'],
  ['Language', 'string'],
];

const FIELD_LABELS = {
  AirlineCode: '航司代码', FlightNum: '航班号',
  CallSign: '呼号', DepartureAirport: '出发', ArrivalAirport: '到达',
  Stand: '停机位', Runway: '跑道', OffBlockTime: '推出', TakeoffTime: '起飞',
  LandingTime: '落地', InBlockTime: '入位', AirlineName: '航司',
  AircraftType: '机型', Airway: '进场程序',
  Registration: '注册号', Voice: '语音', Language: '语言',
};

// Fields that get clock popover
const TIME_FIELDS = new Set(['LandingTime', 'InBlockTime', 'OffBlockTime', 'TakeoffTime']);

// Fields that get dropdown menus
const DROPDOWN_FIELDS = new Set([
  'AircraftType', 'AirlineCode',
  'Stand', 'Runway',
  'Language', 'Registration', 'Airway', 'Voice',
]);

const COL_CLASSES = {
  AirlineCode: 'col-airline-code', FlightNum: 'col-flight-num',
  CallSign: 'col-callsign', DepartureAirport: 'col-dep',
  ArrivalAirport: 'col-arr', Stand: 'col-stand', Runway: 'col-runway',
  OffBlockTime: 'col-time', TakeoffTime: 'col-time', LandingTime: 'col-time',
  InBlockTime: 'col-time', AirlineName: 'col-airline', AircraftType: 'col-ac',
  Airway: 'col-airway', Registration: 'col-reg',
  Voice: 'col-voice', Language: 'col-lang',
};

// Fields per section (arrivals always ArrivalAirport=this airport, departures always DepartureAirport=this airport)
// Arrivals show origin (DepartureAirport), departures show destination (ArrivalAirport)
const ARRIVAL_FIELDS = ['AirlineCode', 'FlightNum', 'DepartureAirport', 'Stand', 'Runway', 'LandingTime', 'InBlockTime', 'AircraftType', 'Airway', 'Registration', 'Voice', 'Language'];
const DEPARTURE_FIELDS = ['AirlineCode', 'FlightNum', 'ArrivalAirport', 'Stand', 'Runway', 'OffBlockTime', 'TakeoffTime', 'AircraftType', 'Registration', 'Voice', 'Language'];
