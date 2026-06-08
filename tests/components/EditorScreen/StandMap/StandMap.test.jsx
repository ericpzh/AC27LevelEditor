import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../../../../src/hooks/useTranslation';
import StandMap from '../../../../src/components/EditorScreen/StandMap/StandMap';

const MOCK_STANDS = {
  'G1': { x: 0, y: 0 },
  'G2': { x: 1, y: 1 },
  'G3': { x: 2, y: 2 },
  'G4': { x: 0, y: 2 },
};

const MOCK_CELL_RECT = {
  left: 200, right: 300, top: 150, bottom: 170,
  width: 100, height: 20,
  x: 200, y: 150,
};

function makeCellRef(rect = MOCK_CELL_RECT) {
  const el = document.createElement('td');
  el.getBoundingClientRect = () => rect;
  return { current: el };
}

function renderMap(props = {}) {
  return render(
    <I18nProvider>
      <StandMap
        stands={MOCK_STANDS}
        selectedStand={null}
        occupiedStands={new Set()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        cellRef={makeCellRef()}
        {...props}
      />
    </I18nProvider>
  );
}

describe('StandMap', () => {
  it('renders correct number of stand dots', () => {
    renderMap();
    const dots = document.querySelectorAll('.stand-map-dot');
    expect(dots).toHaveLength(4);
  });

  it('shows stand ID labels', () => {
    renderMap();
    const labels = document.querySelectorAll('.stand-map-label');
    expect(labels).toHaveLength(4);
    const labelTexts = [...labels].map(l => l.textContent);
    expect(labelTexts).toEqual(expect.arrayContaining(['G1', 'G2', 'G3', 'G4']));
  });

  it('highlights the selected stand with "current" class and ring', () => {
    renderMap({ selectedStand: 'G1' });
    const currentDot = document.querySelector('.stand-map-dot.current');
    expect(currentDot).not.toBeNull();

    // Current dot should have a ring
    const ring = document.querySelector('.stand-map-ring');
    expect(ring).not.toBeNull();
  });

  it('marks occupied stands with "occupied" class', () => {
    renderMap({ occupiedStands: new Set(['G2', 'G3']) });
    const occupiedDots = document.querySelectorAll('.stand-map-dot.occupied');
    expect(occupiedDots).toHaveLength(2);
  });

  it('occupied dots are not clickable', () => {
    const onSelect = vi.fn();
    renderMap({ occupiedStands: new Set(['G1']), onSelect });

    const occupiedDot = document.querySelector('.stand-map-dot.occupied');
    expect(occupiedDot).not.toBeNull();
    fireEvent.click(occupiedDot);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clicking an available dot calls onSelect with stand ID', () => {
    const onSelect = vi.fn();
    renderMap({ onSelect });

    const g1Label = [...document.querySelectorAll('.stand-map-label')]
      .find(l => l.textContent === 'G1');
    const g1Dot = g1Label?.parentElement?.querySelector('.stand-map-dot');
    expect(g1Dot).not.toBeNull();
    fireEvent.click(g1Dot);

    expect(onSelect).toHaveBeenCalledWith('G1');
  });

  it('shows hover state on mouse enter and removes on mouse leave', () => {
    renderMap();

    const g2Label = [...document.querySelectorAll('.stand-map-label')]
      .find(l => l.textContent === 'G2');
    const g2Dot = g2Label?.parentElement?.querySelector('.stand-map-dot');
    expect(g2Dot).not.toBeNull();

    // Initially no hovered dots
    expect(document.querySelector('.stand-map-dot.hovered')).toBeFalsy();

    fireEvent.mouseEnter(g2Dot);
    expect(document.querySelector('.stand-map-dot.hovered')).toBeTruthy();

    fireEvent.mouseLeave(g2Dot);
    expect(document.querySelector('.stand-map-dot.hovered')).toBeFalsy();
  });

  it('available and current dots share the same accent fill color', () => {
    renderMap({ selectedStand: 'G1' });

    const currentDot = document.querySelector('.stand-map-dot.current');
    const availableDot = document.querySelector('.stand-map-dot.available');

    expect(currentDot).not.toBeNull();
    expect(availableDot).not.toBeNull();

    // Both use --stand-dot-color which resolves to var(--accent)
    const currentFill = getComputedStyle(currentDot).fill;
    const availableFill = getComputedStyle(availableDot).fill;
    expect(currentFill).toBe(availableFill);
  });

  it('returns null (no portal) when stands is empty', () => {
    render(
      <I18nProvider>
        <StandMap
          stands={{}}
          selectedStand={null}
          occupiedStands={new Set()}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          cellRef={makeCellRef()}
        />
      </I18nProvider>
    );
    expect(document.querySelector('.stand-map-panel')).toBeNull();
  });

  it('returns null when stands is null', () => {
    render(
      <I18nProvider>
        <StandMap
          stands={null}
          selectedStand={null}
          occupiedStands={new Set()}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          cellRef={makeCellRef()}
        />
      </I18nProvider>
    );
    expect(document.querySelector('.stand-map-panel')).toBeNull();
  });

  it('renders legend with 3 indicators', () => {
    renderMap();
    const legendItems = document.querySelectorAll('.stand-map-legend-item');
    expect(legendItems).toHaveLength(3);

    // All items should have non-empty text (translated)
    for (const item of legendItems) {
      expect(item.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    renderMap({ onClose });

    const closeBtn = document.querySelector('.stand-map-close');
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders panel via portal into document.body', () => {
    renderMap();
    const panel = document.querySelector('.stand-map-panel');
    expect(panel).not.toBeNull();
    expect(document.body.contains(panel)).toBe(true);
  });

  it('pins panel to right edge of screen', () => {
    renderMap();
    const panel = document.querySelector('.stand-map-panel');
    expect(panel).not.toBeNull();
    // Panel should have right: 8px (GAP) inline style
    expect(panel.style.right).toBe('8px');
    expect(panel.style.left).toBe('');
  });

  it('sets panel width and height via inline styles', () => {
    renderMap();
    const panel = document.querySelector('.stand-map-panel');
    expect(panel).not.toBeNull();
    // Width and height should be set as inline px values (JS-computed)
    expect(panel.style.width).toMatch(/px$/);
    expect(panel.style.height).toMatch(/px$/);
  });
});
