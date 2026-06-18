import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web SPA. `build` → dist/web (served by the worker via the ASSETS binding).
// `dev` → a Vite dev server with HMR that proxies the backend (API + live
// WebSocket) to a local `wrangler dev` worker on :8787, so the React app
// iterates instantly against real Durable-Object data (DEV_SEED). See `npm run dev`.
const WORKER = 'http://localhost:8787';
const backend = (ws = false) => ({ target: ws ? WORKER.replace('http', 'ws') : WORKER, ws, changeOrigin: true });

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backend(),
      '/ws': backend(true),
      '/login': backend(),
      '/auth': backend(),
      '/o': backend(),
      '/p': backend(),
      '/f': backend(),
      '/export': backend(),
    },
  },
});
