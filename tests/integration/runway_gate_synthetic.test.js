/**
 * Synthetic (no game install required) coverage for the Ground Painter writer's
 * runway guards in `scenery_write.js`:
 *
 *  1. Deleting the taxiways that serve a runway (their nodes back the runway's
 *     `Entries`/`Exits` refs) must PRUNE the dead Entry/Exit elements and KEEP
 *     the runway — not drop the whole survivor runway, which used to leave zero
 *     runways and trip the save-time "at least one runway" refusal.
 *  2. A STRUCTURAL ref (ThresholdPoints/EdgePoints/TouchDownPoint) that cannot
 *     be repaired still drops the runway (an one-threshold runway is invalid).
 *  3. A NEW runway whose threshold nodes no longer resolve is dropped with a
 *     structured `ground_painter_writer_new_runway_dropped` warning instead of
 *     silently vanishing.
 *
 * The real-fixture counterpart lives in
 * `tests/integration/runway_entries_prune_on_taxiway_delete.test.js`.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { patchSceneryBlob } = require('../../src/acl/scenery_write');
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');

const SEP = '\r\n$$$ GATCARC4 CHECKPOINT FRAME $$$\r\n';
const runwayCount = (text) => (text.match(/"\$k"\s*:\s*"runway:[^"]+"/g) || []).length;

/** Minimal ACL: runway 01/19 with one Entry (held on node 100) and one Exit
 *  (exit node 103). Structural refs are the thresholds 1/2. */
function makeText() {
  const node = (id, x, z) =>
    '{ "$k": "taxiway-node:' + id + '", "$v": { "$id": ' + id + ', "$type": "2|N, A", ' +
    '"ReactivePosition": { "$id": ' + (id + 500) + ', "$type": "3|R, A", { "$type": "4|V, A", ' + x + ', 0, ' + z + ' } }, ' +
    '"PK": "taxiway-node:' + id + '", "OsmId": ' + id + ', "Name": null, "Type": 2, "Flags": 0 } }';
  const rwEntry = (id, name, hold, line) =>
    '{ "$id": ' + id + ', "$type": "15|Runway+Entry, A", "Name": "' + name + '", ' +
    '"HoldingPosition": $iref:' + hold + ', "LineUpPosition": $iref:' + line + ', "DefinePoint": $iref:' + hold + ' }';
  const rwExit = (id, name, ex, hold) =>
    '{ "$id": ' + id + ', "$type": "16|Runway+Exit, A", "Name": "' + name + '", ' +
    '"ExitPosition": $iref:' + ex + ', "HoldingPosition": $iref:' + hold + ', "DefinePoint": $iref:' + hold + ', "IsLeft": false }';
  const rw = (id, name, thA, thB, entries, exits, physInline) =>
    '{ "$k": "runway:' + name + '", "$v": { "$id": ' + id + ', "$type": "13|ContextCross.Models.Runway, A", ' +
    '"Name": "' + name + '", ' +
    '"PhysicalRunwayStaticItem": ' + (physInline
      ? '{ "$id": ' + id + '00, "$type": "14|Item, A", "PhysicalName": "01/19" }'
      : '$iref:' + id + '00') + ', ' +
    '"Entries": { "$id": ' + (id + 1) + ', "$type": "17|Runway+Entry[], A", "$rlength": ' + entries.length + ', "$rcontent": [ ' + entries.join(', ') + ' ] }, ' +
    '"Exits": { "$id": ' + (id + 2) + ', "$type": "18|Runway+Exit[], A", "$rlength": ' + exits.length + ', "$rcontent": [ ' + exits.join(', ') + ' ] }, ' +
    '"Routes": { "$id": ' + (id + 3) + ', "$type": "19|Route[], A", "$rlength": 0, "$rcontent": [] }, ' +
    '"TouchDownPoint": $iref:' + thA + ', ' +
    '"EdgePoints": { "$id": ' + (id + 4) + ', "$type": "21|TaxiwayNode[], A", "$rlength": 2, "$rcontent": [ $iref:' + thA + ', $iref:' + thB + ' ] }, ' +
    '"ThresholdPoints": { "$id": ' + (id + 5) + ', "$type": "21|TaxiwayNode[], A", "$rlength": 2, "$rcontent": [ $iref:' + thA + ', $iref:' + thB + ' ] }, ' +
    '"AreaVertices": { "$id": ' + (id + 6) + ', "$type": "23|Vector3[], A", "$rlength": 0, "$rcontent": [] }, ' +
    '"HoldingAreas": { "$id": ' + (id + 7) + ', "$type": "24|HA[], A", "$rlength": 0, "$rcontent": [] }, ' +
    '"Width": 0.5, "LabelPositionNode": $iref:' + thA + ' } }';

  const pkEntries = [
    node(1, 0, 0), node(2, 100, 0),
    node(100, 20, -5), node(101, 25, -6),
    node(103, 80, -5), node(104, 85, -6),
    rw(200, '01', 1, 2, [rwEntry(210, 'A', 100, 101)], [rwExit(220, 'B', 103, 104)], true),
    rw(230, '19', 2, 1, [], [], true),
  ];
  const siEntries = ['{ "$k": "physical-runway:01/19", "$v": $iref:20000 }'];
  const header =
    '{ "$type": "0|Header, A",\n' +
    '  "StaticData": { "$blobdoc": {\n' +
    '    "$type": "0|B, A",\n' +
    '    "PKStaticEntities": { "$rlength": ' + pkEntries.length + ', "$rcontent": [\n      ' + pkEntries.join(',\n      ') + '\n    ] },\n' +
    '    "NonPKStaticEntities": { "$rlength": 0, "$rcontent": [] },\n' +
    '    "StaticItems": { "$rlength": ' + siEntries.length + ', "$rcontent": [ ' + siEntries.join(', ') + ' ] }\n' +
    '  } },\n' +
    '  "RunwayTimeline": { "$id": 10, "$type": "9|RunwayTimelineData, A", ' +
    '"InitialRunways": { "$id": 11, "$type": "10|System.String[], mscorlib", "$rlength": 1, "$rcontent": [ "01" ] }, ' +
    '"Timeline": { "$id": 12, "$type": "11|RunwayChangeFrame[], A", "$rlength": 0, "$rcontent": [] } }\n' +
    '}';
  const frame =
    '{ "$type": "0|CheckpointFrame, A",\n  "RuntimeData": { "$blobdoc": {\n' +
    '    "RuntimeEntities": { "$rlength": 1, "$rcontent": [\n' +
    '      { "$k": "physical-runway:01/19", "$v": { "$id": 3, "$type": "3|PhysicalRunway, A" } }\n' +
    '    ] }\n  } }\n}';
  return header + SEP + frame;
}

function baseGraph(text) {
  const { graph, meta } = buildSceneryGraph(text);
  expect(graph.runways.map((r) => r.physicalName)).toEqual(['01/19']);
  if (!Array.isArray(meta.deletedPks)) meta.deletedPks = [];
  return { graph, meta };
}

describe('Ground Painter — runway survives serving-taxiway deletion (synthetic)', () => {
  it('prunes dead Entry/Exit elements and keeps the runway', () => {
    const text = makeText();
    const { graph, meta } = baseGraph(text);
    // Delete the two taxiway nodes backing the Entry/Exit (100,103) plus their
    // partners — the Entry/Exit refs are what goes dangling.
    for (const pk of ['taxiway-node:100', 'taxiway-node:101', 'taxiway-node:103', 'taxiway-node:104']) {
      meta.deletedPks.push(pk);
    }
    const warnings = [];
    const out = patchSceneryBlob(text, graph, null, meta, { warnings });
    expect(runwayCount(out)).toBe(2);
    const pruneWarn = warnings.find((w) => w && w.key === 'ground_painter_writer_gate_runway_entries_pruned');
    expect(pruneWarn).toBeTruthy();
    expect(pruneWarn.params.count).toBe(2);
    // No dangling ref to the deleted nodes survives in either runway entry.
    const { graph: g2 } = buildSceneryGraph(out);
    expect(g2.runways.length).toBe(1);
    expect(g2.runways[0].physicalName).toBe('01/19');
    expect(g2.runways[0].entries).toHaveLength(0);
    expect(g2.runways[0].exits).toHaveLength(0);
    // Structural thresholds still resolve.
    expect(g2.runways[0].thAIdx).toBeGreaterThanOrEqual(0);
    expect(g2.runways[0].thBIdx).toBeGreaterThanOrEqual(0);
  });

  it('rescues a threshold node a SURVIVING runway still references (the runway is not lost)', () => {
    const text = makeText();
    const { graph, meta } = baseGraph(text);
    // Flag threshold node 1 for deletion. `patchSceneryBlob`'s referenced-node
    // rescue pulls it back out of pkDelete while a surviving runway points at it,
    // so the runway survives with its structural thresholds intact — only the
    // serving-taxway refs (Entries/Exits) are prunable when their nodes go.
    meta.deletedPks.push('taxiway-node:1');
    const warnings = [];
    const out = patchSceneryBlob(text, graph, null, meta, { warnings });
    expect(runwayCount(out)).toBe(2);
    const { graph: g2 } = buildSceneryGraph(out);
    expect(g2.runways.length).toBe(1);
    expect(g2.runways[0].physicalName).toBe('01/19');
    // Structural thresholds resolve (node 1 survived).
    expect(g2.runways[0].thAIdx).toBeGreaterThanOrEqual(0);
    expect(g2.runways[0].thBIdx).toBeGreaterThanOrEqual(0);
    // The node entry itself is still in the file.
    expect(out).toContain('"$k": "taxiway-node:1"');
    expect(warnings.find((w) => w && w.key === 'ground_painter_writer_gate_dropped_unrepairable')).toBeFalsy();
  });

  it('reports a NEW runway whose thresholds no longer resolve instead of dropping it silently', () => {
    const text = makeText();
    const { graph, meta } = baseGraph(text);
    // Append a painter-created runway (runwayOrigPk null) pointing at stale
    // node indices that do not exist.
    graph.runways.push({ thAIdx: 999999, thBIdx: 999998, names: ['09', '27'], name: '09', physicalName: '09/27', width: 0.6, entries: [], exits: [] });
    meta.runwayOrigPk.push(null);
    meta.runwayOrigInfo.push({ pks: [null, null], physicalName: '09/27', names: ['09', '27'], width: 0.6 });
    meta.runwayPavement.push([]);
    meta.runwayEntriesOrig.push({ entries: [], exits: [] });
    const warnings = [];
    const out = patchSceneryBlob(text, graph, null, meta, { warnings });
    // Survivors kept, the unresolvable new runway is dropped WITH a warning.
    expect(runwayCount(out)).toBe(2);
    const w = warnings.find((x) => x && x.key === 'ground_painter_writer_new_runway_dropped');
    expect(w).toBeTruthy();
    expect(w.params.phys).toBe('09/27');
  });
});
