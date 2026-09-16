// @vitest-environment node

/**
 * Tests for electron/cache-flags.js — the pure whitelist + merge logic behind
 * the `get-cache-flag` / `set-cache-flag` IPC handlers in electron/main.js.
 * No Electron required (pure CommonJS).
 */

import { describe, it, expect } from 'vitest';

const { CACHE_FLAG_KEYS, isCacheFlagKey, readCacheFlag, writeCacheFlag } = require('../../electron/cache-flags');

describe('cache flag whitelist', () => {
  it('exposes the livery hint flag and rejects unknown keys', () => {
    expect(CACHE_FLAG_KEYS).toContain('liveryModHintDismissed');
    expect(isCacheFlagKey('liveryModHintDismissed')).toBe(true);
    expect(isCacheFlagKey('__proto__')).toBe(false);
    expect(isCacheFlagKey('anythingElse')).toBe(false);
    expect(isCacheFlagKey(undefined)).toBe(false);
  });
});

describe('readCacheFlag', () => {
  it('rejects an unknown key with BAD_FLAG', () => {
    expect(readCacheFlag({ flags: {} }, 'nope')).toEqual({ success: false, error: 'BAD_FLAG' });
  });

  it('reads a set flag as true and everything else as false', () => {
    expect(readCacheFlag({ flags: { liveryModHintDismissed: true } }, 'liveryModHintDismissed'))
      .toEqual({ success: true, value: true });
    expect(readCacheFlag({ flags: { liveryModHintDismissed: false } }, 'liveryModHintDismissed'))
      .toEqual({ success: true, value: false });
    expect(readCacheFlag({ flags: {} }, 'liveryModHintDismissed'))
      .toEqual({ success: true, value: false });
  });

  it('tolerates a missing payload or missing flags bag', () => {
    expect(readCacheFlag(null, 'liveryModHintDismissed')).toEqual({ success: true, value: false });
    expect(readCacheFlag({ gameRoot: '/x' }, 'liveryModHintDismissed')).toEqual({ success: true, value: false });
  });

  it('coerces truthy values to a boolean', () => {
    expect(readCacheFlag({ flags: { liveryModHintDismissed: 1 } }, 'liveryModHintDismissed').value).toBe(true);
  });
});

describe('writeCacheFlag', () => {
  it('rejects an unknown key with BAD_FLAG', () => {
    expect(writeCacheFlag({ flags: {} }, 'nope', true)).toEqual({ success: false, error: 'BAD_FLAG' });
  });

  it('refuses to create a cache from a flag write', () => {
    expect(writeCacheFlag(null, 'liveryModHintDismissed', true)).toEqual({ success: false, error: 'NO_CACHE' });
  });

  it('merges the flag into the payload without dropping sibling flags', () => {
    const cache = { gameRoot: '/x', airports: {}, flags: { other: true } };
    const res = writeCacheFlag(cache, 'liveryModHintDismissed', true);
    expect(res.success).toBe(true);
    expect(res.data).toBe(cache);
    expect(cache.flags).toEqual({ other: true, liveryModHintDismissed: true });
    expect(cache.gameRoot).toBe('/x');
  });

  it('creates the flags bag when absent and coerces to a boolean', () => {
    const cache = { gameRoot: '/x' };
    expect(writeCacheFlag(cache, 'liveryModHintDismissed', 'yes').success).toBe(true);
    expect(cache.flags).toEqual({ liveryModHintDismissed: true });
    writeCacheFlag(cache, 'liveryModHintDismissed', 0);
    expect(cache.flags.liveryModHintDismissed).toBe(false);
  });

  it('round-trips through readCacheFlag', () => {
    const cache = { flags: {} };
    writeCacheFlag(cache, 'liveryModHintDismissed', true);
    expect(readCacheFlag(cache, 'liveryModHintDismissed')).toEqual({ success: true, value: true });
  });
});
