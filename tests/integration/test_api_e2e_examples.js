/**
 * E2E tests for MCP API — Composition Examples from the skill (Section 8)
 *
 * Each test loads a fixture flight list, runs the API calls that the LLM
 * would make for a given user prompt, and asserts the final state.
 *
 * Usage: node tests/integration/test_api_e2e_examples.js
 */

const http = require('http');
const { startServer, stopServer } = require('../../electron/api-server');

const PORT = 31420;
let storeState;
let mockWindow;
let cache;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: PORT, path, method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function resetState(flights, overrides = {}) {
  storeState = {
    screen: 'editor',
    currentPath: '/test/flight_schedule_test.acl',
    currentAirport: 'ZSJN',
    flights: JSON.parse(JSON.stringify(flights)),
    before: '', after: '', arrayContent: '', originalBlocks: [],
    modified: false,
    _configStartTime: '06:00:00',
    _configEndTime: '22:00:00',
    isDemo: false,
    weatherTimeline: [],
    windTimeline: [],
    runwayTimeline: { initialRunways: [], timeline: [] },
    airportValues: {
      ZSJN: {
        Stand: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'],
        Runway: ['01', '19'],
        AircraftType: ['A320', 'B738', 'B772', 'B77W', 'A332', 'A333'],
        AirlineCode: ['CCA', 'CES', 'CSN', 'CHH', 'CDG', 'CSZ', 'CSC', 'CXA', 'CQH', 'CPA'],
        AirlineName: ['中国国航', '中国东方航空', '中国南方航空', '海南航空', '山东航空', '深圳航空', '四川航空', '厦门航空', '春秋航空', '国泰航空'],
        Voice: ['zh-CN-1', 'zh-CN-2'],
        Language: ['zh', 'en'],
        _flightNums: {
          CCA: ['1501','1502','1503','1504','1505','1506','1507','1508','1509','1510','1511','1512'],
          CES: ['5001','5002','5003','5004','5005'],
          CSN: ['3001','3002','3003','3004','3005'],
          CHH: ['7001','7002','7003'],
          CSZ: ['9001','9002'],
          CDG: ['4001','4002'],
          CPA: ['8001','8002','8003'],
        },
        _compat: {
          airlineToAircraft: {
            CCA: ['A320', 'B738', 'B772', 'A332'],
            CES: ['A320', 'B738', 'A333'],
            CSN: ['A320', 'B738', 'B77W'],
            CHH: ['B738', 'B772'],
            CSZ: ['A320', 'B738'],
            CDG: ['B738'],
            CPA: ['A332', 'A333', 'B77W'],
          },
        },
        _registrationMap: {
          'CCA|A320': ['B-1234', 'B-1235', 'B-1236'],
          'CCA|B738': ['B-5678', 'B-5679'],
          'CCA|B772': ['B-2001', 'B-2002'],
          'CCA|A332': ['B-3001', 'B-3002'],
          'CES|A320': ['B-4001', 'B-4002'],
          'CES|B738': ['B-5001', 'B-5002'],
          'CES|A333': ['B-6001'],
          'CSN|A320': ['B-7001', 'B-7002'],
          'CSN|B738': ['B-8001'],
          'CSN|B77W': ['B-9001'],
          'CPA|A332': ['B-HLK', 'B-HLL'],
          'CPA|A333': ['B-HLM', 'B-HLN'],
          'CPA|B77W': ['B-HLO'],
        },
      },
    },
    ...overrides,
  };
}

function buildMockWindow() {
  return {
    webContents: {
      executeJavaScript: async (code) => {
        if (code.includes('getState()')) return JSON.parse(JSON.stringify(storeState));
        return undefined;
      },
      send: (channel, data) => {
        if (channel === 'store-api-update') Object.assign(storeState, data);
      },
    },
  };
}

// ── Fixture ─────────────────────────────────────────────────────

const BASE_FLIGHTS = [
  { CallSign:'CCA1501',DepartureAirport:'',ArrivalAirport:'ZSJN',Stand:'G1',Runway:'01',OffBlockTime:'10:00:00',TakeoffTime:'10:05:00',LandingTime:'',InBlockTime:'',AirlineName:'中国国航',AircraftType:'A320',Airway:'',Registration:'B-1234',Voice:'zh-CN-1',Language:'zh' },
  { CallSign:'CCA1502',DepartureAirport:'',ArrivalAirport:'ZSJN',Stand:'G2',Runway:'01',OffBlockTime:'10:05:00',TakeoffTime:'10:10:00',LandingTime:'',InBlockTime:'',AirlineName:'中国国航',AircraftType:'B738',Airway:'',Registration:'B-5678',Voice:'zh-CN-1',Language:'zh' },
  { CallSign:'CES5001',DepartureAirport:'ZBAA',ArrivalAirport:'',Stand:'G3',Runway:'19',OffBlockTime:'',TakeoffTime:'',LandingTime:'10:30:00',InBlockTime:'10:35:00',AirlineName:'中国东方航空',AircraftType:'A320',Airway:'ABCD2B',Registration:'B-4001',Voice:'zh-CN-1',Language:'zh' },
  { CallSign:'CES5002',DepartureAirport:'ZSPD',ArrivalAirport:'',Stand:'G4',Runway:'19',OffBlockTime:'',TakeoffTime:'',LandingTime:'11:00:00',InBlockTime:'11:05:00',AirlineName:'中国东方航空',AircraftType:'B738',Airway:'EFGH3C',Registration:'B-5001',Voice:'zh-CN-1',Language:'zh' },
  { CallSign:'CSN3001',DepartureAirport:'',ArrivalAirport:'ZSJN',Stand:'G5',Runway:'01',OffBlockTime:'11:30:00',TakeoffTime:'11:35:00',LandingTime:'',InBlockTime:'',AirlineName:'中国南方航空',AircraftType:'A320',Airway:'',Registration:'B-7001',Voice:'zh-CN-1',Language:'zh' },
];

// ── Test Helpers ────────────────────────────────────────────────

let passed = 0, failed = 0;

function assert(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error('  FAIL:', label); }
}

function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
  else { failed++; console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function assertRange(actual, min, max, label) {
  if (actual >= min && actual <= max) { passed++; }
  else { failed++; console.error(`  FAIL: ${label} — expected ${min}–${max}, got ${actual}`); }
}

// ── E2E Tests ───────────────────────────────────────────────────

async function runTests() {
  console.log('\n═══ E2E Example Tests ═══\n');

  // ─── Example A: "Create 10 AAL departures" → adapted for ZSJN/CCA ───
  console.log('── Ex A: Create 10 CCA departures, 1 min apart, randomize aircraft ──');
  resetState(BASE_FLIGHTS);

  // Step 1: get_editor_status
  let r = await api('GET', '/api/status');
  assertEq(r.status, 200, 'A1: status 200');
  assert(r.body.editorReady, 'A1: editorReady');
  assertEq(r.body.flightCount, 5, 'A1: 5 initial flights');

  // Step 2: get_airport_info
  r = await api('GET', '/api/airport/values');
  assertEq(r.status, 200, 'A2: airport/values 200');
  assert(r.body.constraints.airlineCode.includes('CCA'), 'A2: CCA in constraints');

  // Step 3: construct 3 CCA departures 1 min apart
  const newFlights = [];
  for (let i = 0; i < 3; i++) {
    const num = `150${i + 3}`; // 1503, 1504, 1505
    const minute = 12 + i;
    const aircraft = ['A320', 'B738', 'B772'][i % 3];
    const reg = { A320: 'B-1235', B738: 'B-5679', B772: 'B-2001' }[aircraft];
    newFlights.push({
      CallSign: `CCA${num}`, DepartureAirport: '', ArrivalAirport: 'ZSJN',
      Stand: `G${6 + i}`, Runway: '01',
      OffBlockTime: `12:0${minute}:00`, TakeoffTime: `12:0${minute + 5}:00`,
      LandingTime: '', InBlockTime: '',
      AirlineName: '中国国航', AircraftType: aircraft, Airway: '',
      Registration: reg, Voice: 'zh-CN-1', Language: 'zh',
    });
  }

  // Step 4: create_flights
  r = await api('POST', '/api/flights/create-batch', { flights: newFlights });
  assertEq(r.status, 200, 'A4: created OK');
  assertEq(r.body.created, 3, 'A4: created 3');

  // Step 5: get_flights to verify
  r = await api('GET', '/api/flights?airline=CCA&type=departure&limit=20');
  assertEq(r.status, 200, 'A5: get OK');
  assertEq(r.body.total, 5, 'A5: 5 CCA departures (2 original + 3 new)');

  // Step 6: get_validation_issues
  r = await api('GET', '/api/validation');
  assertEq(r.status, 200, 'A6: validation OK');
  assertEq(r.body.duplicateCallsigns.length, 0, 'A6: no dup callsigns');

  // ─── Example B: "Change all CCA flights to runway 19" ───
  console.log('── Ex B: Change all CCA flights to runway 19 ──');
  resetState(BASE_FLIGHTS);

  r = await api('GET', '/api/status');
  assertEq(r.body.flightCount, 5, 'B0: 5 flights');

  r = await api('PATCH', '/api/flights/batch', {
    match: { airline: 'CCA' },
    updates: { Runway: '19' },
  });
  assertEq(r.status, 200, 'B1: patch OK');
  assertEq(r.body.matched, 2, 'B1: matched 2 CCA flights');
  assertEq(r.body.modified, 2, 'B1: modified 2');

  r = await api('GET', '/api/flights?airline=CCA&limit=10');
  const all19 = r.body.flights.every(f => f.Runway === '19');
  assert(all19, 'B2: all CCA now on runway 19');

  // ─── Example C: "Delete all CES arrivals before 12:00" ───
  console.log('── Ex C: Delete CES arrivals before 12:00 ──');
  resetState(BASE_FLIGHTS);

  r = await api('GET', '/api/flights?airline=CES&type=arrival');
  assertEq(r.body.total, 2, 'C1: 2 CES arrivals');
  const toDelete = r.body.flights.filter(f => f.LandingTime < '12:00:00');
  assertEq(toDelete.length, 2, 'C2: both before 12:00');

  r = await api('POST', '/api/flights/delete-batch', {
    match: { callsigns: toDelete.map(f => f.CallSign) },
  });
  assertEq(r.status, 200, 'C3: delete OK');
  assertEq(r.body.deleted, 2, 'C3: deleted 2');

  r = await api('GET', '/api/status');
  assertEq(r.body.flightCount, 3, 'C4: 3 flights remain');
  assertEq(r.body.arrivalCount, 0, 'C4: 0 arrivals left');

  // ─── Example D: "Batch shift CCA departure times by +30 min" ───
  console.log('── Ex D: Shift CCA departures +30 minutes ──');
  resetState(BASE_FLIGHTS);

  r = await api('GET', '/api/flights?airline=CCA&type=departure');
  assertEq(r.body.total, 2, 'D1: 2 CCA departures');
  const ccaFlights = r.body.flights;

  // Shift each by +30 min
  for (const f of ccaFlights) {
    const offMin = parseInt(f.OffBlockTime.substring(0,2)) * 60 + parseInt(f.OffBlockTime.substring(3,5)) + 30;
    const takeMin = parseInt(f.TakeoffTime.substring(0,2)) * 60 + parseInt(f.TakeoffTime.substring(3,5)) + 30;
    const pad = m => `${String(Math.floor(m / 60) % 24).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}:00`;
    r = await api('PATCH', '/api/flights/batch', {
      match: { callsigns: [f.CallSign] },
      updates: { OffBlockTime: pad(offMin), TakeoffTime: pad(takeMin) },
    });
    assertEq(r.status, 200, `D2: ${f.CallSign} shifted OK`);
  }

  r = await api('GET', '/api/flights?airline=CCA&type=departure');
  const shifted = r.body.flights;
  assert(shifted[0].OffBlockTime >= '10:30:00', 'D3: first flight shifted to >= 10:30');
  assert(shifted[1].OffBlockTime >= '10:35:00', 'D3: second flight shifted to >= 10:35');

  // ─── Chinese Example E (示例D): "创建3个国航出发航班" ───
  console.log('── Ex E (中文): 创建3个国航出发航班 ──');
  resetState(BASE_FLIGHTS);

  // Simulate: user says "创建3个国航出发航班，12:00开始每2分钟一个"
  // LLM resolves: 国航→CCA, departure type, 12:00 start
  // LLM uses get_airport_info constraints to pick valid (aircraft, reg) combos
  const zhAircraft = ['A320', 'B738', 'A320'];
  const zhRegs = ['B-1235', 'B-5679', 'B-1236']; // from _registrationMap for each (CCA|type) pair
  const zhFlights = [];
  for (let i = 0; i < 3; i++) {
    zhFlights.push({
      CallSign: `CCA150${6 + i}`, DepartureAirport: '', ArrivalAirport: 'ZSJN',
      Stand: `G${6 + i}`, Runway: '01',
      OffBlockTime: `12:0${i * 2}:00`, TakeoffTime: `12:0${i * 2 + 5}:00`,
      LandingTime: '', InBlockTime: '',
      AirlineName: '中国国航', AircraftType: zhAircraft[i], Airway: '',
      Registration: zhRegs[i], Voice: 'zh-CN-1', Language: 'zh',
    });
  }
  r = await api('POST', '/api/flights/create-batch', { flights: zhFlights });
  assertEq(r.status, 200, 'E1: created OK (中文)');
  assertEq(r.body.created, 3, 'E1: 3 created');

  r = await api('GET', '/api/status');
  assertEq(r.body.flightCount, 8, 'E2: 8 total flights');

  // ─── Chinese Example F (示例E): "把所有国航改成01跑道" ───
  console.log('── Ex F (中文): 把所有国航航班改成01跑道 ──');

  // CCA flights are on runway 19 after the shift test? No, this is a fresh state.
  // First make one CCA flight use runway 19, then change all to 01
  resetState(BASE_FLIGHTS);
  // CCA1501 already on 01, CCA1502 already on 01 — all CCA are already on 01
  // Let's first change them to 19, then back to 01

  r = await api('PATCH', '/api/flights/batch', {
    match: { airline: 'CCA' },
    updates: { Runway: '19' },
  });
  assertEq(r.status, 200, 'F1: changed to 19');

  r = await api('PATCH', '/api/flights/batch', {
    match: { airline: 'CCA' },
    updates: { Runway: '01' },
  });
  assertEq(r.status, 200, 'F2: changed back to 01');
  assertEq(r.body.matched, 2, 'F2: 2 flights matched (中文: "把所有国航")');
  assert(r.body.modified >= 2, 'F2: flights modified');

  // Verify all CCA on 01
  r = await api('GET', '/api/flights?airline=CCA');
  assert(r.body.flights.every(f => f.Runway === '01'), 'F3: all CCA on 01');

  // ─── Example G: Validation rejection → LLM recovers ───
  console.log('── Ex G: Validation rejection and recovery ──');
  resetState(BASE_FLIGHTS);

  r = await api('POST', '/api/flights/create-batch', {
    flights: [{
      CallSign: 'XXX9999', DepartureAirport: '', ArrivalAirport: 'ZSJN',
      Stand: 'G99', Runway: '99', OffBlockTime: '25:00:00', TakeoffTime: '24:00:00',
      LandingTime: '', InBlockTime: '', AirlineName: 'Fake',
      AircraftType: 'CONC', Airway: '', Registration: 'BAD',
      Voice: 'xx', Language: 'xx',
    }],
  });
  assertEq(r.status, 422, 'G1: rejected with 422');
  assert(r.body.error && r.body.error.code === 'VALIDATION_FAILED', 'G1: VALIDATION_FAILED');
  const details = r.body.error.details;
  assert(details.some(d => d.issue === 'unknown_airline_code'), 'G1: unknown airline');
  assert(details.some(d => d.issue === 'invalid_stand'), 'G1: invalid stand');
  assert(details.some(d => d.issue === 'invalid_runway'), 'G1: invalid runway');
  assert(details.some(d => d.issue === 'time_after_range'), 'G1: time out of range');
  assert(details.some(d => d.issue === 'time_order'), 'G1: time order');
  console.log(`     ${details.length} validation issues correctly detected`);

  // LLM recovers: fix all issues
  r = await api('POST', '/api/flights/create-batch', {
    flights: [{
      CallSign: 'CCA1512', DepartureAirport: '', ArrivalAirport: 'ZSJN',
      Stand: 'G10', Runway: '01', OffBlockTime: '14:00:00', TakeoffTime: '14:05:00',
      LandingTime: '', InBlockTime: '', AirlineName: '中国国航',
      AircraftType: 'A320', Airway: '', Registration: 'B-1236',
      Voice: 'zh-CN-1', Language: 'zh',
    }],
  });
  assertEq(r.status, 200, 'G2: fixed flight accepted');
  assertEq(r.body.created, 1, 'G2: 1 created after fix');

  // ─── Summary ───
  console.log(`\n${passed} passed, ${failed} failed\n`);
}

// ── Bootstrap ───────────────────────────────────────────────────

mockWindow = buildMockWindow();

// Airport cache — seeded from the same values in the store state fixture
// (the API server reads constraints from the cache, not the store)
const ZSJN_DROPDOWN = {
  Stand: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'],
  Runway: ['01', '19'],
  AircraftType: ['A320', 'B738', 'B772', 'B77W', 'A332', 'A333'],
  AirlineCode: ['CCA', 'CES', 'CSN', 'CHH', 'CDG', 'CSZ', 'CSC', 'CXA', 'CQH', 'CPA'],
  AirlineName: ['中国国航', '中国东方航空', '中国南方航空', '海南航空', '山东航空', '深圳航空', '四川航空', '厦门航空', '春秋航空', '国泰航空'],
  Voice: ['zh-CN-1', 'zh-CN-2'],
  Language: ['zh', 'en'],
  _flightNums: {
    CCA: ['1501','1502','1503','1504','1505','1506','1507','1508','1509','1510','1511','1512'],
    CES: ['5001','5002','5003','5004','5005'],
    CSN: ['3001','3002','3003','3004','3005'],
    CHH: ['7001','7002','7003'],
    CSZ: ['9001','9002'],
    CDG: ['4001','4002'],
    CPA: ['8001','8002','8003'],
  },
  _compat: {
    airlineToAircraft: {
      CCA: ['A320', 'B738', 'B772', 'A332'],
      CES: ['A320', 'B738', 'A333'],
      CSN: ['A320', 'B738', 'B77W'],
      CHH: ['B738', 'B772'],
      CSZ: ['A320', 'B738'],
      CDG: ['B738'],
      CPA: ['A332', 'A333', 'B77W'],
    },
  },
  _registrationMap: {
    'CCA|A320': ['B-1234', 'B-1235', 'B-1236'],
    'CCA|B738': ['B-5678', 'B-5679'],
    'CCA|B772': ['B-2001', 'B-2002'],
    'CCA|A332': ['B-3001', 'B-3002'],
    'CES|A320': ['B-4001', 'B-4002'],
    'CES|B738': ['B-5001', 'B-5002'],
    'CES|A333': ['B-6001'],
    'CSN|A320': ['B-7001', 'B-7002'],
    'CSN|B738': ['B-8001'],
    'CSN|B77W': ['B-9001'],
    'CPA|A332': ['B-HLK', 'B-HLL'],
    'CPA|A333': ['B-HLM', 'B-HLN'],
    'CPA|B77W': ['B-HLO'],
  },
};

cache = {
  ZSJN: {
    dropdownValues: ZSJN_DROPDOWN,
    approachData: {
      runwayStarMap: {
        '01': ['ABCD1A', 'ABCD2B', 'EFGH2B'],
        '19': ['EFGH3C', 'IJKL4D', 'MNOP5E'],
      },
      starRunwayMap: {
        'ABCD1A': ['01'], 'ABCD2B': ['01'], 'EFGH2B': ['01'],
        'EFGH3C': ['19'], 'IJKL4D': ['19'], 'MNOP5E': ['19'],
      },
    },
    audioCallsigns: {
      byAirline: { CCA: ['CCA1501','CCA1502'], CES: ['CES5001','CES5002'], CSN: ['CSN3001'] },
      allCallsigns: [],
      allAirlines: ['CCA', 'CES', 'CSN'],
    },
  },
};
startServer(mockWindow, PORT, () => cache);

setTimeout(async () => {
  try {
    resetState(BASE_FLIGHTS);
    await runTests();
  } catch (err) {
    console.error('Test error:', err);
    failed++;
  } finally {
    stopServer();
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
}, 200);
