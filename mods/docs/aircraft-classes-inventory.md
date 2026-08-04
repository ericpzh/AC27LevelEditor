# Aircraft Class Inventory (IL2CPP dump, DiffableCs)

Generated from Cpp2IL diffable-cs output. Namespaces noted per class; most are `ContextCross.*`.

---

### Aircraft3D (ContextCross.Aircrafts)
- Declaration: `public class Aircraft3D : ManagedBehaviour, IDisposalNode, IDisposable`
- Fields: _rigidbody : Rigidbody; collisionDetector : Collider; noseCollider : Collider; _aircraft : Aircraft; _afterLoadedSubscriber : ISubscriber<AfterLoaded<Aircraft>>; _afterLoadedSubscription : IDisposable; _disposal : DisposalController; _isDestroying : bool
- Properties: DisposalNode : DisposalNode; Source : Aircraft
- Methods: AttachAircraft, Construct, Dispose, OnAfterAircraftLoaded

### AircraftConditionTrigger (ContextCross.Aircrafts)
- Declaration: `public class AircraftConditionTrigger`
- Fields: Condition : ReadOnlyReactiveProperty<bool>; TriggerAction : Action; Subscription : IDisposable
- Properties: (none)
- Methods: (none)

### AircraftFlightMetrics (ContextCross.Aircrafts)
- Declaration: `public class AircraftFlightMetrics : IDisposable`
- Fields: Source (backing) : Aircraft; FlightPlan (backing) : FlightPlan; StarRoute (backing) : Route; Runway (backing) : Runway; OnStarRoute (backing) : bool; RemainingStarDistance (backing) : float; RemainingDistance (backing) : float; SpeedAdjustment (backing) : AircraftFlightSpeedAdjustment; disposable : IDisposable; _currentRoute : Spline; _dynamics : Dynamics; _starRouteEndProgress : float; _prevStarAFM : AircraftFlightMetrics; _nextStarAFM : AircraftFlightMetrics; _prevRunwayAFM : AircraftFlightMetrics; _nextRunwayAFM : AircraftFlightMetrics; _appRouteTime : TimeSpan; _shouldUpdateMetaData : bool; _inited : bool; _airwayRouteService : AirwayRouteService; _gameTime : GameTime
- Properties: DeltaTimeToPlan : TimeSpan; ETA : TimeSpan; FlightPlan : FlightPlan; OnStarRoute : bool; RemainingDistance : float; RemainingStarDistance : float; Runway : Runway; Source : Aircraft; SpeedAdjustment : AircraftFlightSpeedAdjustment; StarRoute : Route
- Methods: Dispose, Init, IsValid, SetRunwayNeighbors, SetStarNeighbors, Update

### AircraftFlightSpeedAdjustment (ContextCross.Aircrafts)
- Declaration: `public enum AircraftFlightSpeedAdjustment : int`
- Values: Maintain = 0, Accelerate = 1, Decelerate = -1, IncreaseAccelerate = 2, IncreaseDecelerate = -2

### RunwaySetter (ContextCross.Aircrafts)
- Declaration: `public enum RunwaySetter : int`
- Values: FlightPlan = 0, ATIS = 1, ATC = 2

### AircraftRadioEventBuilder (ContextCross.Aircrafts)
- Declaration: `public static class AircraftRadioEventBuilder`
- Fields: (none)
- Properties: (none)
- Methods: CreateAtcChangeRunway, CreateAtcClearedForTakeoffAccepted, CreateAtcClearedForTakeoffRejected, CreateAtcClearedToLandAccepted, CreateAtcClearedToLandRejected, CreateAtcClearedToTaxi, CreateAtcContactDeparture, CreateAtcContactGroundWhenApproach, CreateAtcContactGroundWhenDepartureExitRunway, CreateAtcContactTower, CreateAtcContinueApproach, CreateAtcContinueTaxi, CreateAtcForbidCrossRunway, CreateAtcGoAround, CreateAtcHoldPosition, CreateAtcHoldShortOfRunway, CreateAtcLineUpAndWait, CreateAtcPermitCrossRunway, CreateAtcPermitTow, CreateAtcPushbackApproved, CreateAtcRunwayRollout, CreateAtcStandByPushback, CreateAtcStandByTaxi, CreateAtcStopTow, CreateAtcTaxiRouteDeparture, CreateAtcTaxiRouteWhenApproach, CreateCaptainGoingAround, CreateCaptainRequestPushback, CreateCaptainRequestTaxiWhenApproach, CreateCaptainRequestTaxiWhenDeparture, CreateCaptainRequestTaxiWhenDepartureExitRunway, CreateCaptainRequestToLand, CreateCaptainRunwayVacated, CreateCaptainSwitchToTowerFrequency, CreateCaptainTowComplete, CreateCaptainUnableToEnterStand, CreateCaptainWaitingForCrossRunway

### AircraftRunwayCoordinator (ContextCross.Aircrafts)
- Declaration: `public class AircraftRunwayCoordinator : IDisposable`
- Fields: TaxiPathUnPassedIntersectionRunwayNames (backing) : ReactiveProperty<string[]>; TaxiBlockingRunwayNames (backing) : ReactiveProperty<string[]>; RunwayFenceCurrentEnterRunways (backing) : ReactiveProperty<string[]>; RunwayGuardCurrentEnterRunway (backing) : ReactiveProperty<string[]>; CurrentEnterRunways (backing) : ReactiveProperty<string[]>; CrossRunwayPermissions (backing) : ReactiveProperty<string[]>; HoldShortAcknowledgedRunwayNames (backing) : ReactiveProperty<string[]>; RunwaySetter : RunwaySetter; disposable : IDisposable; _disposed : bool
- Properties: BlockByRunwayGuard : bool; CrossRunwayPermissions : ReactiveProperty<string[]>; CurrentEnterRunways : ReactiveProperty<string[]>; HoldShortAcknowledgedRunwayNames : ReactiveProperty<string[]>; RunwayFenceCurrentEnterRunways : ReactiveProperty<string[]>; RunwayGuardCurrentEnterRunway : ReactiveProperty<string[]>; TaxiBlockingRunwayNames : ReactiveProperty<string[]>; TaxiPathUnPassedIntersectionRunwayNames : ReactiveProperty<string[]>
- Methods: AddCrossRunwayPermission, AddHoldShortAcknowledgedRunway, AddRunwayFenceCurrentEnterRunway, AddRunwayGuardCurrentEnterRunway, AddTaxiBlockingRunway, CanSetRunwaySetter, Configure, Dispose, HasCrossRunwayPermission, HasHoldShortAcknowledgedRunway, HasTaxiBlockingRunway, Init, IsInRunway, RemoveCrossRunwayPermission, RemoveHoldShortAcknowledgedRunway, RemoveRunwayFenceCurrentEnterRunway, RemoveRunwayGuardCurrentEnterRunway, RemoveRunwayIntersection, RemoveTaxiBlockingRunway, RemovingBlockingStateAndEnterRunway, Reset, RunwayFenceCurrentInRunway, RunwayGuardCurrentInRunway, SetRunwaySetter, TrySetRunwaySetter

### AircraftUtils (ContextCross.Aircrafts)
- Declaration: `public class AircraftUtils`
- Fields: (none)
- Properties: (none)
- Methods: CheckAircraftRunwayGuardDirection, GetBrakeDistance, GetOccupyingAircraft, IsEntryPoint, IsStandOccupied, IsStandPoint, PointToLineDistance

### AircraftArrivalPolicy (ContextCross.Aircrafts.Policies)
- Declaration: `public static class AircraftArrivalPolicy`
- Fields: (none)
- Properties: (none)
- Methods: CanGoAround, CanStartRunwayExitSelection, HasSelectableRunwayExit, IsGoAroundVisible, IsReadyForLandingCommand

### AircraftCommandRestrictionPolicy (ContextCross.Aircrafts.Policies)
- Declaration: `public sealed class AircraftCommandRestrictionPolicy`
- Fields: AllCommands : HashSet<ECommand>; _allowedCommands : HashSet<ECommand>; _isRestrictionActive : bool; RestrictionsChanged (backing) : Action
- Properties: RestrictionsChanged : event Action
- Methods: ClearRestrictions, IsCommandAllowed, SetAllowedCommands, SetBlockedCommands

### AircraftDeparturePolicy (ContextCross.Aircrafts.Policies)
- Declaration: `public static class AircraftDeparturePolicy`
- Fields: (none)
- Properties: (none)
- Methods: CanClearForTakeoff, CanSelectTargetRunway, DoesTaxiPathMatchScheduledRunway, IsLinedUpForTakeoffCommand, IsReadyForTakeoffCommand, IsTakeoffAvailable

### AircraftGroundMovementPolicy (ContextCross.Aircrafts.Policies)
- Declaration: `public sealed class AircraftGroundMovementPolicy`
- Fields: _taxiPathAvoidedAircraft : HashSet<Aircraft>; _maxTaxiPathLengthMeters : Nullable<float>; _departureTaxiEndMustBeRunwayEntry : bool; _isTaxiPathAvoidStaticAircraftRestrictionActive : bool; _taxiPathAvoidStaticAircraftPassThroughDistanceMeters : float; RestrictionsChanged (backing) : Action
- Properties: RestrictionsChanged : event Action
- Methods: CanChangeTaxiPath, CanConfirmTowTarget, CanContinueTaxi, CanPauseTaxi, CanStartPushbackPlanning, CanStartTaxiPlanning, CanStartTowPlanning, CanStopTow, ClearRestrictions, IsArrivalTaxiPlanning, IsDepartureTaxiPlanning, IsPushbackPlanning, IsTaxiPathValidForConfirm, SetDepartureTaxiEndMustBeRunwayEntryRestriction, SetTaxiPathAvoidStaticAircraftRestriction, SetTaxiPathLengthRestriction

### AircraftRadioTransferPolicy (ContextCross.Aircrafts.Policies)
- Declaration: `public static class AircraftRadioTransferPolicy`
- Fields: (none)
- Properties: (none)
- Methods: CanContactGround, IsGroundJurisdiction, IsHandoffPending, IsReadyToContactApproach, IsReadyToContactDeparture, IsReadyToContactTower, IsTowerJurisdiction

### AircraftRunwayPolicy (ContextCross.Aircrafts.Policies)
- Declaration: `public sealed class AircraftRunwayPolicy`
- Fields: _allowedRunwayNames : HashSet<string>; _allowedCrossingRunwayNames : HashSet<string>; _isRunwaySelectionRestrictionActive : bool; _isRunwayCrossingRestrictionActive : bool; RestrictionsChanged (backing) : Action
- Properties: RestrictionsChanged : event Action
- Methods: CanStartCrossRunwaySelection, ClearRestrictions, GetSelectableCrossRunways, GetSelectableRunways, HasSelectableCrossRunway, IsRunwayCrossingAllowed, IsRunwaySelectionAllowed, SetRunwayCrossingRestriction, SetRunwaySelectionRestriction

### EAircraftPart (ContextCross.Aircrafts.Enums)
- Declaration: `public enum EAircraftPart : int`
- Values: Nose = 0, LeftWing = 1, RightWing = 2, Tail = 3

### EAircraftTrigger (ContextCross.Aircrafts.Enums)
- Declaration: `public enum EAircraftTrigger : int`
- Values: RequestTaxi = 1, PauseTaxi = 2, TakeOff = 3, LineUp = 4, LineUpToTaxi = 5, ContactDeparture = 6, ContactDepartureGoAround = 7, TouchDown = 8, RollFinishWithPath = 9, RollFinishWithoutPath = 10, AtSpot = 11, Approach = 12, GoAround = 13, Pushback = 14, TaxiParking = 15, Taxi = 16, ArrivalToDeparture = 17, StartTow = 18, StopTow = 19

---
### AircraftProjection (ContextCross.Api.Models)
- Declaration: `public sealed class AircraftProjection`
- Fields: AircraftPk (backing) : string; CallSign (backing) : string; Registration (backing) : string; AircraftType (backing) : string; FlightDirection (backing) : string; State (backing) : string; CurrentRadioChannelPk (backing) : string; JurisdictionRadioChannelPk (backing) : string; Runway (backing) : string; Stand (backing) : string; Star (backing) : string; Route (backing) : string; OperationStartTime (backing) : GameDateTime; OperationEndTime (backing) : GameDateTime; Position (backing) : WorldPosition; Direction (backing) : WorldDirection; GroundSpeedKnots (backing) : float; AirSpeedKnots (backing) : float
- Properties: AircraftPk : string; AircraftType : string; AirSpeedKnots : float; CallSign : string; CurrentRadioChannelPk : string; Direction : WorldDirection; FlightDirection : string; GroundSpeedKnots : float; JurisdictionRadioChannelPk : string; OperationEndTime : GameDateTime; OperationStartTime : GameDateTime; Position : WorldPosition; Registration : string; Route : string; Runway : string; Stand : string; Star : string; State : string
- Methods: (ctor internal, no public methods)

### ArrivalFlightScheduleProjection (ContextCross.Api.Models)
- Declaration: `public sealed class ArrivalFlightScheduleProjection`
- Fields: FlightPlanPk (backing) : string; Registration (backing) : string; CallSign (backing) : string; Stand (backing) : string; Runway (backing) : string; LandingTime (backing) : GameDateTime; InBlockTime (backing) : GameDateTime
- Properties: CallSign : string; FlightPlanPk : string; InBlockTime : GameDateTime; LandingTime : GameDateTime; Registration : string; Runway : string; Stand : string
- Methods: (ctor internal, no public methods)

### DepartureFlightScheduleProjection (ContextCross.Api.Models)
- Declaration: `public sealed class DepartureFlightScheduleProjection`
- Fields: FlightPlanPk (backing) : string; Registration (backing) : string; CallSign (backing) : string; Stand (backing) : string; Runway (backing) : string; ScheduledOffBlockTime (backing) : GameDateTime; OffBlockTime (backing) : GameDateTime; TakeoffTime (backing) : GameDateTime
- Properties: CallSign : string; FlightPlanPk : string; OffBlockTime : GameDateTime; Registration : string; Runway : string; ScheduledOffBlockTime : GameDateTime; Stand : string; TakeoffTime : GameDateTime
- Methods: (ctor internal, no public methods)

### FlightStripChannelProjection (ContextCross.Api.Models)
- Declaration: `public sealed class FlightStripChannelProjection : RadioChannelProjection`
- Fields: Strips (backing) : FlightStripProjection[]
- Properties: Strips : FlightStripProjection[]
- Methods: (ctor internal, no public methods)

### FlightStripProjection (ContextCross.Api.Models)
- Declaration: `public sealed class FlightStripProjection`
- Fields: AircraftPk (backing) : string; CallSign (backing) : string; FlightDirection (backing) : string; IsRadioCommunicating (backing) : bool; AlertDotVisible (backing) : bool
- Properties: AircraftPk : string; AlertDotVisible : bool; CallSign : string; FlightDirection : string; IsRadioCommunicating : bool
- Methods: (ctor internal, no public methods)

### AircraftOutput (ContextCross.Api.Endpoints.Aircraft.Get)
- Declaration: `public sealed class AircraftOutput : IApiOutput`
- Fields: Aircraft (backing) : AircraftProjection
- Properties: Aircraft : AircraftProjection
- Methods: (none)

### AircraftListOutput (ContextCross.Api.Endpoints.Aircraft.List)
- Declaration: `public sealed class AircraftListOutput : IApiOutput`
- Fields: Aircraft (backing) : AircraftProjection[]
- Properties: Aircraft : AircraftProjection[]
- Methods: Create (internal static)

### FlightScheduleListOutput (ContextCross.Api.Endpoints.FlightSchedule.List)
- Declaration: `public sealed class FlightScheduleListOutput : IApiOutput`
- Fields: Arrivals (backing) : ArrivalFlightScheduleProjection[]; Departures (backing) : DepartureFlightScheduleProjection[]
- Properties: Arrivals : ArrivalFlightScheduleProjection[]; Departures : DepartureFlightScheduleProjection[]
- Methods: Create (internal static)

### FlightStripListOutput (ContextCross.Api.Endpoints.FlightStrip.List)
- Declaration: `public sealed class FlightStripListOutput : IApiOutput`
- Fields: Channels (backing) : FlightStripChannelProjection[]
- Properties: Channels : FlightStripChannelProjection[]
- Methods: Create (internal static)

### IScheduledAircraftEventQuery (ContextCross.Clock)
- Declaration: `public interface IScheduledAircraftEventQuery`
- Fields: (none)
- Properties: EventQueueRevision : ReadOnlyReactiveProperty<int>
- Methods: HasPendingEvent

---
### AircraftDynamicsInput (ContextCross.Dynamics)
- Declaration: `public struct AircraftDynamicsInput`
- Fields: Position : Vector3; Direction : Vector3; ForwardSpeed : bool
- Properties: (none)
- Methods: (none)

### AircraftDynamicsOutput (ContextCross.Dynamics)
- Declaration: `public struct AircraftDynamicsOutput`
- Fields: Position : Vector3; Direction : Vector3; FrontWheelSteeringAngle : float
- Properties: (none)
- Methods: (none)

### AircraftStateMock (ContextCross.Dynamics)
- Declaration: `public struct AircraftStateMock`
- Fields: position : Vector3; velocity : Vector3; taxiSpeed : float; spotPosition : Vector3; targetPosition : Vector3; immediateTaxi : bool; immediateTakeoff : bool; terminalSpeed : float; needGoAround : bool; progressRatio : float; goAroundStartPosition : Vector3; goAroundEndPosition : Vector3; touchDownPosition : Vector3; approachDirection : Vector3; targetTaxiSpeed : float; taxiAcceleration : float
- Properties: (none)
- Methods: (none)

### IDynamicState (ContextCross.Dynamics.States)
- Declaration: `public interface IDynamicState`
- Fields: (none)
- Properties: State : State
- Methods: GetProgressRatio, Init, Save, Update

### ApproachDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class ApproachDynamicsParams : IDynamicsParams`
- Fields: ProgressRatio : float; TouchDownPosition : Vector3; ApproachDirection : Vector3; CommandedGoAround : bool; InitialPosition : Vector3; PathPointList : List<Vector3>
- Properties: (none)
- Methods: DeepClone

### ApproachState (ContextCross.Dynamics.States)
- Declaration: `public class ApproachState : IDynamicState`
- Fields: NeedGoAround (backing) : bool; _context : Dynamics; _runtimeData : ApproachDynamicsParams; _pathPointList : List<Vector3>; _initialPosition : Vector3; _approachDirection : Vector3; _touchDownPosition : Vector3; startingProgress : float; afm : AircraftFlightMetrics
- Properties: NeedGoAround : bool; State : State
- Methods: GetApproachDynamicsByProgressRatio, GetProgressRatio, Init, Save, Update

### FlyApproachDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class FlyApproachDynamicsParams : IDynamicsParams`
- Fields: ProgressRatio : float; FlyApproachPathPointList : List<Vector3>; AppPointList : List<Vector3>
- Properties: (none)
- Methods: DeepClone

### FlyApproachState (ContextCross.Dynamics.States)
- Declaration: `public class FlyApproachState : IDynamicState`
- Fields: NeedGoAround (backing) : bool; _context : Dynamics; _runtimeData : FlyApproachDynamicsParams; _flyApproachPathPointList : List<Vector3>; _appPointList : List<Vector3>; standardFlightSpeed : float; afm : AircraftFlightMetrics
- Properties: NeedGoAround : bool; State : State
- Methods: GetProgressRatio, Init, Save, Update

### GoAroundClimbTransitionProfile (ContextCross.Dynamics.States)
- Declaration: `public class GoAroundClimbTransitionProfile`
- Nested: ClimbSegment (struct) — DurationSeconds : float, StartRateDeg : float, EndRateDeg : float
- Fields: _forceSkipArrestDescent : bool; _segments : ClimbSegment[]; _segmentTicks : ulong[]
- Properties: (none)
- Methods: Advance, EvaluateClimbRateDeg, ShouldUseArrestFakeTarget

### GoAroundDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class GoAroundDynamicsParams : IDynamicsParams`
- Fields: ProgressRatio : float; InitHeightFeet : float; InitAirSpeedKnot : float; ArrestStartHeightChangeRateDeg : float; StartPosition : Vector3; MissedApproachPoints : List<Vector3>; ClimbElapsedTicks : ulong
- Properties: (none)
- Methods: DeepClone

### GoingAroundState (ContextCross.Dynamics.States)
- Declaration: `public class GoingAroundState : IDynamicState`
- Fields: HeightGoAroundTarget : HeightData; HeightGoAroundArrestMinimum : HeightData; HeightGoAroundArrestFakeTargetOffset : HeightData; _context : Dynamics; _runtimeData : GoAroundDynamicsParams; _initHeightFeet : float; _initAirSpeedKnot : float; _arrestStartHeightChangeRateDeg : float; _startPosition : Vector3; _missedApproachPoints : List<Vector3>; _pathPointList : List<Vector3>; _climbElapsedTicks : ulong; _climbTransitionProfile : GoAroundClimbTransitionProfile
- Properties: State : State
- Methods: GetProgressRatio, Init, ProjectPointOnLine, Save, Update

### PushbackDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class PushbackDynamicsParams : IDynamicsParams`
- Fields: PathPointList : List<Vector3>; ProgressRatio : float
- Properties: (none)
- Methods: DeepClone

### PushbackState (ContextCross.Dynamics.States)
- Declaration: `public class PushbackState : IDynamicState`
- Fields: _context : Dynamics; _runtimeData : PushbackDynamicsParams; _pathPointList : List<Vector3>; _dyController : Controller
- Properties: State : State
- Methods: GetProgressRatio, Init, Save, Update

### ReadyForTaxiState (ContextCross.Dynamics.States)
- Declaration: `public class ReadyForTaxiState : IDynamicState`
- Fields: _context : Dynamics
- Properties: State : State
- Methods: GetProgressRatio, Init, Save, Update

### RollingDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class RollingDynamicsParams : IDynamicsParams`
- Fields: ProgressRatio : float; PathPointList : List<Vector3>; TaxiPermitted : bool; PathEndWithStand : bool; TerminalSpeed : float; TerminalSet : bool; EnterExit : bool; TouchDownSpeed : float
- Properties: (none)
- Methods: DeepClone

### RollingState (ContextCross.Dynamics.States)
- Declaration: `public class RollingState : IDynamicState`
- Fields: ImmediateTaxi (backing) : bool; _context : Dynamics; _runtimeData : RollingDynamicsParams; _pathPointList : List<Vector3>; _terminalSpeed : float; _terminalSet : bool; _enterExit : bool; _pathEndWithStand : bool; _touchDownSpeed : float; targetBreakDistance : float
- Properties: ImmediateTaxi : bool; State : State; TouchDownSpeed : float
- Methods: GetProgressRatio, Init, ResetTerminal, Save, SetEnterExit, SetImmediateTaxi, SetPathEndWithStand, Update

### TakeoffInAirDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class TakeoffInAirDynamicsParams : IDynamicsParams`
- Fields: ProgressRatio : float; InitPosition : Vector3; PathPointList : List<Vector3>; TakeoffTimeElapsed : float
- Properties: (none)
- Methods: DeepClone

### TakeoffInAirState (ContextCross.Dynamics.States)
- Declaration: `public class TakeoffInAirState : IDynamicState`
- Fields: HeightDepartureTarget : HeightData; _context : Dynamics; _runtimeData : TakeoffInAirDynamicsParams; _initPosition : Vector3; _takeoffTimeElapsed : float; _pathPointList : List<Vector3>
- Properties: State : State
- Methods: EvaluateClimbRateDeg (internal static), GetProgressRatio, Init, ProjectPointOnLine, Save, Update

### TakeoffOnRunwayDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class TakeoffOnRunwayDynamicsParams : IDynamicsParams`
- Fields: AlignCompletion : bool; ProgressRatio : float; InitSpeedKnot : float; InitPosition : Vector3
- Properties: (none)
- Methods: DeepClone

### TakeoffOnRunwayState (ContextCross.Dynamics.States)
- Declaration: `public class TakeoffOnRunwayState : IDynamicState`
- Fields: _context : Dynamics; _runtimeData : TakeoffOnRunwayDynamicsParams; _initSpeedKnot : float; _initPosition : Vector3; _pathPointList : List<Vector3>
- Properties: State : State
- Methods: GetProgressRatio, Init, ProjectPointOnLine, Save, Update

### TaxiAlignDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class TaxiAlignDynamicsParams : IDynamicsParams`
- Fields: ProgressRatio : float; PathPointList : List<Vector3>; TerminalSet : bool; TakeoffPermitted : bool; GoalDirection : Vector3
- Properties: (none)
- Methods: DeepClone

### TaxiAlignState (ContextCross.Dynamics.States)
- Declaration: `public class TaxiAlignState : IDynamicState`
- Fields: _context : Dynamics; _runtimeData : TaxiAlignDynamicsParams; _pathPointList : List<Vector3>; _totalDistance : float; _terminalSet : bool; _immediateTakeoff : bool; _goalDirection : Vector3
- Properties: State : State
- Methods: GetProgressRatio, Init, OverrideImmediateTakeoff, Save, Update

### TaxiArrivalDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class TaxiArrivalDynamicsParams : IDynamicsParams`
- Fields: PathPointList : List<Vector3>; ProgressRatio : float; TerminalSet : bool; PathEndWithStand : bool; TerminalSpeed : float
- Properties: (none)
- Methods: DeepClone

### TaxiArrivalParkingState (ContextCross.Dynamics.States)
- Declaration: `public class TaxiArrivalParkingState : IDynamicState`
- Fields: _context : Dynamics; _runtimeData : TaxiArrivalDynamicsParams; _pathPointList : List<Vector3>; _progressRollDistance : float; _terminalSet : bool; _terminalSpeed : float; _totalRollDistance : float; _trailingWheelPosition : Vector3
- Properties: State : State
- Methods: GetProgressRatio, Init, Save, Update

### TaxiArrivalState (ContextCross.Dynamics.States)
- Declaration: `public class TaxiArrivalState : IDynamicState`
- Fields: _context : Dynamics; _runtimeData : TaxiArrivalDynamicsParams; _pathPointList : List<Vector3>; _progressRollDistance : float; _standDirection : Vector3; _standEntryPosition : Vector3; _standExitPosition : Vector3; _terminalSet : bool; _pathEndWithStand : bool; _terminalSpeed : float; _totalRollDistance : float
- Properties: State : State
- Methods: GetProgressRatio, Init, Save, Update

### TaxiDepartureDynamicsParams (ContextCross.Dynamics.States)
- Declaration: `public class TaxiDepartureDynamicsParams : IDynamicsParams`
- Fields: ProgressRatio : float; PathPointList : List<Vector3>; StartDirection : Vector3; GoalDirection : Vector3; TakeoffPermitted : bool; TerminalSpeed : float; TerminalSet : bool; IsTaxiToRunwayEntry : bool; LineUpPermitted : bool
- Properties: (none)
- Methods: DeepClone

### TaxiDepartureState (ContextCross.Dynamics.States)
- Declaration: `public class TaxiDepartureState : IDynamicState`
- Fields: _immediateTakeoff : bool; _context : Dynamics; _runtimeData : TaxiDepartureDynamicsParams; _pathPointList : List<Vector3>; _startDirection : Vector3; _goalDirection : Vector3; _terminalSpeed : float; _totalDistance : float; _progressDistance : float; _terminalSet : bool; _magicDistance : float; _trailingWheelPosition : Vector3; _isTaxiToRunwayEntry : bool; _lineUpPermitted : bool
- Properties: State : State
- Methods: GetProgressRatio, Init, Save, SetImmediateTakeoff, SetLineUpPermitted, Update

### TaxiPausingState (ContextCross.Dynamics.States)
- Declaration: `public class TaxiPausingState : IDynamicState`
- Fields: _context : Dynamics; _pathPointList : List<Vector3>; _terminalSpeed : float; _taxiArrivalData : TaxiArrivalDynamicsParams; _taxiDepartureData : TaxiDepartureDynamicsParams
- Properties: State : State
- Methods: GetProgressRatio, Init, Save, TaxiPausedToContinueTaxi, Update

---
### EStandEgressType (ContextCross.Enums)
- Declaration: `public enum EStandEgressType : int`
- Values: PushOut = 0, TaxiOut = 1

### EStandParkingType (ContextCross.Enums)
- Declaration: `public enum EStandParkingType : int`
- Values: Parrallel = 0, NoseIn = 1, NoseOut = 2, AngledNoseIn = 3, AngledNoseOut = 4

### AircraftEvent (ContextCross.Events)
- Declaration: `public abstract class AircraftEvent : IDeepCloneable<AircraftEvent>, IDeepCloneable`
- Fields: EventType : EEventType; ScheduledDelay : float; ScheduledTick : ulong; CancellationToken : int; Target : string; SourceType : EEventSourceType; Source : string; GameTick : ulong; WallTime : double; DependsOnType : Type; DependsOn : int; Delay : ulong
- Properties: (none)
- Methods: DeepClone, GetHashCode

### AircraftFlightScheduleStateChangeEvent (ContextCross.Events)
- Declaration: `public class AircraftFlightScheduleStateChangeEvent`
- Fields: Aircraft (backing) : Aircraft; EventTime (backing) : DateTime; EventState (backing) : EAircraftFlightScheduleChangeState
- Properties: Aircraft : Aircraft; EventState : EAircraftFlightScheduleChangeState; EventTime : DateTime
- Methods: (none)

### AircraftPhysicsOverlap (ContextCross.Events)
- Declaration: `public sealed class AircraftPhysicsOverlap`
- Fields: Self : Aircraft; Other : Aircraft; TriggerCollider : Collider; OtherCollider : Collider
- Properties: (none)
- Methods: (none)

### AircraftRadioChannelChanged (ContextCross.Events)
- Declaration: `public class AircraftRadioChannelChanged`
- Fields: AircraftPk (backing) : string; Channel (backing) : RadioChannel; Registration (backing) : string; TaskType (backing) : EFlightDirection
- Properties: AircraftPk : string; Channel : RadioChannel; Registration : string; TaskType : EFlightDirection
- Methods: (none)

### EAircraftFlightScheduleChangeState (ContextCross.Events)
- Declaration: `public enum EAircraftFlightScheduleChangeState : int`
- Values: AtSpot = 0, HandOff = 1, Destroy = 2

### ContactTower (ContextCross.Events)
- Declaration: `public class ContactTower : AircraftEvent`
- Fields: (inherits AircraftEvent)
- Methods: (none)

### ReadyForContactTower (ContextCross.Events)
- Declaration: `public class ReadyForContactTower : AircraftEvent`
- Fields: (inherits AircraftEvent)
- Methods: (none)

### RunwayChanged (ContextCross.Events)
- Declaration: `public class RunwayChanged : AircraftEvent`
- Fields: newRunwayPk : string
- Methods: DeepClone

### CrossRunwayForbade (ContextCross.Events)
- Declaration: `public class CrossRunwayForbade : AircraftEvent`
- Fields: PhysicalRunwayName : string
- Methods: (none)

### CrossRunwayPermitted (ContextCross.Events)
- Declaration: `public class CrossRunwayPermitted : AircraftEvent`
- Fields: PhysicalRunwayName : string
- Methods: (none)

### HoldShortOfRunway (ContextCross.Events)
- Declaration: `public class HoldShortOfRunway : AircraftEvent`
- Fields: (inherits AircraftEvent)
- Methods: (none)

### ATISRunwayChangeEvent (ContextCross.Events)
- Declaration: `public class ATISRunwayChangeEvent : ATISEvent`
- Fields: SourceRunway : Runway; DestinationRunway : Runway
- Methods: Conflict

### RunwayIncursionMessageData (ContextCross.Events)
- Declaration: `public sealed class RunwayIncursionMessageData : MessageData`
- Fields: PrimaryCallsign (backing) : string; SecondaryCallsign (backing) : string; Runway (backing) : string; Scenario (backing) : RunwayIncursionScenario
- Properties: PrimaryCallsign : string; Runway : string; Scenario : RunwayIncursionScenario; SecondaryCallsign : string
- Methods: (none)

### AircraftCollisionDemoEndRequested (ContextCross.Events)
- Declaration: `public sealed class AircraftCollisionDemoEndRequested : IGameFailRequest`
- Fields: Overlap (backing) : AircraftPhysicsOverlap; Tick (backing) : ulong; Timestamp (backing) : DateTime
- Properties: Identifier : string; Overlap : AircraftPhysicsOverlap; Parameters : object[]; Tick : ulong; Timestamp : DateTime
- Methods: (none)

### IPlayerEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public interface IPlayerEvent`
- Properties: URI : string
- Methods: (none)

### IAircraftRelatedEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public interface IAircraftRelatedEvent : IPlayerEvent`
- Properties: AircraftPk : string
- Methods: (none)

### ICommandEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public interface ICommandEvent : IAircraftRelatedEvent, IPlayerEvent`
- (no members)

### IRadarEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public interface IRadarEvent : IPlayerEvent`
- Properties: RadarLayer : RadarLayer
- Methods: (none)

### ISelectionEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public interface ISelectionEvent : IAircraftRelatedEvent, IPlayerEvent`
- (no members)

### PlayerAircraftCommandChangeRunwayEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerAircraftCommandChangeRunwayEvent : ICommandEvent, IAircraftRelatedEvent, IPlayerEvent`
- Fields: AircraftPk (backing) : string; RunwayName : string
- Properties: AircraftPk : string; URI : string
- Methods: (none)

### PlayerAircraftCommandCrossRunwayEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerAircraftCommandCrossRunwayEvent : ICommandEvent, IAircraftRelatedEvent, IPlayerEvent`
- Fields: AircraftPk (backing) : string; RunwayName : string; IsPermitted : bool
- Properties: AircraftPk : string; URI : string
- Methods: (none)

### PlayerAircraftCommandEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerAircraftCommandEvent : ICommandEvent, IAircraftRelatedEvent, IPlayerEvent`
- Fields: Command : ECommand; AircraftPk (backing) : string
- Properties: AircraftPk : string; URI : string
- Methods: (none)

### PlayerAircraftCommandSelectExitEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerAircraftCommandSelectExitEvent : ICommandEvent, IAircraftRelatedEvent, IPlayerEvent`
- Fields: AircraftPk (backing) : string; RunwayPk : string; ExitIndex : int
- Properties: AircraftPk : string; URI : string
- Methods: (none)

### PlayerAircraftFocusEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerAircraftFocusEvent : IAircraftRelatedEvent, IPlayerEvent`
- Fields: AircraftPk (backing) : string
- Properties: AircraftPk : string; URI : string
- Methods: (none)

### PlayerEventExtensions (ContextCross.Events.PlayerEvent)
- Declaration: `public static class PlayerEventExtensions`
- Methods: IsCommandEvent, IsRadarEvent, IsRelatedToAircraft, IsSelectionEvent, TryGetAircraftPk, TryGetRadarLayer

### PlayerGameViewDragEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerGameViewDragEvent : IPlayerEvent`
- Fields: Delta (backing) : Vector2; IsAircraftFollowView (backing) : bool
- Properties: Delta : Vector2; IsAircraftFollowView : bool; URI : string
- Methods: (none)

### PlayerPushBackPointSelectEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerPushBackPointSelectEvent : ISelectionEvent, IAircraftRelatedEvent, IPlayerEvent`
- Fields: AircraftPk (backing) : string; PushBackPointPk : string
- Properties: AircraftPk : string; URI : string
- Methods: (none)

### PlayerRenderTextureDragEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerRenderTextureDragEvent : IRadarEvent, IPlayerEvent`
- Fields: RadarLayer (backing) : RadarLayer; DeltaToStart : Vector2; CameraPosition : Vector3
- Properties: RadarLayer : RadarLayer; URI : string
- Methods: (none)

### PlayerRenderTextureScrollEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerRenderTextureScrollEvent : IRadarEvent, IPlayerEvent`
- Fields: RadarLayer (backing) : RadarLayer; Delta : float; PixelPerUnit : float
- Properties: RadarLayer : RadarLayer; URI : string
- Methods: (none)

### PlayerTaxiNavigationPointSelectEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerTaxiNavigationPointSelectEvent : ISelectionEvent, IAircraftRelatedEvent, IPlayerEvent`
- Fields: AircraftPk (backing) : string; NavigationPointPk : string; FreeEdgeId : int; FreeT : float
- Properties: AircraftPk : string; URI : string
- Methods: (none)

### PlayerTaxiNavigationPointUnselectEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerTaxiNavigationPointUnselectEvent : ISelectionEvent, IAircraftRelatedEvent, IPlayerEvent`
- Fields: AircraftPk (backing) : string; NavigationPointPk : string; FreeEdgeId : int; FreeT : float
- Properties: AircraftPk : string; URI : string
- Methods: (none)

### PlayerTimeControlEvent (ContextCross.Events.PlayerEvent)
- Declaration: `public struct PlayerTimeControlEvent : IPlayerEvent`
- Nested: Kind (enum) — PauseToggled = 0, TimeScaleChanged = 1
- Fields: ControlKind (backing) : Kind
- Properties: ControlKind : Kind; URI : string
- Methods: (none)

---
### Aircraft2DFactory (ContextCross.Factories)
- Declaration: `public class Aircraft2DFactory : IDisposable, IStartable`
- Fields: _approachRadarPrefab : Aircraft2D; _resolver : IObjectResolver; _subscriber : ISubscriber<AfterLoaded<Aircraft>>; _surfaceRadarPrefab : Aircraft2D; _surfaceRadar2DElementsManager : SurfaceRadar2DElementsManager; _approachRadar2DElementsManager : ApproachRadar2DElementsManager; _aircraftViewModel : Aircraft2DViewModel; _disposable : IDisposable
- Properties: (none)
- Methods: Dispose, Start

### AircraftBtnFactory (ContextCross.Factories)
- Declaration: `public class AircraftBtnFactory : IDisposable, IStartable`
- Fields: _disposable : IDisposable; _prefab : GameObject; _resolver : IObjectResolver; _subscriber : ISubscriber<AfterLoaded<Aircraft>>
- Properties: (none)
- Methods: Create, Dispose, Start

### AircraftCallSignFactory (ContextCross.Factories)
- Declaration: `public class AircraftCallSignFactory : IDisposable, IStartable`
- Fields: _disposable : IDisposable; _subscriber : ISubscriber<AfterLoaded<Aircraft>>; _resolver : IObjectResolver; _prefab : GameObject
- Properties: (none)
- Methods: Create, Dispose, Start

### AircraftFactory (ContextCross.Factories)
- Declaration: `public class AircraftFactory : IInitializable, IDisposable`
- Fields: _resolver : IObjectResolver; _parent : Transform; _activeViews : Dictionary<Aircraft, Aircraft3D>; _unloadSubscription : IDisposable; _initializedSubscription : IDisposable; _aircraftEventPublisher : IPublisher<AircraftEvent>; _arrivalAircraftAtSpotPublisher : IPublisher<AircraftFlightScheduleStateChangeEvent>; _aircraftEventSubscriber : ISubscriber<AircraftEvent>; _atisEventSubscriber : ISubscriber<ATISEvent>; _approachSequenceSubscriber : ISubscriber<AircraftApproachSequence>; _navigationService : NavigationService; _aircraftCheckList : AircraftCheckList; _weatherManager : WeatherManager; _airwayRouteService : AirwayRouteService; _radioChannelManager : RadioChannelManager; _radioIntentPublisher : IPublisher<AircraftRadioIntent>; _runwayManager : RunwayManager; _scheduledAircraftEventQuery : IScheduledAircraftEventQuery; _dynamicCurveAsset : DynamicCurveAsset; _aircraftParent : Transform; _gameTime : GameTime; _registry : IGameStateRegistry; _runwayIncursionSubscriber : ISubscriber<RunwayIncursionDetected>; _activeRunwayIncursionQuery : IActiveRunwayIncursionQuery
- Properties: (none)
- Methods: Create, Dispose, Initialize

### AircraftHDFactory (ContextCross.Factories)
- Declaration: `public class AircraftHDFactory : IDisposable, IStartable`
- Fields: _disposable : IDisposable; _resolver : IObjectResolver; _registry : IGameStateRegistry; _aircraftSubscriber : ISubscriber<AfterLoaded<Aircraft>>; _animatorSubscriber : ISubscriber<AfterLoaded<AircraftAnimator>>; _pendingAircraftByPk : Dictionary<string, Aircraft>; _pendingCreateContinuations : List<IDisposable>; _levelLifecycle : ILevelLifecycle; _aircraftModelLoader : AircraftModelLoader; _aircraftLiveryService : LiveryService; _3DRoot : GameObject
- Properties: (none)
- Methods: Create, Dispose, Start

### Runway2DFactory (ContextCross.Factories)
- Declaration: `public class Runway2DFactory : IDisposable, IStartable`
- Fields: _runwayPrefab : Runway2D; _airportSpotPrefab : AirportSpot2D; _runwayLabelPrefab : RunwayLabel2D; _exitNamePrefab : TaxiwayName2D; _resolver : IObjectResolver; _subscriber : ISubscriber<AfterLoaded<Runway>>; _surfaceRadar2DElementsManager : SurfaceRadar2DElementsManager; _approachRadar2DElementsManager : ApproachRadar2DElementsManager; _runwayViewModel : RunwayViewModel; _disposable : IDisposable; _generatedSpot : bool
- Properties: (none)
- Methods: Create, CreateLabel2D, Dispose, Start

### RunwayFenceFactory (ContextCross.Factories)
- Declaration: `public class RunwayFenceFactory : IDisposable, IStartable`
- Fields: _resolver : IObjectResolver; _prefab : RunwayFence; _subscriber : ISubscriber<AfterLoaded<Runway>>; _disposable : IDisposable; _processedPhysicalRunways : HashSet<string>
- Properties: (none)
- Methods: Create, Dispose, Start

### Stand2DFactory (ContextCross.Factories)
- Declaration: `public class Stand2DFactory : IDisposable, IStartable`
- Fields: _prefab : Stand2D; _resolver : IObjectResolver; _subscriber : ISubscriber<AfterLoaded<Stand>>; _surfaceRadar2DElementsManager : SurfaceRadar2DElementsManager; _disposable : IDisposable
- Properties: (none)
- Methods: Create, Dispose, Start

### TaxiwaySegment2DFactory (ContextCross.Factories)
- Declaration: `public class TaxiwaySegment2DFactory : IDisposable, IStartable`
- Fields: _lifecycleSubscription : IDisposable; _normalPrefab : TaxiwaySegment2D; _runwayPrefab : TaxiwaySegment2D; _resolver : IObjectResolver; _elementsManager : SurfaceRadar2DElementsManager; _registry : IGameStateRegistry; _levelLifecycle : ILevelLifecycle
- Properties: (none)
- Methods: Create, Dispose, Start

---
### FlightStripDisplayPolicy (ContextCross.FlightStrips)
- Declaration: `public static class FlightStripDisplayPolicy`
- Fields: (none)
- Properties: (none)
- Methods: IsAlertDotVisible, IsVisible

### FlightStripPatienceState (ContextCross.FlightStrips)
- Declaration: `public struct FlightStripPatienceState`
- Fields: IsAvailable (backing) : bool; NormalizedRemaining (backing) : float; IsActive (backing) : bool
- Properties: IsActive : bool; IsAvailable : bool; NormalizedRemaining : float
- Methods: (none)

### FlightStripPatienceStore (ContextCross.FlightStrips)
- Declaration: `public sealed class FlightStripPatienceStore : IStartable, IDisposable`
- Fields: _patienceSubscriber : ISubscriber<ConversationPatienceUpdated>; _aircraftUnloadedSubscriber : ISubscriber<BeforeUnloading<Aircraft>>; _patienceByAircraft : Dictionary<string, FlightStripPatienceState>; _subscription : IDisposable; _disposed : bool
- Properties: (none)
- Methods: Dispose, GetPatienceState, Start

### AirportData (ContextCross.Levels)
- Declaration: `public struct AirportData`
- Fields: sceneName (backing) : string; levelPartName (backing) : string; levels (backing) : IReadOnlyList<LevelData>; isOpen (backing) : bool
- Properties: isOpen : bool; levelPartName : string; levels : IReadOnlyList<LevelData>; sceneName : string
- Methods: (none)

### AircraftApproachSequence (ContextCross.Managers)
- Declaration: `public class AircraftApproachSequence`
- Fields: AircraftDict : Dictionary<object, List<Aircraft>>; Aircrafts : List<Aircraft>
- Properties: (none)
- Methods: (none)

### AircraftApproachSequencingManager (ContextCross.Managers)
- Declaration: `public class AircraftApproachSequencingManager : IDisposable, IFixedTickable`
- Fields: AircraftApproachSpacing (static) : Dictionary<WakeTurbulenceCategory, float>; AircraftFlyApproachSpacing (static) : Dictionary<WakeTurbulenceCategory, float>; _disposable : DisposableBag; _onLoadedSubscriber : ISubscriber<AfterLoaded<Aircraft>>; _atisSubscriber : ISubscriber<ATISEvent>; _aircraftUnloadedSubscriber : ISubscriber<BeforeUnloading<Aircraft>>; _aircraftApproachingSequencePublisher : IPublisher<AircraftApproachSequence>; _airwayRouteService : AirwayRouteService; aircraftList : List<Aircraft>; instId : List<string>; aircraftDisposeableDict : Dictionary<string, List<IDisposable>>; AircraftApproachSequence (backing) : AircraftApproachSequence; _approachQueueUpdateCts : CancellationTokenSource; _tickCount : short; _disposed : bool
- Properties: AircraftApproachSequence : AircraftApproachSequence; AircraftApproachSpacing (static) : Dictionary<WakeTurbulenceCategory, float>; AircraftFlyApproachSpacing (static) : Dictionary<WakeTurbulenceCategory, float>
- Methods: Dispose, FixedTick, Init

### AircraftCheckList (ContextCross.Managers)
- Declaration: `public class AircraftCheckList : IDisposable`
- Fields: weatherManager : WeatherManager
- Properties: (none)
- Methods: Construct, RunLandChecklist, RunTakeoffChecklist

### AircraftManager (ContextCross.Managers)
- Declaration: `public class AircraftManager : IStartable, IDisposable`
- Fields: _registry : IGameStateRegistry; _subscriber : ISubscriber<AfterLoaded<Aircraft>>; _aircraftFlightScheduleStateChangePublisher : IPublisher<AircraftFlightScheduleStateChangeEvent>; _gameTime : GameTime; _levelLifecycle : ILevelLifecycle; _disposable : DisposableBag; _disposeCancellationTokenSource : CancellationTokenSource
- Properties: (none)
- Methods: Dispose, Start

### AircraftOnRunwayStatus (ContextCross.Managers)
- Declaration: `internal struct AircraftOnRunwayStatus`
- Fields: AircraftPk : string; PartsOnRunway : bool[]
- Properties: (none)
- Methods: (none)

### AircraftPhysicalCollisionManager (ContextCross.Managers)
- Declaration: `public class AircraftPhysicalCollisionManager : IStartable, IDisposable`
- Fields: subscriber : ISubscriber<AircraftPhysicsOverlap>; demoEndPublisher : IPublisher<AircraftCollisionDemoEndRequested>; aircraftSelectPublisher : IPublisher<OnSelect<Aircraft>>; _gameTime : GameTime; disposable : IDisposable; canProcessMessages : bool; activationTick : ulong; consequencesTriggered : bool
- Properties: (none)
- Methods: Dispose, Start

### FlightScheduleManager (ContextCross.Managers)
- Declaration: `public class FlightScheduleManager : IFixedTickable, IDisposable`
- Nested: ScheduledFlightQueue — _getPriority : Func<FlightScheduleEntry, DateTime>; _items : SortedDictionary<DateTime, Queue<FlightScheduleEntry>>; _count : int; Count : int; methods: Dequeue, Enqueue, Peek, Rebuild
- Fields: LiveryPrewarmLeadTime (static) : TimeSpan; ArrivalToDepartureLeadTime (static) : TimeSpan; UndockingLeadTime (static) : TimeSpan; ArrivalSpawnLeadTime (static) : TimeSpan; MinimumStandOccupancyDuration (static) : TimeSpan; PermanentStandOccupiedFrom (static) : DateTime; PermanentStandOccupiedUntil (static) : DateTime; LatestOccupiedFromAllowingMinimumDuration (static) : DateTime; _registry : IGameStateRegistry; _taxiTimeEstimator : TaxiTimeEstimator; _aircraftFlightScheduleStateChangeSubscriber : ISubscriber<AircraftFlightScheduleStateChangeEvent>; _disposable : IDisposable; _departureScheduleQueue : ScheduledFlightQueue; _arrivalScheduleQueue : ScheduledFlightQueue; _arrivalToDepartureQueue : ScheduledFlightQueue; _departureWarmupQueue : ScheduledFlightQueue; _arrivalWarmupQueue : ScheduledFlightQueue; _runtimeAircraftSpawnService : RuntimeAircraftSpawnService; _liveryService : LiveryService; _gameTime : GameTime; _levelLifecycle : ILevelLifecycle; _afterLoadedFlightPlanSubscriber : ISubscriber<AfterLoaded<FlightPlan>>; _apronService : ApronService; _callsignService : CallsignService; _flightPlans : Dictionary<string, FlightPlan>; FlightPlans (backing) : ReactiveProperty<FlightScheduleEntry[]>
- Properties: FlightPlans : ReactiveProperty<FlightScheduleEntry[]>
- Methods: Dispose, FixedTick, RebuildScheduleQueues, RemoveFlightPlan

### IActiveRunwayIncursionQuery (ContextCross.Managers)
- Declaration: `public interface IActiveRunwayIncursionQuery`
- Methods: IsCallsignInActiveIncursion

### RunwayAircraftManager (ContextCross.Managers)
- Declaration: `public class RunwayAircraftManager : IStartable, IDisposable`
- Fields: _runwayAfterLoadedSubscriber : ISubscriber<AfterLoaded<Runway>>; _disposable : IDisposable; _runwayAircrafts : Dictionary<string, List<AircraftOnRunwayStatus>>
- Properties: (none)
- Methods: Dispose, IsAircraftOnRunway, Start, UpdateAircraftPartOnRunway

### RunwayManager (ContextCross.Managers)
- Declaration: `public class RunwayManager : IStartable, IDisposable`
- Fields: _runways : Dictionary<string, Runway>; _weatherManager : WeatherManager; _registry : IGameStateRegistry; _disposable : IDisposable
- Properties: Runways : Runway[]
- Methods: Dispose, GetRunwayAndEntryByPosition, GetRunwayByPrimaryKey, Register, SetRunwayStatus, Start

---
### AircraftAnimator (ContextCross.Models)
- Declaration: `public class AircraftAnimator : IRuntimeEntity, IResolveByPK, IEntity`
- Fields: _pk : string; Aircraft (backing) : Aircraft; Version : int; HasSnapshot : bool; FlapRatio : float; SlatRatio : float; GearRatio : float; IsGearMoving : bool; GearTargetRatio : float; GoAroundPhase : EAircraftGoAroundAnimPhase; HasGoAroundCommandTick : bool; GoAroundCommandTick : ulong; GearRetractIssued : bool; TakeoffPitchActive : bool; TakeoffPitchElapsed : float; TakeoffPitchDeg : float
- Properties: Aircraft : Aircraft; PK : string
- Methods: BuildPk (static), Configure, ConstructPk, Init

### AircraftSizeLimit (ContextCross.Models)
- Declaration: `public sealed class AircraftSizeLimit`
- Fields: Identifier (backing) : string; MinSize (backing) : AerodromeCode; MaxSize (backing) : AerodromeCode
- Properties: Identifier : string; MaxSize : AerodromeCode; MinSize : AerodromeCode
- Methods: Contains, Intersect, TryIntersect

### AirportBrief (ContextCross.Models)
- Declaration: `public sealed class AirportBrief`
- Fields: SchemaVersion : int; Icao : string; Runways : PhysicalRunwayBrief[]
- Properties: (none)
- Methods: (none)

### AirportInfrastructureSizeLimits (ContextCross.Models)
- Declaration: `public sealed class AirportInfrastructureSizeLimits`
- Fields: StandLimits (backing) : IReadOnlyDictionary<string, AircraftSizeLimit>; EndlessSpawnStandIdentifiers (backing) : IReadOnlyDictionary<string, bool>; RunwayLimits (backing) : IReadOnlyDictionary<RunwaySizeLimitKey, AircraftSizeLimit>
- Properties: EndlessSpawnStandIdentifiers : IReadOnlyDictionary<string, bool>; RunwayLimits : IReadOnlyDictionary<RunwaySizeLimitKey, AircraftSizeLimit>; StandLimits : IReadOnlyDictionary<string, AircraftSizeLimit>
- Methods: (none)

### EAircraftGoAroundAnimPhase (ContextCross.Models)
- Declaration: `public enum EAircraftGoAroundAnimPhase : int`
- Values: None = 0, HoldLandingConfig = 1, CleanConfig = 2

### FlightPlanArrivalLeg (ContextCross.Models)
- Declaration: `public sealed class FlightPlanArrivalLeg`
- Fields: CallSign : string; OriginAirport : string; LandingTime : DateTime; InBlockTime : DateTime; ActualInBlockTime : DateTime; STAR : string; Runway : string; Stand : string
- Properties: HasRequiredFields : bool
- Methods: (none)

### FlightPlanDepartureLeg (ContextCross.Models)
- Declaration: `public sealed class FlightPlanDepartureLeg`
- Fields: CallSign : string; DestinationAirport : string; OffBlockTime : DateTime; TakeoffTime : DateTime; Runway : string; Stand : string
- Properties: HasRequiredFields : bool
- Methods: (none)

### FlightPlanStaticItem (ContextCross.Models)
- Declaration: `public sealed class FlightPlanStaticItem : IDynamicStaticItem, IStaticItem, IResolveByPK`
- Fields: Registration : string; AircraftType : string; AirlineName : string; Voice : string; Language : string; InitialArrival : FlightPlanArrivalLeg; InitialDeparture : FlightPlanDepartureLeg
- Properties: HasArrivalLeg : bool; HasDepartureLeg : bool; PK : string
- Methods: BuildPk (static), GetAllCallSigns

### FlightScheduleEntry (ContextCross.Models)
- Declaration: `public sealed class FlightScheduleEntry`
- Fields: FlightPlan (backing) : FlightPlan; Direction (backing) : EFlightDirection
- Properties: AircraftType : string; AirlineName : string; CallSign : string; ComputedStartTime : DateTime; Direction : EFlightDirection; EndTime : DateTime; FlightPlan : FlightPlan; FlightPlanPk : string; LatestSpawnTime : DateTime; Registration : string; Runway : string; Stand : string; StartTime : DateTime
- Methods: (none)

### FlightScheduleTableEntry (ContextCross.Models)
- Declaration: `public sealed class FlightScheduleTableEntry`
- Fields: CallSign (backing) : string; Stand (backing) : string; Runway (backing) : string; FirstScheduleTime (backing) : string; SecondScheduleTime (backing) : string; _cellBackgroundColors : Color[]
- Properties: CallSign : string; CellBackgroundColors : ReadOnlySpan<Color>; FirstScheduleTime : string; Runway : string; SecondScheduleTime : string; Stand : string
- Methods: GetCellTexts

### PhysicalRunwayBrief (ContextCross.Models)
- Declaration: `public sealed class PhysicalRunwayBrief`
- Fields: PhysicalName : string; Directions : RunwayDirectionBrief[]
- Properties: (none)
- Methods: (none)

### RunwayDirectionBrief (ContextCross.Models)
- Declaration: `public sealed class RunwayDirectionBrief`
- Fields: Name : string; UseMode : RunwayUseMode
- Properties: AllowsLanding : bool; AllowsTakeoff : bool
- Methods: (none)

### RunwayDirectionConfig (ContextCross.Models)
- Declaration: `public struct RunwayDirectionConfig`
- Fields: PhysicalName : string; DirectionName : string; UseMode : RunwayUseMode
- Properties: (none)
- Methods: (none)

### RunwaySizeLimitKey (ContextCross.Models)
- Declaration: `public struct RunwaySizeLimitKey : IEquatable<RunwaySizeLimitKey>`
- Fields: Identifier (backing) : string; Operation (backing) : RunwaySizeLimitOperation
- Properties: Identifier : string; Operation : RunwaySizeLimitOperation
- Methods: Equals, GetHashCode, ToString

### RunwaySizeLimitOperation (ContextCross.Models)
- Declaration: `public enum RunwaySizeLimitOperation : int`
- Values: Takeoff = 0, Landing = 1

### RunwayUseMode (ContextCross.Models)
- Declaration: `public enum RunwayUseMode : int`
- Values: Closed = 0, TakeoffOnly = 1, LandingOnly = 2, TakeoffAndLanding = 3

### TaxiwayNode (ContextCross.Models)
- Declaration: `public class TaxiwayNode : IPkStaticEntity, IStaticEntity, IEntity, IResolveByPK`
- Nested enums: EFlags (ShowLabel=1, Apron=2, Taxiway=4, PushbackLimitPosition=8, EntryHoldingPosition=16, ExitHoldingPosition=32); ENodeType (Apron=0, Taxiway=1, PushbackLimitPosition=2, EntryHoldingPosition=3, ExitHoldingPosition=4)
- Fields: ReactivePosition (backing) : ReactiveProperty<Vector3>; PK (backing) : string; OsmId (backing) : long; Name (backing) : string; Type (backing) : ENodeType; Flags : int; Aeroway (backing) : string; Ref (backing) : string; RunwayLabel (backing) : string
- Properties: Aeroway : string; Name : string; OsmId : long; PK : string; Position : Vector3; ReactivePosition : ReactiveProperty<Vector3>; Ref : string; RunwayLabel : string; Type : ENodeType
- Methods: Init

### TaxiwaySegment (ContextCross.Models)
- Declaration: `public class TaxiwaySegment : IPkStaticEntity, IStaticEntity, IEntity, IResolveByPK`
- Nested enum: EFlags (StandInternalTaxiway=1, Taxiway=2, Runway=4, FreeWaypointSnappableTaxiway=8)
- Fields: PK (backing) : string; Name (backing) : string; OsmId (backing) : long; Nodes (backing) : ReactiveProperty<List<TaxiwayNode>>; Flags (backing) : int; Directed (backing) : bool; Head (backing) : TaxiwayNode; IsHidden (backing) : bool; IsUnselectable (backing) : bool
- Properties: Directed : bool; Flags : int; Head : TaxiwayNode; IsHidden : bool; IsRunway : bool; IsStandInternalTaxiway : bool; IsTaxiway : bool; IsUnselectable : bool; Name : string; Nodes : ReactiveProperty<List<TaxiwayNode>>; OsmId : long; PK : string
- Methods: BuildPk (static), Init, TryParsePk (static)

---
### AircraftHD (ContextCross.HD)
- Declaration: `public class AircraftHD : ManagedBehaviour, IDisposalNode, IDisposable`
- Fields: CurrentAircraftHD (static) : AircraftHD; LocalAudioManager : AircraftLocalAudioManager; CLS_Controller : CLS_Controller; Animator : Animator; AttitudeRoot : GameObject; State : EAircraftState; DynamicsState : State; OnGroundAttitudeRootAngle : float; _FrontWheelRotationRoot : Transform; _FrontWheelRotationAxis : RotateAxis; _SteeringWheelForward : Transform; wheels : List<WheelSpinConfig>; LiverySlots : List<LiverySlotConfig>; skinnedMeshRendererForBound : SkinnedMeshRenderer; Source (backing) : Aircraft; _disposal : DisposalController; _liveryLease : LiveryLease; _isDestroying : bool; _cameraController : AircraftCameraController; engineHeatVFXController : EngineHeatVFXController; engineN1TurnController : EngineN1TurnController; aircraftExternalLightingController : AircraftExternalLightingController; _rigidbody : Rigidbody; _aircraftFocusAdapter : NativeAircraftFocusAdapter; _physicsOverlapPublisher : IPublisher<AircraftPhysicsOverlap>; _aircraftBtnSelectSubscriber : ISubscriber<OnSelect<Aircraft>>; _playerEventPublisher : IAsyncPublisher<IPlayerEvent>; _weatherManager : WeatherManager; _settingsManager : SettingsManager; _inputManager : InputManager; _sessionContextProvider : GameSessionContextProvider; Corners : Vector3[]; internalCurrentTaxiAcceleration : float; internalTargetTaxiSpeed : float; internalTaxiSpeed : float; inspectorDynamicsMode : DynamicsModeType; inspectorIsFlying : bool; _pathRendererPrefab : PathRenderer; _pathRenderer : PathRenderer; _wheelRuntimeData : List<WheelRuntimeData>; _aircraftAnimator : AircraftAnimatorController; _goAroundAnimOrchestrator : AircraftGoAroundAnimOrchestrator; _tugController : AircraftTugController
- Properties: DisposalNode : DisposalNode; FollowCamera : CinemachineCamera; GearCurrent : ReadOnlyReactiveProperty<float>; GoAroundGearRetractPreparationActive : bool; Source : Aircraft
- Methods: Dispose, GetEffectiveLiverySlots (internal), Init, SetLivery, SetLiveryLease, UpdateMeshCornerPoints

### AircraftAnimatorController (ContextCross.HD)
- Declaration: `public class AircraftAnimatorController : IDisposable`
- Nested: ArrivalApproachConfiguration (internal struct) — FlapRatio : float, SlatRatio : float, StartGearDown : bool, ForceGearDown : bool
- Fields: FlapRatio (static int animator param); SlatRatio (static int); GearRatio (static int); ThrustRatio (static int); SpoilerRatio (static int); HeightFlareInitiation : HeightData; HeightPitchControl : HeightData; HeightCrabApproachActive : HeightData; HeightTouchdownDetection : HeightData; HeightGearRetract : HeightData; HeightLiftoffDetection : HeightData; HeightInFlightMinimum : HeightData; HeightHighAltitudeBank : HeightData; HeightTakeoffPitchFollowEnd : HeightData; _source : Aircraft; _transform : Transform; _attitudeRoot : GameObject; _attitudeRootPose : AttitudeRootPose; _clsController : CLS_Controller; _animator : Animator; _audioManager : AircraftLocalAudioManager; _gameTime : GameTime; _onGroundAttitudeRootAngle : float; _lastHeight : float; _lastAirSpeed : float; _lastHeading : float; _targetBank : float; _alignmentInducedBank : float; _targetPitch : float; _bankOscillationPhaseOffset : float; _crabApproachController : AircraftCrabApproachController; _getWindData : Func<WindData>; _isRotating : bool; _rotateInitRotZ : float; _rotateTargetAngle : float; _rotateCurrent : float; _takeoffPitchActive : bool; _takeoffPitchElapsed : float; _takeoffPitchDeg : float; _lastTakeoffPitchDeg : float; _isGearMoving : bool; _disposal : DisposalController; _gearCurrent : ReactiveProperty<float>; _gearTarget : float; _gearVelocity : float; _departureFlapAndAudioPlayed : bool; _arrivalCleanConfigStarted : bool; _arrivalWasInRunwayFence : bool; _arrivalRunwayFenceVacatedTimerStarted : bool; _arrivalRunwayFenceVacatedTimerSeconds : float; _arrivalStoppedTimerStarted : bool; _arrivalStoppedTimerSeconds : float; _pendingArrivalSpeedBasedConfiguration : bool; _runtimeAnimator : AircraftAnimator; _state : EAircraftState; _dynamicsState : State
- Properties: GearCurrent : ReadOnlyReactiveProperty<float>; GearTargetRatio : float; GoAroundGearRetractPreparationActive : bool; IsGearMoving : bool; TakeoffPitchActive : bool; TakeoffPitchDeg : float; TakeoffPitchElapsed : float
- Methods: ApplyAttitudeRootPose, Dispose, EnsureInitialAttitudeRootPose, GetFlapRatio, GetGearRatio, GetSlatRatio, Init, IsArrivalApproachConfigurationState (internal static), ResolveArrivalSpeedBasedLoadConfiguration (internal static), SetFlapFull, SetFlapRatio, SetGearDown, SetGearRatio, SetSlatRatio, ShouldAllowArrivalGearDown (internal static), ShouldFollowTakeoffPitch (static), ShouldProcessArrivalApproach (internal static), StartGearDown, StartGearUp, Step

### AircraftCameraController (ContextCross.HD)
- Declaration: `public class AircraftCameraController : IDisposable`
- Fields: _camDist (static) : float; _theta (static) : float; _phi (static) : float; _followCamera : CinemachineCamera; _followComponent : CinemachineFollow; _lastPtDownTime : float; _lastPtDownPos : Vector2; _source : Aircraft; _aircraftFocusAdapter : NativeAircraftFocusAdapter; _isCurrentAircraftHD : Func<bool>; _settingsManager : SettingsManager; _playerEventPublisher : IAsyncPublisher<IPlayerEvent>; _gameTime : GameTime; cameraSettingsdisposable : IDisposable; _inputManager : InputManager
- Properties: FollowCamera : CinemachineCamera
- Methods: Dispose, Init, ResetStaticCameraParameters (static), SetPriority, Update, UpdateFarClipPlane

### AircraftCrabApproachController (ContextCross.HD)
- Declaration: `public class AircraftCrabApproachController`
- Fields: _attitudeRootPose : AttitudeRootPose; _source : Aircraft; _getWindData : Func<WindData>; _gameTime : GameTime; _targetYaw : float; _currentCrabAngle : float; _lastHeight : float; _currentHeight : float; _isFinalAlignmentInProgress : bool
- Properties: CurrentCrabAngle : float
- Methods: CheckAndStartFinalAlignment, Init (internal), StartFinalAlignment, StepCrabAngle, UpdateHeight

### AircraftExternalLightingAutoSwitch (ContextCross.HD)
- Declaration: `public class AircraftExternalLightingAutoSwitch`
- Fields: aircraft : Aircraft; aircraftHD : AircraftHD
- Properties: (none)
- Methods: UpdateBeaconLights, UpdateLandingLights, UpdateLogoLights, UpdateNavigationLights, UpdateRunwayTurnoffLights, UpdateStrobeLights, UpdateTakeOffLights, UpdateTaxiLights, UpdateWingLights

### AircraftExternalLightingController (ContextCross.HD)
- Declaration: `public class AircraftExternalLightingController : MonoBehaviour`
- Nested: FlashingConfig (struct) — WingStrobeOnDuration : float, WingStrobeOffDuration : float, WingStrobeSecondFlashDelay : float, HasDoubleFlash : bool, TailStrobeOnDuration : float, StrobeCycleDelay : float, BeaconOnDuration : float, BeaconOffDuration : float; LightAnimator (sealed) — root : GameObject, lights : List<AnimatedLightData>, owner : MonoBehaviour, duration : float, animationRoutine : Coroutine, currentBlend : float, targetState : bool, targetStateInitialized : bool, canAnimate : bool; IsAnimating : bool; methods: InstantSet, SetTarget, StopAnimation; LightingMethod (enum) — AIRBUS=0, BOEING_OLD=1, BOEING_NEW=2
- Fields: AirbusConfig (static) : FlashingConfig; BoeingOldConfig (static) : FlashingConfig; BoeingNewConfig (static) : FlashingConfig; aircraftExternalLightingAutoSwitch : AircraftExternalLightingAutoSwitch; lightingMethod : LightingMethod; StrobeLights : GameObject; NavigationLights : GameObject; LogoLights : GameObject; BeaconLights : GameObject; WingLights : GameObject; RunwayTurnoffLights : GameObject; TaxiLights : GameObject; TakeoffLights : GameObject; LandingLights : GameObject; logoLightTransitionDuration : float; steadyLightTransitionDuration : float; enableLandingLightFadeOut : bool; StrobeLightsOn : bool; NavigationLightsOn : bool; LogoLightsOn : bool; BeaconLightsOn : bool; WingLightsOn : bool; RunwayTurnoffLightsOn : bool; TaxiLightsOn : bool; TakeoffLightsOn : bool; LandingLightsOn : bool; WingStrobeLights : GameObject[]; TailStrobeLight : GameObject; TBeaconLights : GameObject[]; UnimportantLights : List<Light>; mainCamera : Camera; logoLightAnimator : LightAnimator; wingLightAnimator : LightAnimator; runwayTurnoffLightAnimator : LightAnimator; taxiLightAnimator : LightAnimator; takeoffLightAnimator : LightAnimator; landingLightAnimator : LightAnimator; cachedState : EAircraftState; cachedGearCurrent : float; cachedHeightFeet : float; cachedTaxiSpeed : float; cachedIsFlying : bool; cachedEngineState : bool; inputStateInitialized : bool; flashingTaskCancellationTokenSource : CancellationTokenSource
- Properties: (none)
- Methods: DistanceToNearestCameraFrustumPlane, FovBasedNormalizedCameraDistance, Init, StopFlashingLightingTask

### AircraftGoAroundAnimOrchestrator (ContextCross.HD)
- Declaration: `public class AircraftGoAroundAnimOrchestrator`
- Fields: HeightGearDownForced (static) : HeightData; HeightGoAroundGearRetract (static) : HeightData; GoAroundGearRetractDelayTicks (static) : ulong; _source : Aircraft; _animatorEntity : AircraftAnimator; _aircraftAnimator : AircraftAnimatorController; _gameTime : GameTime; _lastAircraftState : EAircraftState; _hasLastAircraftState : bool
- Properties: (none)
- Methods: Init, StepPostAnimation, StepPreAnimation

### AircraftLocalAudioManager (ContextCross.HD)
- Declaration: `public class AircraftLocalAudioManager : ManagedBehaviour`
- Fields: publicAnnouncementLanguage : string; AmbientEngine : AudioSource; StartUpEngine : AudioSource; HighEngineLoop : AudioSource; AirEngine : AudioSource; RetardEngine : AudioSource; GearSound : AudioSource; GenralPA : AudioSource; taxiPAClipsEN : List<AudioClip>; takeoffPAClipsEN : List<AudioClip>; taxiPAClipsCN : List<AudioClip>; takeoffPAClipsCN : List<AudioClip>; _paused : bool; _audioState : AircraftLocalAudioState
- Properties: (none)
- Methods: DeFocus, Focus, Gear, Idle, OffGround, RetardOff, RetardOn, SetAmbientTakeoff, SetLandingConfig, SnapIdle, StartUpIdle, Takeoff, TakeoffPAPlay, TaxiPAPlay

### AircraftLocalAudioState (ContextCross.HD)
- Declaration: `public sealed class AircraftLocalAudioState`
- Fields: _rawVolumes : Dictionary<AudioSource, float>; _gameTime : GameTime
- Properties: (none)
- Methods: GetRawVolume, SetRawVolume, TweenRawVolume

### AircraftModelLoader (ContextCross.HD)
- Declaration: `public class AircraftModelLoader : IDisposable`
- Fields: AircraftModelPathDict : Dictionary<string, string>; AircraftModelDict : Dictionary<string, GameObject>
- Properties: (none)
- Methods: Dispose, GetModel, PreloadAllLocalModels, PreloadLocalModel

### AircraftPhysicsColliderReporter (ContextCross.HD)
- Declaration: `public class AircraftPhysicsColliderReporter : MonoBehaviour`
- Fields: aircraft : Aircraft; aircraftHD : AircraftHD; publisher : IPublisher<AircraftPhysicsOverlap>
- Properties: (none)
- Methods: Initialize

### AircraftTugController (ContextCross.HD)
- Declaration: `public class AircraftTugController`
- Fields: _tugSpawned : bool; _firstObservedTick : Nullable<ulong>; _priorStateForTugRelease : Nullable<EAircraftState>; _source : Aircraft; _frontWheelTugDockingRoot : Transform; _gameTime : GameTime
- Properties: (none)
- Methods: Init, OnAircraftStateUpdated, RequiresScheduledPushbackTug (static), Step

### ColliderAircraftRef (ContextCross.HD)
- Declaration: `public class ColliderAircraftRef : MonoBehaviour`
- Fields: AircraftHD : AircraftHD; Aircraft : Aircraft
- Properties: (none)
- Methods: TryResolveAircraft (static)

### TowerAmbientPitchShifting (ContextCross.HD)
- Declaration: `public class TowerAmbientPitchShifting : MonoBehaviour`
- Fields: source : AudioSource; sign : float
- Properties: (none)
- Methods: (none)

### TowerCam (ContextCross.HD)
- Declaration: `public class TowerCam : MonoBehaviour`
- Fields: UseTowerCamera (static) : bool; LockFollowView (static backing) : bool; theta (static) : float; phi (static) : float; instance (static) : TowerCam; vcam : CinemachineCamera; brain : CinemachineBrain; useInstantBlend : bool; LastPtDownTime : float; LastPtDownPos : Vector2; targetAircraftTransform : Transform; transitionActive : bool; transitionElapsed : float; transitionDuration : float; transitionFromTransform : Transform; transitionFromAngles : Vector2; lastDesiredAngles : Vector2; yawVelocity : float; pitchVelocity : float; _aircraftFocusAdapter : NativeAircraftFocusAdapter; _cameraViewPolicy : CameraViewPolicy; _PlayerEventPublisher : IAsyncPublisher<IPlayerEvent>; _OnSelectSubscriber : ISubscriber<OnSelect<Aircraft>>; disposable : IDisposable; _settingsManager : SettingsManager; _inputManager : InputManager; _gameTime : GameTime; _viewportModel : TowerCameraViewportModel
- Properties: LockFollowView (static) : bool
- Methods: Construct, IsPointerBlockedByUi, SwitchToTowerView (static), TrySwitchToFollowView (static), TryToggleCameraView (static)

### TowerCameraViewportModel (ContextCross.HD)
- Declaration: `public sealed class TowerCameraViewportModel : IDisposable`
- Fields: IsTowerView (backing) : ReactiveProperty<bool>; TowerWorldPosition (backing) : ReactiveProperty<Vector3>; YawDegrees (backing) : ReactiveProperty<float>; FieldOfViewDegrees (backing) : ReactiveProperty<float>
- Properties: FieldOfViewDegrees : ReactiveProperty<float>; IsTowerView : ReactiveProperty<bool>; TowerWorldPosition : ReactiveProperty<Vector3>; YawDegrees : ReactiveProperty<float>
- Methods: Dispose

### JetwayHD (ContextCross.HD.AirportInfra) [fields only]
- Declaration: `public class JetwayHD : MonoBehaviour`
- Fields: DockingBase : Transform; JetwayName : string; _dockingTarget : Vector4; jetway : Jetway; YawBase : Transform; PitchBase : Transform; ExtentCorridor1 : Transform; ExtentCorridor2 : Transform; YawGate : Transform; Ladder : Transform; LadderReverse : Transform; WheelBaseHeight : Transform; WheelBaseRotation : Transform; WheelRotationL : Transform; WheelRotationR : Transform; yawBaseHeight : float; pitchBaseOffset : float; extentCorridorMinLength : float; dockingBaseHorizontalOffset : float; dockingBaseVerticalOffset : float; wheelBaseOffset : float; ladderHorizontalOffset : float; ladderVerticalOffset : float; ladderLength : float; wheelDiameter : float; Progress : float; jetwayAnimation : JetwayAnimationObjectScript; pastProgress : float; pastWheelPosition : Vector3; jetwayDisposeable : IDisposable; dockingAircraftStateDisposable : IDisposable; instancedRenderManager : JetwayInstancedRenderManager; stYawBase : float; stPitchBase : float; stExtentCorridor : float; stYawGate : float; tgYawBaseS : float; tgPitchBaseS : float; tgExtentCorridorS : float; tgYawGateS : float; tgYawBaseE : float; tgPitchBaseE : float; tgExtentCorridorE : float; tgYawGateE : float
- Properties: DockingTarget : Vector4

### JetwayHDContainer (ContextCross.HD.AirportInfra) [fields only]
- Declaration: `public class JetwayHDContainer : MonoBehaviour, IStartable`
- Fields: JetwayHDList : List<JetwayHD>; _jetwayManager : JetwayManager
- Properties: (none)

### JetwayInstancedRenderManager (ContextCross.HD.AirportInfra)
- Declaration: `public class JetwayInstancedRenderManager : MonoBehaviour`
- Nested: PartGroup — Mesh : Mesh, Materials : Material[], Layer : int, Transforms : List<Transform>, Matrices : Matrix4x4[], InstanceCount : int, WorldBounds : Bounds
- Fields: shadowCastingMode : ShadowCastingMode; receiveShadows : bool; lightProbeUsage : LightProbeUsage; motionVectorMode : MotionVectorGenerationMode; partGroups : List<PartGroup>; managedRenderers : List<MeshRenderer>; suppressedLodRenderers : List<Renderer>; disabledLodGroups : List<LODGroup>; built : bool; instanceDataDirty : bool
- Properties: (none)
- Methods: MarkInstanceDataDirty

### PushbackHD (ContextCross.HD.AirportInfra) [fields only]
- Declaration: `public class PushbackHD : MonoBehaviour`
- Fields: _gameTime : GameTime; StickHeight : float; StickLenght : float; StickWheelLenght : float; WheelDiameter : float; FStickRootTransform : Transform; FStickTransform : Transform; RStickRootTransform : Transform; RStickTransform : Transform; FLRot : Transform; FRRot : Transform; RLRot : Transform; RRRot : Transform; FLTurn : Transform; FRTurn : Transform; RLTurn : Transform; RRTurn : Transform; splineContainer : SplineContainer; StickTrackTarget : Transform; equivelentWheelBase : float; wheelBase : float; wheelPerimeter : float; frontWheelSteering : float; FLWheelPositionCache : Vector3; FRWheelPositionCache : Vector3; RLWheelPositionCache : Vector3; RRWheelPositionCache : Vector3; InitialPosition : Vector3; InitialDirection : Vector3; meshRenderers : List<Renderer>; showForwardStick : bool; showRearStick : bool; ForwardStickNeturalRotation : Quaternion; RearStickNeturalRotation : Quaternion; FrameStartFPosition : Vector3; FrameStartRPosition : Vector3; shouldRemove : bool; _cancellationToken : CancellationToken
- Properties: (none)

### PushbackHDContainer (ContextCross.HD.AirportInfra) [fields only]
- Declaration: `public class PushbackHDContainer : MonoBehaviour`
- Fields: Instance (static) : PushbackHDContainer; PushBackPrefab : GameObject; PushBackDict : Dictionary<Transform, PushbackHD>; _resolver : IObjectResolver
- Properties: (none)

---
### AircraftRadioIntent (ContextCross.Radio)
- Declaration: `public abstract class AircraftRadioIntent`
- Fields: AircraftPk (backing) : string
- Properties: AircraftPk : string
- Methods: (none)

### RadioEvent (ContextCross.Radio)
- Declaration: `public class RadioEvent : IDeepCloneable<RadioEvent>, IDeepCloneable`
- Fields: _speaker : RadioSpeaker; _aircraftCallSign : string; _captainVoice : string; _language : string; _currentChannelName : string; _currentChannelFrequency : string; _jurisdictionChannelName : string; _jurisdictionChannelFrequency : string
- Properties: AircraftCallSign : string; CaptainVoice : string; CurrentChannelFrequency : string; CurrentChannelName : string; EventKey : string; IsAtc : bool; IsCaptain : bool; JurisdictionChannelFrequency : string; JurisdictionChannelName : string; Language : string; Speaker : RadioSpeaker
- Methods: DeepClone

### AtcRadioEvent (ContextCross.Radio)
- Declaration: `public abstract class AtcRadioEvent : RadioEvent`
- Methods: (none)

### CaptainRadioEvent (ContextCross.Radio)
- Declaration: `public abstract class CaptainRadioEvent : RadioEvent`
- Methods: (none)

### RadioEventCommonParams (ContextCross.Radio)
- Declaration: `public class RadioEventCommonParams`
- Fields: AircraftCallSign (backing) : string; CaptainVoice (backing) : string; Language (backing) : string; CurrentChannelName (backing) : string; CurrentChannelFrequency (backing) : string; JurisdictionChannelName (backing) : string; JurisdictionChannelFrequency (backing) : string
- Properties: AircraftCallSign : string; CaptainVoice : string; CurrentChannelFrequency : string; CurrentChannelName : string; JurisdictionChannelFrequency : string; JurisdictionChannelName : string; Language : string
- Methods: (none)

### RadioChannelBinding (ContextCross.Radio)
- Declaration: `public sealed class RadioChannelBinding`
- Fields: Channel (backing) : RadioChannel; AudioSource (backing) : AudioSource
- Properties: AudioSource : AudioSource; Channel : RadioChannel
- Methods: (none)

### RadioChannelCall (ContextCross.Radio)
- Declaration: `public sealed class RadioChannelCall`
- Fields: _aircraft : Aircraft; _beginAction : Func<Action>; _queued : bool; _started : bool; _closed : bool; _rollbackAction : Action; RadioEvent (backing) : RadioEvent; PlannedConversation (backing) : RadioPlannedConversation; AircraftPk (backing) : string; CompleteAction (backing) : Action
- Properties: AircraftPk : string; CompleteAction : Action; PlannedConversation : RadioPlannedConversation; RadioEvent : RadioEvent
- Methods: CancelCommunication, CompleteCommunication, MarkQueued, RollbackCommunication, StartCommunication

### RadioChannelQueue (ContextCross.Radio)
- Declaration: `public sealed class RadioChannelQueue`
- Fields: _pending : Queue<RadioChannelCall>; _current : RadioChannelCall
- Properties: CanStartNext : bool; IsIdle : bool
- Methods: CancelPending, CompleteCurrent, Enqueue, GetPendingDuration, StartNext

### RadioCallScheduler (ContextCross.Radio)
- Declaration: `public class RadioCallScheduler : IStartable, IDisposable`
- Fields: _radioSystem : RadioSystem; _disposable : IDisposable; _radioEventPublisher : IPublisher<RadioEvent>; _gameTime : GameTime; _registry : IGameStateRegistry; _lifetimeCancellationTokenSource : CancellationTokenSource; _activeConversationCancellationTokenSources : HashSet<CancellationTokenSource>; _disposed : bool
- Properties: (none)
- Methods: Dispose, Enqueue, Start

### RadioEventRegistry (ContextCross.Radio)
- Declaration: `public static class RadioEventRegistry`
- Fields: TypeByKey (static) : IReadOnlyDictionary<string, Type>
- Properties: Keys (static) : IReadOnlyCollection<string>
- Methods: GetUnknownKeyMessage (static), IsRegistered (static), TryResolveType (static)

### AtcClearedForTakeoffAcceptedIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedForTakeoffAcceptedIntent : AircraftRadioIntent`
- Fields: ClearedForTakeoffEvent (backing) : ClearedForTakeoff
- Properties: ClearedForTakeoffEvent : ClearedForTakeoff
- Methods: (none)

### AtcClearedForTakeoffRejectedIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedForTakeoffRejectedIntent : AircraftRadioIntent`
- Methods: (none)

### AtcClearedToLandAcceptedIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedToLandAcceptedIntent : AircraftRadioIntent`
- Methods: (none)

### AtcClearedToLandRejectedIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedToLandRejectedIntent : AircraftRadioIntent`
- Methods: (none)

### AtcClearedToTaxiIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedToTaxiIntent : AircraftRadioIntent`
- Fields: TaxiRoute (backing) : string[]; SelectedRunwayEntryName (backing) : string
- Properties: SelectedRunwayEntryName : string; TaxiRoute : string[]
- Methods: (none)

### AtcChangeRunwayIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcChangeRunwayIntent : AircraftRadioIntent`
- Fields: ApplyRunwayChangeOnComplete (backing) : bool
- Properties: ApplyRunwayChangeOnComplete : bool
- Methods: (none)

### AtcContactDepartureIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcContactDepartureIntent : AircraftRadioIntent`
- Methods: (none)

### AtcContactGroundWhenApproachIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcContactGroundWhenApproachIntent : AircraftRadioIntent`
- Methods: (none)

### AtcContactGroundWhenDepartureExitRunwayIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcContactGroundWhenDepartureExitRunwayIntent : AircraftRadioIntent`
- Methods: (none)

### AtcContactTowerIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcContactTowerIntent : AircraftRadioIntent`
- Methods: (none)

### AtcContinueApproachIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcContinueApproachIntent : AircraftRadioIntent`
- Methods: (none)

### AtcContinueTaxiIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcContinueTaxiIntent : AircraftRadioIntent`
- Methods: (none)

### AtcForbidCrossRunwayIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcForbidCrossRunwayIntent : AircraftRadioIntent`
- Fields: PhysicalRunwayName (backing) : string
- Properties: PhysicalRunwayName : string
- Methods: (none)

### AtcGoAroundIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcGoAroundIntent : AircraftRadioIntent`
- Fields: GoAroundEvent (backing) : GoAround
- Properties: GoAroundEvent : GoAround
- Methods: (none)

### AtcHoldPositionIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcHoldPositionIntent : AircraftRadioIntent`
- Methods: (none)

### AtcHoldShortOfRunwayIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcHoldShortOfRunwayIntent : AircraftRadioIntent`
- Methods: (none)

### AtcLineUpAndWaitIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcLineUpAndWaitIntent : AircraftRadioIntent`
- Fields: LineUpAndWaitEvent (backing) : LineUpAndWait
- Properties: LineUpAndWaitEvent : LineUpAndWait
- Methods: (none)

### AtcPermitCrossRunwayIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcPermitCrossRunwayIntent : AircraftRadioIntent`
- Fields: PhysicalRunwayName (backing) : string
- Properties: PhysicalRunwayName : string
- Methods: (none)

### AtcPermitTowIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcPermitTowIntent : AircraftRadioIntent`
- Fields: TowPath (backing) : Path
- Properties: TowPath : Path
- Methods: (none)

### AtcPushbackApprovedIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcPushbackApprovedIntent : AircraftRadioIntent`
- Fields: PushbackHeading (backing) : PushbackHeading
- Properties: PushbackHeading : PushbackHeading
- Methods: (none)

### AtcRunwayRolloutIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcRunwayRolloutIntent : AircraftRadioIntent`
- Methods: (none)

### AtcStandByPushbackIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcStandByPushbackIntent : AircraftRadioIntent`
- Methods: (none)

### AtcStandByTaxiIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcStandByTaxiIntent : AircraftRadioIntent`
- Methods: (none)

### AtcStopTowIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcStopTowIntent : AircraftRadioIntent`
- Methods: (none)

### AtcTaxiRouteDepartureIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcTaxiRouteDepartureIntent : AircraftRadioIntent`
- Fields: TaxiRoute (backing) : string[]; SelectedRunwayEntryName (backing) : string
- Properties: SelectedRunwayEntryName : string; TaxiRoute : string[]
- Methods: (none)

### AtcTaxiRouteWhenApproachIntent (ContextCross.Radio)
- Declaration: `public sealed class AtcTaxiRouteWhenApproachIntent : AircraftRadioIntent`
- Fields: Path (backing) : Path; PathEndWithStand (backing) : bool; StartTaxiOnComplete (backing) : bool
- Properties: Path : Path; PathEndWithStand : bool; StartTaxiOnComplete : bool
- Methods: (none)

### CaptainGoingAroundIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainGoingAroundIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainRequestPushbackIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestPushbackIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainRequestTaxiWhenApproachIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestTaxiWhenApproachIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainRequestTaxiWhenDepartureIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestTaxiWhenDepartureIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainRequestTaxiWhenDepartureExitRunwayIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestTaxiWhenDepartureExitRunwayIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainRequestToLandIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestToLandIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainRunwayVacatedIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainRunwayVacatedIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainSwitchToTowerFrequencyIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainSwitchToTowerFrequencyIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainTowCompleteIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainTowCompleteIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainUnableToEnterStandIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainUnableToEnterStandIntent : AircraftRadioIntent`
- Methods: (none)

### CaptainWaitingForCrossRunwayIntent (ContextCross.Radio)
- Declaration: `public sealed class CaptainWaitingForCrossRunwayIntent : AircraftRadioIntent`
- Fields: PhysicalRunwayName (backing) : string
- Properties: PhysicalRunwayName : string
- Methods: (none)

### AtcClearedToTaxi (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedToTaxi : AtcRadioEvent`
- Fields: Runway (backing) : string; TaxiRoute (backing) : string[]; HoldingPoint (backing) : string
- Properties: HoldingPoint : string; Runway : string; TaxiRoute : string[]
- Methods: DeepClone

### AtcChangeRunway (ContextCross.Radio)
- Declaration: `public sealed class AtcChangeRunway : AtcRadioEvent`
- Fields: Runway (backing) : string
- Properties: Runway : string
- Methods: (none)

### AtcContactDeparture (ContextCross.Radio)
- Declaration: `public sealed class AtcContactDeparture : AtcRadioEvent`
- Methods: (none)

### AtcContactGroundWhenApproach (ContextCross.Radio)
- Declaration: `public sealed class AtcContactGroundWhenApproach : AtcRadioEvent`
- Methods: (none)

### AtcContactGroundWhenDepartureExitRunway (ContextCross.Radio)
- Declaration: `public sealed class AtcContactGroundWhenDepartureExitRunway : AtcRadioEvent`
- Methods: (none)

### AtcContactTower (ContextCross.Radio)
- Declaration: `public sealed class AtcContactTower : AtcRadioEvent`
- Methods: (none)

### AtcContinueApproach (ContextCross.Radio)
- Declaration: `public sealed class AtcContinueApproach : AtcRadioEvent`
- Fields: Runway (backing) : string
- Properties: Runway : string
- Methods: (none)

### AtcContinueTaxi (ContextCross.Radio)
- Declaration: `public sealed class AtcContinueTaxi : AtcRadioEvent`
- Methods: (none)

### AtcForbidCrossRunway (ContextCross.Radio)
- Declaration: `public sealed class AtcForbidCrossRunway : AtcRadioEvent`
- Fields: PhysicalRunway (backing) : string; Runway (backing) : string
- Properties: PhysicalRunway : string; Runway : string
- Methods: (none)

### AtcGoAround (ContextCross.Radio)
- Declaration: `public sealed class AtcGoAround : AtcRadioEvent`
- Methods: (none)

### AtcHoldPosition (ContextCross.Radio)
- Declaration: `public sealed class AtcHoldPosition : AtcRadioEvent`
- Methods: (none)

### AtcHoldShortOfRunway (ContextCross.Radio)
- Declaration: `public sealed class AtcHoldShortOfRunway : AtcRadioEvent`
- Fields: Runway (backing) : string
- Properties: Runway : string
- Methods: (none)

### AtcLineUpAndWait (ContextCross.Radio)
- Declaration: `public sealed class AtcLineUpAndWait : AtcRadioEvent`
- Fields: Runway (backing) : string
- Properties: Runway : string
- Methods: (none)

### AtcPermitCrossRunway (ContextCross.Radio)
- Declaration: `public sealed class AtcPermitCrossRunway : AtcRadioEvent`
- Fields: PhysicalRunway (backing) : string; Runway (backing) : string
- Properties: PhysicalRunway : string; Runway : string
- Methods: (none)

### AtcPermitTow (ContextCross.Radio)
- Declaration: `public sealed class AtcPermitTow : AtcRadioEvent`
- Fields: TaxiRoute (backing) : string[]; HoldingPoint (backing) : string
- Properties: HoldingPoint : string; TaxiRoute : string[]
- Methods: DeepClone

### AtcPushbackApproved (ContextCross.Radio)
- Declaration: `public sealed class AtcPushbackApproved : AtcRadioEvent`
- Fields: PushbackHeading (backing) : PushbackHeading; Runway (backing) : string
- Properties: PushbackHeading : PushbackHeading; Runway : string
- Methods: (none)

### AtcRunwayRollout (ContextCross.Radio)
- Declaration: `public sealed class AtcRunwayRollout : AtcRadioEvent`
- Fields: TurnDirection (backing) : TurnDirection; ExitPoint (backing) : string
- Properties: ExitPoint : string; TurnDirection : TurnDirection
- Methods: (none)

### AtcStandByPushback (ContextCross.Radio)
- Declaration: `public sealed class AtcStandByPushback : AtcRadioEvent`
- Methods: (none)

### AtcStandByTaxi (ContextCross.Radio)
- Declaration: `public sealed class AtcStandByTaxi : AtcRadioEvent`
- Methods: (none)

### AtcStopTow (ContextCross.Radio)
- Declaration: `public sealed class AtcStopTow : AtcRadioEvent`
- Methods: (none)

### AtcTaxiRouteDeparture (ContextCross.Radio)
- Declaration: `public sealed class AtcTaxiRouteDeparture : AtcRadioEvent`
- Fields: Runway (backing) : string; TaxiRoute (backing) : string[]; HoldingPoint (backing) : string
- Properties: HoldingPoint : string; Runway : string; TaxiRoute : string[]
- Methods: DeepClone

### AtcTaxiRouteWhenApproach (ContextCross.Radio)
- Declaration: `public sealed class AtcTaxiRouteWhenApproach : AtcRadioEvent`
- Fields: Runway (backing) : string; TaxiRoute (backing) : string[]; ApproachStandTail (backing) : string[]; Spot (backing) : string
- Properties: ApproachStandTail : string[]; Runway : string; Spot : string; TaxiRoute : string[]
- Methods: DeepClone

### AtcClearedForTakeoff_Accepted (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedForTakeoff_Accepted : AtcRadioEvent`
- Fields: WindAngle (backing) : string; WindSpeed (backing) : Nullable<int>; Runway (backing) : string
- Properties: Runway : string; WindAngle : string; WindSpeed : Nullable<int>
- Methods: (none)

### AtcClearedForTakeoff_Rejected (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedForTakeoff_Rejected : AtcRadioEvent`
- Fields: WindAngle (backing) : string; WindSpeed (backing) : Nullable<int>; Runway (backing) : string
- Properties: Runway : string; WindAngle : string; WindSpeed : Nullable<int>
- Methods: (none)

### AtcClearedToLand_Accepted (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedToLand_Accepted : AtcRadioEvent`
- Fields: Runway (backing) : string; WindAngle (backing) : string; WindSpeed (backing) : Nullable<int>
- Properties: Runway : string; WindAngle : string; WindSpeed : Nullable<int>
- Methods: (none)

### AtcClearedToLand_Rejected (ContextCross.Radio)
- Declaration: `public sealed class AtcClearedToLand_Rejected : AtcRadioEvent`
- Fields: Runway (backing) : string; WindAngle (backing) : string; WindSpeed (backing) : Nullable<int>
- Properties: Runway : string; WindAngle : string; WindSpeed : Nullable<int>
- Methods: (none)

### CaptainGoingAround (ContextCross.Radio)
- Declaration: `public sealed class CaptainGoingAround : CaptainRadioEvent`
- Methods: (none)

### CaptainRequestPushback (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestPushback : CaptainRadioEvent`
- Fields: Spot (backing) : string; Information (backing) : string
- Properties: Information : string; Spot : string
- Methods: (none)

### CaptainRequestTaxiWhenApproach (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestTaxiWhenApproach : CaptainRadioEvent`
- Fields: HoldingPoint (backing) : string; Spot (backing) : string
- Properties: HoldingPoint : string; Spot : string
- Methods: (none)

### CaptainRequestTaxiWhenDeparture (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestTaxiWhenDeparture : CaptainRadioEvent`
- Methods: (none)

### CaptainRequestTaxiWhenDepartureExitRunway (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestTaxiWhenDepartureExitRunway : CaptainRadioEvent`
- Methods: (none)

### CaptainRequestToLand (ContextCross.Radio)
- Declaration: `public sealed class CaptainRequestToLand : CaptainRadioEvent`
- Fields: Spot (backing) : string
- Properties: Spot : string
- Methods: (none)

### CaptainRunwayVacated (ContextCross.Radio)
- Declaration: `public sealed class CaptainRunwayVacated : CaptainRadioEvent`
- Fields: Runway (backing) : string
- Properties: Runway : string
- Methods: (none)

### CaptainSwitchToTowerFrequency (ContextCross.Radio)
- Declaration: `public sealed class CaptainSwitchToTowerFrequency : CaptainRadioEvent`
- Methods: (none)

### CaptainTowComplete (ContextCross.Radio)
- Declaration: `public sealed class CaptainTowComplete : CaptainRadioEvent`
- Methods: DeepClone

### CaptainUnableToEnterStand (ContextCross.Radio)
- Declaration: `public sealed class CaptainUnableToEnterStand : CaptainRadioEvent`
- Fields: Spot (backing) : string
- Properties: Spot : string
- Methods: (none)

### CaptainWaitingForCrossRunway (ContextCross.Radio)
- Declaration: `public sealed class CaptainWaitingForCrossRunway : CaptainRadioEvent`
- Fields: PhysicalRunway (backing) : string; Runway (backing) : string
- Properties: PhysicalRunway : string; Runway : string
- Methods: (none)

### ContentAttribute (ContextCross.Radio)
- Declaration: `public class ContentAttribute : Attribute`
- Fields: Content (backing) : string
- Properties: Content : string
- Methods: (none)

### ContentCNAttribute (ContextCross.Radio)
- Declaration: `public class ContentCNAttribute : Attribute`
- Fields: Content (backing) : string
- Properties: Content : string
- Methods: (none)

### EnumExtensions (ContextCross.Radio)
- Declaration: `public static class EnumExtensions`
- Methods: GetContent, GetContentCN

### PushbackHeading (ContextCross.Radio)
- Declaration: `public enum PushbackHeading : int`
- Values: None = 0, North = 1, West = 2, East = 3, South = 4

### PushbackHeadingExtensions (ContextCross.Radio)
- Declaration: `public static class PushbackHeadingExtensions`
- Fields: StringToEnumMap (static) : Dictionary<string, PushbackHeading>
- Methods: FromString

### TurnDirection (ContextCross.Radio)
- Declaration: `public enum TurnDirection : int`
- Values: Left = 0, Right = 1

### TurnDirectionExtensions (ContextCross.Radio)
- Declaration: `public static class TurnDirectionExtensions`
- Fields: StringToEnumMap (static) : Dictionary<string, TurnDirection>
- Methods: FromString

### RadioIntentHandler (ContextCross.Radio)
- Declaration: `public sealed class RadioIntentHandler : IStartable, IDisposable`
- Fields: _radioCallScheduler : RadioCallScheduler; _playPlanner : RadioPlayPlanner; _radioIntentSubscriber : ISubscriber<AircraftRadioIntent>; _registry : IGameStateRegistry; _subscription : IDisposable
- Properties: (none)
- Methods: Dispose, Start

### RadioMixRouter (ContextCross.Radio)
- Declaration: `public sealed class RadioMixRouter`
- Fields: _foregroundGroup : AudioMixerGroup; _backgroundGroup : AudioMixerGroup; _speakingOrder : List<string>
- Properties: (none)
- Methods: InitializeChannel, RefreshChannelMixState, SetChannelTalkingState

### RadioPlayEvent (ContextCross.Radio)
- Declaration: `public sealed class RadioPlayEvent`
- Fields: Speaker (backing) : RadioSpeaker; RadioEvent (backing) : RadioEvent; WindSpeedUnit (backing) : WindSpeedUnit
- Properties: RadioEvent : RadioEvent; Speaker : RadioSpeaker; WindSpeedUnit : WindSpeedUnit
- Methods: (none)

### RadioSpeaker (ContextCross.Radio)
- Declaration: `public sealed class RadioSpeaker`
- Fields: Atc (static backing) : RadioSpeaker; Captain (static backing) : RadioSpeaker; Key (backing) : string
- Properties: Atc (static) : RadioSpeaker; Captain (static) : RadioSpeaker; Key : string
- Methods: ToString

### RadioSystem (ContextCross.Radio)
- Declaration: `public class RadioSystem : IInitializable, IDisposable, IFixedTickable`
- Fields: audioSourcePrefab : AudioSource; _mixRouter : RadioMixRouter; _gameTime : GameTime; _sessionContextProvider : GameSessionContextProvider; _radioChannelAfterLoadedSubscriber : ISubscriber<AfterLoaded<RadioChannel>>; _radioPlayEventPublisher : IPublisher<RadioPlayEvent>; _isGamePaused : bool; _radioChannelBindings : Dictionary<string, RadioChannelBinding>; _disposable : IDisposable; _lifetimeCancellationTokenSource : CancellationTokenSource
- Properties: (none)
- Methods: Construct, Dispose, FixedTick, Initialize, PlayAudioAsync, PlayConversation, ToggleMute

### RadioTemplate (ContextCross.Radio)
- Declaration: `public sealed class RadioTemplate : IEnumerable<KeyValuePair<RadioTemplateKey, string[]>>, IEnumerable`
- Fields: _entries : Dictionary<RadioTemplateKey, string[]>
- Properties: Count : int
- Methods: GetEnumerator, Set, TryGetTemplate

### RadioTemplateKey (ContextCross.Radio)
- Declaration: `public struct RadioTemplateKey : IEquatable<RadioTemplateKey>`
- Fields: EventKey (backing) : string; SpeakerKey (backing) : string
- Properties: EventKey : string; SpeakerKey : string
- Methods: Equals, GetHashCode

### RadioTemplateCSVReader (ContextCross.Radio)
- Declaration: `public class RadioTemplateCSVReader`
- Methods: ReadCSVAsync (static), ReadFileAsync (internal static)

### RadioTemplateParser (ContextCross.Radio)
- Declaration: `public static class RadioTemplateParser`
- Fields: OptionalEmptyArrayPlaceholders (static) : HashSet<string>
- Methods: FormatWindSpeedClipToken (static), GetCalmWindClipTokens (static), ParseItem, ParseLine

### RadioTemplateService (ContextCross.Radio)
- Declaration: `public sealed class RadioTemplateService`
- Fields: _templateEn : RadioTemplate; _templateZh : RadioTemplate; _windSpeedUnit : WindSpeedUnit
- Properties: (none)
- Methods: GetClipNames, Load, SetTemplates

### Util (ContextCross.Radio)
- Declaration: `public static class Util`
- Methods: IsChannelFrequencyPlaceholder, NormalizeChannelFrequencyForAudioClipName, NormalizeRadioTemplatePlaceholderValue, RoundToNearest5Degrees

---
### AircraftRegistrationConfigParser (ContextCross.RawDataParser)
- Declaration: `public static class AircraftRegistrationConfigParser`
- Fields: (none)
- Properties: (none)
- Methods: ParseAirlineCountryRegistry, ParseRegistrationRules

### AirportBriefReader (ContextCross.RawDataParser)
- Declaration: `public static class AirportBriefReader`
- Nested DTOs: AirportBriefDto (SchemaVersion : Nullable<int>, Icao : string, Runways : PhysicalRunwayBriefDto[]); PhysicalRunwayBriefDto (PhysicalName : string, Directions : RunwayDirectionBriefDto[]); RunwayDirectionBriefDto (Name : string, UseMode : Nullable<RunwayUseMode>)
- Methods: Read, ReadForAirport

### FlightScheduleParser (ContextCross.RawDataParser)
- Declaration: `public static class FlightScheduleParser`
- Methods: Parse

### AircraftApproachService (ContextCross.Services)
- Declaration: `public sealed class AircraftApproachService`
- Fields: _commandRestrictionPolicy : AircraftCommandRestrictionPolicy; _playerEventPublisher : IAsyncPublisher<IPlayerEvent>; _aircraftEventPublisher : IPublisher<AircraftEvent>; _gameTime : GameTime
- Properties: (none)
- Methods: TryGoAround

### AircraftDepartureRunwayService (ContextCross.Services)
- Declaration: `public sealed class AircraftDepartureRunwayService`
- Fields: _commandRestrictionPolicy : AircraftCommandRestrictionPolicy; _playerEventPublisher : IAsyncPublisher<IPlayerEvent>; _aircraftEventPublisher : IPublisher<AircraftEvent>; _gameTime : GameTime
- Properties: (none)
- Methods: TryClearForTakeoff

### AircraftFocusService (ContextCross.Services)
- Declaration: `public class AircraftFocusService`
- Fields: PublishOnSelectMarker (static) : ProfilerMarker; _allowedCallSigns : HashSet<string>; _publisher : IPublisher<OnSelect<Aircraft>>; _playerEventPublisher : IAsyncPublisher<IPlayerEvent>; _isFocusRestrictionActive : bool
- Properties: (none)
- Methods: ClearFocusRestriction, SetFocusRestriction, TryFocus

### AircraftRadioTransferService (ContextCross.Services)
- Declaration: `public sealed class AircraftRadioTransferService`
- Fields: _commandRestrictionPolicy : AircraftCommandRestrictionPolicy; _playerEventPublisher : IAsyncPublisher<IPlayerEvent>; _aircraftEventPublisher : IPublisher<AircraftEvent>; _gameTime : GameTime
- Properties: (none)
- Methods: TryContactGround

### AircraftRegistrationService (ContextCross.Services)
- Declaration: `public sealed class AircraftRegistrationService`
- Fields: _registrationRulesByCountry : Dictionary<string, string[]>; _countryByAirline : Dictionary<string, string>; _random : Random
- Properties: (none)
- Methods: GenerateRegistration, SetAirlineCountryRegistry, SetRegistrationRules

### AircraftSpecService (ContextCross.Services)
- Declaration: `public class AircraftSpecService`
- Fields: _aircraftProfiles : Dictionary<string, AircraftSpecification>
- Properties: (none)
- Methods: GetAircraftModelBySize, GetAircraftSpecification, GetAircraftSpecificationsBySize

### AirportInfrastructureSizeLimitService (ContextCross.Services)
- Declaration: `public sealed class AirportInfrastructureSizeLimitService : ILevelService`
- Fields: _aircraftSpecService : AircraftSpecService; _sessionContextProvider : GameSessionContextProvider; _limits : AirportInfrastructureSizeLimits; AirportIcao (backing) : string
- Properties: AirportIcao : string; IsLoaded : bool
- Methods: CanSpawnEndlessFlightAtStand, CanUseRunway, CanUseStand, GetAircraftTypesForStandAndRunway, GetCombinedLimit, GetRunwayLimit, GetStandLimit, Initialize, Load

### ApronService (ContextCross.Services)
- Declaration: `public sealed class ApronService : ILevelService, IDisposable, IDebugModel<ApronStandOccupancyDebugData>`
- Fields: EmptyAllocations (static) : List<ApronStandAllocation>; _allocations : List<ApronStandAllocation>; _allocationsByStand : Dictionary<string, List<ApronStandAllocation>>; _allocationsByOwner : Dictionary<string, List<ApronStandAllocation>>; _debugDataSource : ReactiveProperty<ApronStandOccupancyDebugData>; _debugData : ReadOnlyReactiveProperty<ApronStandOccupancyDebugData>; _registry : IGameStateRegistry; _disposed : bool; _loadedStandIdentifiers : HashSet<string>; _loadedStandIdentifiersOrdered : string[]
- Properties: DebugData (explicit IDebugModel) : ReadOnlyReactiveProperty<ApronStandOccupancyDebugData>
- Methods: Allocate, Dispose, GetFreeStands, GetStandOccupiedUntil, Initialize, IsStandAllocated, ReleaseOwner

### ApronStandAllocation (ContextCross.Services)
- Declaration: `public sealed class ApronStandAllocation`
- Fields: StandIdentifier (backing) : string; OwnerId (backing) : string; DebugCellViewLabel (backing) : string; OccupiedFrom (backing) : DateTime; OccupiedUntil (backing) : DateTime
- Properties: DebugCellViewLabel : string; OccupiedFrom : DateTime; OccupiedUntil : DateTime; OwnerId : string; StandIdentifier : string
- Methods: (none)

### ApronStandAllocationDebugSnapshot (ContextCross.Services)
- Declaration: `public struct ApronStandAllocationDebugSnapshot`
- Fields: StandIdentifier (backing) : string; DebugCellViewLabel (backing) : string; Registration (backing) : string; OccupiedFrom (backing) : DateTime; OccupiedUntil (backing) : DateTime
- Properties: DebugCellViewLabel : string; OccupiedFrom : DateTime; OccupiedUntil : DateTime; OwnerLabel : string; Registration : string; StandIdentifier : string
- Methods: (none)

### ApronStandOccupancyDebugData (ContextCross.Services)
- Declaration: `public struct ApronStandOccupancyDebugData`
- Fields: StandIdentifiers (backing) : IReadOnlyList<string>; Allocations (backing) : IReadOnlyList<ApronStandAllocationDebugSnapshot>
- Properties: Allocations : IReadOnlyList<ApronStandAllocationDebugSnapshot>; StandIdentifiers : IReadOnlyList<string>
- Methods: (none)

### EndlessModeFlightPlanProvider (ContextCross.Services)
- Declaration: `public sealed class EndlessModeFlightPlanProvider : IFixedTickable`
- Nested: FlightPlanHDPresentation (struct) — registration : string, aircraftType : string, airlineName : string, voice : string, language : string, callSignDeparture : string, callSignArrival : string, originAirport : string, destinationAirport : string
- Fields: ArrivalPlanningWindow (static) : TimeSpan; _aircraftSpecService : AircraftSpecService; _aircraftRegistrationService : AircraftRegistrationService; _callsignService : CallsignService; _liveryService : LiveryService; _airportInfrastructureSizeLimitService : AirportInfrastructureSizeLimitService; _apronService : ApronService; _airwayRouteService : AirwayRouteService; _runwayManager : RunwayManager; _registry : IGameStateRegistry; _gameTime : GameTime; _levelLifecycle : ILevelLifecycle; _continuousConfig : EndlessModeConfig; _nextArrivalLandingTime : DateTime; _continuousGenerationConfigured : bool; _isGeneratingContinuousFlightPlans : bool
- Properties: NextArrivalLandingTime (internal) : DateTime
- Methods: ConfigureContinuousGeneration, CreateInitialFlightPlans, FixedTick, NeedsMoreArrivals, TryCreateNextContinuousFlightPlan

### RuntimeAircraftSpawnService (ContextCross.Services)
- Declaration: `public class RuntimeAircraftSpawnService`
- Nested: FlyApproachSpawnPose (struct) — Position : Vector3, Direction : Vector3, ProgressRatio : float
- Fields: _registry : IGameStateRegistry; _aTISManager : ATISManager; _airwayRouteService : AirwayRouteService; _aircraftSpecService : AircraftSpecService; _radioChannelManager : RadioChannelManager; _dynamicCurveAsset : DynamicCurveAsset; _aircraftApproachSequencingManager : AircraftApproachSequencingManager; _jetwayManager : JetwayManager
- Properties: (none)
- Methods: SpawnFlyApproachingAircraft, SpawnIdleAircraft

### RunwayTimelineService (ContextCross.Services)
- Declaration: `public class RunwayTimelineService : IDisposable`
- Nested: RunwayChangeGroup — TimeOfDay : TimeSpan, Changes : RunwayChange[], DestinationDisplay : string, Minus5Played : bool, Minus1Played : bool, T0Played : bool
- Fields: _runwayManager : RunwayManager; _atisManager : ATISManager; _messagePublisher : IPublisher<MessageData>; _gameTime : GameTime; _sessionContextProvider : GameSessionContextProvider; _disposable : IDisposable; _initialRunways : HashSet<string>; _groups : List<RunwayChangeGroup>; _demoDirector : DemoDirectorTNA; _nextGroupIndex : int; _hasLastTimeOfDay : bool; _lastTimeOfDay : TimeSpan
- Properties: (none)
- Methods: Construct, Dispose, LoadLevel

---
### RunwayChange (ContextCross.States)
- Declaration: `public class RunwayChange`
- Fields: Source : string; Dest : string
- Properties: (none)
- Methods: (none)

### RunwayChangeFrame (ContextCross.States)
- Declaration: `public class RunwayChangeFrame`
- Fields: Time : string; Changes : RunwayChange[]
- Properties: (none)
- Methods: (none)

### RunwayTimelineData (ContextCross.States)
- Declaration: `public class RunwayTimelineData`
- Fields: InitialRunways : string[]; Timeline : RunwayChangeFrame[]
- Properties: (none)
- Methods: (none)

### AircraftSizeExtensions (ContextCross.States)
- Declaration: `public static class AircraftSizeExtensions`
- Methods: FromCode, FromString, ToCode

### ConversationPatienceUpdated (ContextCross.Summary.Events)
- Declaration: `public sealed class ConversationPatienceUpdated`
- Fields: Target (backing) : string; NormalizedRemaining (backing) : float; IsActive (backing) : bool
- Properties: IsActive : bool; NormalizedRemaining : float; Target : string
- Methods: (none)

### ConversationTimingEvaluated (ContextCross.Summary.Events)
- Declaration: `public sealed class ConversationTimingEvaluated`
- Fields: Target (backing) : string; Rating (backing) : EConversationTimingRating
- Properties: Rating : EConversationTimingRating; Target : string
- Methods: (none)

### DepartureHandoverEvaluated (ContextCross.Summary.Events)
- Declaration: `public sealed class DepartureHandoverEvaluated`
- Fields: Target (backing) : string; WasPlayerInitiated (backing) : bool; ChannelType (backing) : EChannel; Tick (backing) : ulong; Timestamp (backing) : DateTime
- Properties: ChannelType : EChannel; Target : string; Tick : ulong; Timestamp : DateTime; WasPlayerInitiated : bool
- Methods: (none)

### FlightOperationCompleted (ContextCross.Summary.Events)
- Declaration: `public sealed class FlightOperationCompleted`
- Fields: CallSign (backing) : string; Direction (backing) : EFlightDirection; Tick (backing) : ulong; Timestamp (backing) : DateTime
- Properties: CallSign : string; Direction : EFlightDirection; Tick : ulong; Timestamp : DateTime
- Methods: (none)

### FlightOperationStarted (ContextCross.Summary.Events)
- Declaration: `public sealed class FlightOperationStarted`
- Fields: CallSign (backing) : string; Direction (backing) : EFlightDirection; Tick (backing) : ulong; Timestamp (backing) : DateTime
- Properties: CallSign : string; Direction : EFlightDirection; Tick : ulong; Timestamp : DateTime
- Methods: (none)

### GoAroundDetected (ContextCross.Summary.Events)
- Declaration: `public sealed class GoAroundDetected`
- Fields: CallSign (backing) : string; Tick (backing) : ulong; Timestamp (backing) : DateTime
- Properties: CallSign : string; Tick : ulong; Timestamp : DateTime
- Methods: (none)

### RunwayIncursionDetected (ContextCross.Summary.Events)
- Declaration: `public class RunwayIncursionDetected`
- Fields: CallsignA (backing) : string; CallsignB (backing) : string; Runway (backing) : string; Tick (backing) : ulong; DateTime (backing) : DateTime; Scenario (backing) : RunwayIncursionScenario; PrimaryCallsign (backing) : string; SecondaryCallsign (backing) : string
- Properties: CallsignA : string; CallsignB : string; DateTime : DateTime; PrimaryCallsign : string; Runway : string; Scenario : RunwayIncursionScenario; SecondaryCallsign : string; Tick : ulong
- Methods: (none)

### RunwayIncursionScenario (ContextCross.Summary.Events)
- Declaration: `public enum RunwayIncursionScenario : int`
- Values: TakeoffLanding = 0, TakeoffTakeoff = 1, LandingLanding = 2, TakeoffGround = 3, LandingGround = 4

### SessionEnded (ContextCross.Summary.Events)
- Declaration: `public struct SessionEnded`
- Fields: OccurredAt (backing) : DateTime; Tick (backing) : ulong
- Properties: OccurredAt : DateTime; Tick : ulong
- Methods: (none)

### SummaryEvaluated (ContextCross.Summary.Events)
- Declaration: `public struct SummaryEvaluated`
- Fields: Data (backing) : SummaryModel
- Properties: Data : SummaryModel
- Methods: (none)

### ActualFlightRaw (ContextCross.Summary.Models)
- Declaration: `public struct ActualFlightRaw`
- Fields: DepartureCount (backing) : int; ArrivalCount (backing) : int; TaxiDuration (backing) : Nullable<TimeSpan>; TaxiDistance (backing) : Nullable<float>
- Properties: ArrivalCount : int; DepartureCount : int; TaxiDistance : Nullable<float>; TaxiDuration : Nullable<TimeSpan>; TotalCount : int
- Methods: (none)

### ConversationTimingRaw (ContextCross.Summary.Models)
- Declaration: `public struct ConversationTimingRaw`
- Fields: FastCount (backing) : int; NormalCount (backing) : int; DelayedCount (backing) : int
- Properties: DelayedCount : int; FastCount : int; FastOrNormalCount : int; NormalCount : int; TotalCount : int
- Methods: (none)

### DepartureHandoverRaw (ContextCross.Summary.Models)
- Declaration: `public struct DepartureHandoverRaw`
- Fields: DepartureHandoverNormalCount (backing) : int; DepartureHandoverMissedCount (backing) : int
- Properties: DepartureHandoverMissedCount : int; DepartureHandoverNormalCount : int; TotalCount : int
- Methods: (none)

### GoAroundRaw (ContextCross.Summary.Models)
- Declaration: `public struct GoAroundRaw`
- Fields: Count (backing) : int; UniqueCount (backing) : int
- Properties: Count : int; UniqueCount : int
- Methods: (none)

### OnTimeFlightRaw (ContextCross.Summary.Models)
- Declaration: `public struct OnTimeFlightRaw`
- Fields: Count (backing) : int
- Properties: Count : int
- Methods: (none)

### PlannedFlightRaw (ContextCross.Summary.Models)
- Declaration: `public struct PlannedFlightRaw`
- Fields: DepartureCount (backing) : int; ArrivalCount (backing) : int
- Properties: ArrivalCount : int; DepartureCount : int; TotalCount : int
- Methods: (none)

### RunwayIncursionRaw (ContextCross.Summary.Models)
- Declaration: `public struct RunwayIncursionRaw`
- Fields: Count (backing) : int
- Properties: Count : int
- Methods: (none)

### SummaryContext (ContextCross.Summary.Models)
- Declaration: `public struct SummaryContext`
- Fields: Tick (backing) : ulong; Timestamp (backing) : DateTime
- Properties: Tick : ulong; Timestamp : DateTime
- Methods: (none)

### SummaryGrade (ContextCross.Summary.Models)
- Declaration: `public struct SummaryGrade`
- Fields: ActualTotalGrade (backing) : ESessionGrade; ActualDepartureGrade (backing) : ESessionGrade; ActualArrivalGrade (backing) : ESessionGrade; OnTimeGrade (backing) : ESessionGrade; GoAroundGrade (backing) : ESessionGrade; DepartureHandoverGrade (backing) : ESessionGrade; ConversationGrade (backing) : ESessionGrade; BaseGrade (backing) : ESessionGrade; FinalGrade (backing) : ESessionGrade; AppliedDowngrade (backing) : int
- Properties: ActualArrivalGrade : ESessionGrade; ActualDepartureGrade : ESessionGrade; ActualTotalGrade : ESessionGrade; AppliedDowngrade : int; BaseGrade : ESessionGrade; ConversationGrade : ESessionGrade; DepartureHandoverGrade : ESessionGrade; FinalGrade : ESessionGrade; GoAroundGrade : ESessionGrade; OnTimeGrade : ESessionGrade
- Methods: (none)

### SummaryModel (ContextCross.Summary.Models)
- Declaration: `public sealed class SummaryModel`
- Fields: RawData (backing) : SummaryRawData; Score (backing) : SummaryScore; Grade (backing) : SummaryGrade
- Properties: Grade : SummaryGrade; RawData : SummaryRawData; Score : SummaryScore
- Methods: (none)

### SummaryRawData (ContextCross.Summary.Models)
- Declaration: `public struct SummaryRawData`
- Fields: Context (backing) : SummaryContext; ConversationTiming (backing) : ConversationTimingRaw; RunwayIncursion (backing) : RunwayIncursionRaw; DepartureHandover (backing) : DepartureHandoverRaw; PlannedFlight (backing) : PlannedFlightRaw; ActualFlight (backing) : ActualFlightRaw; OnTimeFlight (backing) : OnTimeFlightRaw; GoAround (backing) : GoAroundRaw
- Properties: ActualFlight : ActualFlightRaw; Context : SummaryContext; ConversationTiming : ConversationTimingRaw; DepartureHandover : DepartureHandoverRaw; GoAround : GoAroundRaw; OnTimeFlight : OnTimeFlightRaw; PlannedFlight : PlannedFlightRaw; RunwayIncursion : RunwayIncursionRaw
- Methods: (none)

### SummaryScore (ContextCross.Summary.Models)
- Declaration: `public struct SummaryScore`
- Fields: ActualTotalScore (backing) : double; ActualDepartureScore (backing) : double; ActualArrivalScore (backing) : double; OnTimeAverageScore (backing) : double; GoAroundAverageScore (backing) : double; DepartureHandoverAverageScore (backing) : double; ConversationAverageScore (backing) : double; TotalAverageScore (backing) : double
- Properties: ActualArrivalScore : double; ActualDepartureScore : double; ActualTotalScore : double; ConversationAverageScore : double; DepartureHandoverAverageScore : double; GoAroundAverageScore : double; OnTimeAverageScore : double; TotalAverageScore : double
- Methods: (none)

### ConversationTimer (ContextCross.Summary.Monitors)
- Declaration: `public sealed class ConversationTimer : IDisposable`
- Fields: _talkingSubscription : IDisposable; _elapsedSeconds : double; _isRunning : bool; _isTracking : bool; _isPaused : bool; _channelTalking : bool; _channelOccupied : bool; _aircraftCommunicating : bool; _isRouteSelecting : bool
- Properties: IsPaused : bool; IsRunning : bool; IsTracking : bool
- Methods: Advance, Cancel, Complete, Dispose, GetElapsedSeconds, SetAircraftCommunicating, SetChannelOccupied, SetRouteSelecting, Start

### ConversationTimingMonitor (ContextCross.Summary.Monitors)
- Declaration: `public class ConversationTimingMonitor : IStartable, IFixedTickable, IDisposable`
- Nested: TrackedAircraftState — Aircraft : Aircraft, Timer : ConversationTimer, LastChannelType : Nullable<EChannel>, LastChannelPk : string, ActiveChannel : RadioChannel, _lastNormalized : Nullable<float>, _lastActive : Nullable<bool>, _radioCommunicatingSubscription : IDisposable; methods: ClearActiveChannel, Dispose, ResetPatiencePublication, SetActiveChannel, SetLastPublished, ShouldPublish
- Fields: PlayerControllableChannels (static) : HashSet<EChannel>; _aircraftLoadedSubscriber : ISubscriber<AfterLoaded<Aircraft>>; _aircraftUnloadedSubscriber : ISubscriber<BeforeUnloading<Aircraft>>; _aircraftEventSubscriber : ISubscriber<AircraftEvent>; _radioEventSubscriber : ISubscriber<RadioEvent>; _routeSelectionSubscriber : ISubscriber<TaxiRouteSelectionStateChanged>; _patiencePublisher : IPublisher<ConversationPatienceUpdated>; _evaluationPublisher : IPublisher<ConversationTimingEvaluated>; _aircraftStates : Dictionary<string, TrackedAircraftState>; _aircraftSubscriptions : Dictionary<string, IDisposable>; _settingsManager : SettingsManager; _gameTime : GameTime; _sessionContextProvider : GameSessionContextProvider; _disposable : DisposableBag
- Properties: (none)
- Methods: Dispose, FixedTick, Start

### DepartureHandoverMonitor (ContextCross.Summary.Monitors)
- Declaration: `public sealed class DepartureHandoverMonitor : IStartable, IDisposable`
- Nested: TrackedDeparture — Aircraft : Aircraft, PlayerInitiated : bool, Subscriptions : DisposableBag
- Fields: _aircraftLoadedSubscriber : ISubscriber<AfterLoaded<Aircraft>>; _aircraftEventSubscriber : ISubscriber<AircraftEvent>; _departureHandoverEvaluatedPublisher : IPublisher<DepartureHandoverEvaluated>; _radioChannelManager : RadioChannelManager; _gameTime : GameTime; _tracked : Dictionary<string, TrackedDeparture>; _disposable : DisposableBag
- Properties: (none)
- Methods: Dispose, Start

### FlightStateMonitor (ContextCross.Summary.Monitors)
- Declaration: `public sealed class FlightStateMonitor : IStartable, IDisposable`
- Fields: _aircraftLoadedSubscriber : ISubscriber<AfterLoaded<Aircraft>>; _flightOperationCompletedPublisher : IPublisher<FlightOperationCompleted>; _flightOperationStartedPublisher : IPublisher<FlightOperationStarted>; _goAroundPublisher : IPublisher<GoAroundDetected>; _gameTime : GameTime; _subscriptionsByAircraft : Dictionary<string, IDisposable>; _disposable : DisposableBag
- Properties: (none)
- Methods: Dispose, Start

### RunwayIncursionDetector (ContextCross.Summary.Monitors)
- Declaration: `internal static class RunwayIncursionDetector`
- Methods: BuildCrossRunwayLabel, Cross2D, GetAircraftVelocity, IsCrossRunwayIncursion_LL, IsCrossRunwayIncursion_TL, IsCrossRunwayIncursion_TT, IsRollingOutInFence, IsSameRunwayLLIncursion, IsShortFinalApproach, RaysIntersect2D, ShouldIgnoreRunwayPair, TryGetLandingRunwayRays (all internal static)

### RunwayIncursionMonitor (ContextCross.Summary.Monitors)
- Declaration: `public class RunwayIncursionMonitor : IFixedTickable, IActiveRunwayIncursionQuery, IDisposable`
- Nested: DetectedIncursion (struct) — Primary : string, Secondary : string, Runway : string, Scenario : RunwayIncursionScenario
- Fields: heightThresholdFeet : float; clearedToLandCallsigns : HashSet<string>; clearedForTakeoffCallsigns : HashSet<string>; _incursionPublisher : IPublisher<RunwayIncursionDetected>; _messagePublisher : IPublisher<MessageData>; _activeIncursions : HashSet<string>; _activeIncursionCallsigns : HashSet<string>; _frameIncursions : Dictionary<string, DetectedIncursion>; _incursionCooldown : Dictionary<string, ulong>; _isInitialTick : bool; _monitoringEnabled : bool; _monitoringPolicy : RunwayIncursionMonitoringPolicy; _requiresBaselineAfterSuppression : bool; _gameTime : GameTime; _registry : IGameStateRegistry
- Properties: IsQueryEnabled (private) : bool
- Methods: BeginMonitoringForLoadedLevel, Dispose, FixedTick, IsCallsignInActiveIncursion

### ActualFlightReducer (ContextCross.Summary.Reducers)
- Declaration: `public sealed class ActualFlightReducer : IStartable, IDisposable, ISummaryDataProvider<ActualFlightRaw>, IAnySummaryDataProvider`
- Fields: _flightOperationCompletedSubscriber : ISubscriber<FlightOperationCompleted>; _history : List<FlightOperationCompleted>; _historyView : ReadOnlyCollection<FlightOperationCompleted>; _disposable : DisposableBag
- Properties: History : IReadOnlyList<FlightOperationCompleted>; RawDataType : Type
- Methods: CollectSummaryData, Dispose, Start

### ConversationTimingReducer (ContextCross.Summary.Reducers)
- Declaration: `public sealed class ConversationTimingReducer : IStartable, IDisposable, ISummaryDataProvider<ConversationTimingRaw>, IAnySummaryDataProvider`
- Fields: _evaluationSubscriber : ISubscriber<ConversationTimingEvaluated>; _history : List<ConversationTimingEvaluated>; _historyView : ReadOnlyCollection<ConversationTimingEvaluated>; _disposable : DisposableBag
- Properties: History : IReadOnlyList<ConversationTimingEvaluated>; RawDataType : Type
- Methods: CollectSummaryData, Dispose, Start

### DepartureHandoverReducer (ContextCross.Summary.Reducers)
- Declaration: `public sealed class DepartureHandoverReducer : IStartable, IDisposable, ISummaryDataProvider<DepartureHandoverRaw>, IAnySummaryDataProvider`
- Fields: _departureHandoverSubscriber : ISubscriber<DepartureHandoverEvaluated>; _history : List<DepartureHandoverEvaluated>; _historyView : ReadOnlyCollection<DepartureHandoverEvaluated>; _disposable : DisposableBag
- Properties: History : IReadOnlyList<DepartureHandoverEvaluated>; RawDataType : Type
- Methods: CollectSummaryData, Dispose, Start

### GoAroundReducer (ContextCross.Summary.Reducers)
- Declaration: `public sealed class GoAroundReducer : IStartable, IDisposable, ISummaryDataProvider<GoAroundRaw>, IAnySummaryDataProvider`
- Fields: _goAroundSubscriber : ISubscriber<GoAroundDetected>; _history : List<GoAroundDetected>; _historyView : ReadOnlyCollection<GoAroundDetected>; _disposable : DisposableBag
- Properties: History : IReadOnlyList<GoAroundDetected>; RawDataType : Type
- Methods: CollectSummaryData, Dispose, Start

### OnTimeFlightReducer (ContextCross.Summary.Reducers)
- Declaration: `public sealed class OnTimeFlightReducer : IStartable, IDisposable, ISummaryDataProvider<OnTimeFlightRaw>, IAnySummaryDataProvider`
- Nested: PlannedEndInfo (struct) — Direction : EFlightDirection, PlannedEndTime : DateTime
- Fields: OnTimeGrace (static) : TimeSpan; _flightPlanLoadedSubscriber : ISubscriber<AfterLoaded<FlightPlan>>; _flightOperationCompletedSubscriber : ISubscriber<FlightOperationCompleted>; _history : List<FlightOperationCompleted>; _historyView : ReadOnlyCollection<FlightOperationCompleted>; _plannedEndTimes : Dictionary<string, PlannedEndInfo>; _onTimeCount : int; _disposable : DisposableBag
- Properties: History : IReadOnlyList<FlightOperationCompleted>; RawDataType : Type
- Methods: CollectSummaryData, Dispose, Start

### PlannedFlightReducer (ContextCross.Summary.Reducers)
- Declaration: `public sealed class PlannedFlightReducer : IStartable, IDisposable, IPlannedFlightSummaryDataProvider, ISummaryDataProvider<PlannedFlightRaw>, IAnySummaryDataProvider`
- Fields: TrafficOverhead (static) : TimeSpan; _flightPlanLoadedSubscriber : ISubscriber<AfterLoaded<FlightPlan>>; _history : List<AfterLoaded<FlightPlan>>; _historyView : ReadOnlyCollection<AfterLoaded<FlightPlan>>; _disposable : DisposableBag
- Properties: History : IReadOnlyList<AfterLoaded<FlightPlan>>; RawDataType : Type
- Methods: CollectSummaryData, CollectSummaryData(scoringStartTime, scoringEndTime), Dispose, Start

### RunwayIncursionReducer (ContextCross.Summary.Reducers)
- Declaration: `public sealed class RunwayIncursionReducer : IStartable, IDisposable, ISummaryDataProvider<RunwayIncursionRaw>, IAnySummaryDataProvider`
- Fields: _incursionSubscriber : ISubscriber<RunwayIncursionDetected>; _history : List<RunwayIncursionDetected>; _historyView : ReadOnlyCollection<RunwayIncursionDetected>; _disposable : DisposableBag
- Properties: History : IReadOnlyList<RunwayIncursionDetected>; RawDataType : Type
- Methods: CollectSummaryData, Dispose, Start

### IPlannedFlightSummaryDataProvider (ContextCross.Summary)
- Declaration: `public interface IPlannedFlightSummaryDataProvider : ISummaryDataProvider<PlannedFlightRaw>, IAnySummaryDataProvider`
- Methods: CollectSummaryData (DateTime scoringStartTime, DateTime scoringEndTime)

### RunwayIncursionMonitoringPolicy (ContextCross.Summary)
- Declaration: `public sealed class RunwayIncursionMonitoringPolicy`
- Nested: SuppressionLease : IDisposable — _owner : RunwayIncursionMonitoringPolicy, _suppressionId : long
- Fields: _suppressions : HashSet<long>; _nextSuppressionId : long; RestrictionsChanged (backing) : Action
- Properties: IsMonitoringSuppressed : bool; RestrictionsChanged : event Action
- Methods: SuppressMonitoring

---
### AircraftTelemetryControlSeat (ContextCross.Telemetry)
- Declaration: `public enum AircraftTelemetryControlSeat : byte`
- Values: Unassigned = 0, Ramp = 1, Ground = 2, Tower = 3, Departure = 4, Approach = 5, Delivery = 6, Apron = 7, Unknown = 255

### AircraftTelemetryRadioChannelType (ContextCross.Telemetry)
- Declaration: `public enum AircraftTelemetryRadioChannelType : byte`
- Values: Ramp = 1, Ground = 2, Tower = 3, Departure = 4, Approach = 5, Delivery = 6, Apron = 7

### AircraftTelemetryStatus (ContextCross.Telemetry)
- Declaration: `public enum AircraftTelemetryStatus : byte`
- Values: Unknown = 0, Active = 1, ActionRequired = 2, HandoffPending = 3, PendingAtStand = 4, CompletedAtStand = 5

### AircraftTelemetryPacketWriter (ContextCross.Telemetry)
- Declaration: `public sealed class AircraftTelemetryPacketWriter`
- Nested: RecordTemplate — Bytes : byte[], CallSign : string, AircraftType : string, Star : string, Runway : string, Stand : string, Route : string, LastUsedPacketSequence : ulong
- Fields: _buffer : byte[]; _templates : Dictionary<string, RecordTemplate>; _staleTemplatePks : List<string>; _recordCount : int; _packetSequence : ulong (many public const layout offsets/format constants omitted)
- Properties: (none)
- Methods: Begin, Complete, TryAppend, WriteActiveRunwaysPacket, WriteRadioChannelsPacket, WriteSelectedAircraftPacket, WriteTaxiPathPacket

### AircraftTelemetryRadioChannelRecord (ContextCross.Telemetry)
- Declaration: `public struct AircraftTelemetryRadioChannelRecord`
- Fields: ChannelType : AircraftTelemetryRadioChannelType; Flags : byte; FrequencyKhz : uint; ShortCode : string
- Properties: (none)
- Methods: (none)

### AircraftTelemetryRecord (ContextCross.Telemetry)
- Declaration: `public struct AircraftTelemetryRecord`
- Fields: EntityPk : string; CallSign : string; AircraftType : string; FlightDirection : byte; ControlSeat : byte; SeatSequence : byte; TelemetryStatus : byte; Position : Vector3; Direction : Vector3; TaxiSpeed : float; AirSpeedKnot : float; Star : string; Runway : string; Stand : string; Route : string; StripFlags : byte; PatienceRemaining : byte; JurisdictionSeat : byte; RadioFrequencyKhz : uint
- Properties: (none)
- Methods: (none)

### AircraftUdpCommandService (ContextCross.Telemetry)
- Declaration: `public sealed class AircraftUdpCommandService : IStartable, IFixedTickable, IDisposable`
- Fields: _registry : IGameStateRegistry; _apiGateway : ApiGateway; _receiveBuffer : byte[]; _socket : Socket; _receiveFailureLogged : bool; _badDatagramLogged : bool
- Properties: (none)
- Methods: Dispose, FixedTick, Start

### AircraftUdpTelemetryService (ContextCross.Telemetry)
- Declaration: `public sealed class AircraftUdpTelemetryService : IStartable, IFixedTickable, IDisposable`
- Nested: RadioChannelRecordComparer : IComparer<AircraftTelemetryRadioChannelRecord> (static Instance); SentTaxiPath (struct) — Path : Path, CallSign : string; StripTelemetryState (struct) — Flags : byte, PatienceRemaining : byte; TelemetryCandidate (struct) — Aircraft : Aircraft, FlightPlan : FlightPlan, Direction : EFlightDirection, CallSign : string, ControlSeat : AircraftTelemetryControlSeat, SeatSequence : byte, Status : AircraftTelemetryStatus, SortTime : DateTime; TelemetryCandidateComparer : IComparer<TelemetryCandidate> (static Instance)
- Fields: _gameTime : GameTime; _sessionContextProvider : GameSessionContextProvider; _flightStripPatienceStore : FlightStripPatienceStore; _aircraftSelectedSubscriber : ISubscriber<OnSelect<Aircraft>>; _registry : IGameStateRegistry; _writer : AircraftTelemetryPacketWriter; _telemetryCandidates : List<TelemetryCandidate>; _sentTaxiPaths : Dictionary<string, SentTaxiPath>; _liveTaxiPathPks : HashSet<string>; _staleTaxiPathPks : List<string>; _taxiPathPointsBuffer : List<Vector3>; _activeRunwaysBuffer : List<string>; _lastSentActiveRunways : List<string>; _radioChannelsBuffer : List<AircraftTelemetryRadioChannelRecord>; _lastSentRadioChannels : List<AircraftTelemetryRadioChannelRecord>; _activeRunwaysSent : bool; _radioChannelsSent : bool; _selectedAircraftSent : bool; _selectedAircraftPk : string; _selectedAircraftCallSign : string; _lastSentSelectedAircraftCallSign : string; _selectedAircraftSession : GameSessionContext; _telemetrySession : GameSessionContext; _socket : Socket; _aircraftSelectionSubscription : IDisposable; _sendFailureLogged : bool; _missingSpecificationLogged : bool; _missingControlSeatLogged : bool; _invalidFrequencyLogged : bool; _nextPausedHeartbeatRealtime : float; _nextExtendedResendRealtime : float; _heartbeatSequence : ushort
- Properties: (none)
- Methods: Dispose, FixedTick, Start

### UdpCommandType (ContextCross.Telemetry)
- Declaration: `public enum UdpCommandType : ushort`
- Values: SelectAircraft = 1

### UdpCommand (ContextCross.Telemetry)
- Declaration: `public struct UdpCommand`
- Fields: Type : UdpCommandType; CallSign : string
- Properties: (none)
- Methods: (none)

### UdpCommandParser (ContextCross.Telemetry)
- Declaration: `public static class UdpCommandParser`
- Methods: TryParse (static)

### UdpCommandParseResult (ContextCross.Telemetry)
- Declaration: `public enum UdpCommandParseResult : int`
- Values: Ok = 0, Malformed = 1, UnsupportedVersion = 2, UnknownCommand = 3

### Airport (ContextCross)
- Declaration: `public class Airport : MonoBehaviour`
- Fields: LatLon : double2; UtcOffset : int
- Properties: (none)
- Methods: (none)

### AirportSpot2D (global namespace)
- Declaration: `public class AirportSpot2D : MonoBehaviour, IScaleableElement`
- Fields: _color : Color; _spot : SpriteRenderer; _disposable : IDisposable; _runwayViewModel : RunwayViewModel
- Properties: (none)
- Methods: Init, Scale

---
### AircraftLiveryLoader (GroundATC.Modding.HD)
- Declaration: `public class AircraftLiveryLoader : IDisposable`
- Fields: _configByModelAndAirline : Dictionary<string, ModLiveryEntry>; _cacheByKey : Dictionary<string, Dictionary<string, AircraftLivery>>; _rootPath : string
- Properties: (none)
- Methods: Dispose, GetLivery, PreloadAllLocalLiveries

### AircraftModelVersions (GroundATC.Modding.Models)
- Declaration: `public static class AircraftModelVersions`
- Fields: SupportedVersions (static) : IReadOnlyDictionary<string, string>
- Properties: (none)
- Methods: GetSupportedVersion (static)

### AircraftLivery (global namespace)
- Declaration: `public class AircraftLivery`
- Fields: AlbedoTex : Texture2D; MaskTex : Texture2D; NormalTex : Texture2D; LitTex : Texture2D; CoatTex : Texture2D
- Properties: (none)
- Methods: (none)

---
