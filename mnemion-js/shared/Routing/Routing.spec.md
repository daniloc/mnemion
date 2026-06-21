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

The router is the worker's declarative HTTP dispatch (method, pattern, auth gate, param constraints matched in declaration order) with handlers grouped by domain under `routes/`, so the full routing surface stays scannable. Its auth helpers are security-load-bearing: `timingSafeEqual` is constant-time to close a timing-attack finding on secret/token/signature checks, and session cookies carry a random sid plus a KV-stored epoch so every session can be revoked without rotating `MNEMION_SECRET`, while encoding the actor backward-compatibly so deploys don't force a re-login.

**Served-content inertness** is the read/serialization dual of the security boundaries: agent- or uploader-authored content served on the FIRST-PARTY origin (which holds the owner's session cookie and can drive `/api/*`/`/mcp`) must never run as active script. The boundary was a CONVENTION ("any served path neutralizes active MIME") correctly implemented at `/o` but silently drifted at two siblings — `/p` publications omitted the `sandbox` directive (so owner-authored markup ran same-origin), and `/f` documents echoed the UPLOADER-controlled `Content-Type` inline with neither `nosniff` nor `sandbox`, turning a `text/html` upload into stored XSS / owner-session theft. The fix makes the convention a CONTRACT: one chokepoint, `inertHeaders(contentType)` (`routes/io.ts`), classifies every served MIME into safe-inline vs active (`ACTIVE_SERVED_MIME` → `Content-Security-Policy: sandbox; default-src 'none'`, forced `attachment` for the file store) and always sets `X-Content-Type-Options: nosniff`; `serveOutput`/`servePublication`/`serveDocument` all route through it. The `served-content inertness totality` oracle enumerates the served egress routes (driving each with active content) AND iterates the live `ACTIVE_SERVED_MIME` registry, asserting every served path returns inert headers — so a NEW served path that emits un-neutralized active content fails the build. The block-list of per-handler MIME handling that could fail open became one chokepoint with a totality over it.

**Served-read gating** is the auth dual of inertness: where inertness governs HOW served content is emitted, this governs WHETHER a visibility-gated resource is served at all. Every served READ route that exposes a `_shared`/`_outputs`/`_publications`/`_documents` resource must refuse an unlisted/private resource to an unauthenticated caller — enforced by `denyUnlessBearerScope` (the bearer gate) plus the secretless-deploy 404 short-circuit. This was a CONVENTION ("any new served read route remembers to gate"), a 5-call-site block-list that fails open the moment one route forgets. The `served bearer-gating totality` oracle iterates the served gated-read route table and asserts each refuses an unlisted resource WITHOUT a token (and that the body/secret never rides a refusal) — so a new served read route that exposes a gated resource un-gated would serve the unlisted body and fail. Anchored `via guard`: it enumerates a fixed route-shape set, not a runtime-varying domain.
