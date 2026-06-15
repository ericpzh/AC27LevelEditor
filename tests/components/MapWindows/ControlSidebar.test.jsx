import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import ControlSidebar from '../../../src/components/MapWindows/ControlSidebar';

// Wrapper for i18n context
function renderWithI18n(ui) {
  return render(React.createElement(I18nProvider, null, ui));
}

describe('ControlSidebar', () => {
  const noop = vi.fn();

  const defaultProps = {
    zoomStep: noop,
    panHStep: noop,
    panVStep: noop,
    zoomPos: 0.5,
    panHPos: 0.5,
    panVPos: 0.5,
    onResetZoom: noop,
    onResetPanH: noop,
    onResetPanV: noop,
  };

  it('renders 3 spin knobs in the knobs section', () => {
    const { container } = renderWithI18n(<ControlSidebar {...defaultProps} />);
    const knobSection = container.querySelector('.control-sidebar-knobs');
    expect(knobSection).toBeTruthy();
    const knobs = knobSection.querySelectorAll('.spin-knob');
    expect(knobs.length).toBe(3);
  });

  it('renders an actions section', () => {
    const { container } = renderWithI18n(<ControlSidebar {...defaultProps} />);
    expect(container.querySelector('.control-sidebar-actions')).toBeTruthy();
  });

  it('renders children in the actions section', () => {
    const { container } = renderWithI18n(
      <ControlSidebar {...defaultProps}>
        <button data-testid="test-btn">Click</button>
      </ControlSidebar>
    );
    const actions = container.querySelector('.control-sidebar-actions');
    expect(actions.querySelector('[data-testid="test-btn"]')).toBeTruthy();
  });

  it('renders airspaceKnob when provided', () => {
    const airspaceKnob = <div className="airspace-knob-mock" data-testid="airspace-knob" />;
    const { container } = renderWithI18n(
      <ControlSidebar {...defaultProps} airspaceKnob={airspaceKnob} />
    );
    const knobs = container.querySelector('.control-sidebar-knobs');
    expect(knobs.querySelector('[data-testid="airspace-knob"]')).toBeTruthy();
  });

  it('does not render airspaceKnob when not provided', () => {
    const { container } = renderWithI18n(<ControlSidebar {...defaultProps} />);
    const knobs = container.querySelector('.control-sidebar-knobs');
    // Should only have the 3 SpinKnobs, no extra elements
    expect(knobs.querySelectorAll('.spin-knob').length).toBe(3);
  });

  it('passes correct labels to knobs', () => {
    const { container } = renderWithI18n(<ControlSidebar {...defaultProps} />);
    const labels = container.querySelectorAll('.spin-knob-label');
    expect(labels.length).toBe(3);
    // Labels come from i18n — just verify they're non-empty
    labels.forEach(label => {
      expect(label.textContent.length).toBeGreaterThan(0);
    });
  });
});
