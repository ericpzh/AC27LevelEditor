# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Eliminating Waterfalls (async)

**Impact:** CRITICAL
**Description:** Waterfalls are the #1 performance killer. Each sequential await adds full latency. Eliminating them yields the largest gains. Applies to IPC calls, file reads, and any async operation.

## 2. Bundle Size Optimization (bundle)

**Impact:** CRITICAL
**Description:** Reducing initial bundle size improves startup time. Vite handles code-splitting via dynamic `import()` and `React.lazy()`.

## 3. Client-Side Data Patterns (client)

**Impact:** MEDIUM
**Description:** Efficient event listener management and localStorage patterns for desktop apps.

## 4. Re-render Optimization (rerender)

**Impact:** MEDIUM
**Description:** Reducing unnecessary re-renders minimizes wasted computation and improves UI responsiveness.

## 5. Rendering Performance (rendering)

**Impact:** MEDIUM
**Description:** Optimizing the rendering process reduces the work the browser needs to do.

## 6. JavaScript Performance (js)

**Impact:** LOW-MEDIUM
**Description:** Micro-optimizations for hot paths can add up to meaningful improvements.

## 7. Advanced Patterns (advanced)

**Impact:** LOW
**Description:** Advanced patterns for specific cases that require careful implementation.
