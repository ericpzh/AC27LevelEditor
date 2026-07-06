// ─── Nautical mile → game units (1852 m ÷ 100 m/unit) ──────
export const NM_TO_GU = 18.52;

// ─── Wind speed ───────────────────────────────────────────
export const KTS_TO_MS = 0.514444;
export const MPS_TO_KNOTS = 1 / KTS_TO_MS;  // ~1.94384
export const WIND_UNITS = { KNOTS: 'knots', MPS: 'mps' };

// ─── Approach & aviation math ─────────────────────────────
export const APPROACH_MIN_TTL = 30;
export const GLIDESLOPE_DEG = 3;
export const TAN_3_DEG = Math.tan(GLIDESLOPE_DEG * Math.PI / 180);   // ~0.052408
export const RAD_TO_DEG = 180 / Math.PI;
export const APPROACH_SPEED_KTS = 240;
export const APPROACH_SPEED_MS = APPROACH_SPEED_KTS * KTS_TO_MS;  // 123.47 m/s
// DEPRECATED: replaced by physics-based APPROACH_SPEED_MS. Kept as fallback.
export const APPROACH_EFFECTIVE_SPEED = 12.5;

// ─── Coordinate scale ─────────────────────────────────────
//
// All axes (XYZ) use a uniform 100 m/unit scale. Confirmed by original
// game files using Y=15.24 (=5000ft) at every airport regardless of runway
// geometry.
export const DEFAULT_AIRPORT_SCALE = 100;

// ─── Approach altitude ceiling ─────────────────────────────
//
// Standard ILS approach ceiling in real-world units (5000ft AGL).
//   approachCap = APPROACH_CEILING_M / DEFAULT_AIRPORT_SCALE = 15.24
export const APPROACH_CEILING_FT = 5000;
export const FT_TO_M = 0.3048;
export const APPROACH_CEILING_M = APPROACH_CEILING_FT * FT_TO_M;  // 1524m

// ─── Approach fallback values ──────────────────────────────
export const DEFAULT_TAT = 1600;           // default totalApproachTime (seconds)
export const TD_FALLBACK_EXTEND = 50;      // game-units to extend past last path point

// ─── Dynamics defaults ─────────────────────────────────────
export const TAXI_SPEED = 240;
export const POSITIVE_TAXI_ACCEL = 1;
export const NEGATIVE_TAXI_ACCEL = -2;
export const DYNAMICS_STATE_FLYING = 1;      // State=30
export const DYNAMICS_STATE_APPROACH = 2;    // State=5

// ─── Command / channel type numbers ────────────────────────
export const CMD_CONTACT_TOWER = 22;
export const CMD_CLEARED_TO_LAND = 23;
export const CMD_GO_AROUND = 24;
export const CMD_CONTINUE_APPROACH = 25;
export const CMD_CLEAR_FOR_TAKEOFF = 26;
export const CMD_LINE_UP_WAIT = 27;
export const CMD_HOLD_SHORT = 28;         // hold short of runway
export const CMD_PUSH_BACK = 31;
export const CMD_CONTACT_GROUND = 33;
export const CMD_HOLD_SHORT_TAXI = 39;    // hold short at taxiway
export const CMD_HOLD_POSITION = 40;
export const CMD_TAXI_VIA = 41;
export const CMD_CONTACT_DEP = 42;
export const CMD_CHANGE_RWY = 43;
export const CMD_DISPATCH_TOW = 44;
export const CMD_SELECT_EXIT = 45;
export const CMD_STAND_BY = 46;
export const CMD_CROSS_RWY = 47;
export const CHANNEL_TYPE_APPROACH = 5;
export const CHANNEL_TYPE_TOWER = 3;

// ─── Vector epsilon thresholds ─────────────────────────────
export const EPSILON_NORMALIZE = 1e-12;      // zero-vector guard
export const EPSILON_PR = 0.001;
export const EPSILON_IAF_JOIN = 0.1;
