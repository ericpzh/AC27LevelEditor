# AC27 UDP Telemetry Pipeline

## Table of Contents

- [Architecture](#architecture)
- [Binary Protocol (Inbound Telemetry, Port 20266)](#binary-protocol-inbound-telemetry-port-20266)
- [Trail Ring Buffer](#trail-ring-buffer)
- [Command Channel (Outbound, Port 20267)](#command-channel-outbound-port-20267)
- [Live State Push to Map Windows](#live-state-push-to-map-windows)
- [Public API (`electron/udp_listener.js` exports)](#public-api-electronudp_listenerjs-exports)
- [IPC Exposure](#ipc-exposure)

## Architecture

`electron/udp_listener.js` (271 lines) is the UDP telemetry engine that bridges the running game's live aircraft data into the Level Editor.

```
┌──────────────────────┐    10 Hz UDP (20266)     ┌──────────────────────┐
│  AC27 Game (Playtest) │ ──────────────────────→ │  electron/udp_       │
│  AircraftUdpTelemetry │                          │  listener.js         │
│  Service              │ ←────────────────────── │                      │
└──────────────────────┘     UDP commands (20267)  │  aircraftMap         │
                                                   │  trailSnapshots      │
                                                   │  currentAirport      │
                                                   └──────────┬───────────┘
                                                              │ 200ms interval
                                                   ┌──────────▼───────────┐
                                                   │  ipcMain → all open  │
                                                   │  map windows         │
                                                   │  'udp-aircraft-state'│
                                                   └──────────────────────┘
```

## Binary Protocol (Inbound Telemetry, Port 20266)

Packets from the game arrive at ~10 Hz. Format: 40-byte header + N × 112-byte records.

**Header (40 bytes, little-endian):**

| Offset | Type | Field | Notes |
|--------|------|-------|-------|
| 0 | u32 | magic | `0x43544147` = ASCII `"GATC"` |
| 4 | u16 | version | Currently `2` (v2 adds `controlSeat`/`seatSequence`/`telemetryStatus` at record offsets 21-23, `simFlags`/`timeScale`/`heartbeatSeq` at header offsets 32-35) |
| 6 | u16 | headerSize | Always `40` — record data starts here |
| 8 | u16 | recordSize | Always `112` — stride per record |
| 10 | u16 | recordCount | Number of records in this packet |
| 12 | 4B | airportIcao | ASCII uppercase (4 chars) |
| 16 | u64 | simTick | Simulation tick (60 Hz) |
| 24 | i64 | simTimeUnixMs | Sim time in Unix milliseconds |
| 32 | u8 | simFlags | bit 0=isPaused, bit 1=isStarted, bit 2=hasLevel, bits 3-7 reserved |
| 33 | u8 | timeScale | Current game speed multiplier; `0` = unknown |
| 34 | u16 | heartbeatSeq | Increments per datagram (wrapping) |
| 36 | 4B | reserved | Zero-filled |

**Record (112 bytes each, little-endian):**

| Offset | Type | Field | Notes |
|--------|------|-------|-------|
| 0 | 12B | callSign | Active segment callsign, ASCII zero-padded |
| 12 | 8B | aircraftType | ICAO designator (e.g. `B77W`, `A320`) |
| 20 | u8 | flightDirection | `0` = Departure, `1` = Arrival |
| 21 | u8 | controlSeat | `0`=None, `1`=Ramp, `2`=Ground, `3`=Tower, `4`=Departure, `5`=Approach, `6`=Delivery, `7`=Apron, `255`=Unknown. Drives parked/active determination. |
| 22 | u8 | seatSequence | 1-based order within seat; `0` = not participating, `255` = overflow |
| 23 | u8 | telemetryStatus | `0`=Unknown, `1`=Active, `2`=ActionRequired, `3`=HandoffPending, `4`=PendingAtStand, `5`=CompletedAtStand |
| 24 | f32×3 | position | Unity world coordinates (x, y, z) |
| 36 | f32×3 | noseDirection | Nose heading unit vector (x, y, z) |
| 48 | f32 | taxiSpeed | Ground taxi speed |
| 52 | f32 | airSpeedKnot | Airspeed in knots |
| 56 | 16B | star | STAR procedure name (blank for departures) |
| 72 | 4B | runway | Active runway designator |
| 76 | 8B | stand | Active stand identifier |
| 84 | 16B | route | Active route name (may include taxiway sequence) |

**Key receiver rules:**
- Use `headerSize` and `recordSize` from the header to locate records — never hardcode offsets
- Packets may be split: do not assume all aircraft for a tick are in one packet
- `recordCount` can be 0 (heartbeat-only packet carrying sim time)
- Reject packets with wrong magic or version

## Trail Ring Buffer

To render trailing dots on the AirMapWindow (historical positions), the listener maintains a `trailSnapshots` Map:

- **Per callsign:** Ring buffer of `{ x, z, simTick }` objects
- **Max 5 snapshots** per aircraft
- **Minimum 600-tick gap** between snapshots (~10 game-seconds at 60 Hz)
- Live position: `age: 0`, trail entries: `age: 10, 20, 30, 40, 50...` (age = approximate seconds old)
- Used by map windows to render shrinking circles with decreasing opacity

## Command Channel (Outbound, Port 20267)

The listener also sends fire-and-forget UDP commands to the game on `127.0.0.1:20267`.

- **`sendCommand(commandId, payloadBuf)`** → `Promise<{ success, error? }>`
- 8-byte header: magic (u32 LE, `0x43544147`) + version (u16 LE, `1`) + commandId (u16 LE)
- **Only supported command:** commandId=1 (`SelectAircraft`), 12-byte ASCII callSign payload (20B total datagram)
- No response expected — effect is observed through the telemetry stream
- Preload wraps this as `sendUdpCommand(commandId, callSign)` which base64-encodes a 12-byte callSign buffer

## Live State Push to Map Windows

- `startUdpListener()` called in `app.whenReady()` after `createWindow()`
- `setInterval` at 200ms reads `getUdpAircraftState()` and sends `udp-aircraft-state` IPC event to all open map windows (`groundMapWindows` + `airMapWindows` + `flightStripsWindows`)
- On `will-quit`, `stopUdpListener()` cleans up: closes socket, clears all intervals/timeouts, resets `aircraftMap`, `trailSnapshots`, etc.
- Auto-reconnect on socket errors with 2-second delay and logging

**Sprite index augmentation (v1.1.6):** Before pushing, each aircraft is augmented with a centralized `spriteIdx` (0–14) from `witchSpriteMap` (Map<callSign, index>). New callsigns get the next round-robin index (`witchSpriteNext % 15`). This guarantees all map windows (ground, air, flight strips) show the same witch-mode character for the same callsign. The `spriteIdx` field is merged into each aircraft object via `Object.assign({}, ac, { spriteIdx })` — the original state is not mutated.

**Auto-reset mechanisms (stale-data protection):**
- **5-second stale timeout:** If `Date.now() - lastPacketTime > 5000`, `getUdpAircraftState()` auto-clears all aircraft state before returning. This prevents stale aircraft from lingering on radar/strip views when the game crashes or disconnects.
- **`hasLevel` transition:** When `simFlags` bit 2 transitions from 0→1 (game loads/changes level), all aircraft state is auto-cleared. The `lastHasLevel` flag is tracked per-transition — staying at 1 does not re-trigger. `resetAircraftState()` also resets `lastHasLevel` to false so the next level load triggers again.
- **Airport transition (v1.1.6):** The listener tracks `lastAirport` (previous packet's ICAO). When the airport code changes to a different valid code (e.g., user loads a different airport in-game), `aircraftMap` and `trailSnapshots` are auto-cleared immediately in the message handler. `getUdpStatus()` now returns `lastAirport` alongside `currentAirport`. The renderer-side `useUdpAircraftState` hook detects the transition via `udpAirportChanged` (true for one render) and each map window triggers `resetUdpAircraft()` + (for flight strips) `loadFlightData()` when the new airport matches the window's ICAO.
- **All mechanisms** operate inside `getUdpAircraftState()` and the message handler, so the 200ms push interval automatically benefits with no renderer-side changes needed.

## Public API (`electron/udp_listener.js` exports)

| Export | Returns | Description |
|--------|---------|-------------|
| `start()` | void | Bind socket, begin parsing packets |
| `stop()` | void | Close socket, clear intervals, reset state |
| `getUdpStatus()` | `{ connected, lastPacketTime, currentAirport, lastAirport, simFlags, heartbeatSeq }` | Current health status + v2 header fields; `lastAirport` tracks previous packet's ICAO for transition detection |
| `getUdpAircraftState()` | `{ aircraft: [], currentAirport, recordCount, simTimeUnixMs, simFlags, timeScale }` | Latest aircraft positions + trails + sim time + v2 header flags |
| `resetAircraftState()` | void | Clear all aircraft state (`aircraftMap` + `trailSnapshots` + `lastHasLevel`) — used by map window refresh button |
| `sendCommand(cmdId, payloadBuf)` | `Promise<{ success, error? }>` | Fire-and-forget command to game |

## IPC Exposure

- `get-udp-status` handler → `getUdpStatus()` — now also returns `simFlags` and `heartbeatSeq` from v2 header
- `get-udp-aircraft-state` handler → `getUdpAircraftState()` — now also returns `simFlags` and `timeScale`; auto-clears aircraft if >5s since last packet
- `reset-udp-aircraft` handler → `resetAircraftState()` — clears stale aircraft after game level restart; also resets `lastHasLevel` so next `hasLevel` 0→1 transition triggers again
- `send-udp-command` handler → base64-decodes `payloadB64` → `sendCommand(commandId, buf)`
