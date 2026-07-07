---
name: react-best-practices
description: React performance optimization guidelines for desktop and client-rendered apps (Electron, Vite SPAs, zustand). Covers re-render prevention, JavaScript micro-optimizations, bundle optimization, and rendering performance. Use when writing, reviewing, or refactoring React components, implementing data loading, optimizing bundles, or fixing performance issues. Applies to any client-rendered React app — not just web.
license: MIT
metadata:
  author: vercel
  adapted_for: ac27-editor
  version: "2.0.0"
---

# React Best Practices (Desktop/Client Edition)

Performance optimization guide tailored for client-rendered React applications: Electron desktop apps, Vite SPAs, and any React app without SSR. Adapted from Vercel Engineering's original guide. Contains 57 rules across 7 categories.

## When to Apply

Reference these guidelines when:
- Writing new React components or hooks
- Implementing data loading (IPC calls, file reads, async operations)
- Reviewing code for performance issues
- Refactoring existing React code
- Optimizing bundle size or startup time
- Reducing unnecessary re-renders

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Eliminating Waterfalls | CRITICAL | `async-` |
| 2 | Bundle Size Optimization | CRITICAL | `bundle-` |
| 3 | Client-Side Data Fetching | MEDIUM | `client-` |
| 4 | Re-render Optimization | MEDIUM | `rerender-` |
| 5 | Rendering Performance | MEDIUM | `rendering-` |
| 6 | JavaScript Performance | LOW-MEDIUM | `js-` |
| 7 | Advanced Patterns | LOW | `advanced-` |

## Quick Reference

### 1. Eliminating Waterfalls (CRITICAL)

- `async-cheap-condition-before-await` - Check cheap sync conditions before async work
- `async-defer-await` - Move await into branches where actually used
- `async-parallel` - Use Promise.all() for independent operations
- `async-dependencies` - Chain promises for partial dependencies
- `async-api-routes` - Start promises early, await late
- `async-suspense-boundaries` - Use Suspense for faster initial render
- `async-parallel-nested` - Chain nested async operations per item in Promise.all

### 2. Bundle Size Optimization (CRITICAL)

- `bundle-barrel-imports` - Import directly, avoid barrel files
- `bundle-analyzable-paths` - Prefer statically analyzable import paths
- `bundle-dynamic-imports` - Use React.lazy() for heavy components
- `bundle-defer-third-party` - Load analytics/logging after initial render
- `bundle-conditional` - Load modules only when feature is activated
- `bundle-preload` - Preload on hover/focus for perceived speed

### 3. Client-Side Data Patterns (MEDIUM)

- `client-event-listeners` - Deduplicate global event listeners with module-level Map
- `client-passive-event-listeners` - Use passive listeners for scroll
- `client-localstorage-schema` - Version and minimize localStorage data

### 4. Re-render Optimization (MEDIUM)

- `rerender-defer-reads` - Use getState() for values only needed in callbacks
- `rerender-memo` - Extract expensive work into memoized components
- `rerender-memo-with-default-value` - Hoist default non-primitive props
- `rerender-dependencies` - Use primitive dependencies in effects
- `rerender-derived-state` - Subscribe to derived booleans, not raw values
- `rerender-derived-state-no-effect` - Derive state during render, not effects
- `rerender-functional-setstate` - Use functional setState for stable callbacks
- `rerender-lazy-state-init` - Pass function to useState for expensive values
- `rerender-simple-expression-in-memo` - Avoid memo for simple primitives
- `rerender-split-combined-hooks` - Split hooks with independent dependencies
- `rerender-move-effect-to-event` - Put interaction logic in event handlers
- `rerender-transitions` - Use startTransition for non-urgent updates
- `rerender-use-deferred-value` - Defer expensive renders to keep UI responsive
- `rerender-use-ref-transient-values` - Use refs for transient frequent values
- `rerender-no-inline-components` - Don't define components inside components

### 5. Rendering Performance (MEDIUM)

- `rendering-animate-svg-wrapper` - Animate div wrapper, not SVG element
- `rendering-content-visibility` - Use content-visibility for long lists
- `rendering-hoist-jsx` - Extract static JSX outside components
- `rendering-svg-precision` - Reduce SVG coordinate precision
- `rendering-activity` - Use Activity component for show/hide
- `rendering-conditional-render` - Use ternary, not && for conditional rendering
- `rendering-usetransition-loading` - Prefer useTransition for loading state

### 6. JavaScript Performance (LOW-MEDIUM)

- `js-batch-dom-css` - Group CSS changes via classes or cssText
- `js-index-maps` - Build Map for repeated lookups
- `js-cache-property-access` - Cache object properties in loops
- `js-cache-function-results` - Cache function results in module-level Map
- `js-cache-storage` - Cache localStorage/sessionStorage reads
- `js-combine-iterations` - Combine multiple filter/map into one loop
- `js-length-check-first` - Check array length before expensive comparison
- `js-early-exit` - Return early from functions
- `js-hoist-regexp` - Hoist RegExp creation outside loops/renders
- `js-min-max-loop` - Use loop for min/max instead of sort
- `js-set-map-lookups` - Use Set/Map for O(1) lookups
- `js-tosorted-immutable` - Use toSorted() for immutability
- `js-flatmap-filter` - Use flatMap to map and filter in one pass
- `js-request-idle-callback` - Defer non-critical work to browser idle time
- `js-hoist-static-io` - Hoist static file I/O to module level

### 7. Advanced Patterns (LOW)

- `advanced-effect-event-deps` - Don't put useEffectEvent results in effect deps
- `advanced-event-handler-refs` - Store event handlers in refs for stable subscriptions
- `advanced-init-once` - Initialize app once per app load (module-level guard)
- `advanced-use-latest` - useEffectEvent for stable callback refs

## How to Use

Read individual rule files for detailed explanations and code examples:

```
rules/async-parallel.md
rules/rerender-memo.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation
- Additional context and references
