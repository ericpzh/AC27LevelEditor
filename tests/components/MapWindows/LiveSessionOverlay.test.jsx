import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LiveSessionOverlay from '../../../src/components/MapWindows/LiveSessionOverlay';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderOverlay(visible) {
  return render(
    <I18nProvider>
      <LiveSessionOverlay visible={visible} />
    </I18nProvider>
  );
}

describe('LiveSessionOverlay', () => {
  beforeEach(() => setLang('en'));

  it('renders nothing while a live session is detected', () => {
    const { container } = renderOverlay(false);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Live game level session not detected.')).toBeNull();
  });

  it('shows the no-session notice when disconnected', () => {
    const { container } = renderOverlay(true);
    expect(container.querySelector('.live-session-overlay')).toBeTruthy();
    expect(container.querySelector('.live-session-overlay-text').textContent)
      .toBe('Live game level session not detected.');
  });

  it('clicking inside the notice does not dismiss it', () => {
    const { container } = renderOverlay(true);
    fireEvent.click(container.querySelector('.live-session-overlay-text'));
    expect(container.querySelector('.live-session-overlay')).toBeTruthy();
  });

  it('clicking the backdrop dismisses it', () => {
    const { container } = renderOverlay(true);
    fireEvent.click(container.querySelector('.live-session-overlay'));
    expect(container.querySelector('.live-session-overlay')).toBeNull();
  });

  it('re-arms after a reconnect → disconnect transition', () => {
    const { container, rerender } = renderOverlay(true);
    fireEvent.click(container.querySelector('.live-session-overlay'));
    expect(container.querySelector('.live-session-overlay')).toBeNull();

    // Reconnect hides it; a later disconnect must show it again, not stay dismissed.
    rerender(<I18nProvider><LiveSessionOverlay visible={false} /></I18nProvider>);
    expect(container.querySelector('.live-session-overlay')).toBeNull();
    rerender(<I18nProvider><LiveSessionOverlay visible={true} /></I18nProvider>);
    expect(container.querySelector('.live-session-overlay')).toBeTruthy();
  });

  it('translates the notice in Chinese', () => {
    setLang('zh');
    const { container } = renderOverlay(true);
    expect(container.querySelector('.live-session-overlay-text').textContent)
      .toBe('未检测到进行中的关卡。');
  });
});
