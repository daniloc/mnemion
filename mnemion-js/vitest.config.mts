import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Migrated to @cloudflare/vitest-pool-workers v0.16 (vitest 4): the pool is now a
// Vite plugin (`cloudflareTest`) rather than `poolOptions`, and per-test isolated
// storage (DO SQLite rollback between tests) is built in — the old
// `isolatedStorage: true` flag was removed.
export default defineConfig({
  test: {
    globals: true,
    // The mutate-engine tests in data-engine-bugs.test.ts (and any test that exercises
    // a write path that triggers embedAfterMutate) round-trip to the REAL Workers AI
    // binding — remote=true in wrangler.toml, no local simulator. Vitest's 5s default
    // testTimeout is fine for in-process work but tight against a remote service whose
    // tail latency can spike under load; CI then fails a whole file's tests with a
    // wall of identical "Test timed out in 5000ms" messages that aren't real bugs.
    // 30s gives the remote round-trip headroom while still surfacing a true hang in
    // a reasonable window.
    testTimeout: 30000,
  },
  plugins: [
    cloudflareTest({
      main: "src/index.ts",
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
