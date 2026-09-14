/**
 * RunwayTimeline dead-reference pruning (ZSJN_leisure_2 ground-fuzz NRE).
 *
 * A scenery save can delete/rename-away a runway the level's embedded
 * RunwayTimeline still activates. Unity resolves `InitialRunways` at load and
 * throws NullReferenceException on a name with no `runway:` entry
 * (`InitialRunways: ["19"]` after the `01/19` runway was gone).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _pruneRunwayTimelineReferences, _remapRunwayNameFields } = require('../../src/acl/scenery_write');

const block = (names, rlength) => '"RunwayTimeline": { "InitialRunways": { "$id": 10, "$type": "10|System.String[], mscorlib", "$rlength": '
  + rlength + ', "$rcontent": [ ' + names.map((n) => '"' + n + '"').join(', ') + ' ] } }';

describe('_pruneRunwayTimelineReferences', () => {
  it('drops InitialRunways entries whose runway no longer exists', () => {
    const out = _pruneRunwayTimelineReferences(block(['19'], 1), new Set(['07', '25']));
    expect(out).toContain('"$rlength": 1');
    expect(out).toContain('"07"');
    expect(out).not.toContain('"19"');
  });

  it('keeps live entries and leaves the text untouched when all are live', () => {
    const src = block(['01', '19'], 2);
    expect(_pruneRunwayTimelineReferences(src, new Set(['01', '19']))).toBe(src);
    const out = _pruneRunwayTimelineReferences(block(['01', '19'], 2), new Set(['19']));
    expect(out).toContain('"$rlength": 1');
    expect(out).toContain('"19"');
    expect(out).not.toContain('"01"');
  });
});

describe('_remapRunwayNameFields — runway change frames', () => {
  it('remaps Source/Dest (not a *Runway* field name)', () => {
    const src = '{ "Source": "01", "Dest": "19", "Runway": "01" }';
    const out = _remapRunwayNameFields(src, new Map([['01', '07']]));
    expect(out).toContain('"Source": "07"');
    expect(out).toContain('"Runway": "07"');
  });
});
