/**
 * Integration test for electron/api-server.js
 *
 * Tests all 7 HTTP API endpoints with mocked Electron mainWindow
 * and airportCache. Uses Node.js built-in http module.
 *
 * Usage: node tests/integration/test_api_server.js
 */

const http = require('http');
const { startServer, stopServer, validateFlightObjects, buildConstraints, applyCascades, parseTimeSeconds, isArrival, handleMcpMessage, MCP_TOOLS } = require('../../electron/api-server');

const PORT = 31416; // use different port from default 31415

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; }
  else { failed++; console.error('  FAIL:', label); }
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
  else { failed++; console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function assertStatus(status, body, expectedStatus, label) {
  if (status === expectedStatus) { passed++; }
  else {
    failed++;
    const errMsg = body && body.error ? (typeof body.error === 'string' ? body.error : JSON.stringify(body.error)) : JSON.stringify(body);
    console.error(`  FAIL: ${label} — expected ${expectedStatus}, got ${status} (${errMsg})`);
  }
}

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1', port: PORT, path, method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(options, (res) => {
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

// ── Mock Data ───────────────────────────────────────────────────

const MOCK_FLIGHTS = [
  { CallSign: 'AAL1001', DepartureAirport: '', ArrivalAirport: 'KJFK', Stand: 'G1', Runway: '04L', OffBlockTime: '10:00:00', TakeoffTime: '10:05:00', LandingTime: '', InBlockTime: '', AirlineName: 'American Airlines', AircraftType: 'A320', Airway: '', Registration: 'N123AB', Voice: 'en-US-1', Language: 'en' },
  { CallSign: 'CCA1501', DepartureAirport: 'ZBAA', ArrivalAirport: '', Stand: 'G2', Runway: '04R', OffBlockTime: '', TakeoffTime: '', LandingTime: '10:30:00', InBlockTime: '10:35:00', AirlineName: 'Air China', AircraftType: 'B738', Airway: 'ABCD2B', Registration: 'B-1234', Voice: 'zh-CN-1', Language: 'zh' },
];

const MOCK_AIRPORT_CACHE = {
  KJFK: {
    dropdownValues: {
      Stand: ['G1', 'G2', 'G3', 'G4', 'G5', 'G10'],
      Runway: ['04L', '04R', '22L', '22R'],
      AircraftType: ['A320', 'B738', 'B772', 'B77W'],
      AirlineCode: ['AAL', 'CCA', 'DAL', 'JBU'],
      AirlineName: ['American Airlines', 'Air China', 'Delta Air Lines', 'JetBlue'],
      Voice: ['en-US-1', 'zh-CN-1'],
      Language: ['en', 'zh'],
      _flightNums: { AAL: ['1001', '1002', '1003'], CCA: ['1501', '1502'], DAL: ['2001'], JBU: ['301'] },
      _compat: {
        airlineToAircraft: {
          AAL: ['A320', 'B738', 'B772'],
          CCA: ['A320', 'B738', 'B77W'],
          DAL: ['A320', 'B738'],
          JBU: ['A320'],
        },
      },
      _registrationMap: {
        'AAL|A320': ['N123AB', 'N456CD'],
        'AAL|B738': ['N789EF'],
        'CCA|B738': ['B-1234', 'B-5678'],
        'CCA|B77W': ['B-9999'],
        'DAL|A320': ['N111DL'],
        'JBU|A320': ['N222JB'],
      },
    },
    approachData: {
      runwayStarMap: {
        '04L': ['ABCD1A', 'EFGH2B'],
        '04R': ['ABCD2B', 'EFGH3C'],
        '22L': ['IJKL4D'],
        '22R': ['MNOP5E'],
      },
    },
    audioCallsigns: {
      byAirline: { AAL: ['AAL1001', 'AAL1002'], CCA: ['CCA1501'], DAL: ['DAL2001'], JBU: ['JBU301'] },
      allCallsigns: [],
      allAirlines: [],
    },
  },
};

// Create a mock Electron mainWindow with mutable store state
function createMockWindow(initialState) {
  let storeState = JSON.parse(JSON.stringify(initialState));
  return {
    webContents: {
      executeJavaScript: async (code) => {
        if (code.includes('getState()')) return JSON.parse(JSON.stringify(storeState));
        return undefined;
      },
      send: (channel, data) => {
        // Apply store-api-update to our mutable state so subsequent reads see changes
        if (channel === 'store-api-update') {
          Object.assign(storeState, data);
        }
      },
    },
  };
}

// ── Unit Tests (pure functions) ─────────────────────────────────

console.log('\n── Unit Tests ──\n');

// parseTimeSeconds
assertEqual(parseTimeSeconds('10:00:00'), 36000, 'parseTimeSeconds 10:00:00');
assertEqual(parseTimeSeconds('10:00'), 36000, 'parseTimeSeconds 10:00 (shorthand)');
assert(Number.isNaN(parseTimeSeconds('')), 'parseTimeSeconds empty → NaN');
assert(Number.isNaN(parseTimeSeconds(null)), 'parseTimeSeconds null → NaN');

// isArrival
assert(isArrival({ LandingTime: '10:00:00', OffBlockTime: '' }), 'isArrival with LandingTime');
assert(!isArrival({ LandingTime: '', OffBlockTime: '10:00:00' }), 'isArrival with OffBlockTime');
assert(!isArrival({ LandingTime: '   ', OffBlockTime: '' }), 'isArrival with whitespace LandingTime');

// buildConstraints
const state = {
  currentAirport: 'KJFK',
  _configStartTime: '06:00:00',
  _configEndTime: '22:00:00',
};
const c = buildConstraints(state, MOCK_AIRPORT_CACHE);
assert(c.knownCodes.has('AAL'), 'constraints has AAL');
assert(c.knownCodes.has('CCA'), 'constraints has CCA');
assertEqual(c.stands, ['G1', 'G2', 'G3', 'G4', 'G5', 'G10'], 'constraints stands');
assertEqual(c.airlineAircraftCompat['AAL'], ['A320', 'B738', 'B772'], 'constraints AAL compat');
assertEqual(c.runwayStarCompat['04L'], ['ABCD1A', 'EFGH2B'], 'constraints runway→STAR');
assertEqual(c.registrationsByPair['AAL|A320'], ['N123AB', 'N456CD'], 'constraints registrations');

// validateFlightObjects — valid flight
const validFlight = {
  CallSign: 'AAL1002', DepartureAirport: '', ArrivalAirport: 'KJFK',
  Stand: 'G3', Runway: '04L', OffBlockTime: '11:00:00', TakeoffTime: '11:05:00',
  LandingTime: '', InBlockTime: '', AirlineName: 'American Airlines',
  AircraftType: 'A320', Airway: '', Registration: 'N456CD',
  Voice: 'en-US-1', Language: 'en',
};
const issues1 = validateFlightObjects([validFlight], MOCK_FLIGHTS, c);
assert(issues1 === null, 'valid flight passes validation');

// validateFlightObjects — unknown airline
const badAirline = { ...validFlight, CallSign: 'XXX9999' };
const issues2 = validateFlightObjects([badAirline], MOCK_FLIGHTS, c);
assert(issues2 !== null, 'unknown airline rejected');
assert(issues2.some(i => i.issue === 'unknown_airline_code'), 'issue type is unknown_airline_code');

// validateFlightObjects — invalid stand
const badStand = { ...validFlight, Stand: 'G99' };
const issues3 = validateFlightObjects([badStand], MOCK_FLIGHTS, c);
assert(issues3 !== null && issues3.some(i => i.issue === 'invalid_stand'), 'invalid stand rejected');

// validateFlightObjects — incompatible aircraft
const badAircraft = { ...validFlight, AircraftType: 'B77W' }; // B77W not in AAL compat
const issues4 = validateFlightObjects([badAircraft], MOCK_FLIGHTS, c);
assert(issues4 !== null && issues4.some(i => i.issue === 'incompatible_aircraft'), 'incompatible aircraft rejected');

// validateFlightObjects — invalid registration
const badReg = { ...validFlight, Registration: 'B-9999' }; // not in AAL|A320 list
const issues5 = validateFlightObjects([badReg], MOCK_FLIGHTS, c);
assert(issues5 !== null && issues5.some(i => i.issue === 'invalid_registration'), 'invalid registration rejected');

// validateFlightObjects — duplicate callsign
const dupCall = { ...validFlight, CallSign: 'AAL1001' }; // already exists
const issues6 = validateFlightObjects([dupCall], MOCK_FLIGHTS, c);
assert(issues6 !== null && issues6.some(i => i.issue === 'duplicate_callsign'), 'duplicate callsign rejected');

// validateFlightObjects — stand conflict (two deps same stand)
const conflictFlight = { ...validFlight, CallSign: 'DAL2001', Stand: 'G1' }; // G1 has AAL1001 departure
const issues7 = validateFlightObjects([conflictFlight], MOCK_FLIGHTS, c);
assert(issues7 !== null && issues7.some(i => i.issue === 'stand_conflict'), 'stand conflict rejected');

// validateFlightObjects — time out of range
const badTime = { ...validFlight, CallSign: 'DAL2001', OffBlockTime: '25:00:00' };
const issues8 = validateFlightObjects([badTime], MOCK_FLIGHTS, c);
assert(issues8 !== null && issues8.some(i => i.issue === 'time_after_range'), 'time after range rejected');

// validateFlightObjects — time order (OffBlock >= Takeoff)
const badOrder = { ...validFlight, CallSign: 'DAL2001', OffBlockTime: '11:05:00', TakeoffTime: '11:00:00' };
const issues9 = validateFlightObjects([badOrder], MOCK_FLIGHTS, c);
assert(issues9 !== null && issues9.some(i => i.issue === 'time_order'), 'time order rejected');

// applyCascades — AirlineCode change
const cascaded1 = applyCascades(
  { ...MOCK_FLIGHTS[0] },
  { AirlineCode: 'DAL' },
  c
);
assertEqual(cascaded1.CallSign, 'DAL1001', 'cascade AirlineCode: CallSign rebuilt');
assertEqual(cascaded1.AircraftType, 'A320', 'cascade AirlineCode: AircraftType to first DAL compat');
assertEqual(cascaded1.Registration, 'N111DL', 'cascade AirlineCode: Registration to first DAL A320 reg');

// applyCascades — FlightNum change
const cascaded2 = applyCascades(
  { ...MOCK_FLIGHTS[0] },
  { FlightNum: '9999' },
  c
);
assertEqual(cascaded2.CallSign, 'AAL9999', 'cascade FlightNum: CallSign rebuilt');

// applyCascades — Runway change
const arrFlight = { ...MOCK_FLIGHTS[1] }; // CCA1501 arrival on 04R with ABCD2B
const cascaded3 = applyCascades(
  arrFlight,
  { Runway: '04L' },
  c
);
assertEqual(cascaded3.Airway, 'ABCD1A', 'cascade Runway: Airway to first STAR for 04L');

// ── MCP SSE Tests (handleMcpMessage) ────────────────────────────

async function runMcpTests() {
  console.log('\n── MCP SSE Tests ──\n');

  // initialize
  const initRes = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert(initRes.jsonrpc === '2.0' && initRes.id === 1, 'MCP: initialize has correct jsonrpc/id');
  assert(initRes.result.protocolVersion === '2024-11-05', 'MCP: initialize protocol version');
  assert(initRes.result.capabilities.tools !== undefined, 'MCP: initialize has tools capability');
  assertEqual(initRes.result.serverInfo.name, 'ac27-editor-mcp', 'MCP: initialize server name');

  // tools/list
  const toolsRes = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert(Array.isArray(toolsRes.result.tools), 'MCP: tools/list returns array');
  assertEqual(toolsRes.result.tools.length, 7, 'MCP: 7 tools');
  const toolNames = toolsRes.result.tools.map(t => t.name);
  assert(toolNames.includes('create_flights'), 'MCP: create_flights');
  assert(toolNames.includes('get_flights'), 'MCP: get_flights');
  assert(toolNames.includes('modify_flights'), 'MCP: modify_flights');
  assert(toolNames.includes('delete_flights'), 'MCP: delete_flights');
  assert(toolNames.includes('get_editor_status'), 'MCP: get_editor_status');
  assert(toolNames.includes('get_airport_info'), 'MCP: get_airport_info');
  assert(toolNames.includes('get_validation_issues'), 'MCP: get_validation_issues');
  const createTool = toolsRes.result.tools.find(t => t.name === 'create_flights');
  assert(createTool.inputSchema.required.includes('flights'), 'MCP: create_flights requires flights');
  assert(createTool.inputSchema.properties.flights.items.required.length === 15, 'MCP: create_flights has 15 required fields');

  // tools/call status + airport_info
  const statusCall = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_editor_status', arguments: {} } });
  if (!statusCall.result || !statusCall.result.content) {
    console.error('  MCP statusCall error:', JSON.stringify(statusCall).substring(0, 300));
    assert(false, 'MCP: status returned error: ' + (statusCall.error ? statusCall.error.message : 'unknown'));
  } else {
    const statusData = JSON.parse(statusCall.result.content[0].text);
    assert(statusData.success === true && statusData.editorReady === true, 'MCP: status editorReady');
  }

  const infoCall = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_airport_info', arguments: {} } });
  const infoData = JSON.parse(infoCall.result.content[0].text);
  assert(infoData.cacheReady === true, 'MCP: airport_info cacheReady');

  // tools/call — get_flights
  const getCall = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_flights', arguments: { type: 'departure' } } });
  const getData = JSON.parse(getCall.result.content[0].text);
  assert(getData.success === true && getData.total >= 1, 'MCP: get_flights');

  // tools/call — create_flights (valid)
  const createCall = await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_flights', arguments: { flights: [{
    CallSign: 'JBU301', DepartureAirport: '', ArrivalAirport: 'KJFK', Stand: 'G10', Runway: '04L',
    OffBlockTime: '15:00:00', TakeoffTime: '15:05:00', LandingTime: '', InBlockTime: '',
    AirlineName: 'JetBlue', AircraftType: 'A320', Airway: '', Registration: 'N222JB',
    Voice: 'en-US-1', Language: 'en',
  }]}}});
  const createData = JSON.parse(createCall.result.content[0].text);
  if (createData.created !== 1) {
    console.error('  MCP create response:', JSON.stringify(createData));
  }
  assert(createData.created === 1, 'MCP: create_flights created');

  // tools/call — create_flights (invalid → error)
  const badCall = await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_flights', arguments: { flights: [{
    CallSign: 'XXX9999', DepartureAirport: '', ArrivalAirport: 'KJFK', Stand: 'G99', Runway: '99',
    OffBlockTime: '25:00:00', TakeoffTime: '24:00:00', LandingTime: '', InBlockTime: '',
    AirlineName: 'Fake', AircraftType: 'CONC', Airway: '', Registration: 'BAD', Voice: 'xx', Language: 'xx',
  }]}}});
  const badData = JSON.parse(badCall.result.content[0].text);
  assert(badData.success === false, 'MCP: invalid create rejected');
  assert(badData.error.code === 'VALIDATION_FAILED', 'MCP: validation failed');

  // tools/call — unknown tool
  const unknownCall = await handleMcpMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nonexistent', arguments: {} } });
  assert(unknownCall.error && unknownCall.error.code === -32601, 'MCP: unknown tool code -32601');

  // MCP_TOOLS static check
  assert(MCP_TOOLS.every(t => t.name && t.description && t.inputSchema), 'MCP: all tools have name+description+schema');
}

// ── Integration Tests (HTTP server) ─────────────────────────────

console.log('\n── Integration Tests (HTTP) ──\n');

const MOCK_STORE_STATE = {
  screen: 'editor',
  currentPath: '/test/flight_schedule_test.acl',
  currentAirport: 'KJFK',
  flights: MOCK_FLIGHTS,
  before: '', after: '', arrayContent: '', originalBlocks: [],
  modified: false,
  selectedIndices: [0],
  searchMatches: [],
  highlightedCells: [],
  _configStartTime: '06:00:00',
  _configEndTime: '22:00:00',
  isDemo: false,
  weatherTimeline: [],
  windTimeline: [],
  runwayTimeline: { initialRunways: [], timeline: [] },
};

async function runIntegrationTests() {
  const mockWindow = createMockWindow(MOCK_STORE_STATE);

  // Start server with mock window
  startServer(mockWindow, PORT, () => MOCK_AIRPORT_CACHE);
  await new Promise(r => setTimeout(r, 100)); // wait for server to start

  try {
    // ── GET /api/status ──
    const status = await apiRequest('GET', '/api/status');
    assertEqual(status.status, 200, 'GET /api/status → 200');
    assert(status.body.success === true, 'status: success');
    assert(status.body.editorReady === true, 'status: editorReady');
    assertEqual(status.body.flightCount, 2, 'status: flightCount=2');
    assertEqual(status.body.arrivalCount, 1, 'status: arrivalCount=1');
    assertEqual(status.body.departureCount, 1, 'status: departureCount=1');

    // ── GET /api/airport/values ──
    const info = await apiRequest('GET', '/api/airport/values');
    assertEqual(info.status, 200, 'GET /api/airport/values → 200');
    assert(info.body.success === true, 'airport/values: success');
    assert(info.body.cacheReady === true, 'airport/values: cacheReady');
    assertEqual(info.body.currentAirport, 'KJFK', 'airport/values: currentAirport');
    assert(info.body.constraints.flatLists.Stand.length > 0, 'airport/values: has stands');
    assert(info.body.constraints.airlineAircraftCompat.AAL.length > 0, 'airport/values: has compat data');
    assert(info.body.constraints.runwayStarCompat['04L'].length > 0, 'airport/values: has runway→STAR');

    // ── GET /api/flights ──
    const flights1 = await apiRequest('GET', '/api/flights');
    assertEqual(flights1.status, 200, 'GET /api/flights → 200');
    assertEqual(flights1.body.total, 2, 'flights: total=2');

    const flights2 = await apiRequest('GET', '/api/flights?type=departure');
    assertEqual(flights2.body.total, 1, 'flights type=departure: total=1');

    const flights3 = await apiRequest('GET', '/api/flights?airline=AAL');
    assertEqual(flights3.body.total, 1, 'flights airline=AAL: total=1');

    // ── POST /api/flights/create-batch (valid) ──
    const create1 = await apiRequest('POST', '/api/flights/create-batch', {
      flights: [{
        CallSign: 'DAL2001', DepartureAirport: '', ArrivalAirport: 'KJFK',
        Stand: 'G5', Runway: '22L', OffBlockTime: '12:00:00', TakeoffTime: '12:05:00',
        LandingTime: '', InBlockTime: '', AirlineName: 'Delta Air Lines',
        AircraftType: 'A320', Airway: '', Registration: 'N111DL',
        Voice: 'en-US-1', Language: 'en',
      }],
    });
    assertEqual(create1.status, 200, 'POST create-batch (valid) → 200');
    assertEqual(create1.body.created, 1, 'create-batch: created=1');

    // ── POST /api/flights/create-batch (invalid — 422) ──
    const create2 = await apiRequest('POST', '/api/flights/create-batch', {
      flights: [{
        CallSign: 'XXX9999', DepartureAirport: '', ArrivalAirport: 'KJFK',
        Stand: 'G99', Runway: '99', OffBlockTime: '25:00:00', TakeoffTime: '24:00:00',
        LandingTime: '', InBlockTime: '', AirlineName: 'Fake Airline',
        AircraftType: 'B747', Airway: '', Registration: 'FAKE-01',
        Voice: 'xx-XX', Language: 'xx',
      }],
    });
    assertEqual(create2.status, 422, 'POST create-batch (invalid) → 422');
    assert(create2.body.success === false, 'invalid create: success=false');
    assert(create2.body.error && create2.body.error.code === 'VALIDATION_FAILED', 'invalid create: VALIDATION_FAILED');
    assert(create2.body.error.details.length > 0, 'invalid create: has details');
    console.log('  Validation errors:', create2.body.error.details.length, 'issues found');

    // ── POST /api/flights/create-batch (missing fields) ──
    const create3 = await apiRequest('POST', '/api/flights/create-batch', {
      flights: [{ CallSign: 'AAL9999' }], // only 1 field
    });
    assertEqual(create3.status, 422, 'POST create-batch (missing fields) → 422');
    assert(create3.body.error.details.some(d => d.issue === 'missing_field'), 'missing fields detected');

    // ── PATCH /api/flights/batch ──
    const patch1 = await apiRequest('PATCH', '/api/flights/batch', {
      match: { callsigns: ['AAL1001'] },
      updates: { Stand: 'G4' }, // G4 is free — no conflict with DAL2001 on G5
    });
    assertEqual(patch1.status, 200, 'PATCH batch → 200');
    assertEqual(patch1.body.matched, 1, 'patch: matched=1');
    assertEqual(patch1.body.modified, 1, 'patch: modified=1');

    // ── GET /api/validation ──
    const val1 = await apiRequest('GET', '/api/validation');
    assertEqual(val1.status, 200, 'GET /api/validation → 200');
    assert(val1.body.success === true, 'validation: success');

    // ── POST /api/flights/delete-batch ──
    const del1 = await apiRequest('POST', '/api/flights/delete-batch', {
      match: { callsigns: ['DAL2001'] },
    });
    assertStatus(del1.status, del1.body, 200, 'POST delete-batch → 200');
    if (del1.status === 200) {
      assertEqual(del1.body.deleted, 1, 'delete: deleted=1');
    }

    // ── POST /api/flights/delete-batch (not found) ──
    const del2 = await apiRequest('POST', '/api/flights/delete-batch', {
      match: { callsigns: ['NONEXISTENT'] },
    });
    assertStatus(del2.status, del2.body, 404, 'POST delete-batch (not found) → 404');

    // ── 404 for unknown endpoint ──
    const unknown = await apiRequest('GET', '/api/nonexistent');
    assertEqual(unknown.status, 404, 'GET unknown endpoint → 404');

    // Run MCP protocol tests last (may mutate state)
    await runMcpTests();

  } finally {
    stopServer();
  }
}

// ── AND-Match Regression Tests ──────────────────────────────────
// Verifies that match criteria in modify_flights and delete_flights
// use AND semantics (all criteria must match), not OR.

const AND_MATCH_FLIGHTS = [
  // AAL arrival
  { CallSign: 'AAL3001', DepartureAirport: 'EGLL', ArrivalAirport: '', Stand: 'G1', Runway: '04R', OffBlockTime: '', TakeoffTime: '', LandingTime: '08:00:00', InBlockTime: '08:05:00', AirlineName: 'American Airlines', AircraftType: 'A320', Airway: 'ABCD2B', Registration: 'N123AB', Voice: 'en-US-1', Language: 'en' },
  // AAL departure
  { CallSign: 'AAL3002', DepartureAirport: '', ArrivalAirport: 'KJFK', Stand: 'G2', Runway: '04L', OffBlockTime: '09:00:00', TakeoffTime: '09:05:00', LandingTime: '', InBlockTime: '', AirlineName: 'American Airlines', AircraftType: 'A320', Airway: '', Registration: 'N456CD', Voice: 'en-US-1', Language: 'en' },
  // CCA arrival
  { CallSign: 'CCA3001', DepartureAirport: 'ZBAA', ArrivalAirport: '', Stand: 'G3', Runway: '04R', OffBlockTime: '', TakeoffTime: '', LandingTime: '10:00:00', InBlockTime: '10:05:00', AirlineName: 'Air China', AircraftType: 'B738', Airway: 'ABCD2B', Registration: 'B-1234', Voice: 'zh-CN-1', Language: 'zh' },
  // CCA departure
  { CallSign: 'CCA3002', DepartureAirport: '', ArrivalAirport: 'KJFK', Stand: 'G4', Runway: '04L', OffBlockTime: '11:00:00', TakeoffTime: '11:05:00', LandingTime: '', InBlockTime: '', AirlineName: 'Air China', AircraftType: 'B738', Airway: '', Registration: 'B-5678', Voice: 'zh-CN-1', Language: 'zh' },
];

async function runAndMatchTests() {
  console.log('\n── AND-Match Regression Tests ──\n');

  const storeState = {
    screen: 'editor',
    currentPath: '/test/and_match_test.acl',
    currentAirport: 'KJFK',
    flights: AND_MATCH_FLIGHTS,
    before: '', after: '', arrayContent: '', originalBlocks: [],
    modified: false,
    selectedIndices: [],
    searchMatches: [],
    highlightedCells: [],
    _configStartTime: '06:00:00',
    _configEndTime: '22:00:00',
    isDemo: false,
    weatherTimeline: [], windTimeline: [], runwayTimeline: { initialRunways: [], timeline: [] },
  };

  const mockWindow = createMockWindow(storeState);
  startServer(mockWindow, PORT, () => MOCK_AIRPORT_CACHE);
  await new Promise(r => setTimeout(r, 100));

  try {
    // ── Test 1: modify_flights with airline+type AND-match ──
    // {airline:"AAL", type:"arrival"} should match ONLY AAL3001 (1 flight),
    // not AAL3002 (AAL departure), not CCA3001 (CCA arrival), not CCA3002 (CCA departure).
    const patchRes = await apiRequest('PATCH', '/api/flights/batch', {
      match: { airline: 'AAL', type: 'arrival' },
      updates: { DepartureAirport: 'ZGGG' },
    });
    assertStatus(patchRes.status, patchRes.body, 200, 'AND-match modify: HTTP 200');
    assertEqual(patchRes.body.matched, 1, 'AND-match modify: matched=1 (only AAL arrival)');
    assert(patchRes.body.modified >= 1, 'AND-match modify: modified >= 1');

    // Verify only AAL3001 was changed, others untouched
    const flightsAfterModify = await apiRequest('GET', '/api/flights');
    const aalArr = flightsAfterModify.body.flights.find(f => f.CallSign === 'AAL3001');
    const aalDep = flightsAfterModify.body.flights.find(f => f.CallSign === 'AAL3002');
    const ccaArr = flightsAfterModify.body.flights.find(f => f.CallSign === 'CCA3001');
    const ccaDep = flightsAfterModify.body.flights.find(f => f.CallSign === 'CCA3002');

    assertEqual(aalArr.DepartureAirport, 'ZGGG', 'AND-match modify: AAL arrival DepartureAirport → ZGGG');
    assertEqual(aalDep.DepartureAirport, '', 'AND-match modify: AAL departure DepartureAirport STILL empty');
    assertEqual(ccaArr.DepartureAirport, 'ZBAA', 'AND-match modify: CCA arrival DepartureAirport UNCHANGED (ZBAA)');
    assertEqual(ccaDep.DepartureAirport, '', 'AND-match modify: CCA departure DepartureAirport STILL empty');

    // ── Test 2: delete_flights with airline+type AND-match ──
    // {airline:"CCA", type:"departure"} should delete ONLY CCA3002 (1 flight).
    const delRes = await apiRequest('POST', '/api/flights/delete-batch', {
      match: { airline: 'CCA', type: 'departure' },
    });
    assertStatus(delRes.status, delRes.body, 200, 'AND-match delete: HTTP 200');
    assertEqual(delRes.body.deleted, 1, 'AND-match delete: deleted=1 (only CCA departure)');

    // Verify CCA arrival still exists
    const flightsAfterDelete = await apiRequest('GET', '/api/flights');
    assertEqual(flightsAfterDelete.body.total, 3, 'AND-match delete: 3 flights remain');
    const ccaArr2 = flightsAfterDelete.body.flights.find(f => f.CallSign === 'CCA3001');
    assert(ccaArr2 !== undefined, 'AND-match delete: CCA arrival STILL present');
    const ccaDep2 = flightsAfterDelete.body.flights.find(f => f.CallSign === 'CCA3002');
    assert(ccaDep2 === undefined, 'AND-match delete: CCA departure GONE');

    // ── Test 3: delete_flights with type-only (no airline) still works ──
    // {type:"arrival"} should match BOTH remaining arrivals (AAL3001 + CCA3001).
    const delTypeOnly = await apiRequest('POST', '/api/flights/delete-batch', {
      match: { type: 'arrival' },
    });
    assertStatus(delTypeOnly.status, delTypeOnly.body, 200, 'AND-match delete type-only: HTTP 200');
    assertEqual(delTypeOnly.body.deleted, 2, 'AND-match delete type-only: deleted=2 (both arrivals)');

    // Only AAL departure should remain
    const flightsFinal = await apiRequest('GET', '/api/flights');
    assertEqual(flightsFinal.body.total, 1, 'AND-match delete type-only: 1 flight remains');
    assertEqual(flightsFinal.body.flights[0].CallSign, 'AAL3002', 'AND-match delete type-only: remaining is AAL departure');

    // ── Test 4: MCP modify_flights AND-match ──
    // Re-seed the store by stopping/restarting with fresh data
    stopServer();
    const mockWindow2 = createMockWindow(JSON.parse(JSON.stringify(storeState)));
    startServer(mockWindow2, PORT, () => MOCK_AIRPORT_CACHE);
    await new Promise(r => setTimeout(r, 100));

    const mcpModifyRes = await handleMcpMessage({
      jsonrpc: '2.0', id: 50, method: 'tools/call',
      params: { name: 'modify_flights', arguments: {
        match: { airline: 'AAL', type: 'arrival' },
        updates: { Stand: 'G10' },
      }},
    });
    const mcpModifyData = JSON.parse(mcpModifyRes.result.content[0].text);
    assert(mcpModifyData.success === true, 'MCP AND-match modify: success');
    assertEqual(mcpModifyData.matched, 1, 'MCP AND-match modify: matched=1 (only AAL arrival, not AAL dep + not CCA arrivals)');

    // ── Test 5: MCP delete_flights AND-match ──
    const mcpDeleteRes = await handleMcpMessage({
      jsonrpc: '2.0', id: 51, method: 'tools/call',
      params: { name: 'delete_flights', arguments: {
        match: { airline: 'CCA', type: 'departure' },
      }},
    });
    const mcpDeleteData = JSON.parse(mcpDeleteRes.result.content[0].text);
    assert(mcpDeleteData.success === true, 'MCP AND-match delete: success');
    assertEqual(mcpDeleteData.deleted, 1, 'MCP AND-match delete: deleted=1 (only CCA departure, not CCA arrival)');

    console.log('  All AND-match regression tests passed.');
  } finally {
    stopServer();
  }
}

// ── Run ─────────────────────────────────────────────────────────

runIntegrationTests().then(async () => {
  // Run AND-match tests after integration tests (needs its own server instance)
  await runAndMatchTests();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
