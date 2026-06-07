import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from '../../../src/components/common/Modal';
import { useAppStore } from '../../../src/store/appStore';

// Use the real store — inject state directly
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<Modal />);
    expect(container.firstChild).toBeNull();
  });

  it('renders when open', () => {
    useAppStore.setState({
      modal: { open: true, title: 'Test Modal', body: <p>Body text</p>, actions: null },
    });
    render(<Modal />);
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

    render(<Modal />);
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

    render(<Modal />);
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
    render(<Modal />);
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
    render(<Modal />);
    expect(screen.getByTestId('custom-body')).toBeInTheDocument();
  });
});
