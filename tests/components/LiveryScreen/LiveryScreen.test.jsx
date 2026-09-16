import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveryScreen from '../../../src/components/LiveryScreen/LiveryScreen';
import CreateTab from '../../../src/components/LiveryScreen/CreateTab';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang, T } from '../../../src/utils/i18n';

function renderLivery() {
  return render(
    <I18nProvider>
      <LiveryScreen />
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
  folder: 'B738_AAL', id: 'b738_aal_default', name: 'B738 AAL',
  airline: 'AAL', targetPlaneId: 'BOEING 737-800', hasBasePng: true, mtime: 0,
};

function setupMocks(overrides = {}) {
  mockIpcInvoke.mockImplementation((channel, ...args) => {
    if (overrides[channel] !== undefined) return overrides[channel];
    switch (channel) {
      case 'list-liveries':
        return Promise.resolve({ mine: [], reference: [] });
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
  useAppStore.setState({ screen: 'livery' });
  // The painter view always mounts LiveryCanvas; jsdom has no 2d context.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
    fillRect: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fill: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), arc: vi.fn(),
    strokeRect: vi.fn(), setLineDash: vi.fn(), fillText: vi.fn(), putImageData: vi.fn(),
    translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(),
    getImageData: vi.fn((x, y, w, h) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h,
    })),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  CreateTab.prefill = null;
  window.__liveryPaintGuard = null;
});

describe('LiveryScreen', () => {
  it('header bar hosts all actions, no title/tabs/bottom bar', async () => {
    setupMocks();
    renderLivery();
    const header = document.querySelector('#screen-livery .browser-header');
    expect(header).toBeInTheDocument();
    const groups = header.querySelectorAll(':scope > .browser-actions');
    expect(groups).toHaveLength(2);
    // LHS: Back + Help (icon-only, moved here to match the painter) + Pack.
    expect(groups[0].textContent).toContain('Back');
    expect(groups[0].textContent).toContain('Pack');
    expect(groups[0].querySelector('#livery-help-btn')).toBeInTheDocument();
    // RHS: Create, Select All, Export, Delete (icon + label), search.
    expect(groups[1].textContent).toContain(T('livery_tab_create'));
    expect(groups[1].textContent).toContain('Select All');
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(groups[1].querySelector('#livery-help-btn')).toBeNull();
    expect(groups[1].querySelector('.livery-search input')).toBeInTheDocument();
    // Old chrome is gone.
    expect(document.querySelector('.livery-tabbar')).toBeNull();
    expect(document.querySelector('.livery-bottombar')).toBeNull();
    expect(header.textContent).not.toContain('Livery');
    await waitFor(() => {
      expect(screen.getByText('No custom liveries yet — create one.')).toBeInTheDocument();
    });
  });

  it('search box renders with its placeholder and carries no tooltip', async () => {
    setupMocks();
    renderLivery();
    const input = document.querySelector('.livery-search input');
    expect(input).toBeInTheDocument();
    expect(input.getAttribute('placeholder')).toBe('Search');
    fireEvent.mouseEnter(document.querySelector('.livery-search'));
    expect(document.body.querySelector('.tooltip-popup')).toBeNull();
  });

  it('back button navigates to browser', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    await user.click(screen.getByText('Back'));
    expect(useAppStore.getState().screen).toBe('browser');
  });

  it('Create opens the painter view, Back there returns to the list', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const user = userEvent.setup();
    renderLivery();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(screen.getByText(T('livery_tab_create')));
    await waitFor(() => {
      // Painter view: canvas + Photoshop-style edge toolbars.
      expect(document.querySelector('.livery-canvas-wrap')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save As' })).toBeInTheDocument();
    });
    // Mine-only header controls hide in create view.
    expect(screen.queryByText('Select All')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    expect(useAppStore.getState().screen).toBe('livery');
  });

  it('header select-all + delete batch-delete end to end', async () => {
    setupMocks({
      'list-liveries': Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] }),
      'delete-livery': Promise.resolve({ success: true }),
    });
    const user = userEvent.setup();
    renderLivery();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(screen.getByText('Select All'));
    await waitFor(() => {
      expect([...document.querySelectorAll('.livery-select')].every(b => b.checked)).toBe(true);
    });
    expect(screen.getByText('Deselect All')).toBeInTheDocument();
    const headerDeleteBtn = screen.getByRole('button', { name: 'Delete' });
    await user.click(headerDeleteBtn);
    await waitFor(() => {
      expect(screen.getByText('Delete 2 selected liveries?')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Delete', { selector: '.btn-danger' }).closest('button'));
    await waitFor(() => {
      expect(mockIpcInvoke).toHaveBeenCalledWith('delete-livery', 'A20N_CCA');
    });
    expect(mockIpcInvoke).toHaveBeenCalledWith('delete-livery', 'B738_AAL');
    await waitFor(() => {
      expect(screen.getByText('Deleted 2 liveries')).toBeInTheDocument();
    });
  });

  it('export / delete header buttons stay disabled until a livery is selected', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] }) });
    const user = userEvent.setup();
    renderLivery();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    const exportBtn = screen.getByRole('button', { name: 'Export' });
    const deleteBtn = screen.getByRole('button', { name: 'Delete' });
    expect(exportBtn).toBeDisabled();
    expect(deleteBtn).toBeDisabled();

    // One selected: both enable.
    await user.click(document.querySelector('.livery-select'));
    await waitFor(() => {
      expect(exportBtn).not.toBeDisabled();
      expect(deleteBtn).not.toBeDisabled();
    });

    // Two selected: export needs a single target, delete still works.
    await user.click(screen.getByText('Select All'));
    await waitFor(() => {
      expect(exportBtn).toBeDisabled();
      expect(deleteBtn).not.toBeDisabled();
    });
  });

  it('header search filters the mine list', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW, ROW2], reference: [] }) });
    const user = userEvent.setup();
    renderLivery();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.type(document.querySelector('.livery-search input'), 'american');
    await waitFor(() => {
      expect(screen.queryByText('Air China')).toBeNull();
    });
    expect(screen.getByText('American Airlines')).toBeInTheDocument();
  });

  it('header Pack button opens the install modal + overlay', async () => {
    setupMocks({
      'download-livery': new Promise(() => {}),
    });
    const user = userEvent.setup();
    renderLivery();
    await user.click(screen.getByText('Pack'));
    await waitFor(() => {
      expect(screen.getByText(/extract it into the game Mods\/ folder/)).toBeInTheDocument();
    });
    const modalInstallBtn = document.querySelector('#modal-box .livery-install-btn');
    expect(modalInstallBtn).toBeInTheDocument();
    expect(modalInstallBtn.textContent).toContain('Install pack');
    await user.click(modalInstallBtn);
    await waitFor(() => {
      expect(document.getElementById('livery-overlay')).toBeInTheDocument();
    });
  });

  it('install modal explains the flow and shows the Mods target', async () => {
    setupMocks();
    useAppStore.setState({ rootPath: 'D:\\Games\\Airport Control 27' });
    const user = userEvent.setup();
    renderLivery();
    await user.click(screen.getByText('Pack'));
    await waitFor(() => {
      expect(screen.getByText(/extract it into the game Mods\/ folder/)).toBeInTheDocument();
    });
    expect(screen.getByText('Install target')).toBeInTheDocument();
    expect(document.querySelector('.livery-install-path').textContent).toContain('Mods');
  });

  it('list help shows only the list-page sections', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    await user.click(document.getElementById('livery-help-btn'));
    await waitFor(() => {
      expect(screen.getByText('Livery Help')).toBeInTheDocument();
    });
    // Only the list section is present.
    const barSection = document.querySelector('#livery-help-bar');
    expect(barSection).toBeInTheDocument();
    expect(document.querySelector('#livery-help-painter')).toBeNull();
    expect(document.querySelector('#livery-help-paint')).toBeNull();
    const barItems = [...barSection.querySelectorAll('.livery-help-item')];
    expect(barItems.length).toBeGreaterThan(0);
    // Every documented chip carries help text (no label-only rows).
    expect(barItems.every(el => el.querySelector('.livery-help-text'))).toBe(true);
    // Painter-only chips are absent.
    expect(screen.queryByText('Import image')).toBeNull();
    expect(screen.queryByText('Import livery')).toBeNull();
  });

  it('painter help shows only the painter sections', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const user = userEvent.setup();
    renderLivery();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(screen.getByText(T('livery_tab_create')));
    await waitFor(() => expect(document.querySelector('.lp-root')).toBeInTheDocument());
    // Painter top-left group: [Back, Help] (help is the icon-only second button).
    const helpBtn = document.querySelectorAll('.lp-topbar .lp-group')[0].querySelectorAll('button')[1];
    await user.click(helpBtn);
    await waitFor(() => expect(screen.getByText('Livery Help')).toBeInTheDocument());
    expect(document.querySelector('#livery-help-painter')).toBeInTheDocument();
    expect(document.querySelector('#livery-help-paint')).toBeInTheDocument();
    // List-only section is absent on the painter page.
    expect(document.querySelector('#livery-help-bar')).toBeNull();
    const paintItems = [...document.querySelectorAll('#livery-help-paint .livery-help-item')];
    expect(paintItems.length).toBeGreaterThan(0);
    expect(paintItems.every(el => el.querySelector('.livery-help-text'))).toBe(true);
  });

  it('Escape closes the help overlay', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    await user.click(document.getElementById('livery-help-btn'));
    await waitFor(() => {
      expect(screen.getByText('Livery Help')).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText('Livery Help')).toBeNull();
    });
  });

  it('backdrop click closes the help overlay', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    await user.click(document.getElementById('livery-help-btn'));
    await waitFor(() => {
      expect(screen.getByText('Livery Help')).toBeInTheDocument();
    });
    fireEvent.click(document.getElementById('livery-help-overlay'));
    await waitFor(() => {
      expect(screen.queryByText('Livery Help')).toBeNull();
    });
  });

  it('header buttons show tooltips on hover, except Create', async () => {
    setupMocks();
    renderLivery();
    fireEvent.mouseEnter(screen.getByText('Pack'));
    const tip = document.body.querySelector('.tooltip-popup');
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain('livery pack');
    fireEvent.mouseLeave(screen.getByText('Pack'));
    // Create carries no tooltip — its label says it all.
    fireEvent.mouseEnter(screen.getByText(T('livery_tab_create')));
    expect(document.body.querySelector('.tooltip-popup')).toBeNull();
  });
});

describe('LiveryScreen unsaved guard + wizard', () => {
  it('prompts before leaving the list for the painter when the guard is dirty', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const user = userEvent.setup();
    renderLivery();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    window.__liveryPaintGuard = { isDirty: () => true };
    await user.click(screen.getByText(T('livery_tab_create')));
    await waitFor(() => expect(screen.getByText('Unsaved Changes')).toBeInTheDocument());
    // Still on the list until Discard.
    expect(screen.queryByRole('button', { name: 'Save As' })).toBeNull();
    await user.click(screen.getByText('Discard').closest('button'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save As' })).toBeInTheDocument());
  });

  it('prompts before Back to the browser when the guard is dirty', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    window.__liveryPaintGuard = { isDirty: () => true };
    await user.click(screen.getByText('Back'));
    await waitFor(() => expect(screen.getByText('Unsaved Changes')).toBeInTheDocument());
    expect(useAppStore.getState().screen).toBe('livery');
    await user.click(screen.getByText('Discard').closest('button'));
    await waitFor(() => expect(useAppStore.getState().screen).toBe('browser'));
  });

  it('clicking a livery card opens the painter prefilled with that livery', async () => {
    setupMocks({ 'list-liveries': Promise.resolve({ success: true, mine: [ROW], reference: [] }) });
    const user = userEvent.setup();
    renderLivery();
    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    await user.click(screen.getByText('Air China').closest('.livery-card'));
    await waitFor(() => expect(document.querySelector('.lp-root')).toBeInTheDocument());
    expect(screen.getByPlaceholderText('CCA').value).toBe('CCA');
  });

  it('the install modal Close button dismisses it', async () => {
    setupMocks();
    const user = userEvent.setup();
    renderLivery();
    await user.click(screen.getByText('Pack'));
    await waitFor(() => expect(document.querySelector('#modal-box')).toBeInTheDocument());
    await user.click(screen.getByText('Close'));
    await waitFor(() => expect(document.querySelector('#modal-box')).toBeNull());
  });
});
