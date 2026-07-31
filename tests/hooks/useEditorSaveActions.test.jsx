import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { useEditorSaveActions } from '../../src/hooks/useEditorSaveActions';
import { useAppStore } from '../../src/store/appStore';

// Spy on the save-gate validator so we can assert the hook's validation flow.
vi.mock('../../src/utils/validators', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    validateCallsigns: vi.fn(() => []),
    runTripleValidation: vi.fn(() => []),
  };
});
import { runTripleValidation, validateCallsigns } from '../../src/utils/validators';

function makeOpts(overrides = {}) {
  return {
    electronAPI: {
      saveAcl: vi.fn().mockResolvedValue({ success: true }),
      saveWeatherTimeline: vi.fn().mockResolvedValue({}),
      saveWindTimeline: vi.fn().mockResolvedValue({}),
      saveRunwayTimeline: vi.fn().mockResolvedValue({}),
      exportZip: vi.fn().mockResolvedValue({ success: true, path: '/fake/export.zip' }),
      manualBackup: vi.fn().mockResolvedValue({ success: true, path: '/fake/backup.bak' }),
      checkBackupExists: vi.fn().mockResolvedValue({ success: true, exists: false }),
      restoreBackup: vi.fn().mockResolvedValue({ success: true, flights: [], config: {}, _saveSec: 0, isDemo: false }),
      importZip: vi.fn().mockResolvedValue({ success: true, flights: [], config: {}, _saveSec: 0, isDemo: false }),
      loadTimelines: vi.fn().mockResolvedValue({ success: true, weatherTimeline: [], windTimeline: [], runwayTimeline: { initialRunways: [], timeline: [] } }),
      scanRunwayPairs: vi.fn().mockResolvedValue({ success: true, pairs: [] }),
    },
    t: (key) => key,
    showModal: vi.fn(),
    hideModal: vi.fn(),
    showToast: vi.fn(),
    convertWindSpeed: (v) => v,
    WIND_UNITS: { KNOTS: 'kts', MPS: 'm/s' },
    rootPath: '/fake/game-root',
    renderCallsignLink: vi.fn(),
    jumpToCallsign: vi.fn(),
    setScreen: vi.fn(),
    ...overrides,
  };
}

function setupStore(overrides = {}) {
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.getState().initializeEditor({
    currentPath: '/test/file.acl',
    airportIcao: 'ZSJN',
    flights: [{ CallSign: 'CCA1234', LandingTime: '10:00:00', InBlockTime: '10:05:00' }],
    before: '', after: '', arrayContent: '', originalBlocks: [],
    configStartTime: '06:00', configEndTime: '18:00',
    _saveSec: 36000,
    ...overrides,
  });
}

describe('useEditorSaveActions — save flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStore();
  });

  it('handleSave calls runTripleValidation with the store flights', async () => {
    const opts = makeOpts();
    const actions = useEditorSaveActions(opts);

    await actions.handleSave();

    expect(runTripleValidation).toHaveBeenCalledTimes(1);
    const call = runTripleValidation.mock.calls[0];
    expect(call[0]).toEqual(useAppStore.getState().flights);
    // No issues → proceeds to the backup modal, not the issues modal
    expect(opts.showModal).toHaveBeenCalledWith('modal_backup_title', expect.anything(), expect.anything());
  });

  it('handleSaveAs calls runTripleValidation', async () => {
    const actions = useEditorSaveActions(makeOpts());

    await actions.handleSaveAs();

    expect(runTripleValidation).toHaveBeenCalledTimes(1);
  });

  it('handleSave blocks on duplicate callsigns before runTripleValidation', async () => {
    validateCallsigns.mockReturnValueOnce(['CCA1234']);
    const opts = makeOpts();
    const actions = useEditorSaveActions(opts);

    await actions.handleSave();

    expect(runTripleValidation).not.toHaveBeenCalled();
    expect(opts.showModal).toHaveBeenCalledWith('modal_duplicate_title', expect.anything(), expect.anything());
  });

  it('handleRestore loads flights via setLegacyState', async () => {
    const opts = makeOpts();
    opts.electronAPI.checkBackupExists.mockResolvedValue({ success: true, exists: true });
    opts.electronAPI.restoreBackup.mockResolvedValue({
      success: true,
      flights: [{ CallSign: 'CES5678' }],
      config: { startTime: '06:00:00', endTime: '18:00:00' },
      _saveSec: 100,
      isDemo: false,
    });
    const actions = useEditorSaveActions(opts);

    await actions.handleRestore();
    // Click the confirm button from the modal content
    const modalChildren = opts.showModal.mock.calls[0][2];
    const view = render(modalChildren);
    fireEvent.click(view.getByText('modal_btn_restore'));

    await waitFor(() => expect(useAppStore.getState().flights).toHaveLength(1));
  });

  it('handleImport loads flights via setLegacyState', async () => {
    const opts = makeOpts();
    opts.electronAPI.importZip.mockResolvedValue({
      success: true,
      flights: [{ CallSign: 'CES5678' }],
      config: { startTime: '06:00:00', endTime: '18:00:00' },
      _saveSec: 100,
      isDemo: false,
    });
    const actions = useEditorSaveActions(opts);

    await actions.handleImport();
    const modalChildren = opts.showModal.mock.calls[0][2];
    const view = render(modalChildren);
    fireEvent.click(view.getByText('modal_btn_import'));

    await waitFor(() => expect(useAppStore.getState().flights).toHaveLength(1));
  });

  it('handleBack with no modifications navigates to browser without modal', async () => {
    const opts = makeOpts();
    const actions = useEditorSaveActions(opts);

    await actions.handleBack();

    expect(opts.setScreen).toHaveBeenCalledWith('browser');
    expect(opts.showModal).not.toHaveBeenCalled();
  });

  it('handleBack with modifications shows the unsaved-changes modal', async () => {
    useAppStore.setState({ modified: true });
    const opts = makeOpts();
    const actions = useEditorSaveActions(opts);

    actions.handleBack();

    expect(opts.setScreen).not.toHaveBeenCalled();
    expect(opts.showModal).toHaveBeenCalledWith('modal_unsaved_title', expect.anything(), expect.anything());
  });
});
