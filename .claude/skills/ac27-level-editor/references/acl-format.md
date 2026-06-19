# AC27 ACL File Format & Approach Math

## Table of Contents

- [ACL File Format](#acl-file-format)
  - [Standard JSON-Plus Extensions](#standard-json-plus-extensions)
  - [Non-Standard JSON Syntax](#non-standard-json-syntax-handled-by-pre-processor)
  - [Two-Pass Parsing](#two-pass-parsing-srcaclacl_jsonjs)
  - [Key Section Types](#key-section-types)
- [SceneryData Runway Routes](#scenerydata-runway-routes)
- [SID and Missed Approach Extraction](#sid-and-missed-approach-extraction)
- [SceneryData TaxiwaySegments](#scenerydata-taxiwaysegments)
- [Approach Aircraft Construction (State=30 & State=5)](#approach-aircraft-construction-state30--state5)
  - [Unified Path Architecture](#unified-path-architecture)
  - [State=5 Sub-types](#state5-sub-types)
  - [Complete Position & Direction Math](#complete-position--direction-math)
  - [saveTime Resolution Priority](#savetime-resolution-priority)
  - [Verified Field Relationships (State=30)](#verified-field-relationships-state30)
  - [ProgressRatio Formula](#progressratio-formula)
  - [TAT (Total Approach Time) Computation](#tat-total-approach-time-computation)
  - [Approach Altitude Ceiling](#approach-altitude-ceiling)
- [Module API (`src/acl/approach.js`)](#module-api-srcaclapproachjs)
- [Test](#test)

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

### Key Section Types

- `SceneryData` (type 59) — runway/gate GUIDs
- `Aircrafts` (type 35) — aircraft state entries with DynamicParams
- `FlightPlans` (type 52) — container for FlightPlanState entries
- `FlightPlanState` (type 37) — individual flight plans with DepartureLeg/ArrivalLeg
- `DepartureLeg` (type 57) / `ArrivalLeg` (type 58) — flight leg data
- `TaskFlightState` (type 56/54) — older WorldState format (legacy)
- `WeatherFrames` / `WindFrames` / `RunwayTimeline` — timeline sections

## SceneryData Runway Routes

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

**Important:** The authoritative source for valid STAR↔runway combinations is `SceneryData.Runways[runway].Routes[].Name` where `Type === 0`. This is a superset of what `appPointMap` covers (which is limited to State=30 aircraft entries at snapshot time).

**Extraction algorithm** (`extractStarRunwayMappings` — see approach.js):
1. Find `SceneryData` → `Runways` section via tokenizer
2. Find main `$rcontent` array at brace depth 1 (skip nested arrays like `comparer`)
3. Iterate runway dictionary entries → extract `Name` (runway designator) and `Routes`
4. Parse `Routes.$rcontent` → for each route with `Type === 0`, collect `Name` (STAR name)
5. Return `{ starRunwayMap: {star → [runways]}, runwayStarMap: {runway → [stars]} }`

## SID and Missed Approach Extraction

Follows the identical pattern in `sid_goaround.js`, operating on `Type === 2` (SID) and `Type === 3` (Missed Approach) routes. The four functions exported by `sid_goaround.js` mirror the approach.js STAR helpers:
- `extractSidRunwayMappings(aclText)` → `{ sidRunwayMap, runwaySidMap }`
- `extractMissedApproachMappings(aclText)` → `{ missedAppMap, runwayMissedAppMap }`
- `buildSidPaths(aclText, sidRunwayMap)` → `{ sidName: [{x, z}, ...] }`
- `buildMissedApproachPaths(aclText, missedAppMap)` → `{ maName: [{x, z}, ...] }`

## SceneryData TaxiwaySegments

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

### Unified Path Architecture

Both State=30 and State=5 share the SAME full path:
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
continuity. The stored DynamicsParams.ProgressRatio uses the **rescaled** `state5PR`.

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

### saveTime Resolution Priority

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
at every airport regardless of runway geometry.

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

### Approach Altitude Ceiling

The approach ceiling is **5000 ft** (1524 m). In game units at the uniform
100 m/unit scale:

```
approachCap = 1524 / 100 = 15.24
```

Every original game file (ZSJN and KJFK alike) stores `Position.y = 15.24`
and `InitialPosition.y = 15.24` for aircraft at the approach ceiling. The
`computeApproachCap()` function always returns this fixed value.

## Module API (`src/acl/approach.js`)

**Data Extraction:**
- `extractSpecificationDB(aclText)` → `Map<Designator, Spec>` — 14 designators across ZSJN+KJFK
- `extractApproachData(aclText)` → `Array<{route, runway, progressRatio, flyPoints, appPoints, ...}>` — all State=30 aircraft
- `extractState5Data(aclText)` → `Array<{route, runway, touchDownPosition, approachDirection, initialPosition, pathPointList}>` — State=5 aircraft still in-air (Sub-type A: has DynamicsParams, no taxi path)
- `extractTypeMap(aclText)` → `Map<number, string>` — captures all fully-qualified `$type` declarations from a file; type numbers are per-file in Unity's serialization
- `buildAppPointMap(approachEntries)` → `Map<"Route|Runway", Vector3[]>` — verified 1:1 mapping
- `buildState5ParamsMap(state5Entries)` → `Map<"runway", {pathPointList, touchDownPosition, approachDirection, initialPosition}>` — per-runway final approach parameters from State=5 data
- `computeApproachTimesFromScenery(aclText, starMappings, appPointMap, refTatMap, defaultTAT, airportScale?)` → `Map<STAR, seconds>` — per-STAR duration from SceneryData path-length estimates using three-tier estimation
- `extractGameTime(aclText)` → `seconds | null` — parse `GameTime.CurrentDateTime` ticks as seconds since midnight
- `extractSaveTime(aclText, totalApproachTimes)` → `seconds | null` — derive snapshot time from first State=30 entry's PR + LandingTime

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
- `buildApproachCache(airportDir)` → `{specDB, appPointMap, totalApproachTimes, designatorMap, saveTimeOffsets, typeMap, fileTypeMaps, state5ParamsMap, starPaths, runwayThresholds, airportScale, starRunwayMap, runwayStarMap}` — scans all .acl files for an airport

**Assembly:**
- `buildApproachAircraftBlock({flightPlanGuid, route, flyPoints, appPoints, progressRatio, spec, radioChannelGuid?, touchDownPosition?, approachCap?, typeNums?, acTypeNum?, nextId?})` → `{guid, block, nextId}` — State=30 `$k/$v` JSON block
- `buildState5AircraftBlock({flightPlanGuid, route, state5PR, spec, towerChannelGuid?, state5Params, flyPoints?, fullPR?, waitingForCommand?, selectedRunwayExitIndex?, typeNums?, acTypeNum?, nextId?})` → `{guid, block, nextId}` — State=5 `$k/$v` JSON block
- `buildAnimatorBlock(aircraftGuid, opts)` — builds the paired `AircraftAnimatorState` entry; `opts.typeNums` controls `animState`/`animSubState` type numbers

## Test

```bash
node --require ./tests/integration/preload.cjs tests/integration/test_approach_aircraft.js [--root <game-root>]
```

Validates all algorithms against the 8 production files: spec consistency, AppPoint mapping, ProgressRatio formula (saveTime spread), FlyApproach resolution, Position/Direction reconstruction, and block assembly.
