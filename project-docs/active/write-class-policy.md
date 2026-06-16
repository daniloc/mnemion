# Write-Class Policy

## One question, asked once

Across a few weeks of security review, five distinct findings clustered on the same seam:

1. `set_sharing` was ungated — `_shared` was a directly-mutatable kernel pattern absent from the consent list, so an agent could publish a private entry with no confirmation.
2. The `patch` operation bypassed the consent gate and the kernel validation hooks — an agent could patch `_federation_hosts.host` from an approved host to an attacker host (token exfiltration), single or batch.
3. `_shared` wasn't excluded from batches — the same hole as (1), through the batch path.
4. Ingress and upload tokens could target kernel patterns — an `_inputs` endpoint pointed at `_shared` let a remote caller flip private entries public; an upload token targeting `_web_cache`/`_system_docs` poisoned trusted content.
5. The register-token owner-takeover — the token-mint path didn't honor the `owner`/roster reservations that `_members` itself enforces.

Each fix was correct. But they were five patches to **instances of one structural question**:

> *Which patterns can agents write, through which path, and what gate fires?*

The tell was the commit log: repeated "blind adversarial review found the prior fix incomplete." The matrix of (write-path × pattern × operation) was being explored by fuzzing, one cell at a time, because **it was never written down**.

## Why it kept recurring

The policy lived in three layers with no shared vocabulary, and the core predicate was re-derived eleven times:

- **`CONSENT_GATED`** (session layer) — a dict that only governed the MCP `mutate` path. Consent was a property of the tool wrapper, not the store.
- **`INTERNAL_WRITE_PROTECTED`** (data layer) — a denylist; the only rule all write paths inherited.
- **`ON_CREATE` hooks** (kernel layer) — each kernel pattern re-coded its own `startsWith("_")` target check.
- **`pattern.startsWith("_")`** — the "is this a kernel pattern" predicate, copied into `kernel.ts`, `data.ts`, `hive.ts`, `evolution.ts`, and `prime.ts` (11 sites).

The root cause was layering. There are **three write paths into the mutate engine**, and only one passed through the consent gate:

```
MCP mutate     → session.ts (CONSENT_GATED ✓) → executeMutate
HTTP ingress   → processInput ───────────────→ executeMutate   (no gate)
HTTP upload    → consumeUpload → raw UPDATE                     (no gate, no denylist)
```

That is exactly why finding (4) had to bolt the `_`-prefix rule onto ingress and upload by hand — they enter *below* the layer where the gate lives, so they couldn't inherit it. Every new write path, or new gated pattern, was a fresh chance to miss a cell.

In `data-is-destiny` terms: the eleven `startsWith("_")` checks weren't eleven copies of a predicate. They were **eleven components each re-deriving the same fact from an absent field.** "Kernel-ness" was inferred from a *naming convention* because the program had no model for the thing it actually cared about — *what class of write does this pattern admit?* When the truth isn't stored, every component invents its own derivation, and they drift.

## The invariant

> Every agent-reachable write resolves to `(pattern, operation, path)` and is admitted by exactly one policy. A pattern's write-class is declared once. Consent-gated and system-only patterns are reachable **only** through the interactive MCP path that can satisfy their gate; every other path is restricted to plain user patterns by the same policy — never by a re-coded `startsWith("_")`.

## The model

`src/policy.ts` is the single source of truth. One `WriteClass` per pattern; every gate is a pure derivation of it.

| WriteClass | Meaning | Agent-writable? | Consent? | Ingress/upload target? |
|---|---|---|---|---|
| `User` | A user pattern (any non-`_` name) | yes | no | **yes — the only valid target** |
| `Open` | Agent-writable kernel pattern | yes | no | no |
| `Consent` | Kernel pattern, MCP path only | via round-trip | yes | no |
| `System` | Caches / audit logs | **no** | n/a | no |

`KERNEL_WRITE_POLICY` is the table — one row per kernel pattern, consent semantics attached as data (not English sentences buried in a session dict). User patterns are **not** listed; their absence (a non-`_` name) is what makes them `User` class.

Derivations — every gate reads through these, none re-derives:

- `writeClass(p)` — `User` for non-`_` names; otherwise the registry entry, or **`System` (fail-closed)** for an unclassified kernel pattern.
- `isInternalWriteProtected(p)` — `writeClass === System`. (Replaces `INTERNAL_WRITE_PROTECTED`.)
- `isValidWriteTarget(p)` — `writeClass === User`. The sole ingress/upload target rule; every kernel class is refused.
- `consentPolicy(p)` / `patchRejected(p)` / `consentRoundTripRequired(p, op, data)` — drive the session round-trip. (Replace `CONSENT_GATED` / `consentRequired`.)

Consent conditions are data: `always` (every escalating write), `on_expose` (only when visibility goes non-private — `_documents`), `patch_only` (never round-tripped, but `patch` rejected — `_access_tokens`, whose real human gate is the out-of-band passkey approval at `/invite/{token}`).

### What falls out

1. **Fail-closed by construction.** A new `_` table added without a policy row resolves to `System` — denied through every path — instead of silently defaulting to agent-writable. `verifyWritePolicyTotality()` (beside `verifyFieldsIntegrity` in `schema.ts`) warns at boot if any kernel table lacks a row.
2. **Consent stops being a session-layer accident.** Whether a pattern is gated is a property read at the one place all paths converge; only the round-trip *mechanics* stay in the session, because only the MCP path can satisfy an interactive re-issue. HTTP paths inherit "unreachable" from the same field, not from a bolted-on `startsWith("_")`.
3. **The boundary is inspectable.** `mnemion://schema/{pattern}` surfaces `write_class`, **derived at read time** — deliberately *not* persisted to `_objects`. Unlike `doctrine`/`memory_policy` (agent-authored, mutable), write-class is a code constant; storing it would denormalize the SSOT and reintroduce drift. Derive, don't store.

### Two latent gaps closed in passing

- **The `_` namespace is now reserved.** `NAME_RE` permitted a leading `_` despite the error text claiming "start with a letter," and `create_pattern` had no guard — so a user pattern could have collided with the kernel namespace. `create_pattern` now refuses `_`-prefixed names, making `isKernelPattern(p) = p.startsWith("_")` exact and the registry total.
- **Batch `patch` on `_access_tokens`.** The old batch gate used `consentRequired`, which returned `false` for `_access_tokens`, so a batched `patch` reached the engine and skipped the kernel hooks. Routing through `patchRejected` blocks `patch` on every gated pattern, batch or single.

## The test that ends the cycle

`src/__tests__/policy.test.ts` enforces the matrix by **double-entry bookkeeping**: the test independently declares the expected class for every registry entry and asserts the keysets match, while `verifyWritePolicyTotality()` guarantees every kernel *table* is in the registry. A new kernel pattern cannot reach an unclassified, untested state — the suite fails until it's classified in both the registry and the expectation. Per-pattern derivation consistency, a fail-closed guard, and integration tests (engine denial, ingress/upload kernel rejection, reserved-namespace refusal) round it out.

The matrix is now exhaustive by construction, not by the next reviewer finding the next hole.

## Files

- `src/policy.ts` — the SSOT (`KERNEL_WRITE_POLICY` + derivations).
- `src/schema.ts` — `verifyWritePolicyTotality()` boot check.
- Consumers (read-through, no local predicate): `session.ts`, `data.ts`, `kernel.ts`, `hive.ts`, `evolution.ts`, `prime.ts`.
- `src/__tests__/policy.test.ts` — the admission matrix.
