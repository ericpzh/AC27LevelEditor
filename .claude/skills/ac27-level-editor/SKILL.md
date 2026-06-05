---
name: ac27-level-editor
description: AC27 Level Editor — Electron desktop app for editing Airport Control 27 .acl flight schedule files. Use this skill whenever working in this repo, editing any source file, running commands (npm start, node build.js, node test/*), adding features, fixing bugs, or discussing the app's architecture. This skill documents the full project structure, coding conventions, IPC patterns, save/load flow, timeline system, build process, and all dev commands. Always consult this skill before making changes.
---

# AC27 Level Editor — Repo Skill

## Project Identity

- **Name:** `ac27-level-editor` (v1.0.8)
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
│  - 26 ipcMain.handle() endpoints                       │
│  - All file I/O, dialog, caching lives here             │
├─────────────────────────────────────────────────────────┤
│  electron/preload.js (contextBridge)                    │
│  - Exposes window.electronAPI with 25 methods          │
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
│    useSaveAcl, useKeyboardShortcuts                     │
├─────────────────────────────────────────────────────────┤
│  src/store/ (zustand state)                             │
│  - appStore.js — single store: screen, flights,         │
│    timelines, modal/toast                               │
├─────────────────────────────────────────────────────────┤
│  src/acl/ (parser facade + 8 backend modules,          │
│    CommonJS + some ESM)                                  │
│  - parser.js is the FACADE — main.js imports ALL        │
│    backend modules through it only                      │
│  - constants, scanner, flight_plans, world_state,        │
│    approach, dynamics, scenery, utils                   │
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
│   ├── main.js              # Electron main process + 26 IPC handlers
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
│   │   └── useKeyboardShortcuts.js
│   │
│   ├── store/
│   │   └── appStore.js          # zustand store — all app state
│   │
│   ├── acl/                     # Backend modules (8 files; CommonJS + some ESM)
│   │   ├── parser.js            # FACADE — re-exports all backend modules
│   │   ├── constants.js         # ACL-format constants (ESM, imported by parser)
│   │   ├── scanner.js           # Scans game root for airports & .acl files
│   │   ├── flight_plans.js      # FlightPlans format (types 37/52/57/58)
│   │   ├── world_state.js       # WorldState format (types 35/56/54)
│   │   ├── approach.js         # Approach AircraftState constructor (State=30)
│   │   ├── dynamics.js          # Deprecated — calcProgressRatio/buildAircraftEntry stubs
│   │   ├── scenery.js           # SceneryData parser (runway/gate GUIDs)
│   │   └── utils.js             # Enrichment, sorting, audio, import utils
│   │
│   └── utils/                   # Shared utilities (ESM + some CJS for backend)
│       ├── constants.js         # UI field defs, airline codes, getActiveColumns
│       ├── timeUtils.js         # Tick↔time conversion, timeline helpers (CJS + ESM)
│       ├── i18n.js              # Chinese/English translation (T(), getLang, setLang)
│       ├── validators.js        # validateCallsigns, runTripleValidation
│       ├── htmlUtils.js         # escapeHtml, stripSuffixes
│       ├── csvIo.js             # CSV import/export
│       ├── zipUtils.js          # Pure Node.js ZIP (zlib, no deps)
│       └── logger.js            # Console → file redirect (dev mode)
│
├── test/                # 9 plain Node.js test scripts (no framework)
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

### Test Conventions

- No test framework. Tests are plain Node.js scripts run with `node test/<name>.js`
- Tests `require('./src/acl/parser.js')` to access both public and `_private` functions
- Many tests need a real game installation (Airport Control 27) at a known path
- Tests print results to stdout — read the output to determine pass/fail
- No mocking, no fixtures — tests operate on real files

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
3. `init-airport-cache` IPC → loads audio clips + pre-scans approach data per airport:
   - Scans all production `.acl` files (excludes demo/test/tutorial)
   - Extracts `specDB` (Designator → AircraftSpec), `appPointMap` ((Route,Runway) → AppPointList), `totalApproachTimes` (Route → seconds), and `designatorMap` (AircraftType → Designator)
   - Caches in memory as `airportCache[icao].approachData`

### Phase 1: Load Level
1. User clicks a level row → `window._pendingEditor = { filePath, airportIcao }` → `setScreen('editor')`
2. EditorScreen's `useEffect` reads `window._pendingEditor` and loads:
   - `load-acl` IPC → reads `.acl` → parses FlightPlans as primary flight data
   - `load-timelines` IPC → reads `weather_timeline.json`, `wind_timeline.json`, `runway_timeline_*.json`
   - `collect-values` IPC → builds dropdown option sets
   - `load-audio-callsigns` IPC → loads airline/aircraft audio metadata
3. Zustand store is populated and React renders the flight table

### Phase 2: Edit (all in zustand store)
- All edits go through store actions: `updateFlight()`, `addArrivalFlight()`, `deleteSelected()`, etc.
- `store.modified = true` on any change
- `store.timelineModified[type] = true` on timeline changes
- FlightNumber counter tracks next available number

### Phase 3: Save
1. `handleSave()` → `validateCallsigns()` → `runTripleValidation()`:
   - (a) Dropdown value validation — every field against valid options
   - (b) Time range validation — flights within config startTime/endTime bounds
   - (c) Runway timeline validation — active runways at each flight's time
2. `save-acl` IPC → sorts flights → looks up approach cache for the airport → generates full ACL:
   - FlightPlans rebuilt from scratch with new GUIDs
   - **AircraftState entries generated for arrival flights** where `0 < ProgressRatio < 1.0` (mid-approach at snapshot time), using `approach.js` verified algorithm: AppPointList lookup, FlyApproach resolution from SceneryData, PR formula, Position/Direction interpolation
   - Writes `.acl` + `.csv`
3. Timeline saves (separate IPC per type) → writes JSON files
4. Backup: `.bak` copies created before overwrite (optional, checkbox in save dialog)

### Save As ZIP
- Saves silently → packages 5 files into ZIP → native save dialog
- ZIP contents: `.acl` + `.csv` + `weather_timeline.json` + `wind_timeline.json` + `runway_timeline_*.json`

### Import ZIP
- Native open dialog → validates ZIP structure → backs up current files → extracts → reloads

## ACL File Format

ACL files are proprietary JSON with embedded .NET type information:
- `"$type": "56|Namespace.ClassName, Assembly"` — type tags
- `"$id": N` — object reference IDs
- `"$k"` / `"$v"` — dictionary key/value entries
- `"$values": [...]` — array payloads

Key section types:
- `SceneryData` (type 59) — runway/gate GUIDs
- `Aircrafts` (type 35) — aircraft state entries with DynamicParams
- `FlightPlans` (type 52) — container for FlightPlanState entries
- `FlightPlanState` (type 37) — individual flight plans with DepartureLeg/ArrivalLeg
- `DepartureLeg` (type 57) / `ArrivalLeg` (type 58) — flight leg data
- `TaskFlightState` (type 56/54) — older WorldState format (legacy)
- `WeatherFrames` / `WindFrames` / `RunwayTimeline` — timeline sections

## Approach Aircraft Construction (State=30)

The `src/acl/approach.js` module implements verified findings from an audit of 8 production `.acl` files (ZSJN + KJFK). It handles construction of State=30 (Flying/Approach) aircraft entries.

### Verified Field Relationships

| Field | Source | Pattern |
|-------|--------|---------|
| `Specification` | Designator→Spec DB | Fixed per Designator (byte-identical across all files) |
| `FlyApproachPathPointList` | AirwayNodes via STAR GUIDs | `Runways[runway].Routes[route].AirwayNodeGuids → AirwayNodes[guid].Position` |
| `AppPointList` | f(Route, Runway) map | Fixed per (Route, Runway) — 8 combos verified, 0 counterexamples |
| `ProgressRatio` | Time-based formula | `1 − (LandingTime − saveTime) / totalApproachTime(Route)` |
| `Direction` | Path tangent | Unit vector in XZ at current path position |
| `Position.y` | Constant | Always 15.24 (approach altitude) |
| All other fields | Invariant template | Fixed across all State=30 aircraft |

### ProgressRatio Formula

```
ProgressRatio = 1 − (LandingTime − saveTime) / totalApproachTime(Route)
```

- `saveTime` = simulation clock when the snapshot was taken (file-consistent, validated within 6-72s spread)
- `totalApproachTime(Route)` = route-specific total duration from STAR entry to touchdown (~1380-1775s, computed from dTime/dPR within each file)
- Verified: saveTime spread within each file is <73s (proves the formula is linear time-based)

### Module API (`src/acl/approach.js`)

**Data Extraction:**
- `extractSpecificationDB(aclText)` → `Map<Designator, Spec>` — 14 designators across ZSJN+KJFK
- `extractApproachData(aclText)` → `Array<{route, runway, progressRatio, flyPoints, appPoints, ...}>` — all State=30 aircraft
- `buildAppPointMap(approachEntries)` → `Map<"Route|Runway", Vector3[]>` — verified 1:1 mapping
- `computeTotalApproachTimes(approachEntries, getGroupId?)` → `Map<Route, seconds>` — per-route duration

**Path Resolution:**
- `resolveFlyApproachPoints(aclText, route, runway)` → `Vector3[]` — via SceneryData AirwayNodes

**Computation:**
- `computeProgressRatio(landingTimeTicks, saveTimeTicks, totalApproachTime)` → `0..1`
- `computePosition(flyPoints, appPoints, progressRatio)` → `{x, y:15.24, z}` — approximate (linear interp, ~50-200m error due to non-uniform speed)
- `computeDirection(flyPoints, appPoints, progressRatio)` → unit vector — accurate (~88%)
- `buildFullPath(flyPoints, appPoints)` → combined path array
- `computePathLength(points)` → total distance

**Designator Mapping & Cache:**
- `buildDesignatorMapping(aclText)` → `Map<AircraftType, Designator>` — cross-references FlightPlans with AircraftStates
- `buildApproachCache(airportDir)` → `{specDB, appPointMap, totalApproachTimes, designatorMap}` — scans all production .acl files for an airport

**Assembly:**
- `buildApproachAircraftBlock({flightPlanGuid, route, flyPoints, appPoints, progressRatio, spec, radioChannelGuid?})` → `{guid, block, nextId}` — complete `$k/$v` JSON block

### Test

```bash
node test/test_approach_aircraft.js [--root <game-root>]
```

Validates all algorithms against the 8 production files: spec consistency, AppPoint mapping, ProgressRatio formula (saveTime spread), FlyApproach resolution, Position/Direction reconstruction, and block assembly.

## All Dev Commands

### Running the app
```bash
npm start          # Launch Electron in dev mode (Vite dev server + Electron)
```

### Running tests

All tests accept `--help` / `-h` for usage. Temp files are written to `test/` and cleaned up automatically.

**Scan-all tests (need game root, default `../../../` from test dir):**
```bash
node test/test_parse_airport.js [--root <game-root>]
node test/test_callsign_gen.js [--root <game-root>]
node test/test_approach_aircraft.js [--root <game-root>]
```

**Single-ACL tests (require `--acl <path>`, derive paired files automatically):**
```bash
node test/test_e2e_save_load.js --acl <path>
node test/test_csv_vs_flightplans.js --acl <path>
node test/test_rebuild_sections.js --acl <path>
node test/test_acl_linkage.js --acl <path>
```

**Timeline tests (require `--acl <path>`, auto-discover JSONs):**
```bash
node test/test_timeline_comparison.js <acl-path>
node test/test_generate_timelines.js --acl <path>
node test/test_rebuild_timelines.js --acl <path>
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
4. **No test framework.** Tests are `node test/script.js`. Do not add Jest, Mocha, or Vitest unless asked.
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
16. **Keep documentation in sync.** After any significant change, update BOTH:
    - **This skill** (`.claude/skills/ac27-level-editor/SKILL.md`)
    - **README.md**
