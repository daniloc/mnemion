import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web SPA.
//   build → dist/web (served by the worker via the ASSETS binding).
//   dev   → a Vite dev server with HMR (:4280) that proxies the backend (API +
//           live WebSocket) to a worker. `npm run dev` runs both. Open :4280.
//
// Two backends, selected by env — the safe one is the default:
//
//   (default) localhost:4281 — the local `wrangler dev` placeholder hive.
//             No real data, no risk, no auth (DEV mode). Use for UI iteration.
//
//   (opt-in)  the REAL host, reached by replaying YOUR OWN browser session:
//               MNEMION_REMOTE=https://your-host \
//               MNEMION_SESSION='<__session cookie value>' \
//               npm run dev:app
//             The proxy attaches your existing, passkey-minted session cookie to
//             each forwarded request. This adds NO auth surface to prod — the
//             worker is unchanged; we only replay a credential you already hold,
//             which is HMAC-signed, 24h-lived, and epoch-revocable (/sessions/
//             revoke). PITR (30d) is the net for write mishaps. Get the cookie
//             from devtools → Application → Cookies → __session after logging in.
//             Pass it on the command line (not a file) so nothing lands on disk.
const APP_PORT = 4280;
const REMOTE = process.env.MNEMION_REMOTE;     // e.g. https://mnemion.<acct>.workers.dev
const SESSION = process.env.MNEMION_SESSION;   // value of the __session cookie
const WORKER = REMOTE ?? 'http://localhost:4281';
const ORIGIN = new URL(WORKER).origin;

// Rewrite Origin to the TARGET origin so the worker's same-origin WebSocket guard
// (pages.ts liveSocket) sees a same-origin upgrade — otherwise the browser's
// Origin (:4280) != the worker's host and every /ws upgrade 403s, killing live
// updates. This only rewrites our own local dev proxy; the deployed worker still
// enforces the guard for every real browser. When hitting the real host, also
// replay your existing session cookie (see header note).
const attach = (proxyReq: { setHeader(name: string, value: string): void }) => {
  proxyReq.setHeader('origin', ORIGIN);
  if (REMOTE && SESSION) proxyReq.setHeader('cookie', `__session=${SESSION}`);
};

const backend = (ws = false) => ({
  target: ws ? WORKER.replace(/^http/, 'ws') : WORKER,
  ws,
  changeOrigin: true,
  configure: (proxy: { on(ev: string, cb: (req: { setHeader(n: string, v: string): void }) => void): void }) => {
    proxy.on('proxyReq', attach);
    proxy.on('proxyReqWs', attach);
  },
});

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
