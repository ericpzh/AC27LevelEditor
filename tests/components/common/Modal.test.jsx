import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from '../../../src/components/common/Modal';
import { useAppStore } from '../../../src/store/appStore';
import { I18nProvider } from '../../../src/hooks/useTranslation';

// Use the real store — inject state directly
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

function renderModal() {
  return render(
    <I18nProvider>
      <Modal />
    </I18nProvider>
  );
}

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = renderModal();
    expect(container.firstChild).toBeNull();
  });

  it('renders when open', () => {
    useAppStore.setState({
      modal: { open: true, title: 'Test Modal', body: <p>Body text</p>, actions: null },
    });
    renderModal();
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
  });

  it('calls hideModal on overlay click', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      modal: { open: true, title: 'Test', body: 'Content', actions: null },
    });
    const hideModal = vi.fn();
    useAppStore.setState({ hideModal });

    renderModal();
    await user.click(screen.getByText('Content').closest('#modal-overlay'));
    expect(hideModal).toHaveBeenCalledTimes(1);
  });

  it('does NOT close when clicking inside modal box', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      modal: { open: true, title: 'Test', body: 'Content', actions: null },
    });
    const hideModal = vi.fn();
    useAppStore.setState({ hideModal });

    renderModal();
    await user.click(screen.getByText('Content'));
    expect(hideModal).not.toHaveBeenCalled();
  });

  it('renders actions when provided', () => {
    useAppStore.setState({
      modal: {
        open: true,
        title: 'Confirm',
        body: 'Are you sure?',
        actions: <button>OK</button>,
      },
    });
    renderModal();
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });

  it('renders body as React elements', () => {
    useAppStore.setState({
      modal: {
        open: true,
        title: 'Test',
        body: <span data-testid="custom-body">Custom content</span>,
        actions: null,
      },
    });
    renderModal();
    expect(screen.getByTestId('custom-body')).toBeInTheDocument();
  });
});
