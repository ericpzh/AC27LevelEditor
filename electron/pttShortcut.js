/**
 * Global PTT hotkey manager (main process).
 *
 * Renderer keydown only fires while a window is focused. For PTT while the
 * game is focused we use the OS-level globalShortcut (main process).
 * NOTE: globalShortcut reports press only (no key-up), so the global hotkey
 * is TOGGLE semantics (press = start, press again = stop), unlike the mouse
 * hold-to-talk button. The renderer owns the mic session (it supplies the
 * airport waypoints), so this manager only broadcasts a toggle to the
 * target strips window, which flips its useVoiceCommands hook.
 *
 * CJS with all Electron/FS access injected as deps (never requires
 * 'electron' itself) so unit tests can require it directly in plain node.
 */

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

function createPttShortcutManager({ globalShortcut, loadConfig, saveConfig, getStripsWindows, onTrigger }) {
  let current = null;

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

  function register(accelerator) {
    try {
      if (current) {
        try { globalShortcut.unregister(current); } catch (_) { /* gone */ }
        current = null;
      }
      if (!accelerator) return { success: true, shortcut: '' }; // empty = disabled
      globalShortcut.register(accelerator, () => {
        const target = pickTargetWindow();
        if (target) {
          try { onTrigger(target); } catch (_) { /* window gone */ }
        }
      });
      if (!globalShortcut.isRegistered(accelerator)) return { success: false, error: 'REGISTER_FAILED' };
      current = accelerator;
      return { success: true, shortcut: accelerator };
    } catch (err) { return { success: false, error: (err && err.message) || 'REGISTER_FAILED' }; }
  }

  function dispose() {
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
