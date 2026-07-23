# AC27 Data Flow & Cache System

## Table of Contents

- [AC27 Data Flow \& Cache System](#ac27-data-flow--cache-system)
  - [Table of Contents](#table-of-contents)
  - [Data Flow Overview](#data-flow-overview)
  - [Phase 0: Airport Cache Init (once per game root)](#phase-0-airport-cache-init-once-per-game-root)
  - [Phase 1: Load Level](#phase-1-load-level)
  - [Phase 2: Edit (all in zustand store)](#phase-2-edit-all-in-zustand-store)
  - [Phase 3: Save](#phase-3-save)
  - [Cache State \& Version Detection (v1.1.0)](#cache-state--version-detection-v110)
  - [Toolbar Backup Button](#toolbar-backup-button)
  - [Save As ZIP](#save-as-zip)
  - [Import ZIP](#import-zip)
  - [Stand Conflict Detection (v1.1.0)](#stand-conflict-detection-v110)
  - [Duplicate Registration Detection (v1.1.2)](#duplicate-registration-detection-v112)
  - [Stand Map Overlay](#stand-map-overlay)
  - [Star Map Overlay](#star-map-overlay)
  - [Demo .acl File Handling (v1.0.9+)](#demo-acl-file-handling-v109)

## Data Flow Overview

```
Phase 0: Cache Init → Phase 1: Load → Phase 2: Edit → Phase 3: Save
```

## Phase 0: Airport Cache Init (once per game root)

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

## Phase 1: Load Level

1. User clicks a level row → `window._pendingEditor = { filePath, airportIcao }` → `setScreen('editor')`
2. EditorScreen's `useEffect` reads `window._pendingEditor` and loads:
   - `load-acl` IPC → reads `.acl` → parses FlightPlans as primary flight data
   - `load-timelines` IPC → reads timelines from ACL + `windSpeedUnit` from `airport_config.json` (defaults to `'knots'`)
   - `collect-values` IPC → reads dropdown values from airport cache (no file I/O). Also returns `_taxiwayPaths`, `_runwayData`, `_sidPaths`, `_missedAppPaths`, `_sidRunwayMap`, `_runwaySidMap` for map window rendering.
   - `load-audio-callsigns` IPC → reads audio callsigns from airport cache (no file I/O)
3. **Wind speed conversion:** If `windSpeedUnit` is `'mps'`, speeds are converted to knots on load (1 m/s = 1.94384 kt). The zustand store always holds knots. Stored in `_windSpeedUnit`.
4. Zustand store is populated and React renders the flight table

## Phase 2: Edit (all in zustand store)

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

## Phase 3: Save

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
   - **Multi-stage cleanup (steps 7a-7d) across ALL segments (header + frames):**
     - **$fstrref cleanup & remapping:** Scans for `$fstrref:"flight-plan:REG"` -- replaces stale refs with `null`, remaps renamed registrations (detected by matching old CallSign to new flight CallSign).
     - **Pre-expand short-form $type refs:** Expands bare `$type: N` to fully-qualified before removal steps, using per-segment type maps to prevent orphaned type-number refs.
     - **Reset jetway docking state (`_resetFrameJetwayDockingState`):** Resets `Status->0`, `Progress->0`, `DockingAircraft->null`, `DockingDoorIndex->-1` on jetway entries with stale `$fstrref` refs. Uses tokenizer-based structural parsing (no longer regex). Applied to ALL segments including header, not just checkpoint frames.
     - **Remove orphaned RuntimeEntities (`_removeOrphanedFlightEntities`):** Removes or renames `$k` entries (`flight-plan:REG`, `aircraft:REG`, `aircraft-animator:aircraft:REG`) whose registration no longer exists in rebuilt StaticItems. Handles rename via `renameMap` and falls back to `StaticItem.$fstrref` for corrupted saves.
     - **Cleanup EventLog LatestEvents (`_cleanupEventLogLatestEvents`):** Removes stale `aircraft:REG` keys from the nested `singleton:event-log.$v.LatestEvents.$rcontent` dictionary -- invisible to step 7c due to its nesting depth.
   - Writes `.acl` + `.csv`
   - **Demo-window files treated identically** — all files in `DEMO_VISIBLE_BASES` (including `_emerg`) write to their `.acl`/`.demo.acl` + shared `.csv` + shared timeline `.json` files with the same 30-minute window logic via `_isDemoFile()`
4. Timeline saves (separate IPC per type) → writes JSON files
5. Backup: `.bak` copies created before overwrite (optional, checkbox in save dialog). For `.demo.acl` files, creates `.demo.acl.bak`

## Cache State & Version Detection (v1.1.0)

The app uses a unified **`cache.json`** in `userData` (replaces `approachCache.json` + `lastRoot.json` + `localStorage.ac27_lang`). It contains `gameRoot`, `lang`, `cacheVersion`, `builtAt`, and `airports`.

Cache validity is determined by a standalone **`CACHE_VERSION`** constant (integer, hand-bumped in `src/utils/constants.js`), NOT by `app.getVersion()`. This decouples cache invalidation from app updates.

**⚠️ CACHE_VERSION rule:** Any change to the shape of `cache.json` (new fields in the approach cache object, new top-level keys, changed structure of `approachData`, `saveTimeOffsets`, `fileTypeMaps`, etc.) MUST bump `CACHE_VERSION` in `src/utils/constants.js:13`. Without this, users with stale caches will not be prompted to re-scan, and old cache data will silently corrupt saves. Examples of changes requiring a bump: adding `saveTimeOffsets` to `approachData`, adding `state5ParamsMap`, changing `fileTypeMaps` from per-airport to per-file, adding `.bak` files to the scan set, adding `taxiwayPaths`/`sidPaths`/`missedAppPaths` to `approachData`. Current `CACHE_VERSION` is 12.

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

## Toolbar Backup Button

- **Backup button** (toolbar, `handleBackup`): directly copies current `.acl` → `.acl.bak` in the same directory (no file picker dialog)
- If a `.bak` file already exists, a confirmation modal appears before overwriting
- Uses `check-backup-exists` IPC to detect existing `.bak`, then `manual-backup` IPC to copy

## Save As ZIP

- Saves silently → packages 5 files into ZIP → native save dialog
- ZIP contents: `.acl` + `.csv` + `weather_timeline.json` + `wind_timeline.json` + `runway_timeline_*.json`
- Works identically for `.demo.acl` files (packs `.demo.acl` + shared `.csv` + shared timelines)

## Import ZIP

- Native open dialog → validates ZIP structure → backs up current files → extracts → reloads
- Works identically for `.demo.acl` files

## Stand Conflict Detection (v1.1.0)

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

## Duplicate Registration Detection (v1.1.2)

`detectDuplicateRegistrations()` in `src/utils/validators.js` catches the same Aircraft Registration appearing in multiple flights of the same type:

| Scope | Rule |
|---|---|
| **dep + dep** | Same Reg in two departure flights → error |
| **arr + arr** | Same Reg in two arrival flights → error |
| **dep + arr** | Allowed — same aircraft can depart and arrive (turnaround) |

- Flight type is determined by `isDeparture` flag or presence of `LandingTime` vs `OffBlockTime`
- i18n keys: `val_duplicate_registration_dep`, `val_duplicate_registration_arr`

## Stand Map Overlay

When editing a Stand cell in the flight table, a non-blocking overlay panel appears pinned to the right edge of the app window. It shows:

- **SVG map** of all stands for the current airport, with dots positioned by real x,y coordinates parsed from `SceneryData > TaxiwayNodes`
- **4 dot states**: Current (accent, large + ring), Hovered (accent, medium), Available (accent, small), Occupied (grey, not clickable)
- **Occupancy detection**: `computeOccupiedStands()` in FlightTable checks time-window overlaps between flights
- **Airport background**: Dark radar-style fill (`#0a1628`) with programmatic SVG: taxiway centerlines, runway rectangles, area polygons (boundary/apron/building) at 0.2 opacity — same data as GroundMapWindow (`_taxiwayPaths`, `_runwayData`, `_areaData` from `collect-values`)
- **Dark mode**: Map content area forces dark mode CSS variables regardless of app theme
- **i18n**: Title and legend use `standmap_title`, `standmap_current`, `standmap_available`, `standmap_occupied` keys

**Component:** `src/components/EditorScreen/StandMap/StandMap.jsx` — portal-based, responsive (scales with window via `useWindowSize` hook), viewBox preserves data aspect ratio with a target ratio cap. Uses the shared `useDrag` hook for header-drag repositioning. Receives `taxiwayPaths`, `runwayData`, `areaData` from EditorScreen (already in store from `collect-values`).

## Star Map Overlay

When editing an Airway cell in the flight table, a non-blocking overlay panel shows the STAR/approach chart for the current airport. It displays:

- **SVG map** of all STAR waypoint paths for the airport, plotted from real x,z coordinates in SceneryData `AirwayNodes`
- **Runway thresholds** rendered as extended lines (3× runway length), parsed from `SceneryData.Runways.ThresholdPointGuids` via `_parseRunwayThresholds()`
- **Live aircraft positions** on approach — arrival flights' positions computed via `get-aircraft-positions` IPC using the same `computePosition()` algorithm as State=30/State=5 save generation
- **Aircraft interactivity**: Hovering an aircraft dot shows callsign + STAR + runway + ETA
- **Click to select** a STAR path, which updates the flight's Airway field via `updateFlight(idx, { Airway: starName })`
- **Departure flights**: Show a notice that the STAR map is unavailable (no approach data for departures)
- **Airport background**: `{ICAO}.png` (e.g. `ZSJN.png`) positioned via `AIR_MAP_BG_OFFSETS` — same algorithm as AirMapWindow (image fills viewBox, per-airport dx/dy/w offsets, `bgUnder` rect behind it, 0.2 opacity, `preserveAspectRatio="xMidYMid slice"`)
- **Dark mode**: Map content area forces dark mode CSS variables regardless of app theme
- **i18n**: Title and legend use `starmap_title`, `starmap_current`, `starmap_available`, `starmap_disabled`, `starmap_no_data` keys

**Component:** `src/components/EditorScreen/StarMap/StarMap.jsx` — portal-based, draggable via `useDrag` hook, responsive viewBox scaling. Path colors cycle through a preset palette per STAR name. Runway thresholds rendered as thin colored lines matching their associated STAR paths.

**Map overlay orchestration:** `MapOverlays` sub-component in `EditorScreen.jsx` manages visibility and prop-passing for both StandMap and StarMap. Visibility state lives in zustand (`showStandMap`, `showStarMap`, `activeMap`, `mapFlightIdx`). Only one map is "on top" at a time (controlled by `activeMap`). Both maps close when leaving the editor screen (`setScreen` clears map state).

## Demo .acl File Handling (v1.0.9+)

The game ships six files that receive the 30-minute demo window treatment (all controlled by `DEMO_VISIBLE_BASES` in `src/utils/constants.js`):
- `ZSJN-Morning_120min.demo.acl` (05:45–06:15)
- `ZSJN_17-19_emerg.acl` — emergency scenario (also gets 30-min window)
- `KJFK_07-09_emerg.acl` — emergency scenario (also gets 30-min window)
- `KJFK_20-22.demo.acl` (20:30–21:00)

**Key properties:**
- Each `.demo.acl` is a save-state snapshot with the **same BaseTime** as its parent but a **later CurrentDateTime** (~40–55 min offset), creating the 30-min playable window
- FlightPlans, scenery, and file references are identical to the parent `.acl`
- No matching `.aclcfg` exists — Config is read from the `.acl` file itself

**Demo mode visibility & window:** The `DEMO_VISIBLE_BASES` Set in `src/utils/constants.js` is the single source of truth — it controls both which files are visible in demo mode AND which files get the 30-minute demo window. Entries are full filenames (e.g. `ZSJN_07-10.demo.acl`). `_isDemoFile()` in `electron/main.js` checks exact filename via `path.basename()` against this set (NOT the `.demo.acl` extension). Update `DEMO_VISIBLE_BASES` when demo levels are added or removed.

**Editor behavior:**
- Demo files are treated as **normal levels** — always visible, no tags, no hiding
- **Demo mode** (root path contains "Airport Control 27 Demo"): only files listed in `DEMO_VISIBLE_BASES` are shown
- **On load:** flights in demo files are filtered to a 30-minute window starting at `CurrentDateTime` via `_filterDemoFlights()` — centralized helper shared across load, save, import, and restore paths. Uses integer-minute bounds: `[cdtMin, cdtMaxMin)` where `cdtMaxMin = _roundNearest5(cdtMin + 30)` — the end time is rounded to the nearest 5-minute boundary (:X0 or :X5). Config's `startTime`/`endTime` are overridden to match. Start time is NOT rounded.
- **On save:** demo files write to `.demo.acl` + shared `.csv` + shared timeline `.json` files; creates `.demo.acl.bak`. End time is rounded to nearest :X0/:X5 (same as load).
- **Export/Import:** packs/unpacks `.demo.acl` identically to normal `.acl` files
- **Approach cache:** includes demo files (unfiltered)
- **Challenge Level display:** Files with `_emerg` in their name show "Challenge Level" / "挑战关卡" (localized) as their time-of-day label (replacing dawn/morning/dusk/etc.), in both demo and non-demo mode. The `isEmer` flag is exposed via `get-airport-files-info` IPC and checked in `BrowserScreen`.
