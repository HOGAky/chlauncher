/**
 * @file vite.config.ts
 * Vite configuration for the Tauri launcher frontend.
 * The dev server must stay on the fixed port 1420 because
 * `tauri.conf.json` points `devUrl` at it.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Prevent vite from obscuring rust errors in the tauri dev console.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri expects a fixed origin in dev; watch the frontend sources only.
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Tauri supports the same env prefix convention as Vite.
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2021',
    minify: 'esbuild',
    sourcemap: false,
  },
});
