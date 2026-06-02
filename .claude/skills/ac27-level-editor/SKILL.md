---
name: ac27-level-editor
description: AC27 Level Editor — Electron desktop app for editing Airport Control 25 .acl flight schedule files. Use this skill whenever working in this repo, editing any source file, running commands (npm start, node build.js, node test/*), adding features, fixing bugs, or discussing the app's architecture. This skill documents the full project structure, coding conventions, IPC patterns, save/load flow, timeline system, build process, and all dev commands. Always consult this skill before making changes — the app has no bundler, no TypeScript, no test framework, and no linter; patterns are deliberate and should be preserved.
---

# AC27 Level Editor — Repo Skill

## Project Identity

- **Name:** `ac27-level-editor` (v1.0.3)
- **Purpose:** Cross-platform desktop level editor for Airport Control 25 `.acl` flight schedule files
- **Stack:** Electron 33 + plain JavaScript (no TypeScript, no bundler, no framework)
- **Entry:** `main.js` (Electron main process)
- **App ID:** `com.ac27.level-editor`
- **Product name:** `AC27 Level Editor`

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  main.js (Electron Main Process)                        │
│  - Creates BrowserWindow (1400×880, min 1024×640)       │
│  - contextIsolation: true, nodeIntegration: false       │
│  - ~20 ipcMain.handle() endpoints                       │
│  - All file I/O, dialog, caching lives here             │
├─────────────────────────────────────────────────────────┤
│  preload.js (contextBridge)                             │
│  - Exposes window.electronAPI with ~20 methods          │
│  - Each method = ipcRenderer.invoke(channel, ...args)   │
├─────────────────────────────────────────────────────────┤
│  src/index.html + style.css                             │
│  - 12 <script> tags in dependency order (NO bundler)    │
│  - Dark theme, CSS custom properties                    │
│  - Three screens: setup → browser → editor              │
├─────────────────────────────────────────────────────────┤
│  src/renderer/ (12 global-scope JS files)               │
│  - Share state via window-level appState singleton      │
│  - Imperative DOM manipulation via getElementById       │
│  - No modules, no imports, no framework                 │
├─────────────────────────────────────────────────────────┤
│  src/*.js (12 CommonJS backend modules)                 │
│  - module.exports / require() patterns                  │
│  - acl_parser.js is the COMPLETE facade — main.js       │
│    imports ALL backend modules through it only          │
│  - Underscore-prefix = private, no prefix = public      │
└─────────────────────────────────────────────────────────┘
```

## Directory Structure

```
AC27LevelEditor/
├── main.js                  # Electron main process entry
├── preload.js               # contextBridge (window.electronAPI)
├── package.json             # scripts, electron-builder config
├── build.js                 # RECOMMENDED build script (programmatic)
├── set_icon.js              # Post-build icon embedding
├── icon.ico / icon.png      # App icons
├── README.md                # Comprehensive docs — read it first
│
├── src/
│   ├── index.html           # SPA shell, loads 12 renderer scripts in order
│   ├── style.css            # Dark theme, all app styles
│   ├── renderer.js          # Entry renderer (IIFE bootstrap, screen routing)
│   │
│   ├── acl_parser.js        # FACADE — re-exports from all backend modules
│   ├── acl_scanner.js       # Scans game root for airports & .acl files
│   ├── acl_flight_plans.js  # FlightPlans format parse/generate (types 37/52/56/57/58)
│   ├── acl_world_state.js   # WorldState format parse/generate (types 35/56/54)
│   ├── acl_dynamics.js      # DynamicParams template capture & Aircraft entry builder
│   ├── acl_scenery.js       # SceneryData parser (runway/gate GUID mapping)
│   ├── acl_utils.js         # Import utilities (enrich, sort, collect, audio)
│   ├── csv_io.js            # CSV import/export (standard + game format)
│   ├── zip_utils.js         # Pure Node.js ZIP create/read/extract (zlib, no deps)
│   ├── time_utils.js        # Newtonsoft.Json DateTime ticks ↔ HH:MM:SS
│   ├── constants.js         # Shared constants (aircraft map, fields, tick offsets)
│   ├── logger.js            # Console → file redirect (dev mode only)
│   │
│   └── renderer/            # 12 global-scope scripts (loaded by index.html)
│       ├── data-constants.js    # Airport metadata, airline codes, field defs
│       ├── state.js             # appState singleton — ALL shared state
│       ├── ui-utils.js          # escapeHtml, showModal, showToast, showScreen
│       ├── setup-screen.js      # Game root directory selection
│       ├── browser-screen.js    # Airport card listing, file sorting/filtering
│       ├── editor-core.js       # Flight table rendering, sorting, column mgmt
│       ├── editor-shell.js      # Screen routing, keyboard shortcuts, modals
│       ├── cell-editor.js       # Inline cell editing + SVG clock popover
│       ├── flight-actions.js    # Add/delete/duplicate flight operations
│       ├── save-actions.js      # Save with triple validation, Save As ZIP
│       ├── import-actions.js    # ZIP import with backup
│       └── timeline-editors.js  # Weather/Wind/Runway timeline inline editors
│
├── test/
│   ├── parse_airport.js         # Smoke test: parse all airports
│   ├── callsign_gen_test.js     # CallSign prefix validation
│   ├── csv_vs_flightplans.js    # CSV vs ACL cross-check
│   ├── e2e_save_load.js         # Full save/load round-trip
│   ├── timeline_comparison.js   # JSON timelines vs ACL-embedded data
│   ├── test_generate_timelines.js    # Timeline section generators
│   ├── test_rebuild_sections.js      # FlightPlans/Aircrafts rebuild
│   └── test_rebuild_timelines.js     # Weather/Wind/Runway section rebuild
│
├── dist/                    # Build output (gitignored)
├── .github/workflows/       # CI: release.yml (Build & Release on v* tags)
└── .claude/skills/          # Claude Code project skills
```

## Coding Conventions

### Backend (Node.js / `src/*.js` + `main.js` + `preload.js`)

**Module system:** CommonJS throughout.
```js
// Import
const { loadFlights, exportCSV } = require('./src/acl_parser.js');

// Export
module.exports = { publicFn, _privateFn };
```

**Naming:**
- `camelCase` for functions and variables
- `_underscorePrefix` for private/internal functions (not exported, or exported only for testing)
- `UPPER_SNAKE_CASE` for true constants
- `PascalCase` only for class-like objects (rare — the codebase is procedural)

**File naming:** `snake_case.js` — this is the established convention in this repo. Do NOT introduce kebab-case or PascalCase filenames.

**Error handling:** Always return `{ success: true/false, error?: message }` from IPC handlers and I/O functions. Never throw across process boundaries.

**Logging:** Use `console.log` with a `[TAG]` prefix for filtering:
- `[IPC]` — main process IPC handlers
- `[ACL-LOAD]` — ACL parsing
- `[DYNAMICS]` — Dynamics template capture
- `[RENDERER]` — renderer-side operations

**No external dependencies for core logic.** The app uses only Node.js built-ins (`fs`, `path`, `zlib`, `crypto`). Do not add npm dependencies without strong justification.

**Facade pattern:** `acl_parser.js` is the single entry point for all parsing/generation. `main.js` imports only from `acl_parser.js`. New parsing modules must be re-exported through `acl_parser.js`.

### Frontend (Renderer / `src/renderer/*.js` + `src/renderer.js`)

**No modules.** All files share the global `window` scope. The `<script>` load order in `index.html` IS the dependency graph. Files loaded earlier are available to files loaded later.

**Load order (critical — do not change without understanding dependencies):**
1. `data-constants.js` — static data, no deps
2. `state.js` — `appState` singleton, depends on data-constants
3. `ui-utils.js` — DOM utilities, depends on state
4. `setup-screen.js` — depends on ui-utils
5. `browser-screen.js` — depends on ui-utils
6. `editor-core.js` — depends on ui-utils
7. `cell-editor.js` — depends on editor-core
8. `flight-actions.js` — depends on editor-core, cell-editor
9. `save-actions.js` — depends on editor-core
10. `import-actions.js` — depends on save-actions
11. `timeline-editors.js` — depends on editor-core
12. `editor-shell.js` — LAST, wires everything together

**State management:** Single mutable `appState` object in `state.js`. All modules read/write it directly. Key fields:
- `appState.flights[]` — the flight array being edited
- `appState.modified` — unsaved changes flag
- `appState.timelineModified` — `{ weather, wind, runway }` booleans
- `appState.selectedIndices` — `Set` of selected flight indices
- `appState.currentPath`, `appState.currentAirport` — active file context

**DOM patterns:**
- `document.getElementById('some-id')` for element access
- `.innerHTML = array.map(...).join('')` for dynamic content
- Event delegation on containers (e.g., click handler on `#sections-container`)
- CSS class toggling for visibility: `element.classList.toggle('hidden', condition)`

**Function naming:**
- `render*()` — functions that rebuild DOM subtrees (`renderWeatherEditor()`)
- `handle*()` — event handlers (`handleSave()`, `handleClick()`)
- `open*()` / `close*()` — screen/modal transitions (`openEditor()`, `closeModal()`)
- `start*()` — begin an interaction (`startCellEdit()`)

**CSS:** Dark theme using CSS custom properties (`--bg`, `--accent`, `--radius`, `--transition`). BEM-like flat naming. Never add a CSS framework or utility library.

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
- All file I/O goes through IPC handlers in `main.js`
- IPC channels use kebab-case strings matching the handler name
- Every `ipcMain.handle()` must return `{ success: true/false }`
- New IPC channels require: (1) handler in `main.js`, (2) bridge method in `preload.js`, (3) call site in renderer

### Test Conventions

- No test framework. Tests are plain Node.js scripts run with `node test/<name>.js`
- Tests `require('./src/acl_parser.js')` to access both public and `_private` functions
- Many tests need a real game installation (Airport Control 25) at a known path
- Tests print results to stdout — read the output to determine pass/fail
- No mocking, no fixtures — tests operate on real files

## Three-Screen SPA

The app is a single-page application with three screens managed by CSS visibility:

| Screen | ID | Purpose | Trigger |
|--------|-----|---------|---------|
| Setup | `#screen-setup` | Select game root directory | First launch (no saved root) |
| Browser | `#screen-browser` | Browse airports & level files | After setup completes |
| Editor | `#screen-editor` | Edit flights in table + timelines | Click a level row |

Screen transitions: `showScreen(name)` in `ui-utils.js` toggles `.hidden` on all `.screen` divs.

## Data Flow: Load → Edit → Save

### Phase 0: Airport Cache Init (once per game root)
1. User selects game root directory
2. `scan-acls` IPC → `scanGameRoot()` → returns airport list with `.acl` file paths
3. `init-airport-cache` IPC → scans all CSVs and audio clips per airport → caches in memory

### Phase 1: Load Level
1. User clicks a level row → `openEditor(filePath, airportIcao)`
2. `load-acl` IPC → reads `.aclcfg` → finds `.csv` → parses both → enriches CSV from ACL
3. `load-timelines` IPC → reads `weather_timeline.json`, `wind_timeline.json`, `runway_timeline_*.json`
4. `collect-values` IPC → builds dropdown option sets
5. `load-audio-callsigns` IPC → loads airline/aircraft audio metadata
6. Renderer populates `appState` and renders the flight table

### Phase 2: Edit (all local)
- All edits mutate `appState` directly in the renderer process
- `appState.modified = true` on any change
- `appState.timelineModified[type] = true` on timeline changes
- Auto-sort on time changes, auto-fill single-option dropdowns

### Phase 3: Save
1. `handleSave()` → `runTripleValidation()`:
   - (a) Dropdown value validation — every field against valid options
   - (b) Time range validation — flights within config startTime/endTime bounds
   - (c) Runway timeline validation — active runways at each flight's time
2. `save-acl` IPC → sorts flights → generates full ACL from scratch → writes `.acl` + `.csv`
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

## All Dev Commands

### Running the app
```bash
npm start          # Launch Electron in dev mode (no build step needed)
```

### Running tests

All tests accept `--help` / `-h` for usage. Temp files are written to `test/` and cleaned up automatically.

**Scan-all tests (need game root, default `../../../` from test dir):**
```bash
node test/test_parse_airport.js [--root <game-root>]     # Smoke test — parse all airports
node test/test_callsign_gen.js [--root <game-root>]      # CallSign prefix validation
```

**Single-ACL tests (require `--acl <path>`, derive paired files automatically):**
```bash
node test/test_e2e_save_load.js --acl <path>             # Full save/load round-trip
node test/test_csv_vs_flightplans.js --acl <path>        # CSV ↔ ACL FlightPlans cross-check
node test/test_rebuild_sections.js --acl <path>          # _rebuildWorldStateSections E2E
```

**Timeline tests (require `--acl <path>`, auto-discover JSONs; can override with `--weather`/`--wind`/`--runway`):**
```bash
node test/test_timeline_comparison.js <acl-path>         # JSON vs ACL timeline field-by-field comparison
node test/test_generate_timelines.js --acl <path>        # generateFramesSection / generateRunwayTimelineSection
node test/test_rebuild_timelines.js --acl <path>         # _rebuildTimelineSections E2E (6 sub-tests)
```

### Building
```bash
# ALWAYS use build.js — never npm run build:win directly
# (PowerShell's watch-mode detection kills the npm script mid-way)
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

1. **No bundler, no TypeScript.** This is plain JS. Do not add `tsconfig.json`, `vite.config.js`, `webpack.config.js`, or any build tooling.
2. **No linter/formatter.** Do not add ESLint, Prettier, or any linting config unless explicitly asked.
3. **No test framework.** Tests are `node test/script.js`. Do not add Jest, Mocha, or Vitest unless asked.
4. **No npm dependencies for core logic.** The app uses only Node.js built-ins. Justify any new dependency.
5. **Preserve CommonJS.** Do not convert to ESM (`import`/`export`). The backend uses `require()`/`module.exports`.
6. **Preserve global scope for renderer.** Do not add `<script type="module">` or convert renderer files to ES modules.
7. **IPC for all file I/O.** The renderer never touches the filesystem. All reads/writes go through `main.js` handlers.
8. **Return `{ success }` from IPC.** Every handler returns `{ success: true/false, error?: string }`.
9. **`_underscore` = private.** Prefix internal functions with `_`. Export them anyway for testing.
10. **`snake_case.js` filenames.** Match the existing convention for all new source and test files.
11. **Update the facade.** New backend modules must be re-exported through `acl_parser.js`.
12. **Respect the `<script>` load order.** New renderer modules must be inserted at the correct position in `index.html`.
13. **Build with `node build.js`** on Windows, never `npm run build:win`.
14. **Keep documentation in sync.** After any significant change (new file, new module, new IPC channel, new test, dependency change, architecture change), update BOTH:
    - **This skill** (`.claude/skills/ac27-level-editor/SKILL.md`) — update the directory tree, architecture diagram, data flow, command list, or rules if the change affects them.
    - **README.md** — update the project structure tree, feature table, test list, or build instructions. The README is the human-facing summary; the skill is the agent-facing reference. Both must stay accurate.
