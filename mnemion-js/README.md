# Mnemion Server

The Cloudflare Worker: an MCP server providing persistent, evolving shared memory between a human and their AI agents.

**Start at the [root README](../README.md)** for what Mnemion is, the full tool/resource surface, and deployment (one-click or `npm run setup` — plain `wrangler deploy` skips the Vectorize index and `WORKER_HOST` pinning that setup handles). Architecture and design principles live in [`CLAUDE.md`](../CLAUDE.md).

## Local development

```bash
npm install
npm run dev    # wrangler dev (worker + DOs, seeded) + Vite HMR for the React app — open the Vite URL
npm test       # vitest suite (runs in workerd via @cloudflare/vitest-plugin)
```

Dev mode auto-approves auth (`DEV=true` is set by the dev scripts only) — no passkey or secret needed locally. MCP endpoint at `http://localhost:8787/mcp`.

## Coherence

`@posthog/coherence` is installed as a dev dependency. From this directory, run `npm run coherence:spec` to check component specs, `npm run coherence:run` to execute their declared test oracles, and `npm run coherence:scope` for a live view. `npm run coherence:hooks-check` verifies the Claude and Codex hooks. Use Node 22.18 or newer. The older generated files in `docs/coherence/` are historical snapshots.

For local oracle runs, select the Cloudflare account with `CLOUDFLARE_ACCOUNT_ID` if Wrangler can see multiple accounts. The CI workflow supplies this value from its secret.
