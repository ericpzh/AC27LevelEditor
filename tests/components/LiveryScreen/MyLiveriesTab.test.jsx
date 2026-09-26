import React, { act } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MyLiveriesTab from '../../../src/components/LiveryScreen/MyLiveriesTab';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderMine(props = {}) {
  return render(
    <I18nProvider>
      <MyLiveriesTab cmdRef={{ current: {} }} onBarState={() => {}} {...props} />
      <Modal />
      <Toast />
    </I18nProvider>
  );
}

const ROW = {
  folder: 'A20N_CCA',
  id: 'a20n_cca_default',
  name: 'A20N CCA Default Livery',
  airline: 'CCA',
  targetPlaneId: 'AIRBUS A-320neo',
  hasBasePng: true,
  mtime: 0,
};

const ROW2 = {
  folder: 'B738_AAL',
  id: 'b738_aal_default',
  name: 'B738 AAL Default Livery',
  airline: 'AAL',
  targetPlaneId: 'BOEING 737-800',
  hasBasePng: true,
  mtime: 0,
};

function setupMocks(overrides = {}) {
  mockIpcInvoke.mockImplementation((channel, ...args) => {
    if (overrides[channel] !== undefined) return overrides[channel];
    switch (channel) {
      case 'list-liveries':
        return Promise.resolve({ success: true, mine: [], reference: [] });
      case 'read-livery-image':
        return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,X' });
      default:
        return Promise.resolve({});
    }
  });
}

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
});

describe('MyLiveriesTab', () => {
  it('empty list shows a placeholder and no groups', async () => {
    setupMocks();
    renderMine();
    await waitFor(() => {
      expect(screen.getByText('No custom liveries yet — create one.')).toBeInTheDocument();
    });
    expect(document.querySelector('.livery-bottombar')).toBeNull();
    expect(document.querySelector('.livery-tabbar')).toBeNull();
  });

  it('search filter narrows groups by airline, folder or aircraft', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] }) });
    renderMine({ search: 'american' });
    await waitFor(() => expect(screen.getByText('American Airlines')).toBeInTheDocument());
    expect(screen.queryByText('Air China')).toBeNull();
  });

  it('search with no match shows the empty-search placeholder', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    renderMine({ search: 'zzz-no-such-airline' });
    await waitFor(() => {
      expect(screen.getByText('No matching liveries')).toBeInTheDocument();
    });
  });

  it('renders each own card with an in-card checkbox and no per-card actions', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    const card = screen.getByText('Air China').closest('.livery-card');
    // No buttons on the card anymore — actions live in the header bar.
    expect(card.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByText('Edit')).toBeNull();
    // The checkbox sits inside the thumbnail, not beside the name.
    expect(card.querySelector('.livery-thumb .livery-check .livery-select')).toBeInTheDocument();
  });

  it('reserves the thumbnail box (no img yet) while the picture is still loading', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'read-livery-image': new Promise(() => {}), // never resolves
    });
    renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    const thumb = screen.getByText('Air China').closest('.livery-card').querySelector('.livery-thumb');
    // The box (with its solid placeholder background) is there before the
    // image resolves, so the card never reflows as thumbnails arrive.
    expect(thumb).toBeInTheDocument();
    expect(thumb.querySelector('img')).toBeNull();
  });

  it('header delete command confirms and deletes the single selected livery', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'delete-livery': Promise.resolve({ success: true }),
    });
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    renderMine({ cmdRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());

    await user.click(document.querySelector('.livery-select'));
    act(() => { cmdRef.current.deleteSelected(); });
    await waitFor(() => {
      expect(screen.getByText('Confirm Delete')).toBeInTheDocument();
    });
    expect(screen.getByText('Delete livery A20N_CCA?')).toBeInTheDocument();
    await user.click(screen.getByText('Delete', { selector: '.btn-danger' }).closest('button'));

    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('delete-livery', 'A20N_CCA');
    });
    await waitFor(() => {
      expect(screen.getByText('Livery deleted')).toBeInTheDocument();
    });
  });

  it('export command runs export + save dialog and toasts the zip name', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'export-livery': Promise.resolve({ success: true, filePath: '/tmp/A20N_CCA.zip' }),
      'save-livery-dialog': Promise.resolve({ canceled: false, success: true, filePath: '/dl/A20N_CCA.zip' }),
    });
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    renderMine({ cmdRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(document.querySelector('.livery-select'));
    act(() => { cmdRef.current.exportSelected(); });
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('export-livery', 'A20N_CCA');
    });
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('save-livery-dialog', {
        sourcePath: '/tmp/A20N_CCA.zip',
        suggestedName: 'A20N_CCA.zip',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('Livery exported: A20N_CCA.zip')).toBeInTheDocument();
    });
  });

  it('save-dialog cancel stays silent (cancel path)', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'export-livery': Promise.resolve({ success: true, filePath: '/tmp/A20N_CCA.zip' }),
      'save-livery-dialog': Promise.resolve({ canceled: true }),
    });
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    renderMine({ cmdRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(document.querySelector('.livery-select'));
    act(() => { cmdRef.current.exportSelected(); });
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('save-livery-dialog', expect.anything());
    });
    await new Promise(r => setTimeout(r, 100));
    expect(screen.queryByText(/Livery exported/)).toBeNull();
  });

  it('the in-card checkbox shows a select tooltip on hover', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    fireEvent.mouseEnter(document.querySelector('.livery-check'));
    const tip = document.body.querySelector('.tooltip-popup');
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain('Select this livery');
    fireEvent.mouseLeave(document.querySelector('.livery-check'));
    expect(document.body.querySelector('.tooltip-popup')).toBeNull();
  });

  it('groups liveries by aircraft type with counts', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    expect(screen.getByText('American Airlines')).toBeInTheDocument();
    expect(screen.getByText('AIRBUS A-320neo')).toBeInTheDocument();
    expect(screen.getByText('BOEING 737-800')).toBeInTheDocument();
    expect(screen.getAllByText('1 liveries')).toHaveLength(2);
  });

  it('clicking a group header collapses and re-expands it', async () => {
    const user = userEvent.setup();
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    const header = screen.getByText('AIRBUS A-320neo').closest('.livery-group-header');
    await user.click(header);
    await waitFor(() => {
      expect(screen.queryByText('Air China')).toBeNull();
    });
    await user.click(header);
    await waitFor(() => {
      expect(screen.getByText('Air China')).toBeInTheDocument();
    });
  });

  it('persists collapsed groups and re-applies them on the next mount', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const user = userEvent.setup();
    const first = renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(screen.getByText('AIRBUS A-320neo').closest('.livery-group-header'));
    await waitFor(() => expect(useAppStore.getState().liveryCollapsedGroups['AIRBUS A-320neo']).toBe(true));
    first.unmount();
    // Re-entering the page seeds the collapse state back from the store.
    renderMine();
    await waitFor(() => expect(screen.getByText('AIRBUS A-320neo')).toBeInTheDocument());
    expect(screen.queryByText('Air China')).toBeNull();
  });

  it('restores the saved scroll offset once the list has settled', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    useAppStore.setState({ liveryScrollTop: 250 });
    const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
    const scrollRef = { current: el };
    renderMine({ scrollRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await waitFor(() => expect(el.scrollTop).toBe(250));
  });

  it('clamps the saved scroll offset to the content maximum', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    useAppStore.setState({ liveryScrollTop: 5000 });
    const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
    const scrollRef = { current: el };
    renderMine({ scrollRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await waitFor(() => expect(el.scrollTop).toBe(900));
  });

  it('merges reference rows into the same aircraft folder with a lock mark', async () => {
    const refRow = {
      folder: 'A20N_CES',
      id: 'a20n_ces_default',
      name: 'A20N CES Default Livery',
      airline: 'CES',
      targetPlaneId: 'AIRBUS A-320neo',
      hasBasePng: true,
      mtime: 0,
    };
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [refRow] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    expect(screen.getByText('China Eastern')).toBeInTheDocument();
    // One shared folder, count covers both packs.
    expect(screen.getAllByText('AIRBUS A-320neo')).toHaveLength(1);
    expect(screen.getByText('2 liveries')).toBeInTheDocument();
    // No separate reference section anymore.
    expect(screen.queryByText('Reference liveries (read-only)')).toBeNull();
    // Reference card carries the lock mark and no checkbox.
    const lock = document.querySelector('.livery-readonly');
    expect(lock).toBeInTheDocument();
    expect(lock.querySelector('svg')).toBeTruthy();
    const refCard = screen.getByText('China Eastern').closest('.livery-card');
    expect(refCard.querySelector('.livery-select')).toBeNull();
    // Only the own-pack card is selectable.
    expect(document.querySelectorAll('.livery-select')).toHaveLength(1);
  });

  it('lock mark shows a read-only tooltip on hover', async () => {
    const refRow = {
      folder: 'A20N_CES',
      id: 'a20n_ces_default',
      name: 'A20N CES Default Livery',
      airline: 'CES',
      targetPlaneId: 'AIRBUS A-320neo',
      hasBasePng: true,
      mtime: 0,
    };
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [refRow] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('China Eastern')).toBeInTheDocument());
    fireEvent.mouseEnter(document.querySelector('.livery-readonly'));
    const tip = document.body.querySelector('.tooltip-popup');
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain('Read-only');
  });

  it('select-all command toggles every own-pack checkbox', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] }) });
    const cmdRef = { current: {} };
    const barStates = [];
    renderMine({ cmdRef, onBarState: (s) => barStates.push(s) });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    const boxes = () => [...document.querySelectorAll('.livery-select')];
    expect(boxes()).toHaveLength(2);
    expect(boxes().every(b => !b.checked)).toBe(true);
    act(() => { cmdRef.current.toggleSelectAll(); });
    await waitFor(() => {
      expect(boxes().every(b => b.checked)).toBe(true);
    });
    expect(barStates[barStates.length - 1]).toMatchObject({ mineCount: 2, selectedCount: 2, allSelected: true, oneSelected: false });
    // Toggles to deselect.
    act(() => { cmdRef.current.toggleSelectAll(); });
    await waitFor(() => {
      expect(boxes().every(b => !b.checked)).toBe(true);
    });
  });

  it('a command handle captured before the list loads still acts on the loaded rows', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] }) });
    const cmdRef = { current: {} };
    renderMine({ cmdRef });
    // Grab the handle the first (loading) render published — the exact stale
    // closure the header/test can hold across the async list load. Calling it
    // after the rows resolve must select the loaded rows, not the empty
    // pre-load list (which would leave every checkbox unchecked).
    const staleHandle = cmdRef.current;
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    act(() => { staleHandle.toggleSelectAll(); });
    await waitFor(() => {
      expect([...document.querySelectorAll('.livery-select')].every(b => b.checked)).toBe(true);
    });
  });

  it('delete-selected command confirms and batch-deletes', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] }),
      'delete-livery': Promise.resolve({ success: true }),
    });
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    renderMine({ cmdRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    act(() => { cmdRef.current.toggleSelectAll(); });
    await waitFor(() => {
      expect([...document.querySelectorAll('.livery-select')].every(b => b.checked)).toBe(true);
    });
    act(() => { cmdRef.current.deleteSelected(); });
    await waitFor(() => {
      expect(screen.getByText('Confirm Delete')).toBeInTheDocument();
    });
    expect(screen.getByText('Delete 2 selected liveries?')).toBeInTheDocument();
    await user.click(screen.getByText('Delete', { selector: '.btn-danger' }).closest('button'));
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('delete-livery', 'A20N_CCA');
    });
    expect(mockIpcInvoke).toHaveBeenCalledWith('delete-livery', 'B738_AAL');
    await waitFor(() => {
      expect(screen.getByText('Deleted 2 liveries')).toBeInTheDocument();
    });
  });

  it('reference rows are not selectable', async () => {
    const refRow = {
      folder: 'A20N_CES', id: 'a20n_ces_default', name: 'A20N CES',
      airline: 'CES', targetPlaneId: 'AIRBUS A-320neo', hasBasePng: true, mtime: 0,
    };
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [refRow] }) });
    const cmdRef = { current: {} };
    const barStates = [];
    renderMine({ cmdRef, onBarState: (s) => barStates.push(s) });
    await waitFor(() => expect(screen.getByText('China Eastern')).toBeInTheDocument());
    // Only the own-pack card has a checkbox.
    expect(document.querySelectorAll('.livery-select')).toHaveLength(1);
    act(() => { cmdRef.current.toggleSelectAll(); });
    await waitFor(() => {
      expect(barStates[barStates.length - 1]).toMatchObject({ mineCount: 1, selectedCount: 1 });
    });
  });

  it('clicking a mine card opens it in the painter with pack and no pixels', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderMine({ onEdit });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    const card = screen.getByText('Air China').closest('.livery-card');
    await user.click(card);
    // The 256px list preview must never seed the painter canvas — the
    // painter lazy-loads the full 2048 texture itself.
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({
      folder: 'A20N_CCA',
      pack: 'mine',
      imageDataUrl: null,
    }));
  });

  it('clicking a locked reference card opens it in the painter as reference', async () => {
    const refRow = {
      folder: 'A20N_CES', id: 'a20n_ces_default', name: 'A20N CES',
      airline: 'CES', targetPlaneId: 'AIRBUS A-320neo', hasBasePng: true, mtime: 0,
    };
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [refRow] }) });
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderMine({ onEdit });
    await waitFor(() => expect(screen.getByText('China Eastern')).toBeInTheDocument());
    const refCard = screen.getByText('China Eastern').closest('.livery-card');
    await user.click(refCard);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({
      folder: 'A20N_CES',
      pack: 'reference',
    }));
  });

  it('checkbox clicks select without opening the painter', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderMine({ onEdit });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(document.querySelector('.livery-select'));
    expect(document.querySelector('.livery-select').checked).toBe(true);
    expect(onEdit).not.toHaveBeenCalled();
  });
});

describe('MyLiveriesTab 3D-only previews', () => {
  it('never uses the resized PNG thumbnail channel', async () => {
    mockIpcInvoke.mockClear();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'list-liveries') return Promise.resolve({ success: true, mine: [ROW], reference: [] });
      return Promise.resolve({});
    });
    renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    expect(mockIpcInvoke.mock.calls.some(c => c[0] === 'read-livery-thumbnail')).toBe(false);
  });

  it('shows no 2D image (the preview is 3D-only)', async () => {
    mockIpcInvoke.mockClear();
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'list-liveries') return Promise.resolve({ success: true, mine: [ROW], reference: [] });
      if (channel === 'read-livery-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,FULL' });
      return Promise.resolve({});
    });
    renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    expect(document.querySelector('.livery-thumb img')).toBeNull();
  });
});

describe('MyLiveriesTab error + edge paths', () => {
  it('list failure toasts the mapped error', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: false, error: 'BAD_MANIFEST' }) });
    renderMine();
    await waitFor(() => {
      expect(screen.getByText('Corrupt livery manifest.')).toBeInTheDocument();
    });
  });

  it('list rejection toasts the thrown message', async () => {
    setupMocks({ 'list-liveries': Promise.reject(new Error('boom')) });
    renderMine();
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('delete failure toasts the mapped error', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'delete-livery': Promise.resolve({ success: false, error: 'BAD_FOLDER' }),
    });
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    renderMine({ cmdRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(document.querySelector('.livery-select'));
    act(() => { cmdRef.current.deleteSelected(); });
    await waitFor(() => expect(screen.getByText('Confirm Delete')).toBeInTheDocument());
    await user.click(screen.getByText('Delete', { selector: '.btn-danger' }).closest('button'));
    await waitFor(() => {
      expect(screen.getByText('Invalid folder name.')).toBeInTheDocument();
    });
  });

  it('export failure toasts the mapped error', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'export-livery': Promise.resolve({ success: false, error: 'BAD_FOLDER' }),
    });
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    renderMine({ cmdRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(document.querySelector('.livery-select'));
    act(() => { cmdRef.current.exportSelected(); });
    await waitFor(() => {
      expect(screen.getByText('Invalid folder name.')).toBeInTheDocument();
    });
  });

  it('save-dialog failure toasts the mapped error', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'export-livery': Promise.resolve({ success: true, filePath: '/tmp/A20N_CCA.zip' }),
      'save-livery-dialog': Promise.resolve({ canceled: false, success: false, error: 'BAD_FOLDER' }),
    });
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    renderMine({ cmdRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(document.querySelector('.livery-select'));
    act(() => { cmdRef.current.exportSelected(); });
    await waitFor(() => {
      expect(screen.getByText('Invalid folder name.')).toBeInTheDocument();
    });
  });

  it('renders a bad-manifest row with its error message', async () => {
    const badRow = { folder: 'A20N_CCA', id: '', name: '', airline: '', targetPlaneId: '', hasBasePng: true, mtime: 0, error: 'BAD_MANIFEST' };
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [badRow], reference: [] }) });
    renderMine();
    await waitFor(() => {
      expect(screen.getByText('Corrupt livery manifest.')).toBeInTheDocument();
    });
  });

  it('groups rows with an unknown aircraft under the fallback title', async () => {
    const unknown = { folder: 'MYSTERY', id: '', name: '', airline: 'CCA', targetPlaneId: '', hasBasePng: true, mtime: 0 };
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [unknown], reference: [] }) });
    renderMine();
    await waitFor(() => {
      expect(screen.getByText('Unknown aircraft')).toBeInTheDocument();
    });
    expect(screen.getByText('Air China')).toBeInTheDocument();
  });

  it('Enter / Space on a focused card opens it in the painter', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const onEdit = vi.fn();
    renderMine({ onEdit });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    const card = screen.getByText('Air China').closest('.livery-card');
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ folder: 'A20N_CCA' }));
    fireEvent.keyDown(card, { key: ' ' });
    expect(onEdit).toHaveBeenCalledTimes(2);
  });

  it('renders an add card in each aircraft folder and calls onCreate with its type', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderMine({ onCreate });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    const addCard = document.querySelector('.livery-add-card');
    expect(addCard).toBeInTheDocument();
    expect(addCard.textContent).toContain('Add livery');
    expect(addCard.getAttribute('title')).toContain('aircraft type');
    await user.click(addCard);
    expect(onCreate).toHaveBeenCalledWith('AIRBUS A-320neo');
  });

  it('add card falls back to onEdit({ targetPlaneId }) when no onCreate is passed', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderMine({ onEdit });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(document.querySelector('.livery-add-card'));
    expect(onEdit).toHaveBeenCalledWith({ targetPlaneId: 'AIRBUS A-320neo' });
  });

  it('renders a folder (and add card) for every scanned type, even with zero liveries', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [], reference: [] }),
      'list-aircraft-types': Promise.resolve({
        success: true,
        types: [{ planeId: 'AIRBUS A-320neo', shortCode: 'A20N' }, { planeId: 'BOMBARDIER CRJ700', shortCode: 'CRJ7' }],
      }),
    });
    renderMine();
    await waitFor(() => expect(screen.getByText('BOMBARDIER CRJ700')).toBeInTheDocument());
    expect(screen.getByText('AIRBUS A-320neo')).toBeInTheDocument();
    expect(screen.getAllByText('0 liveries')).toHaveLength(2);
    expect(document.querySelectorAll('.livery-add-card')).toHaveLength(2);
    // No empty-pack placeholder while types are known.
    expect(screen.queryByText('No custom liveries yet — create one.')).toBeNull();
  });

  it('merges scanned types with row-backed types without duplicating a folder', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'list-aircraft-types': Promise.resolve({
        success: true,
        types: [{ planeId: 'AIRBUS A-320neo', shortCode: 'A20N' }, { planeId: 'BOMBARDIER CRJ700', shortCode: 'CRJ7' }],
      }),
    });
    renderMine();
    await waitFor(() => expect(screen.getByText('BOMBARDIER CRJ700')).toBeInTheDocument());
    expect(screen.getAllByText('AIRBUS A-320neo')).toHaveLength(1);
    expect(screen.getByText('1 liveries')).toBeInTheDocument();
    expect(screen.getByText('0 liveries')).toBeInTheDocument();
  });

  it('keeps an empty folder only when its type matches the search', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'list-aircraft-types': Promise.resolve({
        success: true,
        types: [{ planeId: 'AIRBUS A-320neo', shortCode: 'A20N' }, { planeId: 'BOMBARDIER CRJ700', shortCode: 'CRJ7' }],
      }),
    });
    renderMine({ search: 'crj' });
    await waitFor(() => expect(screen.getByText('BOMBARDIER CRJ700')).toBeInTheDocument());
    // The non-matching (and now row-filtered) A320neo folder is gone.
    expect(screen.queryByText('AIRBUS A-320neo')).toBeNull();
    expect(screen.getByText('0 liveries')).toBeInTheDocument();
    expect(document.querySelectorAll('.livery-add-card')).toHaveLength(1);
  });

  it('shows the no-match placeholder when the search matches no row or type', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'list-aircraft-types': Promise.resolve({ success: true, types: [{ planeId: 'BOMBARDIER CRJ700', shortCode: 'CRJ7' }] }),
    });
    renderMine({ search: 'zzz-nope' });
    await waitFor(() => expect(screen.getByText('No matching liveries')).toBeInTheDocument());
    expect(document.querySelectorAll('.livery-add-card')).toHaveLength(0);
  });

  it('omits the add card for rows with an unknown aircraft type', async () => {
    const unknown = { folder: 'MYSTERY', id: '', name: '', airline: 'CCA', targetPlaneId: '', hasBasePng: true, mtime: 0 };
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [unknown], reference: [] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('Unknown aircraft')).toBeInTheDocument());
    expect(document.querySelector('.livery-add-card')).toBeNull();
  });

  it('a failed aircraft-type scan still renders row-backed folders', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'list-aircraft-types': Promise.reject(new Error('scan failed')),
    });
    renderMine();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    expect(document.querySelector('.livery-add-card')).toBeInTheDocument();
    expect(screen.queryByText(/scan failed/)).toBeNull();
  });

  it('delete removes the row in place, skips the full refresh and caps scroll', async () => {
    let listCalls = 0;
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'list-liveries') {
        listCalls++;
        return Promise.resolve({ success: true, mine: [ROW], reference: [] });
      }
      if (channel === 'delete-livery') return Promise.resolve({ success: true });
      return Promise.resolve({});
    });
    // Fake scroll container: in range before the delete, out of range after.
    const el = { scrollTop: 500, scrollHeight: 1000, clientHeight: 100 };
    const scrollRef = { current: el };
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    renderMine({ cmdRef, scrollRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    expect(listCalls).toBe(1);
    await user.click(document.querySelector('.livery-select'));
    el.scrollHeight = 400; // the list shrinks once the row is gone
    act(() => { cmdRef.current.deleteSelected(); });
    await waitFor(() => expect(screen.getByText('Confirm Delete')).toBeInTheDocument());
    await user.click(screen.getByText('Delete', { selector: '.btn-danger' }).closest('button'));
    await waitFor(() => expect(screen.queryByText('Air China')).toBeNull());
    // No re-list: the list stayed mounted instead of flashing the placeholder.
    expect(listCalls).toBe(1);
    // scrollTop was capped to the new content maximum, not reset to 0.
    await waitFor(() => expect(el.scrollTop).toBe(300));
  });

  it('batch delete reports partial success', async () => {
    let listCalls = 0;
    mockIpcInvoke.mockImplementation((channel, folder) => {
      if (channel === 'list-liveries') {
        listCalls++;
        return Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] });
      }
      if (channel === 'delete-livery') return Promise.resolve(folder === 'A20N_CCA' ? { success: true } : { success: false, error: 'BAD_FOLDER' });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    renderMine({ cmdRef });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    act(() => { cmdRef.current.toggleSelectAll(); });
    // Let the selection commit (and cmdRef re-publish) before deleting —
    // calling deleteSelected in the same tick read the stale empty selection.
    await waitFor(() => {
      expect(document.querySelectorAll('.livery-select:checked').length).toBe(2);
    });
    act(() => { cmdRef.current.deleteSelected(); });
    await waitFor(() => expect(screen.getByText('Confirm Delete')).toBeInTheDocument());
    await user.click(screen.getByText('Delete', { selector: '.btn-danger' }).closest('button'));
    await waitFor(() => {
      expect(screen.getByText('Deleted 1 liveries')).toBeInTheDocument();
    });
    // Both folders were attempted; the success toast is the last one shown.
    expect(mockIpcInvoke).toHaveBeenCalledWith('delete-livery', 'A20N_CCA');
    expect(mockIpcInvoke).toHaveBeenCalledWith('delete-livery', 'B738_AAL');
    // Only the successful row is dropped in place; the failed one survives and
    // the list is never re-fetched (no loading-placeholder flash).
    expect(screen.queryByText('Air China')).toBeNull();
    expect(screen.getByText('American Airlines')).toBeInTheDocument();
    expect(listCalls).toBe(1);
  });

  it('upload command opens the dialog only with exactly one mine selection', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] }) });
    const user = userEvent.setup();
    const cmdRef = { current: {} };
    const onUpload = vi.fn();
    renderMine({ cmdRef, onUpload });
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());

    // Nothing selected: no dialog.
    act(() => { cmdRef.current.uploadSelected(); });
    expect(onUpload).not.toHaveBeenCalled();

    // One selected: the single mine folder is passed up.
    await user.click(document.querySelector('.livery-select'));
    act(() => { cmdRef.current.uploadSelected(); });
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload).toHaveBeenCalledWith('A20N_CCA');

    // Two selected: back to no dialog (single-target gate, like export).
    onUpload.mockClear();
    act(() => { cmdRef.current.toggleSelectAll(); });
    await waitFor(() => {
      expect(document.querySelectorAll('.livery-select:checked').length).toBe(2);
    });
    act(() => { cmdRef.current.uploadSelected(); });
    expect(onUpload).not.toHaveBeenCalled();
  });
});
