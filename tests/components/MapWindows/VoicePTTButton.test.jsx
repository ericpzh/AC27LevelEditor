/**
 * VoicePTTButton hold-to-talk regression tests.
 *
 * The button must start on press and stop on the pointer/key RELEASE edge —
 * never on mouseleave (the old handler released on a 26px button whenever the
 * cursor drifted, which made a held PTT cut out constantly).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import VoicePTTButton from '../../../src/components/MapWindows/VoicePTTButton';

function setup(extra = {}) {
  const onPress = vi.fn();
  const onRelease = vi.fn();
  const utils = render(
    <VoicePTTButton
      listening={false}
      transcript=""
      matchedCommand={null}
      confidence={0}
      isSupported
      error={null}
      feedback={null}
      witchMode={false}
      onPress={onPress}
      onRelease={onRelease}
      {...extra}
    />
  );
  const btn = utils.container.querySelector('.voice-ptt-btn');
  return { ...utils, btn, onPress, onRelease };
}

describe('VoicePTTButton hold-to-talk', () => {
  it('press starts, pointerup stops', () => {
    const { btn, onPress, onRelease } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('does NOT release when the cursor leaves the button mid-hold', () => {
    const { btn, onPress, onRelease } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.mouseLeave(btn);          // old handler released here
    fireEvent.mouseOut(btn);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('ignores duplicate presses (auto-repeat) and duplicate releases', () => {
    const { btn, onPress, onRelease } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(btn, { pointerId: 1 });
    fireEvent.lostPointerCapture(btn, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('releases on pointercancel', () => {
    const { btn, onRelease } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.pointerCancel(btn, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('supports keyboard hold (Space) when focused', () => {
    const { btn, onPress, onRelease } = setup();
    fireEvent.keyDown(btn, { key: ' ' });
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(btn, { key: ' ' });
    expect(onRelease).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('releases the mic if the window blurs mid-hold', () => {
    const { btn, onRelease } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.blur(window);
    expect(onRelease).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('hides the button when unsupported and no error', () => {
    const { container } = setup({ isSupported: false });
    expect(container.querySelector('.voice-ptt-btn')).toBeNull();
    cleanup();
  });
});
