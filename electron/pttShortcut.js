/**
 * Global PTT hotkey manager (main process).
 *
 * Renderer keydown only fires while a window is focused. For PTT while the
 * game is focused we use the OS-level globalShortcut (main process).
 *
 * globalShortcut reports press only (no key-up), so when a `keyWatch` is
 * available we turn the press into a true HOLD-to-talk: broadcast
 * `onPress` (global-ptt-down), arm the watcher for the hotkey's virtual key,
 * and broadcast `onRelease` (global-ptt-up) on the down→up transition. This
 * also absorbs Windows' RegisterHotKey auto-repeat, which would otherwise
 * flip a plain toggle handler rapidly while the combo is held.
 *
 * Without a keyWatch (non-Windows / koffi unavailable / tests) it degrades to
 * the legacy TOGGLE semantics via `onTrigger`.
 *
 * The renderer owns the mic session (it supplies the airport waypoints), so
 * this manager only broadcasts edges to the target strips window.
 *
 * CJS with all Electron/FS access injected as deps (never requires
 * 'electron' itself) so unit tests can require it directly in plain node.
 */

const { acceleratorToVk } = require('./pttKeyWatch');

const PTT_SHORTCUT_DEFAULT = 'Shift+Space';

function getPttShortcutSetting(loadConfig) {
  try {
    const cfg = loadConfig();
    if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'pttShortcut')) {
      return typeof cfg.pttShortcut === 'string' ? cfg.pttShortcut.trim() : PTT_SHORTCUT_DEFAULT;
    }
    return PTT_SHORTCUT_DEFAULT;
  } catch (_) { return PTT_SHORTCUT_DEFAULT; }
}

function createPttShortcutManager({ globalShortcut, loadConfig, saveConfig, getStripsWindows, onTrigger, onPress, onRelease, keyWatch }) {
  let current = null;
  let holding = false;      // a press is active and awaiting key-up
  let holdTarget = null;    // window that received the press (release goes to it)

  function pickTargetWindow() {
    let wins = [];
    try { wins = getStripsWindows() || []; } catch (_) { return null; }
    const alive = wins.filter((w) => {
      try { return w && !w.isDestroyed(); } catch (_) { return false; }
    });
    if (!alive.length) return null;
    return alive.find((w) => {
      try { return w.isFocused(); } catch (_) { return false; }
    }) || alive[0];
  }

  function releaseHold() {
    if (!holding) return;
    holding = false;
    const target = holdTarget;
    holdTarget = null;
    if (keyWatch && typeof keyWatch.cancel === 'function') {
      try { keyWatch.cancel(); } catch (_) { /* watcher gone */ }
    }
    try { if (onRelease) onRelease(target); } catch (_) { /* window gone */ }
  }

  function triggerPress(accelerator, target) {
    const vk = acceleratorToVk(accelerator);
    const canHold = vk && keyWatch && typeof keyWatch.watch === 'function'
      && typeof keyWatch.isAvailable === 'function' && keyWatch.isAvailable()
      && typeof onPress === 'function' && typeof onRelease === 'function';
    if (!canHold) {
      if (onTrigger) { try { onTrigger(target); } catch (_) { /* window gone */ } }
      return;
    }
    // Auto-repeat (Windows RegisterHotKey) re-fires while held — absorb it:
    // only the first edge broadcasts the press, every edge re-arms the watch.
    if (!holding) {
      holding = true;
      holdTarget = target;
      try { onPress(target); } catch (_) { /* window gone */ }
    }
    keyWatch.watch(vk, releaseHold);
  }

  function register(accelerator) {
    try {
      if (current) {
        try { globalShortcut.unregister(current); } catch (_) { /* gone */ }
        current = null;
      }
      releaseHold(); // a remap while held must not leave a stuck mic
      if (!accelerator) return { success: true, shortcut: '' }; // empty = disabled
      globalShortcut.register(accelerator, () => {
        const target = pickTargetWindow();
        if (target) triggerPress(accelerator, target);
      });
      if (!globalShortcut.isRegistered(accelerator)) return { success: false, error: 'REGISTER_FAILED' };
      current = accelerator;
      return { success: true, shortcut: accelerator };
    } catch (err) { return { success: false, error: (err && err.message) || 'REGISTER_FAILED' }; }
  }

  function dispose() {
    releaseHold();
    if (current) {
      try { globalShortcut.unregister(current); } catch (_) { /* shutting down */ }
      current = null;
    }
  }

  function get() {
    return {
      success: true,
      shortcut: getPttShortcutSetting(loadConfig),
      defaultShortcut: PTT_SHORTCUT_DEFAULT,
    };
  }

  function set(accelerator) {
    const s = typeof accelerator === 'string' ? accelerator.trim() : '';
    if (s) {
      const r = register(s);
      if (!r.success) return { success: false, error: r.error || 'REGISTER_FAILED' };
    } else {
      register('');
    }
    try {
      const cfg = loadConfig() || {};
      cfg.pttShortcut = s;
      saveConfig(cfg);
    } catch (e) { return { success: false, error: e.message }; }
    return { success: true, shortcut: s };
  }

  return { get, set, register, dispose, pickTargetWindow, getCurrent: () => current };
}

module.exports = { PTT_SHORTCUT_DEFAULT, getPttShortcutSetting, createPttShortcutManager };
