import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BrowserHelpOverlay from '../../../src/components/BrowserScreen/BrowserHelpOverlay';
import { I18nProvider } from '../../../src/hooks/useTranslation';
import { setLang } from '../../../src/utils/i18n';

function renderOverlay(props = {}) {
  return render(
    <I18nProvider>
      <BrowserHelpOverlay onClose={props.onClose || (() => {})} />
    </I18nProvider>
  );
}

beforeEach(() => {
  setLang('en');
});

describe('BrowserHelpOverlay', () => {
  it('renders the help title', () => {
    renderOverlay();
    expect(screen.getByText('Help')).toBeInTheDocument();
  });

  it('renders all section headings', () => {
    renderOverlay();
    expect(screen.getByText('Header Buttons')).toBeInTheDocument();
    expect(screen.getByText('Airport')).toBeInTheDocument();
    expect(screen.getByText('Levels')).toBeInTheDocument();
  });

  it('renders all button descriptions', () => {
    renderOverlay();
    expect(screen.getByText(/Change the game directory/)).toBeInTheDocument();
    expect(screen.getByText(/Re-scan the current directory/)).toBeInTheDocument();
    expect(screen.getByText(/Report a bug/)).toBeInTheDocument();
    expect(screen.getByText(/Switch the interface language/)).toBeInTheDocument();
    expect(screen.getByText(/Toggle dark.light mode/)).toBeInTheDocument();
    expect(screen.getByText(/ground\/surface radar view/)).toBeInTheDocument();
    expect(screen.getByText(/approach radar view/)).toBeInTheDocument();
    expect(screen.getByText(/flight strips window/)).toBeInTheDocument();
    expect(screen.getByText(/Click any level row/)).toBeInTheDocument();
  });

  it('renders inline button icons', () => {
    renderOverlay();
    const inlineButtons = document.querySelectorAll('.browser-help-btn');
    expect(inlineButtons.length).toBeGreaterThanOrEqual(8);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    fireEvent.click(document.getElementById('browser-help-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close when content box is clicked', () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    fireEvent.click(document.getElementById('browser-help-box'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('close button calls onClose', () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });
    const closeBtn = document.querySelector('#browser-help-header button');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders in Chinese when lang is zh', () => {
    setLang('zh');
    renderOverlay();
    expect(screen.getByText('帮助')).toBeInTheDocument();
    expect(screen.getByText('顶部按钮')).toBeInTheDocument();
    expect(screen.getByText('机场')).toBeInTheDocument();
    expect(screen.getByText('关卡')).toBeInTheDocument();
  });
});
