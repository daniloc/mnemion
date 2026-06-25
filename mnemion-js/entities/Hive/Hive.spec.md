# Hive

The single per-user Durable Object that owns all SQLite data and funnels every agent write through one kernel-enforced chokepoint.

## invariants
- kernel write boundary
- kernel read+write capability
- egress-sensitivity totality
- pattern-effects totality
- facet/kernel-column collision
- data-is-destiny no-hybrid
- credential-mint gating
- born-hashed secrets
- immutable-field enforcement
- token-scope-grammar
- SSRF block-host coverage
- sql-identifier quoting
- instance-identity host

## works when
- hive.ts exists at this node
- hive.ts imports cloudflare:workers
- hive.ts imports ./data
- policy.ts exists at this node
- kernel-columns.ts exists at this node
- data.ts imports ./kernel-columns
- evolution.ts imports ./kernel-columns
- schema.ts imports ./kernel-columns
- hive.ts imports ./kernel-columns
- data.ts exists at this node
- mutate-gate.ts exists at this node
- mutate-gate.ts imports ./policy
- prime.ts imports ./policy
- boundary "kernel write boundary" at writeClass via test "write-policy totality"
- boundary "kernel read+write capability" at query via guard "context-capability totality"
- boundary "egress-sensitivity totality" at SENSITIVE_COLUMNS via test "egress-sensitivity totality"
- boundary "pattern-effects totality" at PATTERN_EFFECTS via test "pattern-effects totality"
- boundary "facet/kernel-column collision" at FACET_RESERVED_COLUMNS via test "facet-kernel-collision totality"
- boundary "data-is-destiny no-hybrid" at findStoredDerivedAggregates via test "data-is-destiny no-hybrid totality"
- boundary "credential-mint gating" at findUngatedCredentialMints via test "credential-mint gating totality"
- boundary "born-hashed secrets" at SENSITIVE_COLUMNS via test "born-hashed-secret totality"
- boundary "immutable-field enforcement" at applyKernelRules via test "IMMUTABLE-registry totality"
- boundary "token-scope-grammar" at isBroadTokenScope via guard "broad-token scope-grammar totality"
- boundary "SSRF block-host coverage" at isBlockedFederationHost via guard "SSRF block-host totality"
- boundary "sql-identifier quoting" at quoteIdent via guard "quoteIdent — grammar"
- boundary "instance-identity host" at resolveHost via guard "instance-identity host resolution"
- effects.ts exists at this node
- effects.ts imports ../features
- effects.ts imports ../features/compose
- documents.ts exists at this node
- hive.ts imports ./documents
- served.ts exists at this node
- hive.ts imports ./served
- federation.ts exists at this node
- hive.ts imports ./federation
- reports.ts exists at this node
- hive.ts imports ./reports

## why

HiveDO is the single Durable Object that owns the SQLite store; every write funnels through its `mutate`/`batchMutate`/`processInput`/`consumeUpload` chokepoints so the kernel-write boundary is enforced in one place instead of re-derived per call site. `policy.ts` is the dependency-free leaf SSOT for "which patterns agents can write, through which path, what gate fires" — unclassified kernel patterns fail CLOSED (System → denied), so a new pattern can never silently become agent-writable, and kernel/prime/ingress gates all derive from it so the boundary can't drift between layers.

(The per-boundary paragraphs below record the non-derivable rationale — the bug or rejected alternative each boundary exists to kill. The mechanism — chokepoint, oracle, "iterates the live domain → fails the build" — is carried by the `## invariants` list and the `boundary "…" at <chokepoint> via test "<oracle>"` claims above, and isn't restated here.)

**facet/kernel-column collision.** Kernel COLUMNS get the same single-source treatment as kernel patterns: `kernel-columns.ts` is the SSOT for the seven auto-provided columns, and every named slice (the data engine's create-exclude/facet-skip sets, schema display, history-diff ignore set) is DERIVED from it. A user-proposed facet may not collide with a kernel column, so `validateFacets` reserves `FACET_RESERVED_COLUMNS` — the kernel columns MINUS the user-overridable ones. The one overridable column is `version` (a pattern may declare its own semver semantics; create_pattern's apply skips the kernel default). The historical bug was a hand-narrowed reserved subset that wrongly omitted `created_by`/`updated_by` (a same-named facet is a duplicate-column DDL error — they MUST be reserved); over-correcting to reserve `version` then broke the user-version feature. Splitting "overridable" into its own declaration fixes both directions at once: `reserved ∪ overridable = KERNEL_COLUMNS`, so neither under- nor over-reserving can recur.

**data-is-destiny no-hybrid.** Makes the "store truth once, derive its consequences" doctrine emergent from the schema rather than prose an agent can interpret away. The doctrine is semantic in general, but it has a DECIDABLE core: a pattern must not STORE an aggregate of rows it also RETAINS. `findStoredDerivedAggregates` checks exactly that, firing only when BOTH halves are present (an aggregate-named facet AND a child pattern referencing this one). It stays silent on the legitimate fork a convergence experiment surfaced — a bare counter with no retained instances IS the stored truth, not a denormalization, because there's no retained source to derive from. Boot warns rather than throws: a deliberate materialized aggregate is a valid reviewed override.

**credential-mint gating.** The consent dual of egress totality. A pattern with a `secret` column mints a born-hashed BEARER on every create, so that create MUST be consent-gated. `patch_only` is provably wrong for such a pattern — it declares create benign while create is the dangerous op — and that was a real shipped bug: `_access_tokens` was `patch_only`, so an injected agent could mint a broad `*` token (a full owner login credential, redeemable at `/auth/verify`) in one un-round-tripped `mutate` and exfiltrate it. Fixed by `on_broad_token`: minting a broad/portable scope (`*`, or a whole-class `read`/`write` key — `isBroadTokenScope`) round-trips like every other standing grant, while narrow target-bound (`upload`/`document`) and inert (`register`, gated by `/invite` passkey approval) scopes stay benign so the frequent legit flows aren't taxed. The rule DERIVES from `SENSITIVE_COLUMNS × KERNEL_WRITE_POLICY` (no new declaration), so re-classifying a credential-minter as `patch_only`/`Open` is unexpressible.

**born-hashed secrets.** The storage dual: credential-mint gating governs WHEN a bearer is minted; this governs HOW it's stored. `mintSecrets` is generic over `SENSITIVE_COLUMNS` and runs on every engine write path, so a `secret`-classed column is born-hashed by construction — the preimage is system-generated, returned ONCE in the create response, and only its SHA-256 digest lands in the column, the audit log, and the `/ws` delta. A read (owner or otherwise) yields a digest, never a usable bearer. The structural enforcement (generic `mintSecrets` keyed on the registry) makes this automatic for any declared secret column.

**immutable-field enforcement.** The registry dual of the create-time hooks: where `ON_CREATE` decides what a kernel row may be BORN as, `IMMUTABLE` / `IMMUTABLE_AFTER_CREATE` decide what it may never BECOME — the defense-in-depth behind the consent model. `approved_at`/`consumed_at` are `IMMUTABLE` so an agent can't self-approve its own invite or replay a single-use token; a token's `scope`/`member`/`constraints`/`token` and an ingress endpoint's `target_pattern` are `IMMUTABLE_AFTER_CREATE` so a row that passed create-time validation can't be silently repointed to a stronger capability; `_members.label` is frozen-after-create (NOT `IMMUTABLE`, which would reject it at birth) because it's the stable handle passkeys/tokens/attribution reference. Enforcement has two faces because the patch path edits one facet by name and sidesteps the top-level key scan: `applyKernelRules` covers create/update/unarchive, `immutableFieldError` covers patch. (`scopeMatches`, the `:`-boundary prefix grammar these freezes protect, is pinned by its own matrix test — a fixed-grammar correctness property, not a live-domain totality, so it's verified but not a boundary.)

**instance-identity host.** Closes the last unmanaged crossing the trust atlas surfaced (public-egress → owner-trusted): the host every generated capability URL is built from. A configured `WORKER_HOST` is AUTHORITATIVE and the inbound `Host` is IGNORED, so an attacker who plants a spoofed `Host` on an unauthenticated request (e.g. a `/ws` upgrade) can't poison an `upload_url`/`page_url`/`og_image` handed to the owner. This was enforced by `currentHost` but proven only by convention (the detector and atlas both flagged it tier-3). The decision is now the pure `resolveHost` (configured-wins-else-observed-else-localhost, placeholder treated as unconfigured), which `currentHost` delegates to — so the test IS the boundary. With this the manifold has zero tier-3 security crossings.

**sql-identifier quoting.** The structural enshrinement of an injection boundary that was a convention. The SQL-identifier crossing (a raw string becoming a table/column token) was guarded by "validate, then interpolate `"${x}"`" at scattered sites — two SEPARATE steps a new site can forget. `quoteIdent` fuses them: it validates against `IDENTIFIER_RE` and returns the double-quoted identifier, throwing on any injection-bearing name — so an identifier that skipped the upstream semantic check still can't carry injection. The query engine (~20 sites in `data.ts`) routes every identifier through it; the semantic checks (`facetMeta`/`isValidColumn`/`patternExists`) stay as the primary gate with `quoteIdent` as fail-closed defense beneath. This moved the boundary from tier-3 to tier-1. (DDL interpolation in `schema.ts`/`evolution.ts` is the tracked follow-up; the coarse `injection-lint` ratchet still covers those + the HTML egress sinks until they're enshrined too.)

**token-scope-grammar.** The classifier dual of credential-mint gating: that boundary decides a credential-minting create must be consent-gated; this decides WHICH scopes are "broad" enough to require the round-trip — so the partition `isBroadTokenScope` draws over the scope grammar IS the boundary. It drifted: a bare `parts.length >= 3` cutoff classified `read:entry:<pattern>` (3 parts) as narrow, but `scopeMatches` prefix-grants it every `read:entry:<pattern>:<id>` — a pattern-WIDE standing read key minted with NO round-trip, an exfil credential. The fix classifies by RESOURCE GRAMMAR, not length: a scope is narrow only when it reaches its kind's LEAF depth (`entry` at depth 4 — `pattern:id`; `output`/`publication`/`document`/`input` at depth 3), so `read:entry:<pattern>` falls short and is broad. The oracle reconciles the partition against both `scopeMatches` and the kinds `io.ts` actually mints, so a new served resource kind can't leave it incomplete.

**kernel write boundary — two transports.** The kernel write boundary reaches the engine over TWO transports: the interactive MCP `mutate` tool and the browser-authenticated `/api/mutate`. The rejected design had gating decisions inlined in the MCP handler; the drift vector was real — an `/api`+RPC test passing while the MCP Zod/consent layer silently broke, so the boundary's enforcement disagreed across the two paths a write can take. Pure decisions in one tested leaf (shared by both transports) is the fix. (Interactive consent round-trip mechanics stay in the session handler because only MCP can satisfy them; `/api` is owner-implicit — a logged-in human IS the consent.)

**kernel read+write capability.** Reads share the SAME boundary on the SAME flag: `DataContext.trusted` is required and gates kernel access symmetrically — an untrusted context may neither write nor read a kernel pattern. Trust is a CAPABILITY, not a per-call-site convention: `HiveDO` exposes two named constructors over a trust-agnostic `ctxFields` — `ownerDataCtx` (the ONLY `trusted: true`) and `servedDataCtx` (`trusted: false`) — with no trust parameter to dial at a call site, so served reads (public page, OG card, publication, `/o/entry`) AND untrusted writes (ingress, upload) physically cannot reach kernel data. All served public reads live in one module (`served.ts`), handed a narrow `ServedContext` exposing only `servedQuery` for user-pattern data plus single-answer kernel-CONFIG lookups (a `_shared` visibility, an endpoint config row, supersession ids, facet metadata) — never `db`, never a trusted context, no way to construct one. This made the old per-block / per-entry `isKernelPattern` guards provably redundant (a kernel-named read returns empty through `servedQuery`, which also binds the id against injection); they were deleted, leaving one chokepoint instead of a guard to forget per sink — replacing a block-list that failed open.

**egress-sensitivity totality.** The bug it kills was a FALSE oracle. Write policy and sensitive columns were composed from two parallel hand-lists, and the second silently omitted a feature (`pages`); the egress side had no totality check at all, so a forked feature that declared a `redact`/`secret` column but forgot the second barrel line got no `seal`/audit/export redaction with no boot warning. Two parallel hand-lists was the rejected design. `findUnclassifiedSensitiveColumns` is honestly demoted to a complementary NAME heuristic — it can't see a sensitive column with an innocuous name, so it isn't full totality.

**pattern-effects totality.** Post-mutate side effects (re-embed, cache invalidate, broadcast, …) were a hand-coded if-pile in `mutate()`: a feature adding a pattern that needed an effect had to remember to extend the if-tree, and a forgotten extension silently no-op'd at runtime. "Remember to add another branch" was the rejected design. Composing the effect set CORE + per-feature from the live `FEATURES` array, with the oracle asserting every effect-bearing pattern is represented, turns a missing entry into a build failure instead of a silent missing side effect — same shape as the write-policy and egress-sensitivity totalities (the three together are the feature-composition trio).

(Federation is not yet a declared invariant on its own — the SSRF block-host coverage above is what's formalized as a boundary; the rest is design rationale living co-located in `federation.ts` until a totality oracle is written for it. The shape: token-send and allow-list consent share a single function (`federatedResolve`) so the approved host and the contacted host can never drift apart, re-validated on every redirect hop; splitting gate from fetch across modules or call sites would let a future edit move one without the other. The narrow `FederationContext` capability the DO hands the module ensures federation can read nothing else. This is the security analysis's "condition #2" — a candidate invariant if a co-location oracle is added.)

**SSRF block-host coverage.** The totality dual of that SSRF guard. `isBlockedFederationHost` must refuse every class of non-public target — loopback/private/CGNAT/link-local IPv4 in every inet_aton encoding (dotted-decimal, octal, hex, integer), the IPv6 loopback/ULA/link-local/mapped/NAT64/6to4 forms, and the `.localhost`/`.local`/`.internal`/`.lan` suffixes — and a dropped category is a silent SSRF reopening (the canonical target is the cloud-metadata IP `169.254.169.254`). Its correctness was a convention ("remember every encoding") with no completeness check; the oracle's category→example table makes a new bypass class fail the build by name.
