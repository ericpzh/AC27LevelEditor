---
name: ac27-level-editor
description: AC27 Level Editor — Electron desktop app for editing Airport Control 27 .acl flight schedule files. Use this skill whenever working in this repo, editing any source file, running commands (npm start, node build.js, npm test, node tests/integration/*), adding features, fixing bugs, or discussing the app's architecture. This skill documents the full project structure, coding conventions, IPC patterns, save/load flow, timeline system, build process, and all dev commands. Always consult this skill before making changes.
---

# AC27 Level Editor — Repo Skill

## Project Identity

- **Name:** `ac27-level-editor` (v1.1.2)
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
│  - 29 ipcMain.handle() endpoints                        │
│  - All file I/O, dialog, caching lives here             │
├─────────────────────────────────────────────────────────┤
│  electron/preload.js (contextBridge)                    │
│  - Exposes window.electronAPI with 28 methods          │
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
│    state (showStandMap, showStarMap, activeMap)          │
├─────────────────────────────────────────────────────────┤
│  src/acl/ (parser facade + 11 backend modules,          │
│    CommonJS + some ESM)                                  │
│  - parser.js is the FACADE — main.js imports ALL        │
│    backend modules through it only                      │
│  - tokenizer, acl_json, acl_document, constants,         │
│    scanner, flight_plans, world_state, approach,         │
│    dynamics, scenery, utils                             │
├─────────────────────────────────────────────────────────┤
│  src/utils/ (shared utilities, ESM frontend + CJS back) │
│  - constants.js — field defs, airline codes, getActiveCol│
│  - timeUtils.js — time conversion + timeline helpers    │
│  - i18n.js — Chinese/English translation system         │
│  - validators.js — save validation logic                │
│  - htmlUtils.js, csvIo.js, zipUtils.js, logger.js       │
└─────────────────────────────────────────────────────────┘
```

## Directory Structure

```
AC27LevelEditor/
├── electron/
│   ├── main.js              # Electron main process + 27 IPC handlers
│   └── preload.js           # contextBridge (window.electronAPI)
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
│   │   │       ├── WeatherEditor.jsx
│   │   │       ├── WindEditor.jsx
│   │   │       ├── RunwayEditor.jsx + .css
│   │   │       ├── TimeCell.jsx         # Shared time cell with clock popover
│   │   │       └── TimelineEditors.css
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
│   ├── acl/                     # Backend modules (11 files; CommonJS + some ESM)
│   │   ├── parser.js            # FACADE — re-exports all backend modules
│   │   ├── tokenizer.js         # String-aware section boundary scanner (no more brace-counting)
│   │   ├── acl_json.js          # Pre-processor (Unity JSON→valid JSON) + serializer
│   │   ├── acl_document.js      # In-memory document model (lazy parsing, mutation tracking)
│   │   ├── constants.js         # ACL-format constants (ESM, imported by parser)
│   │   ├── scanner.js           # Scans game root for airports & .acl files
│   │   ├── flight_plans.js      # FlightPlans format (types 37/52/57/58)
│   │   ├── world_state.js       # WorldState format (types 35/56/54)
│   │   ├── approach.js         # Approach AircraftState constructor (State=30)
│   │   ├── dynamics.js          # Deprecated — calcProgressRatio/buildAircraftEntry stubs
│   │   ├── scenery.js           # SceneryData parser (runway/stand GUIDs + stand position extraction)
│   │   └── utils.js             # Enrichment, sorting, audio, import utils
│   │
│   └── utils/                   # Shared utilities (ESM + some CJS for backend)
│       ├── constants.js         # UI field defs, airline codes, getActiveColumns
│       ├── timeUtils.js         # Tick↔time conversion, timeline helpers (CJS + ESM)
│       ├── i18n.js              # Chinese/English translation (T(), getLang, setLang)
│       ├── validators.js        # validateCallsigns, runTripleValidation
│       ├── htmlUtils.js         # escapeHtml, stripSuffixes
│       ├── csvIo.js             # CSV export
│       ├── zipUtils.js          # Pure Node.js ZIP (zlib, no deps)
│       └── logger.js            # Console → file redirect (dev mode)
│
├── tests/               # Vitest + Playwright + Node.js integration tests
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
- **Main→renderer events:** `mainWindow.webContents.send('cache-invalidated')` — signals renderer when `cache.json` is missing/corrupt; preload bridges via `onCacheInvalidated(cb)`

### Test Conventions

Three-layer testing strategy:

**Layer 1 — Component tests (Vitest + React Testing Library):**
- `npm test` or `npm run test:watch`
- Isolated component rendering in jsdom with mocked `window.electronAPI`
- zustand stores are tested with the real store using `setState()` — never mock stores
- Store auto-reset between tests via `tests/__mocks__/zustand.js`

**Layer 2 — E2E tests (Playwright + Electron):**
- `npm run test:e2e` (requires `npm run build` first)
- Launches the real Electron app against a temp fixture copy in `tests/tmp-e2e/`
- Custom `--user-data-dir` with pre-written `lastRoot.json` skips the setup screen
- `AC27_E2E_TMP_DIR` env var skips native OS dialogs (backup, export) in test mode
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
- New parser tests (`test_tokenizer`, `test_acl_json`, `test_acl_document`) run without a game root — they use synthetic test data
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
   - Scans all `.acl` files (includes demo/test/tutorial variants — all treated as normal levels)
   - Extracts `specDB` (Designator → AircraftSpec, from ALL aircraft entries regardless of State), `appPointMap` ((STAR,Runway) → AppPointList, from SceneryData Type=1 routes), `totalApproachTimes` (STAR → seconds, from SceneryData path lengths with aircraft-derived calibration), and `designatorMap` (AircraftType → Designator)
   - Extracts State=5 data: `state5ParamsMap` (runway → `{pathPointList, touchDownPosition, approachDirection, initialPosition}`), `starPaths` (STAR → waypoint array), and STAR↔runway maps from `SceneryData.Runways.Routes[Type=0]`
   - Extracts `runwayThresholds` from SceneryData (PhysicalName → threshold pair) for StarMap visualization
   - Collects dropdown values (`collectUniqueValues`) and runway pairs (`collectRunwayPairs`) from ALL .acl files
   - Merges audio flight numbers into `_flightNums` per airline code
   - **Stand dropdown from SceneryData:** Stand identifiers parsed by `_parseStandPositions()` become the authoritative dropdown options (sorted), replacing any hardcoded or ACL-derived stand lists
   - **STAR dropdown from SceneryData:** STAR names come from `starRunwayMap` keys (SceneryData Type=0 Routes), same pattern as Stand — scenery is the single source of truth. `starRunwayMap` is built by `extractStarRunwayMappings()` and already excludes stubs (`$rlength:0`)
   - Caches in memory as `airportCache[icao] = { audioCallsigns, approachData, dropdownValues, runwayPairs, standPositions }`
   - `standPositions` parsed from first .acl via `_parseStandPositions()` — maps stand identifier → `{x, y}` (midpoint of tail/nose taxiway node Positions)
   - Persisted to disk (`cache.json` in userData, unified with `gameRoot`, `lang`, `cacheVersion`) — no TTL, refreshed via `refresh-root-scan`
   - **Centralized cache I/O:** `_readCache(opts)` and `_writeCache(data)` in `electron/main.js` handle all `cache.json` reads/writes. `_readCache` validates `cacheVersion` and `gameRoot`, and signals `cache-invalidated` to the renderer on mismatch. All IPC handlers MUST use these helpers — never read/write `cache.json` directly.

### Cache State & Version Detection (v1.1.0)

The app uses a unified **`cache.json`** in `userData` (replaces `approachCache.json` + `lastRoot.json` + `localStorage.ac27_lang`). It contains `gameRoot`, `lang`, `cacheVersion`, `builtAt`, and `airports`.

Cache validity is determined by a standalone **`CACHE_VERSION`** constant (integer, hand-bumped in `electron/main.js`), NOT by `app.getVersion()`. This decouples cache invalidation from app updates.

**⚠️ CACHE_VERSION rule:** Any change to the shape of `cache.json` (new fields in the approach cache object, new top-level keys, changed structure of `approachData`, `saveTimeOffsets`, `fileTypeMaps`, etc.) MUST bump `CACHE_VERSION` in `electron/main.js:12`. Without this, users with stale caches will not be prompted to re-scan, and old cache data will silently corrupt saves. Examples of changes requiring a bump: adding `saveTimeOffsets` to `approachData`, adding `state5ParamsMap`, changing `fileTypeMaps` from per-airport to per-file, adding `.bak` files to the scan set. Current `CACHE_VERSION` is 7.

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
2. User clicks "Re-Scan" → scanning modal with spinner appears (i18n: `browser_scanning_title`/`browser_scanning_body`) → `refresh-root-scan` → rebuilds cache with `cacheVersion: CACHE_VERSION`
3. `init-airport-cache` and `refresh-root-scan` also stamp `cacheVersion` when writing
4. Scanning modal also appears during initial cache build in SetupScreen (`initAirportCache`)

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
   - `collect-values` IPC → reads dropdown options from airport cache (no file I/O)
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
3. `save-acl` IPC → sorts flights → looks up approach cache for the airport → generates full ACL:
   - FlightPlans rebuilt from scratch with new GUIDs
   - **AircraftState entries generated for arrival flights** where `0 < ProgressRatio < 1.0` (mid-approach at snapshot time), using `approach.js` verified algorithm: AppPointList lookup, FlyApproach resolution from SceneryData, PR formula, Position/Direction interpolation
   - Writes `.acl` + `.csv`
   - **Demo `.demo.acl` files treated identically** — save writes to `.demo.acl` + same shared `.csv` + shared timeline `.json` files
4. Timeline saves (separate IPC per type) → writes JSON files
5. Backup: `.bak` copies created before overwrite (optional, checkbox in save dialog). For `.demo.acl` files, creates `.demo.acl.bak`

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
- **Airport background**: Semi-transparent `/{ICAO}_Stand.png` image overlaid (falls back to panel background if missing)
- **i18n**: Title and legend use `standmap_title`, `standmap_current`, `standmap_available`, `standmap_occupied` keys

**Component:** `src/components/EditorScreen/StandMap/StandMap.jsx` — portal-based, responsive (scales with window via `useWindowSize` hook), viewBox preserves data aspect ratio with a target ratio cap. Uses the shared `useDrag` hook for header-drag repositioning.

### Star Map Overlay

When editing an Airway cell in the flight table, a non-blocking overlay panel shows the STAR/approach chart for the current airport. It displays:

- **SVG map** of all STAR waypoint paths for the airport, plotted from real x,z coordinates in SceneryData `AirwayNodes`
- **Runway thresholds** rendered as extended lines (3× runway length), parsed from `SceneryData.Runways.ThresholdPointGuids` via `_parseRunwayThresholds()`
- **Live aircraft positions** on approach — arrival flights' positions computed via `get-aircraft-positions` IPC using the same `computePosition()` algorithm as State=30/State=5 save generation
- **Aircraft interactivity**: Hovering an aircraft dot shows callsign + STAR + runway + ETA
- **Click to select** a STAR path, which updates the flight's Airway field via `updateFlight(idx, { Airway: starName })`
- **Departure flights**: Show a notice that the STAR map is unavailable (no approach data for departures)
- **Airport background**: Semi-transparent `/{ICAO}_STAR.png` image overlaid
- **i18n**: Title and legend use `starmap_title`, `starmap_current`, `starmap_available`, `starmap_disabled`, `starmap_no_data` keys

**Component:** `src/components/EditorScreen/StarMap/StarMap.jsx` — portal-based, draggable via `useDrag` hook, responsive viewBox scaling. Path colors cycle through a preset palette per STAR name. Runway thresholds rendered as thin colored lines matching their associated STAR paths.

**Map overlay orchestration:** `MapOverlays` sub-component in `EditorScreen.jsx` manages visibility and prop-passing for both StandMap and StarMap. Visibility state lives in zustand (`showStandMap`, `showStarMap`, `activeMap`, `mapFlightIdx`). Only one map is "on top" at a time (controlled by `activeMap`). Both maps close when leaving the editor screen (`setScreen` clears map state).

### Demo .acl File Handling (v1.0.9+)

The game ships four 30-minute `.demo.acl` slice levels:
- `ZSJN-Morning_120min.demo.acl` (05:45–06:15)
- `ZSJN_07-10.demo.acl` (07:30–08:00)
- `KJFK_09-11.demo.acl` (09:30–10:00)
- `KJFK_20-22.demo.acl` (20:30–21:00)

**Key properties:**
- Each `.demo.acl` is a save-state snapshot with the **same BaseTime** as its parent but a **later CurrentDateTime** (~40–55 min offset), creating the 30-min playable window
- FlightPlans, scenery, and file references are identical to the parent `.acl`
- No matching `.aclcfg` exists — Config is read from the `.acl` file itself

**Editor behavior:**
- `.demo.acl` files are treated as **normal levels** — always visible, no tags, no hiding
- **Demo mode** (root path contains "Airport Control 27 Demo"): only `.demo.acl` files are shown
- **On load:** flights are filtered to a 30-minute window starting at `CurrentDateTime` via `_filterDemoFlights()` — centralized helper shared across load, save, import, and restore paths. Uses integer-minute bounds: `[cdtMin, cdtMin + 30)` (inclusive lower, exclusive upper). Config's `startTime`/`endTime` are overridden to match.
- **On save:** writes to `.demo.acl` + shared `.csv` + shared timeline `.json` files; creates `.demo.acl.bak`
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
| **2** | **SID** (departure transition) | `JFK5.JFK`, `TUML5T`, `BASV7Y` | Ignore — departure routes only |
| 3 | Missed approach | `RNAV Y Rwy 31L (Missed Approach)` | Ignore |

**Important:** The authoritative source for valid STAR↔runway combinations is `SceneryData.Runways[runway].Routes[].Name` where `Type === 0`. This is a superset of what `appPointMap` covers (which is limited to State=30 aircraft entries at snapshot time). For example, KJFK runway 31L has STAR `SEY.PARCH4` (Type 0) defined in SceneryData, but this combo may have no State=30 aircraft in any scanned .acl file, leaving it absent from `appPointMap`.

**Extraction algorithm** (`extractStarRunwayMappings` — see approach.js):
1. Find `SceneryData` → `Runways` section via tokenizer
2. Find main `$rcontent` array at brace depth 1 (skip nested arrays like `comparer`)
3. Iterate runway dictionary entries → extract `Name` (runway designator) and `Routes`
4. Parse `Routes.$rcontent` → for each route with `Type === 0`, collect `Name` (STAR name)
5. Return `{ starRunwayMap: {star → [runways]}, runwayStarMap: {runway → [stars]} }`

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

**Component tests:**
```bash
npm test              # Run all Vitest component + store + utility tests
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

### Building
```bash
# ALWAYS use build.js — never npm run build:win directly
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
15. **Build with `node build.js`** on Windows, never `npm run build:win`.
16. **Bump `CACHE_VERSION` when cache.json schema changes.** Any change to the structure of `approachData`, `saveTimeOffsets`, `fileTypeMaps`, `state5ParamsMap`, or new top-level keys in cache.json MUST bump `CACHE_VERSION` in `electron/main.js:12`. Stale caches silently corrupt saves.
17. **Keep documentation in sync.** After any significant change, update BOTH:
    - **This skill** (`.claude/skills/ac27-level-editor/SKILL.md`)
    - **README.md**
