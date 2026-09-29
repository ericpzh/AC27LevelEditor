// @vitest-environment jsdom

/**
 * MyLiveriesTab warm 3D snapshot cache.
 *
 * Regression guard for the "loading animation every time I enter the list"
 * report: the offscreen snapshot URL cache survives leaving the livery page
 * (releaseLiveryRenderer keeps it), so a re-entry paints every card from the
 * warm cache on the first frame — no shimmer skeleton, and no re-read of the
 * model binary / full 2048² texture.
 *
 * The real renderer needs WebGL (absent in jsdom) and the module is mocked here
 * so we can assert which snapshots are considered "current" without rendering.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MyLiveriesTab from '../../../src/components/LiveryScreen/MyLiveriesTab';
import Modal from '../../../src/components/common/Modal';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';
import { mockIpcInvoke } from '../../setup';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

const H = vi.hoisted(() => ({ cache: new Map(), snapshots: [] }));

vi.mock('../../../src/utils/livery3d', () => ({
  getCachedLiverySnapshot: (key) => {
    const e = H.cache.get(key);
    return e ? e.url : null;
  },
  isLiverySnapshotCurrent: (key, rev) => {
    const e = H.cache.get(key);
    return Boolean(e) && e.rev === String(rev ?? '');
  },
  renderLiverySnapshot: vi.fn(async ({ key }) => { H.snapshots.push(key); return null; }),
}));

const ROW = {
  folder: 'A20N_CCA',
  id: 'a20n_cca_default',
  name: 'A20N CCA Default Livery',
  airline: 'CCA',
  targetPlaneId: 'AIRBUS A-320neo',
  hasBasePng: true,
  imgMtime: 123,
  mtime: 0,
};

function renderMine(props = {}) {
  return render(
    <I18nProvider>
      <MyLiveriesTab cmdRef={{ current: {} }} onBarState={() => {}} {...props} />
      <Modal />
      <Toast />
    </I18nProvider>
  );
}

beforeEach(() => {
  setLang('en');
  useAppStore.setState(useAppStore.getInitialState());
  H.cache.clear();
  H.snapshots.length = 0;
  mockIpcInvoke.mockReset();
  mockIpcInvoke.mockImplementation((channel) => {
    if (channel === 'list-liveries') return Promise.resolve({ success: true, mine: [ROW], reference: [] });
    if (channel === 'read-livery-image') return Promise.resolve({ success: true, imageDataUrl: 'data:image/png;base64,NEW' });
    if (channel === 'livery-3d-bin') return Promise.resolve({ success: true, parts: [], bin: new Uint8Array(0) });
    return Promise.resolve({});
  });
});

describe('MyLiveriesTab warm 3D snapshot cache', () => {
  it('paints a current cached snapshot without re-reading the model or texture', async () => {
    H.cache.set('mine:A20N_CCA', { url: 'data:image/png;base64,WARM', rev: '123' });
    renderMine({ modelPack: { 'AIRBUS A-320neo': {} } });

    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    const img = document.querySelector('.livery-thumb img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('data:image/png;base64,WARM');
    // The warm hit short-circuits before any bin/texture read for this livery.
    expect(H.snapshots).not.toContain('mine:A20N_CCA');
    expect(mockIpcInvoke.mock.calls.some(c => c[0] === 'read-livery-image' && c[1] === 'A20N_CCA')).toBe(false);
    expect(mockIpcInvoke.mock.calls.some(c => c[0] === 'livery-3d-bin')).toBe(false);
  });

  it('re-renders when the cached revision is stale, while showing the old image meanwhile', async () => {
    H.cache.set('mine:A20N_CCA', { url: 'data:image/png;base64,OLD', rev: '111' });
    renderMine({ modelPack: { 'AIRBUS A-320neo': {} } });

    await waitFor(() => expect(screen.getByText('Air China')).toBeInTheDocument());
    // Even a stale entry is shown synchronously (no shimmer), then refreshed.
    expect(document.querySelector('.livery-thumb img').getAttribute('src')).toBe('data:image/png;base64,OLD');
    await waitFor(() => expect(H.snapshots).toContain('mine:A20N_CCA'));
    expect(mockIpcInvoke.mock.calls.some(c => c[0] === 'read-livery-image' && c[1] === 'A20N_CCA')).toBe(true);
  });
});
