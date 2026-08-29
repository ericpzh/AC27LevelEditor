/**
 * Regression test: saving a level whose checkpoint-frame scope is "lean" —
 * it declares the jetway/flight-plan/runtime types but NOT the aircraft /
 * aircraft-animator type graph — must NOT [TYPE-ASSERT] on
 * "ContextCross.Models.AircraftAnimator, GroundATC.Core".
 *
 * Root cause: `_rebuildFlightRuntimeEntities` resolved the animator type
 * EAGERLY and STRICTLY (no fallback) against the per-segment type map.  For a
 * checkpoint frame that legitimately carries only jetway + flight-plan runtime
 * entities, the animator declaration is absent (e.g. the ZSJN leisure-2
 * 16-type CheckpointFrame scope), so the strict name lookup threw and failed
 * the whole save.  The fix mirrors the v5 "allowFallback" policy already used
 * by `_buildStandaloneAircraftEntry` / `_buildActiveJetwayEntry`: a runtime-
 * adjacent canonical type missing from the scope is minted as a fresh id and
 * self-declared via the emitted full-form "$type": "N|Name".  The
 * STRICT_JETWAY_TYPES guard is untouched.
 *
 * This bit is the exact failure the user hit on save:
 *   [TYPE-ASSERT] canonical type not declared in this scope:
 *     "ContextCross.Models.AircraftAnimator, GroundATC.Core"
 *   Scope declarations (16): 0|ContextCross.Saves.SaveSystem+CheckpointFrame,
 *     GroundATC.Core, 1|ContextCross.Saves.RuntimeSnapshot, GroundATC.Core, ...
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { readAclText, RE_FRAME_SENTINEL } = require('../../src/acl/gatcarc');
const { loadFlights } = require('../../src/acl/parser');
const { buildApproachCache } = require('../../src/acl/approach');
const { _rebuildFlightRuntimeEntities, _makeJwTypeResolver, _IdMapper } = require('../../src/acl/flight_plans');

const LEVEL_DIR = path.join(__dirname, '..', 'fixtures', 'game-root', 'GroundATC_Data',
  'StreamingAssets', 'Airports', 'ZSJN', 'Levels');
const FIXTURE_ACL = path.join(LEVEL_DIR, 'ZSJN_leisure_1.acl');

if (!fs.existsSync(FIXTURE_ACL)) {
  throw new Error('fixture missing: ' + FIXTURE_ACL);
}

// The 16-type CheckpointFrame scope from the user's save-failure dump — the
// minimal scope that carries jetway + flight-plan runtime entities but not
// the aircraft/animator type graph.
const LEAN_SCOPE = new Map([
  [0, 'ContextCross.Saves.SaveSystem+CheckpointFrame, GroundATC.Core'],
  [1, 'ContextCross.Saves.RuntimeSnapshot, GroundATC.Core'],
  [3, 'System.Byte[], mscorlib'],
  [4, 'ContextCross.Models.Jetway, GroundATC.Core'],
  [5, 'R3.ReactiveProperty`1[[System.Single, mscorlib]], R3'],
  [6, 'R3.ReactiveProperty`1[[ContextCross.Aircrafts.Aircraft, GroundATC.Core]], R3'],
  [7, 'R3.ReactiveProperty`1[[System.Int32, mscorlib]], R3'],
  [15, 'ContextCross.Models.FlightPlan, GroundATC.Core'],
  [16, 'System.DateTime, mscorlib'],
  [28, 'ContextCross.Models.RadioChannel, GroundATC.Core'],
  [29, 'R3.ReactiveProperty`1[[System.Boolean, mscorlib]], R3'],
  [30, 'ContextCross.Clock.GameTimeEntity, GroundATC.Core'],
  [31, 'R3.ReactiveProperty`1[[System.DateTime, mscorlib]], R3'],
  [32, 'R3.ReactiveProperty`1[[System.UInt64, mscorlib]], R3'],
  [33, 'ContextCross.Clock.GameEventScheduleEntity, GroundATC.Core'],
  [34, 'System.Collections.Generic.List`1[[ContextCross.Events.AircraftEvent, GroundATC.Core]], mscorlib'],
]);

const ANIMATOR_NAME = 'ContextCross.Models.AircraftAnimator, GroundATC.Core';

describe('rebuild flight runtime entities on a lean checkpoint-frame scope', () => {
  // Real cache + flights from the fixture level dir — same as the app save path.
  const cache = buildApproachCache(LEVEL_DIR);
  const text = readAclText(FIXTURE_ACL);
  const { flights } = loadFlights(FIXTURE_ACL);
  const frameDocs = text.split(RE_FRAME_SENTINEL);
  const segment = frameDocs[1]; // checkpoint frame with RuntimeEntities
  const validRegs = new Set(flights.map((f) => f._Registration || f.Registration || '').filter(Boolean));

  function rebuild(scope) {
    const logs = [];
    return _rebuildFlightRuntimeEntities(
      segment, flights, 0n, validRegs,
      scope, (m) => logs.push(String(m)), new _IdMapper(), 'ZSJN',
      cache, text, 0, [],
      new Map([...validRegs].sort().map((r, i) => [r, 1000 + i])),
      null, null, null
    );
  }

  it('does NOT [TYPE-ASSERT] on a lean scope missing the animator declaration', () => {
    // Previously this threw:
    //   [TYPE-ASSERT] canonical type not declared in this scope: "ContextCross.Models.AircraftAnimator, GroundATC.Core"
    //   Scope declarations (16): ...
    let result;
    expect(() => { result = rebuild(LEAN_SCOPE); }).not.toThrow();
    expect(result.added).toBeGreaterThan(0);
    expect(result.removed).toBeGreaterThan(0);

    // The rebuilt checkpoint frame must carry the aircraft-animator entries with a
    // self-declaring FULL-FORM "$type": "N|ContextCross.Models.AircraftAnimator, GroundATC.Core"
    // (a freshly-minted id above the lean scope's max of 34), not a bare int that
    // would reference an undeclared type id.
    const animTypeRefs = [...result.text.matchAll(
      /"\$type":\s*"(\d+)\|(ContextCross\.Models\.AircraftAnimator, GroundATC\.Core)"/g
    )];
    expect(animTypeRefs.length).toBeGreaterThan(0);
    const animIds = [...new Set(animTypeRefs.map((m) => m[1]))];
    expect(animIds).toHaveLength(1);                       // one consistent id
    expect(parseInt(animIds[0], 10)).toBeGreaterThan(34); // allocated above the lean scope max

    // The rebuilt flight-plan entries use the lean scope's declared id 15
    // (resolved via fpTypeFull, not a fallback — it is present in the scope).
    expect(result.text).toMatch(/"\$type":\s*"15\|ContextCross\.Models\.FlightPlan, GroundATC\.Core"/);
  });

  it('keeps strict resolution for genuinely-unknown names (no silent minting)', () => {
    // A resolver created WITHOUT allowFallback (the default) must still assert on a
    // name that really is absent — the strict protection is not globally relaxed.
    const strict = _makeJwTypeResolver(new Map([[4, 'ContextCross.Models.Jetway, GroundATC.Core']]), true);
    expect(() => strict(ANIMATOR_NAME)).toThrowError(/\[TYPE-ASSERT\]/);
    expect(() => strict(ANIMATOR_NAME)).toThrowError(/Scope declarations/);
  });

  it('never fallback-mints STRICT_JETWAY_TYPES even with allowFallback', () => {
    const fb = _makeJwTypeResolver(
      new Map([[4, 'ContextCross.Models.Jetway, GroundATC.Core']]), true,
      { allowFallback: true }
    );
    // R3.ReactiveProperty<Int32> is in STRICT_JETWAY_TYPES — the DockingDoorIndex
    // bug class must stay strict.
    expect(() => fb('R3.ReactiveProperty`1[[System.Int32, mscorlib]], R3')).toThrowError(/\[TYPE-ASSERT\]/);
    // Nothing was minted into the supplied scope for a strict type.
    expect(fb('ContextCross.Models.Jetway, GroundATC.Core')).toBe('"4|ContextCross.Models.Jetway, GroundATC.Core"');
  });
});
