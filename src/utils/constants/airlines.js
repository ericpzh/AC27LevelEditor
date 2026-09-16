// ─── Airport Hardcoded Display Names & Sort Order ──────────
export const AIRPORT_META = {
  ZSJN: { id: 0, name: '济南遥墙机场' },
  KJFK: { id: 1, name: '约翰·肯尼迪国际机场' },
  ZGSZ: { id: 2, name: '深圳宝安国际机场' },
  KDCA: { id: 3, name: '罗纳德·里根华盛顿国家机场' },
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
  'Asiana Airlines': 'AAR',     'Korean Air': 'KAL',
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

// ─── Code → human-readable names (inverted map) ─────────
// The game/editor store 3-letter codes; the UI shows names. Each code can
// have several names (EN + ZH entries in AIRLINE_CODE_MAP); pick by UI lang:
// a name containing CJK chars is the Chinese display name, otherwise English.
// Unknown codes fall back to the raw code.
const CJK_RE = /[\u4e00-\u9fff]/;

export const AIRLINE_CODE_TO_NAMES = (() => {
  const map = {};
  for (const [name, code] of Object.entries(AIRLINE_CODE_MAP)) {
    if (!map[code]) map[code] = [];
    if (!map[code].includes(name)) map[code].push(name);
  }
  return map;
})();

export function airlineDisplayName(code, lang) {
  const names = AIRLINE_CODE_TO_NAMES[code];
  if (!names || names.length === 0) return code;
  if (lang === 'zh') {
    return names.find(n => CJK_RE.test(n)) || names[0];
  }
  return names.find(n => !CJK_RE.test(n)) || names[0];
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
