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
const { _pruneRunwayTimelineReferences, _remapRunwayNameFields, _ensureInitialRunwaysContain } = require('../../src/acl/scenery_write');

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

  // Ground Painter "delete everything": liveEnds is EMPTY. The old guard
  // (`liveEnds.size === 0` → return) left InitialRunways stale, and the change
  // frames were never pruned — the game then threw ArgumentException
  // "runway.initialRunways references runway '01' that does not exist".
  it('empties InitialRunways and the change frames when every runway is gone', () => {
    const out = _pruneRunwayTimelineReferences(fullBlock(['01'], [[['01', '19']]]), new Set());
    const parsed = JSON.parse('{' + out + '}').RunwayTimeline;
    expect(parsed.InitialRunways.$rlength).toBe(0);
    expect(parsed.InitialRunways.$rcontent).toEqual([]);
    expect(parsed.Timeline.$rlength).toBe(0);
    expect(parsed.Timeline.$rcontent).toEqual([]);
    expect(out).not.toContain('"01"');
    expect(out).not.toContain('"19"');
  });

  it('prunes dead change frames while keeping live ones', () => {
    const out = _pruneRunwayTimelineReferences(
      fullBlock(['01', '04'], [[['01', '19'], ['04', '22']], [['19', '01']]]),
      new Set(['01', '19'])
    );
    const parsed = JSON.parse('{' + out + '}').RunwayTimeline;
    // '01' is live, '04' is dead.
    expect(parsed.InitialRunways.$rcontent).toEqual(['01']);
    expect(parsed.InitialRunways.$rlength).toBe(1);
    // Frame 1 keeps only 01→19 (04→22 dropped); frame 2 (19→01) is fully live.
    expect(parsed.Timeline.$rlength).toBe(2);
    const frame1 = parsed.Timeline.$rcontent[0];
    expect(frame1.Changes.$rlength).toBe(1);
    expect(frame1.Changes.$rcontent[0].Source).toBe('01');
    expect(frame1.Changes.$rcontent[0].Dest).toBe('19');
    expect(parsed.Timeline.$rcontent[1].Changes.$rcontent[0].Source).toBe('19');
  });

  it('drops a frame whose changes all reference dead runways', () => {
    const out = _pruneRunwayTimelineReferences(
      fullBlock(['01'], [[['04', '22']], [['01', '19']]]),
      new Set(['01', '19'])
    );
    const parsed = JSON.parse('{' + out + '}').RunwayTimeline;
    expect(parsed.Timeline.$rlength).toBe(1);
    expect(parsed.Timeline.$rcontent[0].Time).toBe('19:30:00');
  });
});

// A realistic RunwayTimeline section with an InitialRunways list and frames of
// change entries (matches the GATCARC4-decoded ZSJN structure).
function fullBlock(initial, frames) {
  const irInner = initial.map((n) => '"' + n + '"').join(', ');
  const frameText = frames.map((changes, fi) => {
    const chInner = changes.map((c, ci) => '{"$id": ' + (100 + fi * 10 + ci) + ', "$type": "14|ContextCross.States.RunwayChange, GroundATC.Core", "Source": "' + c[0] + '", "Dest": "' + c[1] + '"}').join(', ');
    return '{"$id": ' + (60 + fi) + ', "$type": "12|ContextCross.States.RunwayChangeFrame, GroundATC.Core", "Time": "' + (18 + fi) + ':30:00", '
      + '"Changes": {"$id": ' + (70 + fi) + ', "$type": "13|ContextCross.States.RunwayChange[], GroundATC.Core", "$rlength": ' + changes.length + ', "$rcontent": [' + chInner + ']}}';
  }).join(', ');
  return '"RunwayTimeline": {\n'
    + '  "$id": 10,\n'
    + '  "$type": "9|ContextCross.States.RunwayTimelineData, GroundATC.Core",\n'
    + '  "InitialRunways": { "$id": 11, "$type": "10|System.String[], mscorlib", "$rlength": ' + initial.length + ', "$rcontent": [ ' + irInner + ' ] },\n'
    + '  "Timeline": { "$id": 12, "$type": "11|ContextCross.States.RunwayChangeFrame[], GroundATC.Core", "$rlength": ' + frames.length + ', "$rcontent": [ ' + frameText + ' ] }\n'
    + '}';
}

describe('_remapRunwayNameFields — runway change frames', () => {
  it('remaps Source/Dest (not a *Runway* field name)', () => {
    const src = '{ "Source": "01", "Dest": "19", "Runway": "01" }';
    const out = _remapRunwayNameFields(src, new Map([['01', '07']]));
    expect(out).toContain('"Source": "07"');
    expect(out).toContain('"Runway": "07"');
  });
});

describe('_ensureInitialRunwaysContain (auto-activate a new runway)', () => {
  it('adds the new runway end to an empty InitialRunways', () => {
    const out = _ensureInitialRunwaysContain(fullBlock([], []), ['36']);
    const parsed = JSON.parse('{' + out + '}').RunwayTimeline;
    expect(parsed.InitialRunways.$rcontent).toEqual(['36']);
    expect(parsed.InitialRunways.$rlength).toBe(1);
  });

  it('appends only the missing ends and keeps existing ones', () => {
    const out = _ensureInitialRunwaysContain(fullBlock(['01'], []), ['36', '01']);
    const parsed = JSON.parse('{' + out + '}').RunwayTimeline;
    expect(parsed.InitialRunways.$rcontent).toEqual(['01', '36']);
    expect(parsed.InitialRunways.$rlength).toBe(2);
  });

  it('is a no-op when every end is already present or the input is empty', () => {
    const src = fullBlock(['01', '19'], []);
    expect(_ensureInitialRunwaysContain(src, ['01'])).toBe(src);
    expect(_ensureInitialRunwaysContain(src, [])).toBe(src);
    expect(_ensureInitialRunwaysContain(src, ['   '])).toBe(src);
  });

  it('is a no-op without a RunwayTimeline section', () => {
    const src = '{ "$type": "0|Header, A" }';
    expect(_ensureInitialRunwaysContain(src, ['36'])).toBe(src);
  });
});
