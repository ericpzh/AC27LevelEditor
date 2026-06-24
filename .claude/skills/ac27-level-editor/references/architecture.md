# AC27 Architecture & Conventions

## Table of Contents

- [Directory Structure](#directory-structure)
- [Coding Conventions](#coding-conventions)
  - [Backend (Node.js / `electron/*.js` + `src/acl/*.js`)](#backend-nodejs--electronjs--srcacljs)
  - [Frontend (React / `src/components/*.jsx` + `src/hooks/*.jsx`)](#frontend-react--srccomponentsjsx--srchooksjsx)
  - [IPC Patterns](#ipc-patterns)
  - [Test Conventions](#test-conventions)
- [Three-Screen SPA](#three-screen-spa)

## Directory Structure

```
AC27LevelEditor/
├── electron/
│   ├── main.js              # Electron main process + 42 IPC handlers
│   ├── preload.js           # contextBridge (window.electronAPI, ~47 methods)
│   ├── api-server.js        # HTTP API + MCP server (port 31415, auto-starts with app)
│   └── udp_listener.js      # UDP telemetry — 10 Hz binary aircraft state (127.0.0.1:20266) + commands (20267)
├── mcp/
│   └── bridge.js            # MCP stdio↔HTTP bridge (launched by Claude Code)
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
│   │   │   ├── AirportCardMap.jsx + .css  # Mini ground-radar SVG per card
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
│   │   ├── MapWindows/               # Full-window map visualizations (separate BrowserWindow instances)
│   │   │   ├── GroundMapWindow.jsx + .css  # Surface radar: taxiways, runways, areas, ground aircraft (stand-access segments marked + help overlay)
│   │   │   ├── AirMapWindow.jsx + .css     # Approach radar: STAR/SID/APPR routes, air aircraft, map bg, runway extensions, range rings, border overlay, help overlay
│   │   │   ├── FlightStripsWindow.jsx + .css  # Flight strips: live seat-sorted strips with drag reorder, selection sync, help overlay
│   │   │   ├── ControlSidebar.jsx + .css   # Vertical sidebar: spin knobs (zoom/pan/airspace) + toggle buttons + help button
│   │   │   ├── SpinKnob.jsx + .css         # Rotary encoder knob (click-drag + scroll-wheel, gauge mode)
│   │   │   ├── SimClock.jsx                # Shared sim-time clock (HH:MM:SS UTC, accepts className prop)
│   │   │   ├── MapHelpOverlay.jsx + .css   # Context-sensitive help overlay (air/ground/strips, Escape to close, toggleable buttons, optional title prop)
│   │   │   ├── MapShared.css               # Shared styles: toggle buttons, clock, help button, animations, witch mode UI overrides (sidebar bar.png, button.png/button_on.png toggles, knob.png spin knobs)
│   │   │   ├── useSvgZoom.js               # Scroll-zoom + drag-pan SVG hook (clamped, imperative API)
│   │   │   ├── useUdpAircraftState.js      # Hook subscribing to live UDP state pushes (incl. simTimeUnixMs)
│   │   │   ├── witchMode.js                # Witch mode: direction, parked detection, sprite-sheet lookup (accepts centralized spriteIdx from main process, djb2 hash fallback)
│   │   │   ├── FlightStripCommandBar.jsx   # Strip command bar UI (v1.1.7 planned, import commented out)
│   │   │   ├── commandTree.js              # Command tree data model + filtering by seat/state/direction
│   │   │   ├── voiceNumberParser.js        # Spoken numbers → digits (EN + ZH aviation phraseology)
│   │   │   ├── voiceCallsignParser.js      # Airline name→ICAO + callsign matching against UDP aircraft
│   │   │   ├── voiceCommandMatcher.js      # Fuzzy command matching (aliases, Jaccard, Dice coefficient)
│   │   │   ├── useVoiceCommands.js         # React hook orchestrating full voice pipeline
│   │   │   └── VoicePTTButton.jsx          # Push-to-talk mic button (hold-to-talk, anion/pulse/flash, witch sprite)
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
├── tests/               # 261 Vitest + Playwright E2E + 17 Node.js integration tests
│   ├── components/MapWindows/  # MapWindow component & hook tests (10 files, 151 tests)
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
- **⚠️ CSS `url()` for public assets MUST use absolute paths (`/witch/foo.png`)** — Vite needs the leading `/` to correctly rewrite paths in production builds. Without it, assets break in the packaged EXE because the CSS file lives in `dist/assets/` while public files are in `dist/`. JSX `<img src>` uses page-relative paths (e.g., `witch/help.png` or `./witch/help.png`).

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
  - `store-api-update` — pushes bulk state updates from MCP/API server to renderer: `{ flights, modified, ... }`; preload bridges via `onStoreApiUpdate(cb)` / `offStoreApiUpdate(cb)` (handler-map pattern). Renderer converts arrays→Sets and calls `setLegacyState()`.

### Test Conventions

Three-layer testing strategy:

**Layer 1 — Component tests (Vitest + React Testing Library):**
- `npm test` or `npm run test:watch` — 261 tests across 19 files
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
