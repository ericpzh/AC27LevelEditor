# AC27 Data Flow & Cache System

## Table of Contents

- [AC27 Data Flow \& Cache System](#ac27-data-flow--cache-system)
  - [Table of Contents](#table-of-contents)
  - [Data Flow Overview](#data-flow-overview)
  - [Phase 0: Airport Cache Init (once per game root)](#phase-0-airport-cache-init-once-per-game-root)
  - [Phase 1: Load Level](#phase-1-load-level)
  - [Phase 2: Edit (all in zustand store)](#phase-2-edit-all-in-zustand-store)
  - [Phase 3: Save](#phase-3-save)
  - [Cache State \& Version Detection](#cache-state--version-detection)
  - [Toolbar Backup Button](#toolbar-backup-button)
  - [Save As ZIP](#save-as-zip)
  - [Import ZIP](#import-zip)
  - [Stand Conflict Detection](#stand-conflict-detection)
  - [Duplicate Registration Detection](#duplicate-registration-detection)
  - [Stand Map Overlay](#stand-map-overlay)
  - [Star Map Overlay](#star-map-overlay)
  - [Level Whitelists \& Demo .acl File Handling](#level-whitelists--demo-acl-file-handling)

## Data Flow Overview

```
Phase 0: Cache Init → Phase 1: Load → Phase 2: Edit → Phase 3: Save
```

## Phase 0: Airport Cache Init (once per game root)

1. User selects game root directory
2. `scan-acls` IPC → `scanGameRoot()` → returns airport list with `.acl` file paths
3. `init-airport-cache` IPC → loads audio clips + pre-scans approach data + dropdown values per airport:
   - Scans `.acl` files matching the browser's visibility filter — **excludes** `.acl.bak` backups and all variants hidden by its local `RE_SKIP` regex (`tutorial`, `bench`, `test`, `crossrunway`, `dev`, `endless`, `.prod`). Demo slices (`.demo.acl`) and `_emerg` files are still included. (Note: the browser visibility filter itself now uses explicit whitelists — `PROD_VISIBLE_BASES` / `DEMO_VISIBLE_BASES` in `src/utils/constants/ui.js` — not a blacklist regex.)
   - **Global progress reporting:** Pre-counts total `.acl` files across ALL airports, then sends `cache-build-progress` IPC events (`{ current, total }`) per file during `buildApproachCache`. Renderer shows a progress bar + percentage via `CacheProgressBody` component.
   - Extracts `specDB` (Designator → AircraftSpec, from ALL aircraft entries regardless of State), `appPointMap` ((STAR,Runway) → AppPointList, from PKStaticEntities runway Routes RouteType=1), `totalApproachTimes` (STAR → seconds, from route path lengths with aircraft-derived calibration), and `designatorMap` (AircraftType → Designator)
   - Extracts State=5 data: `state5ParamsMap` (runway → `{pathPointList, touchDownPosition, approachDirection, initialPosition, routeName?}`), `starPaths` (STAR → waypoint array), and STAR↔runway maps from PKStaticEntities `runway:*` entries' `Routes` (RouteType=0)
   - Extracts `runwayThresholds` (PhysicalName → threshold pair, from runway `ThresholdPoints` `$iref`s → taxiway-node positions) for StarMap/MapWindow visualization
   - Extracts `taxiwayPaths` (taxiway centerline polylines from PKStaticEntities `taxiway-segment:*` entries via `taxiway.js`) — **merged from ALL `.acl` files** with coordinate-based dedup (`toFixed(2)` precision), not just the first file. This ensures complete taxiway coverage even when some ACL files have missing segments (e.g. `ZSJN-17_19.acl` missing 2 taxiway A/B segments between E and N). Used by GroundMapWindow.
   - Extracts SID data: `sidPaths` (departure route polylines from PKStaticEntities runway `Routes`, RouteType=2), `sidRunwayMap` (SID→[runways]), `runwaySidMap` (runway→[SIDs]) — parsed by `sid_goaround.js`
   - Extracts Missed Approach data: `missedAppPaths` (go-around route polylines from PKStaticEntities runway `Routes`, RouteType=3), `missedAppMap` (MA name→runway), `runwayMissedAppMap` (runway→MA names) — parsed by `sid_goaround.js`
   - Collects dropdown values (`collectUniqueValues`) and runway pairs (`extractV4RunwayPairs` on the first .acl — reciprocal pairs grouped by `PhysicalName` in PKStaticEntities)
   - Merges audio flight numbers into `_flightNums` per airline code
   - **Stand dropdown from PKStaticEntities:** Stand identifiers parsed by `_parseStandPositions()` (stand `TailPosition`/`NosePosition` `$iref`s) become the authoritative dropdown options (sorted), replacing any hardcoded or ACL-derived stand lists
   - **STAR dropdown from PKStaticEntities:** STAR names come from `starRunwayMap` keys (runway `Routes` with RouteType=0), same pattern as Stand — static scenery is the single source of truth. `starRunwayMap` is built by `extractStarRunwayMappings()` and already excludes stubs (`$rlength:0`)
   - Caches in memory as `airportCache[icao] = { audioCallsigns, approachData, dropdownValues, runwayPairs, standPositions, areaData }`
   - `approachData` now includes: `taxiwayPaths`, `sidPaths`, `missedAppPaths`, `apprPaths`, `sidRunwayMap`, `runwaySidMap`, `missedAppMap`, `runwayMissedAppMap`, `apprRunwayMap`, `runwayApprMap` (all serialized through `serializeApproachCache`/`deserializeApproachCache`)
   - `standPositions` parsed from first .acl via `_parseStandPositions()` — maps stand identifier → `{x, y}` (midpoint) plus `tailX`/`tailZ`/`noseX`/`noseZ` for heading/orientation
       - `areaData` parsed from first .acl via `_parseAreas()` — maps AreaType (0=boundary, 1=stand/apron, 2=building) → `[{guid, enabled, points[{x,z}]}]` — used by GroundMapWindow
   - Persisted to disk (`cache.json` in userData, unified with `gameRoot`, `lang`, `cacheVersion`) — no TTL, refreshed via `refresh-root-scan`
   - **Centralized cache I/O:** `_readCache(opts)` and `_writeCache(data)` in `electron/main.js` handle all `cache.json` reads/writes. `_readCache` validates `cacheVersion` and `gameRoot`. All IPC handlers MUST use these helpers — never read/write `cache.json` directly.

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

**Clock time validation:** When committing a time value via the clock popover, `EditableCell` (FlightTable) and `TimeCell` (timeline editors) validate against field-specific bounds before accepting the value. Out-of-bounds values show a toast and are rejected.

- `getTimeValidationBounds(col, _saveSec, _configStartTime, _configEndTime)` in `src/utils/timeUtils.js` returns `{minTime, maxTime}` or `null`:
  - **OffBlockTime / LandingTime**: bounded by `[_configStartTime, _configEndTime + 30 min]` — max is `configEndTime + SCENARIO_END_GRACE_MIN` (the game allows events up to 30 min past scenario end); the min stays `_configStartTime`
  - **InBlockTime / TakeoffTime**: no bounds validation (save only checks ordering/sequence against sibling fields)
  - **Timeline / generic Time**: bounded by `[_configStartTime, _configEndTime]` — must be strictly within the level range (no grace; matches runway-timeline validation)
- Toast i18n key: `clock_time_out_of_bounds` — `"Time must be between {{min}} and {{max}}"`
- Timeline editors (`WeatherEditor`, `WindEditor`, `RunwayEditor`) pass `minTime`/`maxTime` from `_configStartTime`/`_configEndTime` via `getTimelineActiveRange`

## Phase 3: Save

1. `handleSave()` → `validateCallsigns()` → `runTripleValidation()`:
   - (a) Dropdown value validation — every field against valid options
   - (b) Time range validation — flights within config startTime / endTime+30min bounds (`SCENARIO_END_GRACE_MIN`)
   - (c) Runway timeline bounds — change entry times within level range
   - (d) STAR/runway combination validation — flags flights where the assigned STAR is not valid for the assigned runway (per PKStaticEntities runway `Routes` RouteType=0 via `starRunwayMap`)
   - (e) Duplicate registration validation — flags flights where the same Registration appears in multiple departure or arrival flights (see below)
2. **Wind speed conversion:** Wind speeds are converted from knots (store) back to the airport's native unit (e.g., mps) before being sent to IPC handlers. This ensures `wind_timeline.json` and the ACL both contain values in the unit the game expects.
3. Pre-validation: `_validateStandConflicts(flights)` checks stand occupancy (consecutive ARR→DEP pairs must share the same registration — different aircraft cannot occupy the same stand simultaneously). Throws on conflict before any file modifications begin.
4. `save-acl` IPC → sorts flights → looks up approach cache for the airport → generates full ACL via `_rebuildStaticDataSections()`:
   - **Flight-plan + aircraft RuntimeEntities rebuilt from editor state** (7b-3 below); `StaticItems` flight-plan entries remain the editor's source data
   - **Aircraft entries generated for arrivals and departures** (7b-3): `aircraft:REG` entries for arrivals mid-approach at snapshot time (`0 < ProgressRatio < 1.0`) built by `_buildStandaloneAircraftEntry` using the approach.js verified algorithm: AppPointList lookup, FlyApproach resolution from PKStaticEntities, PR formula, Position/Direction interpolation. Departures also get aircraft entries (jetway-mapped DEPs `$iref` into the jetway's inline `DockingAircraft`).
   - **State=5 (final approach) requires cached state5ParamsMap:** `_buildStandaloneAircraftEntry` throws if `state5ParamsMap` has no entry for the runway. `routeName` is sourced from the cached params (populated during cache build from the approach procedure's `Name` field). `totalLen` includes touchdown distance so the IAF boundary matches TAT's calibrated path length.
   - **Short-form `$type` pre-expansion (7a-2 / 7b-2):** `_expandShortFormTypes()` expands bare `$type: N` references to full-form using per-segment type maps (via `_expandWithBlobdocScopes` + `_replaceBareTypeRefs`) so cleanup steps can never orphan type declarations; re-run on segments modified by the jetway rebuild.
   - **Multi-stage cleanup (steps 7a-2 through 7a) across ALL segments (header + frames),** with pre-validation, per-segment type maps, and `_IdMapper` instances for centralized `$iref` remapping. `_validateStandConflicts()` checks stand occupancy (consecutive ARR→DEP pairs must have matching registrations) before modifications begin. Execution order is critical — 7b runs before 7a so jetway detection sees intact `$fstrref` values:
     - **7a-2. Pre-expand short-form $type refs:** Expands bare `$type: N` to fully-qualified before removal steps, using per-segment type maps to prevent orphaned type-number refs. Re-runs after jetway rebuild (7b-2) for segments modified by constructive template insertion.
     - **7b-1. Constructive jetway rebuild (`_rebuildJetwayEntries` + `_buildActiveJetwayEntry`):** Replaces regex-based `_resetFrameJetwayDockingState` with two-pass constructive template generation. Includes turnaround detection (when same aircraft's ARR lands before DEP off-blocks → jetway empty) and earliest-OffBlockTime tie-breaking for multiple DEPs on the same stand. DEP flights at matching stands get a ~35-field Aircraft structure inside DockingAircraft; stale entries get a clean cleared-state template. Claims shared canonical empty-array `$id`s — six `RunwayCoordinator` `string[]` fields, `AircraftEvent[]`, `ECommand[]` — from a per-segment dynamic allocator (shared with 7b-3 via `strArrCache`/`recvEventsCache`/`waitingCmdsCache`): first emitter defines inline, later entries `$iref`. Ids never come from entryId+offset ranges because adjacent jetway ranges overlap (entryIds 8 apart, offsets up to 38), and a duplicate `$id` that is an `$iref` target crashes the game's JsonDataReader.
     - **7b-3. Rebuild flight-plan, aircraft, and animator RuntimeEntities (`_rebuildFlightRuntimeEntities`):** Deletes ALL existing `flight-plan:REG`, `aircraft:REG`, and `aircraft-animator:aircraft:REG` entries and rebuilds from editor state in 4 passes. Pass 2 rebuilds `flight-plan:REG` with time fields from `_computeTakeoffTicks`/`_computeArrivalInBlockTicks`. Pass 3 builds `aircraft:REG` for ARR and DEP flights via `_buildStandaloneAircraftEntry` (ARR: position/direction from approach path; DEP parked: taxi values 0, `aircraftState: 10`). Pass 4 builds `aircraft-animator:aircraft:REG`. Turnaround detection avoids duplicate aircraft entries when same REG is ARR+DEP. All entries (new + kept) pass through `_reorderIrefEntries` for topological sort by `$iref` dependency — no hardcoded ordering.
     - **7c. Remove orphaned RuntimeEntities (`_removeOrphanedFlightEntities`):** Removes or renames `$k` entries (`flight-plan:REG`, `aircraft:REG`, `aircraft-animator:aircraft:REG`) whose registration no longer exists in rebuilt StaticItems. Handles rename via `renameMap` and falls back to `StaticItem.$fstrref` for corrupted saves. Updates `$rlength`.
     - **7d. Cleanup EventLog LatestEvents (`_cleanupEventLogLatestEvents`):** On every save, fully clears the `LatestEvents` dictionary inside `singleton:event-log.$v.LatestEvents` — sets `$rlength` to 0 and `$rcontent` to `[]`. Replaces the old selective-key-removal approach with a full wipe, preventing stale `aircraft:REG` entries from accumulating across saves.
     - **Centralized $iref remapping (`_IdMapper.remapIrefs`):** Union-find structure per segment. Applies old→new `$id` mappings collected during 7b-1/7b-3 to correct `$iref` references in preserved entries.
     - **7a. $fstrref cleanup & remapping (runs AFTER 7b):** IndexOf-based positional scanning for `$fstrref:"flight-plan:REG"` — replaces stale refs with `null`, remaps renamed registrations. Runs last so 7b's jetway detection sees intact `$fstrref` values.
   - Writes `.acl` + `.csv`
   - **Demo-window files treated identically** — all files in `DEMO_VISIBLE_BASES` (including `_emerg`) write to their `.acl`/`.demo.acl` + shared `.csv` + shared timeline `.json` files with the same 30-minute window logic via `_isDemoFile()`
5. Timeline saves (separate IPC per type) → writes JSON files
6. Backup: `.bak` copies created before overwrite (optional, checkbox in save dialog). For `.demo.acl` files, creates `.demo.acl.bak`

## Cache State & Version Detection

The app uses a unified **`cache.json`** in `userData` (replaces `approachCache.json` + `lastRoot.json` + `localStorage.ac27_lang`). It contains `gameRoot`, `lang`, `cacheVersion`, `builtAt`, and `airports`.

Cache validity is determined by a standalone **`CACHE_VERSION`** constant (integer, hand-bumped in `src/utils/constants.js`), NOT by `app.getVersion()`. This decouples cache invalidation from app updates.

**⚠️ CACHE_VERSION rule:** Any change to the shape of `cache.json` (new fields in the approach cache object, new top-level keys, changed structure of `approachData`, `fileTypeMaps`, etc.) MUST bump `CACHE_VERSION` in `src/utils/constants/timing.js:13`. The re-scan happens transparently during App.jsx boot — `initAirportCache()` detects the version mismatch and rebuilds the cache silently before BrowserScreen mounts. Without the bump, old cached data will silently corrupt saves. Examples of changes requiring a bump: adding `state5ParamsMap`, changing `fileTypeMaps` from per-airport to per-file, adding `.bak` files to the scan set, adding `taxiwayPaths`/`sidPaths`/`missedAppPaths`/`airwayNodes` to `approachData`, removing `saveTimeOffsets`/`typeMap` from the serialized schema. **`airwayNodes` content changes** (e.g. the 2026-08-06 filter to ICAO-style `/^[A-Z]{3,5}$/` fix names only) also count as shape changes and need a bump. Current `CACHE_VERSION` is 20.

| `cache.json` | Behavior |
|---|---|
| Missing | Show root-select screen (SetupScreen) |
| Exists, `cacheVersion` ≠ `CACHE_VERSION` | Re-scan silently during App.jsx boot via `initAirportCache()` |
| Exists, `cacheVersion` matches | Proceed directly to level-select screen |

**Startup flow (`get-cache-state` IPC):**
1. Check `cache.json` — if exists, compare `cacheVersion` vs `CACHE_VERSION`
2. If missing, attempt migration from legacy `approachCache.json` → creates `cache.json` with current version
3. If only `lastRoot.json` exists → returns `mismatch` state (no airport data, needs rescan)
4. Returns `{ state: 'no-cache' | 'mismatch' | 'ready', gameRoot, lang, airports, cachedVersion, expectedVersion }`
5. ScreenRouter uses `getCacheState()` instead of `getLastRoot()` — routes to setup/browser based on state

**Re-scan flow (transparent during boot):**
1. App.jsx boot calls `initAirportCache(gameRoot)` unconditionally
2. When version mismatches, `initAirportCache` does a full re-scan internally (no user-facing modal)
3. By the time BrowserScreen mounts, `cache.json` already has the new `CACHE_VERSION`
4. Progress modal with `CacheProgressBody` still appears during initial cache build in SetupScreen

**Language persistence:**
- `lang` field in `cache.json` provides durable backup for language preference
- `useTranslation` reads from cache JSON when `localStorage` is empty, and writes to both on toggle
- IPC handlers: `get-cached-lang`, `save-cached-lang`

**IPC handlers (new):** `get-cache-state`, `get-cached-lang`, `save-cached-lang`
**IPC handlers (removed):** `get-last-root`, `save-last-root`, `check-version-mismatch`, `update-cached-version`, `cache-invalidated` event
**Preload bridges (new):** `getCacheState()`, `getCachedLang()`, `saveCachedLang(lang)`
**Preload bridges (removed):** `onCacheInvalidated(cb)`

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

## Stand Conflict Detection

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

## Duplicate Registration Detection

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

- **SVG map** of all stands for the current airport, with dots positioned by real x,y coordinates parsed from stand `TailPosition`/`NosePosition` `$iref`s → taxiway-node positions
- **4 dot states**: Current (accent, large + ring), Hovered (accent, medium), Available (accent, small), Occupied (grey, not clickable)
- **Occupancy detection**: `computeOccupiedStands()` in FlightTable checks time-window overlaps between flights
- **Airport background**: Dark radar-style fill (`#0a1628`) with programmatic SVG: taxiway centerlines, runway rectangles, area polygons (boundary/apron/building) at 0.2 opacity — same data as GroundMapWindow (`_taxiwayPaths`, `_runwayData`, `_areaData` from `collect-values`)
- **Dark mode**: Map content area forces dark mode CSS variables regardless of app theme
- **i18n**: Title and legend use `standmap_title`, `standmap_current`, `standmap_available`, `standmap_occupied` keys

**Component:** `src/components/EditorScreen/StandMap/StandMap.jsx` — portal-based, responsive (scales with window via `useWindowSize` hook), viewBox preserves data aspect ratio with a target ratio cap. Uses the shared `useDrag` hook for header-drag repositioning. Receives `taxiwayPaths`, `runwayData`, `areaData` from EditorScreen (already in store from `collect-values`).

## Star Map Overlay

When editing an Airway cell in the flight table, a non-blocking overlay panel shows the STAR/approach chart for the current airport. It displays:

- **SVG map** of all STAR waypoint paths for the airport, plotted from the STAR routes' `AirwayNodes` `$iref`s → taxiway-node coordinates
- **Runway thresholds** rendered as extended lines (3× runway length), parsed from runway `ThresholdPoints` `$iref`s via `_parseRunwayThresholds()`
- **Live aircraft positions** on approach — arrival flights' positions computed via `get-aircraft-positions` IPC using the same `computePosition()` algorithm as State=30/State=5 save generation
- **Aircraft interactivity**: Hovering an aircraft dot shows callsign + STAR + runway + ETA
- **Click to select** a STAR path, which updates the flight's Airway field via `updateFlight(idx, { Airway: starName })`
- **Departure flights**: Show a notice that the STAR map is unavailable (no approach data for departures)
- **Airport background**: `{ICAO}.png` (e.g. `ZSJN.png`) positioned via `AIR_MAP_BG_OFFSETS` — same algorithm as AirMapWindow (image fills viewBox, per-airport dx/dy/w offsets, `bgUnder` rect behind it, 0.2 opacity, `preserveAspectRatio="xMidYMid slice"`)
- **Dark mode**: Map content area forces dark mode CSS variables regardless of app theme
- **i18n**: Title and legend use `starmap_title`, `starmap_current`, `starmap_available`, `starmap_disabled`, `starmap_no_data` keys

**Component:** `src/components/EditorScreen/StarMap/StarMap.jsx` — portal-based, draggable via `useDrag` hook, responsive viewBox scaling. Path colors cycle through a preset palette per STAR name. Runway thresholds rendered as thin colored lines matching their associated STAR paths.

**Map overlay orchestration:** `MapOverlays` sub-component in `EditorScreen.jsx` manages visibility and prop-passing for both StandMap and StarMap. Visibility state lives in zustand (`showStandMap`, `showStarMap`, `activeMap`, `mapFlightIdx`). Only one map is "on top" at a time (controlled by `activeMap`). Both maps close when leaving the editor screen (`setScreen` clears map state).

## Level Whitelists & Demo .acl File Handling

**Visibility is whitelist-based** in `src/utils/constants/ui.js`:

- `PROD_VISIBLE_BASES` (ordered array, 9 entries) — the only levels shown in production (non-demo) mode; **array position = browser display order**:
  `ZSJN_leisure_1.acl`, `ZSJN_leisure_2.acl`, `ZSJN_runwaychange.acl`, `ZSJN_peakdeparture.acl`, `ZSJN_taixwayclosed.acl`, `KJFK_leisure_1.acl`, `KJFK_leisure_2.acl`, `KJFK_peakarrival.acl`, `KDCA_smoke.acl`
- `DEMO_VISIBLE_ORDER` (ordered array, 4 entries) — the only levels shown in demo mode (root path contains "Airport Control 27 Demo"); array position = browser display order:
  `KJFK_leisure_1.demo.acl`, `KJFK_peakarrival.demo.acl`, `ZSJN_leisure_1.acl`, `ZSJN_peakdeparture.demo.acl`
- `DEMO_VISIBLE_BASES` (Set) — derived from `DEMO_VISIBLE_ORDER` for lookups
- `ZSJN_leisure_1.acl` appears in **both** lists — it ships as a regular level but is also playable in demo mode. (`ZSJN_leisure_2.acl` is prod-only.)

**Display names:** Levels show localized names from `src/utils/i18n.js` under `level_name_<base-filename-without-.acl>` keys (e.g. `level_name_ZSJN_leisure_1` → "悠闲时刻" / "Relax Time"; `.demo` variants included, e.g. `'level_name_KJFK_peakarrival.demo'` — quoted because the key contains dots). BrowserScreen looks up `t('level_name_' + filename.replace(/\.acl$/i, ''))`; `t()` falls back to the raw key if missing.

**Row layout:** `[display name — large, replaces the old time-of-day label (Morning/Afternoon)] [time range HH:MM-HH:MM] [small filename via stripSuffixes] [arrivals/departures stats] [arrow]`. Time-of-day label (dawn/morning/afternoon/dusk/night) is gone; the name took its slot. The first column is fixed-width per language (`--tod-width`: zh 80px / en 130px, set inline on `#screen-browser`) so the name/time/filename sections align vertically across airport cards. `sortLevelRows` no longer sorts by time.

**Sorting:** `sortLevelRows` in `BrowserScreen.jsx` ranks files by index in the mode's whitelist array (`PROD_VISIBLE_BASES` in prod, `DEMO_VISIBLE_ORDER` in demo), unknown files last (then by filename), `_emerg` files always last. No time-based sorting.

**Demo mode visibility & window:** The `DEMO_VISIBLE_BASES` Set is the single source of truth — it controls both which files are visible in demo mode AND which files get the 30-minute demo window (every entry, including the regular `.acl` ones). `_isDemoFile()` in `electron/main.js` checks exact filename via `path.basename()` against this set (NOT the `.demo.acl` extension). Update the order arrays when levels are added or removed. (BrowserScreen filters prod mode via `PROD_VISIBLE_BASES.includes(filename)` and demo mode via `DEMO_VISIBLE_BASES.has(filename)`.)

**Key properties:**
- Each `.demo.acl` is a save-state snapshot with the **same BaseTime** as its parent but a **later CurrentDateTime** (~40–55 min offset), creating the 30-min playable window
- FlightPlans, scenery, and file references are identical to the parent `.acl`
- No matching `.aclcfg` exists — Config is read from the `.acl` file itself

**Editor behavior:**
- Demo files are treated as **normal levels** — always visible, no tags, no hiding
- **Demo mode** (root path contains "Airport Control 27 Demo"): only files listed in `DEMO_VISIBLE_BASES` are shown
- **On load:** flights in demo files are filtered to a 30-minute window starting at `CurrentDateTime` via `_filterDemoFlights()` — centralized helper shared across load, save, import, and restore paths. Uses integer-minute bounds: `[cdtMin, cdtMaxMin)` where `cdtMaxMin = _roundNearest5(cdtMin + 30)` — the end time is rounded to the nearest 5-minute boundary (:X0 or :X5). Config's `startTime`/`endTime` are overridden to match. Start time is NOT rounded.
- **On save:** demo files write to `.demo.acl` + shared `.csv` + shared timeline `.json` files; creates `.demo.acl.bak`. End time is rounded to nearest :X0/:X5 (same as load).
- **Export/Import:** packs/unpacks `.demo.acl` identically to normal `.acl` files
- **Approach cache:** includes demo files (unfiltered)
- **Challenge Level display:** Files with `_emerg` in their name sort to the bottom of the browser list (`isEmer` flag exposed via `get-airport-files-info` IPC, checked in `BrowserScreen`). The old time-of-day label ("Challenge Level" / "挑战关卡" via `browser_emerg_level`) was removed along with the time display — display names now come from `level_name_*` i18n keys.
