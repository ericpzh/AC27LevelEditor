// ─── ACL format structure ──────────────────────────────────
// Unity JSON special metadata keys
export const SPECIAL_KEYS = new Set([
  '$id', '$type', '$ref', '$rcontent', '$rlength', '$values', '__v',
]);
// Known ACL top-level section names
export const TOP_LEVEL_SECTIONS = [
  'SceneryData', 'WorldState', 'GameTime', 'Config', 'Channels',
  'WeatherFrames', 'WindFrames', 'RunwayTimeline', 'Jetways',
];
// WorldState sub-sections
export const WORLD_STATE_SUB = ['Aircrafts', 'AircraftAnimators', 'FlightPlans'];

// ─── $id offsets for generated entries ─────────────────────
export const ID_OFFSET_FLIGHTPLAN = 90000;
export const ID_OFFSET_AIRCRAFT = 70000;
export const ID_OFFSET_ANIMATOR = 80000;
export const ID_OFFSET_DYNAMICS = 100000;
export const TYPE_NUM_FALLBACK_START = 100;
export const DEFAULT_SNAPSHOT_ID_START = 5001;

// ─── Specification defaults ────────────────────────────────
export const DEFAULT_AERODROME_CODE = 67;
export const DEFAULT_WAKE_CATEGORY = 77;
export const DEFAULT_RUNWAY_VR_SPEED = 140;
export const DEFAULT_RUNWAY_TAKEOFF_LENGTH = 2000;
export const DEFAULT_MODEL_OFFSET = { x: 0.19, y: -0.05, z: -0.20 };
