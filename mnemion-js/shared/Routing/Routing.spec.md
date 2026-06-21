# Routing

Declarative HTTP dispatch and session machinery: pattern-matched route table plus constant-time, revocable session auth helpers.

## invariants
- served-content inertness

## works when
- router.ts exists at this node
- router.ts imports ../core/constants
- routes/auth.ts exists at this node
- routes/io.ts exists at this node
- routes/io.ts imports ../router
- boundary "served-content inertness" at inertHeaders via test "served-content inertness totality"

## why

The router is the worker's declarative HTTP dispatch (method, pattern, auth gate, param constraints matched in declaration order) with handlers grouped by domain under `routes/`, so the full routing surface stays scannable. Its auth helpers are security-load-bearing: `timingSafeEqual` is constant-time to close a timing-attack finding on secret/token/signature checks, and session cookies carry a random sid plus a KV-stored epoch so every session can be revoked without rotating `MNEMION_SECRET`, while encoding the actor backward-compatibly so deploys don't force a re-login.

**Served-content inertness** is the read/serialization dual of the security boundaries: agent- or uploader-authored content served on the FIRST-PARTY origin (which holds the owner's session cookie and can drive `/api/*`/`/mcp`) must never run as active script. The boundary was a CONVENTION ("any served path neutralizes active MIME") correctly implemented at `/o` but silently drifted at two siblings — `/p` publications omitted the `sandbox` directive (so owner-authored markup ran same-origin), and `/f` documents echoed the UPLOADER-controlled `Content-Type` inline with neither `nosniff` nor `sandbox`, turning a `text/html` upload into stored XSS / owner-session theft. The fix makes the convention a CONTRACT: one chokepoint, `inertHeaders(contentType)` (`routes/io.ts`), classifies every served MIME into safe-inline vs active (`ACTIVE_SERVED_MIME` → `Content-Security-Policy: sandbox; default-src 'none'`, forced `attachment` for the file store) and always sets `X-Content-Type-Options: nosniff`; `serveOutput`/`servePublication`/`serveDocument` all route through it. The `served-content inertness totality` oracle enumerates the served egress routes (driving each with active content) AND iterates the live `ACTIVE_SERVED_MIME` registry, asserting every served path returns inert headers — so a NEW served path that emits un-neutralized active content fails the build. The block-list of per-handler MIME handling that could fail open became one chokepoint with a totality over it.
