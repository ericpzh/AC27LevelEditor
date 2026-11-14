/**
 * Focused GATCARC4 v3 Pushback Path & Stand Navigation Regression Suite.
 *
 * Covers `plan-v3-pushback-path.md` Sections 1–3:
 *   1. Pristine `ZSJN_leisure_2.acl` passes full pushback graph & navigation validation.
 *   2. Minimal geometry replays on Stand `3` (`taxi-navigation:pushback:50002:10060`):
 *      - Fuzzed Stand `3` replay fails with stand identifier, pushback PK, and turn-angle reason
 *        even though the normalized v3 wire schema and `$ref`/`pk:` references are 100% valid,
 *        while leaving `handle.container.staticData` completely unmutated on rejection.
 *      - Individual moves of nose (`10662`), tail (`10072`), and first path node (`10071`) each
 *        reproduce the failure independently.
 *   3. Multi-option Stand `28` (`50027:50252` & `50027:50254`) and alternate-path preservation:
 *      - Fuzzed `50252` replay fails specifically on `taxi-navigation:pushback:50027:50252`
 *        while `50027:50254` remains valid.
 *      - Angling `1222:0` (`10772`) > 120° while keeping `1228:0` intact still passes BOTH
 *        `50027:50252` and `50027:50254` via the valid alternate `1228:0` corridor.
 *   4. Independent failure clearance: when both Stand `3` and Stand `28` are broken, restoring
 *      Stand `3` clears only `50002:10060`, restoring Stand `28` clears only `50027:50252`, and
 *      restoring both allows `applyEdits` + `saveToFile` to succeed cleanly.
 *   5. Directed segment orientation (`1010:0` opposing one-way pushback fails) and rigid
 *      translation of Stand `3` + its local pushback path (passes and updates Q32.32 nav points).
 *   6. Nearby `StandInternal` segment edit that hijacks `TryProject` start snapping without
 *      moving Stand `3`'s own nodes is detected as an affected stand and rejected.
 *   7. Ground Painter save-path (`saveV3GroundPainterData` + `GroundPainter` UI store flow):
 *      - Rejected save leaves `.acl`, existing `.acl.bak`, `.csv`, `.acl.bg.json`, and
 *        `geo_data.osm` byte-for-byte untouched on disk.
 *      - Preserves in-memory `groundPainterGraph` / `groundPainterMeta` edits and surfaces
 *        stand identifier, pushback PK, and reason; repairing geometry and retrying succeeds.
 */

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { I18nProvider } from '../../src/hooks/useTranslation';
import { setLang } from '../../src/utils/i18n';
import { useAppStore } from '../../src/store/appStore';
import GroundPainter from '../../src/components/EditorScreen/GroundPainter/GroundPainter';
import Modal from '../../src/components/common/Modal';

const require = createRequire(import.meta.url);
const { FIXTURES_GAME_ROOT_V3, stageV3AudioIntoRoot } = require('../helpers/gameRoot.cjs');
const { openAcl, openAclFile } = require('../../src/acl/archive');
const { getSchemaForHash } = require('../../src/acl/v3/schema_registry');
const { validateV3Container, validateDocument } = require('../../src/acl/v3/validator');
const {
  dictGet,
  indexDocumentGraph,
  resolveGraphNode,
  unwrapReactive,
  normalizeDocumentGraph,
} = require('../../src/acl/v3/graph');
const { decodePosition3ToGu, encodeGuToPosition3 } = require('../../src/acl/v3/q32');
const {
  PushbackValidationError,
  validateV3PushbackPaths,
  collectPushbackValidationIssues,
} = require('../../src/acl/v3/pushback_validation');
const { saveV3GroundPainterData } = require('../../src/acl/v3/ground_painter_save');

const ZSJN_V3_LEVELS = path.join(
  FIXTURES_GAME_ROOT_V3,
  'GroundATC_Data',
  'StreamingAssets',
  'Airports',
  'ZSJN',
  'Levels',
);
const PRISTINE_LEISURE_2 = path.join(ZSJN_V3_LEVELS, 'ZSJN_leisure_2.acl');

const tmpDirs = [];
function makeTmpDir(prefix = 'ac27-v3-pb-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function sha256File(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

function cloneGraphMeta(snap) {
  return {
    graph: JSON.parse(JSON.stringify(snap.graph)),
    meta: JSON.parse(JSON.stringify(snap.meta)),
  };
}

function findNodeIdxByPk(meta, pk) {
  const idx = meta.nodeOrigPk.indexOf(pk);
  if (idx < 0) throw new Error(`Missing expected node PK in sceneryMeta: ${pk}`);
  return idx;
}

function setNodeGu(graph, meta, pk, x, z) {
  const idx = findNodeIdxByPk(meta, pk);
  graph.nodes[idx] = { ...graph.nodes[idx], x, z };
  return idx;
}

/**
 * Minimal replay of the fuzzed Stand `3` failure on `ZSJN_leisure_2.acl`:
 * Nose `10662` and Tail `10072` flipped relative to directed pushback chain `1010:0` (`171.6° > 120°`).
 */
function applyStand3BrokenEdit(graph, meta) {
  setNodeGu(graph, meta, 'taxiway-node:10662', -5.574038, -11.450988);
  setNodeGu(graph, meta, 'taxiway-node:10072', -5.788056, -11.139088);
  setNodeGu(graph, meta, 'taxiway-node:10060', -5.819972, -12.171048);
}

/**
 * Minimal 2-node replay on multi-option Stand `28` (`ZSJN_leisure_2.acl`):
 * Pushback limit `50252` and adjacent `50250` on `1424:5` angled into a >120° hairpin from both
 * `10798` (`1228:0` / `1424:4`) and `13951`, breaking `taxi-navigation:pushback:50027:50252`
 * while `taxi-navigation:pushback:50027:50254` remains 100% reachable!
 */
function applyStand28BrokenEdit(graph, meta) {
  setNodeGu(graph, meta, 'taxiway-node:50252', -3.50, -4.55);
  setNodeGu(graph, meta, 'taxiway-node:50250', -3.45, -4.50);
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
});

describe('GATCARC4 v3 — Pushback Path & Stand Navigation Validation', () => {
  it('passes pristine ZSJN_leisure_2.acl on full audit and no-op scenery round-trip', () => {
    const h = openAclFile(PRISTINE_LEISURE_2);
    const schema = getSchemaForHash(h.header.schemaHash);

    const res = validateV3PushbackPaths(h.container.staticData, schema);
    expect(res.ok).toBe(true);
    expect(res.checkedStandCount).toBeGreaterThanOrEqual(52);

    const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());
    expect(() => h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta })).not.toThrow();
    validateV3Container(h.container);
  });

  it('rejects minimal Stand 3 broken edits (fuzzed replay + nose/tail/first-leg moves) despite valid wire schema, leaving container unmutated', () => {
    // 1. Verify raw wire schema & references ARE valid when normalized directly without pushback check
    {
      const rawH = openAclFile(PRISTINE_LEISURE_2);
      const schema = getSchemaForHash(rawH.header.schemaHash);
      const stIdx = indexDocumentGraph(rawH.container.staticData, schema.roots.static, schema);
      const pkDict = resolveGraphNode(rawH.container.staticData.PKStaticEntities, stIdx);
      const nNose = resolveGraphNode(dictGet(pkDict, 'taxiway-node:10662'), stIdx);
      const nTail = resolveGraphNode(dictGet(pkDict, 'taxiway-node:10072'), stIdx);
      const navStand3 = resolveGraphNode(dictGet(pkDict, 'taxi-navigation:stand:50002'), stIdx);
      nNose.ReactivePosition.value = encodeGuToPosition3({ x: -5.574038, y: 0, z: -11.450988 });
      nTail.ReactivePosition.value = encodeGuToPosition3({ x: -5.788056, y: 0, z: -11.139088 });
      navStand3.Position = encodeGuToPosition3({ x: -5.788056, y: 0, z: -11.139088 });
      rawH.container.staticData = normalizeDocumentGraph(rawH.container.staticData, schema.roots.static, schema, stIdx);

      // Wire schema & references pass 100%
      expect(() => validateDocument(rawH.container.staticData, 'static', schema, { documentName: 'StaticData' })).not.toThrow();
      expect(() => validateV3Container(rawH.container)).not.toThrow();

      // Pushback validator catches Stand 3 & exact pushback PK
      expect(() => validateV3PushbackPaths(rawH.container.staticData, schema)).toThrow(PushbackValidationError);
    }

    // 2. Full fuzzed Stand 3 replay through applyEdits rejects AND leaves container.staticData unmutated
    {
      const h = openAclFile(PRISTINE_LEISURE_2);
      const origStaticRef = h.container.staticData;
      const origDirty = h.container.dirtyStaticData;
      const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());
      applyStand3BrokenEdit(graph, meta);

      let caught = null;
      try {
        h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PushbackValidationError);
      expect(caught.standIdentifier).toBe('3');
      expect(caught.pushbackPk).toBe('taxi-navigation:pushback:50002:10060');
      expect(caught.message).toContain('stand "3"');
      expect(caught.message).toContain('taxi-navigation:pushback:50002:10060');
      expect(caught.message).toMatch(/120°|empty pushback path/i);

      // Container was not mutated at all
      expect(h.container.staticData).toBe(origStaticRef);
      expect(h.container.dirtyStaticData).toBe(origDirty);
      const afterSnap = h.readSceneryGraph().graph;
      const origTailIdx = findNodeIdxByPk(meta, 'taxiway-node:10072');
      expect(afterSnap.nodes[origTailIdx].z).toBeCloseTo(-13.18662, 5);
    }

    // 3. Individual move of Nose only (`10662` dragged south of tail `10072`)
    {
      const h = openAclFile(PRISTINE_LEISURE_2);
      const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());
      setNodeGu(graph, meta, 'taxiway-node:10662', -5.50, -13.65);
      expect(() => h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta })).toThrow(
        /stand "3".*taxi-navigation:pushback:50002:10060/,
      );
    }

    // 4. Individual move of Tail only (`10072` dragged north of nose `10662`)
    {
      const h = openAclFile(PRISTINE_LEISURE_2);
      const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());
      setNodeGu(graph, meta, 'taxiway-node:10072', -4.85, -12.30);
      expect(() => h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta })).toThrow(
        /stand "3".*taxi-navigation:pushback:50002:10060/,
      );
    }

    // 5. Individual move of first path node (`10071` creating > 120° hairpin turn on `1010:0`)
    {
      const h = openAclFile(PRISTINE_LEISURE_2);
      const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());
      setNodeGu(graph, meta, 'taxiway-node:10071', -5.10, -13.00);
      expect(() => h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta })).toThrow(
        /stand "3".*taxi-navigation:pushback:50002:10060/,
      );
    }
  });

  it('validates multi-option Stand 28 independently and preserves valid alternate pushback paths', () => {
    // 1. Minimal Stand 28 broken edit fails ONLY option `50027:50252`, NOT `50027:50254`
    {
      const h = openAclFile(PRISTINE_LEISURE_2);
      const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());
      applyStand28BrokenEdit(graph, meta);

      let caught = null;
      try {
        h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PushbackValidationError);
      const stand28Issues = caught.issues.filter((i) => i.standIdentifier === '28');
      expect(stand28Issues.map((i) => i.pushbackPk)).toEqual([
        'taxi-navigation:pushback:50027:50252',
      ]);
    }

    // 2. Angling single corridor `1222:0` (`10772`) > 120° while `1228:0` remains intact STILL PASSES
    //    both `50027:50252` and `50027:50254` because `50027:50254` has a valid alternate path via `1228:0`!
    {
      const h = openAclFile(PRISTINE_LEISURE_2);
      const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());
      // Pristine tail `10771` is (-3.523552, -4.640209), nose `10623` is (-3.722085, -4.197222) -> reverse heading ~(+0.41, -0.91).
      // Move `10772` north-west toward nose so `10771 -> 10772` requires ~165° turn (> 120°), while `1228:0` (`10805..10798`) is untouched.
      setNodeGu(graph, meta, 'taxiway-node:10772', -3.68, -4.25);

      expect(() => h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta })).not.toThrow();
      const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
      const schema = getSchemaForHash(reopened.header.schemaHash);
      expect(() => validateV3PushbackPaths(reopened.container.staticData, schema)).not.toThrow();
    }
  });

  it('clears Stand 3 and Stand 28 errors independently when restoring geometry on a combined broken state', () => {
    const pristineH = openAclFile(PRISTINE_LEISURE_2);
    const pristineSnap = pristineH.readSceneryGraph();

    // Both Stand 3 and Stand 28 broken
    const both = cloneGraphMeta(pristineSnap);
    applyStand3BrokenEdit(both.graph, both.meta);
    applyStand28BrokenEdit(both.graph, both.meta);

    {
      const h = openAclFile(PRISTINE_LEISURE_2);
      let caught = null;
      try {
        h.applyEdits({ sceneryGraph: both.graph, sceneryMeta: both.meta });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PushbackValidationError);
      const pks = caught.issues.map((i) => i.pushbackPk);
      expect(pks).toContain('taxi-navigation:pushback:50002:10060');
      expect(pks).toContain('taxi-navigation:pushback:50027:50252');
    }

    // Restore ONLY Stand 3 -> Stand 3 disappears, Stand 28 (`50027:50252`) still fails
    {
      const restore3 = cloneGraphMeta(both);
      for (const pk of ['taxiway-node:10662', 'taxiway-node:10072', 'taxiway-node:10060']) {
        const idx = findNodeIdxByPk(pristineSnap.meta, pk);
        restore3.graph.nodes[idx] = { ...pristineSnap.graph.nodes[idx] };
      }
      const h = openAclFile(PRISTINE_LEISURE_2);
      let caught = null;
      try {
        h.applyEdits({ sceneryGraph: restore3.graph, sceneryMeta: restore3.meta });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PushbackValidationError);
      const pks = caught.issues.map((i) => i.pushbackPk);
      expect(pks).not.toContain('taxi-navigation:pushback:50002:10060');
      expect(pks).toContain('taxi-navigation:pushback:50027:50252');
    }

    // Restore ONLY Stand 28 -> Stand 28 disappears, Stand 3 (`50002:10060`) still fails
    {
      const restore28 = cloneGraphMeta(both);
      for (const pk of ['taxiway-node:50252', 'taxiway-node:50250']) {
        const idx = findNodeIdxByPk(pristineSnap.meta, pk);
        restore28.graph.nodes[idx] = { ...pristineSnap.graph.nodes[idx] };
      }
      const h = openAclFile(PRISTINE_LEISURE_2);
      let caught = null;
      try {
        h.applyEdits({ sceneryGraph: restore28.graph, sceneryMeta: restore28.meta });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PushbackValidationError);
      const pks = caught.issues.map((i) => i.pushbackPk);
      expect(pks).toContain('taxi-navigation:pushback:50002:10060');
      expect(pks).not.toContain('taxi-navigation:pushback:50027:50252');

      // Now restore Stand 3 as well -> succeeds cleanly!
      for (const pk of ['taxiway-node:10662', 'taxiway-node:10072', 'taxiway-node:10060']) {
        const idx = findNodeIdxByPk(pristineSnap.meta, pk);
        restore28.graph.nodes[idx] = { ...pristineSnap.graph.nodes[idx] };
      }
      expect(() => h.applyEdits({ sceneryGraph: restore28.graph, sceneryMeta: restore28.meta })).not.toThrow();
      const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
      const schema = getSchemaForHash(reopened.header.schemaHash);
      expect(() => validateV3PushbackPaths(reopened.container.staticData, schema)).not.toThrow();
    }
  });

  it('enforces one-way Directed segment orientation and accepts rigid translation of Stand 3 + pushback corridor', () => {
    // 1. New stand with a Directed pushback segment oriented AGAINST pushback is rejected;
    //    flipping Directed=false or orienting Head from tail -> pushback limit passes.
    {
      const h = openAclFile(PRISTINE_LEISURE_2);
      const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());
      const pbNodeIdx = findNodeIdxByPk(meta, 'taxiway-node:10060');
      const basePb = graph.nodes[pbNodeIdx];

      const midIdx = graph.nodes.length;
      graph.nodes.push({ x: basePb.x - 0.30, z: basePb.z - 0.15, type: 0, flags: 0 });
      meta.nodeOrigPk.push(null);

      const tailIdx = graph.nodes.length;
      graph.nodes.push({ x: basePb.x - 0.60, z: basePb.z - 0.30, type: 0, flags: 0 });
      meta.nodeOrigPk.push(null);

      const noseIdx = graph.nodes.length;
      graph.nodes.push({ x: basePb.x - 1.10, z: basePb.z - 0.55, type: 0, flags: 0 });
      meta.nodeOrigPk.push(null);

      // Stand lane (undirected StandInternal)
      graph.segments.push({
        aIdx: noseIdx,
        bIdx: tailIdx,
        nodeIdxs: [noseIdx, tailIdx],
        name: 'PB_DIR_STAND',
        flags: 1,
        directed: false,
      });
      meta.segOrigPk.push(null);

      // Directed corridor oriented FROM pbNodeIdx -> midIdx -> tailIdx (OPPOSING pushback tailIdx -> pbNodeIdx!)
      const dirSegIdx = graph.segments.length;
      graph.segments.push({
        aIdx: pbNodeIdx,
        bIdx: tailIdx,
        nodeIdxs: [pbNodeIdx, midIdx, tailIdx],
        name: 'PB_DIR_OPPOSED',
        flags: 1,
        directed: true,
      });
      meta.segOrigPk.push(null);

      graph.stands.push({
        identifier: 'D99',
        name: 'D99',
        noseIdx,
        tailIdx,
        parkingType: 2,
        egressType: 0,
        pushbackIdxs: [pbNodeIdx],
      });
      meta.standOrigPk.push(null);

      expect(() => h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta })).toThrow(
        /stand "D99".*taxi-navigation:pushback:D99:10060/,
      );

      // Orienting the directed corridor FROM tailIdx -> midIdx -> pbNodeIdx (matching pushback) succeeds!
      graph.segments[dirSegIdx] = {
        ...graph.segments[dirSegIdx],
        aIdx: tailIdx,
        bIdx: pbNodeIdx,
        nodeIdxs: [tailIdx, midIdx, pbNodeIdx],
      };
      expect(() => h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta })).not.toThrow();
    }

    // 2. Rigid translation of Stand 3 + its local pushback path (`10662`, `10072..10060`, `13172..13162`, `50216`)
    {
      const h = openAclFile(PRISTINE_LEISURE_2);
      const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());
      const dx = 0.25;
      const dz = -0.35;
      const localStand3Cluster = [
        'taxiway-node:10662',
        'taxiway-node:10072',
        'taxiway-node:10071',
        'taxiway-node:10070',
        'taxiway-node:10069',
        'taxiway-node:10068',
        'taxiway-node:10067',
        'taxiway-node:10066',
        'taxiway-node:10065',
        'taxiway-node:10064',
        'taxiway-node:10063',
        'taxiway-node:10062',
        'taxiway-node:10061',
        'taxiway-node:10060',
        'taxiway-node:13172',
        'taxiway-node:13171',
        'taxiway-node:13169',
        'taxiway-node:13168',
        'taxiway-node:13167',
        'taxiway-node:13166',
        'taxiway-node:13165',
        'taxiway-node:13164',
        'taxiway-node:13163',
        'taxiway-node:13162',
        'taxiway-node:50216',
      ];
      const expectedTail = {
        x: graph.nodes[findNodeIdxByPk(meta, 'taxiway-node:10072')].x + dx,
        z: graph.nodes[findNodeIdxByPk(meta, 'taxiway-node:10072')].z + dz,
      };
      const expectedPb = {
        x: graph.nodes[findNodeIdxByPk(meta, 'taxiway-node:10060')].x + dx,
        z: graph.nodes[findNodeIdxByPk(meta, 'taxiway-node:10060')].z + dz,
      };
      for (const pk of localStand3Cluster) {
        const idx = findNodeIdxByPk(meta, pk);
        graph.nodes[idx] = {
          ...graph.nodes[idx],
          x: graph.nodes[idx].x + dx,
          z: graph.nodes[idx].z + dz,
        };
      }

      expect(() => h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta })).not.toThrow();
      const reopened = openAcl(h.toBuffer(), { validateOnOpen: true });
      const schema = getSchemaForHash(reopened.header.schemaHash);
      expect(() => validateV3PushbackPaths(reopened.container.staticData, schema)).not.toThrow();

      // Companion FixedTaxiNavigationPoints stayed synchronized with translated Tail & PushbackLimit
      const stIdx = indexDocumentGraph(reopened.container.staticData, schema.roots.static, schema);
      const pkDict = resolveGraphNode(reopened.container.staticData.PKStaticEntities, stIdx);
      const navStand = decodePosition3ToGu(resolveGraphNode(dictGet(pkDict, 'taxi-navigation:stand:50002'), stIdx).Position);
      const navPb = decodePosition3ToGu(resolveGraphNode(dictGet(pkDict, 'taxi-navigation:pushback:50002:10060'), stIdx).Position);
      expect(navStand.x).toBeCloseTo(expectedTail.x, 6);
      expect(navStand.z).toBeCloseTo(expectedTail.z, 6);
      expect(navPb.x).toBeCloseTo(expectedPb.x, 6);
      expect(navPb.z).toBeCloseTo(expectedPb.z, 6);
    }
  });

  it('rejects a nearby StandInternal segment edit that hijacks TryProject snapping without moving Stand 3 nodes', () => {
    const h = openAclFile(PRISTINE_LEISURE_2);
    const { graph, meta } = cloneGraphMeta(h.readSceneryGraph());

    const noseNode = graph.nodes[findNodeIdxByPk(meta, 'taxiway-node:10662')];
    const tailNode = graph.nodes[findNodeIdxByPk(meta, 'taxiway-node:10072')];
    const sdx = noseNode.x - tailNode.x;
    const sdz = noseNode.z - tailNode.z;
    const sLen = Math.hypot(sdx, sdz);
    const acX = noseNode.x - (sdx / sLen) * 0.1232;
    const acZ = noseNode.z - (sdz / sLen) * 0.1232;

    // Place an isolated perpendicular StandInternal (Flags=1) dead-end segment right across acPos
    // WITHOUT touching any of Stand 3's own nodes (`10662`, `10072`, `10060`)!
    const hijackA = graph.nodes.length;
    graph.nodes.push({ x: acX - 0.05, z: acZ, type: 0, flags: 0 });
    meta.nodeOrigPk.push(null);

    const hijackB = graph.nodes.length;
    graph.nodes.push({ x: acX + 0.05, z: acZ, type: 0, flags: 0 });
    meta.nodeOrigPk.push(null);

    graph.segments.push({
      aIdx: hijackA,
      bIdx: hijackB,
      nodeIdxs: [hijackA, hijackB],
      name: 'HIJACK_SNAP',
      flags: 1, // StandInternal -> competes in TryProject(acPos, mask=1) with negative OsmId < 1173!
      directed: false,
    });
    meta.segOrigPk.push(null);

    let caught = null;
    try {
      h.applyEdits({ sceneryGraph: graph, sceneryMeta: meta });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PushbackValidationError);
    expect(caught.standIdentifier).toBe('3');
    expect(caught.pushbackPk).toBe('taxi-navigation:pushback:50002:10060');
    expect(caught.message).toContain('stand "3"');
    expect(caught.message).toContain('taxi-navigation:pushback:50002:10060');
  });

  it('rejects before writing ACL, backup, or sidecars in saveV3GroundPainterData & GroundPainter UI, preserves edits, and succeeds on retry', async () => {
    const rootDir = makeTmpDir('ac27-v3-gpsave-');
    const airportDir = path.join(rootDir, 'GroundATC_Data', 'StreamingAssets', 'Airports', 'ZSJN');
    const levelsDir = path.join(airportDir, 'Levels');
    fs.mkdirSync(levelsDir, { recursive: true });
    stageV3AudioIntoRoot(rootDir, 'ZSJN', FIXTURES_GAME_ROOT_V3);

    const aclPath = path.join(levelsDir, 'ZSJN_leisure_2.acl');
    const bakPath = `${aclPath}.bak`;
    const csvPath = path.join(levelsDir, 'flight_schedule_leisure_2.csv');
    const bgPath = `${aclPath}.bg.json`;
    const geoOsmPath = path.join(airportDir, 'geo_data.osm');

    fs.copyFileSync(PRISTINE_LEISURE_2, aclPath);
    fs.writeFileSync(bakPath, Buffer.from('PREEXISTING-BACKUP-SENTINEL-BYTES', 'utf8'));
    fs.copyFileSync(path.join(ZSJN_V3_LEVELS, 'flight_schedule_leisure_2.csv'), csvPath);
    fs.writeFileSync(bgPath, JSON.stringify({ src: 'original-bg.png', opacity: 0.5 }), 'utf8');
    fs.writeFileSync(
      geoOsmPath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="AC27Test">\n</osm>\n',
      'utf8',
    );

    const shaBefore = {
      acl: sha256File(aclPath),
      bak: sha256File(bakPath),
      csv: sha256File(csvPath),
      bg: sha256File(bgPath),
      osm: sha256File(geoOsmPath),
    };

    const initHandle = openAclFile(aclPath);
    const snapshotToken = initHandle.createPainterSnapshotToken();
    const { graph: brokenGraph, meta: brokenMeta } = cloneGraphMeta(initHandle.readSceneryGraph());
    applyStand3BrokenEdit(brokenGraph, brokenMeta);

    // 1. Direct saveV3GroundPainterData call (shared by IPC & MCP save flow) rejects before touching disk
    let saveErr = null;
    try {
      saveV3GroundPainterData({
        filePath: aclPath,
        snapshotText: snapshotToken,
        graph: brokenGraph,
        meta: brokenMeta,
        createBackup: true,
        bg: { src: 'updated-bg.png', opacity: 0.8 },
      });
    } catch (err) {
      saveErr = err;
    }
    expect(saveErr).toBeInstanceOf(PushbackValidationError);
    expect(saveErr.message).toContain('stand "3"');
    expect(saveErr.message).toContain('taxi-navigation:pushback:50002:10060');

    // Every single file on disk (target ACL, existing .bak, CSV, .bg.json, geo_data.osm) is 100% untouched!
    expect(sha256File(aclPath)).toBe(shaBefore.acl);
    expect(sha256File(bakPath)).toBe(shaBefore.bak);
    expect(sha256File(csvPath)).toBe(shaBefore.csv);
    expect(sha256File(bgPath)).toBe(shaBefore.bg);
    expect(sha256File(geoOsmPath)).toBe(shaBefore.osm);

    // 2. Exercise GroundPainter UI save() wired to real saveV3GroundPainterData:
    //    rejection surfaces banner error, preserves in-memory edits, and retry succeeds after geometry repair!
    setLang('en');
    window.electronAPI.loadGroundPainterData = vi.fn(async () => ({
      graph: brokenGraph,
      meta: brokenMeta,
      text: snapshotToken,
    }));
    window.electronAPI.saveGroundPainterData = vi.fn(async (payload) => saveV3GroundPainterData(payload));
    window.electronAPI.loadAcl = vi.fn(async () => ({ success: false }));

    useAppStore.setState({
      showGroundPainter: true,
      groundPainterGraph: null,
      groundPainterMeta: null,
      groundPainterSnapshotText: null,
      groundPainterHasEdited: false,
      groundPainterHistory: null,
      groundPainterMetaHistory: null,
      groundPainterTool: 'select',
      groundPainterSnapEnabled: true,
      currentPath: aclPath,
      modal: {
        open: false,
        title: '',
        body: null,
        actions: null,
        closeable: true,
        headerRight: null,
        showLangToggle: false,
      },
    });

    render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(GroundPainter, { vals: {} }),
        React.createElement(Modal),
      ),
    );

    await waitFor(() => expect(document.querySelector('.ground-painter svg')).toBeTruthy());
    useAppStore.setState({
      groundPainterGraph: brokenGraph,
      groundPainterMeta: brokenMeta,
      groundPainterSnapshotText: snapshotToken,
      groundPainterHasEdited: true,
    });
    await waitFor(() => {
      const saveBtn = document.querySelector('.gp-save');
      expect(saveBtn && !saveBtn.disabled).toBe(true);
    });

    // Trigger Save -> confirm backup modal
    fireEvent.click(document.querySelector('.gp-save'));
    const confirmBtn = await waitFor(() => {
      const el = document.querySelector('#modal-actions .btn-confirm');
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.click(confirmBtn);

    const errBanner = await waitFor(() => {
      const el = document.querySelector('.gp-error');
      expect(el).toBeTruthy();
      return el;
    });
    expect(errBanner.textContent).toContain('stand "3"');
    expect(errBanner.textContent).toContain('taxi-navigation:pushback:50002:10060');

    // In-memory edits remain preserved in store and disk files remain untouched
    const stAfterReject = useAppStore.getState();
    expect(stAfterReject.showGroundPainter).toBe(true);
    expect(stAfterReject.groundPainterHasEdited).toBe(true);
    expect(stAfterReject.groundPainterGraph.nodes[findNodeIdxByPk(brokenMeta, 'taxiway-node:10072')].z).toBeCloseTo(-11.139088, 5);
    expect(sha256File(aclPath)).toBe(shaBefore.acl);
    expect(sha256File(bakPath)).toBe(shaBefore.bak);

    // 3. Repair Stand 3 geometry in-memory (while also applying a valid minor translation to prove edited graph saved)
    const pristineSnap = initHandle.readSceneryGraph();
    const repairedGraph = JSON.parse(JSON.stringify(stAfterReject.groundPainterGraph));
    for (const pk of ['taxiway-node:10662', 'taxiway-node:10072', 'taxiway-node:10060']) {
      const idx = findNodeIdxByPk(brokenMeta, pk);
      repairedGraph.nodes[idx] = { ...pristineSnap.graph.nodes[idx] };
    }
    // Nudge nose by a valid +0.02 GU (+2m) along stand axis so the file genuinely changes
    const noseIdx = findNodeIdxByPk(brokenMeta, 'taxiway-node:10662');
    repairedGraph.nodes[noseIdx] = {
      ...repairedGraph.nodes[noseIdx],
      x: repairedGraph.nodes[noseIdx].x + 0.01,
      z: repairedGraph.nodes[noseIdx].z + 0.02,
    };

    useAppStore.setState({
      groundPainterGraph: repairedGraph,
      groundPainterHasEdited: true,
    });

    fireEvent.click(document.querySelector('.gp-save'));
    const confirmRetryBtn = await waitFor(() => {
      const el = document.querySelector('#modal-actions .btn-confirm');
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.click(confirmRetryBtn);

    await waitFor(() => {
      expect(useAppStore.getState().groundPainterHasEdited).toBe(false);
    });

    // Backup now holds the original pristine ACL bytes, and target ACL holds the valid repaired graph!
    expect(sha256File(bakPath)).toBe(shaBefore.acl);
    expect(sha256File(aclPath)).not.toBe(shaBefore.acl);

    const savedH = openAclFile(aclPath, { validateOnOpen: true });
    validateV3Container(savedH.container);
    const schema = getSchemaForHash(savedH.header.schemaHash);
    expect(() => validateV3PushbackPaths(savedH.container.staticData, schema)).not.toThrow();
    expect(collectPushbackValidationIssues(savedH.container.staticData, schema).issues).toEqual([]);
  });
});
