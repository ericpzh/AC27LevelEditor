# Airport Control 25 — Aircraft Class Structure Report

> Extracted from `GameAssembly.dll` (IL2CPP, native C++) + `global-metadata.dat` using Cpp2IL (development build 2022.1.0-development.1673).
> Game: **GroundATC** — Unity **6000.3.12f1**, IL2CPP metadata version **39**.
> Dump date: 2026-08-03. Source: `ContextCross` assemblies — the game code lives in `GroundATC.Core` (plus `GroundATC.Modding`, `GroundATC.Shared`); `Assembly-CSharp` contains only legacy/environment code (Enviro, Gaia, cameras).

**All gameplay code is namespaced `ContextCross.*`** — an API-style architecture shared with the game's companion web app: domain logic in `ContextCross.Models`, state machines in `ContextCross.Aircrafts` / `ContextCross.Dynamics`, reactive event plumbing (R3/UniRx-style `ReactiveProperty`, `StateMachine`, `IPublisher`/`ISubscriber`), and HTTP-like endpoint classes under `ContextCross.Api`.

---

## 1. Core aircraft class

### `Aircraft` (ContextCross.Aircrafts) — 1411 lines in dump

The central gameplay entity. Implements `IRuntimeEntity, IResolveByPK, IEntity, IDisposalNode, IDisposable`. PK prefix `"aircraft:"`, built from registration (`BuildPk(registration)`).

| Part | Members |
|---|---|
| **State** | `ReactiveProperty<EAircraftState> _state` (serialized), `StateMachine<EAircraftState, EAircraftTrigger> _stateMachine`, `_isFlying`, `IsOnRunway`, `IsinHoldingPosition`, `IsFlying` |
| **Plan** | `FlightPlan _flightPlan` (serialized), `AircraftSpecification Specification`, `Route`-derived `_route` (serialized `ReactiveProperty<string>`) |
| **Physics/Dynamics** | `AircraftDynamicsData DynamicsData` (serialized), `Dynamics _dynamics`, `AVCController`, `AVCPathPredictor`, `ReactiveProperty<DynamicsModeType> KinematicMode`, `CollisionsEnabled` |
| **Position** | `PositionReactive` / `DirectionReactive` (Vector3), `TaxiPathStartingPosition`, `RollingPresetTaxiPathStartingPosition`, `Rotation`, `FrontWheelSteeringAngle`, `Velocity`, `LeadingWheelPosition`, `RemainSplineLength`, `DistanceToEnterRunway` (DistanceData) |
| **Airport refs** | `RunwayReactive`, `SelectedRunwayEntryIndex`/`SelectedRunwayExitIndex` (serialized), `AvailableRunwayExits`, `_selectedRunwayEntryRunway`, `AircraftRunwayCoordinator` (serialized) |
| **Radio** | `_radioChannel`, `_jurisdictionRadioChannel` (serialized ReactiveProperty<RadioChannel>), `IsRadioCommunicating`, `IsRadioBusy`, `IsFrequencyUpdatePending`, `_latestRadioEvent`, `AircraftRadioEventBuilder` |
| **Commands/Events** | `_waitingForCommands` (ECommand[]), `_receivedEvents` (AircraftEvent[]), `_pendingCrossRunwayPermissions`, `AircraftCheckList` |
| **Metrics/Times** | `AircraftFlightMetrics AircraftFlightMetrics`, `TaxiSpeed`, `HeightFeet`, `AirSpeedKnot`, `OperationStartTime`/`OperationEndTime` (DateTime, computed from FlightPlan) |
| **Tow/Pushback** | `SelectedPushbackLimitPosition`, `SelectedTowPosition`, `_towStopRequested`, `_towPushbackSessionActive`, `_needsDepartureTaxiReplan` |
| **Conditions** (ReadOnlyReactiveProperty<bool>, wired in `InitializeReactiveProperties`) | `ParkFinishAtSpotCondition`, `CheckStandClearCondition`, `CheckTaxiFinishedCondition`, `DepartureTaxiFinishedCondition`, `AirrivalTaxiFinishedCondition` [sic], `GoAroundContactDepartureCondition`, `AutoSwitchToDepartureChannelCondition`, `TakeOffContactDepartureCondition`, `DepartureAircraftContactTowerCondition`, `DepartureAircraftReadyForContactGroundCondition`, `ArrivalAircraftReadyForContactGroundCondition`, `ReadyToTaxiCondition`, `TowFinishedCondition`, `CheckAutoGoAroundCondition`, `CheckLandCondition`, `ApproachToGoAroundCondition`, `ArrivalAircraftAutoContactTowerCondition`, `BrakeDistanceCondition`, `EnterSelectedExitCondition`, `TouchDownCondition`, `RollFinishCondition`, `FlyToApproachCondition`, `TaxiToLineUpCondition`, `LineUpToTakeOffCondition`, `ClearStatePathCondition`, `RunwayVacateEdgeCondition`, `JetwayDocked` |

Key behavior:
- `InitStateMachine()` — wires `EAircraftState` machine; `SubscribeGameplayReactions()` — reactive event handlers; `Step()` — per-frame update; `ConfigureRuntimeData(flightPlan, state, spec, direction, position, direction, radioChannel, route, dynamicsData)` — populates a runtime aircraft (this is how saved levels get re-instantiated); `BindAfterLoaded()` — post-load hook; `RestoreRuntimeComponents()`.
- Command API: `CommandBeginPushback`, `CommandBeginTaxi`, `CommandContinueTaxi`, `CommandPauseTaxi`, `CommandStandByPushback`, `CommandStandByTaxi`, `CommandLineUp`, `CommandTakeoff`, `CommandGoAround`, `CommandRollOutTaxi`, `CommandRollOutDirectTaxi`, `CommandChangeRunway`, `CommandContinueApproach`, `CommandBeginTowToSelectedPoint`.
- Radio handlers: `HandleAtcPushbackApprovedRadioStarted/Completed`, `HandleTaxiClearanceRadioStarted`, `HandleAtcClearedForTakeoffAcceptedRadioStarted`, `HandleAtcLineUpAndWaitRadioCompleted`, `HandleAtcContactTowerRadioCompleted`, `HandleAtcContactGroundWhenApproachRadioCompleted`, `HandleCaptainRequestToLandRadioCompleted`, etc. — each with a `*Started` returning an `Action` rollback (see `ExecuteRadioStart` pattern).
- Flight-plan helpers: `IsArrival` / `IsDeparture` (from `EFlightDirection`), `CheckArrivalToDeparture` (turnaround: arrival leg → departure leg), `ConfigureDepartureTurnaround`, `ResetRuntimeStateForDepartureTurnaround`, `WakeupForDeparture`.
- Runway logic: `SetupRunwayExits`, `UpdateDistanceToRunway`, `EnterHoldingArea(physicalRunwayName, entryName)`, `ExitHoldingArea`, `ChangeRunwayOnFly`, `EnterRunwayFence/ExitRunwayFence`, `RunwayIncursionDetectedHandler`, `ShouldAutoGoAroundFromRunwayIncursion`.
- Static tuning constants: `CollisionDetectorRadius`, `AircraftRollingExitThreshold`, `RunwayExitSelectionMargin`, `TaxiParkingEarlyStopDistance = 240`, several `HeightData` thresholds (takeoff/go-around contact heights etc.).

---

## 2. Enums

### `EAircraftState : int` (ContextCross.Aircrafts.Enums)
```
Init = 0,  ReadyForTaxi = 1,  Approach = 5,  TakeOff = 8,  Idle = 10,  RollOut = 14,
AtSpot = 16,  GoAround = 18,  PushBack = 27,  LineUp = 28,  TaxiParking = 29,
Fly = 30,  Taxi = 31,  Towing = 32
```
> Note: `Approach = 5` — this is the enum written to saved levels; the memory note about "state=5 aircraft" refers to this. Values are non-contiguous (legacy gaps), used verbatim in `.acl` save data.

### `EFlightDirection : int`
```
Departure = 0,  Arrival = 1
```

### `EAircraftTrigger : int`
```
RequestTaxi = 1, PauseTaxi = 2, TakeOff = 3, LineUp = 4, LineUpToTaxi = 5, ContactDeparture = 6,
ContactDepartureGoAround = 7, TouchDown = 8, RollFinishWithPath = 9, RollFinishWithoutPath = 10,
AtSpot = 11, Approach = 12, GoAround = 13, Pushback = 14, TaxiParking = 15, Taxi = 16,
ArrivalToDeparture = 17, StartTow = 18, StopTow = 19
```

### `EAircraftPart : int` — `Nose = 0, LeftWing = 1, RightWing = 2, Tail = 3`

---

## 3. Flight plan & schedule models (ContextCross.Models)

### `FlightPlan` : IRuntimeEntity\<FlightPlanStaticItem\>, IResolveByPK, IEntity, IHasStaticItem, IInitialWorldEntity
Runtime twin of the static plan. Serialized fields: `_arrivalInBlockTime`, `_arrivalActualInBlockTime`, `_arrivalRunway`, `_arrivalStand`, `_departureTakeoffTime`, `_departureRunway`, `_departureStand` (all DateTime/string). Reads the rest through `StaticItem` (below). Direction-aware accessors: `GetCallSign(dir)`, `GetAirport(dir)`, `GetRunway(dir)`, `GetStand(dir)`, `GetStartTime(dir)`, `GetEndTime(dir)`, `GetScheduledStartTime(dir)`, `SetRunway(dir, rwy)`, `SetStand(dir, stand)`, `SetEndTime(dir, t)`. Also `GetActualInBlockTime`, `SetActualInBlockTime`, `GetStar()`. `BuildPk(registration)`, `PK = "flightPlan:" + registration`.

### `FlightPlanStaticItem : IDynamicStaticItem, IStaticItem, IResolveByPK` — serialized save payload
```
Registration : string            AircraftType : string
AirlineName  : string            Voice : string          Language : string
InitialArrival   : FlightPlanArrivalLeg
InitialDeparture : FlightPlanDepartureLeg
```
`PK = "flightPlanStatic:" + registration`; `GetAllCallSigns()` returns the leg callsigns.

### `FlightPlanArrivalLeg` — serialized fields
```
CallSign : string,  OriginAirport : string,  LandingTime : DateTime,  InBlockTime : DateTime,
ActualInBlockTime : DateTime,  STAR : string,  Runway : string,  Stand : string
```
(`HasRequiredFields`.)

### `FlightPlanDepartureLeg` — serialized fields
```
CallSign : string,  DestinationAirport : string,  OffBlockTime : DateTime,  TakeoffTime : DateTime,
Runway : string,  Stand : string
```
> These two leg classes map 1:1 to the editor's 15 flight fields (CallSign, Origin/DestinationAirport, Stand, Runway, OffBlock/Takeoff/Landing/InBlock times, AirlineName, AircraftType, STAR/Airway, Registration, Voice, Language).

### `AircraftSpecification` (sealed)
```
Designator : string,  AerodromeCode : AerodromeCode,  WakeTurbulenceCategory : WakeTurbulenceCategory,
WheelBase : float,  ModelOffset : float3,  WingSpan : float,  DockingPositions : Vector4[],
RunwayVRSpeed : float,  RunwayTakeOffLength : float
```
`RunwayLandingLength` (computed getter), `Clone()`.

### `FlightScheduleEntry` / `FlightScheduleTableEntry`
Planned schedule entries (see inventory below).

---

## 4. Dynamics state machine (ContextCross.Dynamics)

### `AircraftDynamicsData : IDeepCloneable` — serialized per-aircraft dynamics state
```
DynamicsState : ReactiveProperty<State>,  TaxiSpeed : float,  ForwardSpeed : bool,
TargetTaxiSpeed / PositiveTaxiAcceleration / NegativeTaxiAcceleration / DynamicsTargetTaxiSpeed /
DynamicsPositiveTaxiAcceleration / DynamicsNegativeTaxiAcceleration : float,
PushbackStopRequested : bool,
TaxiArrivalToSpotPath : Path,  TaxiArrivalToHoldingPointPath : Path,
FrontWheelSteeringAngle : float,  DynamicsParams : IDynamicsParams
```
`CreateDefault()`, `DeepClone()`.

### `AircraftDynamicsInternal : struct` — per-frame output of a state
```
Position : Vector3,  Direction : Vector3,  FrontWheelSteeringAngle : float,  DynamicsMode : DynamicsModeType
```

### `Dynamics : IDisposable` — the movement engine
State machine `StateMachine<State, Trigger>` over 12 states, with `TriggerWithParameters<...,DynamicsParams>` transitions. Speeds as static fields (`StdTaxiSpeed`, `LowTaxiSpeed`, `PushBackTaxiSpeed`, `TurnSpeed`, `ParkingSpeed`, `ParkingAcceleration`, `RollSpeed`, `RollFinishSpeed`, acceleration constants). Holds `Runway`, `Stand`, `AircraftSpecification`, `AircraftFlightMetrics`, `DisplayPath` (Vector3[]), `RouteVersion`, `RouteIsReversed`. Main loop: `Update(AircraftDynamicsInput, deltaTime) → AircraftDynamicsOutput`; `GetProgressRatio()` (spline-path progress — recomputed from path, per save rule); `Ratio` property. Path following via `SetupFollowSpline(Spline)` / `SetupFollowSpline(List<Vector3>, smoothing, smoothingFactor, reversed)`.

### `State : int` (ContextCross.Dynamics.Enums)
```
Init = 0, FlyApproaching = 1, Approaching = 2, GoingAround = 3, Rolling = 4, ReadyForTaxi = 5,
TaxiingArrival = 6, TaxiingDeparture = 7, TaxiPausing = 10, TakingOffOnRunway = 12,
TakingOffInAir = 13, TaxiArrivalParking = 14, TaxiAligning = 15, Pushback = 16
```

### `Trigger : int`
```
Approach = 0, GoAround = 1, Roll = 2, TaxiArrival = 3, TaxiDeparture = 4, PauseTaxi = 5,
FinishTaxi = 6, Takeoff = 7, DepartureInAir = 8, FlyApproach = 9, TaxiArrivalParking = 10,
TaxiAlign = 11, Pushback = 12, PushbackFinished = 13, ParkingFinished = 14
```

### `DynamicsModeType : int`
```
None = 0, FlyWithDataCurve = 1, FlyWithPath = 2, Forward = 3, Backward = 4
```

### `IDynamicState` interface
`State` (property), `GetProgressRatio()`, `Init(IDynamicsParams)`, `Save() → IDynamicsParams`, `Update(AircraftDynamicsInput, deltaTime) → AircraftDynamicsInternal`. Implementations (each `XxxState` + `XxxDynamicsParams` pair):

| State class | DynamicsParams | Purpose |
|---|---|---|
| `ReadyForTaxiState` | — | parked at stand, awaiting pushback/taxi |
| `PushbackState` | `PushbackDynamicsParams` | tug pushback from stand |
| `TaxiDepartureState` | `TaxiDepartureDynamicsParams` | departure taxi to line-up |
| `TaxiAlignState` | `TaxiAlignDynamicsParams` | aligning on runway before takeoff |
| `TakeoffOnRunwayState` | `TakeoffOnRunwayDynamicsParams` | takeoff roll on runway (`GetProgressRatio` via `ProjectPointOnLine`) |
| `TakeoffInAirState` | `TakeoffInAirDynamicsParams` | climb-out after rotation |
| `ApproachState` | `ApproachDynamicsParams` | final approach to touchdown |
| `FlyApproachState` | `FlyApproachDynamicsParams` | STAR/app-route flying |
| `GoingAroundState` | `GoAroundDynamicsParams` (+ `GoAroundClimbTransitionProfile`) | go-around climb |
| `RollingState` | `RollingDynamicsParams` | runway rollout after touchdown |
| `TaxiArrivalState` | `TaxiArrivalDynamicsParams` | arrival taxi to stand |
| `TaxiArrivalParkingState` | `TaxiArrivalDynamicsParams` | final parking into stand |
| `TaxiPausingState` | `IDynamicsParams` | paused taxi (holding) |

> Save note: `IDynamicState.Save()` → params classes are what `AircraftDynamicsData.DynamicsParams` stores — the level-save snapshot of the movement state.

---

## 5. Airport model (ContextCross.Models)

### `Runway : IPkStaticEntity, IStaticEntity, IEntity, IResolveByPK`
Serialized: `Name`, `PhysicalName` (used for runway-pairing in saves), `Entries`/`Exits` (Entry[]/Exit[]), `Routes` (Route[]), `TouchDownPoint`, `EdgePoints`, `ThresholdPoints`, `AreaVertices`, `HoldingAreas`, `Width`, `LabelPositionNode`, `IsActive` (ReactiveProperty<bool>). Computed: `EntriesByDistance`, `ExitsByDistance`, `LongestTakeoffDistanceEntry`, `Direction`, `Position`, `TouchDownPosition`. `BuildPk(name)`, `Init()` → `InitializeEntryTakeoffDistances()`, `InitializeExitLandingDistances()`.

Nested types:
- `Runway.Entry` — `Name`, `HoldingPosition`/`LineUpPosition`/`DefinePoint` (TaxiwayNode), `Runway`, `AvailableTakeoffDistance` (internal set).
- `Runway.Exit` — `Name`, `ExitPosition`/`HoldingPosition`/`DefinePoint`, `AvailableLandingDistance`, `IsLeft`.
- `Runway.HoldingAreaData` — `Vertices : Vector3[]`, `EntryName`.
- `Runway.Route : IDeepCloneable` — `AirwayNodes : AirwayNode[]`, `Name`, `RouteType`.
- `Runway.EAirwayRouteType : int` — `Star = 0, App = 1, Sid = 2, MissedApch = 3`.

### `Stand : IPkStaticEntity, ...`
Serialized: `Name`, `Identifier`, `ParkingType` (EStandParkingType), `EgressType` (EStandEgressType), `TailPosition`/`NosePosition`/`PushbackLimitPositions` (TaxiwayNode[]). Computed: `Position`, `Direction`. `BuildPk(identifier)`.

### `TaxiwayNode : IPkStaticEntity, ...`
Serialized: `PK`, `OsmId : long`, `Name`, `Type` (ENodeType), `Flags : int`, `ReactivePosition`. Internal: `Aeroway`, `Ref`, `RunwayLabel`. Enums:
- `ENodeType : int` — `Apron = 0, Taxiway = 1, PushbackLimitPosition = 2, EntryHoldingPosition = 3, ExitHoldingPosition = 4`
- `EFlags : int` — `ShowLabel = 1, Apron = 2, Taxiway = 4, PushbackLimitPosition = 8, EntryHoldingPosition = 16, ExitHoldingPosition = 32`

### `TaxiwaySegment : IPkStaticEntity, ...`
Serialized: `PK`, `Name`, `OsmId : long`, `StartNode`/`EndNode` (TaxiwayNode), `IsOneWay : bool` (+ direction handling), `Aeroway`/`Ref`/`RunwayLabel` (internal). (Full member list in inventory below.)

### `Airport` (ContextCross) + `AirportSpot2D` (GroundATC.Core root)
Airport aggregate root and its 2D spot marker (details in inventory).

---

## 6. API projection models (ContextCross.Api.Models)

- `AircraftProjection` — API view of a live aircraft (fields in inventory).
- `ArrivalFlightScheduleProjection` / `DepartureFlightScheduleProjection` — scheduled arrivals/departures.
- `FlightStripProjection` / `FlightStripChannelProjection` — flight strip UI projections.
- Endpoint outputs: `AircraftOutput`, `AircraftListOutput`, `FlightScheduleListOutput`, `FlightStripListOutput` (fields-only in inventory).

---

## 7. Supporting types

### `ECommand : int` (ContextCross.Enums) — the ATC command vocabulary
```
PermitPushback = 1, StandByPushback = 2, ConfirmPushback = 3, Cancel = 4, PermitTaxi = 5,
StandByTaxi = 6, ChangeTaxiPath = 7, ConfirmTaxiPath = 8, PauseTaxi = 10, ContinueTaxi = 11,
ContactGround = 12, ContactTower = 13, ContactApproach = 14, ContactDeparture = 15, TakeOff = 16,
LineUp = 18, HoldShortOfRunway = 19, GoAround = 20, ContinueApproach = 21, PermitLanding = 22,
Exit = 23, PermitCrossRunway = 24, SelectRollOutExit = 25, ChangeRunway = 26, RequestTow = 27,
ConfirmTow = 28, StopTow = 29, HoldShortCrossRunway = 30
```
(Stored as `_waitingForCommands : ReactiveProperty<ECommand[]>` on Aircraft — the "waiting for" model used by the editor's command-gating.)

### `AerodromeCode : int` (ContextCross.States) — ICAO aerodrome reference-code letters
`A = 65 … F = 70, L = 76, M = 77, H = 72, J = 74` (code letters for aircraft size limits).

### `WakeTurbulenceCategory : int` (ContextCross.States) — `L / M / H / J` categories.

### `DistanceData` (ContextCross.Data) — distance value with unit
`DistanceUnit : int { Miniature = 0, Meters = 1, NauticalMiles = 2, Kilometers = 3 }`; static `Zero`, `PositiveInfinity`; properties `Meters`, `Kilometers`, `NauticalMiles`, `Miniature`. Used by `DistanceToEnterRunway`, `BrakeTargetDistance`, `RemainSplineLength`.

### `RadioChannel` (ContextCross.Models)
Channel model (frequencies, callsign/name, channel type) — see inventory.

---

## 8. Full class inventory (327 declarations)

| Area | Count | What it is |
|---|---|---|
| `ContextCross.Radio` | 102 | `AircraftRadioIntent` + every `Atc*`/`Captain*` radio event & intent class (pushback, taxi, takeoff, go-around, runway change, cross-runway, tow, etc.) |
| `ContextCross.Dynamics.States` | 25 | movement states + `XxxDynamicsParams` + `IDynamicState` + `GoAroundClimbTransitionProfile` |
| `ContextCross.Models` | 18 | airport/flight models (see §3, §5) + `Path`, `RadioChannel`, `AirwayNode` |
| `ContextCross.Events.PlayerEvent` | 18 | player/AI command events (`PlayerAircraftCommand*`, focus, change-runway, cross-runway, select-exit) |
| `ContextCross.HD` | 16 | HD visuals: `AircraftHD`, animator controllers, camera, lights, audio, tug, model loader, `ColliderAircraftRef` |
| `ContextCross.Services` | 14 | `AircraftApproachService`, `AircraftDepartureRunwayService`, `AircraftFocusService`, `AircraftRadioTransferService`, `AircraftRegistrationService`, `AircraftSpecService`, `ApronService` (+ allocation), `RuntimeAircraftSpawnService`, `RunwayTimelineService`, `EndlessModeFlightPlanProvider`, … |
| `ContextCross.Events` | 14 | domain events (`AircraftEvent`, `RunwayChanged`, `CrossRunwayForbade/Permitted`, `HoldShortOfRunway`, `ContactTower`, `ATISRunwayChangeEvent`, `RunwayIncursionMessageData`, …) |
| `ContextCross.Telemetry` | 12 | `AircraftTelemetryRecord/Status/PacketWriter`, UDP services, radio-channel records |
| `ContextCross.Summary.*` | 35 | post-flight summary: `PlannedFlightRaw`/`ActualFlightRaw`/`OnTimeFlightRaw`, monitors (`FlightStateMonitor`, `RunwayIncursion*`), reducers, events |
| `ContextCross.Managers` | 10 | `AircraftManager`, `AircraftApproachSequencingManager`, `AircraftCheckList`, `AircraftOnRunwayStatus`, `AircraftPhysicalCollisionManager`, `FlightScheduleManager`, `RunwayManager`, `RunwayAircraftManager`, … |
| `ContextCross.Factories` | 9 | `AircraftFactory`, `Aircraft2DFactory`, `AircraftBtnFactory`, `AircraftCallSignFactory`, `AircraftHDFactory`, `Runway2DFactory`, `RunwayFenceFactory`, `Stand2DFactory`, `TaxiwaySegment2DFactory` |
| `ContextCross.Aircrafts(.Enums/.Policies)` | 16 | aircraft subsystem + policies (see §1, §2, inventory) |
| `ContextCross.HD.AirportInfra` | 5 | `JetwayHD`, `JetwayHDContainer`, `JetwayInstancedRenderManager`, `PushbackHD`, `PushbackHDContainer` |
| `ContextCross.States` | 4 | `RunwayTimelineData`, `RunwayChange`, `RunwayChangeFrame` (timeline save model), `AircraftSizeExtensions` |
| `ContextCross.RawDataParser` | 3 | `AircraftRegistrationConfigParser`, `FlightScheduleParser`, `AirportBriefReader` |
| `ContextCross.FlightStrips` | 3 | `FlightStripDisplayPolicy`, `FlightStripPatienceState`, `FlightStripPatienceStore` |
| `ContextCross.Dynamics` | 3 | `Dynamics`, `AircraftDynamicsData`, `AircraftDynamicsInternal` + `AircraftDynamicsInput/Output`, `AircraftStateMock`, `FlyDynamicsData`, `IDynamicsParams`, `SplineTools` |
| `ContextCross.Api.Models` | 5 | projections (§6) |
| API endpoint outputs | 4 | `AircraftOutput`, `AircraftListOutput`, `FlightScheduleListOutput`, `FlightStripListOutput` |
| `ContextCross.Enums` / `Aircrafts.Enums` | 4 | `ECommand`, `EStandEgressType`, `EStandParkingType`, `EAircraftState`… |
| `ContextCross.Summary` / `Levels` / `Clock` / misc | 6 | `AirportData` (levels), `IScheduledAircraftEventQuery`, `Airport`, `AirportSpot2D`, … |
| Modding/Shared | 3 | `AircraftLiveryLoader` (HD), `AircraftModelVersions`, `AircraftLivery` |

> **Appendix: [`aircraft-classes-inventory.md`](aircraft-classes-inventory.md)** — the full per-class detail: declaration line (with base classes/interfaces), serialized fields (name : type), properties, and method lists for all 327 declarations, covering every file listed above (excluding the classes already detailed in §1–§6).

---

## 9. Notes & gotchas for tooling

1. **Namespaces** — gameplay code is `ContextCross.*` in assembly `GroundATC.Core`. `Assembly-CSharp` holds only environment/legacy code (Enviro, Gaia, camera rigs) — no aircraft logic.
2. **`EAircraftState` is sparse** (gaps in numbering) — the literal values are what's persisted in `.acl` saves; don't assume contiguity. `Approach = 5`, `Fly = 30`, `Taxi = 31`, `Towing = 32`.
3. **`State` (Dynamics) ≠ `EAircraftState`** — two different state machines. `Dynamics.State` drives movement physics; `EAircraftState` is the gameplay/command state written to saves. `Aircraft.GetDynamicsState()` bridges them.
4. **Progress ratio** — `Dynamics.GetProgressRatio()` computes path-based progress from the spline (`PathSegment` positions); the save rule (state=5 → write constant 0) comes from the game recalculating on load, not from this method.
5. **`FlightPlan` runtime vs `FlightPlanStaticItem` static** — saves store the static item; `InitializeRuntimeFromStaticItem()` reconstructs the runtime plan (arrival/departure legs, `$iref` static-item resolution).
6. **Runway pairing** — `Runway.Name` is the logical (direction) name; `Runway.PhysicalName` is the physical runway pair — matching memory: v4 save pairs come from `PhysicalName`, not the timeline.
7. **`Serialize` attribute** — fields tagged `[Serialize]` are the save-relevant ones (all listed above); `ReactiveProperty<T>` fields serialize their value, and `_state`/`_flightPlan`/`_taxiPath`/`_waitingForCommands`/`_receivedEvents`/`_radioChannel`/`_jurisdictionRadioChannel`/`_route` are the key serialized runtime state of `Aircraft`.
8. **Turnaround** — one `Aircraft`/`FlightPlan` can serve arrival + departure legs (`HasArrivalLeg`/`HasDepartureLeg`); `CheckArrivalToDeparture()` / `ConfigureDepartureTurnaround()` handle the handover.
9. **Jetway** — `JetwayDocked` reactive property on `Aircraft`; `JetwayHD`/`JetwayHDContainer` under `HD.AirportInfra` (matches the "docked iff off-block > snapshot" game rule research).
10. **Timeline saves** — `RunwayTimelineData` / `RunwayChange` / `RunwayChangeFrame` (ContextCross.States) + `RunwayTimelineService` are the runway-change timeline persisted in level saves.
