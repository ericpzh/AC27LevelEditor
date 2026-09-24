import { describe, it, expect } from 'vitest';
import {
  PTT_SHORTCUT_DEFAULT,
  normalizeAccelerator,
  isValidAccelerator,
  buildAcceleratorFromEvent,
} from '../../src/utils/pttShortcut';

describe('pttShortcut', () => {
  it('defaults to Shift+Space', () => {
    expect(PTT_SHORTCUT_DEFAULT).toBe('Shift+Space');
    expect(isValidAccelerator(PTT_SHORTCUT_DEFAULT)).toBe(true);
  });

  it('normalizes user input to canonical Electron form', () => {
    expect(normalizeAccelerator('shift + space')).toBe('Shift+Space');
    expect(normalizeAccelerator('Ctrl+Alt+p')).toBe('Ctrl+Alt+P');
    expect(normalizeAccelerator('  F9  ')).toBe('F9');
    expect(normalizeAccelerator('')).toBe('');
    expect(normalizeAccelerator('Shift')).toBe(null);
    expect(normalizeAccelerator('Space+Shift+Space')).toBe(null);
    expect(normalizeAccelerator('Shift+F99')).toBe(null); // F-number out of range
    expect(normalizeAccelerator('Ctrl+Ctrl+A')).toBe(null); // duplicate modifier
  });

  it('rejects bare keys that would swallow typing', () => {
    expect(isValidAccelerator('A')).toBe(false);
    expect(isValidAccelerator('Space')).toBe(false);
    expect(isValidAccelerator('')).toBe(false);
    expect(isValidAccelerator('Ctrl+A')).toBe(true);
    expect(isValidAccelerator('F12')).toBe(true);
  });

  it('builds accelerators from capture keydown events', () => {
    // Shift+Space
    expect(buildAcceleratorFromEvent({ key: ' ', code: 'Space', shiftKey: true })).toBe('Shift+Space');
    // Ctrl+Alt+P
    expect(buildAcceleratorFromEvent({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+P');
    // Modifier-only keeps waiting
    expect(buildAcceleratorFromEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })).toBe('');
    // Bare F-key is allowed
    expect(buildAcceleratorFromEvent({ key: 'F9', code: 'F9' })).toBe('F9');
    // Tab participates like a normal key
    expect(buildAcceleratorFromEvent({ key: 'Tab', code: 'Tab' })).toBe('Tab');
    // Unusable keys are rejected
    expect(buildAcceleratorFromEvent({ key: 'Enter', code: 'Enter' })).toBe(null);
    expect(buildAcceleratorFromEvent({ key: '?', code: 'Digit1', shiftKey: true })).toBe(null);
  });
});
