/**
 * Lightweight debug-log gate for the renderer.
 *
 * Noisy diagnostic logs (tagged with a prefix like "[StandMap]") are suppressed
 * unless debug mode is enabled.  Enable via:
 *   1. localStorage key  ac27_debug = '1' / 'true'
 *   2. URL query param   ?debug=1
 *
 * Usage:
 *   import { debugLog } from '../utils/debugLog.js';
 *   debugLog('[StandMap] expand — removing opening state');
 *
 * console.error / console.warn are NOT gated — they always pass through.
 */

const STORAGE_KEY = 'ac27_debug';

let _enabled = null;

function isEnabled() {
  if (_enabled !== null) return _enabled;
  try {
    // 1. localStorage
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === '1' || stored === 'true') {
      _enabled = true;
      return true;
    }
    // 2. URL query param
    const qs = new URLSearchParams(window.location.search);
    if (qs.get('debug') === '1' || qs.get('debug') === 'true') {
      _enabled = true;
      return true;
    }
  } catch (_) {
    // localStorage / URLSearchParams unavailable (SSR, test env)
  }
  _enabled = false;
  return false;
}

/**
 * Log a message only when debug mode is enabled.
 * @param {...any} args
 */
export function debugLog(...args) {
  if (isEnabled()) {
    console.log(...args);
  }
}

/**
 * Force-enable or disable debug logging at runtime.
 * (Mostly useful from the devtools console.)
 */
export function setDebugEnabled(on) {
  _enabled = !!on;
  try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (_) {}
}

/**
 * Returns whether debug logging is currently enabled.
 */
export function isDebugEnabled() {
  return isEnabled();
}
