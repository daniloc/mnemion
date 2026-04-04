import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        css: 'injected',
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: 'src/pages/canvas-client.ts',
      output: {
        entryFileNames: 'canvas-client.client.txt',
        format: 'es',
      },
    },
    outDir: 'dist/canvas',
  },
});
