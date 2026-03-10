---
slug: remote-access
title: "Remote Access"
---
# Remote Access

How to connect an agent to {{PRODUCT_NAME}} from a remote machine (e.g. via SSH) without browser-based OAuth.

## Overview

{{PRODUCT_NAME}} uses OAuth 2.1 for authentication. On a local machine, the MCP client opens a browser for the OAuth flow. On a remote/headless machine, that's not possible. One-time auth codes solve this.

## Creating an auth code

From any authenticated {{PRODUCT_NAME}} session (Claude Code, Claude.ai, etc.), create a one-time code:

```
mutate _auth_codes create { "label": "remote-server", "ttl_minutes": 480 }
```

- `label`: optional, for your own bookkeeping
- `ttl_minutes`: how long the code remains valid (default: 60 minutes)
- The response includes a `code` field — a 32-character hex string

## Connecting the remote agent

On the remote machine, add this to `.mcp.json` (or the equivalent MCP client config):

```json
{
  "mcpServers": {
    "{{URI_SCHEME}}": {
      "type": "http",
      "url": "https://YOUR_WORKER.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer AUTH_CODE_HERE"
      }
    }
  }
}
```

Replace `AUTH_CODE_HERE` with the code from the mutate response. The agent connects immediately — no browser, no OAuth dance.

## How it works

The code acts as a bearer token. {{PRODUCT_NAME}} validates it on each request without consuming it, so the session stays active until the code expires or is revoked. The code bypasses OAuth entirely via the `resolveExternalToken` hook.

## Security notes

- Codes are time-limited. Set `ttl_minutes` to the shortest duration practical for the task.
- To revoke immediately: `mutate _auth_codes archive { "id": CODE_RECORD_ID }`
- Codes are single-purpose: if you also enter one on the browser login page, it is consumed and can't be reused as a bearer token.
- Query active codes: `query _auth_codes { "filter": ["consumed_at="] }` (unconsumed only)

## Auth tiers

1. **Passkey** — primary, for humans in a browser. Register via the setup URL.
2. **Auth codes** — for remote/headless agents. Time-limited bearer tokens created via `mutate`.
3. **Master secret** — infrastructure key. Used only for initial setup and passkey registration. Replaceable at any time via `npm run setup`.
