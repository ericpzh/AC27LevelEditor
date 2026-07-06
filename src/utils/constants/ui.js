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
export const RE_HIDDEN = /tutorial|bench|test|crossrunway|dev|endless|\.prod/i;

/**
 * Full filenames (with extension) that are visible in demo mode.
 * Only levels in this set appear when browsing the demo game root,
 * and only these files get the 30-minute demo window treatment.
 * Update this set when demo levels are added or removed.
 */
export const DEMO_VISIBLE_BASES = new Set([
  'ZSJN-Morning_120min.demo.acl',
  'ZSJN_17-19_emerg.acl',
  'KJFK_07-09_emerg.acl',
  'KJFK_20-22.demo.acl',
]);

// ─── Toast types ───────────────────────────────────────────
export const TOAST_TYPES = { SUCCESS: 'success', ERROR: 'error' };
