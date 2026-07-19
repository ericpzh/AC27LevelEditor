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

export function getActiveColumns(flights, fieldList, isV4) {
  const cols = ['AirlineCode', 'FlightNum'];
  for (const [fn] of FIELDS) {
    if (fn === 'AirlineCode' || fn === 'FlightNum') continue;
    if (!fieldList.includes(fn)) continue;
    // v4 files always store InBlockTime/TakeoffTime as 0 (unset) — hide the column.
    if (isV4 && (fn === 'InBlockTime' || fn === 'TakeoffTime')) continue;
    cols.push(fn);
  }
  return cols;
}
