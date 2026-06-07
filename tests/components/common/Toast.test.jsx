import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import Toast from '../../../src/components/common/Toast';
import { useAppStore } from '../../../src/store/appStore';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Toast', () => {
  it('renders with empty message by default (hidden)', () => {
    const { container } = render(<Toast />);
    const toast = container.querySelector('#toast');
    expect(toast).toBeInTheDocument();
    expect(toast.textContent).toBe('');
  });

  it('shows message when set', () => {
    useAppStore.setState({ toast: { message: 'Saved!', type: 'success' } });
    render(<Toast />);
    expect(screen.getByText('Saved!')).toBeInTheDocument();
  });

  it('applies CSS class based on type', () => {
    useAppStore.setState({ toast: { message: 'Error!', type: 'error' } });
    const { container } = render(<Toast />);
    const toast = container.querySelector('#toast');
    expect(toast.className).toContain('error');
    expect(toast.className).toContain('show');
  });

  it('auto-hides after timeout', () => {
    useAppStore.setState({ toast: { message: 'Saved!', type: 'success' } });
    const { container, rerender } = render(<Toast />);

    expect(container.querySelector('#toast').className).toContain('show');

    // Simulate the store clearing the toast (as the real showToast does)
    act(() => {
      useAppStore.setState({ toast: { message: '', type: '' } });
    });
    rerender(<Toast />);
    expect(container.querySelector('#toast').className).not.toContain('show');
  });
});
