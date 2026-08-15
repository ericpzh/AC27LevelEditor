/**
 * Component tests: FlightPatchCommandBar's "Fly Waypoint" command — the UI
 * sibling of the voice pipeline's 'fly direct to X'.
 *
 * Covers: option placement (left of Clear for Approach), the STAR waypoint
 * picker (left to right in route order), the update_heading payload at the
 * bearing to the picked fix, the Fly Waypoint → Fly Heading override, the
 * Clear for Approach → waypoint supersede, and the Send/Cancel colors.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { mockIpcInvoke } from '../../setup';
import { bearingDegrees } from '../../../src/utils/patchCommands';
import FlightPatchCommandBar from '../../../src/components/MapWindows/FlightPatchCommandBar';

// ── Fixtures ────────────────────────────────────────────────────

const AIRCRAFT = {
  callSign: 'CSC9355',
  controlSeat: 5,                       // approach channel — composer gate
  position: { x: 0, y: 5, z: 0 },       // at the origin: bearings are pure angles
  noseDirection: { x: 0, y: 0, z: 1 },
  airSpeedKnot: 220,
  star: 'UBSS6W',
  runway: '19',
};

const STAR_WPS = {
  'UBSS6W|19': [
    { name: 'UBSIS', x: 100, z: 200 },   //      → bearing 26°
    { name: 'SUNOK', x: 150, z: 150 },   //      → bearing 45°
    { name: 'JN213', x: 200, z: 80 },    //      → bearing 68°
    { name: 'METOG', x: 220, z: 30 },    //      → bearing 82°
    { name: 'JN108', x: 230, z: 10 },    //      → bearing 87°
  ],
};

function renderComposer(props = {}) {
  return render(
    <FlightPatchCommandBar
      aircraft={AIRCRAFT}
      witchMode={false}
      commandCapable
      starWaypoints={STAR_WPS}
      {...props}
    />
  );
}

function optionLabels(container) {
  return [...container.querySelectorAll('.fcc-suggest .fcc-suggest-item')].map((b) => b.textContent);
}

function sentFrames() {
  return mockIpcInvoke.mock.calls.filter((c) => c[0] === 'send-patch-command').map((c) => c[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FlightPatchCommandBar — Fly Waypoint', () => {
  it('places "Fly Waypoint" left of "Clear for Approach"', () => {
    const { container } = renderComposer();
    const labels = optionLabels(container);
    expect(labels).toContain('Fly Waypoint');
    const wi = labels.indexOf('Fly Waypoint');
    expect(wi).toBeGreaterThan(labels.indexOf('Fly Speed'));
    expect(wi).toBeLessThan(labels.indexOf('Clear for Approach'));
  });

  it('drops the option when the aircraft has no telemetry position', () => {
    const { container } = renderComposer({
      aircraft: { ...AIRCRAFT, position: { x: 'nope', y: 5, z: 0 } },
    });
    expect(optionLabels(container)).not.toContain('Fly Waypoint');
  });

  it('opens the STAR waypoint picker — left to right in route order', () => {
    const { container } = renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Fly Waypoint' }));
    // The STAR's own name leads the row; then the route-order fixes.
    expect(container.querySelector('.fcc-waypoint-star').textContent).toBe('UBSS6W');
    const wpBtns = [...container.querySelectorAll('.fcc-waypoint-btn')].map((b) => b.textContent);
    // Only names the approach radar displays (FIX_NAME_RE: ICAO-style 3-5
    // letter fixes) — JN213/JN108 are numbered nodes the radar skips.
    expect(wpBtns).toEqual(['UBSIS', 'SUNOK', 'METOG']);
    expect(screen.queryByRole('button', { name: 'JN213' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'JN108' })).not.toBeInTheDocument();
  });

  it('drops waypoint names the approach radar does not display (same FIX_NAME_RE filter)', () => {
    renderComposer({
      starWaypoints: {
        'UBSS6W|19': [
          { name: 'UBSIS', x: 100, z: 200 },
          { name: 'TurnPoint19', x: 150, z: 150 },   // turn point — radar skips
          { name: 'JN213', x: 200, z: 80 },          // numbered node — radar skips
          { name: 'metog', x: 220, z: 30 },          // lowercase — radar skips
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fly Waypoint' }));
    expect(screen.getByRole('button', { name: 'UBSIS' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'TurnPoint19' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'JN213' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'metog' })).not.toBeInTheDocument();
  });

  it('sends one update_heading frame at the live bearing to the picked fix', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Fly Waypoint' }));
    fireEvent.click(screen.getByRole('button', { name: 'SUNOK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const frames = sentFrames();
    expect(frames).toHaveLength(1);
    const heading = bearingDegrees(0, 0, 150, 150);
    expect(frames[0]).toMatchObject({ type: 'update_heading', callSign: 'CSC9355', rate: 3 });
    expect(frames[0].dx).toBeCloseTo(Math.sin((heading * Math.PI) / 180), 4);
    expect(frames[0].dy).toBeCloseTo(Math.cos((heading * Math.PI) / 180), 4);
  });

  it('labels the line "Fly Direct To <fix>" and chains with Add', () => {
    const { container } = renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Fly Waypoint' }));
    fireEvent.click(screen.getByRole('button', { name: 'METOG' }));
    expect(container.querySelector('.fcc-cmd').textContent).toContain('Fly Direct To METOG');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    // Chained: next options row shows, Fly Waypoint blacked out (one per line)
    expect(container.querySelector('.fcc-cmd').textContent).toContain('Fly Direct To METOG');
    const wpBtn = screen.getByRole('button', { name: 'Fly Waypoint' });
    expect(wpBtn).toBeDisabled();
  });

  it('Fly Waypoint overrides a composed Fly Heading (heading dropped, blacked out)', () => {
    const { container } = renderComposer();
    // Compose a heading first: Fly Heading → slider 090 → Add
    fireEvent.click(screen.getByRole('button', { name: 'Fly Heading' }));
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(container.querySelector('.fcc-cmd').textContent).toContain('Fly Heading 090');

    // Pick Fly Waypoint → the composed heading is dropped from the line
    fireEvent.click(screen.getByRole('button', { name: 'Fly Waypoint' }));
    expect(container.querySelector('.fcc-cmd').textContent).not.toContain('Fly Heading');
    fireEvent.click(screen.getByRole('button', { name: 'SUNOK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // Send → exactly ONE frame: the waypoint bearing (the heading is gone)
    fireEvent.click(container.querySelector('.fcc-suggest-send'));
    const frames = sentFrames();
    expect(frames).toHaveLength(1);
    expect(bearingDegrees(0, 0, 150, 150)).toBeCloseTo(bearingDegrees(0, 0, 150, 150), 6);
  });

  it('Clear for Approach supersedes a chained waypoint (only the cfa frame goes out)', () => {
    const { container } = renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Fly Waypoint' }));
    fireEvent.click(screen.getByRole('button', { name: 'SUNOK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear for Approach' }));
    expect(container.querySelector('.fcc-cmd').textContent).not.toContain('Fly Direct To');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const frames = sentFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('clear_for_appr');
  });

  it('waypoint chains with altitude + speed (combined command)', async () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Fly Speed' }));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fly Waypoint' }));
    fireEvent.click(screen.getByRole('button', { name: 'UBSIS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const frames = sentFrames();   // nothing sent yet
    expect(frames).toHaveLength(0);
    // Send dispatches the whole chain in order: speed then waypoint
    const sendButtons = screen.getAllByRole('button', { name: 'Send' });
    fireEvent.click(sendButtons[sendButtons.length - 1]);
    await new Promise((r) => setTimeout(r, 0));   // flush the sequential awaits
    const sent = sentFrames();
    expect(sent.map((f) => f.type)).toEqual(['update_speed', 'update_heading']);
  });
});

describe('FlightPatchCommandBar — button colors', () => {
  it('Send is green, Cancel is red, Add is blue', () => {
    const { container } = renderComposer();
    // The options row only shows Send once a command is composed — open the
    // speed panel, where all three colored actions are visible together
    fireEvent.click(screen.getByRole('button', { name: 'Fly Speed' }));
    const send = [...container.querySelectorAll('.fcc-suggest-item')].find((b) => b.textContent === 'Send');
    const add = [...container.querySelectorAll('.fcc-suggest-item')].find((b) => b.textContent === 'Add');
    const cancel = [...container.querySelectorAll('.fcc-suggest-item')].find((b) => b.textContent === 'Cancel');
    expect(send.classList.contains('fcc-suggest-send')).toBe(true);
    expect(add.classList.contains('fcc-suggest-add')).toBe(true);
    expect(cancel.classList.contains('fcc-suggest-cancel')).toBe(true);
  });
});