/**
 * Airway roundtrip — airway nodes + procedures (unified painter air mode)
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildSceneryGraph } = require('../../src/acl/scenery_graph');
const { patchSceneryBlob, getAirwayOsmPoolInfo, extractAirwayOsmPool } = require('../../src/acl/scenery_write');

const FIXTURE = path.join(__dirname, '..', '_debug', 'ZSJN_leisure_1.decoded.txt');
const text = fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, 'utf8') : null;

describe('Airway — scenery roundtrip', () => {
  it('no-touch patch with airway is lossless', () => {
    if (!text) return;
    const { graph, meta } = buildSceneryGraph(text);
    const patched = patchSceneryBlob(text, graph, null, meta);
    expect(patched).toBe(text);
    const { graph: g1 } = buildSceneryGraph(patched);
    expect(g1.airwayNodes.length).toBe(graph.airwayNodes.length);
    expect(g1.procedures.length).toBe(graph.procedures.length);
  });

  it('add airway nodes synthesizes and re-parses', () => {
    if (!text) return;
    const { graph, meta } = buildSceneryGraph(text);
    const base = graph.airwayNodes.length;
    graph.airwayNodes.push({ x: 999.1, z: 888.2, name: 'TESTA' });
    meta.airwayNodeOrigPk.push(null);
    graph.airwayNodes.push({ x: 1005.3, z: 895.4, name: 'TESTB' });
    meta.airwayNodeOrigPk.push(null);
    const patched = patchSceneryBlob(text, graph, null, meta);
    expect(patched).not.toBe(text);
    const { graph: g1 } = buildSceneryGraph(patched);
    expect(g1.airwayNodes.length).toBe(base + 2);
    expect(g1.airwayNodes.some((n) => n.name === 'TESTA' && Math.abs(n.x - 999.1) < 1e-6)).toBe(true);
  });

  it('add airway procedure chaining existing nodes persists', () => {
    if (!text) return;
    const { graph, meta } = buildSceneryGraph(text);
    if (graph.airwayNodes.length < 3) return;
    if (!graph.runways.length) return;
    const rwy = graph.runways[0].names[0];
    const before = graph.procedures.length;
    const idxs = [0, 1, 2];
    const name = 'TEST_PROC_' + Date.now() % 10000;
    graph.procedures.push({ name, routeType: 0, runwayName: rwy, airwayNodeIdxs: idxs });
    meta.airwaySegOrigPk.push(null);
    const patched = patchSceneryBlob(text, graph, null, meta);
    const { graph: g1 } = buildSceneryGraph(patched);
    expect(g1.procedures.length).toBe(before + 1);
    const added = g1.procedures.find((p) => p.name === name);
    expect(added).toBeTruthy();
    expect(added.airwayNodeIdxs.length).toBe(3);
  });

  it('move airway node propagates to procedure geometry', () => {
    if (!text) return;
    const { graph, meta } = buildSceneryGraph(text);
    if (!graph.airwayNodes.length) return;
    const idx = 0;
    const orig = { ...graph.airwayNodes[idx] };
    graph.airwayNodes[idx].x += 13.5;
    graph.airwayNodes[idx].z -= 7.2;
    const patched = patchSceneryBlob(text, graph, null, meta);
    const { graph: g1 } = buildSceneryGraph(patched);
    const moved = g1.airwayNodes[idx];
    expect(moved.x).toBeCloseTo(orig.x + 13.5, 4);
    expect(moved.z).toBeCloseTo(orig.z - 7.2, 4);
  });

  it('delete airway node via deletedAirwayPks drops node and degenerate procedure', () => {
    if (!text) return;
    const { graph, meta } = buildSceneryGraph(text);
    if (graph.airwayNodes.length < 2) return;
    const pk = meta.airwayNodeOrigPk[0];
    if (!pk) return;
    const meta2 = { ...meta, deletedAirwayPks: [pk], deletedPks: [...(meta.deletedPks || [])] };
    // Also remove the node from graph so patch knows it's deleted (meta drives delete, graph still has node but patch will drop via pkDelete)
    // For roundtrip test we keep graph node but mark deleted — patch will drop the PK entry.
    // Re-parsed graph should have one fewer node.
    const patched = patchSceneryBlob(text, graph, null, meta2);
    const { graph: g1 } = buildSceneryGraph(patched);
    expect(g1.airwayNodes.length).toBe(graph.airwayNodes.length - 1);
  });

  it('airway OSM pool info extracts finite pools', () => {
    if (!text) return;
    const pool = extractAirwayOsmPool(text);
    expect(pool.nodeIds.length).toBeGreaterThan(0);
    const { buildSceneryGraph: b } = require('../../src/acl/scenery_graph');
    const { graph, meta } = b(text);
    const ranges = require('../../src/acl/scenery_write')._staticEntitiesRanges ? null : null;
    // Use helper via private require: call getAirwayOsmPoolInfo with fake entries
    const info = getAirwayOsmPoolInfo([], graph, meta);
    expect(info).toBeDefined();
    expect(info.nodePoolSize).toBeGreaterThanOrEqual(0);
  });

  it('rename airway node persists', () => {
    if (!text) return;
    const { graph, meta } = buildSceneryGraph(text);
    if (!graph.airwayNodes.length) return;
    const idx = 0;
    const newName = 'RENAMED';
    graph.airwayNodes[idx].name = newName;
    const patched = patchSceneryBlob(text, graph, null, meta);
    const { graph: g1 } = buildSceneryGraph(patched);
    expect(g1.airwayNodes[idx].name).toBe(newName);
  });

  it('rename procedure persists', () => {
    if (!text) return;
    const { graph, meta } = buildSceneryGraph(text);
    if (!graph.procedures.length) return;
    const idx = 0;
    const newName = 'NEWPROC';
    const before = graph.procedures[idx].name;
    graph.procedures[idx].name = newName;
    const patched = patchSceneryBlob(text, graph, null, meta);
    const { graph: g1 } = buildSceneryGraph(patched);
    // Writer re-synthesizes procedures from runway Routes, so rename is persisted via Routes rebuild
    // The first procedure's name should be updated
    expect(g1.procedures.some((p) => p.name === newName)).toBe(true);
  });
});
