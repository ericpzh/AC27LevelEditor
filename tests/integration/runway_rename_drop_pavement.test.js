/**
 * Runway-rename / delete pavement-strip cascade.
 *
 * Regression for the ground-fuzz failure:
 *   saved file has pavement strips without a runway: 23/25R   (KJFK)
 *                                                     7/22C    (KDCA)
 *
 * When the survivor gate drops a renamed runway (its thresholds went dangling),
 * it records the SURVIVOR entry's PRE-rename PhysicalName, while the coupled
 * pavement strips carry the POST-rename designation. The registry-rename
 * cancellation must map old→new and expand the dropped set with the new name —
 * otherwise the later name-based strip suppression misses the renamed strips and
 * leaves orphan flags=4 paint in the saved .acl.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _cancelRunwayRegistryForDrops } = require('../../src/acl/scenery_write');

describe('_cancelRunwayRegistryForDrops', () => {
  it('expands a renamed dropped runway to its post-rename designation', () => {
    const dropped = new Set(['4L/22R']);
    const map = new Map([['physical-runway:4L/22R', 'physical-runway:23/25R']]);
    const orphan = new Set();
    _cancelRunwayRegistryForDrops(dropped, map, orphan);
    // The NEW designation must join the dropped set so synthesized/survivor
    // strips named "23/25R" are suppressed by name.
    expect([...dropped].sort()).toEqual(['23/25R', '4L/22R']);
    expect(map.has('physical-runway:4L/22R')).toBe(false);
    expect(orphan.has('physical-runway:4L/22R')).toBe(true);
    expect(orphan.has('physical-runway:23/25R')).toBe(true);
  });

  it('follows a multi-rename chain (A→B→C) to the final designation', () => {
    const dropped = new Set(['A/AA']);
    const map = new Map([
      ['physical-runway:A/AA', 'physical-runway:B/BB'],
      ['physical-runway:B/BB', 'physical-runway:C/CC'],
    ]);
    const orphan = new Set();
    _cancelRunwayRegistryForDrops(dropped, map, orphan);
    expect([...dropped].sort()).toEqual(['A/AA', 'B/BB', 'C/CC']);
    expect(map.size).toBe(0);
    expect([...orphan].sort()).toEqual(['physical-runway:A/AA', 'physical-runway:B/BB', 'physical-runway:C/CC']);
  });

  it('orphans both keys when the recorded name is already the post-rename one', () => {
    const dropped = new Set(['23/25R']);
    const map = new Map([['physical-runway:4L/22R', 'physical-runway:23/25R']]);
    const orphan = new Set();
    _cancelRunwayRegistryForDrops(dropped, map, orphan);
    expect([...dropped]).toEqual(['23/25R']);
    expect(map.size).toBe(0);
    expect(orphan.has('physical-runway:23/25R')).toBe(true);
    expect(orphan.has('physical-runway:4L/22R')).toBe(true);
  });

  it('orphans the plain registry key when the runway was never renamed', () => {
    const dropped = new Set(['15/33']);
    const map = new Map();
    const orphan = new Set();
    _cancelRunwayRegistryForDrops(dropped, map, orphan);
    expect([...dropped]).toEqual(['15/33']);
    expect([...orphan]).toEqual(['physical-runway:15/33']);
  });
});
