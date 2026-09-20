// ─── Airport Hardcoded Display Names & Sort Order ──────────
export const AIRPORT_META = {
  ZSJN: { id: 0, name: '济南遥墙机场' },
  KJFK: { id: 1, name: '约翰·肯尼迪国际机场' },
  ZGSZ: { id: 2, name: '深圳宝安国际机场' },
  KDCA: { id: 3, name: '罗纳德·里根华盛顿国家机场' },
};

// Generated ICAO → { en, zh } snapshot of every airline from the Wikipedia
// "List of airline codes" pages (see scripts/fetch-airlines.mjs). Used as the
// display fallback so any airline code resolves to a name without hand-editing.
import { WIKI_AIRLINE_NAMES } from './airlines.wiki.js';

// ─── Hand-curated airline name → code table ──────────────
// The curated entries are authoritative: they carry the short display names
// (including Chinese) and drive the painter's airline dropdown, the new-flight
// defaults and the voice callsign parser. Edit here for canonical names; the
// generated table fills in everything else.
export const CURATED_AIRLINE_CODE_MAP = {
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
  'Chengdu Airlines': 'UEA',    '成都航空': 'UEA',
  'Shanghai Airlines': 'CSH',   '上海航空': 'CSH',
  'Tibet Airlines': 'TBA',      '西藏航空': 'TBA',
  'Deer Jet': 'BDJ',            '金鹿公务': 'BDJ',
  'American Airlines': 'AAL',   'Delta Air Lines': 'DAL',
  'United Airlines': 'UAL',     'JetBlue': 'JBU',
  'Southwest Airlines': 'SWA',  'Frontier Airlines': 'FFT',
  'Hawaiian Airlines': 'HAL',   'Allegiant Air': 'AAY',
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

// Sorted unique curated codes — the painter's airline combobox source. The
// generated table (≈5,900 airlines) is intentionally NOT offered here: a native
// <select> that large is unusable, and the field stays typeable for any code.
export const CURATED_AIRLINE_CODES = [...new Set(Object.values(CURATED_AIRLINE_CODE_MAP))].sort();

// ─── Expanded name → code ───────────────────────────────
// Curated entries win; the generated Wikipedia snapshot fills in every other
// airline so getAirlineCode resolves names beyond the curated set. (Duplicate
// names across codes resolve to the first/curated owner — a lossy but harmless
// convenience for reverse lookups, which is why display uses code → name.)
export const AIRLINE_CODE_MAP = (() => {
  const map = { ...CURATED_AIRLINE_CODE_MAP };
  for (const [code, names] of Object.entries(WIKI_AIRLINE_NAMES)) {
    if (!names) continue;
    if (names.en && map[names.en] === undefined) map[names.en] = code;
    if (names.zh && map[names.zh] === undefined) map[names.zh] = code;
  }
  return map;
})();

export function getAirlineCode(airlineName) {
  if (!airlineName) return 'NEW';
  if (/^[A-Z]{3}$/.test(airlineName)) return airlineName;
  const code = AIRLINE_CODE_MAP[airlineName];
  if (code) return code;
  return airlineName.substring(0, 3).toUpperCase();
}

// ─── Code → human-readable names (inverted map) ─────────
// The game/editor store 3-letter codes; the UI shows names. Each code can
// have several names (EN + ZH entries in the curated table); pick by UI lang:
// a name containing CJK chars is the Chinese display name, otherwise English.
// Unknown codes fall back to the raw code.
const CJK_RE = /[\u4e00-\u9fff]/;

export const AIRLINE_CODE_TO_NAMES = (() => {
  const map = {};
  for (const [name, code] of Object.entries(CURATED_AIRLINE_CODE_MAP)) {
    if (!map[code]) map[code] = [];
    if (!map[code].includes(name)) map[code].push(name);
  }
  return map;
})();

export function airlineDisplayName(code, lang) {
  const names = AIRLINE_CODE_TO_NAMES[code];
  const wiki = WIKI_AIRLINE_NAMES[code];
  if (lang === 'zh') {
    // A curated CJK name wins; otherwise fall back to the generated Chinese
    // name, then to whatever curated/generated name exists, then the code.
    if (names && names.some(n => CJK_RE.test(n))) return names.find(n => CJK_RE.test(n));
    if (wiki && wiki.zh) return wiki.zh;
    return (names && names[0]) || (wiki && wiki.en) || code;
  }
  if (names && names.length > 0) return names.find(n => !CJK_RE.test(n)) || names[0];
  if (wiki) return wiki.en || wiki.zh || code;
  return code;
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
