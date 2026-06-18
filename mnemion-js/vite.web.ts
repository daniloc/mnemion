import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web SPA.
//   build → dist/web (served by the worker via the ASSETS binding).
//   dev   → a Vite dev server with HMR (:4280) that proxies the backend (API +
//           live WebSocket) to the local `wrangler dev` worker (:4281, the
//           placeholder hive). The React app iterates instantly; no exfil surface
//           is added to production. `npm run dev` runs both. Open localhost:4280.
//
// (For debugging the UI against REAL data, use an account-authenticated path —
//  e.g. `wrangler dev --remote` — not a token bolted onto prod /api.)
const APP_PORT = 4280;
const WORKER = 'http://localhost:4281';
const backend = (ws = false) => ({ target: ws ? WORKER.replace('http', 'ws') : WORKER, ws, changeOrigin: true });

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: APP_PORT,
    proxy: {
      '/api': backend(),
      '/ws': backend(true),
      '/login': backend(),
      '/auth': backend(),
      '/o': backend(),
      '/p': backend(),
      '/f': backend(),
    },
  },
});
