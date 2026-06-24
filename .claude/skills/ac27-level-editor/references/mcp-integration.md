# MCP / AI Agent Integration

## Architecture

```
Claude Code (LLM)                    AC27 Level Editor (Electron)
┌──────────────┐   stdio    ┌──────────────┐   HTTP    ┌──────────────────┐
│  MCP Client  │───────────→│ mcp/bridge.js│─────────→│ electron/        │
│  (built-in)  │←───────────│ (child proc) │←─────────│ api-server.js    │
└──────────────┘   JSON-RPC └──────────────┘  :31415  │ 7 tools, 12-pt   │
                                                       │ validation       │
                                                       └────────┬─────────┘
                                                                │ IPC
                                                       ┌────────▼─────────┐
                                                       │  Renderer Store   │
                                                       │  setLegacyState() │
                                                       │  → UI updates     │
                                                       └──────────────────┘
```

## Components

### `electron/api-server.js` (~800 lines)
- HTTP server on `127.0.0.1:31415` (auto-starts with app, stops on quit)
- 7 REST endpoints: `GET/POST/PATCH /api/*`
- `GET/POST /mcp` — MCP SSE endpoint + JSON-RPC handler
- `handleMcpMessage(msg)` — dispatches JSON-RPC to internal API functions (no HTTP round-trip)
- 12-point validation suite (`validateFlightObjects`) on every mutating call
- Exports for testing: `validateFlightObjects`, `buildConstraints`, `applyCascades`, `handleMcpMessage`, `MCP_TOOLS`

### `mcp/bridge.js` (~40 lines)
- Launched by Claude Code via `node mcp/bridge.js`
- Reads JSON-RPC from stdin, POSTs to `http://127.0.0.1:31415/mcp`
- Writes JSON-RPC responses to stdout
- Zero npm deps — Node.js built-ins only

### `electron/preload.js` — `store-api-update` bridge
- `onStoreApiUpdate(cb)` / `offStoreApiUpdate(cb)` — handler-map pattern
- Main process pushes `{ flights, modified, ... }` to renderer
- Renderer feeds into `setLegacyState()` for instant UI updates

### `src/App.jsx` — API store listener
- `useEffect` subscribes to `onStoreApiUpdate` in `ScreenRouter`
- Converts arrays back to Sets (`selectedIndices`, `searchMatches`, `highlightedCells`)
- Calls `setLegacyState()` to apply changes

### `.mcp.json` — Project-level MCP config
```json
{
  "mcpServers": {
    "ac27-editor": {
      "command": "node",
      "args": ["mcp/bridge.js"]
    }
  }
}
```

## 7 MCP Tools

| Tool | Purpose |
|------|---------|
| `create_flights` | Insert complete flight objects (15 fields each). Server validates all 12 constraints. |
| `get_flights` | Read flights with optional filters (type, airline, callsign, stand, runway, time range). |
| `modify_flights` | Update fields on matching flights. Cascade: AirlineCode → CallSign+AircraftType+Registration; Runway → Airway. |
| `delete_flights` | Delete matching flights by callsign, airline, type, stand, runway, or aircraft type. |
| `get_editor_status` | Current file, airport, flight counts, dirty flag, timeline status. |
| `get_airport_info` | Full constraint map: flatLists, airline codes, flight numbers, compat maps (airline→aircraft, runway→STAR, airline+aircraft→registration), time bounds. |
| `get_validation_issues` | Run 12-point validation on current flights. Returns structured issues. |

## Validation (12 checks)

1. All 15 fields present
2. Airline code known (from audio callsigns + dropdown values)
3. Flight number canonical (if airline has a list)
4. Stand in valid set
5. Runway in valid set
6. Aircraft compatible with airline (`_compat.airlineToAircraft`)
7. Airway/STAR compatible with runway (`_runwayStarMap`, arrivals only)
8. Registration valid for (airline, aircraft) pair (`_registrationMap`)
9. Time bounds within `[_configStartTime, _configEndTime]`
10. Time order (LandingTime < InBlockTime, OffBlockTime < TakeoffTime)
11. Duplicate callsigns
12. Stand conflicts + duplicate registrations

## Testing

```bash
# API server unit + HTTP integration + MCP protocol (85 tests)
node tests/integration/test_api_server.js

# E2E composition examples from skill (44 tests)
node tests/integration/test_api_e2e_examples.js
```

## Claude Code Setup

### Development (repo)
`.mcp.json` at project root — auto-detected by Claude Code.

### Packaged app
User adds to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "ac27-editor": {
      "command": "node",
      "args": ["path/to/mcp/bridge.js"]
    }
  }
}
```

Requires Node.js. The bridge connects to `127.0.0.1:31415` (API server auto-starts with the editor).
