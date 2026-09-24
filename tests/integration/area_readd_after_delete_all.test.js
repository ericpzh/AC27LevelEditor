/**
 * Area re-add after delete-all — regression test for the Ground Painter save
 * failure:
 *   'Failed to encode .acl ... to GATCARC4: Type id 33 claimed by both
 *    "System.Collections.Generic.List`1[[UnityEngine.Vector3 ...]]" and
 *    "System.Collections.Generic.Dictionary`2[[System.String ...]]"'
 *
 * `_sampleAreaShapes` hardcoded fallback type ids (31/32/33) for a file with
 * no Area left to sample. Those ids are per-$blobdoc scope, so on files where
 * 33 means Dictionary<string, IStaticItem> the synthesized Area collides at
 * binary-encode time. Fallbacks must resolve against the file's own type
 * table first, allocating a fresh id above the scope max for names the file
 * never declares.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { decodeArchive, encodeArchive } from '../../src/acl/gatcarc';
import { buildSceneryGraph } from '../../src/acl/scenery_graph';
import { patchSceneryBlob } from '../../src/acl/scenery_write';
import { _parseAreas } from '../../src/acl/scenery';
import { levelPath, gameLevelExists } from '../helpers/gameRoot';

const LEVEL = levelPath('ZSJN', 'ZSJN_test.acl');
// Real-game fixture: skipped (rather than failing) where the game is not installed.
const describeWithLevel = gameLevelExists('ZSJN', 'ZSJN_test.acl') ? describe : describe.skip;

describeWithLevel('Area delete-all then re-add encodes without type-id collision', () => {
  it('re-added area survives patch + binary encode + decode roundtrip', () => {
    const text = decodeArchive(readFileSync(LEVEL));
    const { graph, meta } = buildSceneryGraph(text);
    expect(graph.areas.length).toBeGreaterThan(0);
    if (!Array.isArray(meta.deletedAreaIds)) meta.deletedAreaIds = [];

    // Step 1 (user: "deleting all areas then save").
    for (const id of meta.areaOrigId) if (id != null && !meta.deletedAreaIds.includes(id)) meta.deletedAreaIds.push(id);
    graph.areas = []; meta.areaOrigId = [];
    const noAreas = patchSceneryBlob(text, graph, null, meta, { warnings: [] });
    expect(buildSceneryGraph(noAreas).graph.areas.length).toBe(0);
    expect(() => encodeArchive(noAreas)).not.toThrow();

    // Step 2 (user: "then add new area" → used to throw "Type id 33 claimed
    // by both ...").
    const s2 = buildSceneryGraph(noAreas);
    const pts = [{ x: 5000, z: 5000 }, { x: 5100, z: 5000 }, { x: 5100, z: 5100 }, { x: 5000, z: 5100 }];
    s2.graph.areas.push({ areaType: 2, points: pts, owner: null });
    s2.meta.areaOrigId.push(null);
    const reAdded = patchSceneryBlob(noAreas, s2.graph, null, s2.meta, { warnings: [] });
    expect(buildSceneryGraph(reAdded).graph.areas.length).toBe(1);
    let buf;
    expect(() => { buf = encodeArchive(reAdded); }).not.toThrow();
    // Full binary roundtrip: the area persists with its vertices and type.
    const rt = buildSceneryGraph(decodeArchive(buf));
    expect(rt.graph.areas.length).toBe(1);
    expect(rt.graph.areas[0].areaType).toBe(2);
    expect(rt.graph.areas[0].points.map((p) => [p.x, p.z])).toEqual(pts.map((p) => [p.x, p.z]));
  });

  it('a file whose areas were saved after delete-all is still readable (bare $type refs)', () => {
    // The synthesized Area introduces a FRESH type id above the scope max on the
    // first entry only; sibling entries reference it bare (`"$type": 41`), which
    // carries no name. Both readers must resolve the bare id through the blobdoc
    // type table, or the saved areas are invisible to the editor while the game
    // (which resolves ids from the registry) sees them just fine.
    const text = decodeArchive(readFileSync(LEVEL));
    const { graph, meta } = buildSceneryGraph(text);
    if (!Array.isArray(meta.deletedAreaIds)) meta.deletedAreaIds = [];
    for (const id of meta.areaOrigId) if (id != null && !meta.deletedAreaIds.includes(id)) meta.deletedAreaIds.push(id);
    graph.areas = []; meta.areaOrigId = [];
    const noAreas = patchSceneryBlob(text, graph, null, meta, { warnings: [] });

    // Add two areas: the first introduces the registration, the second uses the
    // bare reference form — the exact shape produced by a delete-all + re-add.
    const s2 = buildSceneryGraph(noAreas);
    const mk = (ox) => [{ x: ox, z: 6000 }, { x: ox + 100, z: 6000 }, { x: ox + 100, z: 6100 }, { x: ox, z: 6100 }];
    s2.graph.areas.push({ areaType: 2, points: mk(6000), owner: null });
    s2.meta.areaOrigId.push(null);
    s2.graph.areas.push({ areaType: 1, points: mk(7000), owner: null });
    s2.meta.areaOrigId.push(null);
    const reAdded = patchSceneryBlob(noAreas, s2.graph, null, s2.meta, { warnings: [] });
    // The second area serializes a BARE numeric $type (Odin's reference form):
    // assert the shape actually occurred, since that is what both readers used
    // to miss.
    expect(/"\$type":\s*41\b/.test(reAdded)).toBe(true);

    // Reader 1: the Ground Painter graph.
    expect(buildSceneryGraph(reAdded).graph.areas.length).toBe(2);
    // Reader 2: the live-scenery areaData builder (grouped by AreaType).
    const grouped = _parseAreas(reAdded);
    expect((grouped[2] || []).length).toBe(1);
    expect((grouped[1] || []).length).toBe(1);
  });
});
