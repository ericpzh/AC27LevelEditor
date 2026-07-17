---
name: ac27-editor
description: AC27 Editor — Electron desktop app for editing Airport Control 27 .acl flight schedule files. Use this skill whenever working in this repo, editing any source file, running commands (npm start, node build.js, npm test, node tests/integration/*), adding features, fixing bugs, or discussing the app's architecture. This skill documents the full project structure, coding conventions, IPC patterns, save/load flow, timeline system, build process, and all dev commands. Always consult this skill before making changes.
---

# AC27 Editor — Repo Skill

## Project Identity

- **Name:** `ac27-editor` (v1.2.3)
- **Purpose:** Cross-platform desktop level editor for Airport Control 27 `.acl` flight schedule files
- **Stack:** Electron 33 + React 19 + Vite 8 + zustand 5
- **Entry:** `electron/main.js` (Electron main process) + `src/main.jsx` (React renderer)
- **App ID:** `com.ac27.editor`
- **MCP Integration:** Built-in HTTP API server (port 31415) + MCP tools for AI agent control (see `ac27-editor-mcp` skill)
- **Cloud LLM Chat:** In-app chat panel powered by DeepSeek / Gemini / Claude / Codex — 4-vendor multi-model chat with tool calling (see `references/mcp-integration.md`)

## Architecture Overview

| Layer | Key Files | Details |
|-------|-----------|---------|
| **Electron Main Process** | `electron/main.js` | Creates BrowserWindow (1400×880, min 1024×640), contextIsolation: true, nodeIntegration: false, 65 ipcMain.handle() endpoints, all file I/O/dialog/caching |
| | `electron/updater.js` | Auto-update: HEAD check (R2 ETag), MD5 comparison, exe download, batch script generation |
| | `electron/api-server.js` | HTTP API + MCP (port 31415) |
| | `electron/cloud-llm.js` | Multi-vendor cloud LLM chat |
| **Preload Bridge** | `electron/preload.js` | contextBridge exposing `window.electronAPI` with 68 methods, onStoreApiUpdate/offStoreApiUpdate for MCP bridge, each method = ipcRenderer.invoke(channel, ...args) |
| **Vite + React Entry** | `index.html`, `src/main.jsx` | `<div id="root">` rendered by ReactDOM.createRoot, Vite bundles `src/` → `dist/`, three screens: setup → browser → editor |
| **React Components** | `src/components/` | |
| | `App.jsx` | Root: I18nProvider + ScreenRouter + Modal + Toast |
| | `SetupScreen`, `BrowserScreen`, `EditorScreen` | Three-screen SPA |
| | `BrowserScreen` | useTooltip (shared tooltip hook), VideoReplaceOverlay (menu video replacer), VideoBackgroundModal (video replace/restore modal), BrowserHelpOverlay (help overlay), Livery install |
| | `EditorScreen` | FlightTable, TimelineEditors, CellEditor, SearchBar, TutorialOverlay |
| | `common/` | Modal, Toast |
| | `ChatPanel/` | Floating chat panel with cloud LLM integration (4 vendors, tool calling) |
| **Custom Hooks** | `src/hooks/` | useTranslation, useElectronAPI, useEditorShell, useEditorSaveActions, useKeyboardShortcuts, useDrag |
| | `hooks/map/` | Shared hooks for map windows: useCrossWindowSelection, useWitchAnimation, useKnobPositions |
| **State Management** | `src/store/appStore.js` | Zustand single store: screen, flights, timelines, modal/toast, chat, map overlay state, radar window tracking, UDP health |
| | `src/store/flightDefaults.js` | Pure helpers for new flight creation: random airline code (audio → AirlineCode dropdown → AirlineName → 'NEW'), cascaded aircraft type + registration, non-conflicting random stand, random runway with STAR constrained to runway's valid procedures (departure SID auto-derived at runtime) |
| | `src/store/flightCascade.js` | Pure helpers for cascading field updates (CallSign rebuild, airline→type/reg, runway→STAR) |
| **ACL Backend** | `src/acl/parser.js` | **Facade** — main.js imports ALL backend modules through it only (13 modules, CommonJS + some ESM) |
| | `src/acl/constants.js` | CJS re-export of utils/constants.js (single source of truth — add new constants there) |
| **Shared Utilities** | `src/utils/constants/` | 7 domain sub-modules + barrel index.js: timing.js, fields.js, aviation.js, airlines.js, acl-format.js, map-config.js, ui.js |
| | `src/utils/` | timeUtils.js, i18n.js, validators.js, htmlUtils.js, csvIo.js, zipUtils.js, logger.js, safeHtml.jsx (renders i18n strings w/ allowed HTML tags `<strong>`, `<em>`, `<br>` as safe JSX nodes), debugLog.js (gated debug logging via localStorage + URL query param toggle) |

**Map Windows (separate BrowserWindow instances):**
- `electron/main.js` manages `groundMapWindows` / `airMapWindows` / `flightStripsWindows` Maps (keyed by ICAO) + `selectedCallSigns` Map (synced selection state)
- Each map window loads the same Vite SPA with query params (`?window=groundMap&airport=XXXX`, etc.)
- `electron/udp_listener.js` listens on `127.0.0.1:20266` for binary aircraft telemetry (10 Hz) and sends commands on `127.0.0.1:20267`
- Live aircraft state pushed to all open map windows (ground + air + flight strips) at 200ms interval via `udp-aircraft-state` IPC event
- Map window click-to-select goes through centralized `select-aircraft-in-map` IPC
- **Voice command input (v1.1.7 — planned, UI hidden):** `voiceNumberParser.js`, `voiceCallsignParser.js`, `voiceCommandMatcher.js`, `useVoiceCommands.js`, and `VoicePTTButton.jsx` provide push-to-talk voice commands for the Flight Strips window using the Web Speech API (zero dependencies). Callsign-first flow: spoken airline name → ICAO code (via `AIRLINE_CODE_MAP`) + spoken numbers → digits → match against UDP aircraft → fuzzy-match remaining text against available ATC commands. Supports both English and Chinese. Currently commented out behind `TODO: re-enable when game command IDs are confirmed`.

## Reference Files

This skill uses **progressive disclosure** — the central SKILL.md (this file) stays under 200 lines with the rules that apply to every task. Detailed information for specific domains lives in reference files. **Read the relevant reference file(s) when you need deeper detail.**

| Domain | Reference File | When to Read |
|--------|---------------|--------------|
| Architecture & Conventions | `references/architecture.md` | Adding files, creating IPC handlers, writing tests, understanding project structure, coding conventions |
| Data Flow & Cache | `references/data-flow.md` | Working on save/load, cache changes, stand/star maps, demo files, stand conflict detection |
| Map Windows | `references/map-windows.md` | Working on ground/air radar, flight strips, map hooks, ControlSidebar, SpinKnob, witch mode, map i18n |
| UDP Telemetry | `references/udp-telemetry.md` | Working on UDP listener, binary protocol, telemetry pipeline, command channel |
| ACL Format & Approach Math | `references/acl-format.md` | Working on ACL parsing, approach aircraft, scenery data, State=30/State=5 math, TAT formula |
| MCP / AI Agent Integration | `references/mcp-integration.md` | Working on API server, MCP tools, SSE endpoint, store-update IPC bridge, AI agent control flow |
| Cloud LLM / Chat Panel | `references/mcp-integration.md` | Working on `electron/cloud-llm.js`, `ChatPanel` component, multi-vendor chat, tool-calling loop, thinking/nudge |
| Dev Commands | `references/dev-commands.md` | Running, testing, building, or releasing the app |

### Quick Summaries

- **`architecture.md`** — Full directory tree, backend (CJS) and frontend (ESM/React) conventions, IPC patterns, three-layer test strategy, three-screen SPA flow.
- **`data-flow.md`** — Phase 0 cache init → Phase 1 load → Phase 2 edit → Phase 3 save pipeline. Cache version detection, stand conflict validation, stand/star map overlays, demo .acl file handling.
- **`map-windows.md`** — Separate BrowserWindow architecture for GroundMapWindow, AirMapWindow, and FlightStripsWindow. Shared hooks (useSvgZoom, useUdpAircraftState, useCrossWindowSelection, useWitchAnimation, useKnobPositions), ControlSidebar with SpinKnobs, witch mode, cross-window selection sync, drag reorder.
- **`udp-telemetry.md`** — Binary protocol (40B header + 112B records), trail ring buffer, outbound command channel, 200ms live state push, auto-reset mechanisms (stale timeout, hasLevel transition, airport transition).
- **`acl-format.md`** — Unity JSON extensions, two-pass preprocessing, section types. Complete State=30/State=5 approach aircraft construction math: unified path, PR formula, 3° glideslope Y, TAT computation from SceneryData, approach ceiling, module API reference.
- **`mcp-integration.md`** — API server (port 31415), 7 MCP tools, 12-point validation, SSE/JSON-RPC endpoints. Also covers `electron/cloud-llm.js` (DeepSeek/Gemini/Claude/Codex chat with tool calling) and the `ChatPanel` React component.
- **`dev-commands.md`** — All npm/node commands: component tests, E2E tests, integration tests (with `--acl` and `--root` variants), local build (`node build.js`), GitHub release workflow.

## Key Rules for Agents

1. **React + Vite + zustand stack.** Frontend uses ESM, JSX, and React hooks. No global-scope scripts.
2. **No TypeScript.** This is plain JS/JSX. Do not add `tsconfig.json` or convert files to `.tsx`.
3. **No linter/formatter.** Do not add ESLint, Prettier, or any linting config unless explicitly asked.
4. **Testing uses Vitest (component) + Playwright (E2E) + Node.js (integration).** Component tests go in `tests/components/`, electron-backend tests in `tests/electron/` (use `@vitest-environment node` + `require.cache` priming for CJS modules that require ESM SDKs), E2E specs in `tests/e2e/`, integration scripts in `tests/integration/`. Do not add Jest or Mocha.
5. **No npm dependencies for core logic.** The app uses only Node.js built-ins. Justify any new dependency.
6. **Preserve CommonJS for backend.** `electron/` and `src/acl/` use `require()`/`module.exports`.
7. **ESM for frontend.** `src/components/`, `src/hooks/`, `src/store/`, `src/utils/` use `import`/`export`.
8. **IPC for all file I/O.** The renderer never touches the filesystem. All reads/writes go through `electron/main.js` handlers.
9. **Return `{ success }` from IPC.** Every handler returns `{ success: true/false, error?: string }`.
10. **`_underscore` = private in backend.** Prefix internal functions with `_`. Export them anyway for testing.
11. **`snake_case.js` for backend, `PascalCase.jsx` for components.** Match existing conventions.
12. **No inline `style={{}}`.** Always extract CSS to the component's `.css` file.
13. **One `.css` per component.** Match the component filename.
14. **No `dangerouslySetInnerHTML`.** Use `safeHtml()` from `src/utils/safeHtml.jsx` to render i18n strings containing `<strong>`, `<em>`, or `<br>` as safe React nodes. It sanitises unknown tags and attribute injection as plain text.
15. **Update the facade.** New backend modules must be re-exported through `src/acl/parser.js`.
16. **Build locally with `node build.js`** on Windows, never `npm run build:win` (local only — CI uses `npm run build:win` for cross-platform builds).
17. **Bump `CACHE_VERSION` when cache.json schema changes.** Any change to the structure of `approachData`, `saveTimeOffsets`, `fileTypeMaps`, `state5ParamsMap`, `taxiwayPaths`, `sidPaths`, `missedAppPaths`, or new top-level keys in cache.json MUST bump `CACHE_VERSION` in `src/utils/constants/timing.js` (re-exported via `src/utils/constants/index.js` and `src/acl/constants.js` for CJS backward compat). Stale caches silently corrupt saves.
18. **Version tags for releases.** Version tags use `v<MAJOR>.<MINOR>.<PATCH>` (e.g. `v1.2.0`). Keep these three in sync: (a) `.claude/skills/ac27-editor/SKILL.md` Project Identity line, (b) `package.json` `version` field, (c) the git tag. The user decides when to bump; you can re-tag the same version to include new changes.
19. **Keep documentation in sync.** After any significant change, update ALL of:
    - **This skill** (`.claude/skills/ac27-editor/SKILL.md`) and its reference files
    - **README.md**
    - **`tests/README.md`** — whenever tests are added/removed, update the test counts (line 9, line 18, line 22), the file table (add/remove rows), MapWindows file/test counts (line 34), and expected outcomes (lines 44–53). Stale test docs mislead contributors about what's covered.
20. **UDP listener lifecycle is managed by main process.** `startUdpListener()` is called in `app.whenReady()` after `createWindow()`, `stopUdpListener()` in `will-quit`. The listener auto-reconnects on socket errors (2s delay). Do not create multiple listeners or start/stop from the renderer.
21. **Map windows are separate BrowserWindow instances.** They are NOT React components in the main renderer. Track them in `groundMapWindows`/`airMapWindows`/`flightStripsWindows` Maps (keyed by ICAO). Always check for existing windows before creating (focus if exists). Clean up Map entries in the `closed` event handler. Each window loads the same Vite SPA with query params (`?window=groundMap&airport=XXXX`, `?window=airMap&airport=XXXX`, or `?window=flightStrips&airport=XXXX`).
22. **UDP state push handles cleanup.** The `udp-aircraft-state` IPC event is pushed to ALL open map windows every 200ms. Map window components subscribe via `useUdpAircraftState()` hook which wraps `onUdpAircraftState`/`offUdpAircraftState`. Always unsubscribe in `useEffect` cleanup to prevent stale callbacks or memory leaks.
