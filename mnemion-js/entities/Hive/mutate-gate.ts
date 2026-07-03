// Mutate-gate decisions — the pure, transport-agnostic predicates that decide
// what gate a write must clear, factored out of the MCP `mutate` handler so the
// decision can't drift from the place it's enforced.
//
// @why The agent-facing WRITE surface exists on two transports: the MCP `mutate`
// tool (entities/Session/session.ts) and the browser-authenticated `/api/mutate`
// (shared/Routing/routes/pages.ts). The *gate decisions* — "is this op consent-
// gated and which way," "may this op ride inside a batch," "is this loosely-typed
// data actually an object" — were inline imperative branches in session.ts. That
// is the real drift vector the memory warns about ("/api+RPC tests pass while MCP
// breaks via the Zod/consent layer"): a future edit to the batch rule or the
// consent condition touches only session.ts, with no tested home to anchor it.
//
// These functions are PURE derivations of policy.ts (the write-class SSOT) — no
// I/O, no round-trip mechanics. The interactive consent round-trip itself
// (checkAndArmConsent + re-issue) stays in session.ts because only the MCP path
// can satisfy it; this module decides WHETHER it fires, not how. /api stays
// owner-implicit (a logged-in human IS the consent) and does not consult these
// decisions today — it receives parsed, single-op JSON and is intentionally
// ungated. The win is not that both transports call this, but that the gate
// decisions now have ONE tested home (a pure leaf over policy.ts) instead of
// inline branches: an edit to the batch rule or consent condition is anchored by
// a unit test, so an MCP-only regression can't slip past /api-based tests. If /api
// ever needs the same validation, it adopts these — without a second copy existing.

import { consentPolicy, patchRejected, consentRoundTripRequired, type ConsentPolicy } from "./policy";

// === Loosely-typed input normalization ===
//
// Some MCP hosts (Claude.ai) stringify object/array tool arguments. Both single
// `data` and batch arrays can arrive as JSON strings. Parse once, here, so every
// transport that accepts loosely-typed input agrees on the shape before any gate
// runs. (/api receives already-parsed JSON, so for it this is a pass-through.)

/** Parse a possibly-JSON-stringified value; non-strings and unparseable strings
 *  pass through unchanged (the caller's shape check then rejects bad input). */
export function normalizeMutateData(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try { return JSON.parse(data); } catch { return data; }
}

/** True when `data` is a usable single-op payload (a plain object, not an array).
 *  The shape both transports require before handing data to the engine. */
export function isSingleOpData(data: unknown): data is Record<string, unknown> {
  return !!data && typeof data === "object" && !Array.isArray(data);
}

// === Single-op gate decision ===

export type MutateGate =
  /** patch on a consent-gated pattern — refused outright (it would bypass the
   *  kernel validation hooks AND the confirmation round-trip). */
  | { kind: "patch_rejected"; pattern: string }
  /** an escalating write on a consent pattern — needs the interactive round-trip
   *  before it may commit. `policy.message` is shown on the first (unconfirmed) call. */
  | { kind: "round_trip"; pattern: string; operation: string; policy: ConsentPolicy }
  /** no gate — proceed straight to the engine. */
  | { kind: "pass" };

/** Decide which gate a single mutate op must clear, purely from policy.ts. The
 *  MCP handler drives the round-trip mechanics off this; the engine independently
 *  enforces write-class, so this is the consent layer's single decision point. */
export function mutateGate(
  pattern: string,
  operation: string,
  data: { visibility?: unknown } | null | undefined,
): MutateGate {
  const policy = consentPolicy(pattern);
  if (!policy) return { kind: "pass" };
  if (operation === "patch") return { kind: "patch_rejected", pattern };
  if (consentRoundTripRequired(pattern, operation, data)) {
    return { kind: "round_trip", pattern, operation, policy };
  }
  return { kind: "pass" };
}

// === Round-trip key ===

/** Stable JSON serializer: keys sorted at every nesting level so the SAME logical
 *  value yields the SAME string regardless of property insertion order. The
 *  consent key depends on this — without it, an agent re-issuing the identical
 *  call with `{path, visibility}` vs `{visibility, path}` would arm a fresh
 *  round-trip instead of confirming the prior. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

/** The key used to arm/confirm a consent round-trip in `_pending_consent`. The
 *  request data is folded in so consent is bound to the SPECIFIC call shape, not
 *  to `(pattern, operation)` alone — re-issuing with different data must start
 *  a fresh round-trip rather than confirm the prior. (Without the data fold an
 *  agent could arm with benign data and re-issue with harmful data on the same
 *  pattern/op to satisfy the gate.) Data is serialized with sorted keys so
 *  semantically-identical re-issues confirm regardless of property order. Lives
 *  here because the data-binding is the correctness property of the gate; the
 *  round-trip MECHANICS stay in session.ts. */
export function consentKey(pattern: string, operation: string, data: Record<string, unknown>): string {
  return `consent:${pattern}:${operation}:${stableStringify(data)}`;
}

// === Batch eligibility ===

export interface BatchOp { pattern?: string; operation?: string; data?: { visibility?: unknown } }

/** The first op in a batch that may NOT ride inside it, or null if all are
 *  eligible. Consent-gated escalations and patches on gated patterns must go
 *  through a single mutate (a batch would skip the round-trip / kernel hooks);
 *  archive (de-escalation) is allowed. Pure derivation of policy.ts — the batch
 *  rule has one home, not an inline `.find` in the handler. */
export function findGatedBatchOp(batch: BatchOp[]): BatchOp | null {
  return batch.find((op) =>
    !!op && (
      (op.operation === "patch" && patchRejected(op.pattern ?? "")) ||
      consentRoundTripRequired(op.pattern ?? "", op.operation, op.data)
    )) ?? null;
}
