// Official zustand testing pattern — auto-reset all stores after each test.
// Usage: add `vi.mock('zustand')` in tests/setup.js so Vitest uses this
// mock for all zustand imports. Individual tests use setState() to inject
// desired state — never mock the store module itself.
//
// Based on: https://docs.pmnd.rs/zustand/guides/testing

import { act } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

const { create: actualCreate, createStore: actualCreateStore } =
  await vi.importActual('zustand');

// Track reset functions for all stores created during a test
export const storeResetFns = new Set();

// Wrap `create` to snapshot initial state and auto-reset after each test
export const create = (stateCreator) => {
  const store = actualCreate(stateCreator);
  const initialState = store.getInitialState();
  storeResetFns.add(() => {
    store.setState(initialState, true);
  });
  return store;
};

// Wrap `createStore` (vanilla store API)
export const createStore = (stateCreator) => {
  const store = actualCreateStore(stateCreator);
  const initialState = store.getInitialState();
  storeResetFns.add(() => {
    store.setState(initialState, true);
  });
  return store;
};

// Re-export everything else from zustand so consumers get the full API
export * from 'zustand';

// Auto-reset all stores after each test
afterEach(() => {
  act(() => {
    storeResetFns.forEach((resetFn) => resetFn());
  });
  storeResetFns.clear();
});
