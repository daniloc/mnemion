# Multi-tenancy: host-routed hives (decision)

> **STATUS: DEFERRED (not on the active path).** The working premise is **single
> instance per person — everyone runs their own fork/deploy**, and shares across
> instances via *federation*, not multi-tenancy. So a hive stays single-owner
> (`user:owner`), the extensibility story is "a fork-owner extends their own instance
> via feature manifests," and nothing below is being implemented now. This document is
> kept as the analysis-of-record for *if* the premise ever changes (a hosted,
> many-strangers-one-deploy offering). The capability split and actor↔hiveId separation
> that would make it cheap already landed, so picking this up later stays low-cost.

**Decision:** when Mnemion grows beyond the single `user:owner` hive, a hive is
selected by the **request host** — `alice.mnemion.dev → hiveId "host:alice"` — not by
the credential. Chosen over credential-routed tenancy after a parallel worktree
exploration of both (briefs archived in the session that produced this doc).

Status: **decided, not yet implemented.** The capability split (`ownerDataCtx`/
`servedDataCtx`) and the actor↔hiveId separation that make it safe are already in
(`entities/Hive/hive.ts`, `session.ts:94` already reads `props.hiveId ?? HIVE_ID`).

## The two models considered

| | Host-routed (chosen) | Credential-routed |
|---|---|---|
| Hive selector | inbound Host → `host:<label>` | access token / passkey → hiveId via a KV directory |
| Provision a hive | **0 source files**, 1 DNS record (+ one-time wildcard route); DO + schema self-instantiate | 1 KV write (`provisionHive`); DO self-instantiates |
| Backward-compat | zero migration (apex/`workers.dev` → `user:owner`) | zero migration (unmapped credential → `user:owner`) |
| Federation fit | **same idea at two scales** — a hive *is* a host; `mnemion://alice.host/...` already works | **fights it** — co-tenants share a host, need a NEW internal `mnemion://hive:<id>/` URI form |
| Missing core piece | none (routing substrate is complete) | **bootstrap founder-auth** — a new hive has no member to approve invites |

## Why host-routed

The deciding criterion is **agentic extensibility** — how cheaply a forker's agent
stands up and reasons about a new hive — and host-routing wins on the two that matter
most for this project:

1. **Lowest possible touch: zero source files.** Adding a hive is a DNS/route action
   against the Cloudflare API; the DO is conjured on first `idFromName("host:bob")` and
   `initializeSchema` runs in its constructor. Nothing in application code changes.
2. **Conceptual coherence with what already exists.** Mnemion *already* federates by
   hostname and already frames itself as "sovereign hives, voluntary connections"
   (CLAUDE.md). A hive = a host = a federation unit is **one mental model at every
   scale**, so a forker's agent reasons about a single idea, not two. Credential-routing
   would introduce a second, parallel addressing scheme that contradicts the federation
   model.

Credential-routing's one structural advantage (a single host, isolation purely by DO
key) is outweighed by its missing core mechanism (founder bootstrap auth) and its
conflict with federation.

## Hardening backlog (must precede any real second tenant)

The routing substrate is small; the work is all on the isolation boundary. None of
this blocks the owner-only deploy; all of it blocks a *second* tenant.

- **Host-bind the session cookie.** Today the cookie signs `actor` with the global
  secret and is not host-scoped; bind `hiveId` into the payload and reject at
  `validateSession` when it mismatches the request host. *(Both models needed this.)*
- **Host-as-config carve-out (this branch specifically).** This branch's security
  boundary is "instance identity is configuration": `currentHost()` ignores spoofable
  inbound `Host` so capability URLs can't be poisoned. Host *selection* must read the
  raw `Host`, while capability-URL *minting* keeps reading `WORKER_HOST` — two host
  semantics in one request. This is a clarifying split (selection ≠ minting), not a
  regression, but it must be deliberate.
- **Namespace Vectorize by hiveId.** The `VECTORIZE` index is worker-global; without a
  per-hive namespace in the vector metadata, prime could surface another hive's entries.
  Needed for *any* multi-tenant model — check `entities/Hive/prime.ts`.
- **Gate unauthenticated DO-creation.** Zero-touch provisioning and "can't spam-create
  hives" are the same dial: an unauthenticated request with a novel subdomain
  instantiates a fresh DO. Fine for a forker running their own hives; add a creation
  allow-list before renting to strangers.
- **Per-tenant secrets (only if renting to strangers).** `MNEMION_SECRET` is
  worker-global and owns every hive. Acceptable for "one operator, several of their own
  hives"; a per-hiveId secret store is required before untrusted tenants.

Passkeys scope cleanly by construction: `rpID = hostname`, so a passkey at
`alice.host` simply doesn't authenticate at `bob.host` — correct sovereignty isolation,
at the cost of no cross-hive SSO (acceptable).
