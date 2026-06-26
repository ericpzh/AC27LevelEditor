import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../../src/store/appStore';

// Reset the store to initial state before each test
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

describe('appStore — screen & navigation', () => {
  it('starts on setup screen', () => {
    expect(useAppStore.getState().screen).toBe('setup');
  });

  it('setScreen changes the current screen', () => {
    useAppStore.getState().setScreen('browser');
    expect(useAppStore.getState().screen).toBe('browser');
  });
});

describe('appStore — modal', () => {
  it('modal defaults to closed', () => {
    expect(useAppStore.getState().modal.open).toBe(false);
  });

  it('showModal opens modal with content', () => {
    useAppStore.getState().showModal('Test Title', <p>Body</p>, <button>OK</button>);
    const modal = useAppStore.getState().modal;
    expect(modal.open).toBe(true);
    expect(modal.title).toBe('Test Title');
    expect(modal.actions).toBeDefined();
  });

  it('hideModal closes modal', () => {
    useAppStore.getState().showModal('Title', 'Body');
    useAppStore.getState().hideModal();
    expect(useAppStore.getState().modal.open).toBe(false);
  });
});

describe('appStore — toast', () => {
  it('toast defaults to empty', () => {
    expect(useAppStore.getState().toast.message).toBe('');
  });

  it('showToast sets message and type', () => {
    useAppStore.getState().showToast('Saved!', 'success');
    expect(useAppStore.getState().toast.message).toBe('Saved!');
    expect(useAppStore.getState().toast.type).toBe('success');
  });
});

describe('appStore — editor state', () => {
  it('modified defaults to false', () => {
    expect(useAppStore.getState().modified).toBe(false);
  });

  it('initializeEditor sets current path and flights', () => {
    useAppStore.getState().initializeEditor({
      currentPath: '/test/file.acl',
      airportIcao: 'ZSJN',
      flights: [{ CallSign: 'CES1234' }],
      before: '', after: '', arrayContent: '', originalBlocks: [],
      configStartTime: '06:00', configEndTime: '18:00',
      earliestTime: '05:00', _saveSec: 36000,
    });
    const state = useAppStore.getState();
    expect(state.currentPath).toBe('/test/file.acl');
    expect(state.currentAirport).toBe('ZSJN');
    expect(state.flights).toHaveLength(1);
    expect(state.modified).toBe(false);
  });
});

describe('appStore — addArrivalFlight', () => {
  it('adds a new arrival flight', () => {
    useAppStore.getState().initializeEditor({
      currentPath: '/test/file.acl',
      airportIcao: 'ZSJN',
      flights: [],
      before: '', after: '', arrayContent: '', originalBlocks: [],
      configStartTime: '06:00', configEndTime: '18:00',
      earliestTime: '05:00', _saveSec: 36000,
    });
    useAppStore.getState().setAuxData(
      { ZSJN: { AircraftType: ['B738'], AirlineName: ['China Eastern'], Stand: ['G1'], Runway: ['01'], Airway: ['STAR1'], Registration: ['B-1234'], Voice: ['M'] } },
      { byAirline: {}, allCallsigns: [], allAirlines: ['CES'] },
      { weatherTimeline: [], windTimeline: [], runwayTimeline: { initialRunways: [], timeline: [] } },
      [],
    );

    useAppStore.getState().addArrivalFlight();
    const state = useAppStore.getState();
    expect(state.flights).toHaveLength(1);
    expect(state.flights[0].ArrivalAirport).toBe('ZSJN');
    expect(state.modified).toBe(true);
  });
});

describe('appStore — selection', () => {
  it('selectedIndices defaults to empty', () => {
    expect(useAppStore.getState().selectedIndices.size).toBe(0);
  });

  it('toggleSelection adds and removes index', () => {
    const store = useAppStore.getState();
    store.toggleSelection(0);
    expect(useAppStore.getState().selectedIndices.has(0)).toBe(true);
    store.toggleSelection(0);
    expect(useAppStore.getState().selectedIndices.has(0)).toBe(false);
  });

  it('toggleSelectAll sets all indices when none selected', () => {
    useAppStore.getState().initializeEditor({
      currentPath: '/test/file.acl',
      airportIcao: 'ZSJN',
      flights: [{ CallSign: 'A' }, { CallSign: 'B' }, { CallSign: 'C' }],
      before: '', after: '', arrayContent: '', originalBlocks: [],
      configStartTime: '06:00', configEndTime: '18:00',
      earliestTime: '05:00', _saveSec: 36000,
    });
    useAppStore.getState().toggleSelectAll();
    const sel = useAppStore.getState().selectedIndices;
    expect(sel.has(0)).toBe(true);
    expect(sel.has(1)).toBe(true);
    expect(sel.has(2)).toBe(true);
  });

  it('toggleSelectAll clears all when all selected', () => {
    useAppStore.getState().initializeEditor({
      currentPath: '/test/file.acl',
      airportIcao: 'ZSJN',
      flights: [{ CallSign: 'A' }, { CallSign: 'B' }],
      before: '', after: '', arrayContent: '', originalBlocks: [],
      configStartTime: '06:00', configEndTime: '18:00',
      earliestTime: '05:00', _saveSec: 36000,
    });
    useAppStore.getState().toggleSelectAll(); // select all
    useAppStore.getState().toggleSelectAll(); // deselect all
    expect(useAppStore.getState().selectedIndices.size).toBe(0);
  });
});

// ── Chat state ─────────────────────────────────────────────────

describe('appStore — chat', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it('defaults to panel closed', () => {
    expect(useAppStore.getState().chatPanelOpen).toBe(false);
  });

  it('defaults to vendors setup step', () => {
    expect(useAppStore.getState().chatSetupStep).toBe('vendors');
  });

  it('defaults to empty config', () => {
    const cfg = useAppStore.getState().chatConfig;
    expect(cfg.deepseekKey).toBe('');
    expect(cfg.selectedModel).toBe('');
  });

  it('toggles chat panel open/closed', () => {
    const store = useAppStore.getState();
    store.toggleChatPanel();
    expect(useAppStore.getState().chatPanelOpen).toBe(true);
    store.toggleChatPanel();
    expect(useAppStore.getState().chatPanelOpen).toBe(false);
  });

  it('adds and clears chat messages', () => {
    const store = useAppStore.getState();
    store.addChatMessage({ role: 'user', content: 'hello' });
    expect(useAppStore.getState().chatMessages.length).toBe(1);
    store.clearChatMessages();
    expect(useAppStore.getState().chatMessages.length).toBe(0);
  });

  it('sets sending state', () => {
    useAppStore.getState().setChatSending(true);
    expect(useAppStore.getState().chatSending).toBe(true);
  });

  it('sets and clears chat errors', () => {
    useAppStore.getState().setChatError('test error');
    expect(useAppStore.getState().chatError).toBe('test error');
    useAppStore.getState().clearChatError();
    expect(useAppStore.getState().chatError).toBe(null);
  });

  it('sets chat config', () => {
    useAppStore.getState().setChatConfig({ deepseekKey: 'sk-test', selectedModel: 'deepseek-v4-pro' });
    expect(useAppStore.getState().chatConfig.deepseekKey).toBe('sk-test');
    expect(useAppStore.getState().chatConfig.selectedModel).toBe('deepseek-v4-pro');
  });

  it('sets setup step', () => {
    useAppStore.getState().setChatSetupStep('ready');
    expect(useAppStore.getState().chatSetupStep).toBe('ready');
  });
});
