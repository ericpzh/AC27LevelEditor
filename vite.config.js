import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.js',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', 'ffmpeg-static'],
              // Main process is a single CJS entry: inline dynamic imports so
              // Rollup never code-splits (a shared module hoisted into a chunk
              // leaves unbound __esmMin init calls like init_timing() behind —
              // see ReferenceError on app load). Dynamic import()s stay intact
              // in the source, so direct-node loads (integration tests) still work.
              output: { codeSplitting: false },
            },
          },
        },
      },
      {
        entry: 'electron/preload.js',
        onstart(args) { args.reload(); },
        vite: { build: { outDir: 'dist-electron', rollupOptions: { external: ['electron'] } } },
      },
    ]),
  ],
  build: { outDir: 'dist' },
  base: './',
});
