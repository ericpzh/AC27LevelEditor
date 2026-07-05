import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import useTooltip from '../../../src/components/BrowserScreen/useTooltip';

function TooltipDemo({ text }) {
  const { bind, TooltipPortal } = useTooltip();
  return (
    <div>
      <button {...bind(text)} data-testid="target">Hover me</button>
      {TooltipPortal}
    </div>
  );
}

beforeEach(() => {
  document.body.querySelectorAll('.tooltip-popup').forEach(el => el.remove());
});

const EST_H = 40;
const ARROW_H = 6;

/** Get the tooltip element currently in the portal */
function getTip() {
  return document.querySelector('.tooltip-popup');
}

describe('useTooltip', () => {
  it('does NOT render a tooltip initially', () => {
    render(<TooltipDemo text="Hello tooltip" />);
    expect(getTip()).toBeNull();
  });

  it('renders a portal tooltip on mouseEnter and hides on mouseLeave', () => {
    render(<TooltipDemo text="Hello tooltip" />);
    const btn = screen.getByTestId('target');

    fireEvent.mouseEnter(btn);

    const tip = getTip();
    expect(tip).not.toBeNull();
    expect(tip.textContent).toBe('Hello tooltip');

    fireEvent.mouseLeave(btn);

    expect(getTip()).toBeNull();
  });

  it('shows different text when bound with different strings', () => {
    function Multi() {
      const { bind, TooltipPortal } = useTooltip();
      return (
        <div>
          <button {...bind('Tip A')} data-testid="a">A</button>
          <button {...bind('Tip B')} data-testid="b">B</button>
          {TooltipPortal}
        </div>
      );
    }
    render(<Multi />);

    fireEvent.mouseEnter(screen.getByTestId('a'));
    expect(getTip().textContent).toBe('Tip A');

    fireEvent.mouseLeave(screen.getByTestId('a'));

    fireEvent.mouseEnter(screen.getByTestId('b'));
    expect(getTip().textContent).toBe('Tip B');
  });

  it('positions tooltip box entirely above the button', () => {
    render(<TooltipDemo text="Position test" />);
    const btn = screen.getByTestId('target');

    btn.getBoundingClientRect = () => ({
      top: 200, bottom: 230, left: 500, right: 580, width: 80, height: 30,
    });

    fireEvent.mouseEnter(btn);

    expect(parseFloat(getTip().style.top)).toBeCloseTo(154, 0);
  });

  it('flips tooltip below when insufficient space above', () => {
    render(<TooltipDemo text="Flip test" />);
    const btn = screen.getByTestId('target');

    btn.getBoundingClientRect = () => ({
      top: 30, bottom: 60, left: 500, right: 580, width: 80, height: 30,
    });

    fireEvent.mouseEnter(btn);

    const tip = getTip();
    expect(parseFloat(tip.style.top)).toBe(66);
    expect(tip.querySelector('.tooltip-arrow.up')).not.toBeNull();
  });

  it('centres tooltip on the button when not near edges', () => {
    render(<TooltipDemo text="Centre test" />);
    const btn = screen.getByTestId('target');

    btn.getBoundingClientRect = () => ({
      top: 200, bottom: 230, left: 400, right: 500, width: 100, height: 30,
    });

    fireEvent.mouseEnter(btn);

    const tip = getTip();
    // 66 + BASE(10) = 76. halfW=38
    expect(parseFloat(tip.style.left)).toBeCloseTo(450, 0);
    expect(tip.style.transform).toBe('translateX(-50%)');
    expect(parseFloat(tip.style.width)).toBeCloseTo(76, 0);
    expect(parseFloat(tip.querySelector('.tooltip-arrow').style.left)).toBeCloseTo(38, 0);
  });

  it('right-pins tooltip when button is near right viewport edge', () => {
    render(<TooltipDemo text="Clamp test" />);
    const btn = screen.getByTestId('target');

    btn.getBoundingClientRect = () => ({
      top: 200, bottom: 230,
      left: window.innerWidth - 20, right: window.innerWidth,
      width: 20, height: 30,
    });

    fireEvent.mouseEnter(btn);

    const tip = getTip();
    // 62.5 + BASE(10) = 72.5 → 73
    const w = 73;
    expect(parseFloat(tip.style.left)).toBe(window.innerWidth - w - 10);
    expect(tip.style.transform).toBe('translateX(0)');
    // arrowPx = w, clamped to w - 8 = 65
    expect(parseFloat(tip.querySelector('.tooltip-arrow').style.left)).toBe(65);
  });

  it('computes correct width from text characters', () => {
    render(
      <TooltipDemo text="This is a much longer tooltip text to test width computation" />
    );
    const btn = screen.getByTestId('target');

    btn.getBoundingClientRect = () => ({
      top: 200, bottom: 230, left: 400, right: 500, width: 100, height: 30,
    });

    fireEvent.mouseEnter(btn);

    // Per-char sum + BASE(10)
    expect(parseFloat(getTip().style.width)).toBeGreaterThan(340);
    expect(parseFloat(getTip().style.width)).toBeLessThan(360);
  });

  it('has correct CSS classes on the tooltip', () => {
    render(<TooltipDemo text="CSS test" />);
    const btn = screen.getByTestId('target');

    fireEvent.mouseEnter(btn);

    const tip = getTip();
    expect(tip).not.toBeNull();
    expect(tip.classList.contains('tooltip-popup')).toBe(true);
    expect(tip.querySelector('.tooltip-arrow')).not.toBeNull();
  });
});
