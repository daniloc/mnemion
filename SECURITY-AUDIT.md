# Mnemion — Comprehensive Security Audit

**Date:** 2026-06-09
**Scope:** Full `mnemion-js/` worker — auth/crypto, SSRF/federation, injection (SQL/DSL/XSS), HTTP I/O surface, MCP tool layer, dependencies & config.
**Method:** Five parallel deep-dive reviews, findings verified against source.

This codebase is, on the whole, carefully built. It uses constant-time secret
comparison, parameterized SQL with strict identifier gating, a non-`eval`
transform interpreter, HMAC-signed session cookies, and a genuinely well-designed
federation **consent gate**. The findings below are the gaps that remain. No
issue is rated Critical; the High items are real and exploitable under stated
conditions.

---

## Severity summary

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| H1 | High | SSRF + token leak via redirect-following in federated `resolve` | `hive.ts:525` |
| H2 | High | `isBlockedFederationHost` bypassable (DNS→private, octal/hex/decimal IPv4, IPv6 forms) | `kernel.ts:225` |
| H3 | High | `set_sharing → public/unlisted` has **no** consent gate (confused-deputy data exfil) | `session.ts:216`, `evolution.ts` |
| H4 | High | Stored XSS via SSR `__PROPS__` JSON `</script>` breakout | `pages/entry-server.ts:23` |
| H5 | High | WebAuthn user verification not enforced (passkey ≠ true 2FA) | `passkey.ts:44,64,100,129` |
| H6 | High* | Fail-**open** auth on reads/writes when `MNEMION_SECRET` unset | `routes/io.ts:14,48,80` |
| M1 | Medium | Web-fetch adapter path has no SSRF guard; `http://` allowed | `web.ts:33-50` |
| M2 | Medium | WebSocket `/ws` (and `/api/*`) no Origin/CSRF check → live private-data leak | `routes/pages.ts:79` |
| M3 | Medium | MCP SDK version drift: 1.29.0 top-level vs 1.26.0 bundled by `agents` | `package.json` |
| M4 | Medium | Passkey signature-counter clone detection effectively a no-op | `passkey.ts:124-141` |
| M5 | Medium | Session cookie: no session id, no revocation (24h theft window) | `router.ts:94-115` |
| M6 | Medium | Raw SQLite error strings returned to upload/ingress callers | `hive.ts:378` |
| M7 | Medium | `_web_cache` poisonable via direct agent `mutate` | `web.ts:53`, `kernel.ts` |
| M8 | Medium | Single passkey challenge under fixed KV keys (challenge-binding hygiene) | `routes/auth.ts:150,352` |
| L1 | Low | `/marketplace/token` GET returns full token secrets in list | `routes/marketplace.ts:91` |
| L2 | Low | Access tokens stored plaintext; lookup not constant-time | `schema.ts:88`, `credentials.ts:44` |
| L3 | Low | `innerHTML` with server-supplied `err.message` | `passkey.ts:207` |
| L4 | Low | `~`/LIKE does not escape `%`/`_` (over-match, not injection) | `data.ts:184` |
| L5 | Low | No `Vary: Authorization` on token-gated responses | `routes/io.ts:33,65` |
| L6 | Low | Secret reused as both auth + session-HMAC key (no HKDF separation) | `router.ts:94,113` |
| L7 | Low | No rate limiting on auth/token endpoints (mitigated by 128-bit entropy) | — |

\* H6 is conditional on a secretless internet-reachable deployment, but the failure is silent.

---

## High-severity findings

### H1 — SSRF + token exfiltration via redirect-following in federated `resolve`
**`mnemion-js/src/hive.ts:525`**

`federatedResolve` correctly validates the host with `isBlockedFederationHost`
and the allow-list **before** the fetch, and only then attaches
`Authorization: Bearer <token>`. But the fetch uses Workers' default
`redirect: "follow"`, and **the host is only validated for the initial URL**:

```ts
const url = `https://${host}/o/${cleanPath}`;
const headers: Record<string, string> = {};
if (token) headers["Authorization"] = `Bearer ${token}`;
const response = await fetch(url, { headers });   // redirect: "follow" (default)
```

An allow-listed peer that is later compromised, or one with an open redirect, can
respond `302 Location: http://169.254.169.254/latest/meta-data/...` or
`http://127.0.0.1:...`. The worker follows it transparently — SSRF to internal
infrastructure / cloud metadata — and the `Authorization` header can be carried
to a host that never passed the allow-list or the block check.

**Fix:** `redirect: "manual"`; on a 3xx, re-run `isBlockedFederationHost` +
allow-list against the `Location` host before following, and never re-attach the
token to a host other than the originally approved one. Simplest: refuse
redirects for federation entirely.

### H2 — `isBlockedFederationHost` is bypassable
**`mnemion-js/src/kernel.ts:225-247`**

The block check is pure string/regex inspection of the literal host. It misses:

- **DNS names that resolve to private IPs** — the cleanest bypass. The check
  never resolves DNS, so `mnemion://127-0-0-1.nip.io/...` (a real public name
  resolving to 127.0.0.1) passes entirely. No string check can close this.
- **Alternate IPv4 encodings** — `2130706433`, `0x7f000001`, `0177.0.0.1`,
  `127.1` all evade the `^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$` regex.
- **IPv6 forms** — `[::]` (→ empty after bracket strip), `[::ffff:127.0.0.1]`,
  `[::ffff:7f00:1]`, expanded `[0:0:0:0:0:0:0:1]` are not caught (`bare === "::1"`
  is exact-match only; `fec0:` site-local missed).

The allow-list's dot requirement blunts the no-dot numeric forms for *direct*
adds, but the DNS bypass and (combined with H1) the redirect path remain open.

**Fix:** Normalize/expand IPv6 and reject any bracketed IPv6 that isn't a verified
public address; parse octal/hex/short-form IPv4 and reject all IP-literal hosts in
any base. Because DNS-to-private cannot be closed by string inspection, pair this
with H1's manual-redirect handling (validate the *resolved* connection) and
consider Cloudflare egress restrictions.

### H3 — `set_sharing → public/unlisted` has no consent gate
**`mnemion-js/src/session.ts:216-289`, `evolution.ts` (`set_sharing` apply)**

Adding a federation host is consent-gated (round-trip + batch-block) precisely to
stop an agent acting on untrusted content from leaking data. The symmetric hole —
**publishing private entries** — is left open. `propose_change` and `apply_change`
are not in `CONSENT_GATED`; `apply_change` only requires confirmation on the
`revert_history_id` path (verified: a normal `change_id` apply commits with no
round-trip, `session.ts:255-289`).

**Exploit:** prompt-injected content steers an agent to
`propose_change {type:"set_sharing", visibility:"public"}` → `apply_change`. The
entry becomes world-readable and edge-cached at `/o/entry/{pattern}/{id}` — silent
exfiltration, no human in the loop.

**Fix:** Require a confirmation round-trip in `apply_change` (or `propose_change`)
when the pending change is `set_sharing` with `public`/`unlisted`, mirroring the
`CONSENT_GATED` pattern. Block it inside batches too.

### H4 — Stored XSS via SSR `__PROPS__` JSON breakout
**`mnemion-js/src/pages/entry-server.ts:23`**

```ts
<script id="__PROPS__" type="application/json">${JSON.stringify(props)}</script>
```

`props` includes `patterns[].description`, `patterns[].doctrine`, and `charter`
key/values — all **free text** (only `pattern_name`/facet `name` go through
`validateName`; descriptions/doctrine are never validated, `evolution.ts:128-153`).
`JSON.stringify` does **not** escape `<`/`>`/`/`, so a value containing
`</script><img src=x onerror=...>` breaks out of the JSON block and executes in
the authenticated owner's origin. The codebase already defends this context
elsewhere (`auth.ts:328-335` `safeReturnPath`), but the SSR path does not. (The
Svelte body is auto-escaped — `EntryDetail.svelte` uses `{String(val)}`, not
`{@html}` — so this `__PROPS__` block is the one live sink.)

**Fix:** HTML-escape the JSON for script context:
```ts
JSON.stringify(props).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026')
```

### H5 — WebAuthn user verification not enforced
**`mnemion-js/src/passkey.ts:44,64,100,129`**

Registration and authentication use `userVerification: "preferred"` with
`requireUserVerification: false` in both `verifyRegistrationResponse` and
`verifyAuthenticationResponse`. "Preferred" + `false` means the server accepts
assertions where the `uv` flag is unset — the passkey degrades to
possession-only. Since the passkey gates the entire OAuth grant and browser
session, brief access to an unlocked device (or a synced credential where local
verification was skipped) yields a full grant with no biometric/PIN.

**Fix:** `userVerification: "required"` in the options and
`requireUserVerification: true` in both verify calls.

### H6 — Fail-open auth when `MNEMION_SECRET` is unset
**`mnemion-js/src/routes/io.ts:14,48,80`** (verified)

Every visibility check on shared entries, outputs, and inputs is gated on
`&& ctx.env.MNEMION_SECRET`:

```ts
if (result.visibility === "unlisted" && ctx.env.MNEMION_SECRET) { ...require token... }
```

With no secret, the token check is **skipped entirely** — unlisted entries and
private outputs are served, and `POST /i/:path` accepts unauthenticated writes.
`/i/:path` and `/upload/:token` carry no route-level `Auth` gate either
(`index.ts`), so the secret presence is the only guard. "No secret = dev mode" is
documented, but `[env.test]` is described as a live federation peer, and the
failure mode is silent: an operator who deploys before running setup (or after a
rotation failure) has a write-open, read-leaking instance.

**Fix:** Fail **closed** — return 401/404 for non-public visibility when no secret
is configured, and put `/i/:path` + `/upload/:token` behind `Auth.CONFIGURED`.

---

## Medium-severity findings

- **M1 — Web-fetch adapter has no SSRF guard (`web.ts:33-50`).** `resolve()` sends
  any `http(s)://` URL to the browser-rendering / Bluesky adapters with no
  `isBlockedFederationHost` check, and `http://` is allowed. Mitigated because the
  worker doesn't `fetch(rawUrl)` directly (CF's browser infra does the fetch), but
  `http://169.254.169.254` is forwarded and the response is cached + embedded into
  prime. **Fix:** apply the hardened host block to this path; refuse `http://` to
  non-public hosts.
- **M2 — WebSocket `/ws` has no Origin check (`routes/pages.ts:79`).** State-changing
  `/api/*` and the live socket authenticate only via the `SameSite=Lax` session
  cookie. `Lax` does not protect WebSocket upgrades: a malicious page can
  `new WebSocket("wss://victim/ws")`, the browser attaches the cookie, and the
  attacker receives live change events about the owner's private hive. **Fix:**
  validate `Origin` against the worker host on `/ws` and all `/api/*` POSTs; add a
  CSRF token or `SameSite=Strict`.
- **M3 — MCP SDK version drift (`package.json`).** Top-level
  `@modelcontextprotocol/sdk` resolves to **1.29.0** while `agents@0.7.9` bundles
  **1.26.0** — exactly the drift CLAUDE.md warns causes protocol/type divergence.
  **Fix:** pin `"@modelcontextprotocol/sdk": "1.26.0"` exact and dedupe.
- **M4 — Passkey counter clone-detection no-op (`passkey.ts:124-141`).** Modern
  passkeys report counter `0`; `newCounter ?? stored.counter` also silently
  preserves the old value if `authenticationInfo` is absent. **Fix:** treat
  missing `authenticationInfo` as failure; log/alert on observed regression.
- **M5 — Session cookie has no revocation (`router.ts:94-115`).** Cookie signs only
  `session:${ts}`; no session id, no way to invalidate short of rotating the
  master secret. Stolen cookie = 24h of full access. **Fix:** include a random
  session id in the signed payload and check it against a server-side allow/gen list.
- **M6 — Raw SQLite errors leaked (`hive.ts:378`).** `Upload write failed:
  ${err.message}` echoes DB internals (column names, constraints, internal table
  names) to low-trust callers. **Fix:** log server-side, return a generic message.
- **M7 — `_web_cache` poisoning (`web.ts:53`, `kernel.ts` `ON_CREATE`).** `_web_cache`
  is agent-writable via `mutate`; `resolve` returns a cache hit before any fetch.
  Injected content can steer an agent to plant falsified content for a trusted URL
  that later surfaces via prime as authoritative memory. **Fix:** don't expose
  `_web_cache` to `mutate`, or never serve user-inserted rows as cache hits.
- **M8 — Fixed-key passkey challenges (`auth.ts:150,352`).** Registration/session
  challenges use constant KV keys, not per-attempt ids (the OAuth flow does scope
  them). Single-use + random keeps it from being an auth bypass, but concurrent
  flows clobber each other and challenge-binding is weak. **Fix:** scope every
  challenge to a per-attempt random id.

---

## Low-severity / hardening

- **L1 — `/marketplace/token` GET returns full token secrets** (`marketplace.ts:91`).
  `Auth.SECRET`-gated, but echoing live bearer tokens in a list is poor hygiene.
  Return a prefix/last-4; reveal full token only at creation.
- **L2 — Tokens plaintext at rest + non-constant-time lookup** (`schema.ts:88`,
  `credentials.ts:44`). 128-bit entropy makes timing impractical, but storing a
  hash and looking up by hash is cleaner; DB read currently exposes all live tokens.
- **L3 — `innerHTML` with `err.message`** (`passkey.ts:207`). Use `textContent`.
- **L4 — LIKE `%`/`_` not escaped** (`data.ts:184`). Over-match correctness, not
  injection (value is bound).
- **L5 — No `Vary: Authorization`** on token-gated `/o/...` responses (`io.ts:33,65`).
- **L6 — Master secret reused as session-HMAC key** (`router.ts:94,113`). Derive a
  separate key via HKDF.
- **L7 — No rate limiting** on `/upload`, `/i`, `/auth/*`, `/login/*`,
  `/marketplace*`. Mitigated by entropy + `timingSafeEqual`; add WAF rate rules.

---

## Verified solid (no action)

- **Federation consent gate** — confirmation round-trip (`session.ts:447-467`) +
  batch-block (`session.ts:403-410`) + `isBlockedFederationHost` at add *and*
  resolve time + token only sent to allow-listed hosts (`hive.ts:510-521`). The
  gate cannot be reached via `resolve`/`apply_change` side paths. Genuinely good.
- **SQL injection** — `parseFilter` constrains columns to `\w+`; all values bound
  (incl. `|=` IN lists); `facets`/`sortField` gate-checked via `isValidColumn`;
  pattern names via `patternExists`. DDL identifiers validated by `NAME_RE`; types
  whitelisted; `default_value` properly escaped.
- **Transform DSL** — hand-written interpreter, no `eval`/`Function`; `dotPath`
  reads only (no prototype-pollution write sink).
- **`scopeMatches`** — colon-boundary prefix match; no prefix-confusion escalation.
  `resolveExternalToken` requires `*` for MCP (least privilege at the endpoint).
- **`timingSafeEqual`** — SHA-256 + branch-free XOR, length-independent.
- **`git.ts`** — read-only synthesized repo, exact-key lookup, no path traversal,
  no push. **Marketplace plugin scope** correctly post-filtered.
- **Upload constraints** re-validated against `IDENT_RE` at consume time;
  cross-pattern/cross-id writes bounded; token never accepted from input.
- **No committed secrets**; **dev/test routes inert in production**
  (`Auth.DEV` skipped when secret set); no CORS `*`; no committed `.env`.
- **prime / Vectorize** — cross-hive matches gated by local-DB re-fetch (no content
  leak). Note for multi-tenant future: namespace vector IDs by userId.
