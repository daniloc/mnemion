import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web SPA. Separate from the (legacy) Svelte SSR builds — this one produces
// a plain static bundle in dist/web/ that the worker serves via the ASSETS
// binding. No SSR, no .client.txt text-module machinery.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
