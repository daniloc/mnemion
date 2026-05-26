# Mnemion

Persistent, evolving shared memory between a human and their AI agents. MCP server on Cloudflare Workers.

See [`CLAUDE.md`](CLAUDE.md) for architecture and design principles.

## Deploy to Cloudflare

### Prerequisites

- Node.js 20+
- A Cloudflare account (Wrangler will prompt for browser login on first use)
- `openssl` (preinstalled on macOS and most Linux distros)

### One command

From the repo root:

```bash
npm run setup
```

`npm run setup` is idempotent. It:

1. Finds or creates the `OAUTH_KV` namespace and patches its id into `wrangler.toml`
2. Finds or creates the `mnemion-vectors` Vectorize index (768 dims, cosine — matches the Workers AI `bge-base-en-v1.5` embedding model)
3. Generates a 256-bit master secret and pushes it as `MNEMION_SECRET`
4. Builds the Svelte client + SSR bundles and deploys the worker
5. Prints (and optionally opens) a one-time URL: `https://<your-worker>.workers.dev/setup?token=<secret>`

Open that URL once in a browser to register a passkey. After that, browser-based OAuth uses the passkey; the master secret remains as a fallback for headless agents and re-registration.

### Optional: rename the worker

By default the worker deploys as `mnemion`. If you want a different subdomain (or you already have a worker by that name on your account), edit `name` and `WORKER_HOST` in `mnemion-js/wrangler.toml` before running setup.

### Connect an MCP client

Your MCP endpoint is:

```
https://<your-worker>.workers.dev/mcp
```

Add it to Claude Desktop, Claude Code, or any MCP client that supports remote servers with OAuth. The first connection opens the OAuth flow in a browser; your passkey authorizes it.

## Subsequent deploys

Code changes only — no secret rotation, no re-registration:

```bash
npm run deploy
```

Re-running `npm run setup` rotates the master secret and replaces your passkey.

## Local development

```bash
npm run dev        # builds frontend, runs wrangler dev on :8787 in dev mode (no secret required)
npm test           # vitest suite (runs in workerd via @cloudflare/vitest-pool-workers)
```

For frontend-only iteration with mock data: `cd mnemion-js && npm run preview`.

Dev mode auto-approves OAuth (`Auth.DEV`), so you can hit the worker without a passkey or secret.
