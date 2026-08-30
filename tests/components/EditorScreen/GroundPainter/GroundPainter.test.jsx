import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../../../src/hooks/useTranslation';
import { setLang } from '../../../../src/utils/i18n';
import { mockIpcInvoke } from '../../../setup';
import { useAppStore } from '../../../../src/store/appStore';
import GroundPainter from '../../../../src/components/EditorScreen/GroundPainter/GroundPainter';

// ── Fixture: an L-shaped taxiway corner at O=(10,0) ──────────────────────
// seg0: (0,0)→(10,0)   seg1: (10,0)→(10,10)   shared node idx 1.
function mkGraph() {
  return {
    nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
    segments: [
      { aIdx: 0, bIdx: 1, nodeIdxs: [0, 1], flags: 2, directed: false },
      { aIdx: 1, bIdx: 2, nodeIdxs: [1, 2], flags: 2, directed: false },
    ],
    runways: [], areas: [], stands: [],
  };
}
function mkMeta(g) {
  return {
    nodeOrigPk: g.nodes.map((_, i) => 100 + i),
    segOrigPk: g.segments.map((_, i) => 200 + i),
    deletedPks: [],
  };
}
// The load effect re-runs whenever `vals` changes identity — keep it stable.
const VALS = {};

function seedStore(overrides = {}) {
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
    currentPath: 'C:/game/ZSPD_test.acl',
    ...overrides,
  });
}

// jsdom has no SVG CTM support: stub a deterministic identity mapping
// client(clientX,clientY) → svg(x,y) so world = { x: clientX, z: -clientY }.
function stubWorld(svg) {
  svg.createSVGPoint = () => ({
    x: 0, y: 0,
    matrixTransform() { return { x: this.x, y: this.y }; },
  });
  svg.getScreenCTM = () => ({ inverse() { return {}; } });
}

async function renderPainter() {
  const utils = render(
    <I18nProvider>
      <GroundPainter vals={VALS} />
    </I18nProvider>,
  );
  await waitFor(() => expect(document.querySelector('.ground-painter svg')).toBeTruthy());
  stubWorld(document.querySelector('.ground-painter svg'));
  return utils;
}

beforeEach(() => {
  setLang('en');
  mockIpcInvoke.mockClear();
  window.electronAPI.loadGroundPainterData = vi.fn(async () => {
    const g = mkGraph();
    return { graph: g, meta: mkMeta(g), text: '<acl/>' };
  });
});

describe('GroundPainter — mount & render', () => {
  it('smoke: shows the loading state, then the SVG canvas with taxiway polylines and the toolbar', async () => {
    seedStore();
    render(
      <I18nProvider>
        <GroundPainter vals={VALS} />
      </I18nProvider>,
    );
    // Before the async load resolves there is no viewBox — loading placeholder.
    expect(document.querySelector('.gp-empty')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.ground-painter svg')).toBeTruthy());
    // 2 graph segments → 2 taxiway polylines.
    expect(document.querySelectorAll('.ground-painter svg polyline')).toHaveLength(2);
    // Toolbar mounted with tool buttons.
    expect(document.querySelector('.ground-painter-toolbar')).toBeTruthy();
    expect(document.querySelectorAll('.ground-painter-toolbar button').length).toBeGreaterThan(3);
  });

  it('Cancel closes the painter through the store', async () => {
    seedStore();
    await renderPainter();
    fireEvent.click(screen.getByText('Cancel'));
    expect(useAppStore.getState().showGroundPainter).toBe(false);
  });
});

describe('GroundPainter — taxiway line tool', () => {
  it('two clicks commit a new segment between the clicked world points', async () => {
    seedStore({ groundPainterTool: 'taxiwayLine' });
    await renderPainter();
    const svg = document.querySelector('.ground-painter svg');
    // Clicks far from the fixture geometry so no snap interferes.
    fireEvent.mouseMove(svg, { clientX: 5, clientY: -7 });
    fireEvent.click(svg, { clientX: 5, clientY: -7 });
    fireEvent.mouseMove(svg, { clientX: 8, clientY: -9 });
    fireEvent.click(svg, { clientX: 8, clientY: -9 });

    const g = useAppStore.getState().groundPainterGraph;
    expect(g.nodes).toHaveLength(5);
    expect(g.nodes[3]).toMatchObject({ x: 5, z: 7 });
    expect(g.nodes[4]).toMatchObject({ x: 8, z: 9 });
    const seg = g.segments[g.segments.length - 1];
    expect(seg.nodeIdxs).toEqual([3, 4]);
    expect(useAppStore.getState().groundPainterHasEdited).toBe(true);
    // The pre-edit graph was pushed for depth-1 undo.
    expect(useAppStore.getState().groundPainterHistory).toBeTruthy();
  });

  it('rejects a zero-length segment with an inline error and keeps the draft', async () => {
    seedStore({ groundPainterTool: 'taxiwayLine' });
    await renderPainter();
    const svg = document.querySelector('.ground-painter svg');
    fireEvent.click(svg, { clientX: 5, clientY: -7 });
    fireEvent.click(svg, { clientX: 5, clientY: -7 });
    const err = document.querySelector('.gp-error');
    expect(err).toBeTruthy();
    expect(err.textContent).toBe('Segment needs distinct endpoints');
    // Nothing was committed; the graph is unchanged.
    const g = useAppStore.getState().groundPainterGraph;
    expect(g.nodes).toHaveLength(3);
    expect(g.segments).toHaveLength(2);
    expect(useAppStore.getState().groundPainterHasEdited).toBe(false);
  });
});

describe('GroundPainter — fillet (rounding) tool', () => {
  it('picking a curved segment shows the straight-only error', async () => {
    // Curved 3-point segment (10,0)→(10,10)→(12,13).
    const curved = {
      nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 12, z: 13 }],
      segments: [
        { aIdx: 0, bIdx: 1, nodeIdxs: [0, 1], flags: 2, directed: false },
        { aIdx: 1, bIdx: 3, nodeIdxs: [1, 2, 3], flags: 2, directed: false },
      ],
      runways: [], areas: [], stands: [],
    };
    window.electronAPI.loadGroundPainterData = vi.fn(async () => ({ graph: curved, meta: mkMeta(curved), text: '<acl/>' }));
    seedStore({ groundPainterTool: 'taxiwayCurve' });
    await renderPainter();
    const svg = document.querySelector('.ground-painter svg');
    // World (10,5) lies on the curved segment's straight first edge (dist 0).
    fireEvent.click(svg, { clientX: 10, clientY: -5 });
    const err = document.querySelector('.gp-error');
    expect(err).toBeTruthy();
    expect(err.textContent).toBe('Only straight segments can be filleted');
  });

  it('two picks on the L corner commit a fillet: legs truncated to the tangents, arc added, O ghost-deleted', async () => {
    seedStore({ groundPainterTool: 'taxiwayCurve' });
    await renderPainter();
    const svg = document.querySelector('.ground-painter svg');
    // Pick 1 near seg0 (TH=0.45 at base zoom): world (5,0.3) → client (5,-0.3).
    fireEvent.click(svg, { clientX: 5, clientY: -0.3 });
    // Pick 2 near seg1: world (10.3,5) → client (10.3,-5).
    fireEvent.click(svg, { clientX: 10.3, clientY: -5 });
    // No validation error after two valid picks; the floating panel with the
    // confirm button (title 'Save') appears. Generous timeout: parallel workers
    // can starve the event loop past RTL's 1s default.
    expect(document.querySelector('.gp-error')).toBeNull();
    const confirmBtn = await waitFor(() => screen.getByTitle('Save'), { timeout: 5000 });
    fireEvent.click(confirmBtn);

    const s = useAppStore.getState();
    const g = s.groundPainterGraph;
    // 2 originals splice out, 2 truncated legs + 1 arc in. The 90° arc at r=2
    // gets ceil(90/10)=10 steps + 2 endpoints = 11 points (fp: 9.000000000000002).
    expect(g.segments).toHaveLength(3);
    expect(g.nodes).toHaveLength(14);
    // Tangent nodes at t=r/tan(45°)=2 along each leg from O=(10,0).
    expect(g.nodes[3]).toMatchObject({ x: 8, z: 0 });
    expect(g.nodes[13].x).toBeCloseTo(10, 6);
    expect(g.nodes[13].z).toBeCloseTo(2, 6);
    const arc = g.segments.find((sg) => sg.nodeIdxs.length === 11);
    expect(arc).toBeTruthy();
    expect(arc.nodeIdxs[0]).toBe(3);
    expect(arc.nodeIdxs[10]).toBe(13);
    // Ghost bookkeeping: both segment PKs + the now-unreferenced corner node PK.
    expect([...s.groundPainterMeta.deletedPks].sort((a, b) => a - b)).toEqual([101, 200, 201]);
    expect(s.groundPainterHasEdited).toBe(true);
    expect(s.groundPainterHistory).toBeTruthy();
    // The fillet panel closed after commit (picks reset).
    expect(screen.queryByTitle('Save')).toBeNull();
  });
});
