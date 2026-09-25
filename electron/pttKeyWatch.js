/**
 * pttKeyWatch.js — Windows global key-state watcher that gives the PTT hotkey
 * a real key-UP edge.
 *
 * electron's `globalShortcut` reports press only (and on Windows
 * `RegisterHotKey` even auto-repeats while the combo is held). Hold-to-talk
 * therefore cannot be built from globalShortcut alone. Once the shortcut
 * fires we arm a lightweight poll of `user32!GetAsyncKeyState` for the
 * hotkey's main virtual key and report the down→up transition.
 *
 * koffi (already a dependency — it also binds libvosk.dll in the vosk worker)
 * is required lazily and only on Windows, so this module imports cleanly on
 * any host and in unit tests. The platform probe and timers are injectable
 * (DIP) for tests.
 */
'use strict';

const VK = { SPACE: 0x20, TAB: 0x09, ENTER: 0x0D, CAPSLOCK: 0x14, ESCAPE: 0x1B };
const OEM_VK = {
  '`': 0xC0, '-': 0xBD, '=': 0xBB, '[': 0xDB, ']': 0xDD, '\\': 0xDC,
  ';': 0xBA, "'": 0xDE, ',': 0xBC, '.': 0xBE, '/': 0xBF,
};

/**
 * Map an Electron accelerator (e.g. "Shift+Space", "Ctrl+Alt+P", "F9") to the
 * Windows virtual-key code of its MAIN key. Returns 0 when unmappable.
 * @param {string} accelerator
 * @returns {number}
 */
function acceleratorToVk(accelerator) {
  if (!accelerator || typeof accelerator !== 'string') return 0;
  const parts = accelerator.split('+').map((s) => s.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return 0;
  const up = key.toUpperCase();
  const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(up);
  if (f) return 0x70 + (parseInt(f[1], 10) - 1);
  if (up === 'SPACE') return VK.SPACE;
  if (up === 'TAB') return VK.TAB;
  if (up === 'ENTER' || up === 'RETURN') return VK.ENTER;
  if (up === 'CAPSLOCK') return VK.CAPSLOCK;
  if (up === 'ESC' || up === 'ESCAPE') return VK.ESCAPE;
  if (/^[A-Z]$/.test(up)) return up.charCodeAt(0);
  if (/^[0-9]$/.test(up)) return up.charCodeAt(0);
  if (Object.prototype.hasOwnProperty.call(OEM_VK, key)) return OEM_VK[key];
  return 0;
}

/**
 * Bind user32!GetAsyncKeyState via koffi. Returns an `isDown(vk)` predicate,
 * or null when unavailable (non-Windows, koffi missing, load failure).
 * @returns {((vk:number)=>boolean)|null}
 */
function makeWin32IsDown() {
  if (process.platform !== 'win32') return null;
  let fn = null;
  try {
    // eslint-disable-next-line global-require
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    fn = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
  } catch (_) {
    return null;
  }
  return (vk) => {
    try {
      // High bit (0x8000) = key currently down. The low bit ("pressed since
      // last call") is ignored so repeat polls stay stable.
      return (fn(vk) & 0x8000) !== 0;
    } catch (_) {
      return false;
    }
  };
}

/**
 * @param {Object} [opts]
 * @param {(vk:number)=>boolean} [opts.isDown] — platform probe (default:
 *   user32!GetAsyncKeyState on Windows). Injectable for tests.
 * @param {number} [opts.intervalMs] — poll cadence (default 40 ms).
 * @param {Function} [opts.setIntervalFn]
 * @param {Function} [opts.clearIntervalFn]
 */
function createPttKeyWatch({ isDown, intervalMs = 40, setIntervalFn, clearIntervalFn } = {}) {
  // undefined = use the platform default probe; null = explicitly disabled.
  const down = isDown === undefined
    ? makeWin32IsDown()
    : (typeof isDown === 'function' ? isDown : null);
  const setT = setIntervalFn || setInterval;
  const clearT = clearIntervalFn || clearInterval;
  let timer = null;
  let pending = null;    // { vk, onUp } — the armed hold, if any

  function cancel() {
    if (timer) { clearT(timer); timer = null; }
    pending = null;
  }

  function tick() {
    if (!pending) { cancel(); return; }
    let pressed = false;
    try { pressed = !!down(pending.vk); } catch (_) { pressed = false; }
    if (pressed) return;                 // still held — keep polling
    const cb = pending.onUp;
    cancel();
    try { if (typeof cb === 'function') cb(); } catch (_) { /* consumer gone */ }
  }

  /**
   * Arm the watcher for `vk`; `onUp` fires once when the key is released.
   * Re-arming (Windows hotkey auto-repeat) replaces the pending hold without
   * firing the previous callback.
   * @returns {boolean} true when a probe is available and the watch was armed
   */
  function watch(vk, onUp) {
    if (typeof down !== 'function' || !vk) return false;
    cancel();
    pending = { vk, onUp };
    timer = setT(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function isAvailable() { return typeof down === 'function'; }

  return { isAvailable, watch, cancel, getPendingVk: () => (pending ? pending.vk : 0) };
}

module.exports = { acceleratorToVk, createPttKeyWatch, makeWin32IsDown };
