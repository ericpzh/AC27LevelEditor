/**
 * Ground Painter — physical-runway checkpoint-frame reconciliation.
 *
 * Regression test for the Unity load crash:
 *
 *   "PhysicalRunway: static item 'physical-runway:XX/YY' does not exist in
 *    CurrentLevel.StaticField.StaticItems"   (reference integrity is broken)
 *
 * When the painter deletes (or renames) a runway, `patchSceneryBlob` rebuilds
 * the header's STATIC `StaticData.$blobdoc.StaticItems`, but the GATCARC4
 * checkpoint frame's `RuntimeData.$blobdoc.RuntimeEntities` still holds a
 * `PhysicalRunway` runtime entity whose static-item key no longer exists.
 * `_reconcilePhysicalRunwayFrames` is invoked on every save path so orphaned
 * physical-runway runtime entities are dropped (and renamed entries follow the
 * static rename), keeping the runtime snapshot consistent with StaticItems.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { patchSceneryBlob, _reconcilePhysicalRunwayFrames, _physKeysFromEntries, _remapRunwayNameFields, _remapTaxiwaySegmentName } =
  require('../../src/acl/scenery_write');
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');

const SEP = '\r\n$$$ GATCARC4 CHECKPOINT FRAME $$$\r\n';

/** Minimal synthetic .acl: a single runway pair (01/19) + nodes + StaticItems,
 *  plus a checkpoint frame that snapshots a stale physical-runway runtime entity. */
function makeText() {
  const node = (id, x, z) =>
    '{ "$k": "taxiway-node:' + id + '", "$v": { "$id": ' + id + ', "$type": "2|N, A", ' +
    '"ReactivePosition": { "$id": ' + (id + 500) + ', "$type": "3|R, A", { "$type": "4|V, A", ' + x + ', 0, ' + z + ' } }, ' +
    '"PK": "taxiway-node:' + id + '", "OsmId": ' + id + ', "Name": null, "Type": 2, "Flags": 0 } }';
  const physItem = (pid) =>
    '{ "$id": ' + pid + ', "$type": "14|ContextCross.Models.PhysicalRunwayStaticItem, GroundATC.Core", "PhysicalName": "01/19" }';
  const rw = (id, name, thA, thB, itemRef, physInline) =>
    '{ "$k": "runway:' + name + '", "$v": { "$id": ' + id + ', "$type": "13|ContextCross.Models.Runway, GroundATC.Core", ' +
    '"Name": "' + name + '", "PhysicalRunwayStaticItem": ' + (physInline ? physItem(itemRef) : ('$iref:' + itemRef)) + ', ' +
    '"Entries": { "$id": 1, "$type": "15|T, A", "$rlength": 0, "$rcontent": [] }, ' +
    '"Exits": { "$id": 2, "$type": "15|T, A", "$rlength": 0, "$rcontent": [] }, ' +
    '"Routes": { "$id": 3, "$type": "15|T, A", "$rlength": 0, "$rcontent": [] }, ' +
    '"TouchDownPoint": $iref:' + thA + ', ' +
    '"EdgePoints": { "$id": 4, "$type": "15|T, A", "$rlength": 2, "$rcontent": [ $iref:' + thA + ', $iref:' + thB + ' ] }, ' +
    '"ThresholdPoints": { "$id": 5, "$type": "15|T, A", "$rlength": 2, "$rcontent": [ $iref:' + thA + ', $iref:' + thB + ' ] }, ' +
    '"AreaVertices": { "$id": 6, "$type": "15|T, A", "$rlength": 0, "$rcontent": [] }, ' +
    '"HoldingAreas": { "$id": 7, "$type": "15|T, A", "$rlength": 0, "$rcontent": [] }, ' +
    '"Width": 0.5, "LabelPositionNode": $iref:' + thA + ', ' +
    '"IsActive": { "$id": 8, "$type": "15|T, A", true } } }';
  // A taxiway-segment pavement strip named after the PHYSICAL runway (the ZSJN
  // pattern: runway 01/19 ↔ 9 strips whose Name === "01/19"). One coupled strip
  // and one unrelated strip, so we can assert the coupled one follows a rename
  // while the unrelated one is untouched. The coupled strip is a 3-node polyline
  // (threshold − intermediate − threshold) so it has a NON-threshold node to move.
  const tseg = (id, name, a, b) =>
    '{ "$k": "taxiway-segment:9000:0", "$v": { "$id": ' + id + ', "$type": "6|S, A", ' +
    '"PK": "taxiway-segment:9000:0", "Name": "' + name + '", "OsmId": 9000, ' +
    '"Nodes": { "$id": ' + (id + 1) + ', "$type": "7|N, A", { "$id": ' + (id + 2) + ', "$type": "8|L, A", "$rlength": 2, "$rcontent": [ $iref:' + a + ', $iref:' + b + ' ] } }, ' +
    '"Flags": 1, "Directed": false } }';
  // 3-node polyline variant (chain of three node $irefs).
  const tseg3 = (id, name, a, m, b) =>
    '{ "$k": "taxiway-segment:9001:0", "$v": { "$id": ' + id + ', "$type": "6|S, A", ' +
    '"PK": "taxiway-segment:9001:0", "Name": "' + name + '", "OsmId": 9001, ' +
    '"Nodes": { "$id": ' + (id + 1) + ', "$type": "7|N, A", { "$id": ' + (id + 2) + ', "$type": "8|L, A", "$rlength": 3, "$rcontent": [ $iref:' + a + ', $iref:' + m + ', $iref:' + b + ' ] } }, ' +
    '"Flags": 2, "Directed": false } }';

  const pkEntries = [
    node(100, 0, 0), node(102, 50, 0), node(101, 100, 0),
    tseg3(300, '01/19', 100, 102, 101),
    tseg(310, 'A1', 100, 101),
    rw(200, '01', 100, 101, 201, true),
    rw(202, '19', 101, 100, 201, false),
  ];
  const siEntries = ['{ "$k": "physical-runway:01/19", "$v": $iref:201 }'];
  const pkArr = '[\n      ' + pkEntries.join(',\n      ') + '\n    ]';
  const siArr = '[\n      ' + siEntries.join(',\n      ') + '\n    ]';

  const header =
    '{ "$type": "0|Header, A",\n' +
    '  "StaticData": { "$blobdoc": {\n' +
    '    "$type": "0|B, A",\n' +
    '    "PKStaticEntities": { "$rlength": ' + pkEntries.length + ', "$rcontent": ' + pkArr + ' },\n' +
    '    "NonPKStaticEntities": { "$rlength": 0, "$rcontent": [] },\n' +
    '    "StaticItems": { "$rlength": ' + siEntries.length + ', "$rcontent": ' + siArr + ' }\n' +
    '  } }\n' +
    '}';

  const frame =
    '{ "$type": "0|CheckpointFrame, A",\n' +
    '  "RuntimeData": { "$blobdoc": {\n' +
    '    "RuntimeEntities": { "$rlength": 1, "$rcontent": [\n' +
    '      { "$k": "physical-runway:01/19", "$v": { "$id": 3, "$type": "3|ContextCross.Models.PhysicalRunway, GroundATC.Core", "_latestDepartureRoll": null } }\n' +
    '    ] }\n' +
    '  } }\n' +
    '}';

  return header + SEP + frame;
}

function checkpointPhysKeys(text) {
  const cpIdx = text.indexOf('$$$ GATCARC4 CHECKPOINT FRAME $$$');
  if (cpIdx < 0) return [];
  return [...text.slice(cpIdx).matchAll(/"\$k":\s*"(physical-runway:[^"]+)"/g)].map((m) => m[1]);
}

describe('Ground Painter — physical-runway checkpoint-frame reconciliation', () => {
  it('deleting a runway drops the stale PhysicalRunway runtime entity from the checkpoint frame', () => {
    const text = makeText();
    const { graph, meta } = buildSceneryGraph(text);
    expect(graph.runways.map((r) => r.physicalName)).toEqual(['01/19']);
    expect(checkpointPhysKeys(text)).toEqual(['physical-runway:01/19']);

    // Mirror the UI delete path: splice the runway out of the graph WITHOUT
    // updating meta (the underlying editor bug that left StaticItems stale).
    const g2 = { ...graph, nodes: [...graph.nodes], segments: [...graph.segments], runways: [...graph.runways], areas: [...graph.areas], stands: [...graph.stands] };
    g2.runways.splice(0, 1);
    const out = patchSceneryBlob(text, g2, null, meta);

    // The static registry has no physical-runway left, and the checkpoint frame
    // must not retain a dangling runtime entity referencing it.
    expect(checkpointPhysKeys(out)).toEqual([]);
    // And RuntimeEntities no longer holds a PhysicalRunway runtime entity.
    expect(out).not.toMatch(/"\$k":\s*"physical-runway:01\/19"/);
  });

  it('a no-op save on a file with a stale checkpoint entity repairs it (self-heal)', () => {
    const text = makeText();
    // Pretend the static side was already changed to 04/22 (previous corrupt save),
    // while the checkpoint frame still has 01/19.
    const fixedStatic = text.replace('physical-runway:01/19', 'physical-runway:04/22');
    const { graph, meta } = buildSceneryGraph(fixedStatic);
    // Static says 04/22; checkpoint frame still carries stale 01/19.
    expect(checkpointPhysKeys(fixedStatic)).toEqual(['physical-runway:01/19']);
    const out = patchSceneryBlob(fixedStatic, graph, null, meta);
    // The graph's runway is 01/19, so the physical-runway registry is re-registered
    // to match (04/22 was an orphan from the corrupt save), and the now-valid 01/19
    // runtime entity is kept — static and runtime snapshot stay consistent.
    expect(checkpointPhysKeys(out)).toEqual(['physical-runway:01/19']);
  });

  it('adds a missing runtime PhysicalRunway entity for a registered runway (add-missing self-heal)', () => {
    const text = makeText();
    // Replace the physical-runway runtime entity so the registered runway 01/19 has
    // NO runtime snapshot in the checkpoint frame (the game expects one per static
    // physical-runway key; its absence is a silent gap).
    const stripped = text.replace(
      '{ "$k": "physical-runway:01/19", "$v": { "$id": 3, "$type": "3|ContextCross.Models.PhysicalRunway, GroundATC.Core", "_latestDepartureRoll": null } }',
      '{ "$k": "jetway:99", "$v": { "$id": 90, "$type": "4|ContextCross.Models.Jetway, GroundATC.Core", "Status": 0 } }'
    );
    const { graph, meta } = buildSceneryGraph(stripped);
    expect(checkpointPhysKeys(stripped)).toEqual([]);
    const out = patchSceneryBlob(stripped, graph, null, meta);
    // A well-formed runtime PhysicalRunway entity is synthesized for 01/19.
    expect(checkpointPhysKeys(out)).toEqual(['physical-runway:01/19']);
    expect(out).toMatch(/"\$k":\s*"physical-runway:01\/19"\s*,\s*"\$v":\s*\{\s*"\$id":\s*\d+,\s*"\$type":\s*"3\|ContextCross\.Models\.PhysicalRunway, GroundATC\.Core",\s*"_latestDepartureRoll":\s*null\s*\}/);
  });
});

describe('_reconcilePhysicalRunwayFrames', () => {
  const rt = (keys) => {
    const entry = (k) => '{ "$k": "' + k + '", "$v": { "$id": 9, "$type": "1|T, A" } }';
    const rc = '[\n      ' + keys.map(entry).join(',\n      ') + ',\n      ' + entry('jetway:1') + '\n    ]';
    const header = '{ "$type": "0|Header" }';
    const frame = '{ "$type": "0|Frame", "RuntimeData": { "$blobdoc": { "RuntimeEntities": { "$rlength": ' + (keys.length + 1) + ', "$rcontent": ' + rc + ' } } } }';
    return header + SEP + frame;
  };

  it('keeps a valid physical-runway runtime entity (no-op, byte-identical)', () => {
    const text = rt(['physical-runway:01/19']);
    const out = _reconcilePhysicalRunwayFrames(text, new Set(['physical-runway:01/19']), new Map());
    expect(out).toBe(text);
  });

  it('removes an orphaned physical-runway runtime entity but preserves non-runway entries', () => {
    const text = rt(['physical-runway:01/19']);
    const out = _reconcilePhysicalRunwayFrames(text, new Set(['physical-runway:04/22']), new Map());
    expect(checkpointPhysKeys(out)).toEqual([]);
    expect(out).toMatch(/"\$k":\s*"jetway:1"/); // jetway untouched
    const rl = out.match(/"\$rlength":\s*(\d+)/);
    expect(rl && parseInt(rl[1], 10)).toBe(1); // 2 → 1 after removing one entry
  });

  it('renames a physical-runway runtime entity to follow the static rename', () => {
    const text = rt(['physical-runway:01/19']);
    const out = _reconcilePhysicalRunwayFrames(text, new Set(['physical-runway:04/22']), new Map([['physical-runway:01/19', 'physical-runway:04/22']]));
    expect(checkpointPhysKeys(out)).toEqual(['physical-runway:04/22']);
  });

  it('is a no-op when no checkpoint frame or no physical-runway entries exist', () => {
    const text = rt([]);
    expect(_reconcilePhysicalRunwayFrames(text, new Set(), new Map())).toBe(text);
    expect(_reconcilePhysicalRunwayFrames('{ "no": "frame" }', new Set(['x']), new Map())).toBe('{ "no": "frame" }');
  });
});

describe('_physKeysFromEntries', () => {
  it('extracts physical-runway keys from entry strings', () => {
    const entries = [
      '{ "$k": "physical-runway:01/19", "$v": $iref:1 }',
      '{ "$k": "jetway:0", "$v": {} }',
      '{ "$k": "physical-runway:04/22", "$v": $iref:2 }',
    ];
    expect([..._physKeysFromEntries(entries)].sort()).toEqual(['physical-runway:01/19', 'physical-runway:04/22']);
  });
});

describe('_remapRunwayNameFields (rename cascade)', () => {
  const sample =
    '{ "InitialDeparture": { "Runway": "01", "Stand": "26" } }' +
    '\n{ "RelatedRunway": "19", "RelatedStand": "19" }' +
    '\n{ "_departureRunway": "01", "_arrivalRunway": "01", "AircraftType": "A320" }' +
    '\n{ "InitialRunways": { "$id": 7, "$type": "10|System.String[], mscorlib", "$rlength": 1, "$rcontent": [ "01" ] } }';

  it('remaps Runway, RelatedRunway, aircraft dep/arr runway and InitialRunways; leaves stands/ids untouched', () => {
    const out = _remapRunwayNameFields(sample, new Map([['01', '01C'], ['19', '19C']]));
    expect(out).toContain('"Runway": "01C"');
    expect(out).toContain('"RelatedRunway": "19C"');
    expect(out).toContain('"_departureRunway": "01C"');
    expect(out).toContain('"_arrivalRunway": "01C"');
    expect(out).toContain('"$rcontent": [ "01C" ]');
    // Non-runway references must not be touched.
    expect(out).toContain('"Stand": "26"');
    expect(out).toContain('"RelatedStand": "19"');
    expect(out).toContain('"AircraftType": "A320"');
  });

  it('is a no-op when there is no rename map', () => {
    const out = _remapRunwayNameFields(sample, new Map());
    expect(out).toBe(sample);
  });

  it('only remaps the renamed names (not other runway names)', () => {
    // Rename only "01"; "19" must stay.
    const out = _remapRunwayNameFields('{ "Runway": "19" }', new Map([['01', '01C']]));
    expect(out).toContain('"Runway": "19"');
  });

  it('ignores object-valued Runway-keyed fields (PhysicalRunwayStaticItem / RunwayTimeline)', () => {
    const text = '{ "PhysicalRunwayStaticItem": { "$id": 1 }, "RunwayTimeline": { "$id": 2 } }';
    // old name "01" as a direct string value nowhere → unchanged.
    expect(_remapRunwayNameFields(text, new Map([['01', '01C']]))).toBe(text);
  });
});

describe('runway rename cascade (integration through patchSceneryBlob)', () => {
  it('renames runway entity, physical-runway keys, and flight-plan Runway references', () => {
    const text = makeText();
    const { graph: g0, meta: m0 } = buildSceneryGraph(text);
    // Rename the single runway 01/19 → 19R/01L. Meta stays stale (mirrors the UI rename path).
    const g = { ...g0, nodes: [...g0.nodes], segments: [...g0.segments], runways: [...g0.runways], areas: [...g0.areas], stands: [...g0.stands] };
    g.runways[0] = { ...g.runways[0], names: ['19R', '01L'], name: '19R', physicalName: '19R/01L' };
    const out = patchSceneryBlob(text, g, null, m0);

    // Runway entities + physical-runway keys must follow the rename.
    expect(out).toMatch(/"\$k":\s*"runway:19R"/);
    expect(out).toMatch(/"\$k":\s*"runway:01L"/);
    expect(out).toMatch(/"\$k":\s*"physical-runway:19R\/01L"/);
    // No stale physical-runway:01/19 key may remain — the rename must not leave a
    // dangling registry key pointing at the renamed static item (that is a
    // "PhysicalRunwayStaticItem PK vs dictionary key" mismatch in-game).
    expect(out.match(/"\$k":\s*"(physical-runway:[^"]+)"/g) || []).not.toContain('"$k": "physical-runway:01/19"');
    expect(out).not.toMatch(/"\$k":\s*"physical-runway:01\/19"/);
    // The checkpoint frame must not keep a stale physical-runway runtime entity.
    expect(checkpointPhysKeys(out)).toEqual(['physical-runway:19R/01L']);
  });

  it('rewrites taxiway-segment strips named after the physical runway to follow the rename, leaving unrelated strips', () => {
    const text = makeText();
    const { graph: g0, meta: m0 } = buildSceneryGraph(text);
    const g = { ...g0, nodes: [...g0.nodes], segments: [...g0.segments], runways: [...g0.runways], areas: [...g0.areas], stands: [...g0.stands] };
    g.runways[0] = { ...g.runways[0], names: ['19R', '01L'], name: '19R', physicalName: '19R/01L' };
    const out = patchSceneryBlob(text, g, null, m0);

    // The coupled "01/19" strip (9001:0) must now carry the new physical name.
    expect(out).toMatch(/"\$k":\s*"taxiway-segment:9001:0"[\s\S]*?"Name":\s*"19R\/01L"/);
    // The unrelated strip (9000:0) must be untouched.
    expect(out).toMatch(/"\$k":\s*"taxiway-segment:9000:0"[\s\S]*?"Name":\s*"A1"/);
    // No stale "01/19" strip may remain.
    expect(out).not.toMatch(/"\$k":\s*"taxiway-segment:9001:0"[\s\S]*?"Name":\s*"01\/19"/);
  });
});

describe('_remapTaxiwaySegmentName (runway-coupled taxiway strips)', () => {
  const coupled =
    '{ "$k": "taxiway-segment:9:0", "$v": { "$id": 1, "$type": "6|S, A", "Name": "01/19", "OsmId": 9 } }';
  const standalone =
    '{ "$k": "stand:5", "$v": { "$id": 2, "$type": "9|T, A", "Name": "12" } }';

  it('remaps a taxiway strip named after the physical runway on a rename/move', () => {
    const out = _remapTaxiwaySegmentName(coupled, new Map([['01/19', '19R/01L']]), new Map());
    expect(out).toMatch(/"Name":\s*"19R\/01L"/);
    expect(out).not.toMatch(/"Name":\s*"01\/19"/);
  });

  it('ignores a taxiway named after a single end (physical-name map takes precedence; end map is exact, not substring)', () => {
    // "01/19" is not the end name "01" — an exact end-name match must not trim it.
    const out = _remapTaxiwaySegmentName(coupled, new Map(), new Map([['01', '01L']]));
    expect(out).toMatch(/"Name":\s*"01\/19"/);
    expect(out).not.toMatch(/"Name":\s*"01L"/);
  });

  it('does not touch non-taxiway-segment entries (e.g. a stand)', () => {
    expect(_remapTaxiwaySegmentName(standalone, new Map([['01/19', '19R/01L']]), new Map())).toBe(standalone);
  });

  it('is a no-op when no rename maps are provided', () => {
    expect(_remapTaxiwaySegmentName(coupled, new Map(), new Map())).toBe(coupled);
  });

  it('remaps a taxiway named after a single end via the end-name map', () => {
    const singleEnd = '{ "$k": "taxiway-segment:8:0", "$v": { "$id": 1, "$type": "6|S, A", "Name": "01", "OsmId": 8 } }';
    const out = _remapTaxiwaySegmentName(singleEnd, new Map(), new Map([['01', '01L']]));
    expect(out).toMatch(/"Name":\s*"01L"/);
  });
});

// ─── Runway ↔ collinear pavement-strip GEOMETRIC coupling ───────
// A physical runway's pavement is drawn as `taxiway-segment` strips named after
// the runway's PHYSICAL name (ZSJN: runway "01/19" ↔ 9 strips named "01/19"),
// forming a chain collinear with the runway but sharing only its 2 threshold
// nodes. The painter couples them so move/add keep the pavement with the runway.
// This covers the WRITE half (meta.runwayPavement population + patchSceneryBlob
// persisting moved strip nodes and a new runway's strip); the renderer-side
// `runwayPavement`/`reprojectOnRunwayAxis` in GroundPainter.jsx builds the graph
// that these assertions write out.
describe('Ground Painter — runway↔pavement geometric coupling', () => {
  // Mirror of GroundPainter.jsx `reprojectOnRunwayAxis`. along is scaled by
  // l1/l0 so a strip node keeps its FRACTION of the runway: a single-threshold
  // reshape (one endpoint moves, length changes) keeps the strip spanning the
  // runway instead of squishing it toward the moved end.
  const reproject = (p, a0, b0, a1, b1) => {
    const ux0 = b0.x - a0.x, uz0 = b0.z - a0.z, l0 = Math.hypot(ux0, uz0) || 1, u0x = ux0 / l0, u0z = uz0 / l0, n0x = -u0z, n0z = u0x;
    const ddx = p.x - a0.x, ddz = p.z - a0.z, along = ddx * u0x + ddz * u0z, perp = ddx * n0x + ddz * n0z;
    const ux1 = b1.x - a1.x, uz1 = b1.z - a1.z, l1 = Math.hypot(ux1, uz1) || 1, u1x = ux1 / l1, u1z = uz1 / l1, n1x = -u1z, n1z = u1x;
    const alongScaled = along * (l1 / l0);
    return { x: a1.x + alongScaled * u1x + perp * n1x, z: a1.z + alongScaled * u1z + perp * n1z };
  };
  const coupledNodeIdxs = (graph, meta, rwIdx) => meta.runwayPavement && meta.runwayPavement[rwIdx];

  it('buildSceneryGraph populates meta.runwayPavement (parallel to runways) from the strip chain', () => {
    const text = makeText();
    const { graph, meta } = buildSceneryGraph(text);
    expect(Array.isArray(meta.runwayPavement)).toBe(true);
    expect(meta.runwayPavement.length).toBe(graph.runways.length);
    // The synthetic makeText() carries one "01/19" strip (2 threshold nodes + 1 extra),
    // so the coupled chain is non-empty and captures the runway's threshold nodes.
    expect(meta.runwayPavement[0].length).toBeGreaterThanOrEqual(2);
    expect(meta.runwayPavement[0]).toContain(graph.runways[0].thAIdx);
  });

  it('moving a runway persists the reprojected (rigid-collinear) strip nodes', () => {
    const text = makeText();
    const { graph: g0, meta: m0 } = buildSceneryGraph(text);
    const rw = g0.runways[0];
    const strip = coupledNodeIdxs(g0, m0, 0);
    expect(strip.length).toBeGreaterThanOrEqual(2);

    const g = { ...g0, nodes: [...g0.nodes], segments: [...g0.segments], runways: [...g0.runways], areas: [...g0.areas], stands: [...g0.stands] };
    const a0 = { x: g0.nodes[rw.thAIdx].x, z: g0.nodes[rw.thAIdx].z };
    const b0 = { x: g0.nodes[rw.thBIdx].x, z: g0.nodes[rw.thBIdx].z };
    const dx = 2.5, dz = -1.5;
    const a1 = { x: a0.x + dx, z: a0.z + dz }, b1 = { x: b0.x + dx, z: b0.z + dz };
    g.nodes[rw.thAIdx] = { ...g.nodes[rw.thAIdx], x: a1.x, z: a1.z };
    g.nodes[rw.thBIdx] = { ...g.nodes[rw.thBIdx], x: b1.x, z: b1.z };
    for (const ni of strip) {
      if (ni === rw.thAIdx || ni === rw.thBIdx) continue;
      const p = reproject({ x: g0.nodes[ni].x, z: g0.nodes[ni].z }, a0, b0, a1, b1);
      g.nodes[ni] = { ...g.nodes[ni], x: p.x, z: p.z };
    }

    const out = patchSceneryBlob(text, g, null, m0);
    const { graph: g1 } = buildSceneryGraph(out);
    expect(g1.runways.length).toBe(1);
    // A non-threshold strip node must have moved with the (translated) runway.
    const movedNode = strip.find((ni) => ni !== rw.thAIdx && ni !== rw.thBIdx);
    expect(Math.abs(g1.nodes[movedNode].x - (g0.nodes[movedNode].x + dx)) < 1e-4).toBe(true);
    expect(Math.abs(g1.nodes[movedNode].z - (g0.nodes[movedNode].z + dz)) < 1e-4).toBe(true);
  });

  it('moving ONE runway endpoint (length change) keeps the strip spanning the new runway', () => {
    const text = makeText();
    const { graph: g0, meta: m0 } = buildSceneryGraph(text);
    const rw = g0.runways[0];
    const strip = coupledNodeIdxs(g0, m0, 0);
    // Fixture: thA at (0,0), thB at (100,0), one interior strip node at (50,0).
    const a0 = { x: g0.nodes[rw.thAIdx].x, z: g0.nodes[rw.thAIdx].z };
    const b0 = { x: g0.nodes[rw.thBIdx].x, z: g0.nodes[rw.thBIdx].z };
    expect(Math.abs(a0.x - 0) < 1e-6 && Math.abs(b0.x - 100) < 1e-6).toBe(true);

    const g = { ...g0, nodes: [...g0.nodes], segments: [...g0.segments], runways: [...g0.runways], areas: [...g0.areas], stands: [...g0.stands] };
    // Drag ONLY thA outward to (-50,0); thB stays at (100,0). New length = 150.
    const a1 = { x: -50, z: 0 }, b1 = { x: b0.x, z: b0.z };
    g.nodes[rw.thAIdx] = { ...g.nodes[rw.thAIdx], x: a1.x, z: a1.z };
    const interior = strip.filter((ni) => ni !== rw.thAIdx && ni !== rw.thBIdx);
    expect(interior.length).toBeGreaterThanOrEqual(1);
    for (const ni of interior) {
      const p = reproject({ x: g0.nodes[ni].x, z: g0.nodes[ni].z }, a0, b0, a1, b1);
      g.nodes[ni] = { ...g.nodes[ni], x: p.x, z: p.z };
    }

    const out = patchSceneryBlob(text, g, null, m0);
    const { graph: g1 } = buildSceneryGraph(out);
    const rw1 = g1.runways[0];
    const na = g1.nodes[rw1.thAIdx], nb = g1.nodes[rw1.thBIdx];
    // The strip's interior node must stay COLLINEAR with and within the new span.
    for (const ni of interior) {
      const p = g1.nodes[ni];
      const along = ((p.x - na.x) * (nb.x - na.x) + (p.z - na.z) * (nb.z - na.z)) / (Math.hypot(nb.x - na.x, nb.z - na.z) || 1);
      const projX = na.x + along * (nb.x - na.x) / (Math.hypot(nb.x - na.x, nb.z - na.z) || 1);
      const projZ = na.z + along * (nb.z - na.z) / (Math.hypot(nb.x - na.x, nb.z - na.z) || 1);
      expect(Math.hypot(p.x - projX, p.z - projZ)).toBeLessThan(1e-6); // on-axis
      // The interior node sits at the same fraction (50% here) of the runway,
      // NOT squished toward the moved end (the old rigid mapping put it at (0,0)).
      expect(Math.abs(p.x - 25) < 1e-4 && Math.abs(p.z - 0) < 1e-4).toBe(true);
    }
    expect(Math.abs(na.x - -50) < 1e-6 && Math.abs(nb.x - 100) < 1e-6).toBe(true);
  });

  it('adding a runway persists a collinear strip named after the physical runway', () => {
    const text = makeText();
    const { graph: g0, meta: m0 } = buildSceneryGraph(text);
    // commitRunway shape (simplified): new runway pair + a 4-node strip with overhang.
    const a = { x: 5, z: 5 }, b = { x: 9, z: 5 };
    const OH = 0.6, ux = 1, uz = 0;
    const phys = '36/18';
    const iOA = g0.nodes.length, iA = iOA + 1, iB = iOA + 2, iOB = iOA + 3;
    const g = { ...g0, nodes: [...g0.nodes], segments: [...g0.segments], runways: [...g0.runways], areas: [...g0.areas], stands: [...g0.stands] };
    g.nodes.push(
      { x: a.x - ux * OH, z: a.z - uz * OH, type: 2, flags: 0 },
      { x: a.x, z: a.z, type: 2, flags: 0 },
      { x: b.x, z: b.z, type: 2, flags: 0 },
      { x: b.x + ux * OH, z: b.z + uz * OH, type: 2, flags: 0 },
    );
    g.segments.push({ aIdx: iA, bIdx: iB, nodeIdxs: [iOA, iA, iB, iOB], name: phys, flags: 4, directed: false });
    g.runways.push({ thAIdx: iA, thBIdx: iB, names: ['36', '18'], name: '36', physicalName: phys, width: 0.50 });
    const mm = {
      ...m0,
      nodeOrigPk: [...m0.nodeOrigPk, null, null, null, null],
      segOrigPk: [...m0.segOrigPk, null],
      runwayOrigPk: [...m0.runwayOrigPk, null],
      runwayPavement: [...m0.runwayPavement, [iOA, iA, iB, iOB]],
      runwayOrigInfo: [...m0.runwayOrigInfo, { pks: [null, null], physicalName: phys, names: ['36', '18'], width: 0.50 }],
    };

    const out = patchSceneryBlob(text, g, null, mm);
    const { graph: g1 } = buildSceneryGraph(out);
    expect(g1.runways.length).toBe(2);
    const newRw = g1.runways.find((r) => r.physicalName === phys);
    expect(newRw).toBeTruthy();
    const strip = g1.segments.find((s) => s.name === phys);
    expect(strip).toBeTruthy();
    // The strip is collinear and passes through both new runway thresholds.
    const nodes = strip.nodeIdxs.map((ni) => g1.nodes[ni]);
    expect(nodes.every((p) => Math.abs(p.z - 5) < 1e-6)).toBe(true);
    const thA = nodes.find((p) => Math.abs(p.x - newRw.thAIdx) >= 0 && Math.abs(p.x - g1.nodes[newRw.thAIdx].x) < 1e-6);
    expect(thA).toBeTruthy();
  });
});
