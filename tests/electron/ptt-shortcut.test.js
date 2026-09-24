/**
 * Unit tests for electron/pttShortcut.js — the global PTT hotkey manager.
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  PTT_SHORTCUT_DEFAULT,
  getPttShortcutSetting,
  createPttShortcutManager,
} = require('../../electron/pttShortcut');

// ─── Fakes ──────────────────────────────────────────────────────────

function makeGlobalShortcut({ failRegister = false, throwOnRegister = null } = {}) {
  const handlers = new Map();
  return {
    calls: [],
    register(acc, cb) {
      this.calls.push(['register', acc]);
      if (throwOnRegister) throw new Error(throwOnRegister);
      handlers.set(acc, cb);
      return true;
    },
    unregister(acc) {
      this.calls.push(['unregister', acc]);
      handlers.delete(acc);
    },
    isRegistered(acc) {
      return !failRegister && handlers.has(acc);
    },
    fire(acc) {
      const cb = handlers.get(acc);
      if (cb) cb();
    },
    registeredCount() { return handlers.size; },
  };
}

// webContents.send records into the window's sent array.
function makeWindow({ destroyed = false, focused = false } = {}) {
  const win = {
    destroyed,
    focused,
    sent: [],
    isDestroyed() { return win.destroyed; },
    isFocused() { return win.focused; },
  };
  win.webContents = { send: (channel) => { win.sent.push(channel); } };
  return win;
}

function makeConfig(initial = {}) {
  let store = { ...initial };
  return {
    loadConfig: () => store,
    saveConfig: (cfg) => { store = cfg; },
    getStore: () => store,
  };
}

function makeManager(overrides = {}) {
  const globalShortcut = overrides.globalShortcut || makeGlobalShortcut();
  const config = overrides.config || makeConfig();
  let windows = overrides.windows || [];
  const triggered = [];
  const manager = createPttShortcutManager({
    globalShortcut,
    loadConfig: config.loadConfig,
    saveConfig: overrides.saveConfig || config.saveConfig,
    getStripsWindows: overrides.getStripsWindows || (() => windows),
    onTrigger: overrides.onTrigger || ((win) => {
      triggered.push(win);
      win.webContents.send('global-ptt-toggle');
    }),
  });
  return {
    manager, globalShortcut, config, triggered,
    setWindows: (w) => { windows = w; },
  };
}

// ─── getPttShortcutSetting ──────────────────────────────────────────

describe('getPttShortcutSetting', () => {
  it('defaults to Shift+Space when the key is absent', () => {
    expect(PTT_SHORTCUT_DEFAULT).toBe('Shift+Space');
    expect(getPttShortcutSetting(() => ({}))).toBe('Shift+Space');
  });

  it('returns the saved value trimmed', () => {
    expect(getPttShortcutSetting(() => ({ pttShortcut: '  Ctrl+Alt+P ' }))).toBe('Ctrl+Alt+P');
  });

  it('preserves an explicit empty string (disabled)', () => {
    expect(getPttShortcutSetting(() => ({ pttShortcut: '' }))).toBe('');
  });

  it('falls back to default for non-string values and load failures', () => {
    expect(getPttShortcutSetting(() => ({ pttShortcut: 42 }))).toBe('Shift+Space');
    expect(getPttShortcutSetting(() => { throw new Error('no disk'); })).toBe('Shift+Space');
  });
});

// ─── set / get ──────────────────────────────────────────────────────

describe('pttShortcutManager set/get', () => {
  let ctx;
  beforeEach(() => { ctx = makeManager(); });

  it('registers a valid combo and persists it', () => {
    const r = ctx.manager.set('Ctrl+Alt+P');
    expect(r).toEqual({ success: true, shortcut: 'Ctrl+Alt+P' });
    expect(ctx.config.getStore().pttShortcut).toBe('Ctrl+Alt+P');
    expect(ctx.manager.get()).toEqual({
      success: true, shortcut: 'Ctrl+Alt+P', defaultShortcut: 'Shift+Space',
    });
  });

  it('re-registering swaps the old accelerator', () => {
    ctx.manager.set('F9');
    ctx.manager.set('F10');
    const regs = ctx.globalShortcut.calls.filter(([op]) => op === 'register').map(([, acc]) => acc);
    expect(regs).toEqual(['F9', 'F10']);
    expect(ctx.globalShortcut.calls).toContainEqual(['unregister', 'F9']);
    expect(ctx.manager.get().shortcut).toBe('F10');
  });

  it('empty string disables without registering', () => {
    ctx.manager.set('F9');
    const r = ctx.manager.set('');
    expect(r).toEqual({ success: true, shortcut: '' });
    expect(ctx.globalShortcut.registeredCount()).toBe(0);
    expect(ctx.config.getStore().pttShortcut).toBe('');
    expect(ctx.manager.get().shortcut).toBe('');
  });

  it('trims input and treats non-strings as disable', () => {
    expect(ctx.manager.set('  F9  ')).toEqual({ success: true, shortcut: 'F9' });
    expect(ctx.manager.set(undefined)).toEqual({ success: true, shortcut: '' });
  });

  it('does not persist when registration fails', () => {
    const failing = makeManager({ globalShortcut: makeGlobalShortcut({ failRegister: true }) });
    const r = failing.manager.set('F9');
    expect(r).toEqual({ success: false, error: 'REGISTER_FAILED' });
    expect(failing.config.getStore()).toEqual({});
  });

  it('surfaces a register throw as REGISTER_FAILED', () => {
    const throwing = makeManager({ globalShortcut: makeGlobalShortcut({ throwOnRegister: 'denied' }) });
    const r = throwing.manager.set('F9');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/denied|REGISTER_FAILED/);
  });

  it('surfaces a save failure', () => {
    const badSave = makeManager({
      saveConfig: () => { throw new Error('disk full'); },
    });
    const r = badSave.manager.set('F9');
    expect(r).toEqual({ success: false, error: 'disk full' });
  });
});

// ─── hotkey trigger routing ─────────────────────────────────────────

describe('pttShortcutManager trigger routing', () => {
  it('fires the toggle on the focused strips window', () => {
    const ctx = makeManager();
    const unfocused = makeWindow({ focused: false });
    const focused = makeWindow({ focused: true });
    ctx.setWindows([unfocused, focused]);
    ctx.manager.set('F9');
    ctx.globalShortcut.fire('F9');
    expect(focused.sent).toEqual(['global-ptt-toggle']);
    expect(unfocused.sent).toEqual([]);
  });

  it('falls back to the first window when none is focused', () => {
    const ctx = makeManager();
    const first = makeWindow();
    const second = makeWindow();
    ctx.setWindows([first, second]);
    ctx.manager.set('F9');
    ctx.globalShortcut.fire('F9');
    expect(first.sent).toEqual(['global-ptt-toggle']);
    expect(second.sent).toEqual([]);
  });

  it('skips destroyed windows and stays silent with none open', () => {
    const ctx = makeManager();
    const dead = makeWindow({ destroyed: true });
    ctx.setWindows([dead]);
    ctx.manager.set('F9');
    expect(() => ctx.globalShortcut.fire('F9')).not.toThrow();
    expect(ctx.triggered).toEqual([]);
    expect(dead.sent).toEqual([]);
  });
});

// ─── dispose ────────────────────────────────────────────────────────
describe('pttShortcutManager dispose', () => {
  it('unregisters the current hotkey and is a no-op when idle', () => {
    const ctx = makeManager();
    expect(() => ctx.manager.dispose()).not.toThrow();
    ctx.manager.set('F9');
    expect(ctx.globalShortcut.registeredCount()).toBe(1);
    ctx.manager.dispose();
    expect(ctx.globalShortcut.registeredCount()).toBe(0);
    expect(ctx.manager.get().shortcut).toBe('F9'); // persisted value untouched
  });

  it('tolerates an unregister throw on dispose', () => {
    const ctx = makeManager();
    ctx.manager.set('F9');
    ctx.globalShortcut.unregister = () => { throw new Error('gone'); };
    expect(() => ctx.manager.dispose()).not.toThrow();
  });
});

// ─── defensive paths (throwing hosts / windows) ─────────────────────

describe('pttShortcutManager defensive paths', () => {
  it('swaps cleanly when unregister throws', () => {
    const ctx = makeManager();
    ctx.manager.set('F9');
    ctx.globalShortcut.unregister = () => { throw new Error('gone'); };
    const r = ctx.manager.set('F10');
    expect(r).toEqual({ success: true, shortcut: 'F10' });
  });

  it('stays silent when the window list throws', () => {
    const ctx = makeManager({
      getStripsWindows: () => { throw new Error('no windows'); },
    });
    ctx.manager.set('F9');
    expect(() => ctx.globalShortcut.fire('F9')).not.toThrow();
    expect(ctx.triggered).toEqual([]);
  });

  it('skips windows whose status throws and routes to a live one', () => {
    const ctx = makeManager();
    const badDestroy = {
      isDestroyed() { throw new Error('x'); },
      isFocused() { return true; },
      webContents: { send: () => {} },
    };
    const badFocus = makeWindow();
    badFocus.isFocused = () => { throw new Error('y'); };
    const live = makeWindow({ focused: true });
    ctx.setWindows([badDestroy, badFocus, live]);
    ctx.manager.set('F9');
    expect(() => ctx.globalShortcut.fire('F9')).not.toThrow();
    expect(live.sent).toEqual(['global-ptt-toggle']);
  });

  it('swallows an onTrigger throw', () => {
    const ctx = makeManager({
      onTrigger: () => { throw new Error('window gone'); },
    });
    ctx.setWindows([makeWindow()]);
    ctx.manager.set('F9');
    expect(() => ctx.globalShortcut.fire('F9')).not.toThrow();
  });
});
