// ─── Newtonsoft.Json DateTime ticks ──────────────────────
export const NET_EPOCH_OFFSET = 621355968000000000n;
export const TICKS_PER_SECOND = 10000000n;
export const TICKS_PER_DAY = 86400n * TICKS_PER_SECOND;
export const FALLBACK_BASE_DATE_TICKS = 630822816000000000;
export const MINUTES_PER_DAY = 1440;

// Number-form equivalents (for non-BigInt code paths)
export const TICKS_PER_SECOND_NUM = 10000000;
export const TICKS_PER_DAY_NUM = 864000000000;

// ─── CACHE_VERSION — bump when cache.json schema changes ───
export const CACHE_VERSION = 13;

// ─── Game timing / scenario ────────────────────────────────
export const WARMUP_SEC = 780;             // 13-minute game warmup
export const GRACE_TTL = -10;              // max seconds-past-landing filter
export const DEMO_WINDOW_SEC = 1800;       // 30-minute demo window
export const DEMO_WINDOW_MIN = 30;
export const MIDNIGHT_CROSS_THRESHOLD_MIN = 360;  // 6AM in minutes
export const MIDNIGHT_CROSS_START_HOUR = 18;      // 6PM

// ─── UI timing ─────────────────────────────────────────────
export const TOAST_DURATION_MS = 2500;
export const TOAST_ERROR_DURATION_MS = 10000;

// ─── Default flight creation time offsets (minutes) ────────
export const FALLBACK_BASE_MINUTES = 360;   // 06:00
export const DEFAULT_TIME_OFFSET_MIN = 10;
export const DEFAULT_TAXI_MINUTES = 5;

// ─── Stand occupancy window (minutes) ──────────────────────
export const STAND_DEP_BEFORE_ESTIMATE_MIN = 20;
export const STAND_ARR_AFTER_ESTIMATE_MIN = 20;
export const STAND_LANDING_BEFORE_INBLOCK_MIN = 5;
export const STAND_OCCUPANCY_START_OFFSET_MIN = 30;
export const STAND_OCCUPANCY_END_OFFSET_MIN = 60;
