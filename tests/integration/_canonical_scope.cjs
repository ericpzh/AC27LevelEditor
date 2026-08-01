/**
 * Canonical RuntimeEntities frame-scope type declarations from the fixture
 * tests/fixtures/game-root/GroundATC_Data/StreamingAssets/Airports/ZSJN/Levels/
 * ZSJN-Morning_120min.v4.acl (the file the save pipeline is verified against).
 *
 * Type ids are per-GATCARC4-segment scope and vary between files; this is the
 * scope every unit test that drives _buildActiveJetwayEntry or
 * _buildStandaloneAircraftEntry must resolve against, because type resolution
 * is STRICT — a canonical name missing from the scope asserts [TYPE-ASSERT]
 * instead of minting a fallback id.
 *
 * Derived via tests/_debug/dump_frame_scope.cjs. Duplicate names keep
 * last-in-text-order semantics (AircraftEvent[] is declared at both 1 and 28;
 * name→id resolution yields 28, matching the production segTypeMap build).
 */
const CANONICAL_SCOPE = new Map([
  [0, 'ContextCross.Saves.ReplayJournalSerialization+ReplayJournal, GroundATC.Core'],
  [1, 'ContextCross.Events.AircraftEvent[], GroundATC.Core'],
  [2, 'System.Collections.Generic.GenericEqualityComparer`1[[System.String, mscorlib]], mscorlib'],
  [3, 'ContextCross.Models.Jetway, GroundATC.Core'],
  [4, 'R3.ReactiveProperty`1[[System.Single, mscorlib]], R3'],
  [5, 'R3.ReactiveProperty`1[[ContextCross.Aircrafts.Aircraft, GroundATC.Core]], R3'],
  [6, 'R3.ReactiveProperty`1[[System.Int32, mscorlib]], R3'],
  [7, 'ContextCross.Aircrafts.Aircraft, GroundATC.Core'],
  [8, 'ContextCross.Models.AircraftSpecification, GroundATC.Core'],
  [9, 'Unity.Mathematics.float3, Unity.Mathematics'],
  [10, 'UnityEngine.Vector4[], UnityEngine.CoreModule'],
  [11, 'UnityEngine.Vector4, UnityEngine.CoreModule'],
  [12, 'ContextCross.Dynamics.AircraftDynamicsData, GroundATC.Core'],
  [13, 'R3.ReactiveProperty`1[[ContextCross.Dynamics.Enums.State, GroundATC.Core]], R3'],
  [14, 'ContextCross.Aircrafts.AircraftRunwayCoordinator, GroundATC.Core'],
  [15, 'R3.ReactiveProperty`1[[System.String[], mscorlib]], R3'],
  [16, 'System.String[], mscorlib'],
  [17, 'UnityEngine.Vector3, UnityEngine.CoreModule'],
  [18, 'ContextCross.Models.FlightPlan, GroundATC.Core'],
  [19, 'System.DateTime, mscorlib'],
  [20, 'R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EAircraftState, GroundATC.Core]], R3'],
  [21, 'R3.ReactiveProperty`1[[ContextCross.Aircrafts.Enums.EFlightDirection, GroundATC.Core]], R3'],
  [22, 'R3.ReactiveProperty`1[[ContextCross.Models.RadioChannel, GroundATC.Core]], R3'],
  [23, 'R3.ReactiveProperty`1[[ContextCross.Models.Path, GroundATC.Core]], R3'],
  [24, 'R3.ReactiveProperty`1[[System.String, mscorlib]], R3'],
  [25, 'R3.ReactiveProperty`1[[ContextCross.Enums.ECommand[], GroundATC.Core]], R3'],
  [26, 'ContextCross.Enums.ECommand[], GroundATC.Core'],
  [27, 'R3.ReactiveProperty`1[[ContextCross.Events.AircraftEvent[], GroundATC.Core]], R3'],
  [28, 'ContextCross.Events.AircraftEvent[], GroundATC.Core'],
  [29, 'R3.ReactiveProperty`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], R3'],
  [30, 'ContextCross.Models.RadioChannel, GroundATC.Core'],
  [31, 'R3.ReactiveProperty`1[[System.Boolean, mscorlib]], R3'],
  [32, 'ContextCross.Clock.GameTimeEntity, GroundATC.Core'],
  [33, 'R3.ReactiveProperty`1[[System.DateTime, mscorlib]], R3'],
  [34, 'R3.ReactiveProperty`1[[System.UInt64, mscorlib]], R3'],
  [35, 'ContextCross.Clock.GameEventScheduleEntity, GroundATC.Core'],
  [36, 'System.Collections.Generic.List`1[[ContextCross.Events.AircraftEvent, GroundATC.Core]], mscorlib'],
  [37, 'ContextCross.Events.EventLogEntity, GroundATC.Core'],
  [38, 'System.Collections.Generic.Dictionary`2[[System.String, mscorlib],[System.Collections.Generic.Dictionary`2[[System.Type, mscorlib],[ContextCross.Events.AircraftEvent, GroundATC.Core]], mscorlib]], mscorlib'],
  [39, 'System.Collections.Generic.Dictionary`2[[System.Type, mscorlib],[ContextCross.Events.AircraftEvent, GroundATC.Core]], mscorlib'],
  [40, 'System.Collections.Generic.ObjectEqualityComparer`1[[System.Type, mscorlib]], mscorlib'],
  [41, 'System.RuntimeType, mscorlib'],
  [42, 'ContextCross.Events.ContactTower, GroundATC.Core'],
  [43, 'ContextCross.Events.ReadyForCommunication, GroundATC.Core'],
  [44, 'ContextCross.Events.CommunicationCompleted, GroundATC.Core'],
  [45, 'ClearedToLand, GroundATC.Core'],
  [46, 'ContextCross.Events.ContactGround, GroundATC.Core'],
  [47, 'ContextCross.Events.ReadyForUndocking, GroundATC.Core'],
  [48, 'ContextCross.Models.Path, GroundATC.Core'],
  [49, 'ContextCross.Models.PathSegment[], GroundATC.Core'],
  [50, 'ContextCross.Models.PathSegment, GroundATC.Core'],
  [51, 'ContextCross.Models.AircraftAnimator, GroundATC.Core'],
  [52, 'ContextCross.Dynamics.States.ApproachDynamicsParams, GroundATC.Core'],
  [53, 'System.Collections.Generic.List`1[[UnityEngine.Vector3, UnityEngine.CoreModule]], mscorlib'],
  [54, 'ContextCross.Dynamics.States.FlyApproachDynamicsParams, GroundATC.Core'],
]);

module.exports = { CANONICAL_SCOPE };
