import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Svelte SSR build for the remaining Svelte page: the Canvas (/canvas). The main
// app is React (see vite.web.ts); the SchemaViewer SSR was retired when the
// notebook moved to React. canvas-client is built by vite.canvas.ts; the MCP
// render fragment by vite.fragment.ts.
export default defineConfig({
  plugins: [svelte({ compilerOptions: { css: 'injected' } })],
  ssr: { noExternal: true },
  build: {
    ssr: true,
    rollupOptions: {
      input: { 'canvas-server': 'src/pages/canvas-server.ts' },
      output: { format: 'es' },
    },
    outDir: 'dist/server',
  },
});
