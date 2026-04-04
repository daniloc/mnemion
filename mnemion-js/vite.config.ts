import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [
    svelte({
      compilerOptions: {
        css: 'injected',
      },
    }),
  ],
  ssr: {
    // Bundle everything — no externals in Worker environment
    noExternal: true,
  },
  build: isSsrBuild
    ? {
        ssr: true,
        rollupOptions: {
          input: {
            'entry-server': 'src/pages/entry-server.ts',
            'canvas-server': 'src/pages/canvas-server.ts',
          },
          output: { format: 'es' },
        },
        outDir: 'dist/server',
      }
    : {
        rollupOptions: {
          input: 'src/pages/entry-client.ts',
          output: {
            entryFileNames: '[name].client.txt',
            format: 'es',
          },
        },
        outDir: 'dist/client',
      },
}));
