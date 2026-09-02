# AC27 ACL File Format & Approach Math

## Table of Contents

- [AC27 ACL File Format \& Approach Math](#ac27-acl-file-format--approach-math)
 - [Table of Contents](#table-of-contents)
 - [ACL File Format](#acl-file-format)
 - [Standard JSON-Plus Extensions](#standard-json-plus-extensions)
 - [Non-Standard JSON Syntax (handled by pre-processor)](#non-standard-json-syntax-handled-by-pre-processor)
 - [Two-Pass Parsing (`src/acl/acl_json.js`)](#two-pass-parsing-srcaclacl_jsonjs)
 - [Key Section Types](#key-section-types)
 - [Timeline Frames (Weather / Wind / Runway)](#timeline-frames-weather--wind--runway)
 - [File Schema (v4 Only)](#file-schema-v4-only)
 - [GATCARC4 Binary Container](#gatcarc4-binary-container)
 - [Odin JSON Text Dialect](#odin-json-text-dialect)
 - [v4 Structure at a Glance](#v4-structure-at-a-glance)
 - [$blobdoc Nested Document Pattern](#blobdoc-nested-document-pattern)
 - [PKStaticEntities $iref/$id Reference System](#pkstaticentities-irefid-reference-system)
 - [v4 Flight-Plan Entries](#v4-flight-plan-entries)
 - [Independent Type Numbering](#independent-type-numbering)
 - [Scope-Aware Type Expansion During Save](#scope-aware-type-expansion-during-save)
 - [Runway Routes (PKStaticEntities)](#runway-routes-pkstaticentities)
 - [SID and Missed Approach Extraction](#sid-and-missed-approach-extraction)
 - [Taxiway Segments (PKStaticEntities)](#taxiway-segments-pkstaticentities)
 - [Approach Aircraft Construction (State=30 \& State=5)](#approach-aircraft-construction-state30--state5)
 - [Unified Path Architecture](#unified-path-architecture)
 - [State=5 Sub-types](#state5-sub-types)
 - [Complete Position \& Direction Math](#complete-position--direction-math)
 - [Step 1: ProgressRatio](#step-1-progressratio)
 - [Step 2: State determination (IAF passage)](#step-2-state-determination-iaf-passage)
 - [Step 3a: State=30 Position \& Direction](#step-3a-state30-position--direction)
 - [Step 3b: State=5 Position \& Direction](#step-3b-state5-position--direction)
 - [State=5 DynamicsParams fields](#state5-dynamicsparams-fields)
 - [Summary](#summary)
 - [saveTime Resolution Priority](#savetime-resolution-priority)
 - [Verified Field Relationships (State=30)](#verified-field-relationships-state30)
 - [ProgressRatio Formula](#progressratio-formula)
 - [TAT (Total Approach Time) Computation](#tat-total-approach-time-computation)
 - [Coordinate Scale](#coordinate-scale)
 - [Full Terminal Path Length](#full-terminal-path-length)
 - [Aircraft Speed](#aircraft-speed)
 - [TAT Formula](#tat-formula)
 - [Implementation Status](#implementation-status)
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

### Timeline Frames (Weather / Wind / Runway)

The three timeline sections inside `MetaData` hold frame entries with string `Time` values (`"HH:MM:SS"`, not ticks):

- **`WeatherFrames`** — `WeatherFrame[]`: each frame is `{ "Preset": "Sunny"|..., "Time": "HH:MM:SS" }`
- **`WindFrames`** — `WindFrame[]`: each frame is `{ "Direction": <int deg>, "Speed": <int kt>, "Time": "HH:MM:SS" }`
- **`RunwayTimeline`** — `initialRunways` (string list) + `timeline` of change entries with a `Time` and a pair list

**Semantics — weather/wind frames are level-wide step settings.** A frame governs the level from its time onward, so a single frame whose time sits **outside** the scenario window `[Config.startTime, Config.endTime]` still controls the whole level. Shipped levels rely on this: `ZSJN_leisure_1.acl` (window 05:39:14–06:15:00) has wind at 05:00:00, weather at 09:00:00, and WeatherFrames spanning 06:00–24:00. Therefore the editors **never hide or bounds-check weather/wind frames** (no active-range filtering, no TimeCell min/max, no save-time validation). Only `RunwayTimeline` is window-bounded by design: out-of-window changes are auto-removed on load (`EditorScreen.jsx`) and flagged at save (`val_runway_change_bounds`). Save always writes every weather/wind frame back (`_rebuildV4TimelineSections`).

## File Schema (v4 Only)

A game update introduced the **v4 schema**; it is now the only schema. Every `.acl` file is a **GATCARC4 binary archive** (see below). When decoded, the header document has these top-level sections:

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
 [0..7] ASCII magic "GATCARC4"
 [8..11] uint32 storage version (currently 1)
 [12..15] uint32 payload length N
 [16..16+N) payload: OdinSerializer binary document
 [16+N..16+N+32) SHA-256 of payload bytes
 [16+N+32..16+N+36) ASCII commit marker "NODH"

Zero or more appended checkpoint frames:
 [0..3] ASCII frame marker "MARF"
 [4..7] uint32 storage version
 [8..11] uint32 payload length M
 [12..12+M) payload: OdinSerializer binary document
 [12+M..12+M+32) SHA-256 of payload bytes
 [12+M+32..12+M+36) ASCII commit marker "NODF"
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
 "InBlockTime": { "$type": "3|System.DateTime, mscorlib", 0 }, // computed by game
 "ActualInBlockTime": { "$type": "3|System.DateTime, mscorlib", 0 },
 "STAR": "SEY.PARCH4",
 "Runway": "31L",
 "Stand": "12"
 },
 "InitialDeparture": null // or { ... } for departures
 }
}
```

Key facts:
- `InitialArrival`/`InitialDeparture` field names (no `Arrival`/`Departure` forms exist)
- `InBlockTime` is always `0` (game computes it)
- Each leg sub-object has its own `$id` (OdinSerializer requirement for nested objects)
- The key is `flight-plan:REGISTRATION`
- `AirlineName` stores the 3-letter airline code (e.g. `"UAL"`), NOT a display name — the editor writes the callsign's code for new flights and falls back to `CallSign.substring(0, 3)` at save when empty
- The editor decides which leg to write from the internal `isDeparture` flag (set at creation; save falls back to non-empty `OffBlockTime` via `_isDepartureFlight()` in `flight_plans.js`) — exactly one leg is non-null

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
| `PhysicalName` | Runway pair — e.g. `"13R/31L"`, `"01/19"` — **v5:** nested inside `PhysicalRunwayStaticItem` (inline object or `$iref` → inline, sometimes double-indirected via `physical-runway:` PK alias). Resolved via `_extractNestedObject(block,'PhysicalRunwayStaticItem')` → `_findPhysicalNameByIref(aclText,pkIndex,iref)` (PK index + raw-text `"$id": N` scan fallback for inline ids e.g. ZSJN 01 `$iref:8541`). Top-level `PhysicalName` is fallback for pre-v5 files. |
| `Routes` | Contains `$rcontent` array of route entries, each with `Name`, `RouteType`, `AirwayNodes` ($iref array) |

**Route Types** (verified against both KJFK and ZSJN production .acl files):

| RouteType | Meaning | Example Names | Used for |
|-----------|---------|---------------|----------|
| **0** | **STAR** (arrival transition) | `SEY.PARCH4`, `UBSS6W`, `OKAL6W`, `WFG91A` | Airway dropdown filtering, StarMap availability, approach path resolution |
| 1 | RNAV approach procedure | `RNAV Y Rwy 31L`, `RNAV ILS Z Rwy 19` | State=5 approach data (`resolveApproachProcedureData`) |
| **2** | **SID** (departure transition) | `JFK5.JFK`, `TUML5T`, `BASV7Y` | Parsed by `sid_goaround.js` → `sidPaths` for AirMapWindow route display |
| 3 | Missed approach | `RNAV Y Rwy 31L (Missed Approach)` | Parsed by `sid_goaround.js` → `missedAppPaths` for AirMapWindow route display |

**Important:** The authoritative source for valid STAR↔runway combinations is the runway entry's `Routes` where `RouteType === 0`. This is a superset of what `appPointMap` covers (which is limited to State=30 aircraft entries at snapshot time).

**Extraction algorithm** (`extractStarRunwayMappings` — see approach.js, v5-aware):
1. Build the PK index (`buildPkIndex`) and iterate `runway:*` entries in `PKStaticEntities`
2. For each runway, resolve `PhysicalName` via `PhysicalRunwayStaticItem` (see above); skip if `Name` missing or `PhysicalName` present but lacks `/` (v5 fallback: `physName = runwayName` when still missing)
3. Navigate its `Routes.$rcontent` array (skip nested arrays like `comparer`)
4. For each route with `RouteType === 0`, collect `Name` (STAR name) and its `AirwayNodes` `$iref`s
5. Return `{ starRunwayMap: {star → [runways]}, runwayStarMap: {runway → [stars]} }`
6. **v5 merge in `buildApproachCache`:** the per-file maps are **merged across `allAclTexts[]`** (every `.acl` in the airport) with deduped runway lists — a single level no longer carries all runways (ZSJN `leisure_1` = only RWY19, others = only RWY01)

**v5 per-level filtering:** the area/STAR/SID/APPR/runway subsets differ per level; `buildApproachCache` merges `state5ParamsMap`/`appPointMap`/`starPaths`/`starWaypoints`/`runwayThresholds`/`sidPaths`/`missedAppPaths`/`apprPaths`/`airwayNodes` across all files (first hit or deduped, see `allAclTexts`).

## SID and Missed Approach Extraction

Follows the identical pattern in `sid_goaround.js`, operating on `RouteType === 2` (SID) and `RouteType === 3` (Missed Approach) routes. The six functions exported by `sid_goaround.js` mirror the approach.js STAR helpers (all route via PKStaticEntities runway entries — **v5:** `_extractRouteMappingsByType` now resolves `PhysicalName` via `PhysicalRunwayStaticItem` `$iref` indirection, with `resolveIref` PK index + raw-text `"$id": N` scan + double-`$iref` walk for the inline physical-runway object):
- `extractSidRunwayMappings(aclText)` → `{ sidRunwayMap, runwaySidMap }`
- `extractMissedApproachMappings(aclText)` → `{ missedAppMap, runwayMissedAppMap }`
- `buildSidPaths(aclText, sidRunwayMap)` → `{ sidName: [{x, z}, ...] }`
- `buildMissedApproachPaths(aclText, missedAppMap)` → `{ maName: [{x, z}, ...] }`
- `extractApprRunwayMappings(aclText)` → `{ apprRunwayMap, runwayApprMap }` — Approach routes (RouteType=1)
- `buildApprPaths(aclText, apprRunwayMap)` → `{ apprName: [{x, z}, ...] }`

**v5 merge:** `buildApproachCache` loops over `allAclTexts[]` for each extractor and merges the per-file maps/paths with runway-dedup (same as STAR merge) — `sidPaths`/`missedAppPaths`/`apprPaths` are built per-file then merged.

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

## Areas (NonPKStaticEntities) — v5 type 30→31

Areas live in `StaticData.$blobdoc.NonPKStaticEntities.$rcontent` as type `ContextCross.Models.Area` — **v4 = 30, v5 = 31**. `scenery.js:_parseAreas` checks the name substring first (`entryBlock.includes('ContextCross.Models.Area')`) then falls back to numeric `30|31` for both bare (`30`) and quoted (`"30|ContextCross.Models.Area,..."`) `"$type"` forms. Hard-coded `30` is gone. Fields: `AreaType` (0=boundary,1=apron,2=building), `NodePositions` Vector3 ring. `areaData` in `buildApproachCache` is not yet merged — ground painter uses the first file's areas.

**Writing a NEW Area — inner `List<Vector3>` `$type` gotcha (do not reintroduce):** when the Ground Painter adds an area, `scenery_write.js:_sampleAreaShapes(npkEntries)` samples the ambient Area entity so the synthesized entry reuses the exact `$type` ids/strings. The inner `NodePositions` List object is serialized as `{ "$id": N, "$type": T, "$rlength": L, "$rcontent": [...] }` — the `$id` wrapper **precedes** `$type`. A regex that requires `$type` to be the first key (e.g. `/\{\s*"\$type":\s*("[^"]+"|\d+),\s*"\$rlength"/`) fails, leaving `s.listType === null`; `_fmtType(null)` then emits `$type: 0`. Type id `0` is a *valid* numeric ref to `ContextCross.Saves.SaveSystem+ArchiveHeader` (always registered), so `readJson` does **not** throw — Unity instead tries to deserialize the `List<Vector3>` polygon **as an ArchiveHeader** and fails with `InvalidOperationException: Invalid Area static entity` (the misread array surfaces earlier as `Entry of type "StartOfArray" in node "" is missing a name`). The listType regex must allow the optional `$id` prefix (`/\{\s*(?:"\$id"\s*:\s*\d+\s*,\s*)?"\$type":\s*("[^"]+"|\d+),\s*"\$rlength"/`). `_sampleAreaShapes` also hard-codes fallback `$type` strings (Area → the `31|ContextCross.Models.Area` string form, the ReactiveProperty → the `32|R3.ReactiveProperty` List<Vector3> form, the inner List → the `33|System.Collections.Generic.List` List<Vector3> form; `vecType` fallback `5`) so a file with **no** existing Area to sample (adding the very first area) never emits `$type: 0`. The `_synthesizeArea` shape is `{ "$id", "$type", "NodePositions": { "$id", "$type", { "$id", "$type", "$rlength", "$rcontent": [Vector3...] } }, "AreaType", "Enabled": true }`.

## Ground Painter — id-free Scenery Graph (read/write)

The Ground Painter edits static scenery through an **id-free Graph** — it never stores `$id`/`$iref`/OsmId as primary keys. Persistence is centralized at write time only, and the writer is **lossless** (unrelated sub-fields the Graph does not model survive byte-for-byte).

**Two modules (both CommonJS, both `require()`d directly by `electron/main.js` — NOT re-exported through the `parser.js` facade):**

### Read path — `src/acl/scenery_graph.js`

`buildSceneryGraph(text)` returns `{ graph, meta }`:

```js
graph = {
 nodes: [{ x, z, type?, flags? }], // canonical taxiway-nodes (incl. stand nose/tail, runway thresholds, curve mids) — SHARED, deduped by coordKey
 segments: [{ aIdx, bIdx, nodeIdxs?, name?, flags?, directed? }], // one logical taxiway per entry (nodeIdxs = full ordered polyline)
 runways: [{ thAIdx, thBIdx, names: [nameA, nameB], name?, physicalName?, width?, entries?, exits? }], // one entry per PhysicalName PAIR (01+19 collapse to one); names[0]↔thA, names[1]↔thB; entries/exits = the directional Entries/Exits tables aggregated from BOTH runway blocks (see below)
 areas: [{ areaType: 0|1|2, points: Vec2[], owner: null|{kind, idx} }],
 stands: [{ noseIdx, tailIdx, heading, pushbackIdxs[], parkingType?, egressType? }],
};
meta = { nodeOrigPk:[], segOrigPk:[], runwayOrigPk:[], areaOrigId:[], standOrigPk:[] };
```

- All refs are **indices into `nodes`**; a node is SHARED by coordinate (`coordKey(x,z) = x.toFixed(6) + ',' + z.toFixed(6)`, ≈1e-6 eps). Moving one node's `x/z` moves every incident segment/runway/stand that references that index.
- Reads `Flags`/`Type` via `extractIntFromV4` **raw** (preserves `0` — the `taxiway.js:50 ||1` default would turn a real `Flags:0` into `1`, breaking the no-touch invariant).
- Runway pair collapse: `runway:01` + `runway:19` share `PhysicalName` (`"01/19"`) → ONE graph runway with both thresholds (see the `PhysicalRunwayStaticItem` indirection below for **v5** resolution; top-level `PhysicalName` is the v4 fallback).
- `areas` are parsed via a `_parseAreasIntoGraph` equivalent (name-check `ContextCross.Models.Area` then numeric `30|31`, `points.length >= 3`); `owner` is `null` on read (auto-pavement ownership is reconstructed by `rebuildOwners`).
- `meta` is parallel to the Graph arrays: `*OrigPk`/`origId` = the object's original `$k`/`$id` (or `null`). Survivors reuse these ids at write; new objects allocate fresh. `meta` additionally carries `runwayOrigInfo` (parallel to `runways`: `{pks:[], physicalName, names, width}` — how the writer detects survivor runway **name/width** edits) and the explicit-delete flags `deletedPks` (PK `$k`s) / `deletedAreaIds` (NonPK `$id`s). `meta.nodeOrigPk[i]` being `null` (or the graph array longer than `meta`) marks a **new** object to synthesize.
- Helpers: `getBlobTypeMap(text)` (scans the `StaticData.$blobdoc` region for the `$type` table — numbers are per-blobdoc, never hard-code), `coordKey`/`findNodeIndex`, `emptyGraph`, `cloneGraph` (`structuredClone`), `rebuildOwners(graph)`.

### Write path — `src/acl/scenery_write.js`

`patchSceneryBlob(snapshotText, graph, blobTypeMap, meta, opts?)` → `newText` (no disk I/O). The optional `opts.warnings` array collects **non-fatal** problems (an entity that had to be dropped, a dangling ref that was reported) as `{ key, params, text }` — see "Save warnings" below:

1. Locate `PKStaticEntities`/`NonPKStaticEntities` `$rcontent` + `$rlength` ranges via the tokenizer; split the arrays into raw entry blocks.
2. **Allocation (centralized, write-time only):** survivors (`meta.origPk != null`) **reuse** their original `$k`/`$id`/OsmId even if coordinates moved; new objects get `max $id + 1` (new nodes + taxiways use a **fresh-negative OsmId** to avoid colliding with file OsmIds). Ids are never derived from array index.
3. **Lossless no-op:** if there are no removals, no new elements, no moved nodes, no moved areas, **no dangling-ref gate repairs (`refGateDirty`) and no crash-class dangling refs in the input (`crashDangleCount === 0`)**, `patchSceneryBlob` returns `snapshotText` unchanged — **but it still reconciles the checkpoint frame's physical-runway AND jetway runtime entities** (see step 9), so re-saving an already-corrupt file self-heals.
4. **Rebuild:** every surviving entry is kept **verbatim** (so runway `Routes`/`HoldingAreas`/`Entries`, stand `TaxiwayNode[]`, `PhysicalName`, etc. survive byte-for-byte); explicitly-deleted entries (via `meta.deletedPks`/`deletedAreaIds`) are dropped; moved survivor *node* `x/z` AND moved survivor *area* vertex/body coordinates are patched in place — node via `_patchNodePosition` (`movedByPk`), area via `_patchAreaPoints` (detected by diffing each survivor's graph `points` against its original `NodePositions.$rcontent`; `_patchAreaPoints` rebuilds `$rcontent`, preserving the ambient `$type` and the wrapper `$id`s and updating `$rlength`). New nodes/segments/stands/runways/areas are synthesized (sampling the exact ambient `$type` strings from the file) and appended. `$rlength` counters are recomputed.
5. **Manual removal, not inference:** deleted entries are only those the painter explicitly records (`meta.deletedPks`/`deletedAreaIds`); the Graph omitting an entry (e.g. a positionless node) never deletes it.
6. **Taxiway ordinal contiguity (`_renumberTaxiwaySegmentOrdinals`, rebuild path only):** Unity requires each taxiway visual path (all `taxiway-segment:<osm>:<ord>` entries sharing one OsmId) to have **contiguous ordinals starting at 0**. Deleting only *some* sub-segments of a multi-segment taxiway leaves a gap in the survivors (e.g. `1481:1..21` after `1481:0` is removed), which Unity rejects with "non-contiguous ordinal N; expected M". `patchSceneryBlob` groups surviving taxiway-segment entries per osm (ordered by current ordinal, which encodes the path's segment sequence) and rewrites the `$k`/`PK` ordinal suffix back to `0..N-1`. Runways/stands need no equivalent (their keys are by name/identifier). Idempotent for already-contiguous files. Applied only in the rebuild path — the **lossless no-op early-return does not renumber**, so re-saving a file that was already gapped on disk (with no further edit) does not heal it.
7. **Orphan taxiway-node GC preserves shared end nodes:** deleting a taxiway segment GCs its now-unreferenced `taxiway-node`s but **keeps any end node still used by another taxiway/runway/stand**. `GroundPainter.jsx:deleteSelected` (`src/components/EditorScreen/GroundPainter/GroundPainter.jsx:1246`) collects the deleted segment's `nodeIdxs`, checks each node against remaining `segments`/`runways`/`stands`, and only splices orphan nodes from `graph.nodes`/`meta.nodeOrigPk` (pushing original `PK` to `meta.deletedPks` when `origPk != null`; higher indices are decremented for all surviving refs including `meta.runwayPavement`). Curve interior nodes (exclusive) are removed, chain-shared endpoints (e.g. `n0-n1-n2` deleting `n0-n1` keeps `n1`) and runway/stand-shared nodes are preserved. The writer still only removes nodes listed in `deletedPks`; nodes shared with non-painter entities (jetway/route) are intentionally never considered orphan because they are still incident to a surviving painter entity.

7b. **Taxiway visual-path continuity — split pavement stays ONE OsmId (`parentOsm` + `_orderSegmentsForPath`):** a runway's pavement is a **visual path** — all `taxiway-segment:<osm>:<ord>` entries sharing one `OsmId` — and Unity rejects a path whose pieces don't form a continuous chain (`Taxiway visual path 'N' is discontinuous`). When the painter draws a taxiway onto a pavement strip, the auto-slice **splits** that strip at the junction node; the two pieces were being synthesized as brand-new taxiways with fresh negative OsmIds, so the strip's own path lost its middle segment and failed the continuity check. The fix: `GroundPainter.jsx`/`fillet.js` carry the parent strip's OsmId (`osmFromSegPk(pk)` → `parentOsm`) onto every split piece (`seg.parentOsm`), and `scenery_write.js:_synthesizeNew` re-emits a split piece under **that** OsmId (as a later ordinal of the SAME path) instead of minting a fresh one — a genuinely-new taxiway (no `parentOsm`) still gets a fresh `minOsm-1`. Then `_renumberTaxiwaySegmentOrdinals` groups by OsmId and **walks the chain** via `_orderSegmentsForPath` (endpoint-adjacency walk from a terminus) to place each split piece at its true ordinal before renumbering `0..N-1`, so walking order — not stale `oldOrd` — determines the sequence. Covered by `tests/integration/scenery_taxiway_split.test.js` (OSM 50095 `01/19` split → still continuous, new taxiway → fresh OsmId).

7c. **PK static-entity type regroup (`_pkTypeOrder` + `_regroupPkByType`):** the game serializes `PKStaticEntities.$rcontent` grouped by entity type in a fixed order (`taxiway-node`, `taxiway-segment`, `airway-node`, `airway-segment`, `runway`, `stand`, `taxi-navigation`). The rebuild used to keep survivors in place and **append** synthesized objects at the tail, so a newly-drawn `taxiway-node` landed AFTER every `taxi-navigation` entry, breaking the grouping. `patchSceneryBlob` now calls `_regroupPkByType(finalPkOut, _pkTypeOrder(sourceEntries))` after synthesis/renumbering: bucket by `typePrefix` (`_entryTypePrefix`), concatenate buckets in the source file's first-appearance order padded with `PK_TYPE_ORDER` (so a type absent from the file — e.g. a brand-new runway — still gets a deterministic slot), stable within each bucket (original node indices stay stable across a re-parse because new nodes append to their type's block; `runway`/`stand` blocks are NOT key-ordered, so original order is preserved). Covered by `tests/integration/scenery_type_regroup.test.js` (no-touch byte-identical, original file already canonical, added node/segment lands in the right block).

7d. **Runway Entries/Exits — distinct array vs element type ids + painter checkbox (`runwayAccess.js` + `_sampleRunwayInnerType` + `_assertSampledType`):** each directional runway block (`runway:01`/`runway:19`) carries two tables: `Entries` (`Runway+Entry[]` → `Runway+Entry`) and `Exits` (`Runway+Exit[]` → `Runway+Exit`). The **array wrapper** and the **element** are DISTINCT Odin types and must use different type ids; a hardcoded fallback that reused the same id for both caused `Type id N claimed by both "Runway+Entry[]" and "Runway+Entry"` on encode. `buildSceneryGraph` aggregates both directions into the collapsed physical runway (`rw.entries`/`rw.exits` — each `{name, runwayName, holdingIdx, lineUpIdx/exitIdx, defineIdx, isLeft}` plus raw `$iref`s) and snapshots `meta.runwayEntriesOrig` for the writer's dirty-check. The painter's checkbox panel (`src/components/EditorScreen/GroundPainter/runwayAccess.js`, pure) is gated ONLY on a **physical connection** (the taxiway shares a graph node with the runway's coupled pavement-strip chain — `getRunwayPavementNodes` prefers the **live graph** name-match with `meta.runwayPavement` fallback so a junction created by splitting the strip counts even when the snapshot is stale; a name match against an existing entry is NOT a connection, eligibility ignores the taxiway name, toggling requires one, and `toggleRunwayAccess` patches node `Type`/`Flags` and keeps `entries`/`exits` direction-grouped on runway rename). Save re-serializes both directional wrappers via `_buildEntriesWrapperForPatch`/`_buildExitsWrapperForPatch` and samples the inner element ids with `_sampleRunwayInnerType` (regex over `Entries`/`Exits` `$rcontent` first element's `$type`, filtered by `_typeId`, required to differ from the array id); `_sampleRunwayShapes` no longer falls back to hardcoded ids, and `_assertSampledType` **asserts** (`no fallback allowed`) for every type the synthesized runway emits — a file that cannot supply a type refuses to emit a guessed id. When one direction's Entries change, BOTH directions are re-serialized so the shared element type stays declared for the sibling (bare `$type` refs would otherwise orphan). Also patches `Type`/`Flags` for entrance/exit holding nodes and keeps `runwayEntriesDirty` / `hasTypeChanges` in the no-op gate. Covered by `tests/components/EditorScreen/GroundPainter/runwayAccess.test.js` (6, eligibility + physical-only listing) and `tests/integration/runway_entry_type_id.test.js` (8, distinct ids + no-fallback asserts + encode + sibling re-serialization).

8. Final `$id`/`$iref` renumbering is done **only** by `writeAcl` → `renumberAclIds` — never inside `patchSceneryBlob` (double-renumber corrupts).

8.5. **Survivor dangling-`$iref` gate:** deleting a `taxiway-node` in the painter puts its PK in `meta.deletedPks`, so the writer drops it — but **survivor entries are copied verbatim** (step 4), so a survivor `taxiway-segment`/`stand` that still `$iref`s the deleted node serializes a reference the game resolves to null (`ContextCross.Factories.TaxiwaySegment2DFactory` NullReferenceException at level init — the ZSJN_leisure_1 crash, `$iref:2004`/`$iref:2040`). Nothing else repairs it: a *synthesized* entity has its node refs null-filtered at build time, a survivor does not. `_gateSurvivorDanglingRefs(pkEntries, pkDelete, deletedIds, warnings)` runs **before** `_cascadeOrphanEntries` (so a gate-dropped stand's ids are already in `deletedIds` and its jetways cascade too) and repairs each survivor `taxiway-segment`/`stand` in this order:
 - **1. Rewire** each dead ref to a live `taxiway-node` at the **same coordinate** (co-located junction twins are geometrically identical). `deadNodeCoord` is built from the deleted `taxiway-node` entries, `liveIdByCoord` from the non-deleted ones (first wins); the rewrite is `entry.replace(/\$iref:<deadId>(?!\d)/g, '$iref:<twin>')`.
 - **2. Excise** whatever is still unrepairable from the entry's `$rcontent` list, but only when `totalRefs - unrepairable >= 2` (a polyline needs both ends). `_exciseIrefFromRcontent(entry, deadId)` strips either the ref plus its following comma (`$iref:N ,` — the `trailingRe` branch, tried first) or the preceding comma plus the ref (`, $iref:N` — the `leadingRe` branch, the last element of the list), and decrements the `"$rlength"` that declares **this** list — the **last** `"$rlength"` before the `"$rcontent"` key, since a list serializes as `{…, "$rlength": N, "$rcontent": […]}`. It returns `null` (→ drop path) when the ref is not a list member at all — a stand's bare `NosePosition`/`TailPosition` property — or when the ref still appears in the span after one substitution (a duplicated ref).
 - **3. Drop the whole entry** for anything still unrepairable, **or** when a rewire would collapse the polyline onto a single node (`degenerate`: every surviving ref in the entry's `Nodes` list points at the same id — a self-loop the game's edge validator refuses).

 The function returns `dirty` when it changed anything, and that flag defeats the step-3 lossless no-op early-return so the repairs actually get serialized.

8.6. **Final dangling-`$iref` validation (last line of defence):** after every repair/type-fix stage and **before** the final arrays are joined back into text, `patchSceneryBlob` collects the flat declared-id set of the whole document — `_collectDeclaredIds` over `_textOutsideListSpans(snapshotText, ranges)` (the document **minus** the three managed list bodies, whose ids this writer never touches but which legally declare ids that PK entries may reference) plus the emitted PK/NPK/SI arrays — and then, in up to **16 passes to fixpoint**, drops every `taxiway-segment`/`stand` entry that still `$iref`s an undeclared id (the crash class). A following **report-only** pass emits a warning for every remaining dangling owner of any kind (`PK`/`NonPK`/`StaticItems`) instead of dropping it — dropping a `taxi-navigation` node would cascade-delete the shared sub-objects it declares and nuke the whole graph, so those are surfaced, not removed. If anything was dropped, `_renumberTaxiwaySegmentOrdinals` runs again so each per-osm group stays contiguous. `crashDangleCount` (the same count over the *input* emitted arrays, computed just before the no-op check) makes a file that was **already** corrupt before this save go through the rebuild path and get healed, rather than being re-committed verbatim by the early return. Both stages push `{ key, params, text }` warnings into `opts.warnings`.

9. **Checkpoint-frame physical-runway reconciliation + runway-name cascade:** a GATCARC4 `.acl` may be multi-segment: a header document plus `$$$ GATCARC4 CHECKPOINT FRAME $$$` segments, each an independent Odin `$blobdoc`. The checkpoint frame snapshots **runtime** state (`RuntimeData.$blobdoc.RuntimeEntities`), which includes a `PhysicalRunway` runtime entity per physical runway, keyed `physical-runway:XX/YY`. Unity reconciles RuntimeEntities against the static `StaticItems` on load, so two edit classes were previously corrupting the file:
 - **Runway delete** → the static `StaticItems` lost the `physical-runway:XX/YY` key, but the checkpoint frame kept the runtime `PhysicalRunway` entity → `InvalidOperationException: PhysicalRunway: static item 'physical-runway:XX/YY' does not exist in CurrentLevel.StaticField.StaticItems`.
 - **Runway rename** → the rename updated the runway entity + static key, but flight-plan `"Runway"`, aircraft `"RelatedRunway"`/`"_departureRunway"`/`"_arrivalRunway"`, and the `InitialRunways` string[] kept the **old end name** → `NullReferenceException` in `Dynamics.RestoreRuntimeData` when a flight referenced a runway that no longer existed.

 `patchSceneryBlob` now calls `_reconcilePhysicalRunwayFrames(out, validPhysKeys, physPatchMap)` **and** `_remapRunwayNameFields(out, oldNameToNewName)` in the rebuild path (and reconciles the frame even on the lossless no-op path). `_reconcilePhysicalRunwayFrames` walks every segment's `RuntimeEntities.$rcontent`, drops `physical-runway:*` entries whose key is no longer in the static `StaticItems` (`validPhysKeys`, derived via `_physKeysFromEntries(siOutFinal)`), renames entries remapped by `physPatchMap` (old → new physical-runway key from a runway rename), and updates `$rlength`. `_remapRunwayNameFields` cascades a renamed end name to **any** Runway/RWY-keyed string field (a field is a runway-name field when its key contains `Runway`/`RWY`, case-insensitive — covering `"Runway"`, `"RelatedRunway"`, aircraft `"_departureRunway"`/`"_arrivalRunway"`; the `oldNameToNewName` map is built from the per-PK `runwayPatchInfo` entries' `oldName`/`newName`), plus the `InitialRunways` `System.String[]` (`$rcontent` entries equal to the old name). Stand ids, entity `Name`/`Identifier`, and dictionary `comparer` keys (which mix runway and stand names) are deliberately **not** touched. All exports are tested in `tests/integration/scenery_physical_runway_cleanup.test.js`. A one-shot repair for a file already broken by a pre-fix save lives at `scripts/repair_runway_rename.js`.

 **Checkpoint-frame jetway reconciliation:** the checkpoint frame also snapshots a `Jetway` runtime entity per stand, keyed `jetway:NN`. When the painter deletes a stand, `_cascadeOrphanEntries` already dropped the stand's `jetway:*` **static** items from the header `StaticItems` (a jetway follows its stand) — but the checkpoint frame's `jetway:*` **runtime** entity survived, so Unity threw `InvalidOperationException: Jetway: static item 'jetway:NN' does not exist in CurrentLevel.StaticField.StaticItems` (reference integrity is broken) and self-healed by deleting the stand + all its aircraft. The physical-runway reconcile was physical-runway-only, so there was no equivalent for jetways. The reconcile is now **generalized**: `_reconcileRuntimeSegment` / `_reconcileRuntimeFrames` take a list of reconcilers `{ prefix, validKeys, patchMap }` and drop any runtime entity whose `$k` prefix no longer has a backing static key. `_reconcilePhysicalRunwayFrames` (with its optional `physPatchMap` rename) and the new `_reconcileJetwayFrames` are thin wrappers over it; `_runtimeReconcilers(siEntries, physPatchMap)` builds the combined list (`physical-runway` with the rename map + `jetway` with no rename), so **one pass cleans both staleness classes**. Both save paths call it: the rebuild path and the lossless no-op path (self-heal of a file already broken by a pre-fix save). `_jetwayKeysFromEntries(siEntries)` derives the valid static jetway keys. Covered by `tests/integration/scenery_delete_cascade.test.js` (stand-deletion now drops the jetway runtime entity from the checkpoint frame, and a no-op save repairs an already-corrupt frame).

 **Taxiway–runway name coupling:** a physical runway is drawn NOT only as `runway:*`/`physical-runway:*` entries but also as a set of `taxiway-segment` pavement strips whose `Name` field is the runway's **physical** name (verified in ZSJN: runway `01/19` is coupled to 9 `taxiway-segment` entries whose `Name === "01/19"` — the runway-parallel pavement strips, one `OsmId` per segment). Flight plans/aircraft reach a runway by **end** name (`"01"`/`"19"`, handled by `_remapRunwayNameFields`), but these strips are named by the **whole physical pair**, so a runway rename/move must also rewrite them or the strips keep pointing at the old physical runway. `patchSceneryBlob` therefore also calls `_remapTaxiwaySegmentName` over the rebuilt/renumbered PK entries with an `oldPhysToNewPhys` map (built alongside `oldNameToNewName` from `runwayPatchInfo`'s `oldPhys`/`newPhys`). It rewrites the `Name` of a `taxiway-segment` entry when it exactly equals the old physical name — and, as a fallback, when it exactly equals a renamed **end** name (for the rare taxiway named after a single end, e.g. `"01"`). Matching is exact against the whole quoted `Name` value, so the end-name map never trims `"01"` out of `"01/19"`. Non-`taxiway-segment` entries (stands, etc.) and the renumbering pass are untouched.

 **Geometric runway–pavement coupling (painter):** the pavement strip chain is collinear with the runway but shares **only the 2 threshold nodes** with it — its ~18 other nodes are the strip's own. So moving a runway needs an affine reproject, not just name remapping. `buildSceneryGraph` records `meta.runwayPavement` (parallel to `graph.runways`): the graph-node indices of each runway's strip chain (segments whose `Name` === the runway `physicalName`). The painter couples them: `GroundPainter.jsx` has `runwayPavement(graph, meta, rwIdx)` (returns the strip node set + the runway's ORIGINAL threshold axis; prefers `meta.runwayPavement` for index stability across a mid-session rename, with a live Name-match fallback for a runway added this session) and `reprojectOnRunwayAxis(p, a0, b0, a1, b1)` (rigid motion preserving along-axis distance + perpendicular offset — handles translate, rotate and reshape). `applyDrag` carries the coupling in the drag-ref for both a threshold `node` drag and a whole-runway `body` drag: it moves the thresholds (existing node/body path) and reprojects every **non-threshold** strip node onto the new axis, so the pavement follows the runway. `commitRunway` (add runway) also synthesizes the collinear pavement strip: a `taxiway-segment` named after the physical runway with the two threshold nodes **plus a 0.6-unit overhang node past each end** (the real ZSJN strips poke out past the runway ends — that is what makes them visible, since the black runway rectangle draws on top of the centerline), `flags: 2` (wider), referencing the runway's own threshold nodes so it moves with them. It extends `meta.nodeOrigPk`/`segOrigPk`/`runwayOrigPk`/`runwayPavement`/`runwayOrigInfo` in lockstep (the write path's length-mismatch detection + `_synthesizeNew` synthesize the new nodes/segment/runway pair). `commitGraph(newGraph, newMeta)` was extended to accept a new meta; `deleteSelected` splices `runwayPavement`/`runwayOrigInfo` alongside the existing parallel arrays. Strip nodes are ordinary `taxiway-node` survivors, so `patchSceneryBlob`'s `movedByPk`/`_patchNodePosition` persists moved strip nodes; a new runway's strip is synthesized as a new segment. **Selection:** in the painter's Select tool (`onClick`), segments whose `Name` === a runway's `physicalName` are **skipped** from the segment candidates (they are the runway's own collinear pavement strips and run exactly along it, so they'd otherwise out-bid the runway), so a click on the runway always selects the runway — while the *connector* taxiways that merely meet the runway at a junction node (A, B, C, D, F, G, A1, A14) are unaffected and remain selectable. Regression coverage lives in `tests/integration/scenery_physical_runway_cleanup.test.js` ("runway↔pavement geometric coupling"): `makeText()` carries a 3-node coupled strip (9001:0) + an unrelated strip (9000:0) so the suite asserts `meta.runwayPavement` population, a moved runway persisting reprojected collinear strip nodes, and an added runway persisting a collinear strip named after the physical runway. (Vitest cannot run in this sandbox — a Vite child-process EPERM — so the same cases are validated via Node harnesses that round-trip `patchSceneryBlob` → `writeAcl` → `readAclText` → `buildSceneryGraph`.)

`saveGroundPainterAcl({filePath, snapshotText, graph, createBak, blobTypeMap})` → `{success, error?, newText?}`: validates `graph.runways.length !== 0` (rejects a 0-runway save), calls `patchSceneryBlob`, optionally copies `filePath + '.bak'`, then `writeAcl(filePath, newText, {format:'auto'})`. **Note:** the actual `save-ground-painter-data` IPC handler in `electron/main.js` does **not** call this wrapper — it inlines the same steps (`patchSceneryBlob` → `fs.copyFileSync(filePath, filePath+'.bak')` when `createBackup` → `writeAcl`). `saveGroundPainterAcl` is exported from `scenery_write.js` for direct callers/tests, and the renderer's Save prompt passes `createBackup` from the `.bak` checkbox (`groundPainterCreateBak`, default true). **Caveat:** `saveGroundPainterAcl` calls `patchSceneryBlob(snapshotText, graph, blobTypeMap)` **without `meta`**, so it cannot detect survivor edits (moved nodes/areas, runway renames, deletes) and effectively returns `snapshotText` unchanged — only the inlined IPC handler (which passes `meta`) persists edits.

**Delete persistence (renderer `GroundPainter.jsx` `deleteSelected`):** deleting a selected object records the removal so the write-back actually drops it — it pushes the removed object's original key into `meta.deletedPks` (segment/runway/stand) or its original id into `meta.deletedAreaIds` (area), **and** splices the parallel `meta` array (`segOrigPk`/`runwayOrigPk`/`standOrigPk`/`areaOrigId`) so `meta` stays index-aligned with the Graph; it commits graph+meta together with a depth-1 history for Ctrl+Z. This is what makes a taxiway delete *persist* (before the fix the graph was spliced but `meta` was untouched, so `patchSceneryBlob`, which only deletes entries listed in `deletedPks`/`deletedAreaIds`, kept the entry and the delete silently reverted). Deleting a taxiway segment additionally GCs orphan `taxiway-node`s but preserves shared end nodes (see step 7 above — incident check against remaining `segments`/`runways`/`stands` with descending splice + index remap); runway/stand/area deletes do not GC nodes. The MCP delete path (`delete_ground_objects`) records `meta.deletedPks`/`deletedAreaIds` the same way, so MCP-driven deletes persist through this write path as well.

**Ghost-node invariant — a NEW entity must never reference a node that will not be written:** a node whose original PK was pushed into `meta.deletedPks` (orphan GC after a taxiway delete, a fillet's ghost-deleted O node, a virtual-fillet split) is a **ghost**: it stays in `graph.nodes` on purpose so every other entity's index remains stable, but `patchSceneryBlob` will not emit it. A **new** entity — one the writer re-synthesizes, i.e. `meta.segOrigPk`/`standOrigPk`/`runwayOrigPk` is `null` — that still points at a ghost index serializes as `"$iref:null"`, which the Odin JSON reader rejects (`invalid $iref payload "null"`) and which **aborts the entire save**. `src/components/EditorScreen/GroundPainter/fillet.js` now owns the invariant with two exports: `ghostNodeIndices(graph, meta)` (the ghost index set — `meta.nodeOrigPk[i] != null && meta.deletedPks.includes(meta.nodeOrigPk[i])`, with the deleted set defaulted when `meta.deletedPks` is absent) and `repairGhostRefs(graph, meta)` → `{remapped, dropped, warnings}`, which re-points new segments/stands/runways onto a **live node at the same coordinate** (duplicate nodes at a snap point are geometrically identical, so the shape is preserved) and drops what cannot be repaired (`ground_painter_fillet_dropped_leg` / `_stand` / `_runway`). It also treats a **stale index** — a node spliced out while a reference to it survived — as unresolvable, because the save-time outcome is identical. **Survivor entities are deliberately skipped** (`isNew = (arr, i) => !arr || arr[i] == null`): the writer copies them verbatim from the snapshot, so rewriting their indices would silently not persist; that class is handled by the dangling-ref gate (step 8.5) instead. Call sites: `commitFillet`, immediately after ghost-deleting the O nodes (at a T junction the arms often use co-located twins, which is exactly what used to leave a new leg pointing at a deleted node — it resolves each O through `liveEquivalent`), and `GroundPainter.jsx:save()` as a pre-save guard, where any repair is logged via `console.error` because it means an earlier edit left the graph inconsistent. The writer backs the invariant up: `_synthesizeSegment` / `_synthesizeStand` now **return `null`** (the caller drops the entity) instead of emitting a null node ref, and `_synthesizeNew` skips a new segment/stand whose endpoint nodes no longer resolve, emitting `ground_painter_writer_new_segment_dropped` / `..._new_stand_dropped`. Covered by `tests/integration/ghost_ref_invariant.test.js`.

**Runway end-name editing & save-time validation (renderer, `GroundPainter.jsx`):** runway end `names` are edited in floating on-canvas text boxes at each threshold (`runwayOverlay`) — plain `type="text"` `maxLength={3}` inputs with **no in-place validation/normalization** (`updateSelectedRunwayNames` stores the raw string via `String(newNames[i] ?? '')` and recomputes `physicalName = names.join('/')`, so a box can be cleared to empty while typing). The toolbar has **no** runway end-name editors. Before the save IPC, the renderer `save()` validates every runway's names against `^[0-9]{2}[A-Z]?$` (two digits, optionally one capital letter, e.g. `27`/`27L`); an invalid name blocks the save and surfaces i18n `ground_painter_validation_runway_name` via `setGpError`. The global `keydown` handler ignores `Delete`/`Backspace`/`Escape`/`Ctrl+Z` while focus is in a text/edit field (`isTextEditTarget`), so typing or clearing a name box never deletes the selected runway.

**Frozen geometry constants** (single source — `src/utils/constants/map-config.js`, never re-read per file): `TAXIWAY_HALF_WIDTH=0.15`, `TAXIWAY_ENDCAP=0.10`, `RUNWAY_WIDTH=0.50` (full; renderers halve it), `RUNWAY_EDGE_OFFSET=0.58`, `RUNWAY_TOUCHDOWN_FRAC=0.20`, `STAND_LENGTH=0.63`, `STAND_RECT_HALF_LEN=1.2`/`_WID=0.9`, `PUSHBACK_OFFSET_1=0.45`/`_2=0.85`, `HOLDING_RECT_LEN=0.40`/`_WID=0.35`/`HOLDING_OFFSET=0.60`, `RUNWAY_IS_ACTIVE`. Consumption differs per module: `scenery_graph.js` (`rebuildOwners`/`_frozenDims`) pulls them via `src/acl/constants.js` (the CJS re-export) with hard-coded fallback defaults; `scenery_write.js` does **not** import them at all — it falls back to its own constants (`rw.width ?? 0.50`, `parkingType ?? 1`); the painter UI `GroundPainter.jsx` imports `map-config.js` directly.

**IPC + snapshot scope:** `electron/main.js` exposes `load-ground-painter-data` (re-reads `currentPath` via `readAclText`, builds the Graph in the **main process** — the renderer can't reliably dynamic-import the CJS acl module) and `save-ground-painter-data` (returns the new baseline text for `groundPainterSnapshotText`). The painter snapshots only `currentPath`, a **per-level subset** (other levels' runways/areas stay in their own files and are merged by `buildApproachCache`), so a painter save needs **no cache invalidation** (no `CACHE_VERSION` bump). `electron/preload.js` exposes `loadGroundPainterData`/`saveGroundPainterData`.

**Save warnings — a successful save can still lose geometry, so it says so.** `main.js`'s `save-ground-painter-data` now passes `{ warnings }` into `patchSceneryBlob` and returns it next to `newText` and `geoResult` (also `console.warn`ed in the main process). A warning is **structured** `{ key, params, text }` because the writer runs in the Electron main process where **no translation context exists**: `key` + `params` drive renderer-side i18n, and `text` is the plain-English rendering used for the main-process log and as a display fallback. `GroundPainter.jsx:writerWarningText(w)` translates via `t(w.key, w.params)` and falls back to `w.text` when the key is missing from the dictionary (i.e. it returns the key unchanged). On `res.warnings.length > 0` the renderer shows a **`ground_painter_saved_with_warnings`** modal listing each translated warning, then closes — the new baseline from `res.newText` is still installed, because the save really did succeed. Warning keys emitted by the writer: `ground_painter_writer_gate_rewired`, `..._gate_excised`, `..._gate_dropped_collapse`, `..._gate_dropped_unrepairable`, `..._new_segment_dropped`, `..._new_stand_dropped`, `..._last_resort_dropped`, `..._dangling_report`. Separately, `save()` now reports IPC failures through `ground_painter_save_failed` (`{{msg}}`) instead of a hard-coded English string, and runs `repairGhostRefs` on the graph before every save.

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

**Stored PR for State=5:** The editor's save path (`_buildStandaloneAircraftEntry`)
writes a **constant `ProgressRatio: 0`** for State=5 aircraft. The game recalculates
path-based PR from `PathPointList` for final-approach aircraft, so the stored value is
pinned to `STATE5_OUTPUT_PROGRESS_RATIO` (0) — the same value the legacy
`buildState5AircraftBlock` builder has always emitted. Position/direction are still
computed with the real time-based `fullPR` (see Step 3b). State=30
(FlyApproachDynamicsParams) stores the full-approach PR.

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
timeToLanding = landingTime - saveTime [seconds]
TAT = totalApproachTimes[star] [seconds]
progressRatio = 1.0 - timeToLanding / TAT [0.0..1.0]
```

**Gate:** Only generate AircraftState if `0.0 < progressRatio < 1.0`.

#### Step 2: State determination (IAF passage)

The state is determined by whether the aircraft has passed the IAF (last FlyApproach waypoint):

```
flyLen = Σ segmentDistances(flyPoints) [path length of FlyApproach from the route's AirwayNodes]
appLen = Σ segmentDistances(appPoints) [path length of AppPointList from cache]
combined = [...flyPoints, ...appPoints] [concatenate to include connecting segment]
totalLen = computePathLength(combined) [total unified path length]
targetDist = totalLen × progressRatio [aircraft position along unified path]

if targetDist >= flyLen → State=5 (past IAF, final approach, Tower)
else → State=30 (before IAF, still on STAR, Approach)
```

This eliminates the need for a cached `flyFractionMap` — the IAF is determined
directly from the full FlyApproach path (resolved from the runway route's
`AirwayNodes` via `resolveFlyApproachPoints`) and the cached AppPointList.

#### Step 3a: State=30 Position & Direction

Aircraft is on the STAR/en-route approach segment, on Approach frequency.

```
// Unified path: FlyApproach + App + TouchDown
fullPath = flyPoints + appPoints + [touchDownPosition]
totalLen = Σ segmentDistances(fullPath) [sum of |p[i]-p[i-1]|]
targetDist = totalLen × progressRatio

// Position: interpolate along unified path
pos = interpolateAlongPath(fullPath, targetDist)

// Y from 3° ILS glideslope using REMAINING PATH DISTANCE.
// NOT straight-line — path distance follows the approach route through turns.
// Capped at the runway's approach ceiling (hardcoded 15.24m, standard ILS).
remainingPathDist = totalLen - targetDist [distance still to fly]
glideY = remainingPathDist × tan(3°) [uncapped glideslope]
pos.y = min(approachCap, glideY) [capped at max altitude]

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
continuity. The stored DynamicsParams.ProgressRatio is a **constant `0`** — the game
recalculates path-based PR for final-approach aircraft.

```
// Unified path for position (same as State=30, with IAF dedup)
unifiedPath = _dedupeIafJoin(flyPoints, pathPoints) + pathPoints + [tdPos]
totalLen = Σ segmentDistances(unifiedPath)
targetDist = totalLen × fullPR [fullPR for continuity]

// Position: interpolate along unified path
pos = interpolateAlongPath(unifiedPath, targetDist)

// Y from 3° ILS glideslope using remaining path distance
remainingPathDist = totalLen - targetDist
glideY = remainingPathDist × tan(3°)
pos.y = min(approachCap, glideY)

// Direction: matches runway heading (from cached approachDirection)
dir = state5.approachDirection

// Stored PR: CONSTANT 0 — the game recalculates path-based PR from
// PathPointList; the editor never writes a computed PR for State=5.
storedPR = STATE5_OUTPUT_PROGRESS_RATIO = 0
```

#### State=5 DynamicsParams fields

All Y values use path-distance × tan(3°) capped at `approachCap`.
No value is hardcoded — the cap comes from the ACL via the approach cache.

**InitialPosition** — the final approach entry point (first PathPointList point):
```
ipX = pathPoints[0].x
ipZ = pathPoints[0].z
ipPathDist = Σ segmentDistances([...pathPoints, tdPos]) [total path from this point]
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
| Stored PR | fullPR | 0 (constant — game recalculates path-based PR) |
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
3. `_saveSec` is **ignored** — v4 is not a snapshot save; aircraft positions are computed relative to the scenario's configured start time

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
 `GameTime.CurrentDateTime` override applied by `resolveConfigTime`).
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
 flyPathLen = Σ segment distances of FlyApproach points (RouteType=0 STAR route, via resolveFlyApproachPoints)
 procPathLen = Σ segment distances of approach procedure points (RouteType=1 route, via resolveApproachProcedureData)
 tdDist = distance from last procedure point to TouchDownPosition (runway threshold)
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
- `extractSpecificationDB(aclText)` → `Map<Designator, Spec>` — Scans the decoded text for `Specification` objects inside jetway `DockingAircraft` entries and `RuntimeData` aircraft entries. **v5:** primary spec source is `aircraft_profiles.csv` via `loadGlobalSpecDB`; this function is fallback for pre-v5 fixtures without a CSV (still exports `specDB` indexed by both Designator and AircraftType).
- `parseAircraftProfilesCsv(csvText)` → `{specDB, designatorMap}` — Parses `StreamingAssets/aircraft_profiles.csv` (`AircraftType,Designator,AerodromeCode,WakeCategory,CwtCategory,WheelBase,ModelOffset,WingSpan,DockingPositions,VR,ISA_MTOW_ToL`; DockingPositions `|` split, ModelOffset `/` split) into the global specDB (indexed by both AircraftType and Designator) and `AircraftType → Designator` map. Columns parsed per spec: `Designator`, `AerodromeCode` (charCode), `WakeTurbulenceCategory`, `WheelBase`, `ModelOffset {x,y,z}`, `WingSpan`, `DockingPositions [{x,y,z,w}]`, `RunwayVRSpeed`, `RunwayTakeOffLength`. Missing DockingPositions falls back to `[{x:2.5,y:0,z:0,w:1}]`.
- `findAircraftProfilesCsv(airportDir)` → `string|null` — Locates the CSV from `airportDir` (…/Airports/<ICAO>/Levels) via `path.resolve(airportDir,'..','..','..','aircraft_profiles.csv')` then walk-up search for `aircraft_profiles.csv` / `StreamingAssets/aircraft_profiles.csv` / `GroundATC_Data/StreamingAssets/aircraft_profiles.csv`.
- `loadGlobalSpecDB(airportDir)` → `{specDB, designatorMap}|null` — Cached global loader: returns cloned Maps from the parsed CSV (first call parses + caches in `_globalSpecDB`/`_globalDesignatorMap`; logs `[APPROACH-CACHE] Loaded global specDB …`). Used by `buildApproachCache` to seed the airport cache before the two-pass scan.
- `extractApproachData(aclText)` → `Array<{route, runway, progressRatio, flyPoints, appPoints, ...}>` — all State=30 aircraft. **Returns `[]`** — v4 files have no pre-spawned aircraft (the game computes state at runtime).
- `extractState5Data(aclText)` → `Array<{route, runway, touchDownPosition, approachDirection, initialPosition, pathPointList}>` — **stub returning `[]`** (v4 has no pre-spawned aircraft; final-approach parameters come from `resolveApproachProcedureData`).
- `extractTypeMap(aclText)` → `Map<number, string>` — captures all fully-qualified `$type` declarations from a file; type numbers are per-file in Unity's serialization
- `buildAppPointMap(approachEntries)` → `Map<"Route|Runway", Vector3[]>` — verified 1:1 mapping
- `buildState5ParamsMap(state5Entries)` → `Map<"runway", {pathPointList, touchDownPosition, approachDirection, initialPosition, routeName?}>` — per-runway final approach parameters; `routeName` populated from the approach procedure's `Name` field
- `computeApproachTimesFromScenery(aclText, starMappings, appPointMap, refTatMap, defaultTAT, airportScale?)` → `Map<STAR, seconds>` — per-STAR duration from PKStaticEntities route path-length estimates using three-tier estimation
- `extractGameTime(aclText)` → `seconds | null` — parse `GameTime.CurrentDateTime` ticks as seconds since midnight (returns `null` when the file has no `GameTime` section, as v4 scenario files usually don't)

**Path Resolution:**
- `resolveFlyApproachPoints(aclText, route, runway)` → `Vector3[]` — via the PKStaticEntities runway → `Routes` → `AirwayNodes` `$iref` chain

**Runway Routes & STAR Mapping (v5-aware — `PhysicalRunwayStaticItem` indirection, merged cache):**
- `extractStarRunwayMappings(aclText)` → `{starRunwayMap: {star→[runways]}, runwayStarMap: {runway→[stars]}}` — authoritative from PKStaticEntities `runway:*` entries' `Routes` (RouteType=0). Resolves `PhysicalName` via `PhysicalRunwayStaticItem` (see above); skips entry if `Name` missing or `PhysicalName` present but lacks `/`.
- `extractStarWaypoints(aclText)` → `{ "STAR|runway": [{name, x, z}, ...] }` — each STAR route's ordered waypoint list (route order: entry → IAF), resolving the route's `AirwayNodes` `$iref`s to named airway-node entities (the composer's "Fly Waypoint" picker target set). Parses each runway's nested `Routes` `$rcontent` for RouteType=0 entries, skipping stubs; shares the v4 PK-index lazy-require pattern (`./v4_pk_index` inside the function). Serialized in the approach cache as `starWaypoints` (CACHE_VERSION bump required — v23). v5: also resolves `PhysicalName` via `PhysicalRunwayStaticItem`.
- `resolveApproachProcedureData(aclText, runway, hintPosition?)` → `{pathPointList, touchDownPosition, approachDirection, initialPosition, routeName?} | null` — resolves final approach parameters for a runway from PKStaticEntities runway `Routes` (RouteType=1); when `hintPosition` is provided and multiple variants exist, picks the closest one. Returns `routeName` from the selected procedure's `Name` field (extracted via `_extractString` from the route block). `TouchDownPosition` via `TouchDownPoint $iref` → taxiway-node; throws on missing.
- `_parseRunwayThresholds(aclText)` → `{[PhysicalName]: {thresholds: [{x,z}, {x,z}]}}` — runway endpoint positions via the runway's `ThresholdPoints` `$iref`s → taxiway-node positions. v5: `PhysicalName` via `PhysicalRunwayStaticItem` + `_findPhysicalNameByIref` (double-`$iref` + raw `"$id"` scan).
- `_findPhysicalNameByIref(aclText, pkIndex, iref)` → `string|null` — Helper for v5: resolves a `PhysicalRunwayStaticItem` `$iref` to its `PhysicalName` (PK index first, double-`$iref` walk, then raw-text `"$id": N` scan for inline objects e.g. ZSJN 01 `$iref:8541`).

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
- `buildDesignatorMapping(aclText)` → `Map<AircraftType, Designator>` — cross-references `StaticItems` (flight-plan → Registration, AircraftType, Stand) with `RuntimeEntities`. Scans `StaticItems` for flight-plan entries then cross-references `RuntimeEntities` in two passes: **(Pass A)** `aircraft:REG` entries (Registration → Specification.Designator), **(Pass B)** `jetway:STAND` entries with `DockingAircraft.Specification.Designator` (linked via Stand → AircraftType from static-item Stand field). Jetway fallback covers aircraft whose only runtime representation is inside a jetway's `DockingAircraft`. Produces a complete map for spec lookup during save. **v5:** the global CSV seeds the map before the scan (see above).
- `buildApproachCache(airportDir, progressCallback?, fileFilter?)` → `{specDB, appPointMap, totalApproachTimes, designatorMap, saveTimeOffsets, typeMap, typeNameIndex, fileTypeMaps, fileTypeNameIndexes, state5ParamsMap, starPaths, starWaypoints, runwayThresholds, airportScale, starRunwayMap, runwayStarMap, taxiwayPaths, sidRunwayMap, runwaySidMap, sidPaths, missedAppMap, runwayMissedAppMap, missedAppPaths, apprRunwayMap, runwayApprMap, apprPaths, airwayNodes}` — scans all `.acl` files for an airport. **v5:** collects `allAclTexts[]` and **merges every scenery-derived map across all files** (STAR/SID/APPR/runway/waypoints/thresholds/airwayNodes/sidPaths/missedAppPaths/apprPaths all multi-file with dedup) because each level now carries only a subset of runways/procedures (ZSJN `leisure_1` = RWY19 only, others = RWY01 only). Also loads the global `specDB`/`designatorMap` from `aircraft_profiles.csv` before the per-file loop (same for all airports). The first file no longer dominates. `fileFilter(filename)` overrides the built-in skip regex (`/tutorial|bench|test|crossrunway|dev|endless|\.prod/i`); `electron/main.js` passes `isCacheAclFile` so whitelisted demo/prod visible bases (e.g. `ZGSZ_Endless.acl`) are scanned even when they match the regex — without it their geometry cache would come back empty.

**Assembly:**
- `buildApproachAircraftBlock({flightPlanGuid, route, flyPoints, appPoints, progressRatio, spec, radioChannelGuid?, touchDownPosition?, approachCap?, typeNums?, acTypeNum?, nextId?})` → `{guid, block, nextId}` — State=30 `$k/$v` JSON block
- `buildState5AircraftBlock({flightPlanGuid, route, state5PR, spec, towerChannelGuid?, state5Params, flyPoints?, fullPR?, waitingForCommand?, selectedRunwayExitIndex?, typeNums?, acTypeNum?, nextId?})` → `{guid, block, nextId}` — State=5 `$k/$v` JSON block. `state5PR` is deprecated — the builder hardcodes `ProgressRatio: 0` (game recalculates path-based PR); not used by the save path
- `buildAnimatorBlock(aircraftGuid, opts)` — builds the paired `AircraftAnimatorState` entry; `opts.typeNums` controls `animState`/`animSubState` type numbers; `opts.gearRatio` (default 1) sets `GearRatio`/`GearTargetRatio` — gear down (1) for parked and final-approach aircraft, gear up (0) for STAR approach

## Test

```bash
node --require ./tests/integration/preload.cjs tests/integration/test_approach_aircraft.js [--root <game-root>]
```

Validates all algorithms: spec consistency, AppPoint mapping, ProgressRatio formula (saveTime spread), FlyApproach resolution, Position/Direction reconstruction, and block assembly. ⚠ The 8 hardcoded filenames (ZSJN-Morning_120min.acl etc.) are v3-era and absent from the current playtest install → 0/8 found, so the run executes in limited mode (T1 spec cross-file consistency is still real; T7 skips when no State=30 types are present).
