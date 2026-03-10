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
  root: 'src/pages',
  server: {
    port: 5173,
    open: '/preview.html',
  },
});
