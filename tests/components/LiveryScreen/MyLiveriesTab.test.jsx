import React from 'react';
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
      <MyLiveriesTab {...props} />
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
  it('shows empty state with a create shortcut', async () => {
    setupMocks();
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderMine({ onCreate });
    await waitFor(() => {
      expect(screen.getByText('No custom liveries yet — create one.')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Create'));
    expect(onCreate).toHaveBeenCalled();
  });

  it('renders rows with edit/export/copy/delete actions', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const onEdit = vi.fn();
    renderMine({ onEdit });
    await waitFor(() => expect(screen.getByText('A20N_CCA')).toBeInTheDocument());
    expect(screen.getByText('CCA · AIRBUS A-320neo')).toBeInTheDocument();

    const editBtn = screen.getByText('Edit').closest('button');
    const exportBtn = screen.getByText('Export').closest('button');
    expect(exportBtn.disabled).toBe(false);

    const user = userEvent.setup();
    await user.click(editBtn);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ folder: 'A20N_CCA' }));
  });

  it('delete opens a confirm modal and refreshes on confirm', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'delete-livery': Promise.resolve({ success: true }),
    });
    const user = userEvent.setup();
    renderMine();
    await waitFor(() => expect(screen.getByText('A20N_CCA')).toBeInTheDocument());

    await user.click(screen.getByText('Delete').closest('button'));
    await waitFor(() => {
      expect(screen.getByText('Confirm Delete')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Delete', { selector: '.btn-danger' }).closest('button'));

    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('delete-livery', 'A20N_CCA');
    });
    await waitFor(() => {
      expect(screen.getByText('Livery deleted')).toBeInTheDocument();
    });
  });

  it('export runs export + save dialog and toasts the zip name', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }),
      'export-livery': Promise.resolve({ success: true, filePath: '/tmp/A20N_CCA.zip' }),
      'save-livery-dialog': Promise.resolve({ canceled: false, success: true, filePath: '/dl/A20N_CCA.zip' }),
    });
    const user = userEvent.setup();
    renderMine();
    await waitFor(() => expect(screen.getByText('A20N_CCA')).toBeInTheDocument());
    await user.click(screen.getByText('Export').closest('button'));
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
    renderMine();
    await waitFor(() => expect(screen.getByText('A20N_CCA')).toBeInTheDocument());
    await user.click(screen.getByText('Export').closest('button'));
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('save-livery-dialog', expect.anything());
    });
    await new Promise(r => setTimeout(r, 100));
    expect(screen.queryByText(/Livery exported/)).toBeNull();
  });

  it('copy folder name writes to clipboard and toasts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const user = userEvent.setup();
    renderMine();
    await waitFor(() => expect(screen.getByText('A20N_CCA')).toBeInTheDocument());
    // NB: define AFTER userEvent.setup() — setup() replaces
    // window.navigator.clipboard with its own stub getter.
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    await user.click(screen.getByText('Copy folder name').closest('button'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('A20N_CCA'));
    await waitFor(() => {
      expect(screen.getByText('Copied A20N_CCA')).toBeInTheDocument();
    });
    delete window.navigator.clipboard;
  });

  it('row buttons show tooltips on hover', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('A20N_CCA')).toBeInTheDocument());
    fireEvent.mouseEnter(screen.getByText('Export').closest('button'));
    const tip = document.body.querySelector('.tooltip-popup');
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain('shareable ZIP');
    fireEvent.mouseLeave(screen.getByText('Export').closest('button'));
    expect(document.body.querySelector('.tooltip-popup')).toBeNull();
  });

  it('groups liveries by aircraft type with counts', async () => {
    const row2 = {
      folder: 'B738_AAL',
      id: 'b738_aal_default',
      name: 'B738 AAL Default Livery',
      airline: 'AAL',
      targetPlaneId: 'BOEING 737-800',
      hasBasePng: true,
      mtime: 0,
    };
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW, row2], reference: [] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('A20N_CCA')).toBeInTheDocument());
    expect(screen.getByText('B738_AAL')).toBeInTheDocument();
    expect(screen.getByText('A20N · AIRBUS A-320neo')).toBeInTheDocument();
    expect(screen.getByText('B738 · BOEING 737-800')).toBeInTheDocument();
    expect(screen.getAllByText('1 liveries')).toHaveLength(2);
  });

  it('clicking a group header collapses and re-expands it', async () => {
    const user = userEvent.setup();
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    renderMine();
    await waitFor(() => expect(screen.getByText('A20N_CCA')).toBeInTheDocument());
    const header = screen.getByText('A20N · AIRBUS A-320neo').closest('.livery-group-header');
    await user.click(header);
    await waitFor(() => {
      expect(screen.queryByText('A20N_CCA')).toBeNull();
    });
    await user.click(header);
    await waitFor(() => {
      expect(screen.getByText('A20N_CCA')).toBeInTheDocument();
    });
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
    await waitFor(() => expect(screen.getByText('A20N_CCA')).toBeInTheDocument());
    expect(screen.getByText('A20N_CES')).toBeInTheDocument();
    // One shared folder, count covers both packs.
    expect(screen.getAllByText('A20N · AIRBUS A-320neo')).toHaveLength(1);
    expect(screen.getByText('2 liveries')).toBeInTheDocument();
    // No separate reference section anymore.
    expect(screen.queryByText('Reference liveries (read-only)')).toBeNull();
    // Reference card carries the lock mark and no action buttons.
    const lock = document.querySelector('.livery-readonly');
    expect(lock).toBeInTheDocument();
    expect(lock.querySelector('svg')).toBeTruthy();
    const refCard = screen.getByText('A20N_CES').closest('.livery-card');
    expect(refCard.querySelector('button')).toBeNull();
    const mineCard = screen.getByText('A20N_CCA').closest('.livery-card');
    expect(mineCard.querySelectorAll('button').length).toBeGreaterThan(0);
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
    await waitFor(() => expect(screen.getByText('A20N_CES')).toBeInTheDocument());
    fireEvent.mouseEnter(document.querySelector('.livery-readonly'));
    const tip = document.body.querySelector('.tooltip-popup');
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain('Read-only');
  });
});
