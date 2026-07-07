# MCP / AI Agent Integration + Cloud LLM Chat

The editor has two AI integration paths:

| Path | Interface | Model | Entry Point |
|------|-----------|-------|-------------|
| **MCP** (external) | Claude Code via `mcp/bridge.js` → HTTP API | Claude (hosted by user's Claude Code) | `.mcp.json` |
| **Cloud LLM Chat** (in-app) | ChatPanel UI → IPC → `cloud-llm.js` | DeepSeek / Gemini / Claude / Codex (user chooses) | ChatPanel button in EditorScreen |

---

## 1. MCP Integration (External AI Agent)

### Architecture

```
Claude Code (LLM)                    AC27 Editor (Electron)
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

---

## 2. Cloud LLM Chat (In-App AI)

### Architecture

```
ChatPanel (React)                electron/main.js               Cloud APIs
┌──────────────────┐   IPC    ┌─────────────────────┐   HTTP   ┌──────────────┐
│  ChatPanel.jsx   │─────────→│ ipcMain.handle      │─────────→│ DeepSeek API │
│  (floating panel)│←─────────│  'cloud-chat'       │←─────────│ Gemini API   │
│                  │  events  │  ↓                  │  stream  │ Claude API   │
│  Vendor setup    │←─────────│ cloudLLM.chat()     │←─────────│ Codex/OpenAI │
│  Model selector  │  (tools, │  ├─ openaiChat()    │          └──────────────┘
│  Thinking view   │  done)   │  └─ claudeChat()    │
└──────────────────┘          │  ↓                  │
                              │  onToolCall →       │
                              │  handleMcpMessage() │────→ MCP tools (same 7)
                              └─────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `electron/cloud-llm.js` | Multi-vendor LLM module. `chat()` entry, `openaiChat()` for DeepSeek/Gemini/Codex, `claudeChat()` for Anthropic. Tool calling loop, dedup guard, thinking accumulation, Gemini JSON Schema sanitization. |
| `electron/main.js:2049-2110` | `cloud-chat` IPC handler. Loads config, wires `onToolCall` → `handleMcpMessage()`, emits `cloud-chat-event` to renderer (thinking, toolCall, toolResult, done). |
| `electron/preload.js:149-162` | `cloudChat()`, `onCloudChatEvent()`, `offCloudChatEvent()` bridge methods. |
| `src/components/ChatPanel/ChatPanel.jsx` | Floating chat UI. Vendor key setup, model selector, message list with thinking disclosure, send/stream handling. |
| `src/components/ChatPanel/ChatPanel.css` | Panel styling — positioned bottom-right, draggable, 380×500px. |
| `src/store/appStore.js` | Chat state: `chatPanelOpen`, `chatMessages`, `chatSending`, `chatSetupStep`, `chatError`, `chatConfig`, `chatAvailableModels`. |

### Supported Models

| Vendor | Icon | Models | SDK |
|--------|------|--------|-----|
| DeepSeek | 🔵 | `deepseek-v4-pro`, `deepseek-v4-flash` | OpenAI SDK (`api.deepseek.com`) |
| Gemini | 🟢 | `gemini-2.5-pro`, `gemini-2.5-flash` | OpenAI SDK (Gemini OpenAI-compat endpoint) |
| Claude | 🟣 | `claude-sonnet-4-6`, `claude-haiku-4-5` | Anthropic SDK |
| Codex | 🟡 | `gpt-4o`, `gpt-4o-mini` | OpenAI SDK (`api.openai.com`) |

### Tool Calling

The chat reuses the same 7 MCP tools. When the model calls a tool:
1. Cloud LLM sends tool call → `onToolCall` callback
2. Callback forwards to `handleMcpMessage()` (same as MCP path)
3. Tool result sent back to model for next turn
4. Final response streamed to ChatPanel UI

Tool definitions are converted: `MCP_TOOLS → mcpToolsToOpenAITools()` (OpenAI function format) or `toolsToAnthropic()` (Anthropic `input_schema` format). Gemini requires additional sanitization via `sanitizeToolsForVendor()` to strip OpenAI-only JSON Schema keywords (`minItems`, `maxItems`, `default`, `const`).

### Configuration

User API keys stored in `config.json` alongside other editor settings:
```json
{
  "deepseekKey": "sk-...",
  "geminiKey": "...",
  "claudeKey": "sk-ant-...",
  "codexKey": "sk-...",
  "selectedModel": "deepseek-v4-pro"
}
```

Config path managed by `getConfigPath()` / `loadConfig()` / `saveConfig()` in `electron/main.js`.

### Testing

```bash
# 49 tests — vendor registry, model lookup, tool conversion, Gemini sanitization,
# chat error handling, OpenAI/Claude chat with mocked SDKs, tool loops,
# thinking accumulation, empty-content nudge
npx vitest run tests/electron/cloud-llm.test.js
```

Uses `@vitest-environment node` with `require.cache` priming to stub the `openai` and `@anthropic-ai/sdk` packages (both are ESM; vitest's `vi.mock` cannot intercept CJS `require()` of ESM packages).
