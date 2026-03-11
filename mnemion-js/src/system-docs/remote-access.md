---
slug: remote-access
title: "Remote Access"
---
# Remote Access

How to connect an agent to {{PRODUCT_NAME}} from a remote machine (e.g. via SSH) without browser-based OAuth.

## Overview

{{PRODUCT_NAME}} uses OAuth 2.1 for authentication. On a local machine, the MCP client opens a browser for the OAuth flow. On a remote/headless machine, that's not possible. Access tokens solve this.

## Creating an access token

From any authenticated {{PRODUCT_NAME}} session (Claude Code, Claude.ai, etc.), create a token:

```
mutate _access_tokens create { "label": "remote-server", "ttl_minutes": 480 }
```

- `label`: optional, for your own bookkeeping
- `ttl_minutes`: how long the token remains valid (default: 60 minutes)
- `scope`: what the token can do (default: `*` = full access)
- The response includes a `token` field — a 32-character hex string

## Scoped tokens

Tokens can be scoped to limit what they can do:

- `*` — full access (OAuth, reads, writes)
- `read` — read any shared entry or output
- `read:entry:axioms` — read shared entries in the axioms pattern
- `read:entry:axioms:7` — read a specific shared entry
- `upload` — write via POST /upload/{token} (requires constraints)
- `marketplace` — private marketplace git access

## Connecting the remote agent

On the remote machine, add this to `.mcp.json` (or the equivalent MCP client config):

```json
{
  "mcpServers": {
    "{{URI_SCHEME}}": {
      "type": "http",
      "url": "https://YOUR_WORKER.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer TOKEN_HERE"
      }
    }
  }
}
```

Replace `TOKEN_HERE` with the token from the mutate response. The agent connects immediately — no browser, no OAuth dance.

## How it works

The token acts as a bearer token. {{PRODUCT_NAME}} validates it on each request. Scope matching is hierarchical: a `read` token matches `read:entry:axioms:7`. The token bypasses OAuth entirely via the `resolveExternalToken` hook.

## Security notes

- Tokens are time-limited by default. Set `ttl_minutes` to the shortest duration practical for the task.
- To revoke immediately: `mutate _access_tokens archive { "id": TOKEN_ID }`
- Query active tokens: `query _access_tokens { "filter": ["consumed_at="] }`
- Single-use tokens (e.g. upload) are consumed after first use.

## Auth tiers

1. **Passkey** — primary, for humans in a browser. Register via the setup URL.
2. **Access tokens** — for remote/headless agents. Time-limited, scoped bearer tokens created via `mutate`.
3. **Master secret** — infrastructure key. Used only for initial setup and passkey registration. Replaceable at any time via `npm run setup`.
