import { defineConfig } from 'vite';

// Builds the MCP Apps fragment client (ui://mnemion/render) into a single
// self-contained IIFE, emitted as a .client.txt text module that session.ts
// inlines into the resource HTML.
export default defineConfig({
  build: {
    rollupOptions: {
      input: 'src/pages/render-client.ts',
      output: {
        entryFileNames: 'render-client.client.txt',
        format: 'iife',
        name: 'MnemionRender',
        inlineDynamicImports: true,
      },
    },
    outDir: 'dist/fragment',
    emptyOutDir: true,
    target: 'es2022',
  },
});
