# AC27 ACL File Format & Approach Math

## Table of Contents

- [ACL File Format](#acl-file-format)
  - [Standard JSON-Plus Extensions](#standard-json-plus-extensions)
  - [Non-Standard JSON Syntax](#non-standard-json-syntax-handled-by-pre-processor)
  - [Two-Pass Parsing](#two-pass-parsing-srcaclacl_jsonjs)
  - [Key Section Types](#key-section-types)
- [Runway Routes (PKStaticEntities)](#runway-routes-pkstaticentities)
- [SID and Missed Approach Extraction](#sid-and-missed-approach-extraction)
- [Taxiway Segments (PKStaticEntities)](#taxiway-segments-pkstaticentities)
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

- `MetaData` (`ContextCross.Saves.LevelMetaData`) — `BaseTime` (DateTime tick value as inline `{ "$type": 2, ticks }`), nested `Config` (`startTime`/`endTime`, file references), plus the timeline sections `WeatherFrames` / `WindFrames` / `RunwayTimeline` (rebuilt by `_rebuildV4TimelineSections`)
- `StaticData` — `byte[]` field whose value is a decoded nested Odin document (`"$blobdoc"`) containing `PKStaticEntities`, `NonPKStaticEntities`, `StaticItems`
- Checkpoint-frame documents — `CheckpointFrame` → `Snapshot` (RuntimeSnapshot) → `RuntimeData` → `$blobdoc` → `RuntimeField` → `RuntimeEntities` (runtime aircraft / jetway / event entries)
- No `SceneryData` or `WorldState` sections exist; `GameTime` is usually absent (snapshot time comes from `MetaData.BaseTime`)

## File Schema (v4 Only)

The 2026-07 game update introduced the **v4 schema**; it is now the only schema. Every `.acl` file is a **GATCARC4 binary archive** (see below). When decoded, the header document has these top-level sections:

| Section | Description |
|---------|-------------|
| `MetaData` | `LevelMetaData` — `BaseTime` (DateTime tick value as inline `{ "$type": 2, ticks }`), nested `Config` (`startTime`, `endTime`, file references), plus the timeline sections `WeatherFrames`, `WindFrames`, `RunwayTimeline` |
| `StaticData` | `byte[]` field whose value is a decoded nested Odin binary document (`"$blobdoc"`), containing `PKStaticEntities`, `NonPKStaticEntities`, `StaticItems` |
| `GameTime` | (usually absent — snapshot time derived from `MetaData.BaseTime` instead) |

Each appended **checkpoint frame** document contains `Snapshot` (RuntimeSnapshot) → `RuntimeData` → `$blobdoc` → `RuntimeField` → `RuntimeEntities` — the runtime aircraft / jetway / event entries rebuilt by the save pipeline.

All files are v4 — there is no schema detection and no `isV4` parameter anywhere in the code.

### GATCARC4 Binary Container

GATCARC4 is an append-only binary archive format that wraps Odin-serialized payloads. All sections:

```
Header segment:
  [0..7]   ASCII magic "GATCARC4"
  [8..11]  uint32 storage version (currently 1)
  [12..15] uint32 payload length N
  [16..16+N)          payload: OdinSerializer binary document
  [16+N..16+N+32)     SHA-256 of payload bytes
  [16+N+32..16+N+36)  ASCII commit marker "NODH"

Zero or more appended checkpoint frames:
  [0..3]   ASCII frame marker "MARF"
  [4..7]   uint32 storage version
  [8..11]  uint32 payload length M
  [12..12+M)          payload: OdinSerializer binary document
  [12+M..12+M+32)     SHA-256 of payload bytes
  [12+M+32..12+M+36)  ASCII commit marker "NODF"
```

Each payload is an independent OdinSerializer binary document. Nested `byte[]` fields (such as `ArchiveHeader.StaticData`, `RuntimeSnapshot.RuntimeData`) contain complete nested Odin binary documents, decoded inline as `"$blobdoc": { ... }` entries.

**Multi-frame archives** are decoded into multiple Odin JSON documents separated by a sentinel line:
```
$$$ GATCARC4 CHECKPOINT FRAME $$$
```

**I/O rules:**
- `readAclText(path)` — universal read: decodes GATCARC4 binary via `decodeArchive()` to Odin JSON text.
- `writeAcl(path, text, { format })` — writes binary (GATCARC4 archive) or text. Default `'auto'` preserves whatever the file was on disk. New files default to binary (`'text'` exists for debugging only).
- All game `.acl` files are GATCARC4 binary archives — the editor never writes plain text.

All ACL I/O in the editor goes through `src/acl/gatcarc.js`. No code calls `fs.readFileSync(path, 'utf-8')` on `.acl` files.

### Odin JSON Text Dialect

Decoded GATCARC4 payloads use the Odin JSON text dialect — the extensions listed in [Standard JSON-Plus Extensions](#standard-json-plus-extensions) above. All parsing code (tokenizer, pre-processor, etc.) operates on this decoded text.

### v4 Structure at a Glance

| Aspect | v4 |
|--------|-----|
| Top-level sections | Header document: `MetaData` (nested `Config` + timeline sections), `StaticData` (`$blobdoc`); checkpoint frames: `Snapshot.RuntimeData` |
| Scenery entities | `StaticData.$blobdoc.PKStaticEntities` (flat array, all entity types) + `NonPKStaticEntities` (areas) |
| Entity references | `$iref:N` pointer to `$id:N` |
| Flight plans | `StaticData.$blobdoc.StaticItems.$rcontent` with `flight-plan:REGISTRATION` keys |
| Leg field names | `InitialArrival` / `InitialDeparture` |
| Pre-spawned aircraft | None — game computes state at runtime |
| Snapshot time | `MetaData.BaseTime` (inline `{ "$type": 2, ticks }`) |
| InBlockTime / TakeoffTime | Always 0 (game computes dynamically) |

### $blobdoc Nested Document Pattern

Nested binary payloads appear as `"$blobdoc": { ... }` in decoded text. The `$blobdoc` value is a complete decoded Odin JSON document with its own **independent type numbering**. The nesting path for key v4 data:

```
StaticData
  → $blobdoc (decoded ArchiveHeader payload)
    → PKStaticEntities: { $rcontent: [{ $k: "runway:31L", $v: { $id: 1, Name: "...", Routes: {...} } }, ...] }
    → NonPKStaticEntities: { $rcontent: [area entries with NodePositions] }
    → StaticItems: { $rcontent: [{ $k: "flight-plan:N738AC", $v: { ... } }, ...] }
```

### PKStaticEntities $iref/$id Reference System

In v4, all scenery entities live in a single flat `PKStaticEntities.$rcontent` array, each with a `$k` (type-prefixed primary key like `"runway:31L"`, `"stand:12"`, `"taxiway-node:123"`) and a `$v` block. The `$v` block contains a numeric `$id` that other entities reference via `$iref:N`:

```json
// A taxiway segment references its endpoint nodes:
{ "$k": "taxiway-segment:TWY_A1",
  "$v": { "$id": 501, "Name": "A1", "Flags": 1,
    "Nodes": { "$rcontent": ["$iref:401", "$iref:402"] } } }

// Those nodes have positions:
{ "$k": "taxiway-node:401",
  "$v": { "$id": 401,
    "ReactivePosition": { "$type": 4, { "$type": 5, 123.4, 0, 567.8 } } } }

// A stand references its tail and nose nodes:
{ "$k": "stand:12",
  "$v": { "$id": 601, "Identifier": "12",
    "TailPosition": "$iref:701", "NosePosition": "$iref:702" } }
```

The `src/acl/v4_pk_index.js` module builds a dual index (`byType` + `byId`) from the flat array and provides helpers for field extraction.

### v4 Flight-Plan Entries

v4 flight plans live in `StaticData.$blobdoc.StaticItems.$rcontent` with keys prefixed `flight-plan:`:

```json
{ "$k": "flight-plan:N738AC",
  "$v": { "$id": 2001,
    "$type": "42|ContextCross.Models.FlightPlanStaticItem, GroundATC.Core",
    "Registration": "N738AC",
    "AircraftType": "B738",
    "AirlineName": "UAL",
    "InitialArrival": {
      "$id": 2002,
      "$type": "30|ContextCross.Models.FlightPlanArrivalLeg, GroundATC.Core",
      "CallSign": "UAL738",
      "OriginAirport": "KLAX",
      "LandingTime": { "$type": "3|System.DateTime, mscorlib", 638468106000000000 },
      "InBlockTime": { "$type": "3|System.DateTime, mscorlib", 0 },  // computed by game
      "ActualInBlockTime": { "$type": "3|System.DateTime, mscorlib", 0 },
      "Runway": "31L",
      "Stand": "12",
      "STAR": "SEY.PARCH4"
    },
    "InitialDeparture": null  // or { ... } for departures
  }
}
```

Key facts:
- `InitialArrival`/`InitialDeparture` field names (no `Arrival`/`Departure` forms exist)
- `InBlockTime` is always `0` (game computes it)
- Each leg sub-object has its own `$id` (OdinSerializer requirement for nested objects)
- The key is `flight-plan:REGISTRATION`

### Independent Type Numbering

Each `$blobdoc` section has its **own independent type number space**. Type `42` inside a `$blobdoc` is not the same type as `42` in the outer document. The save path (`_rebuildStaticDataSections`) maintains a separate `bdTypeMap` for the blobdoc scope. When type numbers must be created for new content, the code scans for unused numbers within the blobdoc's own type namespace.

#### Scope-Aware Type Expansion During Save

Before the save pipeline removes orphaned entries (which may carry the only declaration of a type number), all bare `$type: N` references are pre-expanded to their fully-qualified form using **per-segment type maps**. Each GATCARC4 segment (header + checkpoint frames) is an independent Odin binary document with its own type numbering, so expansion uses that segment's own declarations:

```
frameDocs[fi] → extract "$type": "N|TypeName" declarations → per-segment typeMap
              → _expandShortFormTypes(frameDocs[fi], segTypeMap)
              → all bare "$type": N become "$type": "N|TypeName"
              → cleanup steps proceed without risk of orphaned type refs
```

The expansion function is scope-aware at every level: `_expandWithBlobdocScopes` walks the JSON text, identifies `$blobdoc` entries (which are nested Odin binary documents with their own type numbering), extracts their type declarations, and recurses so that bare references inside a blobdoc are expanded against that blobdoc's scope — not the outer document's. A standalone `_replaceBareTypeRefs` handles single-scope regex expansion for non-blobdoc text. This replaces the previous single-pass regex approach that conflated type numbers across all scopes.

This prevents "unknown type id N" / "Type id N claimed by both" encoding errors when cleanup removes entries containing type declarations that other entries still reference.

## Runway Routes (PKStaticEntities)

Runway entries live in `StaticData.$blobdoc.PKStaticEntities` as `"$k": "runway:<name>"` entries. Each entry contains:

| Field | Description |
|---|---|
| `Name` | Runway designator used by flight plans — e.g. `"31L"`, `"19"`, `"01"` |
| `PhysicalName` | Runway pair — e.g. `"13R/31L"`, `"01/19"` |
| `Routes` | Contains `$rcontent` array of route entries, each with `Name`, `RouteType`, `AirwayNodes` ($iref array) |

**Route Types** (verified against both KJFK and ZSJN production .acl files):

| RouteType | Meaning | Example Names | Used for |
|-----------|---------|---------------|----------|
| **0** | **STAR** (arrival transition) | `SEY.PARCH4`, `UBSS6W`, `OKAL6W`, `WFG91A` | Airway dropdown filtering, StarMap availability, approach path resolution |
| 1 | RNAV approach procedure | `RNAV Y Rwy 31L`, `RNAV ILS Z Rwy 19` | State=5 approach data (`resolveApproachProcedureData`) |
| **2** | **SID** (departure transition) | `JFK5.JFK`, `TUML5T`, `BASV7Y` | Parsed by `sid_goaround.js` → `sidPaths` for AirMapWindow route display |
| 3 | Missed approach | `RNAV Y Rwy 31L (Missed Approach)` | Parsed by `sid_goaround.js` → `missedAppPaths` for AirMapWindow route display |

**Important:** The authoritative source for valid STAR↔runway combinations is the runway entry's `Routes` where `RouteType === 0`. This is a superset of what `appPointMap` covers (which is limited to State=30 aircraft entries at snapshot time).

**Extraction algorithm** (`extractStarRunwayMappings` — see approach.js):
1. Build the PK index (`buildPkIndex`) and iterate `runway:*` entries in `PKStaticEntities`
2. For each runway, navigate its `Routes.$rcontent` array (skip nested arrays like `comparer`)
3. For each route with `RouteType === 0`, collect `Name` (STAR name) and its `AirwayNodes` `$iref`s
4. Return `{ starRunwayMap: {star → [runways]}, runwayStarMap: {runway → [stars]} }`

## SID and Missed Approach Extraction

Follows the identical pattern in `sid_goaround.js`, operating on `RouteType === 2` (SID) and `RouteType === 3` (Missed Approach) routes. The six functions exported by `sid_goaround.js` mirror the approach.js STAR helpers (all route via PKStaticEntities runway entries):
- `extractSidRunwayMappings(aclText)` → `{ sidRunwayMap, runwaySidMap }`
- `extractMissedApproachMappings(aclText)` → `{ missedAppMap, runwayMissedAppMap }`
- `buildSidPaths(aclText, sidRunwayMap)` → `{ sidName: [{x, z}, ...] }`
- `buildMissedApproachPaths(aclText, missedAppMap)` → `{ maName: [{x, z}, ...] }`
- `extractApprRunwayMappings(aclText)` → `{ apprRunwayMap, runwayApprMap }` — Approach routes (RouteType=1)
- `buildApprPaths(aclText, apprRunwayMap)` → `{ apprName: [{x, z}, ...] }`

## Taxiway Segments (PKStaticEntities)

Taxiway centerline segments are `"$k": "taxiway-segment:*"` entries in `PKStaticEntities`:

| Field | Description |
|-------|-------------|
| `Name` | Taxiway designation (e.g. `"A"`, `"B"`, may be empty) |
| `Flags` | Integer: 1=standard, 2=wider, 4=special |
| `Nodes` | `{$rcontent: [$iref, $iref]}` — endpoint `$iref`s resolved to taxiway-node positions via the PK index |

Parsed by `src/acl/taxiway.js` (`parseTaxiwayPaths(aclText)`):
- **Stand-access segments are included** (marked with `isStandAccess: true`) instead of being excluded — segments where ANY endpoint node touches a stand position (via `TailPosition` / `NosePosition` `$iref`s from `stand:*` entries) get the flag; non-stand segments omit it
- Returns `{ paths: [{ name, flags, points: [{x, z}], isStandAccess?: boolean }] }`
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

**totalLen includes touchdown distance:** `_buildStandaloneAircraftEntry` includes the touchdown
distance in `totalLen` (the denominator for the IAF boundary `rawTargetDist`). This ensures `totalLen` matches the path
length that TAT was calibrated for — scenery-derived TAT includes `tdDist` from
`computeFullTerminalPath`. Without this, `rawTargetDist` used a shorter denominator, biasing the
IAF boundary toward State=30 for aircraft near the runway. The touchdown position is sourced from
`state5ParamsMap` (by appKey then runway) as the authoritive single-point touchdown, replacing the
older `runwayThresholds` value which was an array of two threshold positions (causing NaN in
`_vec3Dist`).

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
| **A: Contact Tower** | < 60s | `[22]` | 0 | null |
| **B: Cleared to Land** | 0–60s | `[23]` | 0 | null |
| **C: Post-landing** | ≤ 0 | `[]` | ≥ 1 | populated (taxi route) |

Sub-type A is the standard State=5 — aircraft just handed off to Tower, needs to
contact. Sub-type B is for aircraft within 1 minute of landing — landing clearance
already issued. Sub-type C is for aircraft that have already touched down and are
taxiing to the stand.

### Complete Position & Direction Math

**Inputs (per aircraft):**
- `landingTime` [seconds since midnight] — from FlightPlan ArrivalLeg
- `saveTime` [seconds since midnight] — from the scenario's configured start time (see [saveTime Resolution Priority](#savetime-resolution-priority))
- `star` [string] — STAR/route name, e.g. `"UBSS6W"`
- `runway` [string] — runway name, e.g. `"19"`

**Cache lookups (per airport, built during init by `buildApproachCache`):**
- `TAT = totalApproachTimes[star]` — full approach duration in seconds (~1380-1775)
- `appPoints = appPointMap[star + "|" + runway]` — AppPointList Vector3[]
- `state5 = state5ParamsMap[runway]` — `{ pathPointList, touchDownPosition, approachDirection, initialPosition }`
- `approachCap = 15.24` — standard ILS approach ceiling in game units (= 5000ft at 100 m/unit), from `computeApproachCap()`

**Runway route data (resolved per-file from PKStaticEntities):**
- `flyPoints = resolveFlyApproachPoints(aclText, star, runway)` — FlyApproachPathPointList (from the runway route's `AirwayNodes` `$iref`s)

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
flyLen   = Σ segmentDistances(flyPoints)   [path length of FlyApproach from the route's AirwayNodes]
appLen   = Σ segmentDistances(appPoints)   [path length of AppPointList from cache]
combined = [...flyPoints, ...appPoints]    [concatenate to include connecting segment]
totalLen = computePathLength(combined)     [total unified path length]
targetDist = totalLen × progressRatio      [aircraft position along unified path]

if targetDist >= flyLen → State=5  (past IAF, final approach, Tower)
else → State=30                    (before IAF, still on STAR, Approach)
```

This eliminates the need for a cached `flyFractionMap` — the IAF is determined
directly from the full FlyApproach path (resolved from the runway route's
`AirwayNodes` via `resolveFlyApproachPoints`) and the cached AppPointList.

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
**Note:** The editor's save path (`_buildStandaloneAircraftEntry`) hardcodes `InitialPosition.Y` to
`15.24` (= 5000 ft at 100 m/unit) instead of computing it from path distance. The stored path
points have Y=0 (game engine computes altitude internally from `touchDownPosition` + path
distance), but `InitialPosition` stores the approach ceiling altitude directly. Every original game
file uses 15.24 regardless of airport.

**TouchDownPosition** — from the runway's approach route data via `state5ParamsMap` (Y≈0, runway level).

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

In `_rebuildStaticDataSections` (flight_plans.js), saveTime is resolved as:

1. `aclcfgStartTime` — passed from the frontend (config `startTime` with the `GameTime.CurrentDateTime` override applied via `resolveConfigTime`)
2. Fallback: `resolveConfigTime(text).startTime` from the file being saved
3. `_saveSec` is **ignored** — v4 is not a snapshot save; aircraft positions are computed relative to the scenario's configured start time (`extractSaveTime` is a stub returning `null`)

### Verified Field Relationships (State=30)

| Field | Source | Pattern |
|-------|--------|---------|
| `Specification` | Designator→Spec DB | Fixed per Designator (byte-identical across all files) |
| `FlyApproachPathPointList` | AirwayNodes `$iref` chain | runway route `AirwayNodes` `$iref`s → taxiway-node positions (via `resolveIref`) |
| `AppPointList` | f(Route, Runway) map | Fixed per (Route, Runway) — 8 combos verified, 0 counterexamples |
| `ProgressRatio` | Time-based formula | `1 − (LandingTime − saveTime) / totalApproachTime(Route)` |
| `Direction` | Path tangent | Unit vector in XZ at current path position |
| `Position.y` | 3° glideslope, path-distance, capped | `min(approachCap, remainingPathDist × tan(3°))` — continuous with State=5, approachCap always 15.24 (5000ft ÷ 100 m/unit) |
| All other fields | Invariant template | Fixed across all State=30 aircraft |

### ProgressRatio Formula

```
ProgressRatio = 1 − (LandingTime − saveTime) / totalApproachTime(Route)
```

- `saveTime` = the scenario's configured start time (config `startTime` with the
  `GameTime.CurrentDateTime` override applied by `resolveConfigTime`). The cache's
  `saveTimeOffsets` is still computed at cache-build time but the save path no
  longer reads it (`extractSaveTime` is a stub returning `null`).
- `totalApproachTime(STAR)` = route-specific total duration from STAR entry to
  touchdown (~1380-1775s, computed from route path-length estimates via
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

The total approach path in game units combines three segments from the runway route data:

```
totalGamePath = flyPathLen + procPathLen + tdDist

where:
  flyPathLen  = Σ segment distances of FlyApproach points (RouteType=0 STAR route, via resolveFlyApproachPoints)
  procPathLen = Σ segment distances of approach procedure points (RouteType=1 route, via resolveApproachProcedureData)
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
- `extractSpecificationDB(aclText)` → `Map<Designator, Spec>` — 14 designators across ZSJN+KJFK. Scans the decoded text for `Specification` objects inside jetway `DockingAircraft` entries and `RuntimeData` aircraft entries.
- `extractApproachData(aclText)` → `Array<{route, runway, progressRatio, flyPoints, appPoints, ...}>` — all State=30 aircraft. **Returns `[]`** — v4 files have no pre-spawned aircraft (the game computes state at runtime).
- `extractState5Data(aclText)` → `Array<{route, runway, touchDownPosition, approachDirection, initialPosition, pathPointList}>` — **stub returning `[]`** (v4 has no pre-spawned aircraft; final-approach parameters come from `resolveApproachProcedureData`).
- `extractTypeMap(aclText)` → `Map<number, string>` — captures all fully-qualified `$type` declarations from a file; type numbers are per-file in Unity's serialization
- `buildAppPointMap(approachEntries)` → `Map<"Route|Runway", Vector3[]>` — verified 1:1 mapping
- `buildState5ParamsMap(state5Entries)` → `Map<"runway", {pathPointList, touchDownPosition, approachDirection, initialPosition, routeName?}>` — per-runway final approach parameters; `routeName` populated from the approach procedure's `Name` field
- `computeApproachTimesFromScenery(aclText, starMappings, appPointMap, refTatMap, defaultTAT, airportScale?)` → `Map<STAR, seconds>` — per-STAR duration from PKStaticEntities route path-length estimates using three-tier estimation
- `extractGameTime(aclText)` → `seconds | null` — parse `GameTime.CurrentDateTime` ticks as seconds since midnight (returns `null` when the file has no `GameTime` section, as v4 scenario files usually don't)
- `extractSaveTime(aclText, totalApproachTimes)` → **stub returning `null`** — snapshot time is resolved from the config start time instead (see [saveTime Resolution Priority](#savetime-resolution-priority))

**Path Resolution:**
- `resolveFlyApproachPoints(aclText, route, runway)` → `Vector3[]` — via the PKStaticEntities runway → `Routes` → `AirwayNodes` `$iref` chain

**Runway Routes & STAR Mapping:**
- `extractStarRunwayMappings(aclText)` → `{starRunwayMap: {star→[runways]}, runwayStarMap: {runway→[stars]}}` — authoritative from PKStaticEntities `runway:*` entries' `Routes` (RouteType=0)
- `resolveApproachProcedureData(aclText, runway, hintPosition?)` → `{pathPointList, touchDownPosition, approachDirection, initialPosition, routeName?} | null` — resolves final approach parameters for a runway from PKStaticEntities runway `Routes` (RouteType=1); when `hintPosition` is provided and multiple variants exist, picks the closest one. Returns `routeName` from the selected procedure's `Name` field (extracted via `_extractString` from the route block).
- `_parseRunwayThresholds(aclText)` → `{[PhysicalName]: {thresholds: [{x,z}, {x,z}]}}` — runway endpoint positions via the runway's `ThresholdPoints` `$iref`s → taxiway-node positions

**Computation:**
- `computeProgressRatio(landingTimeTicks, saveTimeTicks, totalApproachTime)` → `0..1`
- `computePosition(flyPoints, appPoints, progressRatio, touchDownPosition?, approachCap?)` → `{x, y, z}` — unified path (FlyApproach + App + TouchDown) with 3° glideslope Y; exported through parser facade for `get-aircraft-positions` IPC (StarMap live aircraft dots)
- `computeDirection(flyPoints, appPoints, progressRatio, touchDownPosition?)` → unit vector — unified path tangent; also exported through parser facade
- `buildFullPath(flyPoints, appPoints, touchDownPosition?)` → combined unified path array
- `_dedupeIafJoin(flyPoints, ppList)` → flyPoints with last point trimmed if it matches the first PathPointList point (within 0.1m) — prevents zero-length segments at the IAF join that would cause NaN in interpolation
- `computePathLength(points)` → total distance
- `computeAirportScale(aclText)` → `number` — always returns `DEFAULT_AIRPORT_SCALE` (100); all axes use uniform 100 m/unit
- `computeApproachCap(airportScale?)` → `number` — always returns `APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE` (15.24); ceiling is 5000ft regardless of airport
- `computeFullTerminalPath(aclText, star, runway)` → `{flyLen, procLen, tdDist, total}` — full terminal path length in game units combining FlyApproach + procedure + touchdown segments. Passes the last FlyApproach point as `hintPosition` to `resolveApproachProcedureData` so the correct approach variant is selected when multiple exist for the runway.

**Designator Mapping & Cache:**
- `buildDesignatorMapping(aclText)` → `Map<AircraftType, Designator>` — cross-references `StaticItems` (flight-plan → Registration, AircraftType, Stand) with `RuntimeEntities`. Scans `StaticItems` for flight-plan entries then cross-references `RuntimeEntities` in two passes: **(Pass A)** `aircraft:REG` entries (Registration → Specification.Designator), **(Pass B)** `jetway:STAND` entries with `DockingAircraft.Specification.Designator` (linked via Stand → AircraftType from static-item Stand field). Jetway fallback covers aircraft whose only runtime representation is inside a jetway's `DockingAircraft`. Produces a complete map for spec lookup during save
- `buildApproachCache(airportDir)` → `{specDB, appPointMap, totalApproachTimes, designatorMap, saveTimeOffsets, typeMap, typeNameIndex, fileTypeMaps, fileTypeNameIndexes, state5ParamsMap, starPaths, runwayThresholds, airportScale, starRunwayMap, runwayStarMap, taxiwayPaths, sidRunwayMap, runwaySidMap, sidPaths, missedAppMap, runwayMissedAppMap, missedAppPaths, apprRunwayMap, runwayApprMap, apprPaths}` — scans all .acl files for an airport; the first file provides the scenery-derived maps (runway routes, taxiway paths, SID/approach/missed paths, type maps).

**Assembly:**
- `buildApproachAircraftBlock({flightPlanGuid, route, flyPoints, appPoints, progressRatio, spec, radioChannelGuid?, touchDownPosition?, approachCap?, typeNums?, acTypeNum?, nextId?})` → `{guid, block, nextId}` — State=30 `$k/$v` JSON block
- `buildState5AircraftBlock({flightPlanGuid, route, state5PR, spec, towerChannelGuid?, state5Params, flyPoints?, fullPR?, waitingForCommand?, selectedRunwayExitIndex?, typeNums?, acTypeNum?, nextId?})` → `{guid, block, nextId}` — State=5 `$k/$v` JSON block
- `buildAnimatorBlock(aircraftGuid, opts)` — builds the paired `AircraftAnimatorState` entry; `opts.typeNums` controls `animState`/`animSubState` type numbers; `opts.gearRatio` (default 1) sets `GearRatio`/`GearTargetRatio` — gear down (1) for parked and final-approach aircraft, gear up (0) for STAR approach

## Test

```bash
node --require ./tests/integration/preload.cjs tests/integration/test_approach_aircraft.js [--root <game-root>]
```

Validates all algorithms against the 8 production files: spec consistency, AppPoint mapping, ProgressRatio formula (saveTime spread), FlyApproach resolution, Position/Direction reconstruction, and block assembly.
