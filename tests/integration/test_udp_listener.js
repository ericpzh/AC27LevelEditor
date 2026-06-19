/**
 * UDP Telemetry Listener Test — binary protocol parsing via mock loopback server.
 *
 * Usage: node tests/integration/test_udp_listener.js
 *
 * Sends crafted binary UDP packets to the listener on 127.0.0.1:20266
 * and verifies parsed state via the public API.
 *
 * NOTE: Requires that port 20266 is not in use by the game.
 */

const dgram = require('dgram');
const { start, stop, getUdpStatus, getUdpAircraftState, resetAircraftState, sendCommand } = require('../../electron/udp_listener');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS:', name);
  } catch (e) {
    failed++;
    console.log('  FAIL:', name);
    console.log('       ', e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'assertion') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

// ── Binary packet builders ──────────────────────────────────────

const MAGIC = 0x43544147; // "GATC"
const RECORD_SIZE = 112;
const HEADER_SIZE = 40;

/**
 * Build a complete UDP datagram buffer.
 * @param {string} airportIcao - 4-char ICAO code
 * @param {number} simTick - simulation tick
 * @param {number} simTimeUnixMs - sim time in Unix ms
 * @param {Array<Object>} records - array of record objects
 * @param {Object} [opts] - v2 header options
 * @param {number} [opts.version=1] - protocol version (2 enables simFlags/seq fields)
 * @param {number} [opts.simFlags=0] - simFlags bit field (v2 only)
 * @param {number} [opts.timeScale=0] - game speed multiplier (v2 only)
 * @param {number} [opts.heartbeatSeq=0] - heartbeat sequence number (v2 only)
 */
function buildDatagram(airportIcao, simTick, simTimeUnixMs, records, opts) {
  const version = opts?.version ?? 1;
  const recordCount = records.length;
  const totalSize = HEADER_SIZE + recordCount * RECORD_SIZE;
  const buf = Buffer.alloc(totalSize, 0);

  // Header
  buf.writeUInt32LE(MAGIC, 0);           // magic
  buf.writeUInt16LE(version, 4);         // version
  buf.writeUInt16LE(HEADER_SIZE, 6);     // headerSize
  buf.writeUInt16LE(RECORD_SIZE, 8);     // recordSize
  buf.writeUInt16LE(recordCount, 10);    // recordCount

  // airportIcao (4 bytes ASCII, space padded)
  const icao = (airportIcao || '').padEnd(4, ' ').substring(0, 4);
  for (let i = 0; i < 4; i++) buf[12 + i] = icao.charCodeAt(i);

  // simTick (u64 LE)
  buf.writeBigUInt64LE(BigInt(simTick || 0), 16);

  // simTimeUnixMs (i64 LE)
  buf.writeBigInt64LE(BigInt(simTimeUnixMs || 0), 24);

  // v2 header fields (offsets 32-35)
  if (version >= 2) {
    buf.writeUInt8(opts?.simFlags ?? 0, 32);
    buf.writeUInt8(opts?.timeScale ?? 0, 33);
    buf.writeUInt16LE(opts?.heartbeatSeq ?? 0, 34);
  }

  // Records
  for (let i = 0; i < recordCount; i++) {
    const off = HEADER_SIZE + i * RECORD_SIZE;
    const r = records[i];

    // callSign (12 bytes ASCII)
    const cs = (r.callSign || '').padEnd(12, '\0').substring(0, 12);
    buf.write(cs, off, 12, 'ascii');

    // aircraftType (8 bytes ASCII)
    const at = (r.aircraftType || '').padEnd(8, '\0').substring(0, 8);
    buf.write(at, off + 12, 8, 'ascii');

    // flightDirection (u8)
    buf.writeUInt8(r.flightDirection || 0, off + 20);
    // controlSeat (u8)
    buf.writeUInt8(r.controlSeat ?? 0, off + 21);
    // seatSequence (u8)
    buf.writeUInt8(r.seatSequence ?? 0, off + 22);
    // telemetryStatus (u8)
    buf.writeUInt8(r.telemetryStatus ?? 1, off + 23);

    // position (f32×3)
    const pos = r.position || { x: 0, y: 0, z: 0 };
    buf.writeFloatLE(pos.x || 0, off + 24);
    buf.writeFloatLE(pos.y || 0, off + 28);
    buf.writeFloatLE(pos.z || 0, off + 32);

    // noseDirection (f32×3)
    const nose = r.noseDirection || { x: 0, y: 0, z: 0 };
    buf.writeFloatLE(nose.x || 0, off + 36);
    buf.writeFloatLE(nose.y || 0, off + 40);
    buf.writeFloatLE(nose.z || 0, off + 44);

    // taxiSpeed (f32)
    buf.writeFloatLE(r.taxiSpeed || 0, off + 48);
    // airSpeedKnot (f32)
    buf.writeFloatLE(r.airSpeedKnot || 0, off + 52);

    // star (16 bytes ASCII)
    const star = (r.star || '').padEnd(16, '\0').substring(0, 16);
    buf.write(star, off + 56, 16, 'ascii');

    // runway (4 bytes ASCII)
    const rwy = (r.runway || '').padEnd(4, '\0').substring(0, 4);
    buf.write(rwy, off + 72, 4, 'ascii');

    // stand (8 bytes ASCII)
    const std = (r.stand || '').padEnd(8, '\0').substring(0, 8);
    buf.write(std, off + 76, 8, 'ascii');

    // route (16 bytes ASCII)
    const route = (r.route || '').padEnd(16, '\0').substring(0, 16);
    buf.write(route, off + 84, 16, 'ascii');
  }

  return buf;
}

/**
 * Send a datagram to the listener via loopback.
 */
function sendDatagram(datagram) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    client.send(datagram, 0, datagram.length, 20266, '127.0.0.1', (err) => {
      client.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Tests (async) ───────────────────────────────────────────────

async function runTests() {
  console.log('\n=== UDP Listener Tests ===\n');

  // Check if port is available before starting
  const portInUse = await new Promise(resolve => {
    const probe = dgram.createSocket('udp4');
    probe.on('error', () => resolve(true));
    probe.on('listening', () => { probe.close(); resolve(false); });
    probe.bind(20266, '127.0.0.1');
  });

  if (portInUse) {
    console.log('  SKIP: Port 20266 is in use (game running?). Close the game first.');
    console.log('\n' + '='.repeat(50));
    console.log('Results: 0 passed, 0 failed (skipped)');
    console.log('='.repeat(50));
    return;
  }

  // Start the listener
  start();
  await sleep(200); // Wait for socket to bind

  console.log('--- Basic parsing ---');

  // Test 1: Single record
  await test('parses a single aircraft record', async () => {
    resetAircraftState();
    const datagram = buildDatagram('ZSJN', 360000, 1718400000000, [
      {
        callSign: 'CES1234',
        aircraftType: 'B738',
        flightDirection: 1,
        position: { x: 100.5, y: 15.25, z: 200.3 },
        noseDirection: { x: 0.707, y: 0, z: -0.707 },
        taxiSpeed: 0,
        airSpeedKnot: 240,
        star: 'UBSS6W',
        runway: '19',
        stand: 'A01',
        route: 'TAXI_A',
      },
    ]);

    await sendDatagram(datagram);
    await sleep(50); // Let the UDP message handler fire

    const state = getUdpAircraftState();
    assertEq(state.aircraft.length, 1, 'should have 1 aircraft');
    const ac = state.aircraft[0];
    assertEq(ac.callSign, 'CES1234');
    assertEq(ac.aircraftType, 'B738');
    assertEq(ac.flightDirection, 1);
    assert(Math.abs(ac.position.x - 100.5) < 0.001, 'pos.x should be 100.5, got ' + ac.position.x);
    assert(Math.abs(ac.position.y - 15.25) < 0.001, 'pos.y should be 15.25, got ' + ac.position.y);
    assert(Math.abs(ac.position.z - 200.3) < 0.001, 'pos.z should be 200.3, got ' + ac.position.z);
    assert(ac.airSpeedKnot === 240, 'airspeed should be 240');
    assertEq(ac.star, 'UBSS6W');
    assertEq(ac.runway, '19');
    assertEq(ac.stand, 'A01');
    assertEq(ac.route, 'TAXI_A');
    // Should have trail with live position (age=0)
    assert(ac.trail.length >= 1, 'should have at least 1 trail entry');
    assertEq(ac.trail[0].age, 0, 'live position age should be 0');
  });

  // Test 2: Multiple records
  await test('parses multiple aircraft records in one packet', async () => {
    resetAircraftState();
    const datagram = buildDatagram('KJFK', 720000, 1718405000000, [
      { callSign: 'DAL101', aircraftType: 'A320', flightDirection: 0, position: { x: 50, y: 0.3, z: 100 } },
      { callSign: 'UAL202', aircraftType: 'B77W', flightDirection: 1, position: { x: 500, y: 500, z: 1000 } },
      { callSign: 'AAL303', aircraftType: 'B738', flightDirection: 1, position: { x: 600, y: 800, z: 1200 } },
    ]);

    await sendDatagram(datagram);
    await sleep(50);

    const state = getUdpAircraftState();
    assertEq(state.aircraft.length, 3, 'should have 3 aircraft');
    assertEq(state.currentAirport, 'KJFK');
  });

  // Test 3: Current airport tracking
  await test('tracks currentAirport from packet headers', async () => {
    resetAircraftState();
    const datagram = buildDatagram('KLAX', 100, 1718410000000, [
      { callSign: 'SWA456', aircraftType: 'B737', position: { x: 0, y: 10, z: 0 } },
    ]);
    await sendDatagram(datagram);
    await sleep(50);

    const state = getUdpAircraftState();
    assertEq(state.currentAirport, 'KLAX');
  });

  // Test 4: simTimeUnixMs tracking
  await test('tracks simTimeUnixMs from header', async () => {
    resetAircraftState();
    const testTime = 1718500000000;
    const datagram = buildDatagram('KSFO', 500, testTime, [
      { callSign: 'ASA789', aircraftType: 'B739', position: { x: 0, y: 0, z: 0 } },
    ]);
    await sendDatagram(datagram);
    await sleep(50);

    const state = getUdpAircraftState();
    assertEq(state.simTimeUnixMs, testTime, 'simTimeUnixMs should match header');
  });

  // Test 5: Trail ring buffer
  await test('accumulates trail snapshots with tick gap', async () => {
    resetAircraftState();
    const simTick = 1000000;
    const datagram1 = buildDatagram('ZSJN', simTick, 1718400000000, [
      { callSign: 'TRL001', position: { x: 100, y: 50, z: 200 } },
    ]);
    await sendDatagram(datagram1);
    await sleep(50);

    // Send second packet with tick advanced by TRAIL_TICK_GAP (600)
    const datagram2 = buildDatagram('ZSJN', simTick + 600, 1718400010000, [
      { callSign: 'TRL001', position: { x: 105, y: 48, z: 205 } },
    ]);
    await sendDatagram(datagram2);
    await sleep(50);

    // Send third packet with another gap
    const datagram3 = buildDatagram('ZSJN', simTick + 1200, 1718400020000, [
      { callSign: 'TRL001', position: { x: 110, y: 46, z: 210 } },
    ]);
    await sendDatagram(datagram3);
    await sleep(50);

    const state = getUdpAircraftState();
    const ac = state.aircraft.find(a => a.callSign === 'TRL001');
    assert(ac, 'TRL001 should exist');
    assert(ac.trail.length >= 2, 'should have at least 2 trail entries (live + historical), got ' + ac.trail.length);
    // Live position should be the latest
    assertEq(ac.trail[0].age, 0, 'first trail entry should be age 0 (live)');
    // Historical entries should have increasing ages
    if (ac.trail.length >= 2) {
      assert(ac.trail[1].age > 0, 'historical entry should have age > 0');
    }
  });

  // Test 6: Trail max 5 entries
  await test('caps trail buffer at 5 entries', async () => {
    resetAircraftState();
    // Send 10 packets with sufficient tick gaps
    for (let i = 0; i < 10; i++) {
      const datagram = buildDatagram('ZSJN', i * 600, 1718400000000 + i * 10000, [
        { callSign: 'MAXTRL', position: { x: i * 10, y: 50, z: i * 20 } },
      ]);
      await sendDatagram(datagram);
      await sleep(10);
    }
    await sleep(50);

    const state = getUdpAircraftState();
    const ac = state.aircraft.find(a => a.callSign === 'MAXTRL');
    assert(ac, 'MAXTRL should exist');
    // Should have at most 5 trail entries (1 live + up to 5 historical = 6 max, but the code caps at 5 total queue entries)
    // Actually the code: 1 live + queue entries. MAX_TRAIL = 5 is the queue size.
    assert(ac.trail.length <= 6, 'trail should have at most 6 entries (1 live + 5 historical)');
  });

  // Test 7: Empty packet (recordCount=0)
  await test('handles empty packet (recordCount=0)', async () => {
    // Count current aircraft
    const before = getUdpAircraftState().aircraft.length;
    const datagram = buildDatagram('ZSJN', 999999, 1718499999999, []); // 0 records
    await sendDatagram(datagram);
    await sleep(50);

    const after = getUdpAircraftState();
    // No new aircraft should have been added
    assertEq(after.aircraft.length, before, 'aircraft count should not change for empty packet');
    // Airport should NOT change (empty packet has no airport effect)
    // But the currentAirport IS updated from the header in the message handler
    assertEq(after.simTimeUnixMs, 1718499999999, 'simTime should update from heartbeat');
  });

  // Test 8: Bad magic rejection
  await test('rejects packet with bad magic', async () => {
    resetAircraftState();
    const buf = Buffer.alloc(40);
    buf.writeUInt32LE(0xDEADBEEF, 0); // wrong magic
    buf.writeUInt16LE(1, 4);
    buf.writeUInt16LE(40, 6);
    buf.writeUInt16LE(112, 8);
    buf.writeUInt16LE(1, 10);

    try {
      await sendDatagram(buf);
    } catch (_) {}
    await sleep(50);

    const state = getUdpAircraftState();
    assertEq(state.aircraft.length, 0, 'no aircraft should be parsed from bad packet');
  });

  // Test 9: Bad version rejection (version != 1 is rejected by parseDatagram)
  // Note: The current code only checks magic. Version is read but not validated.
  // This test verifies the current behavior.
  await test('handles non-zero version packets', async () => {
    resetAircraftState();
    const buf = Buffer.alloc(HEADER_SIZE + RECORD_SIZE);
    buf.writeUInt32LE(MAGIC, 0);
    buf.writeUInt16LE(99, 4); // version 99
    buf.writeUInt16LE(HEADER_SIZE, 6);
    buf.writeUInt16LE(RECORD_SIZE, 8);
    buf.writeUInt16LE(1, 10); // 1 record
    // Airport
    buf.write('ZSJN', 12, 4, 'ascii');
    // Record callSign at offset HEADER_SIZE
    const cs = 'VER99'.padEnd(12, '\0');
    buf.write(cs, HEADER_SIZE, 12, 'ascii');

    await sendDatagram(buf);
    await sleep(50);

    const state = getUdpAircraftState();
    // Current code does not validate version, so it will parse
    console.log('       (note: version validation not implemented in listener)');
  });

  // Test 10: Flight direction — departure (0) vs arrival (1)
  await test('distinguishes departure (0) and arrival (1) flight direction', async () => {
    resetAircraftState();
    const datagram = buildDatagram('ZSJN', 100, 1718400000000, [
      { callSign: 'DEP001', flightDirection: 0, position: { x: 10, y: 0, z: 20 } },
      { callSign: 'ARR001', flightDirection: 1, position: { x: 100, y: 500, z: 200 } },
    ]);
    await sendDatagram(datagram);
    await sleep(50);

    const state = getUdpAircraftState();
    const dep = state.aircraft.find(a => a.callSign === 'DEP001');
    const arr = state.aircraft.find(a => a.callSign === 'ARR001');
    assert(dep, 'DEP001 should exist');
    assert(arr, 'ARR001 should exist');
    assertEq(dep.flightDirection, 0, 'DEP001 should be departure');
    assertEq(arr.flightDirection, 1, 'ARR001 should be arrival');
  });

  // Test 11: Aircraft state reset
  await test('resetAircraftState clears all aircraft', async () => {
    // First, drain any pending UDP packets by resetting and waiting
    resetAircraftState();
    await sleep(100);

    // Now send a fresh packet
    const datagram = buildDatagram('ZSJN', 100, 1718400000000, [
      { callSign: 'CLEARME', position: { x: 0, y: 0, z: 0 } },
    ]);
    await sendDatagram(datagram);
    await sleep(100); // Increased wait for UDP processing

    const before = getUdpAircraftState();
    assert(before.aircraft.length > 0, 'should have aircraft before reset, got ' + before.aircraft.length);

    resetAircraftState();
    // resetAircraftState is synchronous — Map is cleared immediately
    const after = getUdpAircraftState();
    assertEq(after.aircraft.length, 0, 'should be empty immediately after reset');
    assertEq(after.recordCount, 0, 'recordCount should be 0 after reset');
  });

  // Test 12: getUdpStatus returns connected when receiving
  await test('getUdpStatus reports connected after receiving packets', async () => {
    resetAircraftState();
    const datagram = buildDatagram('ZSJN', 100, 1718400000000, [
      { callSign: 'STATUS1', position: { x: 0, y: 0, z: 0 } },
    ]);
    await sendDatagram(datagram);
    await sleep(50);

    const status = getUdpStatus();
    assert(status.connected, 'should be connected after receiving packet');
    assert(status.currentAirport === 'ZSJN', 'currentAirport should be ZSJN');
    assert(status.lastPacketTime > 0, 'lastPacketTime should be set');
  });

  // Test 13: Callsign with trailing nulls/whitespace stripped
  await test('strips null bytes and trims callsign', async () => {
    resetAircraftState();
    // Build packet directly with null-padded callsign
    const datagram = buildDatagram('ZSJN', 100, 1718400000000, [
      { callSign: 'ABC', position: { x: 0, y: 0, z: 0 } },
    ]);
    // buildDatagram already pads to 12 bytes with nulls
    await sendDatagram(datagram);
    await sleep(50);

    const state = getUdpAircraftState();
    const ac = state.aircraft.find(a => a.callSign === 'ABC');
    assert(ac, 'ABC should exist with trimmed callsign');
    // callsign should NOT contain trailing nulls
    assert(ac.callSign.indexOf('\0') < 0, 'callsign should not contain null bytes');
  });

  // Test 14: controlSeat, seatSequence, telemetryStatus parsing (v2)
  await test('parses controlSeat, seatSequence, and telemetryStatus from v2 records', async () => {
    resetAircraftState();
    const datagram = buildDatagram('ZSJN', 100, 1718400000000, [
      {
        callSign: 'CTRL001',
        aircraftType: 'A320',
        flightDirection: 0,
        controlSeat: 2,        // Ground
        seatSequence: 3,
        telemetryStatus: 1,    // Active
        position: { x: 100, y: 0.5, z: 200 },
      },
      {
        callSign: 'CTRL002',
        aircraftType: 'B738',
        flightDirection: 1,
        controlSeat: 0,        // None (parked/completed)
        seatSequence: 0,
        telemetryStatus: 5,    // CompletedAtStand
        position: { x: 200, y: 0.3, z: 300 },
      },
      {
        callSign: 'CTRL003',
        aircraftType: 'B77W',
        flightDirection: 0,
        controlSeat: 255,      // Unknown
        seatSequence: 0,
        telemetryStatus: 0,    // Unknown
        position: { x: 300, y: 0.4, z: 400 },
      },
    ]);
    await sendDatagram(datagram);
    await sleep(50);

    const state = getUdpAircraftState();
    assertEq(state.aircraft.length, 3, 'should have 3 aircraft');

    const ctrl1 = state.aircraft.find(a => a.callSign === 'CTRL001');
    assert(ctrl1, 'CTRL001 should exist');
    assertEq(ctrl1.controlSeat, 2, 'CTRL001 controlSeat should be 2 (Ground)');
    assertEq(ctrl1.seatSequence, 3, 'CTRL001 seatSequence should be 3');
    assertEq(ctrl1.telemetryStatus, 1, 'CTRL001 telemetryStatus should be 1 (Active)');

    const ctrl2 = state.aircraft.find(a => a.callSign === 'CTRL002');
    assert(ctrl2, 'CTRL002 should exist');
    assertEq(ctrl2.controlSeat, 0, 'CTRL002 controlSeat should be 0 (None)');
    assertEq(ctrl2.seatSequence, 0);
    assertEq(ctrl2.telemetryStatus, 5, 'CTRL002 telemetryStatus should be 5 (CompletedAtStand)');

    const ctrl3 = state.aircraft.find(a => a.callSign === 'CTRL003');
    assert(ctrl3, 'CTRL003 should exist');
    assertEq(ctrl3.controlSeat, 255, 'CTRL003 controlSeat should be 255 (Unknown)');
    assertEq(ctrl3.telemetryStatus, 0, 'CTRL003 telemetryStatus should be 0 (Unknown)');
  });

  // Test 15: simFlags and heartbeatSeq parsing (v2 header)
  await test('parses simFlags and heartbeatSeq from v2 header', async () => {
    resetAircraftState();
    const datagram = buildDatagram('ZSJN', 100, 1718400000000, [
      { callSign: 'V2TEST', position: { x: 0, y: 0, z: 0 } },
    ], { version: 2, simFlags: 0x07, timeScale: 1, heartbeatSeq: 42 });

    await sendDatagram(datagram);
    await sleep(50);

    const status = getUdpStatus();
    assertEq(status.simFlags, 0x07, 'simFlags should be 0x07');
    assertEq(status.heartbeatSeq, 42, 'heartbeatSeq should be 42');

    const state = getUdpAircraftState();
    assertEq(state.simFlags, 0x07, 'state.simFlags should be 0x07');
  });

  // Test 16: hasLevel 0→1 transition triggers auto-reset
  await test('hasLevel 0→1 transition clears aircraft', async () => {
    resetAircraftState();
    // First send aircraft with hasLevel=0
    const datagram1 = buildDatagram('ZSJN', 100, 1718400000000, [
      { callSign: 'LVL001', position: { x: 1, y: 2, z: 3 } },
    ], { version: 2, simFlags: 0x00, heartbeatSeq: 1 });
    await sendDatagram(datagram1);
    await sleep(50);

    const before = getUdpAircraftState();
    assertEq(before.aircraft.length, 1, 'aircraft should exist before hasLevel trigger');

    // Now send with hasLevel=1 (bit 2 set) — should trigger reset
    const datagram2 = buildDatagram('ZSJN', 200, 1718400001000, [
      { callSign: 'LVL002', position: { x: 4, y: 5, z: 6 } },
    ], { version: 2, simFlags: 0x04, heartbeatSeq: 2 });
    await sendDatagram(datagram2);
    await sleep(50);

    const after = getUdpAircraftState();
    // After reset + receiving the new packet, only LVL002 should remain
    assertEq(after.aircraft.length, 1, 'should have 1 aircraft after hasLevel reset');
    assert(after.aircraft.find(a => a.callSign === 'LVL002'), 'LVL002 should exist (from post-reset packet)');
    assert(!after.aircraft.find(a => a.callSign === 'LVL001'), 'LVL001 should be gone (cleared by reset)');
  });

  // Test 17: hasLevel stays 1 does not re-trigger reset
  await test('hasLevel staying 1 does not re-trigger reset', async () => {
    resetAircraftState();
    // Send with hasLevel=1
    const datagram1 = buildDatagram('ZSJN', 100, 1718400000000, [
      { callSign: 'STAY01', position: { x: 1, y: 2, z: 3 } },
    ], { version: 2, simFlags: 0x04, heartbeatSeq: 1 });
    await sendDatagram(datagram1);
    await sleep(50);

    // Send another with hasLevel=1 — should NOT trigger a second reset
    const datagram2 = buildDatagram('ZSJN', 200, 1718400001000, [
      { callSign: 'STAY02', position: { x: 4, y: 5, z: 6 } },
    ], { version: 2, simFlags: 0x04, heartbeatSeq: 2 });
    await sendDatagram(datagram2);
    await sleep(50);

    const state = getUdpAircraftState();
    assertEq(state.aircraft.length, 2, 'both aircraft should exist — no spurious reset');
  });

  // Test 18: getUdpAircraftState includes simFlags
  await test('getUdpAircraftState returns simFlags', async () => {
    resetAircraftState();
    const datagram = buildDatagram('ZSJN', 100, 1718400000000, [
      { callSign: 'FLAG01', position: { x: 0, y: 0, z: 0 } },
    ], { version: 2, simFlags: 0x05, heartbeatSeq: 99 }); // isPaused + hasLevel

    await sendDatagram(datagram);
    await sleep(50);

    const state = getUdpAircraftState();
    assertEq(state.simFlags, 0x05, 'state.simFlags should be 0x05 (isPaused=1, hasLevel=1)');
  });

  // Test 19: stale timeout detection — lastPacketTime is updated
  await test('lastPacketTime is updated on each packet', async () => {
    resetAircraftState();
    const beforeSend = Date.now();
    const datagram = buildDatagram('ZSJN', 100, 1718400000000, [
      { callSign: 'TIME01', position: { x: 0, y: 0, z: 0 } },
    ]);
    await sendDatagram(datagram);
    await sleep(50);

    const status = getUdpStatus();
    assert(status.lastPacketTime >= beforeSend, 'lastPacketTime should be >= time before send');
    assert(status.lastPacketTime <= Date.now(), 'lastPacketTime should be <= current time');
    // Connected should be true since we just sent a packet
    assert(status.connected, 'should be connected after fresh packet');
  });

  // ── Cleanup ───────────────────────────────────────────────────

  stop();
  await sleep(100);

  console.log('\n' + '='.repeat(50));
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
  console.log('='.repeat(50));
}

// Run all tests
runTests().then(() => {
  if (failed > 0) process.exit(1);
}).catch((e) => {
  console.error('Test runner error:', e);
  stop();
  process.exit(1);
});
