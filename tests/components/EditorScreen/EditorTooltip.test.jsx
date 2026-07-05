import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { BUTTONS } from '../../../src/components/EditorScreen/TutorialOverlay';
import useTooltip from '../../../src/components/BrowserScreen/useTooltip';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

beforeEach(() => {
  setLang('en');
  document.body.querySelectorAll('.tooltip-popup').forEach(el => el.remove());
});

// ── Verify BUTTONS registry is complete ──────────────────────
describe('Editor BUTTONS registry', () => {
  it('has descKey for every registered button', () => {
    Object.entries(BUTTONS).forEach(([key, btn]) => {
      expect(btn).toHaveProperty('descKey');
      expect(typeof btn.descKey).toBe('string');
      expect(btn.descKey.length).toBeGreaterThan(0);
    });
  });

  it('has icon for every registered button', () => {
    Object.entries(BUTTONS).forEach(([key, btn]) => {
      expect(btn).toHaveProperty('icon');
      expect(typeof btn.icon).toBe('function');
    });
  });

  it('includes all required toolbar buttons', () => {
    const required = [
      'addArrival', 'addDeparture', 'copy', 'deleteSelected', 'find',
      'back', 'lang', 'help', 'save', 'backup', 'restore', 'import',
      'saveAs', 'selectAll', 'starMap', 'standMap', 'chat',
    ];
    required.forEach(key => {
      expect(BUTTONS).toHaveProperty(key);
      expect(BUTTONS[key]).toHaveProperty('descKey');
    });
  });

  it('all buttons can be bound and trigger tooltips', () => {
    function KeyChecker() {
      const { bind, TooltipPortal } = useTooltip();
      return (
        <div>
          {Object.entries(BUTTONS).map(([key, btn]) => (
            <button key={key} {...bind(btn.descKey)} data-testid={`btn-${key}`}>
              {key}
            </button>
          ))}
          {TooltipPortal}
        </div>
      );
    }
    const { getByTestId } = render(
      <I18nProvider>
        <KeyChecker />
      </I18nProvider>
    );

    // Fire mouseEnter on each button and verify tooltip appears
    Object.keys(BUTTONS).forEach(key => {
      const btn = getByTestId(`btn-${key}`);
      fireEvent.mouseEnter(btn);
      const tip = document.body.querySelector('.tooltip-popup');
      expect(tip).not.toBeNull();
      expect(tip.textContent).toBe(BUTTONS[key].descKey);
      fireEvent.mouseLeave(btn);
    });
  });
});

// ── Integration: tooltip with editor button text ─────────────
describe('Editor tooltip integration', () => {
  function EditorToolbarStub() {
    const { bind, TooltipPortal } = useTooltip();
    return (
      <div>
        <button {...bind('Add a new arrival flight')} data-testid="add-arr">
          Add Arrival
        </button>
        <button {...bind('Add a new departure flight')} data-testid="add-dep">
          Add Departure
        </button>
        <button {...bind('Copy selected flights')} data-testid="copy">
          Copy
        </button>
        <button {...bind('Delete selected flights')} data-testid="delete">
          Delete
        </button>
        <button {...bind('Search flights by callsign')} data-testid="find">
          Find
        </button>
        <button {...bind('Save changes to file')} data-testid="save">
          Save
        </button>
        <button {...bind('Return to the level browser')} data-testid="back">
          Back
        </button>
        {TooltipPortal}
      </div>
    );
  }

  it('shows tooltip on editor Add Arrival button hover', () => {
    const { getByTestId } = render(
      <I18nProvider>
        <EditorToolbarStub />
      </I18nProvider>
    );

    fireEvent.mouseEnter(getByTestId('add-arr'));
    const tip = document.body.querySelector('.tooltip-popup');
    expect(tip).not.toBeNull();
    expect(tip.textContent).toBe('Add a new arrival flight');
  });

  it('shows tooltip on editor Save button hover and hide on leave', () => {
    const { getByTestId } = render(
      <I18nProvider>
        <EditorToolbarStub />
      </I18nProvider>
    );

    const saveBtn = getByTestId('save');
    fireEvent.mouseEnter(saveBtn);
    expect(document.body.querySelector('.tooltip-popup').textContent).toBe('Save changes to file');

    fireEvent.mouseLeave(saveBtn);
    expect(document.body.querySelector('.tooltip-popup')).toBeNull();
  });

  it('switches tooltip text when moving between buttons', () => {
    const { getByTestId } = render(
      <I18nProvider>
        <EditorToolbarStub />
      </I18nProvider>
    );

    fireEvent.mouseEnter(getByTestId('add-arr'));
    expect(document.body.querySelector('.tooltip-popup').textContent).toBe('Add a new arrival flight');

    fireEvent.mouseLeave(getByTestId('add-arr'));

    fireEvent.mouseEnter(getByTestId('delete'));
    expect(document.body.querySelector('.tooltip-popup').textContent).toBe('Delete selected flights');
  });

  it('all toolbar buttons trigger and clear tooltips', () => {
    const { getByTestId } = render(
      <I18nProvider>
        <EditorToolbarStub />
      </I18nProvider>
    );

    ['add-arr', 'add-dep', 'copy', 'delete', 'find', 'save', 'back'].forEach(tid => {
      const btn = getByTestId(tid);
      fireEvent.mouseEnter(btn);
      expect(document.body.querySelector('.tooltip-popup')).not.toBeNull();
      fireEvent.mouseLeave(btn);
      expect(document.body.querySelector('.tooltip-popup')).toBeNull();
    });
  });
});
