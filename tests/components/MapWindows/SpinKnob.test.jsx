import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import SpinKnob from '../../../src/components/MapWindows/SpinKnob';

describe('SpinKnob', () => {
  describe('rendering', () => {
    it('renders without label when no label prop', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} />);
      expect(container.querySelector('.spin-knob-svg')).toBeTruthy();
      expect(container.querySelector('.spin-knob-label')).toBeNull();
    });

    it('renders with label when provided', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob label="Zoom" onStep={onStep} />);
      expect(container.querySelector('.spin-knob-label').textContent).toBe('Zoom');
    });

    it('renders SVG elements: bezel, face, ticks, center, indicator, arrow', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} />);
      const svg = container.querySelector('.spin-knob-svg');
      expect(svg).toBeTruthy();
      expect(svg.querySelector('.spin-knob-bezel')).toBeTruthy();
      expect(svg.querySelector('.spin-knob-face')).toBeTruthy();
      expect(svg.querySelector('.spin-knob-center')).toBeTruthy();
      expect(svg.querySelector('.spin-knob-indicator')).toBeTruthy();
      expect(svg.querySelector('.spin-knob-arrow')).toBeTruthy();
      // 8 tick marks
      expect(svg.querySelectorAll('.spin-knob-tick').length).toBe(8);
    });

    it('renders indicator with default angle 0 when no position', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} />);
      const indicator = container.querySelector('.spin-knob-indicator');
      expect(indicator.getAttribute('data-angle')).toBe('0');
    });
  });

  describe('position gauge mode', () => {
    it('sets indicator angle to -135° at position=0 (min)', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} position={0} />);
      const indicator = container.querySelector('.spin-knob-indicator');
      expect(indicator.getAttribute('data-angle')).toBe('-135');
      expect(indicator.getAttribute('transform')).toContain('rotate(-135');
    });

    it('sets indicator angle to 0° at position=0.5 (mid)', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} position={0.5} />);
      const indicator = container.querySelector('.spin-knob-indicator');
      expect(indicator.getAttribute('data-angle')).toBe('0');
    });

    it('sets indicator angle to 135° at position=1 (max)', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} position={1} />);
      const indicator = container.querySelector('.spin-knob-indicator');
      expect(indicator.getAttribute('data-angle')).toBe('135');
    });

    it('clamps position below 0 to 0 (-135°)', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} position={-0.5} />);
      const indicator = container.querySelector('.spin-knob-indicator');
      expect(indicator.getAttribute('data-angle')).toBe('-135');
    });

    it('clamps position above 1 to 1 (135°)', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} position={1.5} />);
      const indicator = container.querySelector('.spin-knob-indicator');
      expect(indicator.getAttribute('data-angle')).toBe('135');
    });

    it('updates indicator when position prop changes', () => {
      const onStep = vi.fn();
      const { container, rerender } = render(<SpinKnob onStep={onStep} position={0.2} />);
      let indicator = container.querySelector('.spin-knob-indicator');
      expect(indicator.getAttribute('data-angle')).toBe('-81'); // 0.2 * 270 - 135

      rerender(<SpinKnob onStep={onStep} position={0.8} />);
      indicator = container.querySelector('.spin-knob-indicator');
      expect(indicator.getAttribute('data-angle')).toBe('81'); // 0.8 * 270 - 135
    });

    it('does not update indicator when position is undefined', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} />);
      const indicator = container.querySelector('.spin-knob-indicator');
      expect(indicator.getAttribute('data-angle')).toBe('0');
    });
  });

  describe('interactions', () => {
    it('calls onStep with +1 on scroll up (deltaY negative)', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} />);
      const wrapper = container.querySelector('.spin-knob-svg-wrapper');
      fireEvent.wheel(wrapper, { deltaY: -100 });
      expect(onStep).toHaveBeenCalledWith(1);
    });

    it('calls onStep with -1 on scroll down (deltaY positive)', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} />);
      const wrapper = container.querySelector('.spin-knob-svg-wrapper');
      fireEvent.wheel(wrapper, { deltaY: 100 });
      expect(onStep).toHaveBeenCalledWith(-1);
    });

    it('calls onReset on click (no drag)', () => {
      const onStep = vi.fn();
      const onReset = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} onReset={onReset} />);
      const wrapper = container.querySelector('.spin-knob-svg-wrapper');
      fireEvent.click(wrapper);
      expect(onReset).toHaveBeenCalledTimes(1);
    });

    it('does not call onReset when onReset is not provided', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} />);
      const wrapper = container.querySelector('.spin-knob-svg-wrapper');
      // Should not throw
      fireEvent.click(wrapper);
    });
  });

  describe('SVG path (arrow arc)', () => {
    it('renders the double-arrow arc path', () => {
      const onStep = vi.fn();
      const { container } = render(<SpinKnob onStep={onStep} />);
      const arrow = container.querySelector('.spin-knob-arrow');
      expect(arrow).toBeTruthy();
      const d = arrow.getAttribute('d');
      // Should contain arc commands
      expect(d).toContain('M '); // move-to
      expect(d).toContain('L '); // line-to
      expect(d).toContain('A '); // arc
    });
  });
});
