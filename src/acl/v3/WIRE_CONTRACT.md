# GATCARC4 Storage Version 3 — Wire Contract & Conversion Reference

## 1. Source Build & Corpus Inventory

- **Source build:** *Airport Control 27* (Steam AppID `3328490`), updated `2026-11-12T20:40:31Z` (`GameAssembly.dll` 131,855,360 bytes).
- **Embedded wire schema location:** `<gameRoot>/GroundATC_Data/il2cpp_data/Metadata/global-metadata.dat` at byte offset `13698156`, length `131812` bytes (`src/acl/v3/schema_ca34c2ab.json`).
- **Schema hash canonicalization:** UTF-8 SHA-256 of compact JSON with lexicographically sorted object keys at every depth (`computeCanonicalSchemaHash(schema)`):
  `ca34c2ab4444042a719e43df7896794fd87ceb05977556bd405dc51e59721510`
- **Shipped corpus (40 `.acl` files across 5 airports):**
  - `EGLC`: 0 `.acl` files (`flight_schedule.csv` only).
  - `KDCA` (9 files): `KDCA_CrossRunwayTutorial` (1 frame), `KDCA_Endless` (0), `KDCA_PerfBench_MaxParked` (0), `KDCA_leisure_1` (1), `KDCA_leisure_2` (1), `KDCA_peakarrival` (1), `KDCA_peakdeparture` (1), `KDCA_runwaychange` (1), `KDCA_surfaceradarinvisible` (0).
  - `KJFK` (10 files, all 0 frames): `KJFK_Endless`, `KJFK_leisure_1`, `KJFK_leisure_1.demo`, `KJFK_leisure_2`, `KJFK_peakarrival`, `KJFK_peakarrival.demo`, `KJFK_peakdeparture`, `KJFK_runwaychange`, `KJFK_surfaceradarinvisible`, `KJFK_test`.
  - `ZGSZ` (8 files, all 0 frames): `ZGSZ_Endless`, `ZGSZ_leisure_1`, `ZGSZ_leisure_2`, `ZGSZ_peakarrival`, `ZGSZ_peakdeparture`, `ZGSZ_runwaychange`, `ZGSZ_surfaceradarinvisible`, `ZGSZ_test`.
  - `ZSJN` (13 files): `ZSJN_ApproachandTakeOffTutorial` (1 frame), `ZSJN_Endless` (0), `ZSJN_GoAroundTutorial` (1), `ZSJN_PerfBench_MaxParked` (0), `ZSJN_RunwayIncursionTutorial` (1), `ZSJN_leisure_1` (1), `ZSJN_leisure_2` (0), `ZSJN_peakdeparture` (0), `ZSJN_peakdeparture.demo` (0), `ZSJN_runwaychange` (0), `ZSJN_surfaceradarinvisible` (0), `ZSJN_taixwayclosed` (0), `ZSJN_test` (0).
  - Every archive header version is `3`, every `MARF` checkpoint frame version is `3`, and every header `schemaHash` equals `ca34c2ab4444042a719e43df7896794fd87ceb05977556bd405dc51e59721510`.
- **Reproducing the corpus check:**
  ```bash
  AC27_GAME_ROOT="D:/SteamLibrary/steamapps/common/Airport Control 27" npx vitest run tests/acl/v3_corpus.test.js
  ```

---

## 2. Container Framing (GATCARC4 v3)

All length and version integers are unsigned 32-bit little-endian (`uint32LE`):

1. **Header segment (`NODS`):**
   - `[0..7]` ASCII `"GATCARC4"`
   - `[8..11]` `uint32LE` storage version = `3`
   - `[12..15]` `uint32LE` header UTF-8 byte length `N`
   - `[16..16+N)` UTF-8 JSON `{schemaHash, archiveGuid, progressDisplayName, levelGuid, airportIcao}`
   - `[16+N..48+N)` 32-byte SHA-256 of the `N` header bytes
   - `[48+N..52+N)` ASCII commit marker `"NODS"`
2. **Main `LevelPayload` segment (`NODH`):**
   - `[0..3]` `uint32LE` main UTF-8 byte length `P`
   - `[4..4+P)` UTF-8 JSON `{"MetaData": <LevelMetaData>, "StaticData": "<base64 UTF-8 JSON StaticField>"}`
   - `[4+P..36+P)` 32-byte SHA-256 of the `P` main payload bytes
   - `[36+P..40+P)` ASCII commit marker `"NODH"`
3. **Zero or more appended `MARF` checkpoint frames (`NODF`):**
   - `[0..3]` ASCII `"MARF"`
   - `[4..7]` `uint32LE` frame storage version = `3`
   - `[8..11]` `uint32LE` outer frame byte length `M` (`M = 4 + J + 32 + 4 + B + 32 + 4`)
   - `[12..12+M)` frame body:
     - `[0..3]` `uint32LE` summary JSON length `J`
     - `[4..4+J)` UTF-8 JSON `{guid, displayName, kind, createdAtUtcTicks, inGameDateTimeTicks, departureCount, arrivalCount, warningCount, infoCount}`
     - `[4+J..36+J)` 32-byte SHA-256 of summary bytes
     - `[36+J..40+J)` `uint32LE` payload JSON length `B`
     - `[40+J..40+J+B)` UTF-8 JSON `{"RuntimeData": "<base64 UTF-8 JSON RuntimeField>", "RecentMessages": [...]}`
     - `[40+J+B..72+J+B)` 32-byte SHA-256 of payload bytes
     - `[72+J+B..76+J+B)` ASCII commit marker `"NODF"`
   - Truncated tails or partial frames are rejected with byte offset and frame index diagnostics (`SaveSystem` rejects uncommitted/boundary-mismatched frames on level load).

### Checkpoint Summary Metadata Rules
- `kind === 0` (`Initial` snapshot shipped with levels): `displayName: ""`, `inGameDateTimeTicks: 0`, `departureCount: 0`, `arrivalCount: 0`, `warningCount: 0`, `infoCount: 0`, `createdAtUtcTicks: <int64 .NET UTC ticks>`. None of its summary fields depend on rewritten flight counts; preserving the summary JSON verbatim preserves exact `createdAtUtcTicks` (> `2^53`).
- `kind > 0` (`Progress` / `Auto` player save): `inGameDateTimeTicks > 0` and `displayName` matches header `progressDisplayName`. Preserving summary metadata (and keeping counts non-negative) satisfies `SaveSummaryCatalog`.

---

## 3. Wire Graph & Schema Rules (`newtonsoft-auto-object-references-v1`)

- **Roots:**
  - Plain roots (`wire.plainRoots = ["metadata", "messages"]`): `MetaData` (`ContextCross.Saves.LevelMetaData`) and `RecentMessages` (`ContextCross.Saves.GameMessageSnapshot[]`) serialize as plain JSON with **no** `$id`, `id`, `$type`, or array wrappers (`T[]` is a plain `[...]`).
  - Graph roots: `StaticData` (`ContextCross.Saves.StaticField`) and `RuntimeData` (`ContextCross.Saves.RuntimeField`) each have an independent positive-`int32` string ID namespace (`"1"`, `"2"`, ..., `"N"`).
- **Reference IDs & wrappers inside graph roots:**
  - `object` (`kind: "object"`): `{"$id": "<n>", ...members}` or back-reference `{"$ref": "<n>"}` or external static authority reference `{"$ref": "pk:<ConcreteType>:<PK>"}`.
  - `dictionary` (`kind: "dictionary"`): `{"$id": "<n>", "<key>": <value>, ...}` (or `{"$ref": "<n>"}`).
  - `array` (`kind: "array"`, C# `T[]`): `{"id": "<n>", "type": "<ElementType>[]", "values": [...]}` (or `{"$ref": "<n>"}`).
  - `reactive` (`kind: "reactive"`, `R3.ReactiveProperty<T>`): `{"id": "<n>", "value": <T>}` (note: `value` itself may be `{"$ref": "<n>"}` when `T` is a reference/array type).
  - `list` (`kind: "list"`, `List<T>`): bare JSON `[...]` (no `id` / `$id`).
  - `fixedArray` (`Position3`, `Direction3`, `Displacement2`): bare fixed-length JSON integer tuple `[x, y, z]` or `[x, y]`.
- **Polymorphic `$type` rule:**
  - Emit `"$type": "<ConcreteType>"` (assembly-free full name) **if and only if** the declared slot type is polymorphic (`abstract === true` or `assignable.length > 0`):
    - `IPkStaticEntity`, `IStaticEntity`, `IStaticItem`, `IRuntimeEntity`, `IDynamicsParams`, `AircraftEvent`.
  - Concrete declared slots (`abstract === false && assignable.length === 0`) **never** carry `"$type"`.
- **Members rule (`all-required-including-null-no-unknown-members`):**
  - Every member declared on the concrete object type in `schema.types[typeName].members` **must** be present as an explicit JSON property (using `null` when unset and `allowNull === true`), and no undeclared keys may appear (aside from `$id` and polymorphic `$type`).
- **External `pk:` authority references (`RuntimeData` → `StaticData`):**
  - Format: `"pk:<ConcreteType>:<key>"` (split on the first two colons only, since `<key>` itself contains colons, e.g. `"pk:ContextCross.Models.FlightPlanStaticItem:flight-plan:B-66X5"`, `"pk:ContextCross.Models.Runway:runway:01"`, `"pk:ContextCross.Models.FixedTaxiNavigationPoint:taxi-navigation:stand:-90101"`).
  - Validated against `StaticData.PKStaticEntities` (`IPkStaticEntity` subtypes) and `StaticData.StaticItems` (`IStaticItem` subtypes).

---

## 4. Field-Level Unit & Type Conversion Table

Constant: `Q32 = 4294967296` ($2^{32}$), `KT_TO_MPS = 1852 / 3600` ($\approx 0.5144444444$), `DEG_TO_RAD = Math.PI / 180`, `GU_TO_METERS = 100` (`Config.scaleFactor = 0.01`).

| Domain / Field | Wire Type | Wire Unit / Convention | Editor Unit / Convention | Decode (Wire → Editor) | Encode (Editor → Wire) | Null / Unset |
|---|---|---|---|---|---|---|
| `Position3` (`TaxiwayNode.ReactivePosition.value`, `AirwayNode.Position`, `Area.NodePositions.value[]`, `Runway.AreaVertices.values[]`, `Aircraft._position.value`, `DynamicsParams.*PointList[]`) | `[int64, int64, int64]` (`q32.32-si`) | SI meters `[x_east, y_up, z_north_neg]` $\times 2^{32}$ | Game units `{x, y, z}` where `1 GU = 100 m` (same axes as v2) | `(raw / 2^32) / 100` | `roundBigInt(gu * 100 * 2^32)` (preserve untouched wire tuple when unedited) | Non-nullable tuple (`[0,0,0]` default) |
| `Direction3` (`Aircraft._direction.value`, `ApproachDynamicsParams.ApproachDirection`, `GoalDirection`, `FixedTaxiNavigationPoint.Direction`) | `[int64, int64, int64]` (`q32.32-si`) | Unit vector components $\times 2^{32}$ | Unit vector `{x, y, z}` (`[-1..1]`) | `raw / 2^32` | `roundBigInt(comp * 2^32)` | `null` only on `Nullable<Direction3>` |
| `Displacement2` (`Config.offset`) | `[int64, int64]` (`q32.32-si`) | SI meters `[x, y]` $\times 2^{32}$ | `{x, y}` meters | `raw / 2^32` | `roundBigInt(m * 2^32)` | `[0, 0]` |
| `Length` (`Runway.Width`, `Config.offsetDistance`, `InitHeight`) | `int64` (`q32.32-si`) | SI meters $\times 2^{32}$ | `Runway.Width`: game units `m * 0.01` (`0` when unset); `offsetDistance`: meters | `Runway.Width`: `(raw / 2^32) / 100`; `offsetDistance`: `raw / 2^32` | `Runway.Width`: `roundBigInt(gu * 100 * 2^32)`; `offsetDistance`: `roundBigInt(m * 2^32)` | `0` |
| `WindFrame.direction` | `Fixed64` (`int64`) | Radians $[0, 2\pi) \times 2^{32}$ | Integer degrees `[0..360)` | `((Math.round((raw / 2^32) * 180 / Math.PI) % 360) + 360) % 360` | Unedited: raw wire int; edited: `roundBigInt((deg * Math.PI / 180) * 2^32)` | Required (`0`) |
| `WindFrame.speed` | `Speed` (`int64`) | SI m/s $\times 2^{32}$ | Integer knots (`kt`, store canonical unit) | `Math.round((raw / 2^32) * 3600 / 1852)` | Unedited: raw wire int; edited: `roundBigInt((kt * 1852 / 3600) * 2^32)` | Required (`0`) |
| `WeatherFrame` | `{preset, time}` | Strings (`"Sunny"`, `"HH:MM:SS"`) | `{preset, time}` | Identity | Identity | Required |
| `Config.referenceLatitude`, `Config.referenceLongitude` | `Fixed64` (`int64`) | Radians $\times 2^{32}$ | Degrees (`refPoint`: `{lat, lon}`) | `(raw / 2^32) * 180 / Math.PI` | `roundBigInt((deg * Math.PI / 180) * 2^32)` | Preserved from wire |
| `Config.scaleFactor` | `Fixed64` (`int64`) | Ratio $\times 2^{32}$ (`42949672` / `42949673` $\approx 0.01$) | `0.01` (`GU = m * 0.01`) | `raw / 2^32` | Preserved raw wire int (`42949673` default) | Preserved |
| `Config.offsetRatio` | `Fixed64` (`int64`) | Fraction $\times 2^{32}$ (`214748365` $\approx 0.05$) | `offsetPercent = ratio * 100` (`5`) | `(raw / 2^32) * 100` | Preserved raw wire int | Preserved |
| `Fixed64` ratios (`ProgressRatio`, `GearRatio`, `FlapRatio`, `SlatRatio`, `InitialProgress`) | `Fixed64` (`int64`) | Dimensionless $\times 2^{32}$ (`1.0 = 4294967296`) | Float `[0..1]` | `raw / 2^32` | `roundBigInt(r * 2^32)` | `0` |
| `System.DateTime` (`BaseTime`, `LandingTime`, `OffBlockTime`, `InBlockTime`, `ActualInBlockTime`, `TakeoffTime`, `CurrentDateTime.value`, `_departureTakeoffTime`, `_arrivalInBlockTime`) | `string` | Local wall-clock ISO `"YYYY-MM-DDTHH:MM:SS[.fff]"` (no TZ shift; `LastModified` uses UTC `"Z"`) | `"HH:MM"` or `"HH:MM:SS"` (base date `"2000-01-01"`) | Substring clock parse (no `Date` local-TZ conversion) | `"2000-01-01T" + hhmmss` | `"0001-01-01T00:00:00"` |
| `Duration` (`CurrentTimestamp.value`, `TakeoffPitchElapsed`) | `int64` (`q32.32-si`) | SI seconds $\times 2^{32}$ | Seconds (`number`) | `raw / 2^32` | `roundBigInt(sec * 2^32)` | `0` |
| `Aircraft._state.value` | `EAircraftState` (`int32`) | `0`=Init, `1`=ReadyForTaxi, `5`=Approach, `8`=TakeOff, `10`=Idle, `14`=RollOut, `16`=AtSpot, `18`=GoAround, `27`=PushBack, `28`=LineUp, `29`=TaxiParking, `30`=Fly, `30`=STAR, `31`=Taxi, `32`=Towing | Same integer enum | Identity | Identity | `{id, value: 10}` |

## 5. `LevelArchiveCodec` Interrupted-Tail & Envelope Invariants

Confirmed from `global-metadata.dat` (`ContextCross.Saves.LevelArchiveCodec` / `ContextCross.Saves.SaveSystem`):
- **Interrupted append tails (`TryReadCommittedFrameBounds` / `EnsureInterruptedTailAllowed`):** The game's runtime autosave reader optionally tolerates an uncommitted trailing `MARF` append via `allowInterruptedTail: true` (logging via `ReportInterruptedTail`), whereas mutation/level-authoring loads (`LoadRequiredProgressForMutation`, `allowInterruptedTail: false`) reject any uncommitted or truncated trailing frame. The editor **defaults to strict rejection (`allowInterruptedTail: false`)** so opening and re-saving a file can never silently discard a truncated checkpoint frame, and reports the exact byte offset and 0-based frame index on failure.
- **Envelope consistency (`EnsureArchiveSummaryMatchesPayload` / `EnsureFrameSummary`):**
  - `header.levelGuid` matches `MetaData.Guid`.
  - Checkpoint `summary.kind` (`0` = initial snapshot, `1` = progress checkpoint), `summary.createdAtUtcTicks > 0` (`Int64`), and `summary.displayName` (matching `header.progressDisplayName` when `kind !== 0`) are summary-level metadata independent of payload byte length; preserving `header` and unmodified `summary` bytes verbatim preserves all envelope invariants.

