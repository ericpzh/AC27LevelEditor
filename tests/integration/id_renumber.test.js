/**
 * Regression test: $id declarations must be strictly ascending in text
 * order within each document scope (the game's JsonDataReader requirement).
 *
 * The editor's segment rebuild allocates $id values in construction order,
 * which differs from emission order: an R3.ReactiveProperty<Aircraft>
 * wrapper may get $id 1123 while its inline Aircraft value gets 1120 and
 * its shared String[] 1117; kept entries keep low ids (62, ...) declared
 * after new high ones.  The game then misbinds the DockingAircraft inline
 * value → `SetDockingTarget(null)` NullReferenceException during level
 * init (5 per session, one per docked jetway).
 *
 * The fix (src/acl/id_renumber.js) rewrites every document to a strictly
 * ascending $id stream in text order, with $blobdoc values renumbered as
 * independent documents (fresh 1..N space) and $iref references remapped
 * (including outer-document `aircraft:` stub entries that reference ids
 * declared inside a byte[] payload).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { renumberDocument, renumberAclIds, countIdDescents } =
  require('../../src/acl/id_renumber');
const { encodeArchive, decodeArchive } = require('../../src/acl/gatcarc');

/** Collect every $id declared in a scope, in text order. */
function idsOf(text) {
  const out = [];
  const re = /"\$id"\s*:\s*(-?\d+)/g;
  let m;
  while ((m = re.exec(text))) out.push(parseInt(m[1], 10));
  return out;
}

// The exact crash pattern from ZSJN_peakdeparture.acl jetway:02's
// DockedAircraft subtree: the ReactiveProperty wrapper (1123) is declared
// BEFORE its inline Aircraft value (1120) and the shared String[] (1117).
const CRASH_PATTERN = `{
    "$id": 0,
    "$type": "0|ContextCross.Saves.RuntimeSnapshot, GroundATC.Core",
    "Entries": [
        { "$k": "jetway:02", "$v": {
            "$id": 1123,
            "$type": "2|R3.ReactiveProperty\`1[[ContextCross.Aircrafts.Aircraft, GroundATC.Core]], R3",
            "Value": {
                "$id": 1120,
                "$type": "3|ContextCross.Aircrafts.Aircraft, GroundATC.Core",
                "_flightPlan": {
                    "$id": 1084,
                    "$type": "4|ContextCross.Models.FlightPlan, GroundATC.Core",
                    "Route": "$fstrref:B-29YO.route"
                },
                "AircraftSpecification": { "$id": 1117, "$type": "5" }
            }
        } }
    ]
}`;

// RuntimeSnapshot with a RuntimeData byte[] payload whose inner document
// restarts its own id table, and an outer `aircraft:` stub entry that
// $irefs an id declared INSIDE that payload (the editor's decoded form).
const DATA_LAYOUT_MISMATCH = `{
    "$id": 0,
    "$type": "0|ContextCross.Saves.RuntimeSnapshot, GroundATC.Core",
    "Counts": { "$id": 1, "$type": "6", "JetwayCount": 3 },
    "RuntimeData": {
        "$id": 62,
        "$type": "3|System.Byte[], mscorlib",
        "$blobdoc": {
            "$id": 0,
            "$type": "0|ContextCross.Saves.RuntimeData, GroundATC.Core",
            "Jets": {
                "$id": 1,
                "$type": "1|System.Collections.Generic.Dictionary\`2[[System.String, mscorlib],[ContextCross.Models.Jetway, GroundATC.Core]], mscorlib",
                "$rlength": 1,
                "$rcontent": [
                    { "$k": "jetway:04", "$v": {
                        "$id": 1197,
                        "$type": "2|R3.ReactiveProperty\`1[[ContextCross.Aircrafts.Aircraft, GroundATC.Core]], R3",
                        "Value": {
                            "$id": 1118,
                            "$type": "3",
                            "_flightPlan": { "$id": 1119, "$type": "4" }
                        }
                    } }
                ]
            }
        }
    },
    "aircraft:B-5380A": { "$k": "aircraft:B-5380A", "$v": $iref:1118 }
}`;

describe('id_renumber', () => {
  it('fixes the jetway crash pattern (wrapper id before inline value)', () => {
    const out = renumberDocument(CRASH_PATTERN);
    expect(countIdDescents(out).violations).toBe(0);
    const ids = idsOf(out);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('renumbers blobdoc contents as fresh documents and remaps cross-scope irefs', () => {
    const out = renumberDocument(DATA_LAYOUT_MISMATCH);
    expect(countIdDescents(out).violations).toBe(0);

    // blobdoc content gets a fresh 1..N namespace of its own
    const blobInner = out.slice(out.indexOf('$blobdoc'), out.indexOf('aircraft:B-5380A'));
    const blobIds = idsOf(blobInner);
    expect(blobIds).toContain(1);
    for (let i = 1; i < blobIds.length; i++) {
      expect(blobIds[i]).toBeGreaterThan(blobIds[i - 1]);
    }

    // the outer stub's $iref resolves to the blob doc's declared id
    const iref = out.match(/\$iref:(\d+)/);
    expect(iref).toBeTruthy();
    expect(blobIds).toContain(parseInt(iref[1], 10));
  });

  it('adds no ids and preserves every non-id token', () => {
    const out = renumberDocument(CRASH_PATTERN);
    const tok = (s) =>
      [...s.matchAll(/\$id"|"\$id"|\$iref:|\$fstrref:|\$type"|"\$type"|\$k"|"\$k"|\$v"|"\$v"/g)].length;
    expect(tok(out)).toBe(tok(CRASH_PATTERN));
    expect([...out.matchAll(/\$iref:/g)].length).toBe(
      [...CRASH_PATTERN.matchAll(/\$iref:/g)].length
    );
  });

  it('is idempotent (second pass changes nothing)', () => {
    const once = renumberDocument(CRASH_PATTERN);
    expect(renumberDocument(once)).toBe(once);
    const frame = 'root\r\n$$$ GATCARC4 CHECKPOINT FRAME $$$\r\n' + CRASH_PATTERN;
    const out2 = renumberAclIds(frame);
    expect(renumberAclIds(out2)).toBe(out2);
  });

  it('propagates through the GATCARC4 binary encode/decode pipeline', () => {
    const out = renumberDocument(DATA_LAYOUT_MISMATCH);
    const decoded = decodeArchive(encodeArchive(out));
    // decoded text is the writer's canonical form (ids preserved), and it
    // must stay monotonic per scope with the stub's iref still resolving
    // into the blob doc — the property the game actually requires
    expect(countIdDescents(decoded).violations).toBe(0);
    const blobDec = decoded.slice(decoded.indexOf('$blobdoc'), decoded.indexOf('aircraft:B-5380A'));
    const blobIds = idsOf(blobDec);
    const iref = decoded.match(/\$iref:(\d+)/);
    expect(iref).toBeTruthy();
    expect(blobIds).toContain(parseInt(iref[1], 10));
  });

  it('throws on a truly forward $iref (target not declared yet)', () => {
    const bad = '{ "$id": 0, "a": { "$v": $iref:99 }, "later": { "$id": 99 } }';
    expect(() => renumberDocument(bad)).toThrow(/forward \$iref:99/);
  });
});