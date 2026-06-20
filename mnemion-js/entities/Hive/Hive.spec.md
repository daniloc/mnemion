# Hive

The single per-user Durable Object that owns all SQLite data and funnels every agent write through one kernel-enforced chokepoint.

## works when
- hive.ts exists at this node
- hive.ts imports cloudflare:workers
- hive.ts imports ./data
- policy.ts exists at this node
- data.ts exists at this node
- prime.ts imports ./policy
- passes test "write-policy totality"
- passes test "context-capability totality"
- passes test "pattern-effects totality"
- effects.ts exists at this node

## why

HiveDO is the single Durable Object that owns the SQLite store; every write funnels through its `mutate`/`batchMutate`/`processInput`/`consumeUpload` chokepoints precisely so the kernel-write boundary is enforced in one place instead of re-derived per call site. `policy.ts` is the dependency-free leaf source of truth for "which patterns agents can write, through which path, what gate fires" — unclassified kernel patterns fail CLOSED (System → denied) so a new pattern can never silently become agent-writable, and kernel/prime/ingress gates all derive from it so the boundary cannot drift between layers.

Reads share the SAME boundary, on the same flag. `DataContext.trusted` is required and gates kernel access symmetrically: an untrusted context (`!trusted`) may neither write a kernel pattern nor read one. The trust decision is a CAPABILITY, not a per-call-site convention: `HiveDO` exposes two named constructors over a trust-agnostic `ctxFields` — `ownerDataCtx` (the ONLY `trusted: true`) and `servedDataCtx` (`trusted: false`) — and there is no trust parameter to dial at a call site. Served/untrusted reads (public page chart/metric, OG card, publication source, `/o/entry`) AND untrusted writes (ingress, upload) go through `servedDataCtx`, where the `data.ts` engine refuses any kernel pattern — so a serve/ingress sink physically cannot read or write `_access_tokens`/`_members`/etc. Because trust is fixed by the constructor (and the engine flag is required, no default), a NEW serve path can't silently inherit kernel access; it fails CLOSED. `context-capability totality` guards that the split can't rot back into a trust-defaulting factory. This replaced a block-list of scattered per-sink `isKernelPattern` checks that failed open. The read totality is the served-entry-point enumeration in `security.test.ts`, the analogue of `policy.test.ts` for writes. Instance identity is configuration, not request data: `currentHost()` is authoritative on `WORKER_HOST` and IGNORES the inbound `Host`, so an attacker cannot poison a capability URL (`upload_url`/`page_url`/`og_image`) by sending a spoofed `Host` on an unauthenticated request (e.g. a `/ws` upgrade).
