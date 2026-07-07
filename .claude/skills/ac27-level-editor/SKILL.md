---
name: ac27-editor
description: AC27 Editor â€” Electron desktop app for editing Airport Control 27 .acl flight schedule files. Use this skill whenever working in this repo, editing any source file, running commands (npm start, node build.js, npm test, node tests/integration/*), adding features, fixing bugs, or discussing the app's architecture. This skill documents the full project structure, coding conventions, IPC patterns, save/load flow, timeline system, build process, and all dev commands. Always consult this skill before making changes.
---

# AC27 Editor â€” Repo Skill

## Project Identity

- **Name:** `ac27-editor` (v1.2.0)
- **Purpose:** Cross-platform desktop level editor for Airport Control 27 `.acl` flight schedule files
- **Stack:** Electron 33 + React 19 + Vite 8 + zustand 5
- **Entry:** `electron/main.js` (Electron main process) + `src/main.jsx` (React renderer)
- **App ID:** `com.ac27.editor`
- **MCP Integration:** Built-in HTTP API server (port 31415) + MCP tools for AI agent control (see `ac27-editor-mcp` skill)
- **Cloud LLM Chat:** In-app chat panel powered by DeepSeek / Gemini / Claude / Codex â€” 4-vendor multi-model chat with tool calling (see `references/mcp-integration.md`)

## Architecture Overview

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  electron/main.js (Electron Main Process)               â”‚
â”‚  - Creates BrowserWindow (1400Ã—880, min 1024Ã—640)       â”‚
â”‚  - contextIsolation: true, nodeIntegration: false       â”‚
â”‚  - 53 ipcMain.handle() endpoints                        â”‚
â”‚  - All file I/O, dialog, caching lives here             â”‚
â”‚  - electron/api-server.js â€” HTTP API + MCP (port 31415) â”‚
â”‚  - electron/cloud-llm.js â€” Multi-vendor cloud LLM chat    â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  electron/preload.js (contextBridge)                    â”‚
â”‚  - Exposes window.electronAPI with 52 methods            â”‚
â”‚  - onStoreApiUpdate/offStoreApiUpdate for MCP bridge    â”‚
â”‚  - Each method = ipcRenderer.invoke(channel, ...args)   â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  index.html + src/main.jsx (Vite entry)                 â”‚
â”‚  - <div id="root"> rendered by ReactDOM.createRoot      â”‚
â”‚  - Vite bundles src/ â†’ dist/                            â”‚
â”‚  - Three screens: setup â†’ browser â†’ editor              â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  src/components/ (React component tree)                 â”‚
â”‚  - App.jsx â€” root: I18nProvider + ScreenRouter + Modal +â”‚
â”‚    Toast                                                â”‚
â”‚  - SetupScreen / BrowserScreen / EditorScreen           â”‚
â”‚  - BrowserScreen: useTooltip (shared tooltip hook),
    VideoReplaceOverlay (menu video replacer),â”‚
â”‚    BrowserHelpOverlay (help overlay)                  â”‚
â”‚  - EditorScreen: FlightTable, TimelineEditors,          â”‚
â”‚    CellEditor, SearchBar, TutorialOverlay               â”‚
â”‚  - common: Modal, Toast                                 â”‚
â”‚  - ChatPanel: Floating chat panel with cloud LLM         â”‚
â”‚    integration (4 vendors, tool calling)                 â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  src/hooks/ (React custom hooks)                        â”‚
â”‚  - useTranslation, useElectronAPI, useEditorShell,      â”‚
â”‚    useEditorSaveActions, useKeyboardShortcuts, useDrag    â”‚
â”‚  - hooks/map/ â€” shared hooks for map windows:            â”‚
â”‚    useCrossWindowSelection, useWitchAnimation,            â”‚
â”‚    useKnobPositions                                      â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  src/store/ (zustand state)                             â”‚
â”‚  - appStore.js â€” single store: screen, flights,         â”‚
â”‚    timelines, modal/toast, chat, map overlay state,      â”‚
â”‚    radar window tracking, UDP health                     â”‚
â”‚  - flightDefaults.js â€” pure helpers for new flight       â”‚
â”‚    creation with sensible defaults                       â”‚
â”‚  - flightCascade.js â€” pure helpers for cascading field   â”‚
â”‚    updates (CallSign rebuild, airlineâ†’type/reg,          â”‚
â”‚    runwayâ†’STAR)                                          â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  src/acl/ (parser facade + 13 backend modules,          â”‚
â”‚    CommonJS + some ESM)                                  â”‚
â”‚  - parser.js is the FACADE â€” main.js imports ALL        â”‚
â”‚    backend modules through it only                      â”‚
â”‚  - constants.js â€” CJS re-export of utils/constants.js    â”‚
â”‚    (single source of truth â€” add new constants there)    â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚  src/utils/ (shared utilities, ESM frontend + CJS back) â”‚
â”‚  - constants/ â€” 7 domain sub-modules + barrel index.js:  â”‚
â”‚    timing.js, fields.js, aviation.js, airlines.js,       â”‚
â”‚    acl-format.js, map-config.js, ui.js                    â”‚
â”‚  - timeUtils.js, i18n.js, validators.js, htmlUtils.js,    â”‚
â”‚    csvIo.js, zipUtils.js, logger.js                       â”‚
â”‚  - safeHtml.jsx â€” renders i18n strings w/ allowed HTML    â”‚
â”‚    tags (<strong>, <em>, <br>) as safe JSX nodes          â”‚
â”‚  - debugLog.js â€” gated debug logging (localStorage +      â”‚
â”‚    URL query param toggle)                                â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

**Map Windows (separate BrowserWindow instances):**
- `electron/main.js` manages `groundMapWindows` / `airMapWindows` / `flightStripsWindows` Maps (keyed by ICAO) + `selectedCallSigns` Map (synced selection state)
- Each map window loads the same Vite SPA with query params (`?window=groundMap&airport=XXXX`, etc.)
- `electron/udp_listener.js` listens on `127.0.0.1:20266` for binary aircraft telemetry (10 Hz) and sends commands on `127.0.0.1:20267`
- Live aircraft state pushed to all open map windows (ground + air + flight strips) at 200ms interval via `udp-aircraft-state` IPC event
- Map window click-to-select goes through centralized `select-aircraft-in-map` IPC
- **Voice command input (v1.1.7 â€” planned, UI hidden):** `voiceNumberParser.js`, `voiceCallsignParser.js`, `voiceCommandMatcher.js`, `useVoiceCommands.js`, and `VoicePTTButton.jsx` provide push-to-talk voice commands for the Flight Strips window using the Web Speech API (zero dependencies). Callsign-first flow: spoken airline name â†’ ICAO code (via `AIRLINE_CODE_MAP`) + spoken numbers â†’ digits â†’ match against UDP aircraft â†’ fuzzy-match remaining text against available ATC commands. Supports both English and Chinese. Currently commented out behind `TODO: re-enable when game command IDs are confirmed`.

## Reference Files

This skill uses **progressive disclosure** â€” the central SKILL.md (this file) stays under 200 lines with the rules that apply to every task. Detailed information for specific domains lives in reference files. **Read the relevant reference file(s) when you need deeper detail.**

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

- **`architecture.md`** â€” Full directory tree, backend (CJS) and frontend (ESM/React) conventions, IPC patterns, three-layer test strategy, three-screen SPA flow.
- **`data-flow.md`** â€” Phase 0 cache init â†’ Phase 1 load â†’ Phase 2 edit â†’ Phase 3 save pipeline. Cache version detection, stand conflict validation, stand/star map overlays, demo .acl file handling.
- **`map-windows.md`** â€” Separate BrowserWindow architecture for GroundMapWindow, AirMapWindow, and FlightStripsWindow. Shared hooks (useSvgZoom, useUdpAircraftState, useCrossWindowSelection, useWitchAnimation, useKnobPositions), ControlSidebar with SpinKnobs, witch mode, cross-window selection sync, drag reorder.
- **`udp-telemetry.md`** â€” Binary protocol (40B header + 112B records), trail ring buffer, outbound command channel, 200ms live state push, auto-reset mechanisms (stale timeout, hasLevel transition, airport transition).
- **`acl-format.md`** â€” Unity JSON extensions, two-pass preprocessing, section types. Complete State=30/State=5 approach aircraft construction math: unified path, PR formula, 3Â° glideslope Y, TAT computation from SceneryData, approach ceiling, module API reference.
- **`mcp-integration.md`** â€” API server (port 31415), 7 MCP tools, 12-point validation, SSE/JSON-RPC endpoints. Also covers `electron/cloud-llm.js` (DeepSeek/Gemini/Claude/Codex chat with tool calling) and the `ChatPanel` React component.
- **`dev-commands.md`** â€” All npm/node commands: component tests, E2E tests, integration tests (with `--acl` and `--root` variants), local build (`node build.js`), GitHub release workflow.

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
16. **Build locally with `node build.js`** on Windows, never `npm run build:win` (local only â€” CI uses `npm run build:win` for cross-platform builds).
17. **Bump `CACHE_VERSION` when cache.json schema changes.** Any change to the structure of `approachData`, `saveTimeOffsets`, `fileTypeMaps`, `state5ParamsMap`, `taxiwayPaths`, `sidPaths`, `missedAppPaths`, or new top-level keys in cache.json MUST bump `CACHE_VERSION` in `src/utils/constants/timing.js` (re-exported via `src/utils/constants/index.js` and `src/acl/constants.js` for CJS backward compat). Stale caches silently corrupt saves.
18. **Semantic versioning for releases.** Version tags use `v<MAJOR>.<MINOR>.<PATCH>` (e.g. `v1.2.0`). Bump PATCH for bug fixes, MINOR for new features/refactors, MAJOR for breaking changes. Every release MUST bump the version in ALL of: (a) `.claude/skills/ac27-editor/SKILL.md` Project Identity line, (b) `package.json` `version` field, (c) the git tag itself. These three must stay in sync.
19. **Keep documentation in sync.** After any significant change, update ALL of:
    - **This skill** (`.claude/skills/ac27-editor/SKILL.md`) and its reference files
    - **README.md**
    - **`tests/README.md`** â€” whenever tests are added/removed, update the test counts (line 9, line 18, line 22), the file table (add/remove rows), MapWindows file/test counts (line 34), and expected outcomes (lines 44â€“53). Stale test docs mislead contributors about what's covered.
20. **UDP listener lifecycle is managed by main process.** `startUdpListener()` is called in `app.whenReady()` after `createWindow()`, `stopUdpListener()` in `will-quit`. The listener auto-reconnects on socket errors (2s delay). Do not create multiple listeners or start/stop from the renderer.
21. **Map windows are separate BrowserWindow instances.** They are NOT React components in the main renderer. Track them in `groundMapWindows`/`airMapWindows`/`flightStripsWindows` Maps (keyed by ICAO). Always check for existing windows before creating (focus if exists). Clean up Map entries in the `closed` event handler. Each window loads the same Vite SPA with query params (`?window=groundMap&airport=XXXX`, `?window=airMap&airport=XXXX`, or `?window=flightStrips&airport=XXXX`).
22. **UDP state push handles cleanup.** The `udp-aircraft-state` IPC event is pushed to ALL open map windows every 200ms. Map window components subscribe via `useUdpAircraftState()` hook which wraps `onUdpAircraftState`/`offUdpAircraftState`. Always unsubscribe in `useEffect` cleanup to prevent stale callbacks or memory leaks.
