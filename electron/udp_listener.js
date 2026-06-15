/**
 * UDP Telemetry Engine — parses live aircraft telemetry from the game.
 *
 * Listens on 127.0.0.1:20266 for binary UDP packets (10 Hz from the game)
 * formatted per public/udp_aircraft_telemetry.md.  Sends SelectAircraft
 * commands to 127.0.0.1:20267 per public/udp_remote_control.md.
 */

const dgram = require('dgram');

// ─── Module state ────────────────────────────────────────────────

let socket = null;
let lastPacketTime = 0;
let currentAirport = null;
const aircraftMap = new Map();   // callsign → latest telemetry record
const trailSnapshots = new Map(); // callsign → [{x, z, simTick}, ...] ring buffer, max 5

const RECONNECT_DELAY_MS = 2000;
const TRAIL_TICK_GAP = 600; // 10 game-seconds at 60Hz
const MAX_TRAIL = 5;
let reconnectTimer = null;
let logInterval = null;
let lastSimTimeUnixMs = 0; // latest simTimeUnixMs from header
let packetCount = 0;
let firstPacketLogged = false;

// ─── Binary parsing ──────────────────────────────────────────────

const MAGIC = 0x43544147; // ASCII "GATC"

/**
 * Parse a single telemetry datagram.
 * Per udp_aircraft_telemetry.md: little-endian, 40B header + N×112B records.
 */
function parseDatagram(buf) {
  if (buf.length < 40) return null;

  const magic = buf.readUInt32LE(0);
  if (magic !== MAGIC) return null;

  const version = buf.readUInt16LE(4);
  const headerSize = buf.readUInt16LE(6);
  const recordSize = buf.readUInt16LE(8);
  const recordCount = buf.readUInt16LE(10);

  // airportIcao at offset 12, 4 bytes ASCII
  let icao = '';
  for (let i = 12; i < 16; i++) {
    const b = buf[i];
    if (b === 0) break;
    icao += String.fromCharCode(b);
  }

  // simTick at offset 16 (u64), simTimeUnixMs at offset 24 (i64)
  const records = [];
  for (let i = 0; i < recordCount; i++) {
    const off = headerSize + i * recordSize;
    if (off + recordSize > buf.length) break;

    const callSign = buf.toString('ascii', off, off + 12).replace(/\0/g, '').trim();
    const aircraftType = buf.toString('ascii', off + 12, off + 20).replace(/\0/g, '').trim();
    const flightDirection = buf.readUInt8(off + 20); // 0=Departure, 1=Arrival
    // 3B reserved at offset 21

    const posX = buf.readFloatLE(off + 24);
    const posY = buf.readFloatLE(off + 28);
    const posZ = buf.readFloatLE(off + 32);

    const noseX = buf.readFloatLE(off + 36);
    const noseY = buf.readFloatLE(off + 40);
    const noseZ = buf.readFloatLE(off + 44);

    const taxiSpeed = buf.readFloatLE(off + 48);
    const airSpeedKnot = buf.readFloatLE(off + 52);

    let star = '';
    for (let j = 0; j < 16; j++) { const b = buf[off + 56 + j]; if (b === 0) break; star += String.fromCharCode(b); }
    star = star.trim();

    let runway = '';
    for (let j = 0; j < 4; j++) { const b = buf[off + 72 + j]; if (b === 0) break; runway += String.fromCharCode(b); }
    runway = runway.trim();

    let stand = '';
    for (let j = 0; j < 8; j++) { const b = buf[off + 76 + j]; if (b === 0) break; stand += String.fromCharCode(b); }
    stand = stand.trim();

    let route = '';
    for (let j = 0; j < 16; j++) { const b = buf[off + 84 + j]; if (b === 0) break; route += String.fromCharCode(b); }
    route = route.trim();

    records.push({
      callSign, aircraftType, flightDirection,
      position: { x: posX, y: posY, z: posZ },
      noseDirection: { x: noseX, y: noseY, z: noseZ },
      taxiSpeed, airSpeedKnot,
      star, runway, stand, route,
    });
  }

  return { icao, records };
}

// ─── Socket lifecycle ─────────────────────────────────────────────

function bindSocket() {
  if (socket) {
    try { socket.close(); } catch (_) {}
    socket = null;
  }

  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (err) {
    console.log('[UDP] createSocket failed:', err.message);
    scheduleReconnect();
    return;
  }

  socket.on('message', (buf) => {
    lastPacketTime = Date.now();
    packetCount++;
    const result = parseDatagram(buf);
    if (!result) return;

    if (!firstPacketLogged) {
      firstPacketLogged = true;
      console.log('[UDP] First packet received — airport:', result.icao, 'records:', result.records.length);
    }

    if (result.icao) currentAirport = result.icao;

    // Read simTimeUnixMs from header (offset 24, i64 little-endian)
    if (buf.length >= 32) {
      const simTimeUnixMs = Number(buf.readBigInt64LE(24));
      if (!isNaN(simTimeUnixMs) && simTimeUnixMs > 0) {
        lastSimTimeUnixMs = simTimeUnixMs;
      }
    }

    // Read simTick from header (offset 16, u64 little-endian)
    const simTick = buf.readBigUInt64LE
      ? Number(buf.readBigUInt64LE(16))
      : buf.readUInt32LE(16) + buf.readUInt32LE(20) * 0x100000000;

    // Update aircraft and trail queue
    for (const r of result.records) {
      if (!r.callSign) continue;
      aircraftMap.set(r.callSign, r);

      let snaps = trailSnapshots.get(r.callSign);
      if (!snaps) { snaps = []; trailSnapshots.set(r.callSign, snaps); }

      // If this position is TRAIL_TICK_GAP ahead of the queue head, push & pop
      if (snaps.length === 0 || simTick - snaps[0].simTick >= TRAIL_TICK_GAP) {
        snaps.unshift({ x: r.position.x, y: r.position.y, z: r.position.z, simTick });
        if (snaps.length > MAX_TRAIL) snaps.length = MAX_TRAIL;
      }
    }
    if (packetCount === 0) console.log('[UDP] trail queue started, gap=' + TRAIL_TICK_GAP + 'ticks max=' + MAX_TRAIL);
  });

  socket.on('error', (err) => {
    console.log('[UDP] socket error:', err.message);
    if (socket) { try { socket.close(); } catch (_) {} }
    socket = null;
    currentAirport = null;
    scheduleReconnect();
  });

  socket.bind(20266, '127.0.0.1', () => {
    console.log('[UDP] listening on 127.0.0.1:20266');
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[UDP] attempting reconnect...');
    bindSocket();
  }, RECONNECT_DELAY_MS);
}

function start() {
  console.log('[UDP] starting listener...');
  bindSocket();
  // 10-second decoded message log
  if (logInterval) clearInterval(logInterval);
  logInterval = setInterval(() => {
    const aircraft = Array.from(aircraftMap.values());
    const secs = Math.round((Date.now() - (lastPacketTime || Date.now())) / 1000);
    console.log('[UDP] ── 10s snapshot — pkts:' + packetCount +
      ' airport:' + (currentAirport || 'none') +
      ' aircraft:' + aircraft.length +
      ' lastPkt:' + secs + 's ago ──');
    // if (aircraft.length === 0) return;
    // for (const a of aircraft) {
    //   console.log('[UDP]   ' + a.callSign +
    //     ' dir=' + (a.flightDirection === 0 ? 'DEP' : 'ARR') +
    //     ' pos=(' + a.position.x.toFixed(1) + ',' + a.position.y.toFixed(1) + ',' + a.position.z.toFixed(1) + ')' +
    //     ' ias=' + a.airSpeedKnot.toFixed(0) + 'kt' +
    //     (a.star ? ' star=' + a.star : '') +
    //     (a.stand ? ' stand=' + a.stand : ''));
    // }
  }, 10000);
}

function stop() {
  if (logInterval) { clearInterval(logInterval); logInterval = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) {
    try { socket.close(); } catch (_) {}
    socket = null;
  }
  aircraftMap.clear();
  trailSnapshots.clear();
  currentAirport = null;
  lastPacketTime = 0;
  lastSimTimeUnixMs = 0;
  packetCount = 0;
  firstPacketLogged = false;
  console.log('[UDP] stopped');
}

// ─── Public API ───────────────────────────────────────────────────

function getUdpStatus() {
  const connected = socket !== null && (Date.now() - lastPacketTime) < 2000;
  return {
    connected,
    lastPacketTime,
    currentAirport,
  };
}

function getUdpAircraftState() {
  const aircraft = Array.from(aircraftMap.values()).map(a => {
    const snaps = trailSnapshots.get(a.callSign) || [];
    // Live position as age=0, then queue entries as age=10,20,30,40,50...
    const trail = [{ x: a.position.x, y: a.position.y, z: a.position.z, age: 0 }];
    for (let i = 0; i < snaps.length; i++) {
      trail.push({ x: snaps[i].x, y: snaps[i].y, z: snaps[i].z, age: (i + 1) * 10 });
    }
    return { ...a, trail };
  });
  return { aircraft, currentAirport, recordCount: aircraftMap.size, simTimeUnixMs: lastSimTimeUnixMs };
}

/**
 * Send a command to the game on 127.0.0.1:20267.
 * Per udp_remote_control.md: 8B header (magic + version + commandId) + payload.
 * Fire-and-forget — no response.
 */
function resetAircraftState() {
  aircraftMap.clear();
  trailSnapshots.clear();
  console.log('[UDP] aircraft state reset');
}

function sendCommand(commandId, payloadBuf) {
  return new Promise((resolve) => {
    if (!socket) {
      resolve({ success: false, error: 'UDP socket not active' });
      return;
    }

    const header = Buffer.alloc(8);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt16LE(1, 4);       // version
    header.writeUInt16LE(commandId, 6);

    const packet = Buffer.concat([header, payloadBuf]);

    socket.send(packet, 0, packet.length, 20267, '127.0.0.1', (err) => {
      if (err) {
        console.log('[UDP] sendCommand error:', err.message);
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true });
      }
    });
  });
}

module.exports = { start, stop, getUdpStatus, getUdpAircraftState, resetAircraftState, sendCommand };
