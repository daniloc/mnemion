# Rationale from the original Coherence specs

The v0 `## why` sections were preserved during migration to the PostHog Coherence spec grammar. Current requirements live in the co-located `*.spec.md` files.

## Mnemion.spec.md

The worker entry keeps the entire HTTP surface as one scannable declarative route table (method, pattern, auth gate, handler per line) so the system's shape is graspable from the declarations alone, per the "code as schematic" principle. OAuthProvider wraps the worker to own the OAuth 2.1 / DCR / token flow and intercept `/mcp`, `/token`, `/register` before dispatch, so the rest of the code never re-implements auth plumbing.

## entities/Hive/Hive.spec.md

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

## entities/Session/Session.spec.md

(SessionDO is one Durable Object per MCP session: it handles the MCP protocol — tools, resources, init instructions — and proxies to the single HiveDO over RPC, keeping protocol concerns out of the data substrate. It also stamps the authenticated actor onto writes from its OAuth props, so attribution is enforced at the protocol edge.)

**tools SSOT totality.** Tool metadata feeds two consumers — the MCP `.tool(`/`.registerTool(` registrations and the `/api/tools` frontend — and the rejected design was "two parallel hand-lists, keep them in sync." The real failure shipped when `render` was registered inline without a corresponding `TOOLS` row: a live MCP tool invisible to `/api/tools`, visible to one consumer and not the other, with no warning anywhere. A tool present in one place and absent from the other is what the boundary makes unrepresentable.

## entities/features/Features.spec.md

A "feature" is the extensibility keystone, and today its footprint is smeared
across registries a forker's agent must find and edit in lockstep: post-mutate
effects (`entities/Hive/effects.ts`), HTTP routes (`src/index.ts`), MCP tools
(`entities/Session/tools.ts`), kernel patterns + DDL (`entities/Hive/schema.ts`),
write-policy class (`entities/Hive/policy.ts`), system docs, and the coherence
spec. The `Feature` type collects all of those contributions into ONE
co-located, typed declaration; the composers in `compose.ts` DERIVE each
registry from the hand-maintained `FEATURES` barrel (`index.ts`). Adding a
feature is then: create one dir + add one import line to the barrel — its whole
footprint legible in the manifest instead of scattered.

`effects` was the first registry wired end-to-end; `routes` is the second:
`PATTERN_EFFECTS` in `effects.ts` is `composeEffects(FEATURES)`, and the route
table in `src/index.ts` is `[...CORE_ROUTES, ...composeRoutes(FEATURES)]` rather
than one hand-written literal. The `documents` feature owns its `/f/*` upload +
serve edges and the `pages` feature owns its `/page/*` serve + OG edges, declared
in their manifests (handlers still imported from the I/O adapter layer,
`shared/Routing/routes/io.ts` — the manifest declares the routing rows, not the
handler bodies). So a new side-effecting pattern, or a new HTTP edge for these
features, is a feature manifest — not another entry in a central map.

Route ORDER is load-bearing and preserved: the router matches in declaration
order (first match wins), and feature routes are appended AFTER `CORE_ROUTES`, so
a feature route can never shadow a core route. The moved patterns (`/f/...`,
`/page/...`) share no prefix with any retained core route (`/o/`, `/p/`,
`/marketplace*`, etc.), so the move changes no match outcome — confirmed by the
route/document/page tests staying green. Each route's `backendPrefix` travels
with its declaration into `BACKEND_PREFIXES`, so a moved route's SPA-fallback
exclusion is derived from the manifest, not re-hardcoded in `src/index.ts`.

Patterns + migrations are the third and fourth registries wired end-to-end: each
feature owns its PATTERN STRUCTURE — the kernel-pattern DDL/facets/index and any
feature-specific schema migration — as PURE DATA in its dir
(`<name>/schema.ts`, type-only imports, no manifest code), and `schema.ts` builds
`KERNEL_TABLES = [...CORE_KERNEL_TABLES, ...composePatterns(FEATURES)]` while its
boot migration pile gains a tail loop over `composeMigrations(FEATURES)`. The
`documents` feature owns the `_documents` table + its v12 extraction-columns
migration; the `pages` feature owns the `_pages` table + path index. The move is
byte-identical: every consumer of `KERNEL_TABLES` (the boot DDL loop, `_fields`
seeding, the audit triggers, and crucially `verifyFieldsIntegrity` — the
DDL↔`_fields` drift oracle — plus `verifyWritePolicyTotality`) reads the COMPOSED
array, so a feature pattern is indistinguishable from a core one and an existing
hive sees no schema diff at boot. The feature `schema.ts` files stay PURE DATA so
they share the leaf discipline of the `*/security.ts` siblings (the structure half
of "a feature owns its schema," beside the security half).

The kernel PRE-MUTATION HOOKS are the fifth registry, completing "a feature owns its
kernel pattern": the `_documents` create validation (title required) + its
system-managed immutable bookkeeping columns live in `documents/hooks.ts`, and the
`_pages` write-time hook (URL-safe path + block-palette validation + the
kernel-pattern exfil guard) lives in `pages/hooks.ts`. A feature declares these in
its manifest's `hooks` slot; `kernel.ts` renames its hand-written literals to
`CORE_ON_CREATE`/`CORE_ON_WRITE`/`CORE_IMMUTABLE` and derives the EXPORTED
`ON_CREATE`/`ON_WRITE`/`IMMUTABLE` as `mergeDisjoint(CORE_*, compose*(FEATURES))`.
ENFORCEMENT does NOT move — `applyKernelRules` (the one chokepoint every mutate runs
through) reads the EXPORTED composed maps, so the validation fires byte-for-byte as
before (confirmed by the document title/immutability + page block-exfil tests staying
green); only the DECLARATION moves into the feature dir, exactly as `effects` compose
into `PATTERN_EFFECTS` but fire at the mutate chokepoint. The hook bodies are code, so
`<dir>/hooks.ts` imports ONLY TYPES from `kernel.ts` (the hook signature types +
`ImmutableRule` shape) — type imports are erased at runtime, so the `kernel.ts →
FEATURES → manifest → hooks` back-edge is type-only and adds NO runtime cycle
(`dpdm -T`, which strips type-only edges, shows the same single pre-existing runtime
cycle before and after). `mergeDisjoint` mirrors policy.ts: a feature hook for a CORE
pattern throws at module load, so a feature can never silently override a core
invariant.

Composition for `effects`/`tools`/`writePolicy`/`routes` runs at MODULE LOAD
(static tables); `patterns`/`migrations`/`systemDocs` compose at BOOT (they touch
the DB). The composers fail LOUDLY on collision (two features over one pattern's
effect, a duplicate migration version, a route/tool/pattern name clash) rather
than silently last-write-wins — a malformed manifest can't quietly shadow another
feature; a feature↔core pattern-name clash is caught by policy.ts's `mergeDisjoint`
at module load. The fail-CLOSED write-policy default is preserved: a feature
pattern declared without a write-policy entry still resolves to System/denied,
never silently agent-writable. System docs stay a single source (`http-io.md`
spans egress/publications/documents/ingress, so it isn't split per-feature); the
remaining registries (`tools`, `systemDocs`) keep ONE source of truth each until
they adopt their composer (documented landing spots in `compose.ts`), so this
migration adds the seam without duplicating definitions.

`clipboards` is the feature that EXTENDS THE CORE CHOKEPOINT. Unlike `documents`/
`pages` (which add only effects/routes/their own pattern + hooks), a clipboard is a
validated job-dispatch form: a `_clipboards` row binds a reusable, deterministically-
validated form to a target dataset pattern, and every create/update on that pattern
becomes a SUBMISSION — validated collect-all (regex/range/length/cross-field/composite
uniqueness) and scored against a composable numeric completion contract. The feature
DIR owns only the declaration (the `_clipboards` pattern/schema, the fail-closed
DEFINITION hook in `hooks.ts` that rejects an unknown constraint/metric/op, and the
`Consent` write class — binding a contract to an existing shared dataset is an
injection-reachable write-availability lever, so creation takes a human round-trip like
`_members`/`_shared`). The ENFORCEMENT is core: two generic LEAF engines
(`entities/Hive/{constraints,completion}.ts` — `CONSTRAINT_RULES`/`COMPARISON_OPS` and
`COMPLETION_METRICS`) configured by the `_clipboards` DATA, invoked at the ONE mutate
chokepoint (`executeMutate`) via the `clipboardFor` seam on `DataContext`. So the
chokepoint covers every write path — MCP mutate AND public ingress — and a fanout of
agents all filling one clipboard is race-free (a single DO serializes the
SELECT-then-INSERT, so composite-uniqueness dedupe holds and each submission's derived
progress is a consistent snapshot). The fail-closed knot is a double-entry TOTALITY
oracle: the constraint/metric/op keys the definition hook ACCEPTS must equal the keys
the engines ENFORCE — a rule that could be stored but silently isn't checked (fail-OPEN)
fails the suite. Progress is DERIVED from the submission log every read (data-is-destiny:
`count`/`sources_covered`/`days_since_last` are SQL aggregates, never stored counters).
`patternClass` joined `KernelContext` so the definition hook can require a dataset-class
target (guaranteeing the chokepoint's type coercion runs before numeric comparison).

`scratchpad` is the pub/sub coordination feature: a `_scratchpad` row is a NOTE posted to
a named shared PAD, so agents in neighboring sessions on one hive can coordinate a fanout
(claim/done/found) without polling. The DATA half is doctrine-standard — an `Open`,
`auditExempt`, append-only kernel pattern (coordination chatter, not durable memory, so
NOT `primeInclude` and GC'd at 30 days in the boot sweep, mirroring `_entry_access_log`)
with an `onCreate` hook validating the pad slug + kind. Reads are free: the
`mnemion://scratchpad/{pad}` resource is an ordinary `query` (newest-first by pad), and
agents can poll `query _scratchpad pad=X id>cursor` to catch up. The PUSH half (Phase 2)
extends CORE — there is no HiveDO→SessionDO channel today, so a post fans out via an
effect that RPCs each live session's `notifyScratch`, which must emit `sendResourceUpdated`
from WITHIN the agents-framework agent context (a bare DO-to-DO RPC has none — confirmed
by spike). `schedule()` is the supported in-context entrypoint, so the emit is a
near-immediate scheduled task. The session registry + the per-pad `resources/subscribe`
handlers are the new SessionDO↔HiveDO seam this feature owns.

## shared/Auth/Auth.spec.md

Auth primitives (passkeys + access/register/auth tokens) are isolated as pure db-accessor functions so credential concerns stay separate from the cognitive substrate; the multi-row passkey model (one credential per member, NULL = bootstrap owner) exists because one shared hive is authenticated into by several people each acting as themselves. `resolveRegisterToken` deliberately re-validates scope/owner/roster at setup/consume time — independent of how the token's fields were set — because an adversarial review showed mint-time checks alone could be bypassed by a post-create constraints update to mount an owner-takeover, and a malformed member-less token must be unusable rather than defaulting to the owner sentinel.

Access tokens are stored HASHED at rest (`hashToken`, SHA-256): `findAccessToken` hashes the presented value and compares digests, mint stores only the digest (the raw token is shown once), and a boot migration hashes any legacy plaintext token in place. So a read of an `_access_tokens` row — a `query`, a `search` hit, a leaked DO snapshot — discloses only a digest, never a usable bearer. This is a deliberate exception to "store truth once": the secret's preimage is never persisted, which neuters the entire "a token reached a read sink" class independent of which sink leaks. Because the column holds a digest, every lookup that needs the token is async (`crypto.subtle.digest`), which is why these accessors return Promises.

## shared/core/Core.spec.md

Core is the layer both runtimes depend on but neither owns, so it carries zero env-specific imports and stays pure data — that purity is what lets the same module validate a write in the worker and render it in the SPA without forking.

Its center of gravity is the agent-authorable UI: `view-palette` (how a pattern renders), `format-palette` (how a value renders), `block-palette` (how a page composes), and the chart pair (`chart-spec` + `chart-svg`). These are the canonical instances of the "self-enforcing declarations" doctrine — one declarative table that is simultaneously the spec an agent reads, the validator the kernel derives (`validateViewSpec`/`validateBlocks`/`validateFormatsMap`, fail-closed at the mutate chokepoint), and the totality oracle the SPA's `Record<…Id, Component>` enforces at compile time. The agent composes UI from these tables as data, never as code, which is what makes live agent-authored rework safe.

The chart layer is deliberately split so one spec drives two renderers: `chart-spec` is the single home for the mark set, the categorical color palette, and the long→wide series pivot, and both the in-hive Recharts renderer and the server SVG renderer (`chart-svg`, for published pages and OG cards) derive from it — so a dataset reads identically in-hive and on a public page. `constants` keeps product identity (`PRODUCT_NAME`, `URI_SCHEME`, `uri()`) in one place so the scheme is never hardcoded. `dev-seed` is gated and runs only in the DO constructor under `DEV_SEED`; it writes via raw SQL (trusted, bypassing the kernel hook), so its contents must stay valid against these same palettes by hand — it is inert in production.

## shared/IO/IO.spec.md

IO holds the adapters that move data across the hive's boundary, kept as focused single-purpose modules so each owns one concern. Publications render live pattern projections at request time (never stored) per the "data is destiny" doctrine; `web.ts` caches adapter-fetched content as durable memory with a re-fetch-horizon TTL and refuses blocked hosts; `extract.ts` splits inline text extraction from async PDF extraction off the response path because only the DO has `waitUntil`, capping extracted text to stay under the entry size limit.

## shared/Routing/Routing.spec.md

(The router is the worker's declarative HTTP dispatch — method, pattern, auth gate, param constraints, matched in declaration order — with handlers grouped by domain under `routes/`, so the full routing surface stays scannable. Two auth primitives ride along that aren't yet declared invariants on their own: `timingSafeEqual` is constant-time to close a timing-attack finding on secret/token/signature checks, and session cookies carry a random sid plus a KV-stored epoch so every session can be revoked without rotating `MNEMION_SECRET`. Candidates for promotion when an oracle is added.)

**Served-content inertness.** Agent- or uploader-authored content served on the FIRST-PARTY origin (which holds the owner's session cookie and can drive `/api/*`/`/mcp`) must never run as active script. The rejected design was a per-handler MIME block-list ("any served path remembers to neutralize active MIME") — correctly implemented at `/o` but silently drifted at two siblings: `/p` publications omitted the `sandbox` directive so owner-authored markup ran same-origin, and `/f` documents echoed the UPLOADER-controlled `Content-Type` inline with neither `nosniff` nor `sandbox`, turning a `text/html` upload into stored XSS / owner-session theft. A block-list of per-handler MIME handling fails open the moment one site forgets — the same failure mode that made it a convention crossing in the first place.

**Served-read gating.** The auth dual of inertness: where inertness governs HOW served content is emitted, this governs WHETHER a visibility-gated resource is served at all. The rejected design was a 5-call-site block-list — "any new served read route remembers to gate" — that fails open the moment one route forgets, a real risk because adding a served read path is otherwise a cheap edit. A secretless deploy was an additional silent failure mode: with no master secret configured, owner-only APIs returned 503 but served reads still went through the bearer check against a NULL secret. Both failure modes are killed at one chokepoint with a fixed enumeration over the gated route-shape set. Anchored `via guard` rather than `via test` because the domain is a known route table, not a runtime-varying live domain.

(Operational protection of the public surfaces is cost/availability, not a security boundary, so it isn't a declared invariant. Two layers, both fail-OPEN so absence is harmless: `rateLimit` over the GA `ratelimit` bindings caps the public WRITE surface per endpoint and the public READ surfaces per client IP, and `cached` wraps the public GET reads in `caches.default` so a hit returns from Cloudflare's per-colo edge without running the Worker or touching the DO. Together they answer the single-DO contention ceiling: hot public reads offload to the edge, and what reaches the DO — writes, cache misses, cache-busting enumeration — is throttled. Early `Content-Length` caps on the buffered text bodies bound Worker memory before the transform DSL runs.)
