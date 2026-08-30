import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
    // Integration suites decode/patch real .acl levels (multi-second per test
    // even un-instrumented); 5s defaults time them out under coverage.
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      // The core logic trees: .acl read/write pipeline + the Ground Painter
      // (editor) modules. Thresholds floor THESE; the rest of src/ (screens,
      // entry points) is intentionally out of scope.
      include: ['src/acl/**', 'src/components/EditorScreen/GroundPainter/**'],
      thresholds: {
        // Floors: scoped baseline measured 2026-08 after the Ground-Painter
        // coverage work (component, fillet connected path, snap cascade, metrics)
        // → 59.8/44.8/53.7/62.4. Keep a few points of slack below that.
        statements: 55,
        branches: 40,
        functions: 48,
        lines: 55,
      },
    },
  },
});
