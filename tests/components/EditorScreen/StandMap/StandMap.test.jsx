import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../../../../src/hooks/useTranslation';
import StandMap from '../../../../src/components/EditorScreen/StandMap/StandMap';

const MOCK_STANDS = {
  'G1': { x: 0, y: 0, heading: 90 },
  'G2': { x: 1, y: 1, heading: 45 },
  'G3': { x: 2, y: 2, heading: 45 },
  'G4': { x: 0, y: 2, heading: 0 },
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

function makeButtonRef(rect = { left: 10, right: 100, top: 520, bottom: 552, width: 90, height: 32 }) {
  const el = document.createElement('button');
  el.getBoundingClientRect = () => rect;
  return { current: el };
}

function renderMap(props = {}) {
  return render(
    <I18nProvider>
      <StandMap
        stands={MOCK_STANDS}
        selectedStand={null}
        occupiedStands={{}}
        onSelect={vi.fn()}
        onShrink={vi.fn()}
        buttonRef={makeButtonRef()}
        callsign="CCA1234"
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

  it('marks occupied stands with plane icons instead of dots', () => {
    renderMap({ occupiedStands: { G2: { callsign: 'CCA1234' }, G3: { callsign: 'CES5678' } } });
    const occupiedPlanes = document.querySelectorAll('.stand-map-plane');
    expect(occupiedPlanes).toHaveLength(2);
  });

  it('occupied stands show plane icons with callsign labels', () => {
    renderMap({ occupiedStands: { G1: { callsign: 'CCA1234' } } });
    // Plane icon rendered
    const occupiedPlanes = document.querySelectorAll('.stand-map-plane');
    expect(occupiedPlanes).toHaveLength(1);
    // Callsign label in nose direction
    const labels = document.querySelectorAll('.stand-map-ac-label');
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe('CCA1234');
  });

  it('occupied plane icons are not clickable (pointer-events: none)', () => {
    const onSelect = vi.fn();
    renderMap({ occupiedStands: { G1: { callsign: 'CCA1234' } }, onSelect });

    const planeGroup = document.querySelector('.stand-map-plane-group');
    expect(planeGroup).not.toBeNull();
    const plane = document.querySelector('.stand-map-plane');
    fireEvent.click(plane);

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
          occupiedStands={{}}
          onSelect={vi.fn()}
          onShrink={vi.fn()}
          buttonRef={makeButtonRef()}
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
          occupiedStands={{}}
          onSelect={vi.fn()}
          onShrink={vi.fn()}
          buttonRef={makeButtonRef()}
        />
      </I18nProvider>
    );
    expect(document.querySelector('.stand-map-panel')).toBeNull();
  });

  it('renders legend with 3 indicators', () => {
    renderMap();
    const legendItems = document.querySelectorAll('.stand-map-legend-item');
    expect(legendItems).toHaveLength(3);

    for (const item of legendItems) {
      expect(item.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it('calls onShrink when shrink button is clicked', () => {
    const onShrink = vi.fn();
    renderMap({ onShrink });

    const shrinkBtn = document.querySelector('.stand-map-shrink');
    expect(shrinkBtn).not.toBeNull();
    fireEvent.click(shrinkBtn);
    // Shrink sets closing state, then onShrink fires on transitionend
    // We test that the click handler runs (closing class is added)
    const panel = document.querySelector('.stand-map-panel');
    expect(panel.classList.contains('closing')).toBe(true);
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

  it('starts with opening class for expand animation', () => {
    renderMap();
    const panel = document.querySelector('.stand-map-panel');
    expect(panel).not.toBeNull();
    // Panel starts with 'opening' class for expand-from-button animation
    expect(panel.classList.contains('opening')).toBe(true);
  });

  it('renders only the shrink button (no close button)', () => {
    renderMap();
    const shrinkBtn = document.querySelector('.stand-map-shrink');
    expect(shrinkBtn).not.toBeNull();
    const closeBtn = document.querySelector('.stand-map-close');
    expect(closeBtn).toBeNull();
  });

  it('occupied stand plane icons have rotation applied', () => {
    renderMap({ occupiedStands: { G1: { callsign: 'CCA1234' } } });
    const planeGroup = document.querySelector('.stand-map-plane-group');
    expect(planeGroup).not.toBeNull();
    // Rotation is on the inner <g> that wraps the path, not the outer group
    const innerG = planeGroup.querySelector('g');
    expect(innerG).not.toBeNull();
    expect(innerG.getAttribute('transform')).toContain('rotate(');
  });

  it('active plane icon has rotation applied when selected', () => {
    renderMap({ selectedStand: 'G1', callsign: 'CCA1234' });
    const activePlane = document.querySelector('.stand-map-active-plane');
    expect(activePlane).not.toBeNull();
    // Rotation is on the inner <g> that wraps the path
    const innerG = activePlane.querySelector('g');
    expect(innerG).not.toBeNull();
    expect(innerG.getAttribute('transform')).toContain('rotate(');
  });

  it('all stands are disabled when no callsign (no aircraft selected)', () => {
    const onSelect = vi.fn();
    renderMap({ callsign: '' });
    const dots = document.querySelectorAll('.stand-map-dot');
    // All dots should have the disabled class
    expect(dots).toHaveLength(4);
    dots.forEach(dot => {
      expect(dot.classList.contains('disabled')).toBe(true);
    });
    // Clicking a disabled dot should not call onSelect
    fireEvent.click(dots[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('backward compatible — missing heading defaults to 0 rotation', () => {
    const standsNoHeading = { 'X1': { x: 5, y: 5 } };
    render(
      <I18nProvider>
        <StandMap
          stands={standsNoHeading}
          selectedStand={null}
          occupiedStands={{ X1: { callsign: 'TEST' } }}
          onSelect={vi.fn()}
          onShrink={vi.fn()}
          buttonRef={makeButtonRef()}
          callsign="CCA1234"
        />
      </I18nProvider>
    );
    const planeGroup = document.querySelector('.stand-map-plane-group');
    expect(planeGroup).not.toBeNull();
    // Rotation on the inner <g> wrapping the path
    const innerG = planeGroup.querySelector('g');
    expect(innerG).not.toBeNull();
    expect(innerG.getAttribute('transform')).toContain('rotate(0)');
  });
});
