/**
 * Ground Painter — runway rename must carry its airway procedures with it.
 *
 * The writer rebuilds each directional runway's `Routes[]` from
 * `graph.procedures` grouped by `runwayName === <runway PK suffix>`. Renaming a
 * runway (the painter edits its end names) without remapping
 * `procedures[].runwayName` therefore orphaned every STAR/APP route on that
 * runway: the Routes list was rewritten empty, and the game threw
 * NullReferenceException in RuntimeAircraftSpawnService.SpawnFlyApproachingAircraft
 * while spawning arrivals whose STAR had just disappeared (ZSJN_runwaychange).
 *
 * The fix cascades the rename to `procedures[].runwayName` (and to the
 * directional Entries/Exits) in the UI rename and in the MCP rename_ground_object
 * tool. This test drives the writer directly — rename + procedure remap — and
 * asserts every original route survives under the new end name.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
const { patchSceneryBlob } = require('../../src/acl/scenery_write');

const FIXTURE = path.join(__dirname, '..', '_debug', 'ZSJN_leisure_1.decoded.txt');
const text = fs.readFileSync(FIXTURE, 'utf8');

const countRoutes = (t) => (t.match(/"AirwayNodes"/g) || []).length;

// Rename `graph.runways[idx]` exactly the way the painter does (end names +
// physicalName + coupled pavement strips), remap procedures the way the fixed
// callers do, then add one NEW procedure on the renamed runway — the new
// procedure is what flips the writer's `airwayRoutesDirty` flag and forces it to
// rebuild every runway's Routes (without it the stale-name route map is left
// verbatim and the bug stays hidden).
function renameAndPatch(remapProcedures) {
  const { graph, meta } = buildSceneryGraph(text);
  const idx = graph.runways.findIndex((r) => (r.names || []).includes('01'));
  expect(idx).toBeGreaterThanOrEqual(0);

  const rw = graph.runways[idx];
  const oldNames = (rw.names || []).slice();
  const names = ['32R', '3C'];
  const oldPhys = rw.physicalName || '';
  graph.runways = graph.runways.slice();
  graph.runways[idx] = { ...rw, names, name: names[0], physicalName: names.join('/') };
  graph.segments = graph.segments.map((s) => (s.name === oldPhys ? { ...s, name: names.join('/') } : s));

  if (remapProcedures) {
    graph.procedures = (graph.procedures || []).map((p) => {
      if (p.runwayName === oldNames[0] && oldNames[0] !== names[0]) return { ...p, runwayName: names[0] };
      if (p.runwayName === oldNames[1] && oldNames[1] !== names[1]) return { ...p, runwayName: names[1] };
      return p;
    });
  }
  graph.procedures = graph.procedures.slice();
  graph.procedures.push({ name: 'PROC_NEW', routeType: 0, runwayName: names[0], airwayNodeIdxs: [0, 1] });
  meta.airwaySegOrigPk = (meta.airwaySegOrigPk || []).slice();
  meta.airwaySegOrigPk.push(null);

  return { out: patchSceneryBlob(text, graph, null, meta, { warnings: [] }), oldNames, names };
}

describe('Ground Painter — runway rename keeps its airway routes', () => {
  it('the fixture ships routes (guards the test itself)', () => {
    expect(countRoutes(text)).toBe(25);
  });

  it('keeps every original route when the procedures follow the rename', () => {
    const { out, names } = renameAndPatch(true);
    // 25 original routes + the 1 new procedure.
    expect(countRoutes(out)).toBe(26);

    const { graph: reparsed } = buildSceneryGraph(out);
    const starNames = new Set(
      (buildSceneryGraph(text).graph.procedures || [])
        .filter((p) => p.routeType === 0)
        .map((p) => p.name),
    );
    expect(starNames.size).toBeGreaterThan(0);
    for (const name of starNames) {
      const hit = reparsed.procedures.find((p) => p.name === name);
      expect(hit, `STAR ${name} survived the rename`).toBeTruthy();
      expect(names).toContain(hit.runwayName);
    }
  });

  it('without the procedure remap the routes are orphaned (the ZSJN_runwaychange crash)', () => {
    // Documents WHY the cascade exists: a stale `runwayName` matches no runway,
    // so the Routes rebuild drops the lot. If the writer ever stops keying routes
    // by `runwayName`, this test (and the fix) can be simplified together.
    const { out } = renameAndPatch(false);
    expect(countRoutes(out)).toBeLessThan(5);
  });
});
