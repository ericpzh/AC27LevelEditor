/**
 * Shared PTT global-hotkey helpers (pure, no Electron imports so both the
 * renderer and unit tests can use them; the main-process side lives in
 * electron/pttShortcut.js, which re-declares the same default).
 */

export const PTT_SHORTCUT_DEFAULT = 'Shift+Space';

/** Canonical modifier labels used in Electron accelerators. */
const MOD_CANON = {
  control: 'Ctrl', ctrl: 'Ctrl', command: 'Ctrl', cmd: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl',
  alt: 'Alt', option: 'Alt', altgr: 'Alt',
  shift: 'Shift', super: 'Super', meta: 'Meta',
};

function canonMod(raw) {
  return MOD_CANON[String(raw).trim().toLowerCase()] || null;
}

function canonKey(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  if (/^f\d{1,2}$/i.test(s)) {
    const n = parseInt(s.slice(1), 10);
    if (n >= 1 && n <= 24) return 'F' + n;
    return null;
  }
  if (s.toLowerCase() === 'space') return 'Space';
  if (s.length === 1) return s.toUpperCase();
  const low = s.toLowerCase();
  if (low === 'tab') return 'Tab';
  if (low === 'capslock') return 'CapsLock';
  return null;
}

/**
 * Normalize a user-typed accelerator (e.g. "shift + space") to canonical
 * Electron form ("Shift+Space"). Returns '' for empty/disabled, null when
 * unparseable.
 */
export function normalizeAccelerator(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return '';
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  const keyRaw = parts.pop();
  const key = canonKey(keyRaw);
  if (!key) return null;
  const mods = [];
  for (const m of parts) {
    const c = canonMod(m);
    if (!c || mods.includes(c)) return null;
    mods.push(c);
  }
  const order = ['Ctrl', 'Alt', 'Shift', 'Super', 'Meta'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (mods.includes(key)) return null;
  return [...mods, key].join('+');
}

/**
 * globalShortcut can only register combos with a modifier (or a bare
 * F-key). Bare letters/Space would swallow normal typing — reject them.
 */
export function isValidAccelerator(accelerator) {
  if (!accelerator) return false;
  if (/^F\d{1,2}$/.test(accelerator)) return true;
  return accelerator.includes('+');
}

/**
 * Build an accelerator from a renderer keydown event during capture.
 * Returns the canonical accelerator, '' when only modifiers are held
 * (keep waiting), or null when the key itself is unusable.
 */
export function buildAcceleratorFromEvent(e) {
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = null;
  if (e.code === 'Space') {
    key = 'Space';
  } else if (/^F\d{1,2}$/.test(e.key)) {
    key = e.key.toUpperCase();
  } else if (typeof e.key === 'string' && e.key.length === 1) {
    key = e.key.toUpperCase();
  } else if (e.key === 'Tab') {
    key = 'Tab';
  } else if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    return ''; // modifier-only — keep waiting for the real key
  } else {
    return null;
  }
  if (mods.includes(key)) return '';
  if (/^[A-Z0-9]$/.test(key) || key === 'Space' || /^F\d{1,2}$/.test(key) || key === 'Tab') {
    return [...mods, key].join('+');
  }
  return null;
}
