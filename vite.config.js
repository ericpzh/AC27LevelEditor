import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.js',
        vite: { build: { outDir: 'dist-electron', rollupOptions: { external: ['electron', 'ffmpeg-static'] } } },
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
