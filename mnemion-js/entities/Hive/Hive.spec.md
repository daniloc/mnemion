# Hive

The single per-user Durable Object that owns all SQLite data and funnels every agent write through one kernel-enforced chokepoint.

## invariants
- kernel write boundary
- kernel read+write capability
- pattern-effects totality
- facet/kernel-column collision

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
- boundary "kernel read+write capability" at query via test "context-capability totality"
- boundary "pattern-effects totality" at PATTERN_EFFECTS via test "pattern-effects totality"
- boundary "facet/kernel-column collision" at KERNEL_COLUMN_SET via test "facet-kernel-collision totality"
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

HiveDO is the single Durable Object that owns the SQLite store; every write funnels through its `mutate`/`batchMutate`/`processInput`/`consumeUpload` chokepoints precisely so the kernel-write boundary is enforced in one place instead of re-derived per call site. `policy.ts` is the dependency-free leaf source of truth for "which patterns agents can write, through which path, what gate fires" — unclassified kernel patterns fail CLOSED (System → denied) so a new pattern can never silently become agent-writable, and kernel/prime/ingress gates all derive from it so the boundary cannot drift between layers.

Kernel COLUMNS get the same single-source treatment as kernel patterns. `kernel-columns.ts` is the dependency-free SSOT for the seven auto-provided columns; every "the kernel columns" or named-slice need (the data engine's create-exclude/facet-skip sets, the schema display, the history-diff ignore set) is DERIVED from it by filter, never re-listed, so a slice can't drift from the source. The **facet/kernel-column collision** invariant rides on that: a user-proposed facet may not be named after a kernel column (it would shadow the auto-added column on the same table), and the reservation at the `propose_change` chokepoint (`validateFacets`, reached by BOTH create_pattern and add_facet) is the FULL `KERNEL_COLUMN_SET` — deliberately NOT a narrowed subset. A subset was the historical bug (it omitted `version`/`created_by`/`updated_by`, so those three were nameable as facets). Because the reservation IS the kernel column set, adding a kernel column auto-reserves it, and the `facet-kernel-collision totality` oracle iterates `KERNEL_COLUMNS` asserting every one is rejected on both paths — so the under-coverage is impossible to reintroduce without failing the suite.

The agent-facing WRITE surface reaches the engine over two transports — the interactive MCP `mutate` tool (`entities/Session/session.ts`) and the browser-authenticated `/api/mutate`. The *gating DECISIONS* those transports share — which gate a single op must clear (`mutateGate`: patch-reject vs. consent round-trip vs. pass), which op may not ride inside a batch (`findGatedBatchOp`), and how loosely-typed tool input normalizes (`normalizeMutateData`/`isSingleOpData`) — live in `mutate-gate.ts` as PURE derivations of `policy.ts`, not inline imperative branches in the MCP handler. That removes the real drift vector (an `/api`+RPC test passing while the MCP Zod/consent layer silently breaks): the decision has one tested home. The interactive consent round-trip MECHANICS (`checkAndArmConsent` + re-issue) stay in `session.ts` because only the MCP path can satisfy them; `mutate-gate.ts` decides WHETHER the round-trip fires, never how. `/api` stays owner-implicit (a logged-in human IS the consent) and does not consult the consent decision.

Reads share the SAME boundary, on the same flag. `DataContext.trusted` is required and gates kernel access symmetrically: an untrusted context (`!trusted`) may neither write a kernel pattern nor read one. The trust decision is a CAPABILITY, not a per-call-site convention: `HiveDO` exposes two named constructors over a trust-agnostic `ctxFields` — `ownerDataCtx` (the ONLY `trusted: true`) and `servedDataCtx` (`trusted: false`) — and there is no trust parameter to dial at a call site. Served/untrusted reads (public page chart/metric, OG card, publication source, `/o/entry`) AND untrusted writes (ingress, upload) go through `servedDataCtx`, where the `data.ts` engine refuses any kernel pattern — so a serve/ingress sink physically cannot read or write `_access_tokens`/`_members`/etc. ALL served public reads — the public-page + OG-card render orchestration AND `getSharedEntry`/`resolvePublication`/`resolveOutput`/`getInputVisibility` — live in one module (`served.ts`), handed a narrow `ServedContext` that exposes ONLY the served reader (`servedQuery`) for user-pattern data plus a small set of bound kernel-CONFIG lookups (each returning ONE specific answer — a `_shared` visibility, a `_publications`/`_outputs`/`_inputs` config row, supersession ids, facet metadata) — never `db`, never a trusted context, no way to construct one — so every served read's user-pattern access IS the kernel-refusing chokepoint and the kernel-config reads stay confined to single-answer hands (the same shape `federation.ts` gets for its allow-list). The DO keeps thin RPC stubs (the RPC contract io.ts calls) over those functions. That made the old per-block `isKernelPattern` guard in `renderBlockHtml` provably redundant (a kernel-named block just reads back empty through `servedQuery`); it was deleted, leaving one chokepoint instead of a guard to forget per block type. The same redundancy retired `getSharedEntry`'s old hand-rolled `isKernelPattern` guard: its entry read now goes through `servedQuery` (which refuses kernel patterns at the engine AND binds the id, so no SQL-identifier injection), exactly as the render path's per-block guard was retired — the `patternExists`/`Number.isInteger(id)` checks survive only as a clean early not-found, never as the security gate. Because trust is fixed by the constructor (and the engine flag is required, no default), a NEW serve path can't silently inherit kernel access; it fails CLOSED. `context-capability totality` guards that the split can't rot back into a trust-defaulting factory. This replaced a block-list of scattered per-sink `isKernelPattern` checks that failed open. The read totality is the served-entry-point enumeration in `security.test.ts`, the analogue of `policy.test.ts` for writes. Instance identity is configuration, not request data: `currentHost()` is authoritative on `WORKER_HOST` and IGNORES the inbound `Host`, so an attacker cannot poison a capability URL (`upload_url`/`page_url`/`og_image`) by sending a spoofed `Host` on an unauthenticated request (e.g. a `/ws` upgrade).

Cross-hive (foreign-URI) resolution lives in its own module (`federation.ts`), the one place that sends THIS hive's access token (`?token=` → `Authorization: Bearer`) to another origin. Its token-send is CO-LOCATED with the allow-list consent check in a single function (`federatedResolve`) precisely so the approved host and the contacted host can never drift apart: a token is attached only to a request whose host is BOTH not `isBlockedFederationHost` (SSRF block) AND `isHostAllowed` (the `_federation_hosts` consent allow-list), and that pair is re-validated on the INITIAL request AND on EVERY redirect hop, in lockstep with the fetch loop. Splitting the gate from the fetch — across modules or call sites — would let a future edit move one without the other; here they move as a unit. The DO hands the module a NARROW `FederationContext` — only the bound allow-list lookup (`isHostAllowed`, wrapping `_federation_hosts`, never `db`) + `errorJson` — so federation cannot read anything else; `resolve` stays on the DO and decides local vs. federated before dispatching here. This is the security analysis's "condition #2".
