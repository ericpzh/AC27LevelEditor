/**
 * Taxi-navigation cascade on stand deletion.
 *
 * A deleted stand leaves its `taxi-navigation:pushback:*` points behind: they
 * reference LIVE taxiway nodes, so the dead-`$iref` cascade skips them — but
 * their `RelatedStand` then names a stand that no longer exists and the game
 * NREs while building the taxi-navigation/pushback graph. This reproduces the
 * ZSJN_leisure_2 ground-fuzz result (`taxi-navigation:pushback:-90116:…`
 * with `"RelatedStand": "324"` after stand 324 was deleted).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _cascadeOrphanEntries } = require('../../src/acl/scenery_write');

const declarer = '{ "$k": "taxi-navigation:stand:-1", "$v": { "$id": 10, "$type": 27, "Type": 4, "RelatedStand": "20", "CrossTaxiwayNames": { "$id": 11 } } }';
const keepPushback = '{ "$k": "taxi-navigation:pushback:-1:555", "$v": { "$id": 12, "$type": 27, "Type": 3, "Reference": $iref:100, "RelatedStand": "20" } }';
const stalePushback = '{ "$k": "taxi-navigation:pushback:-2:556", "$v": { "$id": 13, "$type": 27, "Type": 3, "Reference": $iref:101, "RelatedStand": "19" } }';
const standA = '{ "$k": "stand:20", "$v": { "$id": 20, "$type": 20, "Identifier": "20" } }';
const standB = '{ "$k": "stand:19", "$v": { "$id": 21, "$type": 20, "Identifier": "19" } }';

describe('_cascadeOrphanEntries — stale RelatedStand', () => {
  it('drops a pushback point whose RelatedStand no longer resolves (live $iref)', () => {
    const pk = [declarer, keepPushback, stalePushback, standA, standB];
    const deadIds = new Set(); // no dead ids — the pushback Reference is live
    const liveStandIdents = new Set(['20']); // stand 19 was deleted
    const { pkEntries, drop } = _cascadeOrphanEntries(pk, [], deadIds, liveStandIdents);
    const pks = pkEntries.map((e) => e.match(/"\$k"\s*:\s*"([^"]+)"/)[1]);
    expect(pks).toContain('taxi-navigation:stand:-1');   // declarer kept (shared CrossTaxiwayNames)
    expect(pks).toContain('taxi-navigation:pushback:-1:555');
    expect(pks).not.toContain('taxi-navigation:pushback:-2:556'); // RelatedStand "19" gone
    expect(drop.taxiNavigation).toBe(1);
  });

  it('keeps pushback points whose RelatedStand still exists', () => {
    const pk = [declarer, keepPushback, standA];
    const { pkEntries, drop } = _cascadeOrphanEntries(pk, [], new Set(), new Set(['20']));
    expect(pkEntries).toHaveLength(3);
    expect(drop.taxiNavigation).toBe(0);
  });

  it('renames/keeps empty RelatedStand nav points (runway/entry/exit)', () => {
    const noStand = '{ "$k": "taxi-navigation:entry:9", "$v": { "$id": 30, "$type": 27, "Type": 1, "Reference": $iref:101, "RelatedStand": "" } }';
    const { pkEntries } = _cascadeOrphanEntries([noStand], [], new Set(), new Set(['20']));
    expect(pkEntries).toHaveLength(1);
  });

  it('still drops taxi-navigation that references a deleted id', () => {
    const refDead = '{ "$k": "taxi-navigation:pushback:-3:557", "$v": { "$id": 40, "$type": 27, "Type": 3, "Reference": $iref:999, "RelatedStand": "20" } }';
    const { pkEntries, drop } = _cascadeOrphanEntries([keepPushback, refDead], [], new Set([999]), new Set(['20']));
    expect(pkEntries.map((e) => e.match(/"\$k"\s*:\s*"([^"]+)"/)[1])).toEqual(['taxi-navigation:pushback:-1:555']);
    expect(drop.taxiNavigation).toBe(1);
  });
});
