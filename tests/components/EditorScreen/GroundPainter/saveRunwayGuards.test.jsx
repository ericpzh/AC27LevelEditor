/**
 * GroundPainter `save()` pre-flight guards (renderer side).
 *
 * Two rejections that must happen BEFORE the IPC call so the user gets the
 * actionable inline error instead of a raw `Error invoking remote method`:
 *
 *  1. The two ends of one physical runway cannot share a name (27/27) — the
 *     writer would emit two `runway:27` entries and the game rejects the level.
 *  2. After the pre-save ghost repair, the graph must still contain a runway.
 *     The repair drops a runway whose thresholds no longer resolve; without the
 *     re-check the writer would delete every survivor runway and the save would
 *     come back with the "at least one runway" refusal.
 *
 * The main-process half of the same guards is exercised in
 * `tests/integration/runway_gate_synthetic.test.js`.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../../../../src/hooks/useTranslation';
import { setLang } from '../../../../src/utils/i18n';
import { useAppStore } from '../../../../src/store/appStore';
import GroundPainter from '../../../../src/components/EditorScreen/GroundPainter/GroundPainter';
import Modal from '../../../../src/components/common/Modal';

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
    modal: { open: false, title: '', body: null, actions: null, closeable: true, headerRight: null, showLangToggle: false },
    ...overrides,
  });
}

/** Render the painter + modal, then install the state `save()` reads. The load
 *  effect resets the graph/hasEdited, so seed AFTER it resolves. */
async function renderThenSeed(graph, meta) {
  render(
    <I18nProvider>
      <GroundPainter vals={VALS} />
      <Modal />
    </I18nProvider>,
  );
  await waitFor(() => expect(document.querySelector('.ground-painter svg')).toBeTruthy());
  useAppStore.setState({
    groundPainterGraph: graph,
    groundPainterMeta: meta,
    groundPainterSnapshotText: '<acl/>',
    groundPainterHasEdited: true,
  });
  await waitFor(() => {
    const b = document.querySelector('.gp-save');
    expect(b && !b.disabled).toBe(true);
  });
}

/** Click the toolbar Save, then confirm in the backup modal. */
async function clickSaveAndConfirm() {
  fireEvent.click(document.querySelector('.gp-save'));
  const confirm = await waitFor(() => {
    const el = document.querySelector('#modal-actions .btn-confirm');
    expect(el).toBeTruthy();
    return el;
  });
  fireEvent.click(confirm);
}

beforeEach(() => {
  setLang('en');
  window.electronAPI.loadGroundPainterData = vi.fn(async () => {
    const g = { nodes: [], segments: [], runways: [], areas: [], stands: [] };
    return { graph: g, meta: { nodeOrigPk: [], segOrigPk: [], deletedPks: [] }, text: '<acl/>' };
  });
  window.electronAPI.saveGroundPainterData = vi.fn(async () => ({ newText: '<acl/>' }));
  window.electronAPI.loadAcl = vi.fn(async () => ({ success: false }));
  seedStore();
});

describe('GroundPainter save() — runway guard pre-flight', () => {
  it('refuses a runway whose two ends share a name, without calling the save IPC', async () => {
    const g = {
      nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      segments: [], areas: [], stands: [],
      runways: [{ thAIdx: 0, thBIdx: 1, names: ['27', '27'], name: '27', physicalName: '27/27', width: 0.5, entries: [], exits: [] }],
    };
    await renderThenSeed(g, { nodeOrigPk: [101, 102], segOrigPk: [], runwayOrigPk: [201], deletedPks: [] });
    await clickSaveAndConfirm();

    const err = await waitFor(() => {
      const el = document.querySelector('.gp-error');
      expect(el).toBeTruthy();
      return el;
    });
    expect(err.textContent).toContain('same name');
    expect(err.textContent).toContain('27');
    expect(window.electronAPI.saveGroundPainterData).not.toHaveBeenCalled();
  });

  it('refuses to save when the ghost repair leaves zero runways (no IPC call)', async () => {
    // Node 0 is a ghost (its PK is in deletedPks) with NO live twin at (0,0), so
    // repairGhostRefs must drop the runway that uses it as a threshold.
    const g = {
      nodes: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      segments: [], areas: [], stands: [],
      runways: [{ thAIdx: 0, thBIdx: 1, names: ['01', '19'], name: '01', physicalName: '01/19', width: 0.5, entries: [], exits: [] }],
    };
    await renderThenSeed(g, { nodeOrigPk: [101, 102], segOrigPk: [], runwayOrigPk: [201], deletedPks: [101] });
    await clickSaveAndConfirm();

    const err = await waitFor(() => {
      const el = document.querySelector('.gp-error');
      expect(el).toBeTruthy();
      return el;
    });
    expect(err.textContent).toMatch(/at least one runway/i);
    expect(window.electronAPI.saveGroundPainterData).not.toHaveBeenCalled();
    // The repair did drop the runway from the in-memory graph.
    expect(useAppStore.getState().groundPainterGraph.runways).toHaveLength(0);
  });
});
