/**
 * Reproducible synthetic GATCARC4 v3 fixture builder for unit and integration tests.
 *
 * Exercises:
 *   - GATCARC4 v3 header + LevelPayload + 1 MARF v3 checkpoint frame
 *   - Nested reference graphs ($id / $ref, {id, type, values}, {id, value}, pk:concrete-type:key
 *     including colon-bearing keys)
 *   - Signed 64-bit Q32.32 & tick integers beyond Number.MAX_SAFE_INTEGER
 *     (e.g. createdAtUtcTicks = 639247227652411246n, Position3 coords = 9007199254740995n)
 *   - Runway pairs, taxiways, stands, areas, airways, routes, jetways, departure + arrival
 *     flight plans, docked + flying runtime aircraft, animators, and singletons.
 */
const fs = require('fs');
const path = require('path');
const { TARGET_SCHEMA_HASH, getSchemaForHash } = require('../../../src/acl/v3/schema_registry');
const { encodeV3Container } = require('../../../src/acl/v3/framing');
const { normalizeDocumentGraph, makeTypedArray, makeReactive, makePkRef } = require('../../../src/acl/v3/graph');
const { validateV3Container } = require('../../../src/acl/v3/validator');
const { encodeQ32, encodeGuToPosition3, encodeDegToRadiansQ32, encodeWindSpeedFromKnots } = require('../../../src/acl/v3/q32');

function buildSyntheticV3Container(overrides = {}) {
  const schema = getSchemaForHash(TARGET_SCHEMA_HASH);
  const levelGuid = overrides.levelGuid || 'SYNTH_leisure_1';
  const airportIcao = overrides.airportIcao || 'ZSJN';

  const header = {
    schemaHash: TARGET_SCHEMA_HASH,
    archiveGuid: levelGuid,
    progressDisplayName: null,
    levelGuid,
    airportIcao,
    ...(overrides.header || {}),
  };

  const metaData = {
    Guid: levelGuid,
    Author: 'AC27LevelEditor',
    LastModified: '2026-11-12T20:40:31Z',
    Config: {
      prototypeName: airportIcao,
      name: levelGuid,
      geoDataFile: 'geo_data',
      taxiNavigationDataFile: 'taxi_navigation',
      generatedTaxiNavigationDataFile: 'generated_taxi_navigation',
      visualGeoDataFile: 'visual_geo_data',
      radioTemplateFileZH: 'radio_templates_zh',
      radioTemplateFileEN: 'radio_templates_en',
      radioAudioClipNamesFileZH: 'audio_clips_zh',
      radioAudioClipNamesFileEN: 'audio_clips_en',
      channelFile: 'channels',
      flightScheduleFile: `${levelGuid}_schedule`,
      referenceLatitude: encodeDegToRadiansQ32(36.8572),
      referenceLongitude: encodeDegToRadiansQ32(117.216),
      scaleFactor: encodeQ32(0.01),
      usePercentOffset: true,
      offsetRatio: encodeQ32(0.05),
      offsetDistance: encodeQ32(10),
      offset: [0, 0],
      startTime: '08:00:00',
      endTime: '10:00:00',
      isSurfaceRadarTrafficHidden: false,
      tutorialScenario: 0,
    },
    BaseTime: '2000-01-01T08:00:00',
    WeatherFrames: [
      { preset: 'Clear', time: '08:00:00' },
      { preset: 'Cloudy', time: '09:00:00' },
    ],
    WindFrames: [
      {
        direction: encodeDegToRadiansQ32(180),
        speed: encodeQ32(6.0), // exact 6.0 m/s in Q32.32 to test untouched preservation
        time: '08:00:00',
      },
      {
        direction: encodeDegToRadiansQ32(210),
        speed: encodeWindSpeedFromKnots(15),
        time: '09:15:00',
      },
    ],
    RunwayTimeline: {
      initialRunways: ['01'],
      timeline: [
        {
          time: '09:30:00',
          changes: [{ source: '01', dest: '19' }],
        },
      ],
    },
    ...(overrides.metaData || {}),
  };

  // Shared StaticData nodes
  const makeTwNode = (osmId, posTuple, type = 1, flags = 0) => ({
    $type: 'ContextCross.Models.TaxiwayNode',
    Flags: flags,
    Name: null,
    OsmId: osmId,
    PK: `taxiway-node:${osmId}`,
    ReactivePosition: makeReactive(posTuple),
    Type: type,
  });

  const th01 = makeTwNode(-1001, encodeGuToPosition3({ x: 0, y: 0, z: -15 }), 1, 0);
  const th19 = makeTwNode(-1002, encodeGuToPosition3({ x: 0, y: 0, z: 15 }), 1, 0);
  const hold01 = makeTwNode(-1003, encodeGuToPosition3({ x: -1.2, y: 0, z: -14 }), 3, 0);
  const exit01 = makeTwNode(-1004, encodeGuToPosition3({ x: -1.2, y: 0, z: 5 }), 4, 0);
  const twMid = makeTwNode(-1005, encodeGuToPosition3({ x: -1.2, y: 0, z: 0 }), 1, 0);
  const stand101Nose = makeTwNode(-1006, encodeGuToPosition3({ x: -3.0, y: 0, z: -1.0 }), 0, 0);
  const stand101Tail = makeTwNode(-1007, encodeGuToPosition3({ x: -2.37, y: 0, z: -1.0 }), 0, 0);
  const stand101Push = makeTwNode(-1008, encodeGuToPosition3({ x: -1.2, y: 0, z: -1.0 }), 2, 0);
  const stand102Nose = makeTwNode(-1009, encodeGuToPosition3({ x: -3.0, y: 0, z: 1.0 }), 0, 0);
  const stand102Tail = makeTwNode(-1010, encodeGuToPosition3({ x: -2.37, y: 0, z: 1.0 }), 0, 0);
  // Node with exact > MAX_SAFE_INTEGER signed int64 Q32.32 values to exercise lossless 64-bit precision
  const farBoundaryNode = makeTwNode(-1099, [9007199254740995n, 0, -9007199254740995n], 1, 0);

  const segMain = {
    $type: 'ContextCross.Models.TaxiwaySegment',
    Directed: false,
    Flags: 1,
    Head: hold01,
    IsHidden: false,
    IsUnselectable: false,
    Name: 'A',
    Nodes: makeReactive([hold01, stand101Push, twMid, exit01]),
    OsmId: -2001,
    PK: 'taxiway-segment:-2001:0',
  };

  const segRwyStrip = {
    $type: 'ContextCross.Models.TaxiwaySegment',
    Directed: false,
    Flags: 4,
    Head: th01,
    IsHidden: false,
    IsUnselectable: false,
    Name: '01/19',
    Nodes: makeReactive([th01, th19]),
    OsmId: -2002,
    PK: 'taxiway-segment:-2002:0',
  };

  const awFix1 = {
    $type: 'ContextCross.Models.AirwayNode',
    Name: 'PEXEL',
    OsmId: -3001,
    PK: 'airway-node:-3001',
    Position: encodeGuToPosition3({ x: -40, y: 0, z: -80 }),
  };
  const awFix2 = {
    $type: 'ContextCross.Models.AirwayNode',
    Name: 'JN101',
    OsmId: -3002,
    PK: 'airway-node:-3002',
    Position: encodeGuToPosition3({ x: 0, y: 0, z: -45 }),
  };
  const awFix3 = {
    $type: 'ContextCross.Models.AirwayNode',
    Name: 'FI01',
    OsmId: -3003,
    PK: 'airway-node:-3003',
    Position: encodeGuToPosition3({ x: 0, y: 0, z: -25 }),
  };
  const awSidEnd = {
    $type: 'ContextCross.Models.AirwayNode',
    Name: 'DOVOP',
    OsmId: -3004,
    PK: 'airway-node:-3004',
    Position: encodeGuToPosition3({ x: 20, y: 0, z: 60 }),
  };

  const awSegStar = {
    $type: 'ContextCross.Models.AirwaySegment',
    Name: 'PEXEL1A',
    Nodes: makeReactive([awFix1, awFix2]),
    OsmId: -3101,
    PK: 'airway-segment:-3101',
  };

  const sharedPhysRwy = {
    PhysicalName: '01/19',
  };

  const rwy01 = {
    $type: 'ContextCross.Models.Runway',
    AreaVertices: makeTypedArray('GroundAtc.Numerics.Position3[]', [
      encodeGuToPosition3({ x: -0.25, y: 0, z: -15 }),
      encodeGuToPosition3({ x: 0.25, y: 0, z: -15 }),
      encodeGuToPosition3({ x: 0.25, y: 0, z: 15 }),
      encodeGuToPosition3({ x: -0.25, y: 0, z: 15 }),
    ]),
    EdgePoints: makeTypedArray('ContextCross.Models.TaxiwayNode[]', [th01, th19]),
    Entries: makeTypedArray('ContextCross.Models.Runway+Entry[]', [
      {
        DefinePoint: hold01,
        HoldingPosition: hold01,
        LineUpPosition: th01,
        Name: 'A1',
      },
    ]),
    Exits: makeTypedArray('ContextCross.Models.Runway+Exit[]', [
      {
        DefinePoint: exit01,
        ExitPosition: exit01,
        HoldingPosition: exit01,
        IsLeft: true,
        Name: 'A2',
      },
    ]),
    HoldingAreas: makeTypedArray('ContextCross.Models.Runway+HoldingAreaData[]', []),
    LabelPositionNode: th01,
    Name: '01',
    PhysicalRunwayStaticItem: sharedPhysRwy,
    Routes: makeTypedArray('ContextCross.Models.Runway+Route[]', [
      {
        AirwayNodes: makeTypedArray('ContextCross.Models.AirwayNode[]', [awFix1, awFix2]),
        Name: 'PEXEL1A',
        RouteType: 0, // Star
      },
      {
        AirwayNodes: makeTypedArray('ContextCross.Models.AirwayNode[]', [awFix2, awFix3]),
        Name: 'ILS01',
        RouteType: 1, // App
      },
      {
        AirwayNodes: makeTypedArray('ContextCross.Models.AirwayNode[]', [awFix3, awSidEnd]),
        Name: 'DOVOP1D',
        RouteType: 2, // Sid
      },
      {
        AirwayNodes: makeTypedArray('ContextCross.Models.AirwayNode[]', [awFix3, awSidEnd]),
        Name: 'GA01',
        RouteType: 3, // MissedApch
      },
    ]),
    ThresholdPoints: makeTypedArray('ContextCross.Models.TaxiwayNode[]', [th01, th19]),
    TouchDownPoint: th01,
    Width: encodeQ32(45), // 45m = 0.45 GU
  };

  const rwy19 = {
    $type: 'ContextCross.Models.Runway',
    AreaVertices: makeTypedArray('GroundAtc.Numerics.Position3[]', [
      encodeGuToPosition3({ x: -0.25, y: 0, z: 15 }),
      encodeGuToPosition3({ x: 0.25, y: 0, z: 15 }),
      encodeGuToPosition3({ x: 0.25, y: 0, z: -15 }),
      encodeGuToPosition3({ x: -0.25, y: 0, z: -15 }),
    ]),
    EdgePoints: makeTypedArray('ContextCross.Models.TaxiwayNode[]', [th19, th01]),
    Entries: makeTypedArray('ContextCross.Models.Runway+Entry[]', []),
    Exits: makeTypedArray('ContextCross.Models.Runway+Exit[]', []),
    HoldingAreas: makeTypedArray('ContextCross.Models.Runway+HoldingAreaData[]', []),
    LabelPositionNode: th19,
    Name: '19',
    PhysicalRunwayStaticItem: sharedPhysRwy,
    Routes: makeTypedArray('ContextCross.Models.Runway+Route[]', []),
    ThresholdPoints: makeTypedArray('ContextCross.Models.TaxiwayNode[]', [th19, th01]),
    TouchDownPoint: th19,
    Width: encodeQ32(45),
  };

  const stand101 = {
    $type: 'ContextCross.Models.Stand',
    EgressType: 0,
    Identifier: '101',
    Name: '101',
    NosePosition: stand101Nose,
    ParkingType: 1,
    PushbackLimitPositions: makeTypedArray('ContextCross.Models.TaxiwayNode[]', [stand101Push]),
    TailPosition: stand101Tail,
  };

  const stand102 = {
    $type: 'ContextCross.Models.Stand',
    EgressType: 0,
    Identifier: '102',
    Name: '102',
    NosePosition: stand102Nose,
    ParkingType: 1,
    PushbackLimitPositions: makeTypedArray('ContextCross.Models.TaxiwayNode[]', [twMid]),
    TailPosition: stand102Tail,
  };

  const emptyStrArr = makeTypedArray('System.String[]', []);
  const navStand101 = {
    $type: 'ContextCross.Models.FixedTaxiNavigationPoint',
    CrossTaxiwayNames: emptyStrArr,
    Direction: null,
    PK: 'taxi-navigation:stand:101',
    Position: encodeGuToPosition3({ x: -3.0, y: 0, z: -1.0 }),
    Reference: stand101,
    RelatedRunway: '',
    RelatedStand: '101',
    TaxiwayName: '',
    Type: 4,
  };
  const navPush101 = {
    $type: 'ContextCross.Models.FixedTaxiNavigationPoint',
    CrossTaxiwayNames: emptyStrArr,
    Direction: null,
    PK: 'taxi-navigation:pushback:101:0',
    Position: encodeGuToPosition3({ x: -1.2, y: 0, z: -1.0 }),
    Reference: stand101Push,
    RelatedRunway: '',
    RelatedStand: '101',
    TaxiwayName: 'A',
    Type: 3,
  };

  const rawStatic = {
    NonPKStaticEntities: [
      {
        $type: 'ContextCross.Models.Area',
        AreaType: 0,
        NodePositions: makeReactive([
          encodeGuToPosition3({ x: -4, y: 0, z: -2 }),
          encodeGuToPosition3({ x: -1, y: 0, z: -2 }),
          encodeGuToPosition3({ x: -1, y: 0, z: 2 }),
          encodeGuToPosition3({ x: -4, y: 0, z: 2 }),
        ]),
      },
    ],
    PKStaticEntities: {
      'taxiway-node:-1001': th01,
      'taxiway-node:-1002': th19,
      'taxiway-node:-1003': hold01,
      'taxiway-node:-1004': exit01,
      'taxiway-node:-1005': twMid,
      'taxiway-node:-1006': stand101Nose,
      'taxiway-node:-1007': stand101Tail,
      'taxiway-node:-1008': stand101Push,
      'taxiway-node:-1009': stand102Nose,
      'taxiway-node:-1010': stand102Tail,
      'taxiway-node:-1099': farBoundaryNode,
      'taxiway-segment:-2001:0': segMain,
      'taxiway-segment:-2002:0': segRwyStrip,
      'airway-node:-3001': awFix1,
      'airway-node:-3002': awFix2,
      'airway-node:-3003': awFix3,
      'airway-node:-3004': awSidEnd,
      'airway-segment:-3101': awSegStar,
      'runway:01': rwy01,
      'runway:19': rwy19,
      'stand:101': stand101,
      'stand:102': stand102,
      'taxi-navigation:stand:101': navStand101,
      'taxi-navigation:pushback:101:0': navPush101,
    },
    StaticItems: {
      'physical-runway:01/19': sharedPhysRwy,
      'jetway:101': {
        $type: 'ContextCross.Models.JetwayStaticItem',
        InitialAutoUndockFinished: false,
        InitialProgress: 0,
        InitialStatus: 0,
        Name: '101',
        Stands: makeTypedArray('ContextCross.Models.Stand[]', [stand101]),
      },
      'jetway:102': {
        $type: 'ContextCross.Models.JetwayStaticItem',
        InitialAutoUndockFinished: false,
        InitialProgress: 0,
        InitialStatus: 0,
        Name: '102',
        Stands: makeTypedArray('ContextCross.Models.Stand[]', [stand102]),
      },
      'radio-channel:121.85': {
        $type: 'ContextCross.Models.RadioChannelStaticItem',
        Frequency: '121.85',
        InitialAutoControlled: false,
        InitialMuted: false,
        LocalizationKey: 'ground_zsjn',
        RadioName: 'Ground',
        ShortCode: 'GND',
        Type: 2,
        Voice: { zh: 'Hanser', en: 'Hanser-EN' },
      },
      'radio-channel:118.30': {
        $type: 'ContextCross.Models.RadioChannelStaticItem',
        Frequency: '118.30',
        InitialAutoControlled: false,
        InitialMuted: false,
        LocalizationKey: 'tower_zsjn',
        RadioName: 'Tower',
        ShortCode: 'TWR',
        Type: 3,
        Voice: { zh: 'Hanser', en: 'Hanser-EN' },
      },
      'flight-plan:B-1001': {
        $type: 'ContextCross.Models.FlightPlanStaticItem',
        AircraftType: 'BOEING 737-800',
        AirlineName: 'CES',
        InitialArrival: null,
        InitialDeparture: {
          CallSign: 'CES5101',
          DestinationAirport: 'ZBAA',
          OffBlockTime: '2000-01-01T08:10:00',
          Runway: '01',
          Stand: '101',
          TakeoffTime: '0001-01-01T00:00:00',
        },
        Language: 'zh',
        Registration: 'B-1001',
        Voice: 'CN-Captain-Young',
      },
      'flight-plan:B-2002': {
        $type: 'ContextCross.Models.FlightPlanStaticItem',
        AircraftType: 'AIRBUS A-320neo',
        AirlineName: 'CCA',
        InitialArrival: {
          ActualInBlockTime: '0001-01-01T00:00:00',
          CallSign: 'CCA8202',
          InBlockTime: '0001-01-01T00:00:00',
          LandingTime: '2000-01-01T08:06:00',
          OriginAirport: 'ZSPD',
          Runway: '01',
          STAR: 'PEXEL1A',
          Stand: '102',
        },
        InitialDeparture: null,
        Language: 'zh',
        Registration: 'B-2002',
        Voice: 'CN-Captain-Middle-Aged',
      },
    },
  };

  const staticData = normalizeDocumentGraph(rawStatic, schema.roots.static, schema);

  // Runtime checkpoint frame
  const rtEmptyStrings = makeTypedArray('System.String[]', []);
  const rtEmptyEvents = makeTypedArray('ContextCross.Events.AircraftEvent[]', []);
  const rtEmptyCmds = makeTypedArray('ContextCross.Enums.ECommand[]', []);

  const makeCoord = () => ({
    CrossRunwayPermissions: makeReactive(rtEmptyStrings),
    HoldShortAcknowledgedRunwayNames: makeReactive(rtEmptyStrings),
    RunwayFenceCurrentEnterRunways: makeReactive(rtEmptyStrings),
    RunwayGuardCurrentEnterRunway: makeReactive(rtEmptyStrings),
    RunwaySetter: 0,
    TaxiBlockingRunwayNames: makeReactive(rtEmptyStrings),
    TaxiPathUnPassedIntersectionRunwayNames: makeReactive(rtEmptyStrings),
  });

  const rtChGround = {
    $type: 'ContextCross.Models.RadioChannel',
    IsAutoControlled: makeReactive(false),
    IsMuted: makeReactive(false),
  };
  const rtChTower = {
    $type: 'ContextCross.Models.RadioChannel',
    IsAutoControlled: makeReactive(false),
    IsMuted: makeReactive(false),
  };

  const rtFpDep = {
    $type: 'ContextCross.Models.FlightPlan',
    StaticItem: makePkRef('ContextCross.Models.FlightPlanStaticItem', 'flight-plan:B-1001'),
    _arrivalActualInBlockTime: '0001-01-01T00:00:00',
    _arrivalInBlockTime: '0001-01-01T00:00:00',
    _arrivalRunway: null,
    _arrivalStand: null,
    _departureRunway: '01',
    _departureStand: '101',
    _departureTakeoffTime: '2000-01-01T08:15:30',
  };

  const rtFpArr = {
    $type: 'ContextCross.Models.FlightPlan',
    StaticItem: makePkRef('ContextCross.Models.FlightPlanStaticItem', 'flight-plan:B-2002'),
    _arrivalActualInBlockTime: '0001-01-01T00:00:00',
    _arrivalInBlockTime: '2000-01-01T08:11:00',
    _arrivalRunway: '01',
    _arrivalStand: '102',
    _departureRunway: null,
    _departureStand: null,
    _departureTakeoffTime: '0001-01-01T00:00:00',
  };

  const rtAcDep = {
    $type: 'ContextCross.Aircrafts.Aircraft',
    AircraftRunwayCoordinator: makeCoord(),
    DynamicsData: {
      DynamicsNegativeTaxiAcceleration: 0,
      DynamicsParams: null,
      DynamicsPositiveTaxiAcceleration: 0,
      DynamicsState: makeReactive(0),
      DynamicsTargetTaxiSpeed: 0,
      ForwardSpeed: true,
      FrontWheelSteeringAngle: 0,
      NegativeTaxiAcceleration: 0,
      PositiveTaxiAcceleration: 0,
      PushbackStopRequested: false,
      TargetTaxiSpeed: 0,
      TaxiArrivalToHoldingPointPath: null,
      TaxiArrivalToSpotPath: null,
      TaxiSpeed: 0,
    },
    RollingPresetTaxiPathStartingPosition: [0, 0, 0],
    SelectedPushbackLimitPosition: makePkRef(
      'ContextCross.Models.FixedTaxiNavigationPoint',
      'taxi-navigation:pushback:101:0'
    ),
    SelectedRunwayEntryIndex: -1,
    SelectedRunwayExitIndex: -1,
    SelectedTowPosition: null,
    TaxiPathStartingPosition: [0, 0, 0],
    _direction: makeReactive([encodeQ32(-1), 0, 0]),
    _flightDirection: makeReactive(0),
    _flightPlan: rtFpDep,
    _groundIdleTimerState: { AccumulatedTicks: 0, IsRunning: false, StartedAtTick: 0 },
    _isFirstTaxi: false,
    _jurisdictionRadioChannel: makeReactive(null),
    _position: makeReactive(encodeGuToPosition3({ x: -3.0, y: 0, z: -1.0 })),
    _radioChannel: makeReactive(null),
    _receivedEvents: makeReactive(rtEmptyEvents),
    _rollingPresetTaxiPath: makeReactive(null),
    _route: makeReactive(''),
    _selectedRunwayEntryRunway: null,
    _state: makeReactive(10),
    _taxiPath: makeReactive(null),
    _waitingForCommands: makeReactive(rtEmptyCmds),
  };

  const rtAcArr = {
    $type: 'ContextCross.Aircrafts.Aircraft',
    AircraftRunwayCoordinator: makeCoord(),
    DynamicsData: {
      DynamicsNegativeTaxiAcceleration: encodeQ32(-1.0),
      DynamicsParams: {
        $type: 'ContextCross.Dynamics.States.FlyApproachDynamicsParams',
        AppPointList: [
          encodeGuToPosition3({ x: 0, y: 0, z: -45 }),
          encodeGuToPosition3({ x: 0, y: 0, z: -25 }),
        ],
        FlyApproachPathPointList: [
          encodeGuToPosition3({ x: -40, y: 0, z: -80 }),
          encodeGuToPosition3({ x: 0, y: 0, z: -45 }),
        ],
        ProgressRatio: encodeQ32(0.5),
      },
      DynamicsPositiveTaxiAcceleration: encodeQ32(0.5),
      DynamicsState: makeReactive(1),
      DynamicsTargetTaxiSpeed: 0,
      ForwardSpeed: true,
      FrontWheelSteeringAngle: 0,
      NegativeTaxiAcceleration: encodeQ32(-1.0),
      PositiveTaxiAcceleration: encodeQ32(0.5),
      PushbackStopRequested: false,
      TargetTaxiSpeed: encodeQ32(120),
      TaxiArrivalToHoldingPointPath: null,
      TaxiArrivalToSpotPath: null,
      TaxiSpeed: encodeQ32(120),
    },
    RollingPresetTaxiPathStartingPosition: [0, 0, 0],
    SelectedPushbackLimitPosition: null,
    SelectedRunwayEntryIndex: -1,
    SelectedRunwayExitIndex: -1,
    SelectedTowPosition: null,
    TaxiPathStartingPosition: [0, 0, 0],
    _direction: makeReactive([0, 0, encodeQ32(1)]),
    _flightDirection: makeReactive(1),
    _flightPlan: rtFpArr,
    _groundIdleTimerState: { AccumulatedTicks: 0, IsRunning: false, StartedAtTick: 0 },
    _isFirstTaxi: false,
    _jurisdictionRadioChannel: makeReactive(null),
    _position: makeReactive(encodeGuToPosition3({ x: -20, y: 10, z: -62.5 })),
    _radioChannel: makeReactive(rtChTower),
    _receivedEvents: makeReactive(rtEmptyEvents),
    _rollingPresetTaxiPath: makeReactive(null),
    _route: makeReactive('PEXEL1A'),
    _selectedRunwayEntryRunway: null,
    _state: makeReactive(30),
    _taxiPath: makeReactive(null),
    _waitingForCommands: makeReactive(rtEmptyCmds),
  };

  const rawRuntime = {
    RuntimeEntities: {
      'physical-runway:01/19': {
        $type: 'ContextCross.Models.PhysicalRunway',
        _latestDepartureRoll: null,
      },
      'jetway:101': {
        $type: 'ContextCross.Models.Jetway',
        AutoUndockFinished: false,
        DockingAircraft: makeReactive(rtAcDep),
        DockingDoorIndex: makeReactive(0),
        Progress: makeReactive(encodeQ32(1)),
        Status: 2,
        TrigEvent: true,
      },
      'jetway:102': {
        $type: 'ContextCross.Models.Jetway',
        AutoUndockFinished: false,
        DockingAircraft: makeReactive(null),
        DockingDoorIndex: makeReactive(-1),
        Progress: makeReactive(0),
        Status: 0,
        TrigEvent: false,
      },
      'radio-channel:121.85': rtChGround,
      'radio-channel:118.30': rtChTower,
      'flight-plan:B-1001': rtFpDep,
      'flight-plan:B-2002': rtFpArr,
      'singleton:game-time': {
        $type: 'ContextCross.Clock.GameTimeEntity',
        CurrentDateTime: makeReactive('2000-01-01T08:00:05.25'),
        CurrentTick: makeReactive(525),
        CurrentTimestamp: makeReactive(52500000),
      },
      'singleton:game-event-schedule': {
        $type: 'ContextCross.Clock.GameEventScheduleEntity',
        EventQueue: [],
        NextEventSequence: 1,
      },
      'singleton:scoring-state': {
        $type: 'ContextCross.Summary.ScoringStateEntity',
        ActiveIncursions: [],
        CompletedLegs: [],
        Conversations: [],
        GoArounds: [],
        Handovers: [],
        IncursionMessageCooldowns: [],
        Incursions: [],
        PendingConversations: [],
        PlayerRequestedDepartureContacts: [],
        ScoringWindowStart: '2000-01-01T08:00:05.25',
        StartedLegs: [],
        WakeChecks: [],
      },
      'aircraft:B-1001': rtAcDep,
      'aircraft-animator:aircraft:B-1001': {
        $type: 'ContextCross.Models.AircraftAnimator',
        Aircraft: rtAcDep,
        FlapRatio: 0,
        GearRatio: encodeQ32(1),
        GearRetractIssued: false,
        GearTargetRatio: encodeQ32(1),
        GoAroundCommandTick: 0,
        GoAroundPhase: 0,
        HasGoAroundCommandTick: false,
        HasSnapshot: true,
        IsGearMoving: false,
        SlatRatio: 0,
        TakeoffPitch: 0,
        TakeoffPitchElapsed: 0,
        TakeoffPitchActive: false,
        Version: 3,
      },
      'aircraft:B-2002': rtAcArr,
      'aircraft-animator:aircraft:B-2002': {
        $type: 'ContextCross.Models.AircraftAnimator',
        Aircraft: rtAcArr,
        FlapRatio: 0,
        GearRatio: 0,
        GearRetractIssued: false,
        GearTargetRatio: 0,
        GoAroundCommandTick: 0,
        GoAroundPhase: 0,
        HasGoAroundCommandTick: false,
        HasSnapshot: true,
        IsGearMoving: false,
        SlatRatio: 0,
        TakeoffPitch: 0,
        TakeoffPitchElapsed: 0,
        TakeoffPitchActive: false,
        Version: 3,
      },
    },
  };

  const runtimeData = normalizeDocumentGraph(rawRuntime, schema.roots.runtime, schema);

  const frames = overrides.frames !== undefined ? overrides.frames : [
    {
      version: 3,
      summary: {
        kind: 0,
        displayName: '',
        createdAtUtcTicks: 639247227652411246n, // > Number.MAX_SAFE_INTEGER
        inGameDateTimeTicks: 0,
        departureCount: 0,
        arrivalCount: 0,
      },
      runtimeData,
      recentMessages: [],
      dirtySummary: true,
      dirtyRuntime: true,
      dirtyMessages: true,
    },
  ];

  const container = {
    version: 3,
    header,
    metaData,
    staticData,
    frames,
    dirtyHeader: true,
    dirtyMetaData: true,
    dirtyStaticData: true,
  };

  validateV3Container(container);
  return container;
}

function buildSyntheticV3Buffer(overrides = {}) {
  const container = buildSyntheticV3Container(overrides);
  return encodeV3Container(container, { forceReencode: true });
}

const SYNTH_FIXTURE_PATH = path.join(__dirname, 'SYNTH_leisure_1.acl');

function ensureSyntheticFixtureOnDisk() {
  const buf = buildSyntheticV3Buffer();
  fs.mkdirSync(path.dirname(SYNTH_FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(SYNTH_FIXTURE_PATH, buf);
  return SYNTH_FIXTURE_PATH;
}

module.exports = {
  SYNTH_FIXTURE_PATH,
  buildSyntheticV3Container,
  buildSyntheticV3Buffer,
  ensureSyntheticFixtureOnDisk,
};
