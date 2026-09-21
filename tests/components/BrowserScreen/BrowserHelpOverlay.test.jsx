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
    expect(screen.getByText('Settings Menu')).toBeInTheDocument();
    expect(screen.getByText('Airport')).toBeInTheDocument();
    expect(screen.getByText('Levels')).toBeInTheDocument();
  });

  it('documents the settings menu in the header section', () => {
    renderOverlay();
    expect(screen.getByText(/holds the remaining options/)).toBeInTheDocument();
    // Header section lists only the top-level buttons …
    const headerSection = document.getElementById('browser-help-toolbar');
    expect(headerSection.textContent).toMatch(/Livery/);
    expect(headerSection.textContent).toMatch(/Restore All/);
    expect(headerSection.textContent).toMatch(/Setting/);
    // … while the collapsed items live under the Settings Menu section.
    const settingsSection = document.getElementById('browser-help-settings');
    expect(settingsSection.textContent).toMatch(/Change Folder/);
    expect(settingsSection.textContent).toMatch(/Background Video/);
    expect(settingsSection.textContent).toMatch(/Debug Mode/);
  });

  it('renders all button descriptions', () => {
    renderOverlay();
    expect(screen.getByText(/Select a different game installation path/)).toBeInTheDocument();
    expect(screen.getByText(/Report a bug/)).toBeInTheDocument();
    expect(screen.getByText(/Switch the UI language/)).toBeInTheDocument();
    expect(screen.getByText(/Toggle dark.light mode/)).toBeInTheDocument();
    expect(screen.getByText(/ground\/surface radar view/)).toBeInTheDocument();
    expect(screen.getByText(/approach radar view/)).toBeInTheDocument();
    expect(screen.getByText(/flight strips window/)).toBeInTheDocument();
    expect(screen.getByText(/Click any level row/)).toBeInTheDocument();
  });

  it('renders inline button icons', () => {
    renderOverlay();
    const inlineButtons = document.querySelectorAll('.browser-help-btn');
    expect(inlineButtons.length).toBeGreaterThanOrEqual(9);
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
    expect(screen.getByText('设置菜单')).toBeInTheDocument();
    expect(screen.getByText('机场')).toBeInTheDocument();
    expect(screen.getByText('关卡')).toBeInTheDocument();
  });
});
