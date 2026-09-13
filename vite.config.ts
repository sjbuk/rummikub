import { defineConfig } from 'vite';

export default defineConfig({
  // Project Pages serves from /<repo>/, so web builds need a subpath base.
  // Tauri keeps the default '/' (equivalent) for the desktop wrapper.
  base: process.env.TAURI_PLATFORM ? '/' : '/rummikub/',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_PLATFORM ? 'chrome105' : 'esnext',
  },
});
