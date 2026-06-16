import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Migrated to @cloudflare/vitest-pool-workers v0.16 (vitest 4): the pool is now a
// Vite plugin (`cloudflareTest`) rather than `poolOptions`, and per-test isolated
// storage (DO SQLite rollback between tests) is built in — the old
// `isolatedStorage: true` flag was removed.
export default defineConfig({
  test: {
    globals: true,
  },
  plugins: [
    cloudflareTest({
      main: "src/index.ts",
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
