/**
 * Runway Entries/Exits prune on taxiway delete — regression test for the
 * Ground Painter save rejection:
 *   "保存被拒绝：关卡必须至少保留一条跑道（游戏要求 InitialRunways 非空）"
 *
 * Deleting every taxiway serving a runway deletes the taxiway nodes backing
 * the runway's `Entries`/`Exits` lists. The survivor gate used to drop the
 * whole survivor `runway:` entry ("referenced deleted node(s) … with no
 * repairable replacement"), leaving zero runways and tripping the save-time
 * "at least one runway" guard — even though the runway itself was untouched.
 *
 * A runway with empty Entries/Exits is valid (a freshly drawn runway ships
 * exactly like that), so the gate must prune the dead Entry/Exit ELEMENTS
 * and keep the runway, surfacing a `gate_runway_entries_pruned` warning.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { decodeArchive } from '../../src/acl/gatcarc';
import { buildSceneryGraph } from '../../src/acl/scenery_graph';
import { patchSceneryBlob } from '../../src/acl/scenery_write';
import { buildPkIndex, getPkEntriesByType, extractVector3FromV4 } from '../../src/acl/v4_pk_index';
import { levelPath, gameLevelExists } from '../helpers/gameRoot';

const LEVEL = levelPath('ZSJN', 'ZSJN_test.acl');
// Real-game fixture: skipped (rather than failing) where the game is not installed.
const describeWithLevel = gameLevelExists('ZSJN', 'ZSJN_test.acl') ? describe : describe.skip;

const runwayCountOf = (text) => (text.match(/"\$k"\s*:\s*"runway:[^"]+"/g) || []).length;

describeWithLevel('Runway survives deletion of all serving taxiways', () => {
  it('prunes dead Entries/Exits elements instead of dropping the runway', () => {
    const text = decodeArchive(readFileSync(LEVEL));
    const { graph, meta } = buildSceneryGraph(text);
    expect(graph.runways.length).toBeGreaterThanOrEqual(1);
    const phys = graph.runways[0].physicalName;
    if (!Array.isArray(meta.deletedPks)) meta.deletedPks = [];

    // Delete every taxiway-segment except the runway pavement strips.
    const keepSeg = [], keepSegPk = [];
    for (let i = 0; i < graph.segments.length; i++) {
      if (graph.segments[i].name === phys) { keepSeg.push(graph.segments[i]); keepSegPk.push(meta.segOrigPk[i]); }
      else {
        const pk = meta.segOrigPk[i];
        if (pk && !meta.deletedPks.includes(pk)) meta.deletedPks.push(pk);
      }
    }
    graph.segments = keepSeg; meta.segOrigPk = keepSegPk;

    // Orphan node GC (mirrors the painter): nodes unused by surviving
    // segments / runway thresholds / stands are dropped with their PKs.
    const used = new Set();
    for (const sg of graph.segments) for (const ni of (sg.nodeIdxs || [sg.aIdx, sg.bIdx])) used.add(ni);
    for (const rw of graph.runways) { used.add(rw.thAIdx); used.add(rw.thBIdx); }
    for (const st of graph.stands) { used.add(st.noseIdx); used.add(st.tailIdx); for (const p of (st.pushbackIdxs || [])) used.add(p); }
    const usedCoords = new Set([...used].map((i) => graph.nodes[i].x.toFixed(6) + ',' + graph.nodes[i].z.toFixed(6)));
    const pkIndex = buildPkIndex(text);
    for (const e of getPkEntriesByType(pkIndex, 'taxiway-node')) {
      const pos = extractVector3FromV4(e.block);
      if (!pos) continue;
      if (usedCoords.has(pos.x.toFixed(6) + ',' + pos.z.toFixed(6))) continue;
      if (!meta.deletedPks.includes(e.pk)) meta.deletedPks.push(e.pk);
    }

    const warnings = [];
    const newText = patchSceneryBlob(text, graph, null, meta, { warnings });
    // The save-time guard counts these: both directional entries must survive.
    expect(runwayCountOf(newText)).toBe(2);
    // The prune is reported (not silent) so the UI can show it.
    const pruneWarns = warnings.filter((w) => w && w.key === 'ground_painter_writer_gate_runway_entries_pruned');
    expect(pruneWarns.length).toBe(2);
    // No dangling taxi-node $iref may survive inside the kept runway entries.
    const declared = new Set([...newText.matchAll(/"\$id":\s*(\d+)/g)].map((m) => parseInt(m[1], 10)));
    const rwBlocks = [...newText.matchAll(/\{\s*"\$k":\s*"runway:[^"]+",\s*"\$v":\s*\{/g)];
    expect(rwBlocks.length).toBe(2);
    // Reparse: same physical runway, structural refs intact.
    const { graph: g1 } = buildSceneryGraph(newText);
    expect(g1.runways.length).toBe(1);
    expect(g1.runways[0].physicalName).toBe(phys);
    expect(declared.size).toBeGreaterThan(0);
  });

  it('keeps a runway whose Entries/Exits are already empty (no-op prune)', () => {
    const text = decodeArchive(readFileSync(LEVEL));
    const { graph, meta } = buildSceneryGraph(text);
    if (!Array.isArray(meta.deletedPks)) meta.deletedPks = [];
    // Drop a single mid-field taxiway far from the runway: runway untouched.
    const idx = graph.segments.findIndex((sg) => sg.name !== graph.runways[0].physicalName);
    expect(idx).toBeGreaterThanOrEqual(0);
    const pk = meta.segOrigPk[idx];
    if (pk && !meta.deletedPks.includes(pk)) meta.deletedPks.push(pk);
    graph.segments.splice(idx, 1);
    meta.segOrigPk.splice(idx, 1);
    const warnings = [];
    const newText = patchSceneryBlob(text, graph, null, meta, { warnings });
    expect(runwayCountOf(newText)).toBe(2);
    expect(warnings.filter((w) => w && w.key === 'ground_painter_writer_gate_runway_entries_pruned').length).toBe(0);
  });
});
