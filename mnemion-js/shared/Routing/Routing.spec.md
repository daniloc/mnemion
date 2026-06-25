# Routing

Declarative HTTP dispatch and session machinery: pattern-matched route table plus constant-time, revocable session auth helpers.

## invariants
- served-content inertness
- served-read gating

## works when
- router.ts exists at this node
- router.ts imports ../core/constants
- routes/auth.ts exists at this node
- routes/io.ts exists at this node
- routes/io.ts imports ../router
- boundary "served-content inertness" at inertHeaders via test "served-content inertness totality"
- boundary "served-read gating" at denyUnlessBearerScope via guard "served bearer-gating totality"

## why

(The router is the worker's declarative HTTP dispatch — method, pattern, auth gate, param constraints, matched in declaration order — with handlers grouped by domain under `routes/`, so the full routing surface stays scannable. Two auth primitives ride along that aren't yet declared invariants on their own: `timingSafeEqual` is constant-time to close a timing-attack finding on secret/token/signature checks, and session cookies carry a random sid plus a KV-stored epoch so every session can be revoked without rotating `MNEMION_SECRET`. Candidates for promotion when an oracle is added.)

**Served-content inertness.** Agent- or uploader-authored content served on the FIRST-PARTY origin (which holds the owner's session cookie and can drive `/api/*`/`/mcp`) must never run as active script. The rejected design was a per-handler MIME block-list ("any served path remembers to neutralize active MIME") — correctly implemented at `/o` but silently drifted at two siblings: `/p` publications omitted the `sandbox` directive so owner-authored markup ran same-origin, and `/f` documents echoed the UPLOADER-controlled `Content-Type` inline with neither `nosniff` nor `sandbox`, turning a `text/html` upload into stored XSS / owner-session theft. A block-list of per-handler MIME handling fails open the moment one site forgets — the same failure mode that made it a convention crossing in the first place.

**Served-read gating.** The auth dual of inertness: where inertness governs HOW served content is emitted, this governs WHETHER a visibility-gated resource is served at all. The rejected design was a 5-call-site block-list — "any new served read route remembers to gate" — that fails open the moment one route forgets, a real risk because adding a served read path is otherwise a cheap edit. A secretless deploy was an additional silent failure mode: with no master secret configured, owner-only APIs returned 503 but served reads still went through the bearer check against a NULL secret. Both failure modes are killed at one chokepoint with a fixed enumeration over the gated route-shape set. Anchored `via guard` rather than `via test` because the domain is a known route table, not a runtime-varying live domain.

(Operational protection of the public surfaces is cost/availability, not a security boundary, so it isn't a declared invariant. Two layers, both fail-OPEN so absence is harmless: `rateLimit` over the GA `ratelimit` bindings caps the public WRITE surface per endpoint and the public READ surfaces per client IP, and `cached` wraps the public GET reads in `caches.default` so a hit returns from Cloudflare's per-colo edge without running the Worker or touching the DO. Together they answer the single-DO contention ceiling: hot public reads offload to the edge, and what reaches the DO — writes, cache misses, cache-busting enumeration — is throttled. Early `Content-Length` caps on the buffered text bodies bound Worker memory before the transform DSL runs.)
