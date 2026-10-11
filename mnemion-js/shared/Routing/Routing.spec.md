# Routing

Declarative HTTP dispatch and session machinery: pattern-matched route table plus constant-time, revocable session auth helpers.

## invariants
- deployable environment auth: A deployed worker without a master secret refuses owner access.
  over: every deployable Wrangler environment
  via: deployable environment auth fails closed
  because: Publishing DEV=true turns a secretless test worker into an unauthenticated owner endpoint.
  crossing: served-untrusted -> owner-trusted
  kinds: credential
  checklist: capability-authorization declared as deployable environment auth
  checklist: revalidated-permission dismissed: this rule checks deploy configuration; request-time session validation is separate
  checklist: message-authenticity dismissed: owner HTTP requests are authenticated by session or bearer, not signed peer messages
  checklist: encrypted-storage dismissed: this rule requires a master secret but does not encrypt stored data
  checklist: key-rotation-compatibility dismissed: it checks whether a deploy can bypass auth, not how a secret rotates
  checklist: separation-of-duties dismissed: this rule rejects anonymous owner access, not actor-role separation
- deployed public rate-limit bindings: Each deployed worker has both public cost guards bound.
  over: production and test Wrangler environments
  via: deployed public rate-limit bindings
  because: A named environment does not inherit top-level bindings, and absent limiters fail open.
  crossing: served-untrusted -> storage
  kinds: budget, deploy
  checklist: graceful-drain dismissed: this rule requires limiter bindings, not connection draining
  checklist: bounded-admission dismissed: rateLimit currently fails open if its service throws; this rule covers declared bindings
  checklist: fair-admission dismissed: the limiter keys and fairness policy are outside binding presence
  checklist: rate-budget declared as deployed public rate-limit bindings
  checklist: memory-budget dismissed: the limiter does not cap worker memory
  checklist: execution-budget dismissed: the limiter does not cap per-request CPU time
  checklist: circuit-breaker-policy dismissed: limiter service failures currently allow the request; no breaker is promised
  checklist: readiness-evidence dismissed: Wrangler binding declarations are checked in source; live readiness needs a deployment probe
  checklist: declared-target-coverage declared as deployed public rate-limit bindings
- bounded public request bodies: Public ingress and upload bodies stay within their byte limits even without Content-Length.
  over: public input, text upload, and document upload request bodies
  via: request body limit
  because: A chunked request could previously bypass the header-only check and buffer a much larger body.
  crossing: served-untrusted -> storage
  kinds: encoding
  checklist: key-rotation-compatibility dismissed: body size enforcement has no key or rotation stage
  checklist: semantic-preservation declared as bounded public request bodies
  checklist: canonical-encoding dismissed: this boundary limits raw bytes before format-specific decoding
- upload capability receipts: Upload-only capabilities receive write receipts without target entry data or internal blob keys.
  over: text and document capability upload responses
  via: upload capability receipts
  because: Returning a full row after a write lets a narrow upload token read private entry fields and internal blob keys.
  crossing: storage -> public-egress
  kinds: output, credential
  checklist: capability-authorization dismissed: token authorization happens before the write; this rule limits the response after authorization
  checklist: revalidated-permission dismissed: the one-time upload token is consumed by the Hive write, not by response shaping
  checklist: destination-confinement dismissed: this rule controls the response body returned to the upload caller, not an outbound destination
  checklist: message-authenticity dismissed: this route returns a synchronous HTTP response, not an authenticated message to another service
  checklist: encrypted-storage dismissed: these responses do not persist or decrypt stored data
  checklist: key-rotation-compatibility dismissed: response shaping does not rotate capability tokens or keys
  checklist: redaction declared as upload capability receipts
  checklist: separation-of-duties dismissed: receipt fields do not authorize another role or actor
  checklist: commit-ordered-effects dismissed: the Hive write completes before this response is built; this rule does not schedule effects
  checklist: circuit-breaker-policy dismissed: no downstream service is called while shaping the receipt
  checklist: declared-target-coverage declared as upload capability receipts
- served-content inertness: Served user content is inert on the first-party origin.
  over: all served response paths and active content types
  via: served-content inertness totality
  because: A publication or uploaded HTML document must not execute with the owner session cookie.
  crossing: served-untrusted -> public-egress
  entrances: none
  kinds: output
  checklist: destination-confinement dismissed: the rule makes same-origin content inert rather than choosing an outbound destination
  checklist: redaction dismissed: this rule prevents script execution; field sealing is egress-sensitivity totality
  checklist: commit-ordered-effects dismissed: served responses are reads with no commit-triggered effect
  checklist: circuit-breaker-policy dismissed: response headers do not call a remote service
  checklist: declared-target-coverage declared as served-content inertness
- served-read gating: Every visibility-gated served route checks its bearer scope.
  over: all gated served route shapes and secretless deploys
  via: served bearer-gating totality
  because: A new served read path must not expose a resource by omitting the bearer check.
  crossing: public-egress -> served-untrusted
  entrances: none
  kinds: read, credential
  checklist: scoped-reads declared as served-read gating
  checklist: capability-authorization declared as served-read gating
  checklist: revalidated-permission declared as served-read gating
  checklist: message-authenticity dismissed: this rule validates an HTTP bearer, not a signed peer message
  checklist: encrypted-storage dismissed: it governs reads after storage, not encryption at rest
  checklist: key-rotation-compatibility dismissed: token validation and revocation are separate from route coverage
  checklist: redaction dismissed: the route either serves or refuses the resource; egress sealing is separate
  checklist: separation-of-duties dismissed: this rule checks visibility and bearer scope, not actor roles
- session bearer gate: An OAuth bearer on a session route authenticates as its granting member only while that member is active, the grant names this hive, and any audience covers the request.
  over: every Auth.SESSION route (/api/*, /ws, /export) presented with an Authorization Bearer header
  via: session bearer gate
  because: Native clients cannot use the browser cookie; a token replayed from /mcp or kept by a suspended member must not reach owner-plane reads and writes.
  crossing: served-untrusted -> owner-trusted
  kinds: credential
  checklist: capability-authorization declared as session bearer gate
  checklist: revalidated-permission declared as session bearer gate
  checklist: message-authenticity dismissed: the provider's token store authenticates the bearer; requests are not signed messages
  checklist: encrypted-storage dismissed: grant props are encrypted by the OAuth provider, not by this gate
  checklist: key-rotation-compatibility dismissed: access tokens expire hourly and refresh through the provider; the gate holds no key
  checklist: separation-of-duties dismissed: this rule attributes the member; role separation is not enforced on session routes
