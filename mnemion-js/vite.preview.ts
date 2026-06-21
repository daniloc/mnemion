import { defineConfig } from 'vite';

// Dev-server preview for the MCP render fragment (ui://mnemion/render). Serves
// src/pages/render-preview.html so the fragment can be iterated in a browser.
export default defineConfig({
  root: 'src/pages',
  server: {
    port: 5173,
    open: '/render-preview.html',
  },
});
