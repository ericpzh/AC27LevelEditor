// ─── localStorage keys ─────────────────────────────────────
export const STORAGE_KEY_LANG = 'ac27_lang';
export const STORAGE_KEY_THEME = 'ac27_theme';

// ─── Valid languages ───────────────────────────────────────
export const VALID_LANGUAGES = new Set(['en', 'zh']);

// ─── Weather presets ───────────────────────────────────────
export const WEATHER_PRESETS = ['Sunny', 'FewCloudy', 'MidCloudy', 'PartlyCloudy', 'OvercastSky', 'AfterRain'];

// ─── Compass directions ────────────────────────────────────
export const COMPASS_DIRS = ['N', '', '', 'E', '', '', 'S', '', '', 'W', '', ''];
export const COMPASS_CARDINAL = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// ─── File filtering ────────────────────────────────────────

/**
 * Full filenames (with extension) that are visible in production
 * (non-demo) mode, in display order: the position of each entry in
 * this list is the order levels appear in the browser. Only levels
 * explicitly listed here appear when browsing the full game root.
 * Update this list when production levels are added or removed.
 */
export const PROD_VISIBLE_BASES = [
  // ZSJN — Relax Time, Busy Time, Runway Change, Peak Departure, Taxiway Closed
  'ZSJN_leisure_1.acl',
  'ZSJN_leisure_2.acl',
  'ZSJN_runwaychange.acl',
  'ZSJN_peakdeparture.acl',
  'ZSJN_taixwayclosed.acl',
  // KJFK — Relax Time, Busy Time, Runway Change, Peak Departure, Peak Arrival
  'KJFK_leisure_1.acl',
  'KJFK_leisure_2.acl',
  'KJFK_runwaychange.acl',
  'KJFK_peakdeparture.acl',
  'KJFK_peakarrival.acl',
  // KDCA — Relax Time, Busy Time, Runway Change, Peak Departure, Peak Arrival
  'KDCA_leisure_1.acl',
  'KDCA_leisure_2.acl',
  'KDCA_runwaychange.acl',
  'KDCA_peakdeparture.acl',
  'KDCA_peakarrival.acl',
  // ZGSZ — Endless
  'ZGSZ_Endless.acl',
];

/**
 * Full filenames (with extension) that are visible in demo mode,
 * in display order: the position of each entry in this list is the
 * order levels appear in the browser. Only levels explicitly listed
 * here appear when browsing the demo game root. Update this list
 * when demo levels are added or removed.
 */
export const DEMO_VISIBLE_ORDER = [
  // KJFK — Relax Time, Peak Arrival
  'KJFK_leisure_1.demo.acl',
  'KJFK_peakarrival.demo.acl',
  // ZSJN — Relax Time, Peak Departure
  'ZSJN_leisure_1.acl',
  'ZSJN_peakdeparture.demo.acl',
];

/**
 * Set view of DEMO_VISIBLE_ORDER. Only these files get the 30-minute
 * demo window treatment. Kept as a Set because electron/main.js uses
 * Set.has() for exact filename matching.
 */
export const DEMO_VISIBLE_BASES = new Set(DEMO_VISIBLE_ORDER);

// ─── Toast types ───────────────────────────────────────────
export const TOAST_TYPES = { SUCCESS: 'success', ERROR: 'error' };
