---
name: ac27-level-editor
description: AC27 Level Editor — Electron desktop app for editing Airport Control 27 .acl flight schedule files. Use this skill whenever working in this repo, editing any source file, running commands (npm start, node build.js, npm test, node tests/integration/*), adding features, fixing bugs, or discussing the app's architecture. This skill documents the full project structure, coding conventions, IPC patterns, save/load flow, timeline system, build process, and all dev commands. Always consult this skill before making changes.
---

# AC27 Level Editor — Repo Skill

## Project Identity

- **Name:** `ac27-level-editor` (v1.1.0)
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
│  - 27 ipcMain.handle() endpoints                       │
│  - All file I/O, dialog, caching lives here             │
├─────────────────────────────────────────────────────────┤
│  electron/preload.js (contextBridge)                    │
│  - Exposes window.electronAPI with 26 methods          │
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
│    timelines, modal/toast, _windSpeedUnit               │
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
│   │   ├── scenery.js           # SceneryData parser (runway/gate GUIDs)
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
   - Extracts `specDB` (Designator → AircraftSpec), `appPointMap` ((Route,Runway) → AppPointList), `totalApproachTimes` (Route → seconds), and `designatorMap` (AircraftType → Designator)
   - Collects dropdown values (`collectUniqueValues`) and runway pairs (`collectRunwayPairs`) from ALL .acl files
   - Merges audio flight numbers into `_flightNums` per airline code
   - Caches in memory as `airportCache[icao] = { audioCallsigns, approachData, dropdownValues, runwayPairs }`
   - Persisted to disk (`cache.json` in userData, unified with `gameRoot`, `lang`, `cacheVersion`) — no TTL, refreshed via `refresh-root-scan`

### Cache State & Version Detection (v1.1.0)

The app uses a unified **`cache.json`** in `userData` (replaces `approachCache.json` + `lastRoot.json` + `localStorage.ac27_lang`). It contains `gameRoot`, `lang`, `cacheVersion`, `builtAt`, and `airports`.

Cache validity is determined by a standalone **`CACHE_VERSION`** constant (integer, hand-bumped in `electron/main.js`), NOT by `app.getVersion()`. This decouples cache invalidation from app updates — only bump `CACHE_VERSION` when the cache schema changes.

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
2. User clicks "Re-Scan" → `refresh-root-scan` → rebuilds cache with `cacheVersion: CACHE_VERSION`
3. `init-airport-cache` and `refresh-root-scan` also stamp `cacheVersion` when writing

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
- **Custom Type Mode** (`store.customTypeMode`): toggle button in the bottom toolbar switches AirlineCode and FlightNum columns from dropdowns to free-text inputs. When ON, AircraftType shows all available types (unfiltered by airline compat), and Registration is filtered by aircraft type only (across all airlines). The AirlineCode→AircraftType/Registration cascade in `updateFlight` is skipped. Validation is data-driven: if any flight has a custom airline code or flight number (one not in the audio callsign reference data), those specific validation rules are skipped for the entire save — regardless of toggle state. A one-time notice modal with "Don't show again" checkbox warns about missing radio calls.

### Phase 3: Save
1. `handleSave()` → `validateCallsigns()` → `runTripleValidation()`:
   - (a) Dropdown value validation — every field against valid options
   - (b) Time range validation — flights within config startTime/endTime bounds
   - (c) Runway timeline bounds — change entry times within level range
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
- **On load:** flights with landing/off-block times before `CurrentDateTime` are auto-removed (ease-of-use cleanup)
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
- `extractTypeMap(aclText)` → `Map<number, string>` — captures all fully-qualified `$type` declarations from a file; type numbers are per-file in Unity's serialization
- `buildAppPointMap(approachEntries)` → `Map<"Route|Runway", Vector3[]>` — verified 1:1 mapping
- `computeTotalApproachTimes(approachEntries, getGroupId?)` → `Map<Route, seconds>` — per-route duration
- `extractGameTime(aclText)` → `seconds \| null` — parse `GameTime.CurrentDateTime` ticks as seconds since midnight
- `extractSaveTime(aclText, totalApproachTimes)` → `seconds \| null` — derive snapshot time from first State=30 entry's PR + LandingTime

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
- `buildApproachCache(airportDir)` → `{specDB, appPointMap, totalApproachTimes, designatorMap, saveTimeOffsets, typeMap, fileTypeMaps}` — scans all .acl files for an airport (including demo/test/tutorial variants); `saveTimeOffsets` is a `Map<filename, seconds>` of per-file snapshot times; `typeMap` is a merged `Map<number, string>` of all type declarations across the airport; `fileTypeMaps` is a `Map<basename, Map<number, string>>` of per-file type declarations for save-time type resolution

**Assembly:**
- `buildApproachAircraftBlock({flightPlanGuid, route, flyPoints, appPoints, progressRatio, spec, radioChannelGuid?, typeNums?, acTypeNum?, nextId?})` → `{guid, block, nextId}` — complete `$k/$v` JSON block; `typeNums` (optional) maps type names→numbers from the per-file `typeMap` to avoid hardcoded type IDs
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
16. **Keep documentation in sync.** After any significant change, update BOTH:
    - **This skill** (`.claude/skills/ac27-level-editor/SKILL.md`)
    - **README.md**
