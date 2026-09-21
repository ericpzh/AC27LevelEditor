import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider, useTranslation } from '../../../src/hooks/useTranslation';
import LanguagePicker from '../../../src/components/LanguagePicker/LanguagePicker';
import { mockIpcInvoke } from '../../setup';
import { setLang } from '../../../src/utils/i18n';
import { STORAGE_KEY_LANG } from '../../../src/utils/constants';

function StatusProbe() {
  const { langStatus, lang } = useTranslation();
  return <div data-testid="status">{langStatus}:{lang}</div>;
}

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  mockIpcInvoke.mockReset();
});

describe('LanguagePicker', () => {
  it('shows the brand and both language buttons, persisting the choice', async () => {
    const user = userEvent.setup();
    mockIpcInvoke.mockImplementation(() => Promise.resolve({}));
    render(<I18nProvider><LanguagePicker /></I18nProvider>);

    expect(screen.getByText('AC27 Editor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '中文' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '中文' }));
    expect(mockIpcInvoke).toHaveBeenCalledWith('save-cached-lang', 'zh');
  });
});

describe('I18nProvider language status', () => {
  it('reports unset when neither localStorage nor cache.json has a language', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'get-cached-lang') return Promise.resolve({ lang: null });
      return Promise.resolve({});
    });
    render(<I18nProvider><StatusProbe /></I18nProvider>);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toMatch(/^unset:/));
  });

  it('adopts the cached language and reports chosen', async () => {
    mockIpcInvoke.mockImplementation((channel) => {
      if (channel === 'get-cached-lang') return Promise.resolve({ lang: 'en' });
      return Promise.resolve({});
    });
    render(<I18nProvider><StatusProbe /></I18nProvider>);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('chosen:en'));
  });

  it('is chosen immediately when localStorage already has a language', () => {
    localStorage.setItem(STORAGE_KEY_LANG, 'en');
    mockIpcInvoke.mockImplementation(() => Promise.resolve({}));
    render(<I18nProvider><StatusProbe /></I18nProvider>);
    expect(screen.getByTestId('status').textContent).toBe('chosen:en');
    expect(mockIpcInvoke).not.toHaveBeenCalledWith('get-cached-lang');
  });
});
