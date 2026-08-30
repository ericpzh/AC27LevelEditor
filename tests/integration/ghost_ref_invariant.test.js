/**
 * Ghost-node invariant — regression test for the Ground Painter save failure
 * `Failed to encode .acl ... invalid $iref payload "null"`.
 *
 * A node whose original PK lands in meta.deletedPks is a GHOST: it stays in
 * graph.nodes (so every other entity's index stays stable) but patchSceneryBlob
 * will not emit it. Any NEW entity (meta.segOrigPk/standOrigPk/runwayOrigPk
 * null — i.e. one the writer re-synthesizes) that still points at that index
 * serializes to "$iref:null", which the Odin JSON reader rejects and which
 * aborts the whole save.
 *
 * The fillet (rounding) tool creates exactly that state at a T junction whose
 * arms use duplicate nodes at one snap point: it ghost-deletes the O node of the
 * second picked arm and then creates the O→T leg referencing that same index.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { decodeArchive } from '../../src/acl/gatcarc';
import { buildSceneryGraph } from '../../src/acl/scenery_graph';
import { patchSceneryBlob } from '../../src/acl/scenery_write';
import { ghostNodeIndices, repairGhostRefs } from '../../src/components/EditorScreen/GroundPainter/fillet';
import { levelPath, gameLevelExists } from '../helpers/gameRoot';

const LEVEL = levelPath('ZSJN', 'ZSJN_runwaychange.acl');
// Real-game fixture: skipped (rather than failing) where the game is not installed.
const describeWithLevel = gameLevelExists('ZSJN', 'ZSJN_runwaychange.acl') ? describe : describe.skip;

function loadGraph() {
  const text = decodeArchive(readFileSync(LEVEL));
  const { graph, meta } = buildSceneryGraph(text);
  meta.deletedPks = meta.deletedPks || [];
  return { text, graph, meta };
}

const badIrefs = (t) => [...t.matchAll(/\$iref:([^\s,\}\]]*)/g)]
  .map((m) => m[1])
  .filter((v) => !/^-?\d+$/.test(v));

const countTaxiwaySegments = (t) => (t.match(/"\$k":\s*"taxiway-segment:/g) || []).length;

/** Fresh copy of the pristine level graph/meta, for baselines. */
function pristine() {
  const { graph, meta } = loadGraph();
  return [graph, meta];
}

describe('ghost-node invariant', () => {
  it('identifies nodes whose PK was deleted but which are kept for index stability', { timeout: 60000 }, () => {
    const graph = {
      nodes: [{ x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 2 }],
      segments: [], stands: [], runways: [],
    };
    const meta = { nodeOrigPk: ['taxiway-node:1', 'taxiway-node:2', null], deletedPks: ['taxiway-node:2'] };
    expect([...ghostNodeIndices(graph, meta)]).toEqual([1]);
  });
});

describeWithLevel('ghost-node invariant — against the real ZSJN level', () => {
  it('re-points a new leg from a ghost node onto its live duplicate instead of emitting $iref:null', { timeout: 60000 }, () => {
    const { text, graph, meta } = loadGraph();
    // Build the T-junction shape: two nodes at the same coordinate (the snap
    // point), one of them ghost-deleted, plus a NEW leg that references it —
    // exactly what the fillet used to commit.
    const n = graph.nodes.length;
    graph.nodes.push({ x: 0.5, z: 0.5, type: 2, flags: 0 });          // live twin
    graph.nodes.push({ x: 0.5, z: 0.5, type: 2, flags: 0 });          // ghost
    meta.nodeOrigPk.push(null, 'taxiway-node:ghost-1');
    meta.deletedPks.push('taxiway-node:ghost-1');
    const other = graph.nodes.length;
    graph.nodes.push({ x: 3.5, z: 3.5, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);

    graph.segments.push({ aIdx: n + 1, bIdx: other, nodeIdxs: [n + 1, other], flags: 2, directed: false });
    meta.segOrigPk.push(null);
    const segIdx = graph.segments.length - 1;

    // Pre-condition: a NEW entity references a ghost node — the state that
    // serializes to "$iref:null" and aborts the save. Left unrepaired it also
    // loses the leg (the writer has to drop it).
    expect([...ghostNodeIndices(graph, meta)]).toContain(n + 1);
    expect(graph.segments[segIdx].nodeIdxs).toContain(n + 1);

    // Repair: the leg must SURVIVE, re-pointed at the live twin.
    const res = repairGhostRefs(graph, meta);
    expect(res.dropped).toBe(0);
    expect(res.remapped).toBe(1);
    expect(graph.segments[segIdx].nodeIdxs).toEqual([n, other]);
    expect(graph.segments[segIdx].aIdx).toBe(n);

    // Post-condition: the save encodes cleanly AND keeps the leg (baseline + 1).
    const baseline = countTaxiwaySegments(patchSceneryBlob(text, ...pristine()));
    const patched = patchSceneryBlob(text, graph, null, meta);
    expect(badIrefs(patched)).toEqual([]);
    expect(countTaxiwaySegments(patched)).toBe(baseline + 1);
  });

  it('drops a new leg whose ghost node has no live duplicate (unrepairable)', { timeout: 60000 }, () => {
    const { text, graph, meta } = loadGraph();
    const n = graph.nodes.length;
    graph.nodes.push({ x: 7.25, z: 7.25, type: 2, flags: 0 });   // ghost, alone at its coordinate
    meta.nodeOrigPk.push('taxiway-node:ghost-2');
    meta.deletedPks.push('taxiway-node:ghost-2');
    const other = graph.nodes.length;
    graph.nodes.push({ x: 8.5, z: 8.5, type: 2, flags: 0 });
    meta.nodeOrigPk.push(null);

    graph.segments.push({ aIdx: n, bIdx: other, nodeIdxs: [n, other], flags: 2, directed: false });
    meta.segOrigPk.push(null);

    const res = repairGhostRefs(graph, meta);
    expect(res.dropped).toBe(1);
    expect(badIrefs(patchSceneryBlob(text, graph, null, meta))).toEqual([]);
  });
});

describe('ghost-node invariant — repairGhostRefs semantics', () => {
  it('never repairs a survivor entity (the writer copies those verbatim)', { timeout: 60000 }, () => {
    const graph = {
      nodes: [{ x: 0, z: 0 }, { x: 1, z: 1 }],
      segments: [{ aIdx: 0, bIdx: 1, nodeIdxs: [0, 1], flags: 2 }],
      stands: [], runways: [],
    };
    const meta = {
      nodeOrigPk: [null, 'taxiway-node:9'],
      segOrigPk: ['taxiway-segment:1:0'],
      deletedPks: ['taxiway-node:9'],
    };
    const res = repairGhostRefs(graph, meta);
    expect(res.dropped).toBe(0);
    expect(res.remapped).toBe(0);
    expect(graph.segments[0].nodeIdxs).toEqual([0, 1]);
  });
});
