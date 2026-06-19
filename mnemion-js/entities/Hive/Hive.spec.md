# Hive

The single per-user Durable Object that owns all SQLite data and funnels every agent write through one kernel-enforced chokepoint.

## works when
- hive.ts exists at this node
- hive.ts imports cloudflare:workers
- hive.ts imports ./data
- policy.ts exists at this node
- data.ts exists at this node
- prime.ts imports ./policy

## why

HiveDO is the single Durable Object that owns the SQLite store; every write funnels through its `mutate`/`batchMutate`/`processInput`/`consumeUpload` chokepoints precisely so the kernel-write boundary is enforced in one place instead of re-derived per call site. `policy.ts` is the dependency-free leaf source of truth for "which patterns agents can write, through which path, what gate fires" — unclassified kernel patterns fail CLOSED (System → denied) so a new pattern can never silently become agent-writable, and kernel/prime/ingress gates all derive from it so the boundary cannot drift between layers.

Reads have the mirror boundary. SERVED/untrusted reads (public page chart/metric, OG card, publication source, `/o/entry`) go through `servedDataCtx`/`servedQuery`, where the `data.ts` engine refuses any kernel pattern (`ctx.served`) — so a serve sink physically cannot read `_access_tokens`/`_members`/etc., and a NEW serve path inherits the boundary by using the served context instead of re-deriving an `isKernelPattern` check the next sink would forget. This is the read analogue of `executeUntrustedWrite`; it exists because the scattered per-sink guards it replaced were a block-list that failed open. Instance identity is configuration, not request data: `currentHost()` is authoritative on `WORKER_HOST` and IGNORES the inbound `Host`, so an attacker cannot poison a capability URL (`upload_url`/`page_url`/`og_image`) by sending a spoofed `Host` on an unauthenticated request (e.g. a `/ws` upgrade).
