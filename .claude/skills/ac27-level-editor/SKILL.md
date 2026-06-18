---
name: ac27-level-editor
description: AC27 Level Editor — Electron desktop app for editing Airport Control 27 .acl flight schedule files. Use this skill whenever working in this repo, editing any source file, running commands (npm start, node build.js, npm test, node tests/integration/*), adding features, fixing bugs, or discussing the app's architecture. This skill documents the full project structure, coding conventions, IPC patterns, save/load flow, timeline system, build process, and all dev commands. Always consult this skill before making changes.
---

# AC27 Level Editor — Repo Skill

## Project Identity

- **Name:** `ac27-level-editor` (v1.1.5)
- **Purpose:** Cross-platform desktop level editor for Airport Control 27 `.acl` flight schedule files
- **Stack:** Electron 33 + React 19 + Vite 8 + zustand 5
- **Entry:** `electron/main.js` (Electron main process) + `src/main.jsx` (React renderer)
- **App ID:** `com.ac27.level-editor`
- **Product name:** `AC27 Level Editor`

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  electron/main.js (Electron Main Process)               │
│  - Creates BrowserWindow (1400×880, min 1024×640)       │
│  - contextIsolation: true, nodeIntegration: false       │
│  - 39 ipcMain.handle() endpoints                        │
│  - All file I/O, dialog, caching lives here             │
├─────────────────────────────────────────────────────────┤
│  electron/preload.js (contextBridge)                    │
│  - Exposes window.electronAPI with ~42 methods          │
│  - Each method = ipcRenderer.invoke(channel, ...args)   │
├─────────────────────────────────────────────────────────┤
│  index.html + src/main.jsx (Vite entry)                 │
│  - <div id="root"> rendered by ReactDOM.createRoot      │
│  - Vite bundles src/ → dist/                            │
│  - Three screens: setup → browser → editor              │
├─────────────────────────────────────────────────────────┤
│  src/components/ (React component tree)                 │
│  - App.jsx — root: I18nProvider + ScreenRouter + Modal +│
│    Toast                                                │
│  - SetupScreen / BrowserScreen / EditorScreen           │
│  - EditorScreen: FlightTable, TimelineEditors,          │
│    CellEditor, SearchBar                                │
│  - common: Modal, Toast                                 │
├─────────────────────────────────────────────────────────┤
│  src/hooks/ (React custom hooks)                        │
│  - useTranslation, useElectronAPI, useEditorShell,      │
│    useSaveAcl, useKeyboardShortcuts, useDrag             │
├─────────────────────────────────────────────────────────┤
│  src/store/ (zustand state)                             │
│  - appStore.js — single store: screen, flights,         │
│    timelines, modal/toast, _windSpeedUnit, map overlay   │
│    state (showStandMap, showStarMap, activeMap),          │
│    radar window tracking (openGroundRadarAirports,        │
│    openAirRadarAirports), UDP health (udpConnected,       │
│    udpCurrentAirport)                                     │
├─────────────────────────────────────────────────────────┤
│  src/acl/ (parser facade + 13 backend modules,          │
│    CommonJS + some ESM)                                  │
│  - parser.js is the FACADE — main.js imports ALL        │
│    backend modules through it only                      │
│  - constants.js — CJS re-export of utils/constants.js    │
│    (single source of truth — add new constants there)    │
├─────────────────────────────────────────────────────────┤
│  src/utils/ (shared utilities, ESM frontend + CJS back) │
│  - constants.js — single source of truth for ALL app      │
│    constants (fields, math, timing, layout, i18n keys)    │
│  - timeUtils.js — time conversion + timeline helpers    │
│  - i18n.js — Chinese/English translation system         │
│  - validators.js — save validation logic                │
│  - htmlUtils.js, csvIo.js, zipUtils.js, logger.js       │
└─────────────────────────────────────────────────────────┘
```

**Map Windows (separate BrowserWindow instances):**
- `electron/main.js` manages `groundMapWindows` / `airMapWindows` Maps (keyed by ICAO) + `selectedCallSigns` Map (synced selection state)
- Each map window loads the same Vite SPA with query params (`?window=groundMap&airport=XXXX` or `?window=airMap&airport=XXXX`)
- `electron/udp_listener.js` listens on `127.0.0.1:20266` for binary aircraft telemetry (10 Hz) and sends commands on `127.0.0.1:20267`
- Live aircraft state pushed to all open map windows at 200ms interval via `udp-aircraft-state` IPC event
- Map window click-to-select goes through centralized `select-aircraft-in-map` IPC — main process broadcasts to BOTH ground + air map windows for the same airport and sends `SelectAircraft` UDP command to game

## Directory Structure

```
AC27LevelEditor/
├── electron/
│   ├── main.js              # Electron main process + 39 IPC handlers
│   ├── preload.js           # contextBridge (window.electronAPI, ~42 methods)
│   └── udp_listener.js      # UDP telemetry — 10 Hz binary aircraft state (127.0.0.1:20266) + commands (20267)
├── index.html               # Vite HTML entry (<div id="root">)
├── vite.config.js           # Vite 8 + @vitejs/plugin-react + vite-plugin-electron
├── package.json             # scripts, electron-builder config
├── build.js                 # RECOMMENDED build script (programmatic)
├── set_icon.js              # Post-build icon embedding
├── icon.ico / icon.png      # App icons
├── README.md                # Comprehensive docs
│
├── src/
│   ├── main.jsx             # React entry: ReactDOM.createRoot → <App />
│   ├── App.jsx              # Root component: providers + screen routing
│   ├── style.css            # Global dark theme CSS variables + reset
│   │
│   ├── components/
│   │   ├── SetupScreen/     # Game root directory selection
│   │   │   ├── SetupScreen.jsx  + .css
│   │   ├── BrowserScreen/   # Airport card listing, file browsing
│   │   │   ├── BrowserScreen.jsx + .css
│   │   ├── EditorScreen/    # Main editor: toolbar + table + timelines
│   │   │   ├── EditorScreen.jsx + .css
│   │   │   ├── SearchBar.jsx     # Ctrl+F search (extracted component)
│   │   │   ├── TutorialOverlay.jsx + .css  # First-time help overlay
│   │   │   ├── FlightTable/
│   │   │   │   └── FlightTable.jsx + .css
│   │   │   ├── CellEditor/
│   │   │   │   ├── TimeClockPopover.jsx  # SVG clock picker
│   │   │   │   ├── CompassPopover.jsx    # SVG compass picker
│   │   │   │   └── CellEditor.css
│   │   │   ├── StandMap/
│   │   │   │   ├── StandMap.jsx + .css   # Interactive stand position map overlay
│   │   │   ├── StarMap/
│   │   │   │   └── StarMap.jsx + .css    # Interactive STAR/approach map overlay
│   │   │   └── TimelineEditors/
│   │   ├── MapWindows/               # Full-window radar visualizations (separate BrowserWindow instances)
│   │   │   ├── GroundMapWindow.jsx + .css  # Surface radar: taxiways, runways, areas, ground aircraft (stand-access segments marked + help overlay)
│   │   │   ├── AirMapWindow.jsx + .css     # Approach radar: STAR/SID/APPR routes, air aircraft, map bg, runway extensions, range rings, border overlay, help overlay
│   │   │   ├── ControlSidebar.jsx + .css   # Vertical sidebar: spin knobs (zoom/pan/airspace) + toggle buttons + help button
│   │   │   ├── SpinKnob.jsx + .css         # Rotary encoder knob (click-drag + scroll-wheel, gauge mode)
│   │   │   ├── SimClock.jsx                # Shared sim-time clock (HH:MM:SS UTC, accepts className prop)
│   │   │   ├── MapHelpOverlay.jsx + .css   # Context-sensitive help overlay (air or ground map, Escape to close, toggleable button interactivity)
│   │   │   ├── MapShared.css               # Shared styles: toggle buttons, clock, help button, animations, witch mode UI overrides (sidebar bar.png, button.png/button_on.png toggles, knob.png spin knobs)
│   │   │   ├── useSvgZoom.js               # Scroll-zoom + drag-pan SVG hook (clamped, imperative API)
│   │   │   ├── useUdpAircraftState.js      # Hook subscribing to live UDP state pushes (incl. simTimeUnixMs)
│   │   │   └── witchMode.js                # Witch mode: direction, parked detection, sprite-sheet lookup, round-robin character assignment
│   │   └── common/
│   │       ├── Modal.jsx + .css         # Declarative modal
│   │       └── Toast.jsx + .css         # Declarative toast
│   │
│   ├── hooks/
│   │   ├── useTranslation.jsx   # I18n Context Provider
│   │   ├── useElectronAPI.jsx   # electronAPI Context Provider
│   │   ├── useEditorShell.jsx   # Keyboard shortcuts (Ctrl+S, Delete, etc.)
│   │   ├── useSaveAcl.jsx       # Save/export/backup logic
│   │   ├── useKeyboardShortcuts.js
│   │   └── useDrag.js          # Shared drag behavior for floating panels (StandMap, StarMap)
│   │
│   ├── store/
│   │   └── appStore.js          # zustand store — all app state
│   │
│   ├── acl/                     # Backend modules (13 files; CommonJS + some ESM)
│   │   ├── parser.js            # FACADE — re-exports all backend modules
│   │   ├── tokenizer.js         # String-aware section boundary scanner (no more brace-counting)
│   │   ├── acl_json.js          # Pre-processor (Unity JSON→valid JSON) + serializer
│   │   ├── acl_document.js      # In-memory document model (lazy parsing, mutation tracking)
│   │   ├── constants.js         # CJS re-export of utils/constants.js (backward compat)
│   │   ├── scanner.js           # Scans game root for airports & .acl files
│   │   ├── flight_plans.js      # FlightPlans format (types 37/52/57/58)
│   │   ├── world_state.js       # WorldState format (types 35/56/54)
│   │   ├── approach.js         # Approach AircraftState constructor (State=30)
│   │   ├── dynamics.js          # Deprecated — calcProgressRatio/buildAircraftEntry stubs
│   │   ├── scenery.js           # SceneryData parser (runway/stand GUIDs + stand position extraction)
│   │   ├── taxiway.js           # Taxiway centerline parser from SceneryData.TaxiwaySegments (added v1.1.3)
│   │   ├── sid_goaround.js      # SID + Missed Approach route parser from SceneryData.Runways.Routes[Type=2/3]
│   │   └── utils.js             # Enrichment, sorting, audio, import utils
│   │
│   └── utils/                   # Shared utilities (ESM + some CJS for backend)
│       ├── constants.js         # Single source of truth: ALL app constants (fields, math, timing, layout, keys)
│       ├── timeUtils.js         # Tick↔time conversion, timeline helpers (CJS + ESM)
│       ├── i18n.js              # Chinese/English translation (T(), getLang, setLang)
│       ├── validators.js        # validateCallsigns, runTripleValidation
│       ├── htmlUtils.js         # escapeHtml, stripSuffixes
│       ├── csvIo.js             # CSV export
│       ├── zipUtils.js          # Pure Node.js ZIP (zlib, no deps)
│       └── logger.js            # Console → file redirect (dev mode)
│
├── tests/               # 198 Vitest + Playwright E2E + 17 Node.js integration tests
│   ├── components/MapWindows/  # MapWindow component & hook tests (7 files, 90 tests)
└── dist/                # Build output (gitignored)
```

## Coding Conventions

### Backend (Node.js / `electron/*.js` + `src/acl/*.js`)

**Module system:** Primarily CommonJS. `parser.js` uses `require()` for most modules but also uses ESM `import` for `./constants.js`. New shared constants should use ESM so both frontend and backend can consume them.
```js
const { loadFlights, exportCSV } = require('../src/acl/parser.js');
module.exports = { publicFn, _privateFn };
```

**Naming:**
- `camelCase` for functions and variables
- `_underscorePrefix` for private/internal functions
- `UPPER_SNAKE_CASE` for true constants
- `snake_case.js` filenames in `src/acl/`

**Error handling:** Always return `{ success: true/false, error?: message }` from IPC handlers and I/O functions. Never throw across process boundaries.

**Logging:** Use `console.log` with a `[TAG]` prefix: `[IPC]`, `[ACL-LOAD]`, `[DYNAMICS]`, `[RENDERER]`.

**No external dependencies for core logic.** Uses only Node.js built-ins (`fs`, `path`, `zlib`, `crypto`). Do not add npm dependencies without strong justification.

**Facade pattern:** `src/acl/parser.js` is the single entry point. `electron/main.js` imports only from `parser.js`. New parsing modules must be re-exported through `parser.js`.

### Frontend (React / `src/components/*.jsx` + `src/hooks/*.jsx`)

**Module system:** ESM (`import`/`export`) throughout. Vite handles bundling.

**Component patterns:**
- One component per file (default export)
- Each component has a matching `.css` file in the same directory
- Sub-components that are only used by one parent may be defined in the same file
- Shared sub-components go in their own file (e.g., `TimeCell.jsx`)
- Use React hooks for state and side effects (never class components)

**File naming:**
- `PascalCase.jsx` for components: `EditorScreen.jsx`, `FlightTable.jsx`
- `camelCase.js` for non-React utilities: `constants.js`, `timeUtils.js`
- `.css` files match their component: `EditorScreen.css`, `FlightTable.css`

**CSS conventions:**
- Global variables + reset in `src/style.css`
- Component styles in `<ComponentName>.css` next to the `.jsx` file
- NEVER use inline `style={{}}` — always extract to CSS classes
- CSS class naming: BEM-like flat naming (`.modal-issues-body`, `.callsign-link`)
- CSS custom properties (`--bg`, `--accent`, `--radius`, etc.) for theming

**State management (zustand):**
- Single store in `src/store/appStore.js`
- Components subscribe with selectors: `useAppStore(s => s.flights)`
- Actions are defined in the store and called via `useAppStore.getState().actionName()`
- NEVER mutate state directly — always use `set()` or store actions
- `Set` and `Map` in state must be replaced with new instances on mutation

**Hooks:**
- Custom hooks in `src/hooks/` — one hook per file
- `useTranslation()` — returns `{ t, lang, toggleLang }`
- `useElectronAPI()` — returns the `window.electronAPI` bridge
- `useEditorShell({ onSave })` — registers keyboard shortcuts
- `useSaveAcl()` — returns `{ handleSave, handleSaveAs, handleBackup }`
- `useDrag({ panelRef, enabled, onDragEnd })` — shared drag behavior for floating panels; returns `{ pos, isDragging, hasDragged, setPos, headerHandlers }`

**React best practices:**
- Hoist RegExp to module scope (never inside render)
- Use `useMemo`/`useCallback` for expensive computations or stable callbacks
- Never mutate props/state arrays — use spread `[...arr]` or `.toSorted()`
- Always include proper dependency arrays in `useEffect`
- Use `didInit` guard pattern for app-wide initialization effects
- Never use `key={Math.random()}` — use stable keys
- Never use `dangerouslySetInnerHTML` — render JSX elements instead

### IPC Patterns

```
Renderer                    preload.js                  main.js
─────────                   ──────────                  ───────
window.electronAPI          ipcRenderer.invoke()        ipcMain.handle()
  .loadAcl(path)    ──→       'load-acl'        ──→      async handler
                    ←──       result            ←──      return {...}
```

**Rules:**
- Renderer NEVER accesses `require()` or Node.js APIs directly
- All file I/O goes through IPC handlers in `electron/main.js`
- IPC channels use kebab-case strings matching the handler name
- Every `ipcMain.handle()` must return `{ success: true/false }`
- New IPC channels require: (1) handler in `electron/main.js`, (2) bridge method in `electron/preload.js`, (3) call site in renderer
- **Main→renderer events:**
  - `cache-invalidated` — signals renderer when `cache.json` is missing/corrupt; preload bridges via `onCacheInvalidated(cb)`
  - `cache-build-progress` — per-file progress during scan: `{ current: number, total: number }`; preload bridges via `onCacheBuildProgress(cb)` / `offCacheBuildProgress(cb)` (uses handler-map pattern, same function reference required for cleanup)

### Test Conventions

Three-layer testing strategy:

**Layer 1 — Component tests (Vitest + React Testing Library):**
- `npm test` or `npm run test:watch` — 198 tests across 16 files
- Isolated component rendering in jsdom with mocked `window.electronAPI`
- zustand stores are tested with the real store using `setState()` — never mock stores
- Store auto-reset between tests via `tests/__mocks__/zustand.js`
- MapWindow component tests mock `useUdpAircraftState`, `useSvgZoom`, and `useElectronAPI` hooks at the module level
- MapWindow hooks (`useSvgZoom`, `useUdpAircraftState`) are tested with `renderHook` from `@testing-library/react`

**Layer 2 — E2E tests (Playwright + Electron):**
- `npm run test:e2e` (requires `npm run build` first)
- Launches the real Electron app against a temp fixture copy in `tests/tmp-e2e/`
- Custom `--user-data-dir` with pre-written `lastRoot.json` skips the setup screen
- `AC27_E2E_TMP_DIR` env var skips native OS dialogs (export) in test mode; backup saves `.bak` directly alongside source (no dialog)
- **Never touches real game files** — all reads/writes go to temp copies

File isolation flow:
```
tests/fixtures/game-root/       tests/tmp-e2e/                  tests/tmp-e2e-userdata/
(committed to git)              (gitignored, fresh each run)    (gitignored)
─────────────────────     copy    ─────────────────────
ZSJN/                    ─────→   ZSJN/                  lastRoot.json → { rootPath: "tmp-e2e" }
  airport_config.json               airport_config.json
  Levels/                           Levels/
    *.acl                             *.acl              Electron --user-data-dir=tmp-e2e-userdata/
    *.json                            *.json             → reads lastRoot.json → skips SetupScreen
                                                         → all file I/O goes to tmp-e2e/
```
1. `global-setup.mjs`: copy fixtures → `tmp-e2e/`, write `lastRoot.json`
2. Electron launches with `--user-data-dir=tmp-e2e-userdata/` + `AC27_E2E_TMP_DIR` env
3. App sees `lastRoot.json` → goes straight to BrowserScreen (no native dialog)
4. All saves, backups, timeline writes land in `tmp-e2e/`
5. `global-teardown.mjs`: remove both temp dirs

**Layer 3 — Integration tests (plain Node.js):**
- Located in `tests/integration/` (moved from `test/`)
- Standalone scripts run with `node tests/integration/<name>.js`
- Tests `require('../../src/acl/parser.js')` to access both public and `_private` functions
- Use `--require ./tests/integration/preload.cjs` for tests that import ESM source modules
- New parser tests (`test_tokenizer`, `test_acl_json`, `test_acl_document`, `test_sid_goaround`, `test_taxiway`) run without a game root — they use synthetic test data
- `test_sid_goaround` and `test_taxiway` also run against the ZSJN fixture in `tests/fixtures/game-root/` for integration coverage
- UDP listener test (`test_udp_listener`) uses a mock loopback server — sends crafted binary packets and verifies parsed state. Requires port 20266 to be free (game not running)
- Other tests need a real game installation (Airport Control 27) at a known path
- Tests print results to stdout — read the output to determine pass/fail

**Save integrity test (`test_save_integrity_all.js`) — file isolation flow:**

Real game files are **never modified**. Each .acl file follows this path:

```
Game root (read-only)            Temp golden/ (pristine)        Temp result/ (save target)
────────────────────────         ─────────────────────          ────────────────────────
Airports/ZSJN/Levels/       copy →  _tmp/golden/ZSJN/     copy →  _tmp/result/ZSJN/
  ZSJN-Morning_120min.acl  ─────→    ZSJN-Morning_120min.acl ──→   ZSJN-Morning_120min.acl
  weather_timeline.json    ─────→    weather_timeline.json           (overwritten by save)
  wind_timeline.json       ─────→    wind_timeline.json
  runway_timeline_....json ─────→    runway_timeline_....json
```

1. **Copy** real .acl + timeline JSONs → `tests/integration/_tmp/golden/<icao>/` (pristine snapshot)
2. **Load golden** → in-memory snapshot (flights, config, scenery, timelines)
3. **Copy golden** → `tests/integration/_tmp/result/<icao>/` (save target)
4. **Save** via `generateFullAcl` on result copy — only result is modified
5. **Load result** → compare against golden snapshot (14 fields × N flights, config, scenery maps, embedded timelines)
6. **Clean up** `_tmp/` after each file (removed entirely after run)
7. **Write JSON report** → `tests/_reports_/save-integrity-<timestamp>.json` with per-file metrics and diffs

- Supports `--prod-demo` flag to test only the 8 production + 4 demo files
- Both `tests/integration/_tmp/` and `tests/_reports_/` are gitignored
- Full test documentation: `tests/README.md` — test matrix, expected values, execution commands

## Three-Screen SPA

The app is a single-page application with three screens managed by zustand state:

| Screen | Component | Purpose | Trigger |
|--------|-----------|---------|---------|
| Setup | `<SetupScreen />` | Select game root directory | First launch (no saved root) |
| Browser | `<BrowserScreen />` | Browse airports & level files | After setup completes |
| Editor | `<EditorScreen />` | Edit flights in table + timelines | Click a level row |

Screen transitions: `useAppStore.getState().setScreen('browser')` — `App.jsx`'s `ScreenRouter` renders the corresponding component.

## Data Flow: Load → Edit → Save

### Phase 0: Airport Cache Init (once per game root)
1. User selects game root directory
2. `scan-acls` IPC → `scanGameRoot()` → returns airport list with `.acl` file paths
3. `init-airport-cache` IPC → loads audio clips + pre-scans approach data + dropdown values per airport:
   - Scans `.acl` files matching the browser's visibility filter — **excludes** `.acl.bak` backups and all variants hidden by `RE_HIDDEN` in `constants.js` (`tutorial`, `bench`, `test`, `crossrunway`, `dev`, `endless`, `.prod`). Demo slices (`.demo.acl`) and `_emerg` files are still included.
   - **Global progress reporting:** Pre-counts total `.acl` files across ALL airports, then sends `cache-build-progress` IPC events (`{ current, total }`) per file during `buildApproachCache`. Renderer shows a progress bar + percentage via `CacheProgressBody` component.
   - Extracts `specDB` (Designator → AircraftSpec, from ALL aircraft entries regardless of State), `appPointMap` ((STAR,Runway) → AppPointList, from SceneryData Type=1 routes), `totalApproachTimes` (STAR → seconds, from SceneryData path lengths with aircraft-derived calibration), and `designatorMap` (AircraftType → Designator)
   - Extracts State=5 data: `state5ParamsMap` (runway → `{pathPointList, touchDownPosition, approachDirection, initialPosition}`), `starPaths` (STAR → waypoint array), and STAR↔runway maps from `SceneryData.Runways.Routes[Type=0]`
   - Extracts `runwayThresholds` from SceneryData (PhysicalName → threshold pair) for StarMap/MapWindow visualization
   - Extracts `taxiwayPaths` (taxiway centerline polylines from `SceneryData.TaxiwaySegments` via `taxiway.js`) — **merged from ALL `.acl` files** with coordinate-based dedup (`toFixed(2)` precision), not just the first file. This ensures complete taxiway coverage even when some ACL files have missing segments (e.g. `ZSJN-17_19.acl` missing 2 taxiway A/B segments between E and N). Used by GroundMapWindow.
   - Extracts SID data: `sidPaths` (departure route polylines from `SceneryData.Runways.Routes[Type=2]`), `sidRunwayMap` (SID→[runways]), `runwaySidMap` (runway→[SIDs]) — parsed by `sid_goaround.js`
   - Extracts Missed Approach data: `missedAppPaths` (go-around route polylines from `SceneryData.Runways.Routes[Type=3]`), `missedAppMap` (MA name→runway), `runwayMissedAppMap` (runway→MA names) — parsed by `sid_goaround.js`
   - Collects dropdown values (`collectUniqueValues`) and runway pairs (`collectRunwayPairs`) from ALL .acl files
   - Merges audio flight numbers into `_flightNums` per airline code
   - **Stand dropdown from SceneryData:** Stand identifiers parsed by `_parseStandPositions()` become the authoritative dropdown options (sorted), replacing any hardcoded or ACL-derived stand lists
   - **STAR dropdown from SceneryData:** STAR names come from `starRunwayMap` keys (SceneryData Type=0 Routes), same pattern as Stand — scenery is the single source of truth. `starRunwayMap` is built by `extractStarRunwayMappings()` and already excludes stubs (`$rlength:0`)
   - Caches in memory as `airportCache[icao] = { audioCallsigns, approachData, dropdownValues, runwayPairs, standPositions, areaData }`
   - `approachData` now includes: `taxiwayPaths`, `sidPaths`, `missedAppPaths`, `apprPaths`, `sidRunwayMap`, `runwaySidMap`, `missedAppMap`, `runwayMissedAppMap`, `apprRunwayMap`, `runwayApprMap` (all serialized through `serializeApproachCache`/`deserializeApproachCache`)
   - `standPositions` parsed from first .acl via `_parseStandPositions()` — maps stand identifier → `{x, y}` (midpoint) plus `tailX`/`tailZ`/`noseX`/`noseZ` for heading/orientation
	   - `areaData` parsed from first .acl via `_parseAreas()` — maps AreaType (0=boundary, 1=stand/apron, 2=building) → `[{guid, enabled, points[{x,z}]}]` — used by GroundMapWindow
   - Persisted to disk (`cache.json` in userData, unified with `gameRoot`, `lang`, `cacheVersion`) — no TTL, refreshed via `refresh-root-scan`
   - **Centralized cache I/O:** `_readCache(opts)` and `_writeCache(data)` in `electron/main.js` handle all `cache.json` reads/writes. `_readCache` validates `cacheVersion` and `gameRoot`, and signals `cache-invalidated` to the renderer on mismatch. All IPC handlers MUST use these helpers — never read/write `cache.json` directly.

### Cache State & Version Detection (v1.1.0)

The app uses a unified **`cache.json`** in `userData` (replaces `approachCache.json` + `lastRoot.json` + `localStorage.ac27_lang`). It contains `gameRoot`, `lang`, `cacheVersion`, `builtAt`, and `airports`.

Cache validity is determined by a standalone **`CACHE_VERSION`** constant (integer, hand-bumped in `src/utils/constants.js`), NOT by `app.getVersion()`. This decouples cache invalidation from app updates.

**⚠️ CACHE_VERSION rule:** Any change to the shape of `cache.json` (new fields in the approach cache object, new top-level keys, changed structure of `approachData`, `saveTimeOffsets`, `fileTypeMaps`, etc.) MUST bump `CACHE_VERSION` in `src/utils/constants.js:13`. Without this, users with stale caches will not be prompted to re-scan, and old cache data will silently corrupt saves. Examples of changes requiring a bump: adding `saveTimeOffsets` to `approachData`, adding `state5ParamsMap`, changing `fileTypeMaps` from per-airport to per-file, adding `.bak` files to the scan set, adding `taxiwayPaths`/`sidPaths`/`missedAppPaths` to `approachData`. Current `CACHE_VERSION` is 11.

| `cache.json` | Behavior |
|---|---|
| Missing | Show root-select screen (SetupScreen) |
| Exists, `cacheVersion` ≠ `CACHE_VERSION` | Show re-scan modal on browser screen |
| Exists, `cacheVersion` matches | Proceed directly to level-select screen |

**Startup flow (`get-cache-state` IPC):**
1. Check `cache.json` — if exists, compare `cacheVersion` vs `CACHE_VERSION`
2. If missing, attempt migration from legacy `approachCache.json` → creates `cache.json` with current version
3. If only `lastRoot.json` exists → returns `mismatch` state (no airport data, needs rescan)
4. Returns `{ state: 'no-cache' | 'mismatch' | 'ready', gameRoot, lang, airports, cachedVersion, expectedVersion }`
5. ScreenRouter uses `getCacheState()` instead of `getLastRoot()` — routes to setup/browser based on state

**Re-scan flow:**
1. Mismatch modal appears on BrowserScreen (non-closeable, with lang toggle button in top-right via `showLangToggle`)
2. User clicks "Re-Scan" → scanning modal with **progress bar + percentage** (`CacheProgressBody` component) appears → `refresh-root-scan` → rebuilds cache with `cacheVersion: CACHE_VERSION`. Progress counts ALL `.acl` files across ALL airports as a single global 0–100%.
3. `init-airport-cache` and `refresh-root-scan` also stamp `cacheVersion` when writing
4. Same progress modal appears during initial cache build in SetupScreen (`initAirportCache`)

**Language persistence:**
- `lang` field in `cache.json` provides durable backup for language preference
- `useTranslation` reads from cache JSON when `localStorage` is empty, and writes to both on toggle
- IPC handlers: `get-cached-lang`, `save-cached-lang`

**IPC handlers (new):** `get-cache-state`, `get-cached-lang`, `save-cached-lang`
**IPC handlers (removed):** `get-last-root`, `save-last-root`, `check-version-mismatch`, `update-cached-version`
**Preload bridges (new):** `getCacheState()`, `getCachedLang()`, `saveCachedLang(lang)`
**Modal:** `showModal(title, body, actions, closeable, headerRight, showLangToggle)` — `showLangToggle` renders a live lang toggle button using Modal's own `useTranslation` hooks

### Phase 1: Load Level
1. User clicks a level row → `window._pendingEditor = { filePath, airportIcao }` → `setScreen('editor')`
2. EditorScreen's `useEffect` reads `window._pendingEditor` and loads:
   - `load-acl` IPC → reads `.acl` → parses FlightPlans as primary flight data
   - `load-timelines` IPC → reads timelines from ACL + `windSpeedUnit` from `airport_config.json` (defaults to `'knots'`)
   - `collect-values` IPC → reads dropdown options from airport cache (no file I/O). Also returns `_taxiwayPaths`, `_runwayData`, `_sidPaths`, `_missedAppPaths`, `_sidRunwayMap`, `_runwaySidMap` for map window rendering.
   - `load-audio-callsigns` IPC → reads audio callsigns from airport cache (no file I/O)
3. **Wind speed conversion:** If `windSpeedUnit` is `'mps'`, speeds are converted to knots on load (1 m/s = 1.94384 kt). The zustand store always holds knots. Stored in `_windSpeedUnit`.
4. Zustand store is populated and React renders the flight table

### Phase 2: Edit (all in zustand store)
- All edits go through store actions: `updateFlight()`, `addArrivalFlight()`, `deleteSelected()`, etc.
- `store.modified = true` on any change
- `store.timelineModified[type] = true` on timeline changes

**Clock time validation (v1.1.2):** When committing a time value via the clock popover, `EditableCell` (FlightTable) and `TimeCell` (timeline editors) validate against field-specific bounds before accepting the value. Out-of-bounds values show a toast and are rejected.

- `getTimeValidationBounds(col, _saveSec, _configStartTime, _configEndTime)` in `src/utils/timeUtils.js` returns `{minTime, maxTime}` or `null`:
  - **OffBlockTime / LandingTime**: bounded by `[_saveSec, _configEndTime]` — must be after the scenario snapshot and before the config end
  - **InBlockTime / TakeoffTime**: no bounds validation (save only checks ordering/sequence against sibling fields)
  - **Timeline / generic Time**: bounded by `[_configStartTime, _configEndTime]` — must be strictly within the level range
- Toast i18n key: `clock_time_out_of_bounds` — `"Time must be between {{min}} and {{max}}"`
- Timeline editors (`WeatherEditor`, `WindEditor`, `RunwayEditor`) pass `minTime`/`maxTime` from `_configStartTime`/`_configEndTime` via `getTimelineActiveRange`

### Phase 3: Save
1. `handleSave()` → `validateCallsigns()` → `runTripleValidation()`:
   - (a) Dropdown value validation — every field against valid options
   - (b) Time range validation — flights within config startTime/endTime bounds
   - (c) Runway timeline bounds — change entry times within level range
   - (d) STAR/runway combination validation — flags flights where the assigned STAR is not valid for the assigned runway (per SceneryData Type=0 Routes via `starRunwayMap`)
   - (e) Duplicate registration validation — flags flights where the same Registration appears in multiple departure or arrival flights (see below)
2. **Wind speed conversion:** Wind speeds are converted from knots (store) back to the airport's native unit (e.g., mps) before being sent to IPC handlers. This ensures `wind_timeline.json` and the ACL both contain values in the unit the game expects.
3. `save-acl` IPC → sorts flights → looks up approach cache for the airport → generates full ACL via `_rebuildWorldStateSections()`:
   - FlightPlans rebuilt from scratch with new GUIDs
   - **AircraftState entries generated for arrival flights** where `0 < ProgressRatio < 1.0` (mid-approach at snapshot time), using `approach.js` verified algorithm: AppPointList lookup, FlyApproach resolution from SceneryData, PR formula, Position/Direction interpolation
   - **Preserved segments patched:** `_expandShortFormTypes()` expands short-form `$type: N` references in `segBefore`/`segAfter` to full-form so Unity deserialization survives the Aircrafts rebuild. `_fixSingletonStateRefs()` replaces dangling `$iref` references in `GameEventScheduler.EventQueue` / `EventLogger.History` with inline empty `AircraftEvent[]` queues — these `$iref` targets lived in the original Aircrafts `$rcontent` and are lost after rebuild.
   - `_resetJetwayDockingState()` clears orphaned `DockingAircraftGuid` values in the preserved Jetways section (old aircraft GUIDs no longer exist)
   - Writes `.acl` + `.csv`
   - **Demo `.demo.acl` files treated identically** — save writes to `.demo.acl` + same shared `.csv` + shared timeline `.json` files
4. Timeline saves (separate IPC per type) → writes JSON files
5. Backup: `.bak` copies created before overwrite (optional, checkbox in save dialog). For `.demo.acl` files, creates `.demo.acl.bak`

### Toolbar Backup Button
- **Backup button** (toolbar, `handleBackup`): directly copies current `.acl` → `.acl.bak` in the same directory (no file picker dialog)
- If a `.bak` file already exists, a confirmation modal appears before overwriting
- Uses `check-backup-exists` IPC to detect existing `.bak`, then `manual-backup` IPC to copy

### Save As ZIP
- Saves silently → packages 5 files into ZIP → native save dialog
- ZIP contents: `.acl` + `.csv` + `weather_timeline.json` + `wind_timeline.json` + `runway_timeline_*.json`
- Works identically for `.demo.acl` files (packs `.demo.acl` + shared `.csv` + shared timelines)

### Import ZIP
- Native open dialog → validates ZIP structure → backs up current files → extracts → reloads
- Works identically for `.demo.acl` files

### Stand Conflict Detection (v1.1.0)

Stand conflicts are validated on save via `detectStandConflicts()` in `src/utils/validators.js`. Three rules, based on in-game testing:

| Pair | Enforced | Rule |
|---|---|---|
| **dep + dep** | ✅ | Always conflict — unique stand per schedule (regardless of time) |
| **dep + arr** | ✅ | `offblock >= landing` — strict bound. Departure must vacate **before** arrival touches down. |
| **arr + arr** | ❌ | Game does not enforce — intentionally skipped |

**Occupancy window:** Arrival start uses `landing` (touchdown), not `inblock` (parking). Fallback: `inblock − 5min` when `landing` is missing. Departure end uses `offblock`.

**Message formats:**
- dep/dep: `"CES1234 和 CAL5678: 停机位 \"A01\" 时段重叠。"` (simple, no times)
- dep/arr: `"CDG5166 和 CCA2761: 停机位 \"26\" 时段冲突。CDG5166推出 (07:58:00) >= CCA2761落地 (07:50:00)"` (pinpoints violation)
- i18n keys: `val_stand_conflict`, `val_stand_conflict_dep_arr`

### Duplicate Registration Detection (v1.1.2)

`detectDuplicateRegistrations()` in `src/utils/validators.js` catches the same Aircraft Registration appearing in multiple flights of the same type:

| Scope | Rule |
|---|---|
| **dep + dep** | Same Reg in two departure flights → error |
| **arr + arr** | Same Reg in two arrival flights → error |
| **dep + arr** | Allowed — same aircraft can depart and arrive (turnaround) |

- Flight type is determined by `isDeparture` flag or presence of `LandingTime` vs `OffBlockTime`
- i18n keys: `val_duplicate_registration_dep`, `val_duplicate_registration_arr`

### Stand Map Overlay

When editing a Stand cell in the flight table, a non-blocking overlay panel appears pinned to the right edge of the app window. It shows:

- **SVG map** of all stands for the current airport, with dots positioned by real x,y coordinates parsed from `SceneryData > TaxiwayNodes`
- **4 dot states**: Current (accent, large + ring), Hovered (accent, medium), Available (accent, small), Occupied (grey, not clickable)
- **Occupancy detection**: `computeOccupiedStands()` in FlightTable checks time-window overlaps between flights
- **Airport background**: Dark radar-style fill (`#0a1628`) with programmatic SVG: taxiway centerlines, runway rectangles, area polygons (boundary/apron/building) at 0.2 opacity — same data as GroundMapWindow (`_taxiwayPaths`, `_runwayData`, `_areaData` from `collect-values`)
- **Dark mode**: Map content area forces dark mode CSS variables regardless of app theme
- **i18n**: Title and legend use `standmap_title`, `standmap_current`, `standmap_available`, `standmap_occupied` keys

**Component:** `src/components/EditorScreen/StandMap/StandMap.jsx` — portal-based, responsive (scales with window via `useWindowSize` hook), viewBox preserves data aspect ratio with a target ratio cap. Uses the shared `useDrag` hook for header-drag repositioning. Receives `taxiwayPaths`, `runwayData`, `areaData` from EditorScreen (already in store from `collect-values`).

### Star Map Overlay

When editing an Airway cell in the flight table, a non-blocking overlay panel shows the STAR/approach chart for the current airport. It displays:

- **SVG map** of all STAR waypoint paths for the airport, plotted from real x,z coordinates in SceneryData `AirwayNodes`
- **Runway thresholds** rendered as extended lines (3× runway length), parsed from `SceneryData.Runways.ThresholdPointGuids` via `_parseRunwayThresholds()`
- **Live aircraft positions** on approach — arrival flights' positions computed via `get-aircraft-positions` IPC using the same `computePosition()` algorithm as State=30/State=5 save generation
- **Aircraft interactivity**: Hovering an aircraft dot shows callsign + STAR + runway + ETA
- **Click to select** a STAR path, which updates the flight's Airway field via `updateFlight(idx, { Airway: starName })`
- **Departure flights**: Show a notice that the STAR map is unavailable (no approach data for departures)
- **Airport background**: `_STAR.png` (scaled-down `_Map.png` at 25% resolution) positioned via `AIR_MAP_BG_OFFSETS` — same algorithm as AirMapWindow (image fills viewBox, per-airport dx/dy/w offsets, `bgUnder` rect behind it, 0.2 opacity, `preserveAspectRatio="xMidYMid slice"`)
- **Dark mode**: Map content area forces dark mode CSS variables regardless of app theme
- **i18n**: Title and legend use `starmap_title`, `starmap_current`, `starmap_available`, `starmap_disabled`, `starmap_no_data` keys

**Component:** `src/components/EditorScreen/StarMap/StarMap.jsx` — portal-based, draggable via `useDrag` hook, responsive viewBox scaling. Path colors cycle through a preset palette per STAR name. Runway thresholds rendered as thin colored lines matching their associated STAR paths.

**Map overlay orchestration:** `MapOverlays` sub-component in `EditorScreen.jsx` manages visibility and prop-passing for both StandMap and StarMap. Visibility state lives in zustand (`showStandMap`, `showStarMap`, `activeMap`, `mapFlightIdx`). Only one map is "on top" at a time (controlled by `activeMap`). Both maps close when leaving the editor screen (`setScreen` clears map state).

## Map Windows (Surface Radar & Approach Radar) — v1.1.3

Map windows are separate Electron `BrowserWindow` instances (one per airport ICAO + type pair), NOT React components rendered in the main window. They provide real-time radar visualization of aircraft positions streamed via UDP telemetry from the running game.

### Architecture

- `electron/main.js` manages two `Map` instances:
  - `groundMapWindows` — keyed by airport ICAO, holds `BrowserWindow` for Surface Radar
  - `airMapWindows` — keyed by airport ICAO, holds `BrowserWindow` for Approach Radar
- Each map window loads the same Vite SPA with query params:
  - `?window=groundMap&airport=XXXX&root=...` → renders `<GroundMapWindow>`
  - `?window=airMap&airport=XXXX&root=...` → renders `<AirMapWindow>`
- `App.jsx` (lines 23-28) checks `URLSearchParams` **before** the normal screen router
- On window `closed`, the main process deletes the entry from its Map and sends `radar-window-closed` to the main window so the UI can update its toggle state

### IPC Handlers (main → renderer)

| Channel | Args | Direction | Purpose |
|---------|------|-----------|---------|
| `open-ground-map` | `(airportIcao, gameRoot)` | invoke | Creates/focuses Surface Radar BrowserWindow |
| `open-air-map` | `(airportIcao, gameRoot)` | invoke | Creates/focuses Approach Radar BrowserWindow |
| `close-ground-map` | `(airportIcao)` | invoke | Closes Surface Radar window |
| `close-air-map` | `(airportIcao)` | invoke | Closes Approach Radar window |
| `radar-window-closed` | `{ icao, type }` | main→renderer | Notifies main window that user closed a map window (X button) |
| `select-aircraft-in-map` | `(airportIcao, callSign)` | invoke | Sets selected aircraft, sends UDP SelectAircraft command, broadcasts to all map windows for that airport |
| `get-selected-aircraft` | `(airportIcao)` | invoke | Returns currently selected callSign for an airport (or null) |
| `aircraft-selected-in-map` | `{ icao, callSign }` | main→renderer (push) | Broadcasts selection change to ground + air map windows for the same airport |
| `reset-udp-aircraft` | none | invoke | Clears all UDP aircraft state (used by map refresh button) |
| `send-udp-command` | `(commandId, payloadB64)` | invoke | Sends fire-and-forget UDP command to game on port 20267 |
| `debug-log` | `(args[])` | invoke | Logs renderer messages to main process terminal (debug only) |
| `udp-aircraft-state` | `state` | main→renderer (push) | Live aircraft state pushed every 200ms to all open map windows |

### Preload API (`window.electronAPI` additions)

```js
// Map window launchers
openGroundMap(airportIcao, gameRoot)    // → ipcRenderer.invoke('open-ground-map', ...)
openAirMap(airportIcao, gameRoot)       // → ipcRenderer.invoke('open-air-map', ...)
closeGroundMap(airportIcao)             // → ipcRenderer.invoke('close-ground-map', ...)
closeAirMap(airportIcao)                // → ipcRenderer.invoke('close-air-map', ...)
onRadarWindowClosed(cb)                 // → ipcRenderer.on('radar-window-closed', handler)

// Linked aircraft selection (synced across ground + air map for same airport)
selectAircraftInMap(airportIcao, callSign)  // → ipcRenderer.invoke('select-aircraft-in-map', ...)
getSelectedAircraft(airportIcao)            // → ipcRenderer.invoke('get-selected-aircraft', ...)
onAircraftSelectedInMap(cb)                 // → ipcRenderer.on('aircraft-selected-in-map', handler)
offAircraftSelectedInMap(cb)                // → ipcRenderer.removeListener(...)

// UDP telemetry
getUdpStatus()                          // → { connected, lastPacketTime, currentAirport }
getUdpAircraftState()                   // → { aircraft, currentAirport, recordCount, simTimeUnixMs }
resetUdpAircraft()                      // → clears all aircraft state (map refresh button)
sendUdpCommand(commandId, callSign)     // → base64-encodes 12B callSign, invokes 'send-udp-command'
debugLog(...args)                       // → ipcRenderer.invoke('debug-log', args) — logs to main terminal
onUdpAircraftState(cb)                  // subscribe to live ~10 Hz pushes
offUdpAircraftState(cb)                 // unsubscribe (must be SAME function reference)
onCacheBuildProgress(cb)                // subscribe to cache build progress: cb({ current: number, total: number })
offCacheBuildProgress(cb)               // unsubscribe (must be SAME function reference)
```

### GroundMapWindow (`src/components/MapWindows/GroundMapWindow.jsx`)

**Purpose:** SVG surface radar for tracking aircraft movement on the ground at a specific airport.

**Layout:** Flex row with a `ControlSidebar` on the right containing spin knobs (zoom, E-W pan, S-N pan), push-button toggles (parked aircraft, taxiway labels, refresh), and a **help button** (`?` icon). Sim-time clock displayed in top-left corner.

**Data sources:**
- `_taxiwayPaths` — taxiway centerline polylines from approach cache (via `electronAPI.collectValues()`)
- `_runwayData` — runway rectangles (threshold pairs + width) computed in `collect-values` IPC
- `_standPositions` — stand midpoints from approach cache (via `electronAPI.collectValues()`)
- `_areaData` — area polygons by AreaType (0=airport boundary, 1=stand/apron, 2=building) from approach cache
- `useUdpAircraftState()` — live aircraft positions + `simTimeUnixMs` from UDP telemetry
- `GROUND_MAP_CENTER_OFFSET` — per-airport viewBox center offset (game units)

**Rendering layers:**
1. Radar-blue background (`#0a1628`). Witch mode: `witch/groundradar.png` image stretched to viewBox, background color `#24150a`.
2. Taxiway centerlines — uniform grey (`#444`) polylines. Segments touching stand-position nodes are marked `isStandAccess: true` and rendered with square linecap + configurable width multiplier (`GROUND_MAP_STAND_ACCESS_WIDTH_MULT`). Stand-access segments are no longer excluded — they render alongside main taxiways for differentiated styling. **Runway-named taxiway segments** (name matches a runway in `runwayData`) are excluded from this layer — they render as runway-style polygons instead (see layer 4b).
3. Area polygons — semi-transparent fills by AreaType: blue boundary, grey apron, black buildings. Default stroke color `#444` (matches taxiways). Parsed from `SceneryData.Areas` via `_parseAreas()`.
4. Runway rectangles — black filled polygons from threshold endpoints + width
5. **Runway-named taxiway segments** — taxiway centerlines whose name matches a runway entry are rendered as black filled polygons (same style as runways), using `computeRunwayCorners()` with the matching runway's width. These represent runway surfaces stored as taxiway centerline segments.
6. Taxiway labels — name labels at path midpoints with proximity dedup (`GROUND_MAP_TAXIWAY_LABEL_SPACING`). Placed **above** runways in layer order (was below runways before v1.1.4). Only rendered for non-runway taxiway segments.
6. Live ground aircraft — filtered to `position.y <= 1.0` (ground-level, not airborne) with inactive aircraft hidden by default:
   - **Inactivity filter:** Aircraft at a known stand (UDP `stand` field ∈ `_standPositions`) AND within `GROUND_RADAR_STAND_PROXIMITY` (0.5 GU ≈ 50m) of that stand's midpoint are hidden as "parked/inactive"
   - **"Parked" toggle:** Push-button (i18n: `ground_map_show_all`) bypasses the inactivity filter, showing all ground-level aircraft
   - **Icon:** `MAP_ICON_PATH` (IonIons IoAirplane SVG path) rotated by `noseDirection.x/z`
   - **Label:** Green callsign text with a short connector line from aircraft to label
   - **Selection highlight:** Yellow icon + label when aircraft is selected (click-to-select)
   - **Witch mode (v1.1.5):** Double-click the help `?` button to toggle. Aircraft rendered as animated 2-frame sprites from 15 character sheets (`public/witch/*.png`, each a 1536×768 sprite sheet with 18 cells in a 3-row×6-column grid of 256×256 PNGs with transparent backgrounds). A nested `<svg>` with `clipPath` isolates the target cell, then an `<image>` loads the full sheet clipped to that cell. `feDropShadow` traces the character's alpha channel for a white silhouette glow — only on the **active** (click-selected) aircraft (`callSign === selectedCallSign`). Characters assigned round-robin (module-level `_assignments` Map), stable per callsign. Moving: walk sprites (direction-aware via `witchDirection()`); parked/stopped: stand sprites (`isParked()` uses `taxiSpeed < 1` OR stand proximity). Airport boundary (AreaType 0) is hidden. Any click exits witch mode. Labels and connector lines hidden. Background replaced with `witch/groundradar.png`, sidebar gets witch-themed UI (bar.png background, button.png/button_on.png toggles, knob.png spin knobs, help.png icon).

**Zoom/pan:** `useSvgZoom` hook, per-airport initial viewBox via `GROUND_MAP_DEFAULT_ZOOM` + `GROUND_MAP_CENTER_OFFSET`, pan clamped to initial bounds.

**Click-to-select:** Calls `electronAPI.selectAircraftInMap(airportIcao, callSign)` — centralized IPC handler that stores selection in main process, sends `SelectAircraft` UDP command, and broadcasts the change to all map windows for the same airport (ground + air). On mount, fetches current selection via `getSelectedAircraft` so a newly-opened map window inherits any existing selection. Background click deselects via `selectAircraftInMap(airportIcao, null)`. The selected callSign is rendered with yellow highlight.

### AirMapWindow (`src/components/MapWindows/AirMapWindow.jsx`)

**Purpose:** SVG approach radar for tracking airborne aircraft and visualizing STAR/SID/APPR/missed-approach routes with range rings, runway extensions, and border overlay.

**Layout:** Flex row with a `ControlSidebar` on the right containing spin knobs (zoom, E-W pan, S-N pan, airspace with gauge indicators), push-button toggles (STAR, SID, APPR, Labels, ILS, Map, Refresh), and a **help button** (`?` icon). Sim-time clock in top-left corner.

**Data sources:**
- `_starPaths` (STAR routes, Type=0) — rendered in grey; trimmed at APPR overlap points
- `_sidPaths` (SID departure routes, Type=2) — rendered in grey
- `_missedAppPaths` (Missed Approach routes, Type=3) — rendered in grey
- `_apprPaths` (RNAV approach routes, Type=1) — rendered in grey; points used to trim STAR display
- `_runwayThresholds` from approach cache — for threshold lines and runway extensions
- `useUdpAircraftState()` — live aircraft positions + `simTimeUnixMs`
- `AIR_MAP_BG_OFFSETS` from `src/utils/constants.js` — per-airport background image config
- `AIR_MAP_DEFAULT_ZOOM` from `src/utils/constants.js` — per-airport initial zoom scale
- `NM_TO_GU` from `src/utils/constants.js` — nautical mile to game-units conversion (18.52)

**Rendering layers (bottom to top):**
1. Background map image (toggleable): `/{ICAO}_STAR.png` positioned via `bgCfg`, opacity 20%. Background color via CSS custom property `--air-map-bg`. Witch mode (see below) uses `witch/{ICAO}_STAR.png` at full opacity with independent `WITCH_MAP_BG_OFFSETS` positioning.
2. Range rings (airspace knob, 12 levels from 10–120 NM gap): centered on geometric mean of all runway thresholds, radius labels when route labels enabled.
3. SID / STAR / APPR routes — each independently toggleable, grey (`#888888`) at 50% opacity. STAR paths are trimmed at APPR overlap points so each category shows its unique portion.
4. Route name labels (toggleable + per-category): positioned at path starts with vertical spreading to avoid overlaps.
5. Runway extension lines (toggleable): 1–20 NM dashed white lines from each threshold with tick marks at 5/10/15/20 NM.
6. Runway thresholds — runway-width lines connecting threshold pairs.
7. Border overlay — independent SVG with white border rect and 10° tick marks with degree labels. Tick/label sizes scale inversely to container width via `ResizeObserver` (baseline 800px) so they stay fixed in pixels when the window resizes.
8. Live airborne aircraft — filtered to `position.y > 1.0`:
   - **Direction-based coloring:** Outbound aircraft (`flightDirection === 0`) render with green labels/indicators (`#66ff66`); inbound aircraft (`flightDirection === 1`) use white. Dots remain `#1a4a8a` blue for all. Selected aircraft always get yellow highlights.
   - **Circle:** Small colored circle at aircraft position (unselected) or yellow (selected)
   - **Trail dots:** Ring buffer of historical positions (max 5 snapshots, minimum 600-tick gap), rendered as shrinking circles with decreasing opacity
   - **Heading line:** For selected aircraft only, projects nose direction forward 12× planeScale
   - **Label:** Callsign + speed/type (toggles every 5 seconds between airspeed/10 and aircraft type), dynamically positioned via anti-overlap layout (4 candidate positions: right/top/left/bottom). Emergency aircraft show an "EM" label above the callsign in red.
   - **A/D indicator:** "A" or "D" text next to the current position dot
   - **Witch mode (v1.1.5):** Double-click the help `?` button to toggle. Aircraft rendered as animated 2-frame fly sprites from 15 character sheets (`public/witch/*.png`, each a 1536×768 sprite sheet with 18 cells in a 3-row×6-column grid of 256×256 PNGs with transparent backgrounds). A nested `<svg>` with `clipPath` isolates the target cell, then an `<image>` loads the full sheet clipped to that cell. `feDropShadow` traces the character's alpha channel for a white silhouette glow — only on the **active** (click-selected) aircraft (`callSign === selectedCallSign`). Characters assigned round-robin, stable per callsign. Direction-aware via `witchDirection()` (dominant axis of nose vector). Any click exits witch mode. Labels, connectors, and heading lines hidden. Map background switches to `witch/{ICAO}_STAR.png` at full opacity with `WITCH_MAP_BG_OFFSETS`, background color `#160900`. Sidebar gets witch-themed UI (bar.png background, button.png/button_on.png toggles, knob.png spin knobs, help.png icon).

**Airspace knob:** `SpinKnob` passed via `airspaceKnob` prop to `ControlSidebar` — controls range ring density (0=10NM gap … 11=120NM gap, default 40NM). Double-click knob to reset to default.

**Emergency call sign:** Refresh button (double-click) randomly picks an active aircraft and marks it with a red "EM" label. Single click resets UDP aircraft state.

**Zoom/pan:** `useSvgZoom` hook, per-airport initial viewBox via `AIR_MAP_DEFAULT_ZOOM`, pan clamped to initial bounds. Spin knobs show gauge positions derived from current zoom/pan relative to initial viewBox.

**Click-to-select:** Same centralized `electronAPI.selectAircraftInMap(airportIcao, callSign)` pattern as GroundMapWindow. Selection syncs across both map windows for the same airport.

**Help overlay:** A `?` button in the control sidebar opens a context-sensitive `MapHelpOverlay` (type `"air"` or `"ground"`) that documents all knobs, toggle buttons, and interactions with interactive inline button visuals. Closes on Escape key or background click.

### Shared Hooks

**`useSvgZoom.js`:**
- Scroll-wheel zoom: cursor-centered, 1.12× factor per tick, clamped between 2% and 100% of initial viewBox
- Click-drag pan: pixel-to-viewBox coordinate conversion, **clamped** to stay within initial viewBox bounds
- Reset on first data load only (not subsequent prop changes)
- **Imperative zoom/pan API** (for sidebar spin knobs, uses `viewBoxRef` to avoid stale closures):
  - `zoomIn()` / `zoomOut()` — center-based, 1.12× factor, clamped
  - `panLeft()` / `panRight()` / `panUp()` / `panDown()` — 5% step, clamped to initial bounds
- **Axis-specific resets:** `resetPanH()` (horizontal only) and `resetPanV()` (vertical only) preserve zoom + opposite-axis offset
- Returns `{ viewBox, svgRef, resetZoom, resetPanH, resetPanV, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp, zoomIn, zoomOut, panLeft, panRight, panUp, panDown }`

**`useUdpAircraftState.js`:**
- Subscribes to `electronAPI.onUdpAircraftState` on mount, unsubscribes on unmount
- Returns `{ aircraft: Array, currentAirport: string|null, simTimeUnixMs: number }` updated at ~10 Hz
- Used by both GroundMapWindow and AirMapWindow (simTimeUnixMs drives the SimClock component)

### BrowserScreen Integration

- **Radar toggle buttons:** Each airport card shows two radar buttons when NOT in demo mode (`!isDemo`):
  - "Surface Radar" (`IoMapOutline` icon, i18n: `toolbar_surface_radar`)
  - "Approach Radar" (`IoNavigateOutline` icon, i18n: `toolbar_approach_radar`)
  - Buttons have an `.active` class when the corresponding window is open for that airport
  - In demo mode (`rootPath` includes `'Airport Control 27 Demo'`), radar buttons are hidden entirely
- **Toggle handler:** Checks `openGroundRadarAirports` / `openAirRadarAirports` Sets — if ICAO present, calls `closeXxxMap` IPC; otherwise calls `openXxxMap` IPC. Updates zustand state on both paths.
- **Window-closed sync:** `onRadarWindowClosed` listener updates zustand Sets when user closes a map window via its X button (the main process notifies the renderer so toggle state stays in sync).

### Zustand Store Additions (`appStore.js`)

```js
// State
openGroundRadarAirports: new Set(),   // ICAO codes of open Surface Radar windows
openAirRadarAirports: new Set(),      // ICAO codes of open Approach Radar windows
udpConnected: false,                   // UDP telemetry listener is receiving packets
udpCurrentAirport: null,              // Current airport ICAO from UDP (null if no packets)

// Actions
setGroundRadarOpen(icao, open)  // Add/remove from openGroundRadarAirports Set
setAirRadarOpen(icao, open)     // Add/remove from openAirRadarAirports Set
isGroundRadarOpen(icao)         // → openGroundRadarAirports.has(icao)
isAirRadarOpen(icao)            // → openAirRadarAirports.has(icao)
setUdpStatus(connected, currentAirport)  // Update UDP health state
```

**Important:** Set mutations must create a new `Set(...)` rather than mutating in place, per existing zustand Immutability rules.

### Map Window i18n Keys

| Key | Chinese | English |
|-----|---------|---------|
| `toolbar_surface_radar` | 场面雷达 | Surface Radar |
| `toolbar_approach_radar` | 进近雷达 | Approach Radar |
| `air_map_bg` | Map | Map |
| `air_map_airspace` | Airspace | Airspace |
| `air_map_runway_ext` | ILS | ILS |
| `air_map_labels` | Label | Label |
| `air_map_star` | STAR | STAR |
| `air_map_sid` | SID | SID |
| `air_map_appr` | APPR | APPR |
| `ground_map_taxiway` | Label | Label |
| `ground_map_show_all` | Parked | Parked |
| `map_refresh` | Refresh | Refresh |
| `knob_zoom` | Range | Range |
| `knob_pan_h` | E-W | E-W |
| `knob_pan_v` | S-N | S-N |
| `map_help_title` | 功能指南 | Map Help |
| `map_help_air_knobs_heading` | 旋钮 | Knobs |
| `map_help_air_toggles_heading` | 按钮 | Buttons |
| `map_help_air_interact_heading` | 交互 | Interaction |
| `map_help_ground_knobs_heading` | 旋钮 | Knobs |
| `map_help_ground_toggles_heading` | 按钮 | Buttons |
| `map_help_ground_interact_heading` | 交互 | Interaction |

### New Constants

- **`AIR_MAP_BG_OFFSETS`** (`src/utils/constants.js`): Per-airport config for approach radar background image (renamed from `STAR_BG_OFFSETS`). Fields: `dx`/`dy` (fine-tune position offset), `w` (image width in viewBox units when height=3000), `bg` (color outside map image), `bgUnder` (color behind semi-transparent image). Entries for ZSJN and KJFK. Witch mode uses separate `WITCH_MAP_BG_OFFSETS`.
- **`NM_TO_GU`** (`src/utils/constants.js`): Nautical mile to game-units conversion (18.52 = 1852m ÷ 100 m/unit). Used by AirMapWindow for runway extension lines, tick marks, and range rings.
- **`AIR_MAP_DEFAULT_ZOOM`** / **`GROUND_MAP_DEFAULT_ZOOM`** (`src/utils/constants.js`): Per-airport default zoom scale. 1.0 = full dataBounds, <1 = tighter initial view. Entries for ZSJN (0.75 ground) and KJFK (1.0 both).
- **`GROUND_RADAR_STAND_PROXIMITY`** (`src/utils/constants.js`): Max distance (0.5 GU ≈ 50m) from aircraft position to its assigned stand midpoint to consider it "parked at stand." Used by GroundMapWindow to hide inactive aircraft.
- **`GROUND_MAP_CENTER_OFFSET`** (`src/utils/constants.js`): Per-airport viewBox center offset in game units (`{x, z}`). Used by GroundMapWindow to fine-tune initial camera position. Entries for ZSJN and KJFK.
- **`GROUND_MAP_TAXIWAY_LABEL_SPACING`** (`src/utils/constants.js`): Minimum distance (10.0 GU) between same-name taxiway labels to prevent label clutter. Used by GroundMapWindow for proximity dedup.
- **`GROUND_MAP_STAND_ACCESS_WIDTH_MULT`** (`src/utils/constants.js`): Multiplier (1.0) for stand-access taxiway line width. Stand-access segments are rendered with square linecaps for differentiated styling. Change this to make stand-access stubs visually distinct from main taxiways.
- **`WITCH_MAP_BG_OFFSETS`** (`src/utils/constants.js`): Per-airport config for witch mode map background images (`witch/{ICAO}_STAR.png`). Independent of normal mode offsets. Fields: `dx`/`dy` (fine-tune position), `w` (override image width, 0 = use default). Entries for ZSJN and KJFK.

## UDP Telemetry Pipeline

`electron/udp_listener.js` (271 lines) is the UDP telemetry engine that bridges the running game's live aircraft data into the Level Editor.

### Architecture

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

### Binary Protocol (Inbound Telemetry, Port 20266)

Packets from the game arrive at ~10 Hz. Format: 40-byte header + N × 112-byte records.

**Header (40 bytes, little-endian):**

| Offset | Type | Field | Notes |
|--------|------|-------|-------|
| 0 | u32 | magic | `0x43544147` = ASCII `"GATC"` |
| 4 | u16 | version | Currently `1` |
| 6 | u16 | headerSize | Always `40` — record data starts here |
| 8 | u16 | recordSize | Always `112` — stride per record |
| 10 | u16 | recordCount | Number of records in this packet |
| 12 | 4B | airportIcao | ASCII uppercase (4 chars) |
| 16 | u64 | simTick | Simulation tick (60 Hz) |
| 24 | i64 | simTimeUnixMs | Sim time in Unix milliseconds |
| 32 | 8B | reserved | Zero-filled |

**Record (112 bytes each, little-endian):**

| Offset | Type | Field | Notes |
|--------|------|-------|-------|
| 0 | 12B | callSign | Active segment callsign, ASCII zero-padded |
| 12 | 8B | aircraftType | ICAO designator (e.g. `B77W`, `A320`) |
| 20 | u8 | flightDirection | `0` = Departure, `1` = Arrival |
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

### Trail Ring Buffer

To render trailing dots on the AirMapWindow (historical positions), the listener maintains a `trailSnapshots` Map:

- **Per callsign:** Ring buffer of `{ x, z, simTick }` objects
- **Max 5 snapshots** per aircraft
- **Minimum 600-tick gap** between snapshots (~10 game-seconds at 60 Hz)
- Live position: `age: 0`, trail entries: `age: 10, 20, 30, 40, 50...` (age = approximate seconds old)
- Used by map windows to render shrinking circles with decreasing opacity

### Command Channel (Outbound, Port 20267)

The listener also sends fire-and-forget UDP commands to the game on `127.0.0.1:20267`.

- **`sendCommand(commandId, payloadBuf)`** → `Promise<{ success, error? }>`
- 8-byte header: magic (u32 LE, `0x43544147`) + version (u16 LE, `1`) + commandId (u16 LE)
- **Only supported command:** commandId=1 (`SelectAircraft`), 12-byte ASCII callSign payload (20B total datagram)
- No response expected — effect is observed through the telemetry stream
- Preload wraps this as `sendUdpCommand(commandId, callSign)` which base64-encodes a 12-byte callSign buffer

### Live State Push to Map Windows

- `startUdpListener()` called in `app.whenReady()` after `createWindow()`
- `setInterval` at 200ms reads `getUdpAircraftState()` and sends `udp-aircraft-state` IPC event to all open map windows (`groundMapWindows` + `airMapWindows`)
- On `will-quit`, `stopUdpListener()` cleans up: closes socket, clears all intervals/timeouts, resets `aircraftMap`, `trailSnapshots`, etc.
- Auto-reconnect on socket errors with 2-second delay and logging

### Public API (`electron/udp_listener.js` exports)

| Export | Returns | Description |
|--------|---------|-------------|
| `start()` | void | Bind socket, begin parsing packets |
| `stop()` | void | Close socket, clear intervals, reset state |
| `getUdpStatus()` | `{ connected, lastPacketTime, currentAirport }` | Current health status |
| `getUdpAircraftState()` | `{ aircraft: [], currentAirport, recordCount, simTimeUnixMs }` | Latest aircraft positions + trails + sim time |
| `resetAircraftState()` | void | Clear all aircraft state (`aircraftMap` + `trailSnapshots`) — used by map window refresh button |
| `sendCommand(cmdId, payloadBuf)` | `Promise<{ success, error? }>` | Fire-and-forget command to game |

### IPC Exposure

- `get-udp-status` handler → `getUdpStatus()`
- `get-udp-aircraft-state` handler → `getUdpAircraftState()`
- `reset-udp-aircraft` handler → `resetAircraftState()` — clears stale aircraft after game level restart
- `send-udp-command` handler → base64-decodes `payloadB64` → `sendCommand(commandId, buf)`

### Demo .acl File Handling (v1.0.9+)

The game ships four 30-minute `.demo.acl` slice levels plus one `_emerg` emergency-scenario level:
- `ZSJN-Morning_120min.demo.acl` (05:45–06:15)
- `ZSJN_07-10.demo.acl` (07:30–08:00)
- `ZSJN_17-19_emerg.acl` — emergency scenario, **not** a 30-min demo slice (no time filtering)
- `KJFK_09-11.demo.acl` (09:30–10:00)
- `KJFK_20-22.demo.acl` (20:30–21:00)

**Key properties:**
- Each `.demo.acl` is a save-state snapshot with the **same BaseTime** as its parent but a **later CurrentDateTime** (~40–55 min offset), creating the 30-min playable window
- FlightPlans, scenery, and file references are identical to the parent `.acl`
- No matching `.aclcfg` exists — Config is read from the `.acl` file itself

**`_emerg` files:** Emergency-scenario files (filenames containing `_emerg`) are regular levels, not 30-minute demo slices. The `_isEmerFile()` helper in `electron/main.js` detects them and skips the 30-min `_filterDemoFlights()` time window. When rooted in the Demo game, `_emerg` files are shown alongside `.demo.acl` files via the `DEMO_VISIBLE_BASES` whitelist in `src/utils/constants.js`.

**Demo mode visibility:** The `DEMO_VISIBLE_BASES` Set in `src/utils/constants.js` is a whitelist of base filenames (without `.acl` or `.demo.acl` extension) that are visible when browsing the demo game root. `demoBaseName(filename)` strips extensions for matching. Update this set when demo levels are added or removed.

**Editor behavior:**
- `.demo.acl` files are treated as **normal levels** — always visible, no tags, no hiding
- **Demo mode** (root path contains "Airport Control 27 Demo"): only `.demo.acl` files **plus** `_emerg` files listed in `DEMO_VISIBLE_BASES` are shown
- **On load:** flights in `.demo.acl` files (non-emergency) are filtered to a 30-minute window starting at `CurrentDateTime` via `_filterDemoFlights()` — centralized helper shared across load, save, import, and restore paths. Uses integer-minute bounds: `[cdtMin, cdtMin + 30)` (inclusive lower, exclusive upper). Config's `startTime`/`endTime` are overridden to match. `_emerg` files skip this filter.
- **On save:** writes to `.demo.acl` + shared `.csv` + shared timeline `.json` files; creates `.demo.acl.bak`. `_emerg` files save normally (no time filtering).
- **Export/Import:** packs/unpacks `.demo.acl` identically to normal `.acl` files
- **Approach cache:** includes `.demo.acl` files (unfiltered)

## ACL File Format

ACL files are proprietary JSON with embedded .NET type information. Unity's `JsonUtility` produces several non-standard extensions beyond standard JSON:

### Standard JSON-Plus Extensions
- `"$type": "56|Namespace.ClassName, Assembly"` — type tags
- `"$id": N` — object reference IDs
- `"$ref": N` — back-references to `$id`
- `"$k"` / `"$v"` — dictionary key/value entries
- `"$rcontent": [...]` / `"$rlength": N` — array wrappers
- `"$values": [...]` — array payloads

### Non-Standard JSON Syntax (handled by pre-processor)
- **Trailing commas** — `{"a": 1,}` or `[1, 2,]`
- **NaN / Infinity** — `"field": NaN`
- **Missing commas between properties** — Unity may omit commas after nested object values
- **Typed-value objects** — `{"$type": 3, int64_ticks}` (DateTime), `{"$type": "16|...", x, 0, z}` (Vector3) — bare numeric values without keys in objects

### Two-Pass Parsing (`src/acl/acl_json.js`)

The `preprocessUnityJson()` function transforms Unity JSON into valid JSON in 3 passes:
1. **Fix trailing commas** (string-aware removal)
2. **Insert missing commas** between adjacent properties
3. **Fix NaN / Infinity** → safe values
4. **Transform typed-value objects** → `__v` sentinel: `{"$type": 3, "__v": ["int64_string"]}`

`JSON.parse` then runs on the sanitized output. The `serializeUnityJson()` function reverses all transformations for output.

Key section types:
- `SceneryData` (type 59) — runway/gate GUIDs
- `Aircrafts` (type 35) — aircraft state entries with DynamicParams
- `FlightPlans` (type 52) — container for FlightPlanState entries
- `FlightPlanState` (type 37) — individual flight plans with DepartureLeg/ArrivalLeg
- `DepartureLeg` (type 57) / `ArrivalLeg` (type 58) — flight leg data
- `TaskFlightState` (type 56/54) — older WorldState format (legacy)
- `WeatherFrames` / `WindFrames` / `RunwayTimeline` — timeline sections

### SceneryData Runway Routes

`SceneryData.Runways` is a dictionary (`$k`/`$v`) where each entry represents one runway direction. Each `$v` block contains:

| Field | Description |
|---|---|
| `Name` | Runway designator used by flight plans — e.g. `"31L"`, `"19"`, `"01"` |
| `PhysicalName` | Runway pair — e.g. `"13R/31L"`, `"01/19"` |
| `Routes` | Contains `$rcontent` array of route entries, each with `Name`, `Type`, `AirwayNodeGuids` |

**Route Types** (verified against both KJFK and ZSJN production .acl files):

| Type | Meaning | Example Names | Used for |
|------|---------|---------------|----------|
| **0** | **STAR** (arrival transition) | `SEY.PARCH4`, `UBSS6W`, `OKAL6W`, `WFG91A` | Airway dropdown filtering, StarMap availability, approach path resolution |
| 1 | RNAV approach procedure | `RNAV Y Rwy 31L`, `RNAV ILS Z Rwy 19` | State=5 approach data (`resolveApproachProcedureData`) |
| **2** | **SID** (departure transition) | `JFK5.JFK`, `TUML5T`, `BASV7Y` | Parsed by `sid_goaround.js` → `sidPaths` for AirMapWindow route display |
| 3 | Missed approach | `RNAV Y Rwy 31L (Missed Approach)` | Parsed by `sid_goaround.js` → `missedAppPaths` for AirMapWindow route display |

**Important:** The authoritative source for valid STAR↔runway combinations is `SceneryData.Runways[runway].Routes[].Name` where `Type === 0`. This is a superset of what `appPointMap` covers (which is limited to State=30 aircraft entries at snapshot time). For example, KJFK runway 31L has STAR `SEY.PARCH4` (Type 0) defined in SceneryData, but this combo may have no State=30 aircraft in any scanned .acl file, leaving it absent from `appPointMap`.

**Extraction algorithm** (`extractStarRunwayMappings` — see approach.js):
1. Find `SceneryData` → `Runways` section via tokenizer
2. Find main `$rcontent` array at brace depth 1 (skip nested arrays like `comparer`)
3. Iterate runway dictionary entries → extract `Name` (runway designator) and `Routes`
4. Parse `Routes.$rcontent` → for each route with `Type === 0`, collect `Name` (STAR name)
5. Return `{ starRunwayMap: {star → [runways]}, runwayStarMap: {runway → [stars]} }`

**SID and Missed Approach extraction** follows the identical pattern in `sid_goaround.js`, operating on `Type === 2` (SID) and `Type === 3` (Missed Approach) routes. The four functions exported by `sid_goaround.js` mirror the approach.js STAR helpers:
- `extractSidRunwayMappings(aclText)` → `{ sidRunwayMap, runwaySidMap }`
- `extractMissedApproachMappings(aclText)` → `{ missedAppMap, runwayMissedAppMap }`
- `buildSidPaths(aclText, sidRunwayMap)` → `{ sidName: [{x, z}, ...] }`
- `buildMissedApproachPaths(aclText, missedAppMap)` → `{ maName: [{x, z}, ...] }`

### SceneryData TaxiwaySegments

`SceneryData.TaxiwaySegments` is a `$k`/`$v` dictionary where each entry represents a taxiway centerline segment:

| Field | Description |
|-------|-------------|
| `Name` | Taxiway designation (e.g. `"A"`, `"B"`, may be empty) |
| `Flags` | Integer: 1=standard, 2=wider, 4=special |
| `Nodes` | `{$rcontent: [nodeGuid1, nodeGuid2]}` — endpoint GUIDs resolved via `_parseTaxiwayNodes()` |

Parsed by `src/acl/taxiway.js`:
- Resolves node GUIDs via `_parseTaxiwayNodes()` (shared with `approach.js`)
- **Stand-access segments are now included** (marked with `isStandAccess: true`) instead of being excluded — segments where ANY endpoint GUID touches a stand position (via `TailPositionGuid` / `NosePositionGuid` from `SceneryData.Stands`) get the flag; non-stand segments omit it
- Returns `{ paths: [{ name, flags, points: [{x, z}], isStandAccess?: boolean }] }`
- **Accepts optional `existingNodesMap`** parameter to skip re-parsing `TaxiwayNodes` when called repeatedly for the same airport
- **Merged from all files in `buildApproachCache()`**: each file's taxiway paths are parsed inline during the main approach-data loop (no separate second pass), with coordinate-based dedup at `toFixed(2)` precision. Exposed via `collect-values` as `_taxiwayPaths`

## Approach Aircraft Construction (State=30 & State=5)

The `src/acl/approach.js` module builds approach aircraft entries for arrival flights
that are mid-approach at the snapshot time. Two states are generated:

- **State=30** (FlyApproachDynamicsParams) — aircraft on the STAR/en-route approach segment,
  on Approach frequency. Descending on the 3° ILS glideslope toward the runway.
- **State=5** (ApproachDynamicsParams) — aircraft on the final approach segment, past the
  IAF (Initial Approach Fix, the last FlyApproach waypoint), on Tower frequency. Same
  glideslope descent, different DynamicsParams type and radio channel.

**Unified path architecture:** Both State=30 and State=5 share the SAME full path:
`FlyApproach → App/PathPointList → TouchDown`. Position is always interpolated on this
unified path using `fullPR` (relative to the full STAR+Approach duration), ensuring
spatial continuity across the State=30→5 transition.

**Dual PR semantics:** The ACL's `ProgressRatio` field means different things per state:
- State=30 (FlyApproachDynamicsParams): PR is relative to full approach → stores `fullPR`
- State=5 (ApproachDynamicsParams): PR is relative to final approach segment only →
  stores **rescaled** value `(targetDist - flyLen) / appLen` where `targetDist` is the
  aircraft's distance along the unified path, `flyLen` is the FlyApproach path length,
  and `appLen` is the AppPointList path length

The rescaling is purely for the stored DynamicsParams field — position always uses the
unified path with `fullPR`.

### State=5 Sub-types

State=5 has three sub-types based on `timeToLanding` (seconds until scheduled touchdown):

| Sub-type | timeToLanding | WaitingForCommands | SelectedRunwayExitIndex | TaxiArrivalToHoldingPointPath |
|----------|--------------|-------------------|------------------------|------------------------------|
| **A: Contact Tower** | ≥ 60s | `[22]` | -1 | null |
| **B: Cleared to Land** | 0–60s | `[23]` | 0 | null |
| **C: Post-landing** | ≤ 0 | `[]` | ≥ 1 | populated (taxi route) |

Sub-type A is the standard State=5 — aircraft just handed off to Tower, needs to
contact. Sub-type B is for aircraft within 1 minute of landing — landing clearance
already issued. Sub-type C is for aircraft that have already touched down and are
taxiing to the stand.

**Key principle for Y:** All Y values are computed from the **remaining path distance**
along the approach route to the runway touchdown point, NOT from straight-line horizontal
distance. The path distance follows the approach route through turns, giving correct
altitude even for curved approaches (e.g., KJFK SIE.CAMRM5). The altitude is **capped**
at the runway's approach ceiling (`approachCap`), fixed at 15.24 game units
(= 5000ft / 100 m/unit = 1524m). All original game files use this value
regardless of airport.

### Complete Position & Direction Math

**Inputs (per aircraft):**
- `landingTime` [seconds since midnight] — from FlightPlan ArrivalLeg
- `saveTime` [seconds since midnight] — from GameTime.CurrentDateTime (authoritative)
- `star` [string] — STAR/route name, e.g. `"UBSS6W"`
- `runway` [string] — runway name, e.g. `"19"`

**Cache lookups (per airport, built during init by `buildApproachCache`):**
- `TAT = totalApproachTimes[star]` — full approach duration in seconds (~1380-1775)
- `appPoints = appPointMap[star + "|" + runway]` — AppPointList Vector3[]
- `state5 = state5ParamsMap[runway]` — `{ pathPointList, touchDownPosition, approachDirection, initialPosition }`
- `approachCap = 15.24` — standard ILS approach ceiling in game units (= 5000ft at 100 m/unit), from `computeApproachCap()`

**SceneryData (resolved per-file from AirwayNodes):**
- `flyPoints = resolveFlyApproachPoints(aclText, star, runway)` — FlyApproachPathPointList

**Constant:**
- `tan(3°) ≈ 0.052408` — standard ILS glideslope (3 degrees)

#### Step 1: ProgressRatio

```
timeToLanding = landingTime - saveTime                          [seconds]
TAT = totalApproachTimes[star]                                  [seconds]
progressRatio = 1.0 - timeToLanding / TAT                       [0.0..1.0]
```

**Gate:** Only generate AircraftState if `0.0 < progressRatio < 1.0`.

#### Step 2: State determination (IAF passage)

The state is determined by whether the aircraft has passed the IAF (last FlyApproach waypoint):

```
flyLen   = Σ segmentDistances(flyPoints)   [path length of FlyApproach from SceneryData]
appLen   = Σ segmentDistances(appPoints)   [path length of AppPointList from cache]
combined = [...flyPoints, ...appPoints]    [concatenate to include connecting segment]
totalLen = computePathLength(combined)     [total unified path length]
targetDist = totalLen × progressRatio      [aircraft position along unified path]

if targetDist >= flyLen → State=5  (past IAF, final approach, Tower)
else → State=30                    (before IAF, still on STAR, Approach)
```

This eliminates the need for a cached `flyFractionMap` — the IAF is determined
directly from the full FlyApproach path (resolved from SceneryData via
`resolveFlyApproachPoints`) and the cached AppPointList.

#### Step 3a: State=30 Position & Direction

Aircraft is on the STAR/en-route approach segment, on Approach frequency.

```
// Unified path: FlyApproach + App + TouchDown
fullPath = flyPoints + appPoints + [touchDownPosition]
totalLen = Σ segmentDistances(fullPath)                         [sum of |p[i]-p[i-1]|]
targetDist = totalLen × progressRatio

// Position: interpolate along unified path
pos = interpolateAlongPath(fullPath, targetDist)

// Y from 3° ILS glideslope using REMAINING PATH DISTANCE.
// NOT straight-line — path distance follows the approach route through turns.
// Capped at the runway's approach ceiling (hardcoded 15.24m, standard ILS).
remainingPathDist = totalLen - targetDist                        [distance still to fly]
glideY = remainingPathDist × tan(3°)                             [uncapped glideslope]
pos.y = min(approachCap, glideY)                                 [capped at max altitude]

// Direction: path tangent, level flight (no vertical component in dir vector)
dir = tangentAlongPath(fullPath, targetDist)
dir.y = 0
dir = normalize(dir)
```

The glideslope intercepts the cap at distance `approachCap / tan(3°)` from the runway.
For portions of the approach beyond that distance, the aircraft stays at `approachCap`.

#### Step 3b: State=5 Position & Direction

Aircraft is on final approach, on Tower frequency. Position uses the **same unified
path** as State=30 (FlyApproach + PathPointList + TouchDown) with `fullPR` for spatial
continuity. The STOR FlyApproach and procedure PathPointList meet at the IAF (Initial
Approach Fix) — `_dedupeIafJoin()` trims the duplicate flyPoint when it matches the first
pathPoint (within 0.1m) to avoid a zero-length segment that would cause NaN in interpolation.
The stored DynamicsParams.ProgressRatio uses the **rescaled** `state5PR`.

```
// Unified path for position (same as State=30, with IAF dedup)
unifiedPath = _dedupeIafJoin(flyPoints, pathPoints) + pathPoints + [tdPos]
totalLen = Σ segmentDistances(unifiedPath)
targetDist = totalLen × fullPR                                    [fullPR for continuity]

// Position: interpolate along unified path
pos = interpolateAlongPath(unifiedPath, targetDist)

// Y from 3° ILS glideslope using remaining path distance
remainingPathDist = totalLen - targetDist
glideY = remainingPathDist × tan(3°)
pos.y = min(approachCap, glideY)

// Direction: matches runway heading (from cached approachDirection)
dir = state5.approachDirection

// Stored PR: RESCALED for game's ApproachDynamicsParams
// Based on position past IAF, not time-based fraction
state5PR = (targetDist - flyLen) / appLen
```

#### State=5 DynamicsParams fields

All Y values use path-distance × tan(3°) capped at `approachCap`.
No value is hardcoded — the cap comes from the ACL via the approach cache.

**InitialPosition** — the final approach entry point (first PathPointList point):
```
ipX = pathPoints[0].x
ipZ = pathPoints[0].z
ipPathDist = Σ segmentDistances([...pathPoints, tdPos])         [total path from this point]
ipY = min(approachCap, ipPathDist × tan(3°))
```

**TouchDownPosition** — from SceneryData via `state5ParamsMap` (Y≈0, runway level).

**PathPointList** — waypoints with glideslope-computed Y:
```
for each pt in pathPoints:
    ptPathDist = Σ segmentDistances([pt, ...remainingPoints, tdPos])
    ptOutput.y = min(approachCap, ptPathDist × tan(3°))
```
```

#### Summary

| Component | State=30 | State=5 |
|-----------|----------|---------|
| Path (position) | flyPoints + appPoints + [tdPos] | flyPoints + pathPoints + [tdPos] (same unified path) |
| Position PR | fullPR (relative to full approach) | fullPR (same, for spatial continuity) |
| Stored PR | fullPR | state5PR = (targetDist − flyLen) / appLen |
| pos.y | min(approachCap, remainingPathDist × tan(3°)) | min(approachCap, remainingPathDist × tan(3°)) |
| dir | path tangent (level) | path tangent (follows approach path, converges to runway heading at touchdown) |
| Radio | Approach (APP) | Tower (TWR) |
| DynamicsParams | FlyApproachDynamicsParams | ApproachDynamicsParams |
| WaitingForCommands | [] (empty) | [22] or [23] (sub-type A/B) |
| Y source | Not copied from aircraft — computed from glideslope + runway cap |

#### saveTime Resolution Priority

In `_rebuildWorldStateSections` (flight_plans.js), saveTime is resolved in this order:

1. `_saveSec` — explicit, passed from frontend (set by `extractGameTime` during load)
2. **`extractGameTime(text)`** — GameTime.CurrentDateTime from the file being saved (authoritative)
3. Cache `saveTimeOffsets` — derived from State=30 entries (less accurate, fallback)
4. `startSec + 780` — warmup fallback (13 min after config startTime)

### Verified Field Relationships (State=30)

| Field | Source | Pattern |
|-------|--------|---------|
| `Specification` | Designator→Spec DB | Fixed per Designator (byte-identical across all files) |
| `FlyApproachPathPointList` | AirwayNodes via STAR GUIDs | `Runways[runway].Routes[route].AirwayNodeGuids → AirwayNodes[guid].Position` |
| `AppPointList` | f(Route, Runway) map | Fixed per (Route, Runway) — 8 combos verified, 0 counterexamples |
| `ProgressRatio` | Time-based formula | `1 − (LandingTime − saveTime) / totalApproachTime(Route)` |
| `Direction` | Path tangent | Unit vector in XZ at current path position |
| `Position.y` | 3° glideslope, path-distance, capped | `min(approachCap, remainingPathDist × tan(3°))` — continuous with State=5, approachCap always 15.24 (5000ft ÷ 100 m/unit) |
| All other fields | Invariant template | Fixed across all State=30 aircraft |

### ProgressRatio Formula

```
ProgressRatio = 1 − (LandingTime − saveTime) / totalApproachTime(Route)
```

- `saveTime` = the snapshot time. Prefer GameTime.CurrentDateTime from the ACL file
  (the literal wall-clock time the game wrote). The cache's `saveTimeOffsets` is a
  fallback derived from State=30 entries via the inverse formula.
- `totalApproachTime(STAR)` = route-specific total duration from STAR entry to
  touchdown (~1380-1775s, computed from SceneryData path-length estimates via
  `computeApproachTimesFromScenery()` using physics-based formula with
  uniform 100 m/unit scale)
- This is a time-based approximation of the game's path-based PR. Expected position
  error is ~50-200m due to non-uniform aircraft speed along the approach.
- **APPROACH_MIN_TTL clamping:** For StarMap live position display and the PR gate,
  `timeToLanding` is clamped to a minimum of `APPROACH_MIN_TTL` (30s, from
  `src/acl/constants.js`) so aircraft at or very near landing still show on the map
  (PR never reaches exactly 1.0). Note: StarMap.jsx has its own local copy (10s)
  for the in-panel aircraft position computation.

### TAT (Total Approach Time) Computation

TAT is the total duration from approach start (PR=0) to touchdown (PR=1).

#### Coordinate Scale

All axes (XYZ) use a **uniform 100 m/unit scale**. This is confirmed by original
game files using `Position.y = 15.24` (= 5000ft / 100 m/unit / 3.28084 ft/m)
at every airport regardless of runway geometry. The per-airport runway-length
ratio (Σ realRunwayLength / Σ gameThresholdDistance) was a mistaken assumption
and has been removed.

#### Full Terminal Path Length

The total approach path in game units combines three segments from SceneryData:

```
totalGamePath = flyPathLen + procPathLen + tdDist

where:
  flyPathLen  = Σ segment distances of FlyApproach points (Type=0 STAR route, via resolveFlyApproachPoints)
  procPathLen = Σ segment distances of approach procedure points (Type=1 route, via resolveApproachProcedureData)
  tdDist      = distance from last procedure point to TouchDownPosition (runway threshold)
```

#### Aircraft Speed

The aircraft approach speed is **240 knots** (123.47 m/s), sourced from the
`TargetTaxiSpeed: 240` field in DynamicsParams — this is the game's constant
airspeed for all aircraft on approach (not just ground taxi).

#### TAT Formula

```
TAT(seconds) = totalGamePath × 100 / (240 × 0.514444)

                (flyLen + procLen + tdDist) × 100
              = ─────────────────────────────────
                           123.47
```

The deprecated `APPROACH_EFFECTIVE_SPEED` (12.5 m/s) fallback remains as a
legacy option for airports without threshold data.

#### Implementation Status

TAT estimation in `computeApproachTimesFromScenery` uses three tiers:
1. Aircraft-derived TATs (from `refTatMap`) — most accurate, preserved when available
2. Physics-based: `totalLen × 100 / APPROACH_SPEED_MS` (240 kts) — primary method
3. `totalLen / APPROACH_EFFECTIVE_SPEED` (12.5 m/s) — deprecated fallback

#### Approach Altitude Ceiling

The approach ceiling is **5000 ft** (1524 m). In game units at the uniform
100 m/unit scale:

```
approachCap = 1524 / 100 = 15.24
```

Every original game file (ZSJN and KJFK alike) stores `Position.y = 15.24`
and `InitialPosition.y = 15.24` for aircraft at the approach ceiling. The
`computeApproachCap()` function always returns this fixed value.

### Module API (`src/acl/approach.js`)

**Data Extraction:**
- `extractSpecificationDB(aclText)` → `Map<Designator, Spec>` — 14 designators across ZSJN+KJFK
- `extractApproachData(aclText)` → `Array<{route, runway, progressRatio, flyPoints, appPoints, ...}>` — all State=30 aircraft
- `extractState5Data(aclText)` → `Array<{route, runway, touchDownPosition, approachDirection, initialPosition, pathPointList}>` — State=5 aircraft still in-air (Sub-type A: has DynamicsParams, no taxi path)
- `extractTypeMap(aclText)` → `Map<number, string>` — captures all fully-qualified `$type` declarations from a file; type numbers are per-file in Unity's serialization
- `buildAppPointMap(approachEntries)` → `Map<"Route|Runway", Vector3[]>` — verified 1:1 mapping
- `buildState5ParamsMap(state5Entries)` → `Map<"runway", {pathPointList, touchDownPosition, approachDirection, initialPosition}>` — per-runway final approach parameters from State=5 data
- `computeApproachTimesFromScenery(aclText, starMappings, appPointMap, refTatMap, defaultTAT, airportScale?)` → `Map<STAR, seconds>` — per-STAR duration from SceneryData path-length estimates using three-tier estimation (aircraft-derived → physics-based → deprecated fallback)
- `extractGameTime(aclText)` → `seconds \| null` — parse `GameTime.CurrentDateTime` ticks as seconds since midnight
- `extractSaveTime(aclText, totalApproachTimes)` → `seconds \| null` — derive snapshot time from first State=30 entry's PR + LandingTime

**Path Resolution:**
- `resolveFlyApproachPoints(aclText, route, runway)` → `Vector3[]` — via SceneryData AirwayNodes

**SceneryData & STAR Mapping:**
- `extractStarRunwayMappings(aclText)` → `{starRunwayMap: {star→[runways]}, runwayStarMap: {runway→[stars]}}` — authoritative from `SceneryData.Runways.Routes[Type=0]` (superset of `appPointMap`)
- `resolveApproachProcedureData(aclText, runway, hintPosition?)` → `{pathPointList, touchDownPosition, approachDirection, initialPosition} | null` — resolves final approach parameters for a runway from SceneryData Type=1 routes; when `hintPosition` is provided and multiple Type=1 variants exist, picks the one whose first AirwayNode is closest to the hint (used for STAR-specific variant selection); used to rebuild `state5ParamsMap` on cache hit
- `_parseRunwayThresholds(aclText)` → `{[PhysicalName]: {thresholds: [{x,z}, {x,z}]}}` — runway endpoint positions from SceneryData for StarMap visualization
- `_parseTaxiwayNodes(aclText)` → `Map<guid, Vector3>` — TaxiwayNode positions for GUID resolution
- `_parseAirwayNodes(aclText)` → `Map<guid, {name, position}>` — AirwayNode positions for FlyApproach path resolution

**Computation:**
- `computeProgressRatio(landingTimeTicks, saveTimeTicks, totalApproachTime)` → `0..1`
- `computePosition(flyPoints, appPoints, progressRatio, touchDownPosition?, approachCap?)` → `{x, y, z}` — unified path (FlyApproach + App + TouchDown) with 3° glideslope Y; exported through parser facade for `get-aircraft-positions` IPC (StarMap live aircraft dots)
- `computeDirection(flyPoints, appPoints, progressRatio, touchDownPosition?)` → unit vector — unified path tangent; also exported through parser facade
- `buildFullPath(flyPoints, appPoints, touchDownPosition?)` → combined unified path array
- `_dedupeIafJoin(flyPoints, ppList)` → flyPoints with last point trimmed if it matches the first PathPointList point (within 0.1m) — prevents zero-length segments at the IAF join that would cause NaN in interpolation
- `computePathLength(points)` → total distance
- `computeAirportScale(aclText)` → `number` — always returns `DEFAULT_AIRPORT_SCALE` (100); all axes use uniform 100 m/unit
- `computeApproachCap(airportScale?)` → `number` — always returns `APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE` (15.24); ceiling is 5000ft regardless of airport
- `computeFullTerminalPath(aclText, star, runway)` → `{flyLen, procLen, tdDist, total}` — full terminal path length in game units combining FlyApproach + procedure + touchdown segments

**Designator Mapping & Cache:**
- `buildDesignatorMapping(aclText)` → `Map<AircraftType, Designator>` — cross-references FlightPlans with AircraftStates
- `buildApproachCache(airportDir)` → `{specDB, appPointMap, totalApproachTimes, designatorMap, saveTimeOffsets, typeMap, fileTypeMaps, state5ParamsMap, starPaths, runwayThresholds, airportScale, starRunwayMap, runwayStarMap}` — scans all .acl files for an airport (including demo/test/tutorial variants); `airportScale` is always 100 (uniform XYZ scale); `saveTimeOffsets` is a `Map<filename, seconds>` of per-file snapshot times; `state5ParamsMap` is a `Map<runway, {pathPointList, touchDownPosition, approachDirection, initialPosition}>` of per-runway and per-STAR+runway final approach parameters. `state5ParamsMap`, `appPointMap`, `totalApproachTimes`, and `airportScale` are persisted in `cache.json`. On cache hit from an older version, they are rebuilt from SceneryData via `resolveApproachProcedureData()`, `computeApproachTimesFromScenery()`, and `computeAirportScale()`. State determination (State=30 vs State=5) uses IAF passage: aircraft past the last FlyApproach waypoint are State=5, computed directly from the full FlyApproach path (resolved from SceneryData) without a cached fraction map

**Assembly:**
- `buildApproachAircraftBlock({flightPlanGuid, route, flyPoints, appPoints, progressRatio, spec, radioChannelGuid?, touchDownPosition?, approachCap?, typeNums?, acTypeNum?, nextId?})` → `{guid, block, nextId}` — State=30 `$k/$v` JSON block; position uses unified path with touchdown
- `buildState5AircraftBlock({flightPlanGuid, route, state5PR, spec, towerChannelGuid?, state5Params, flyPoints?, fullPR?, waitingForCommand?, selectedRunwayExitIndex?, typeNums?, acTypeNum?, nextId?})` → `{guid, block, nextId}` — State=5 `$k/$v` JSON block; position uses unified path (flyPoints + PathPointList + TouchDown) with `fullPR` for spatial continuity; stored PR is rescaled `state5PR`; `waitingForCommand` controls sub-type (22=Contact Tower, 23=Cleared to Land)
- `buildAnimatorBlock(aircraftGuid, opts)` — builds the paired `AircraftAnimatorState` entry; `opts.typeNums` controls `animState`/`animSubState` type numbers

### Test

```bash
node --require ./tests/integration/preload.cjs tests/integration/test_approach_aircraft.js [--root <game-root>]
```

Validates all algorithms against the 8 production files: spec consistency, AppPoint mapping, ProgressRatio formula (saveTime spread), FlyApproach resolution, Position/Direction reconstruction, and block assembly.

## All Dev Commands

### Running the app
```bash
npm start          # Launch Electron in dev mode (Vite dev server + Electron)
```

### Running tests

**Component tests (198 tests across 16 files):**
```bash
npm test              # Run all Vitest component + store + utility + MapWindow tests
npm run test:watch    # Watch mode — re-runs on file changes
```

**E2E tests:**
```bash
npm run test:e2e      # Playwright + Electron full user-flow tests
```

**Integration tests (plain Node.js, now in `tests/integration/`):**

All accept `--help` / `-h` for usage. Temp files are written to `tests/integration/` and cleaned up automatically.

New parser module tests (no game root needed):
```bash
node tests/integration/test_tokenizer.js            # String-aware scanner (18 tests)
node tests/integration/test_acl_json.js             # Pre-processor + serializer round-trips (25 tests)
node tests/integration/test_acl_document.js         # Document model integration (13 tests)
node tests/integration/test_sid_goaround.js         # SID + missed approach route parsers (17 tests)
node tests/integration/test_taxiway.js              # Taxiway centerline parser (11 tests)
```

UDP telemetry test (mock loopback server, requires port 20266 free):
```bash
node tests/integration/test_udp_listener.js         # Binary protocol parsing + trail buffer (13 tests)
```

Scan-all tests (need game root, default `../../../../` from integration dir):
```bash
node tests/integration/test_parse_airport.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_callsign_gen.js [--root <game-root>]
node --require ./tests/integration/preload.cjs tests/integration/test_approach_aircraft.js [--root <game-root>]
```

Single-ACL tests (require `--acl <path>`, derive paired files automatically):
```bash
node tests/integration/test_e2e_save_load.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_sections.js --acl <path>
node tests/integration/test_acl_linkage.js --acl <path>
```

Timeline tests (require `--acl <path>`, auto-discover JSONs):
```bash
node --require ./tests/integration/preload.cjs tests/integration/test_timeline_comparison.js <acl-path>
node --require ./tests/integration/preload.cjs tests/integration/test_generate_timelines.js --acl <path>
node --require ./tests/integration/preload.cjs tests/integration/test_rebuild_timelines.js --acl <path>
```

### Local Build
```bash
# ALWAYS use build.js for local Windows builds — never npm run build:win directly
node build.js        # Build Windows portable EXE → dist/AC27LevelEditor.exe
node set_icon.js     # Post-build: embed icon.ico into the EXE
```

### Pre-build cleanup (Windows PowerShell)
```powershell
Stop-Process -Name "AC27 Level Editor" -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
```

### winCodeSign one-time fix (if build fails)
```powershell
$libDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\darwin\10.12\lib"
Copy-Item "$libDir\libcrypto.1.0.0.dylib" "$libDir\libcrypto.dylib" -Force
Copy-Item "$libDir\libssl.1.0.0.dylib" "$libDir\libssl.dylib" -Force
```

### GitHub Release

The release workflow (`.github/workflows/release.yml`) triggers on `v*` tags pushed to GitHub. It builds **Windows** (portable `.exe`) and **macOS** (`.dmg`) in parallel via `npm run build:win/build:mac -- --publish never`, then attaches both artifacts to a GitHub Release with auto-generated release notes.

#### How to release a new version

1. **Bump version** in `package.json` if this is a new version (not a re-tag)
2. **Commit** all changes
3. **Tag** the commit: `git tag v<version> <commit-ish>` (defaults to HEAD)
4. **Push** the tag: `git push origin v<version>`
5. **CI** builds Windows + macOS and creates the GitHub Release automatically

#### How to re-release the same version (after a hotfix)

If the tag already points to an old commit and you need to move it:

```bash
git tag -f v<version> <new-commit>
git push -f origin v<version>
```

The force-push re-triggers the CI workflow, which rebuilds both platforms and updates the GitHub Release with fresh artifacts. **The tag must be force-pushed** — simply pushing a new commit without moving the tag will NOT trigger a new release.

#### Important notes

- The CI uses `npm run build:win/build:mac`, NOT `node build.js`. Rule 15 (never `npm run build:win`) applies to **local development only** — `build.js` auto-detects Windows and sets up portable target + icon correctly.
- `--publish never` in CI prevents electron-builder from trying to publish to GitHub Releases (the workflow handles that via `softprops/action-gh-release`).
- `CSC_IDENTITY_AUTO_DISCOVERY: false` disables code signing since we don't have a signing certificate.
- Manual release: trigger the workflow via `workflow_dispatch` on GitHub Actions with an optional version input.
- macOS builds produce a `.dmg`; Windows builds produce a portable `.exe` (no installer).

## Key Rules for Agents

1. **React + Vite + zustand stack.** Frontend uses ESM, JSX, and React hooks. No global-scope scripts.
2. **No TypeScript.** This is plain JS/JSX. Do not add `tsconfig.json` or convert files to `.tsx`.
3. **No linter/formatter.** Do not add ESLint, Prettier, or any linting config unless explicitly asked.
4. **Testing uses Vitest (component) + Playwright (E2E) + Node.js (integration).** Component tests go in `tests/components/`, E2E specs in `tests/e2e/`, integration scripts in `tests/integration/`. Do not add Jest or Mocha.
5. **No npm dependencies for core logic.** The app uses only Node.js built-ins. Justify any new dependency.
6. **Preserve CommonJS for backend.** `electron/` and `src/acl/` use `require()`/`module.exports`.
7. **ESM for frontend.** `src/components/`, `src/hooks/`, `src/store/`, `src/utils/` use `import`/`export`.
8. **IPC for all file I/O.** The renderer never touches the filesystem. All reads/writes go through `electron/main.js` handlers.
9. **Return `{ success }` from IPC.** Every handler returns `{ success: true/false, error?: string }`.
10. **`_underscore` = private in backend.** Prefix internal functions with `_`. Export them anyway for testing.
11. **`snake_case.js` for backend, `PascalCase.jsx` for components.** Match existing conventions.
12. **No inline `style={{}}`.** Always extract CSS to the component's `.css` file.
13. **One `.css` per component.** Match the component filename.
14. **Update the facade.** New backend modules must be re-exported through `src/acl/parser.js`.
15. **Build locally with `node build.js`** on Windows, never `npm run build:win` (local only — CI uses `npm run build:win` for cross-platform builds).
16. **Bump `CACHE_VERSION` when cache.json schema changes.** Any change to the structure of `approachData`, `saveTimeOffsets`, `fileTypeMaps`, `state5ParamsMap`, `taxiwayPaths`, `sidPaths`, `missedAppPaths`, or new top-level keys in cache.json MUST bump `CACHE_VERSION` in `src/utils/constants.js:13` (re-exported via `src/acl/constants.js` for CJS backward compat). Stale caches silently corrupt saves.
17. **Keep documentation in sync.** After any significant change, update BOTH:
    - **This skill** (`.claude/skills/ac27-level-editor/SKILL.md`)
    - **README.md**
18. **UDP listener lifecycle is managed by main process.** `startUdpListener()` is called in `app.whenReady()` after `createWindow()`, `stopUdpListener()` in `will-quit`. The listener auto-reconnects on socket errors (2s delay). Do not create multiple listeners or start/stop from the renderer.
19. **Map windows are separate BrowserWindow instances.** They are NOT React components in the main renderer. Track them in `groundMapWindows`/`airMapWindows` Maps (keyed by ICAO). Always check for existing windows before creating (focus if exists). Clean up Map entries in the `closed` event handler. Each window loads the same Vite SPA with query params (`?window=groundMap&airport=XXXX` or `?window=airMap&airport=XXXX`).
20. **UDP state push handles cleanup.** The `udp-aircraft-state` IPC event is pushed to ALL open map windows every 200ms. Map window components subscribe via `useUdpAircraftState()` hook which wraps `onUdpAircraftState`/`offUdpAircraftState`. Always unsubscribe in `useEffect` cleanup to prevent stale callbacks or memory leaks.
