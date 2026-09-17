import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import LiveryColorPicker from '../../../src/components/LiveryScreen/LiveryColorPicker';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

// The picker renders through a portal into document.body and positions itself
// from the anchor's client rect, so every geometry read is stubbed.
let rectSpy;

beforeEach(() => {
  setLang('en');
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {},
  });
});

afterEach(() => {
  rectSpy.mockRestore();
});

function renderPicker({
  color = '#ff0000',
  opacity = 1,
  anchor = { x: 10, y: 20 },
  onChange = vi.fn(),
  onClose = vi.fn(),
} = {}) {
  const utils = render(
    <I18nProvider>
      <LiveryColorPicker
        color={color} opacity={opacity} anchor={anchor}
        onChange={onChange} onClose={onClose}
      />
    </I18nProvider>
  );
  return { onChange, onClose, ...utils };
}

describe('LiveryColorPicker', () => {
  it('renders the hue/alpha/hex controls in a body portal at the anchor', () => {
    renderPicker();
    const dialog = screen.getByRole('dialog', { name: 'Color' });
    expect(dialog.parentElement).toBe(document.body); // portalled out of the tool rail
    expect(dialog.style.left).toBe('10px');
    expect(dialog.style.top).toBe('20px');
    expect(within(dialog).getByRole('slider', { name: 'Hue' }).value).toBe('0');
    expect(within(dialog).getByRole('slider', { name: 'Opacity' }).value).toBe('1');
    expect(within(dialog).getByRole('slider', { name: 'Colour area' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Hex colour').value).toBe('#ff0000');
    expect(within(dialog).getByText('100%')).toBeInTheDocument();
  });

  it('dragging the saturation/value square emits the colour and keeps the opacity', () => {
    const { onChange } = renderPicker({ opacity: 0.5 });
    const sv = screen.getByRole('slider', { name: 'Colour area' });
    // jsdom rect is 200×100 → centre = s 0.5, v 0.5 → #804040.
    fireEvent.pointerDown(sv, { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
    fireEvent.pointerMove(sv, { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sv, { pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith({ color: '#804040', opacity: 0.5 });
  });

  it('the hue rail re-derives the colour', () => {
    const { onChange } = renderPicker();
    fireEvent.change(screen.getByRole('slider', { name: 'Hue' }), { target: { value: '240' } });
    expect(onChange).toHaveBeenLastCalledWith({ color: '#0000ff', opacity: 1 });
  });

  it('the alpha rail emits the opacity without changing the colour', () => {
    const { onChange } = renderPicker();
    fireEvent.change(screen.getByRole('slider', { name: 'Opacity' }), { target: { value: '0.4' } });
    expect(onChange).toHaveBeenLastCalledWith({ color: '#ff0000', opacity: 0.4 });
  });

  it('commits a hex on blur and on Enter, ignoring malformed input', () => {
    const { onChange } = renderPicker();
    const hex = screen.getByLabelText('Hex colour');

    fireEvent.change(hex, { target: { value: '#00ff00' } });
    fireEvent.blur(hex);
    expect(onChange).toHaveBeenLastCalledWith({ color: '#00ff00', opacity: 1 });

    fireEvent.change(hex, { target: { value: '#00f' } }); // 3-digit shorthand
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ color: '#0000ff', opacity: 1 });

    const calls = onChange.mock.calls.length;
    fireEvent.change(hex, { target: { value: 'nope' } });
    fireEvent.blur(hex);
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it('Escape closes the picker (window listener)', () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape in the hex field closes the picker', () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(screen.getByLabelText('Hex colour'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the backdrop closes on pointerdown and on right-click', () => {
    const { onClose } = renderPicker();
    const backdrop = document.querySelector('.lp-color-backdrop');
    expect(backdrop).toBeTruthy();
    fireEvent.pointerDown(backdrop, { button: 0 });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the hue across achromatic colours and updates it for saturated ones', () => {
    const props = { opacity: 1, anchor: { x: 0, y: 0 }, onChange: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(
      <I18nProvider><LiveryColorPicker color="#00ff00" {...props} /></I18nProvider>
    );
    expect(screen.getByRole('slider', { name: 'Hue' }).value).toBe('120');

    // #808080 has no recoverable hue — the rail must not jump back to red.
    rerender(<I18nProvider><LiveryColorPicker color="#808080" {...props} /></I18nProvider>);
    expect(screen.getByRole('slider', { name: 'Hue' }).value).toBe('120');

    rerender(<I18nProvider><LiveryColorPicker color="#0000ff" {...props} /></I18nProvider>);
    expect(screen.getByRole('slider', { name: 'Hue' }).value).toBe('240');
  });
});
