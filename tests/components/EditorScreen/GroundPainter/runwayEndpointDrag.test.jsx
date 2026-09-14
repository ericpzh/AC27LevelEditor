/**
 * Ground Painter — runway endpoint (threshold) drag.
 *
 * Regression: in Box Select mode `pointOnMultiSelected` reports any point on a
 * runway/segment line as "on selection", so a threshold could never be grabbed
 * (the whole runway body-dragged instead). The endpoint grab must be tested
 * before the body-drag fallback, exactly like the Select tool.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../../../src/hooks/useTranslation';
import { setLang } from '../../../../src/utils/i18n';
import { mockIpcInvoke } from '../../../setup';
import { useAppStore } from '../../../../src/store/appStore';
import GroundPainter from '../../../../src/components/EditorScreen/GroundPainter/GroundPainter';

// A runway 09/27 along +x, with its pavement strips sharing the two thresholds
// (the real ZSJN shape: the threshold is an interior node of a 3-point strip).
function mkGraph() {
  return {
    nodes: [
      { x: -0.6, z: 0 }, { x: 0, z: 0 }, { x: 3, z: 0 }, { x: 7, z: 0 }, { x: 10.6, z: 0 }, { x: 10, z: 0 },
    ],
    segments: [
      { aIdx: 1, bIdx: 2, nodeIdxs: [0, 1, 2], name: '09/27', flags: 4, directed: false },
      { aIdx: 2, bIdx: 5, nodeIdxs: [2, 3, 4], name: '09/27', flags: 4, directed: false },
    ],
    runways: [{ thAIdx: 1, thBIdx: 5, names: ['09', '27'], name: '09', physicalName: '09/27', width: 0.5, entries: [], exits: [] }],
    areas: [], stands: [],
  };
}
function mkMeta(g) {
  return { nodeOrigPk: g.nodes.map((_, i) => 100 + i), segOrigPk: [200, 201], deletedPks: [], runwayOrigPk: [900], runwayPavement: [[0, 1, 2, 3, 4, 5]] };
}
const VALS = {};
function seedStore(overrides = {}) {
  useAppStore.setState({
    showGroundPainter: true, groundPainterGraph: null, groundPainterMeta: null,
    groundPainterSnapshotText: null, groundPainterHasEdited: false,
    groundPainterHistory: null, groundPainterMetaHistory: null,
    groundPainterTool: 'select', groundPainterSnapEnabled: true,
    currentPath: 'C:/game/ZSPD_test.acl', ...overrides,
  });
}
// jsdom has no SVG CTM: identity map client(clientX,clientY) → world(clientX,-clientY).
function stubWorld(svg) {
  svg.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } });
  svg.getScreenCTM = () => ({ inverse() { return {}; } });
}
async function renderPainter() {
  const utils = render(<I18nProvider><GroundPainter vals={VALS} /></I18nProvider>);
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

// Select the runway, then drag its east threshold out to x=-6.
function dragEndpoint(tool) {
  return async () => {
    seedStore({ groundPainterTool: tool });
    await renderPainter();
    const svg = document.querySelector('.ground-painter svg');
    if (tool === 'boxSelect') {
      // Box-select selects on mouseup of a (non-moved) marquee.
      fireEvent.mouseDown(svg, { clientX: 5, clientY: 0, button: 0 });
      fireEvent.mouseUp(svg, { clientX: 5, clientY: 0, button: 0 });
    } else {
      fireEvent.click(svg, { clientX: 5, clientY: 0 });
    }
    fireEvent.mouseDown(svg, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.mouseMove(svg, { clientX: -6, clientY: 0, button: 0 });
    fireEvent.mouseUp(svg, { clientX: -6, clientY: 0, button: 0 });
    return useAppStore.getState().groundPainterGraph;
  };
}

describe('GroundPainter — runway endpoint drag', () => {
  it('Select tool grabs the threshold and leaves the other end in place', async () => {
    const g = await dragEndpoint('select')();
    expect(g.nodes[1].x).toBeCloseTo(-6, 6);
    expect(g.nodes[5].x).toBeCloseTo(10, 6);
  });

  it('Box Select tool grabs the threshold instead of body-dragging the runway', async () => {
    const g = await dragEndpoint('boxSelect')();
    expect(g.nodes[1].x).toBeCloseTo(-6, 6);
    expect(g.nodes[5].x).toBeCloseTo(10, 6);
    // The coupled Flags=4 pavement strips must follow the threshold (not be left
    // behind): each strip node reprojects proportionally to the new runway length
    // (old axis 0..10, new axis -6..10 → along scale 1.6).
    expect(g.nodes[0].x).toBeCloseTo(-6.96, 6);
    expect(g.nodes[2].x).toBeCloseTo(-1.2, 6);
    expect(g.nodes[3].x).toBeCloseTo(5.2, 6);
    expect(g.nodes[4].x).toBeCloseTo(10.96, 6);
  });

  it('Box Select body-drag away from a node moves the whole runway', async () => {
    seedStore({ groundPainterTool: 'boxSelect' });
    await renderPainter();
    const svg = document.querySelector('.ground-painter svg');
    fireEvent.mouseDown(svg, { clientX: 5, clientY: 0, button: 0 });
    fireEvent.mouseUp(svg, { clientX: 5, clientY: 0, button: 0 });
    // Grab the runway body away from a threshold and the rotation handle
    // (which sits at the flat selection's top-center) and move it.
    fireEvent.mouseDown(svg, { clientX: 1.5, clientY: 0, button: 0 });
    fireEvent.mouseMove(svg, { clientX: 1.5, clientY: 6, button: 0 });
    fireEvent.mouseUp(svg, { clientX: 1.5, clientY: 6, button: 0 });
    const g = useAppStore.getState().groundPainterGraph;
    expect(g.nodes[1].x).toBeCloseTo(0, 6);
    expect(g.nodes[1].z).toBeCloseTo(-6, 6);
    expect(g.nodes[5].x).toBeCloseTo(10, 6);
    expect(g.nodes[5].z).toBeCloseTo(-6, 6);
  });

  it('tracks the cursor smoothly across collinear pavement strip nodes (no snap stutter)', async () => {
    // A far-away area inflates the map bounds so the snap radius is large enough
    // to capture; the Flags=4 pavement vertices are collinear with the runway and
    // 1 GU apart. Without excluding the runway's own pavement from the node-drag
    // snap geometry the threshold sticks to each strip vertex and then jumps
    // ("drag comes loose after some distance").
    const SCALE = 16; // client px per world unit (3px dead zone ≈ 0.19 GU)
    const snapGraph = {
      nodes: [
        { x: -0.6, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 4.6, z: 0 },
        { x: 200, z: 200 }, { x: 210, z: 200 }, { x: 210, z: 210 }, { x: 200, z: 210 },
      ],
      segments: [{ aIdx: 1, bIdx: 5, nodeIdxs: [0, 1, 2, 3, 4, 5, 6], name: '09/27', flags: 4, directed: false }],
      runways: [{ thAIdx: 1, thBIdx: 5, names: ['09', '27'], name: '09', physicalName: '09/27', width: 0.5, entries: [], exits: [] }],
      areas: [{ areaType: 2, points: [{ x: 200, z: 200 }, { x: 210, z: 200 }, { x: 210, z: 210 }, { x: 200, z: 210 }] }],
      stands: [],
    };
    const snapMeta = {
      nodeOrigPk: snapGraph.nodes.map((_, i) => 100 + i), segOrigPk: [200], deletedPks: [],
      runwayOrigPk: [900], runwayPavement: [[0, 1, 2, 3, 4, 5, 6]], areaOrigId: [null],
    };
    window.electronAPI.loadGroundPainterData = vi.fn(async () => ({ graph: snapGraph, meta: snapMeta, text: '<acl/>' }));
    seedStore();
    await renderPainter();
    const svg = document.querySelector('.ground-painter svg');
    svg.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x / SCALE, y: this.y / SCALE }; } });
    fireEvent.click(svg, { clientX: 2 * SCALE, clientY: 0 }); // select runway on its body
    fireEvent.mouseDown(svg, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.mouseMove(svg, { clientX: 0.5 * SCALE, clientY: 0, button: 0 }); // pass the 3px dead zone
    for (let x = 0.6; x <= 3.51; x += 0.1) {
      fireEvent.mouseMove(svg, { clientX: x * SCALE, clientY: 0, button: 0 });
      const n = useAppStore.getState().groundPainterGraph.nodes[1];
      expect(n.x).toBeCloseTo(x, 6);
    }
  });
});
