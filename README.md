# AC27 Level Editor

Cross-platform (Windows + macOS) GUI tool for editing **Airport Control 25** `.acl` flight schedule and level files. Built with Electron + Node.js.

## User Flow

1. **Setup** — Select game root folder (with Steam instructions)
2. **Browser** — All `.acl` files across all airports auto-scanned and displayed, grouped by airport. Hidden levels (tutorial/test/demo/bench/endless) are toggleable.
3. **Editor** — Full flight table editor + embedded timeline editors:
   - Dropdown menus per column (values auto-collected per airport: KJFK ≠ ZSJN)
   - Instant inline editing — no per-row save dialog needed
   - Auto-sort: arrivals by LandingTime, departures by OffBlockTime
   - Batch operations: add/delete/copy flights, batch callsign assignment
   - Search + arrival/departure filter via toolbar
   - **Timeline editors**: Weather presets, Wind direction/speed, Runway usage — editable in collapsible panels within the flight tab

### Save Flow
- **Save** (Ctrl+S) — triple validation (options legality → time range → runway set), then writes `.acl` + `.csv` + timeline `.json` files, creating `.bak` backups automatically. Minimal confirmation popup on success.
- **Save As** — export `.acl` + `.csv` + timeline `.json` as a ZIP bundle
- **Import** — load external `.acl` to override current level
- **CSV Export/Import** — export flights to generic CSV, or bulk-import from CSV into a `.acl` template
- **Backup/Restore** — manual backup to any location, restore latest `.bak` chain (`.acl` + `.csv` + timeline `.json`)

## Data Flow

```
Phase 0 (Setup, once):
  Game Root → scan all CSVs per airport → load audio_clips en+zh → AirportCache

Phase 1 (Load):
  .acl file → parse flights (WorldState.FlightPlans)
           → load .aclcfg config (time bounds, airport code, sceneries)
           → load timeline JSONs (weather, wind, runway)
           → collect per-airport dropdown values (ACL + CSV + audio merge)
           → appState

Phase 3 (Save):
  Edit → triple validation → .bak backup → write .acl + .csv + timeline .json
```

## ACL File Format

`.acl` files use Newtonsoft.Json serialization with `$type` and `$rcontent`. The editor uses the `WorldState.FlightPlans` format — a dictionary of keyed `FlightPlanState` entries, each containing either an `Arrival` or `Departure` leg.

Flight data fields:

| Field | Type | Description |
|-------|------|-------------|
| CallSign | string | Flight callsign (e.g. CCA0001) |
| DepartureAirport | string | ICAO departure |
| ArrivalAirport | string | ICAO arrival |
| Stand | string | Gate/stand number |
| Runway | string | Runway identifier |
| OffBlockTime | ticks/HH:MM:SS | Pushback time |
| TakeoffTime | ticks/HH:MM:SS | Takeoff time |
| LandingTime | ticks/HH:MM:SS | Landing time |
| InBlockTime | ticks/HH:MM:SS | Gate arrival time |
| AirlineName | string | Airline code |
| AircraftType | string | Aircraft model |
| Voice | string | Voice profile (from audio_clips) |
| Language | string | en / zh |

## Architecture

All renderer JS files share the global scope (plain `<script>` tags, no ES modules or bundler). The `<script>` load order in `index.html` is the definitive dependency order — each file can only reference symbols defined in files loaded before it.

### Dependency Graph

```
data-constants.js   (pure data, no dependencies)
        │
   state.js         (mutates appState, depends on data-constants.js)
        │
   ui-utils.js      (showScreen/showToast/showModal, depends on state.js)
        │
   ┌────┼────┬──────────┐
   │    │    │          │
   ▼    ▼    ▼          ▼
setup  browser   editor-   cell-     ← Screen handlers (all depend on ui-utils + state + data-constants)
-screen -screen   core     editor
                  │          │
          ┌───────┘          │
          ▼                  ▼
    flight-actions      save-actions    ← Mutate flights & save (depend on editor-core for autoSort/renderAllSections)
    import-actions                       ← depends on editor-core to reload after import
                  │
          ┌───────┘
          ▼
   timeline-editors.js     ← depends on editor-shell (updateTimelineStatus) + editor-core (renderAllSections on rwy change)
          │
          ▼
   editor-shell.js         ← Init & event wiring; depends on EVERY file above (wires onClick handlers, keyboard shortcuts)
```

**Key cross-module calls (file A calls file B):**

| Caller | Callee | Function(s) |
|--------|--------|-------------|
| `flight-actions.js` | `editor-core.js` | `autoSort()`, `renderAllSections()` |
| `save-actions.js` | `editor-core.js` | `autoSort()`, `renderAllSections()`, `appState` |
| `import-actions.js` | `editor-core.js` | `openEditor()` (re-opens after import) |
| `cell-editor.js` | `editor-core.js` | `renderAllSections()` (after inline edit) |
| `timeline-editors.js` | `editor-shell.js` | `updateTimelineStatus()` |
| `timeline-editors.js` | `editor-core.js` | `renderAllSections()` (on runway change) |
| `editor-shell.js` | `editor-core.js` | `openEditor()`, `autoSort()`, `renderAllSections()` |
| `editor-shell.js` | `setup-screen.js` | Calls `initSetupScreen()` or inline handler |
| `editor-shell.js` | `browser-screen.js` | `showBrowser()` |
| `editor-shell.js` | `flight-actions.js` | `addArrivalFlight()`, `addDepartureFlight()`, `deleteSelected()`, etc. |
| `editor-shell.js` | `save-actions.js` | `handleSave()`, `handleSaveAs()`, `handleManualBackup()` |
| `editor-shell.js` | `import-actions.js` | `handleImportAcl()`, `handleRestoreBackup()` |
| `editor-shell.js` | `timeline-editors.js` | `renderWeatherEditor()`, `renderWindEditor()`, `renderRunwayEditor()` |

### Backend Module Dependency Graph (Node.js / IPC side)

The backend modules in `src/` form a strict acyclic dependency tree. `acl_parser.js` is the **facade** — `main.js` only requires this one file, which delegates to all sub-modules.

```
constants.js  ──────────────────────────────────────────── (pure data, no deps)
     │
time_utils.js ─────────────────────────────── (tick math, depends on constants.js)
     │
     ├── csv_io.js ────────────────────────── (CSV read/write, depends on constants+time_utils)
     │
     ├── acl_scenery.js ───────────────────── (SceneryData parser, no deps)
     │
     ├── acl_world_state.js ──────────────── (WorldState type 56/54/35, depends on constants+time_utils)
     │         │
     │         ├── acl_flight_plans.js ────── (flight plans + timeline sections, depends on acl_world_state)
     │         │         │
     │         └── acl_dynamics.js ──────── (DynamicsParams builder, depends on acl_world_state)
     │                   │
     └───────┬───────────┴──────┬────────────────┐
             │                  │                │
             ▼                  ▼                ▼
    acl_utils.js ─────────────────────────────── (enrich, sort, scan, audio — depends on all parsers + csv_io)
             │
             ▼
    acl_parser.js ────────────────────────────── (FACADE: loadFlights, generateFullAcl, generateAclFromCsv)
             │
             ▼
         main.js ─────────────────────────────── (Electron main process, IPC handlers)
```

**Key cross-module calls (backend):**

| Caller | Callee | Function(s) |
|--------|--------|-------------|
| `acl_parser.js` | `acl_scenery.js` | `_parseSceneryData()` |
| `acl_parser.js` | `acl_world_state.js` | `_parseWorldStateData()`, `_extractFlightsFromWorldState()` |
| `acl_parser.js` | `acl_flight_plans.js` | `_parseWorldStateFlightPlans()`, `_rebuildWorldStateSections()` |
| `acl_parser.js` | `acl_utils.js` | `_enrichFlightsFromSource()`, all public utils |
| `acl_flight_plans.js` | `acl_world_state.js` | `_applyWsField()`, `_generateGuid()` |
| `acl_dynamics.js` | `acl_world_state.js` | `_generateGuid()` |
| `acl_utils.js` | `acl_world_state.js` | `_parseWorldStateData()`, `_extractFlightsFromWorldState()` |
| `acl_utils.js` | `acl_flight_plans.js` | `_parseWorldStateFlightPlans()` |
| `main.js` | `acl_parser.js` | `loadFlights()`, `generateFullAcl()`, `generateAclFromCsv()`, `collectUniqueValues()`, etc. |

**Note on export convention:** Underscore-prefixed exports (`_parse...`, `_apply...`, `_rebuild...`) are internal functions exposed only for testing and cross-module use within the backend. Public API functions have no underscore prefix.

### ACL Parsing Flow

When loading a `.acl` file, the parser detects the file format and dispatches accordingly:

```
loadFlights(aclPath)
  ├── _parseSceneryData(text)           → extracts Runway and Stand GUID maps
  ├── _parseWorldStateFlightPlans(text) → parse FlightPlans format (type 37 in WorldState.FlightPlans)
  │   └── IF found: enrich CSV flights from FlightPlans data ✓
  │
  └── IF no FlightPlans found:
      └── _parseWorldStateData(text)    → extract TaskFlightState entries
          └── _extractFlightsFromWorldState() → convert WS entries to flight objects
```

When saving, `_rebuildWorldStateSections()` rebuilds FlightPlans entries from scratch.

## Project Structure

```
├── main.js              # Electron main process + all IPC handlers
├── preload.js           # Secure contextBridge IPC layer (exposes ipcApi to renderer)
├── build.js             # Electron-builder build script
├── package.json
├── src/
│   │
│   │ ── Backend: ACL parsing & CSV I/O (Node.js, no DOM) ──
│   │
│   ├── constants.js          # Shared constants: field definitions, tick constants, aircraft designator map
│   │   Depends on: nothing (pure data)
│   │   Exports: FIELDS, FIELD_LABELS, DROPDOWN_FIELDS, TICKS_PER_DAY, FALLBACK_BASE_DATE_TICKS, AIRCRAFT_DESIGNATOR_MAP
│   │
│   ├── time_utils.js         # Newtonsoft.Json DateTime ticks ↔ HH:MM:SS conversion, base-date extraction
│   │   Depends on: constants.js
│   │   Exports: ticksToTime(), timeToTicks(), ticksToString(), _guessDesignator(), _extractBaseDateTicks(), _extractBaseDateFromText()
│   │
│   ├── csv_io.js             # CSV import/export: game-compatible 16-column format, value scanning
│   │   Depends on: constants.js, time_utils.js
│   │   Exports: importCsvFromFile(), exportCSV(), exportGameCSV(), collectUniqueValuesFromCSV()
│   │
│   ├── acl_scenery.js        # SceneryData parser: extracts Runway Name↔GUID and Stand Identifier↔GUID maps
│   │   Depends on: nothing (pure text parsing, no imports)
│   │   Exports: _parseSceneryData()
│   │
│   ├── acl_world_state.js    # WorldState parser: TaskFlightState (type 56/54), AircraftState (type 35)
│   │   Depends on: constants.js, time_utils.js
│   │   Exports: _generateGuid(), _parseWorldStateData(), _extractFlightsFromWorldState(), _applyWsField()
│   │
│   ├── acl_flight_plans.js   # FlightPlans parser + rebuild: type 37/52/57/58, timeline sections (Weather/Wind/Runway)
│   │   Depends on: constants.js, time_utils.js, acl_world_state.js (_applyWsField, _generateGuid)
│   │   Exports: _parseWorldStateFlightPlans(), _parseFlightPlanEntry(),
│   │            _buildFlightPlanArrivalLeg(), _buildFlightPlanDepartureLeg(),
│   │            _rebuildWorldStateSections(), _rebuildTimelineSections(),
│   │            generateFramesSection(), generateRunwayTimelineSection()
│   │   Note: timeline sections rebuild WeatherFrames/WindFrames/RunwayTimeline in-place,
│   │         preserving $id and $type references
│   │
│   ├── acl_dynamics.js       # DynamicsParams builder: captures AircraftState templates, creates runtime entries
│   │   Depends on: acl_world_state.js (_generateGuid)
│   │   Exports: calcProgressRatio(), captureAllDynamicsTemplates(), buildAircraftEntry(),
│   │            _parseFlightPlanArrivalData(), _parseAircraftsEntries()
│   │
│   ├── acl_utils.js          # Utility functions: CSV↔ACL enrichment, chronological sort, dropdown scanning, audio callsign loading
│   │   Depends on: constants.js, acl_scenery.js, acl_world_state.js, acl_flight_plans.js
│   │   Exports: _enrichFlightsFromSource(), sortFlightsChronologically(), collectUniqueValues(),
│   │            getFileInfo(), loadAudioCallsigns(), mergeAudioCallsigns()
│   │
│   ├── acl_parser.js         # FACADE — public API: load/save/generate ACL, re-exports all sub-module exports
│   │   Depends on: ALL modules above
│   │   Exports: loadFlights(), generateFullAcl(), generateAclFromCsv(),
│   │            + re-exports from csv_io, acl_utils, and internal _parse* functions (used by tests)
│   │
│   ├── acl_scanner.js        # Game root scanner: discovers all airports and their .acl/csv files
│   │   Depends on: fs, path only
│   │   Exports: scanGameRoot(), getAllAirportsFromPlaytest()
│   │
│   ├── zip_utils.js           # Minimal ZIP create/extract using Node.js built-ins (zlib + CRC32)
│   │   Depends on: fs, path, zlib only
│   │   Exports: createZip(), extractZip()
│   │
│   ├── index.html            # 3-screen SPA shell (Setup / Browser / Editor), loads all JS in dependency order
│   ├── style.css             # Dark theme styles
│   ├── logger.js             # File-based logging (dev mode)
│   │
│   └── renderer/             # 12-module UI logic (refactored from single 2137-line renderer.js)
│       │
│       │ ── Foundation (loaded first, no renderer dependencies) ──
│       ├── data-constants.js
│       │   Exports: AIRPORT_META, AIRLINE_CODE_MAP, ALL_FIELDS, FIELD_LABELS, TIME_FIELDS,
│       │            DROPDOWN_FIELDS, COL_CLASSES, ARRIVAL_FIELDS, DEPARTURE_FIELDS
│       │   Helpers: getAirlineCode(), airportDisplayName(), airportSortOrder()
│       │   Depends on: nothing (pure data + pure functions)
│       │
│       ├── state.js
│       │   Exports: appState{} (the single global state object), nextFlightNumber,
│       │            initFlightNumberCounter()
│       │   Depends on: data-constants.js
│       │
│       ├── ui-utils.js
│       │   Exports: showScreen(name), showToast(msg, type), showModal(title, bodyHtml, actionsHtml),
│       │            hideModal(), showAlert(title, msg), escapeHtml(str), stripSuffixes(name)
│       │   Depends on: state.js (reads/writes appState.screen)
│       │
│       │ ── Screen controllers (each handles one screen's rendering + events) ──
│       ├── setup-screen.js
│       │   Depends on: ui-utils.js, state.js
│       │   Renders: Screen 0 — game root folder picker with Steam path instructions
│       │
│       ├── browser-screen.js
│       │   Exports: showBrowser() — rescans .acl files, renders grouped card UI
│       │   Depends on: ui-utils.js, state.js, data-constants.js
│       │   Renders: Screen 1 — level cards grouped by airport, tag pills, hidden-toggle
│       │
│       ├── editor-core.js
│       │   Exports: openEditor(filePath, airportIcao), autoSort(), populateConfigBar(),
│       │            getActiveColumns(), buildSectionTable(), renderAllSections(), autoFillSingleOptionColumns()
│       │   Depends on: ui-utils.js, state.js, data-constants.js
│       │   Renders: Screen 2 — config bar, arrivals/departures table sections
│       │
│       │ ── Interaction modules (tightly coupled to editor-core's DOM) ──
│       ├── cell-editor.js
│       │   Exports: startCellEdit(td, col, idx), moveToNextCell(), openTimeClockPopover()
│       │   Depends on: ui-utils.js, state.js, data-constants.js, editor-core.js
│       │
│       ├── flight-actions.js
│       │   Exports: addArrivalFlight(), addDepartureFlight(), deleteSelected(), deleteAll(), copyHighlighted()
│       │   Depends on: ui-utils.js, state.js, editor-core.js
│       │
│       ├── save-actions.js
│       │   Exports: handleSave(), handleSaveAs(), handleManualBackup(), runTripleValidation(), doSaveAcl(), validateCallsigns()
│       │   Depends on: ui-utils.js, state.js, editor-core.js
│       │
│       ├── import-actions.js
│       │   Exports: handleImportAcl(), handleRestoreBackup()
│       │   Depends on: ui-utils.js, state.js, editor-core.js
│       │
│       ├── timeline-editors.js
│       │   Exports: renderWeatherEditor(), renderWindEditor(), renderRunwayEditor(), WEATHER_PRESETS
│       │   Depends on: ui-utils.js, state.js, editor-shell.js
│       │
│       └── editor-shell.js
│           Exports: updateTimelineStatus(), updateStatusBar(), getLastRootLocal(), saveLastRootLocal()
│           Depends on: ALL previous renderer modules
│           Wires: toolbar buttons, search, keyboard shortcuts → delegates to action modules
├── test/
│   ├── parse_airport.js           # Smoke test: parse all airports, validate field coverage
│   ├── callsign_gen_test.js       # Verify CallSign prefixes match airline ICAO codes
│   ├── csv_vs_flightplans.js      # Cross-check CSV imports against ACL FlightPlans entries
│   ├── e2e_save_load.js           # End-to-end round-trip: load → save → load → compare
│   ├── timeline_comparison.js     # Compare JSON timeline files against ACL-embedded data
│   ├── test_generate_timelines.js # Unit: generateFramesSection / generateRunwayTimelineSection ↔ existing ACL
│   ├── test_rebuild_sections.js   # E2E: _rebuildWorldStateSections (FlightPlans/Aircrafts rebuild)
│   └── test_rebuild_timelines.js  # E2E: _rebuildTimelineSections (Weather/Wind/Runway in-place patch)
└── dist/                # Build output (AC27 Level Editor.exe)
```

## Development

```bash
npm install
npm start
```

## Tests

```bash
node test/parse_airport.js              # Parse all airports, check field coverage
node test/callsign_gen_test.js          # Validate CallSign → ICAO consistency
node test/csv_vs_flightplans.js         # CSV ↔ ACL FlightPlans cross-check
node test/e2e_save_load.js              # Full save/load round-trip test
node test/timeline_comparison.js <acl>  # Compare ACL timelines vs JSON files
node test/test_generate_timelines.js    # Verify JSON→ACL timeline section generators
node test/test_rebuild_sections.js      # E2E: FlightPlans/Aircrafts section rebuild
node test/test_rebuild_timelines.js     # E2E: Weather/Wind/Runway section rebuild
```

## Build

### Prerequisites (Windows — first time only)

The `winCodeSign` cache contains broken macOS symlinks (`libcrypto.dylib` / `libssl.dylib` are 0 bytes).
Run this once after the first build attempt fails:

```powershell
$libDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\darwin\10.12\lib"
Copy-Item "$libDir\libcrypto.1.0.0.dylib" "$libDir\libcrypto.dylib" -Force
Copy-Item "$libDir\libssl.1.0.0.dylib" "$libDir\libssl.dylib" -Force
```

### Build (Windows portable)

**Always use `build.js`**, never `npm run build:win` — the latter gets killed mid-way by PowerShell's watch-mode detection.

1. Close any running instance of the editor:
   ```powershell
   Stop-Process -Name "AC27 Level Editor" -Force -ErrorAction SilentlyContinue
   ```

2. Clean `dist/`:
   ```powershell
   Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
   ```

3. Run the build:
   ```bash
   node build.js
   ```

Output: `dist\AC27 Level Editor.exe` (~180 MB portable executable).

If the build fails with file-locking errors, try disabling real-time antivirus or reboot before building.

### Icon notes

- Edit `icon.png` (512×512 PNG), then regenerate `icon.ico`:
  ```bash
  node -e "const p=require('png-to-ico').default;require('fs').writeFileSync('icon.ico',await p('icon.png',[256,128,64,48,32,16]))"
  ```
