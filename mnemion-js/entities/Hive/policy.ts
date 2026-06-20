// Write-class policy — the single source of truth for "which patterns can
// agents write, through which path, and what gate fires."
//
// This question was previously answered hole-by-hole: a `CONSENT_GATED` dict in
// the session layer, an `INTERNAL_WRITE_PROTECTED` set in the data layer, and
// eleven independent `startsWith("_")` checks scattered across kernel/data/hive/
// evolution/prime. Each was a separate map of the same territory, and a missed
// cell was a security hole (see the set_sharing, patch-bypass, ingress/upload,
// and register-token findings).
//
// Here the territory is modeled once. Every pattern has a WriteClass; every gate
// (consent round-trip, batch exclusion, ingress/upload eligibility, schema-
// evolution restriction, prime inclusion) is a pure derivation of it. A kernel
// pattern with no declared class fails CLOSED (System — denied) so a newly added
// kernel pattern can never silently default to agent-writable through every path.
//
// This module is a leaf: it imports nothing from the enforcement layers, so they
// can all derive from it without cycles.
//
// @why That question was previously answered hole-by-hole across three layers
// plus eleven scattered startsWith("_") checks, and every missed cell was a
// security hole (set_sharing ungated, the patch-bypass, ingress/upload
// targeting kernel patterns, register-token takeover). Unclassified kernel
// patterns fail CLOSED (System → denied) so a new kernel pattern can never
// silently default to agent-writable; the module is a dependency-free leaf so
// every enforcement layer derives from it without cycles; write-class is
// computed at read time, never persisted, to avoid denormalizing the constant.

// === Write classes ===

export enum WriteClass {
  /** Agent-writable user pattern. The only valid ingress/upload write target. */
  User = "user",
  /** Agent-writable kernel pattern; no consent. NOT an ingress/upload target. */
  Open = "kernel_open",
  /** Agent-writable kernel pattern via the interactive MCP path only — a human
   *  confirmation round-trip gates escalating writes. NOT an ingress/upload
   *  target (HTTP paths can't satisfy the round-trip, so they can't reach it). */
  Consent = "kernel_consent",
  /** Never agent-writable — system caches/audit logs written by internal code. */
  System = "system_only",
}

// When a Consent pattern's round-trip actually fires:
//  - always:     every escalating create/update/unarchive needs confirmation.
//  - on_expose:  only when the write exposes content over HTTP (visibility
//                non-private) — creating a private document is benign.
//  - patch_only: never round-tripped, but patch is still rejected (patch would
//                bypass the kernel validation hooks and could set system-managed
//                columns). Used for _access_tokens, whose real human gate is the
//                out-of-band passkey approval at /invite/{token}, not a re-issue.
type ConsentCondition = "always" | "on_expose" | "patch_only";

interface ConsentPolicy {
  condition: ConsentCondition;
  /** Shown to the agent on the first (unconfirmed) call. */
  message: string;
}

interface KernelPolicy {
  class: WriteClass;
  consent?: ConsentPolicy;
  // Behavioral flags that used to live as invisible, hand-maintained sets keyed
  // by pattern name (prime's KERNEL_INCLUDE, schema's AUDIT_EXEMPT) with no
  // totality check — a renamed pattern silently dropped out of recall / started
  // churning the audit log. Folded in here so each kernel pattern's behavior is
  // one row, covered by the same boot-time totality check as write class.
  primeInclude?: boolean; // surface this kernel pattern in prime recall (default: kernel patterns are excluded)
  auditExempt?: boolean;  // skip audit triggers (high-frequency append-only logs whose history is the data)
}

// === The registry ===
//
// One row per kernel pattern. User patterns are NOT listed — their absence (any
// non-`_` name) is what makes them User class. The `_` namespace is reserved for
// the kernel (create_pattern refuses `_`-prefixed names), so every `_` pattern is
// enumerated here and the boot-time totality check asserts it against KERNEL_TABLES.

export const KERNEL_WRITE_POLICY: Record<string, KernelPolicy> = {
  // --- Consent-gated: agent-writable via MCP only, human round-trip ---
  _members: {
    class: WriteClass.Consent,
    consent: {
      condition: "always",
      message:
        "Adding a member grants another person standing access to this shared hive — everything in it becomes readable and writable by them. Only proceed if the human explicitly chose to share this hive with this person. Call mutate again with the same arguments to proceed.",
    },
  },
  _federation_hosts: {
    class: WriteClass.Consent,
    consent: {
      condition: "always",
      message:
        "Adding a federation host is a standing grant: resolve() will send this hive's access tokens to that host whenever it fetches a mnemion:// URI there. Only proceed if the human explicitly approved federating with this host. Call mutate again with the same arguments to proceed.",
    },
  },
  _shared: {
    class: WriteClass.Consent,
    consent: {
      condition: "always",
      message:
        "Sharing an entry publishes it over HTTP at /o/entry/{pattern}/{id} (public = readable by anyone and edge-cached; unlisted = readable by anyone with an access token). Only proceed if the human approved publishing this entry. Call mutate again with the same arguments to proceed.",
    },
  },
  _publications: {
    class: WriteClass.Consent,
    consent: {
      condition: "always",
      message:
        "A publication serves LIVE query results over HTTP at /p/{path} — every current and future entry the query matches (public = readable by anyone and edge-cached; unlisted = readable by anyone with an access token). Only proceed if the human explicitly approved publishing this data. Call mutate again with the same arguments to proceed.",
    },
  },
  _system_docs: {
    class: WriteClass.Consent,
    consent: {
      condition: "always",
      message:
        "System docs affect all future agent sessions. Confirm this edit will make future runs more effective. Call mutate again with the same arguments to proceed.",
    },
  },
  _documents: {
    class: WriteClass.Consent,
    consent: {
      condition: "on_expose",
      message:
        "Making this document non-private serves its file over HTTP at /f/{id} (public = readable by anyone and edge-cached; unlisted = readable by anyone with an access token). Only proceed if the human approved publishing this file. Call mutate again with the same arguments to proceed.",
    },
    primeInclude: true, // document contents are searchable + recallable
  },
  _access_tokens: {
    class: WriteClass.Consent,
    consent: {
      // Token creation is never round-tripped: ordinary tokens are benign, and
      // register/invite tokens are minted inert and gated by an out-of-band
      // passkey approval at /invite/{token} (a stronger, human-present gate an
      // injected agent can't satisfy). patch is still rejected so it can't set
      // the system-managed approved_at/consumed_at columns.
      condition: "patch_only",
      message:
        "This token cannot be modified with patch.",
    },
  },

  // --- Open: agent-writable kernel patterns, no consent ---
  _outputs: { class: WriteClass.Open },
  _inputs: { class: WriteClass.Open },
  _links: { class: WriteClass.Open },
  _charter: { class: WriteClass.Open },
  _system_tasks: { class: WriteClass.Open },
  _short_term_fragments: { class: WriteClass.Open, primeInclude: true }, // working memory surfaces in recall
  _maintenance_passes: { class: WriteClass.Open },
  _canvases: { class: WriteClass.Open },
  _views: { class: WriteClass.Open }, // agent-authored UI view specs; owner-facing, not exposed externally
  _pages: {
    // Private page edits flow freely (iterate with the agent); publishing one
    // (visibility public) is consent-gated — it serves hive data over HTTP.
    class: WriteClass.Consent,
    consent: {
      condition: "on_expose",
      message:
        "Making this page public serves it over HTTP at /page/{path} — anyone with the link can read it, including the data its blocks pull from the hive. Only proceed if the human approved publishing this page. Call mutate again with the same arguments to proceed.",
    },
  },
  // Promotion from _short_term_fragments is the intended writer, but direct
  // agent writes have never been denied — kept Open to preserve that behavior.
  _long_term_fragments: { class: WriteClass.Open, primeInclude: true }, // consolidated memory surfaces in recall

  // --- System-only: never agent-writable (caches + audit logs) ---
  // Planting a _web_cache row would make resolve() serve attacker-chosen content
  // as a trusted cache hit; the logs are append-only point-in-time records.
  _web_cache: { class: WriteClass.System },
  _fragment_access_log: { class: WriteClass.System, auditExempt: true },
  _entry_access_log: { class: WriteClass.System, auditExempt: true },
  // Not registered in _objects (never reach the mutate path), but listed for
  // parity with the former INTERNAL_WRITE_PROTECTED denylist and as documentation.
  _mutation_log: { class: WriteClass.System },
  _schema_history: { class: WriteClass.System },
  _pending_changes: { class: WriteClass.System },
};

// === Derivations — every gate reads through these, never re-derives ===

/** The `_` namespace is reserved for the kernel (create_pattern refuses it), so
 *  a leading underscore is the exact, single definition of "kernel pattern." */
export function isKernelPattern(pattern: string): boolean {
  return pattern.startsWith("_");
}

/** The write class of any pattern. Unclassified kernel patterns fail CLOSED
 *  (System) — a new `_` table added without a policy row is denied, not opened. */
export function writeClass(pattern: string): WriteClass {
  if (!isKernelPattern(pattern)) return WriteClass.User;
  return KERNEL_WRITE_POLICY[pattern]?.class ?? WriteClass.System;
}

/** True for patterns the system manages itself — denied at the mutate engine. */
export function isInternalWriteProtected(pattern: string): boolean {
  return writeClass(pattern) === WriteClass.System;
}

/** True only for User-class patterns: the sole valid ingress/upload write target.
 *  Every kernel pattern — gated, open, or system — is refused, because HTTP write
 *  paths bypass the MCP consent layer and must never reach the kernel surface. */
export function isValidWriteTarget(pattern: string): boolean {
  return writeClass(pattern) === WriteClass.User;
}

/** Consent configuration for a pattern, or null if it carries none. */
export function consentPolicy(pattern: string): ConsentPolicy | null {
  return KERNEL_WRITE_POLICY[pattern]?.consent ?? null;
}

/** True if this kernel pattern is surfaced in prime recall (most are excluded). */
export function primeIncluded(pattern: string): boolean {
  return KERNEL_WRITE_POLICY[pattern]?.primeInclude === true;
}

/** True if this pattern is exempt from audit triggers (append-only logs). */
export function isAuditExempt(pattern: string): boolean {
  return KERNEL_WRITE_POLICY[pattern]?.auditExempt === true;
}

// === Egress sensitivity: the read/serialization dual of KERNEL_WRITE_POLICY ===
//
// "Sensitive" is a property of DATA (a column), but it used to be enforced per
// EGRESS path (mutate response, /ws delta, audit trigger, query, export, served
// reads) — so a new egress kept reintroducing the leak. This is the one
// declarative home: which columns must never leave the DO in the clear.
//   - `secret`: born-hashed. The preimage is generated in app code and returned
//     ONCE at mint; only its digest is ever stored — so the audit trigger, the
//     broadcast, and any read see a hash, not a usable bearer. Also stripped by
//     `seal` from every serialized row (belt-and-suspenders).
//   - `redact`: never serialized off the DO at all (stripped by `seal`); the
//     data plane has no legitimate need for it.
// Broadcast, audit, export, and served reads all derive from this, so adding a
// new secret column protects every egress at once — and `findUnclassifiedSensitiveColumns`
// fails loud if a secret-shaped column has no policy (the egress totality check).
export type SensitivityKind = "secret" | "redact";
export interface SensitiveColumn { column: string; kind: SensitivityKind }

export const SENSITIVE_COLUMNS: Record<string, SensitiveColumn[]> = {
  _access_tokens: [{ column: "token", kind: "secret" }],
  _passkeys: [{ column: "public_key", kind: "redact" }, { column: "credential_id", kind: "redact" }],
};

export function sensitiveColumns(pattern: string): SensitiveColumn[] {
  return SENSITIVE_COLUMNS[pattern] ?? [];
}

/** The single `secret` (born-hashed) column for a pattern, or null. */
export function secretColumn(pattern: string): string | null {
  return SENSITIVE_COLUMNS[pattern]?.find((c) => c.kind === "secret")?.column ?? null;
}

/** Strip sensitive columns from a row about to leave the DO — the one sieve every
 *  egress routes through (broadcast, export, served read, mutate response). Shallow
 *  copy; null/undefined passes through. */
export function seal<T extends Record<string, unknown> | null | undefined>(pattern: string, row: T): T {
  if (!row) return row;
  const cols = SENSITIVE_COLUMNS[pattern];
  if (!cols?.length) return row;
  const out: Record<string, unknown> = { ...row };
  for (const c of cols) delete out[c.column];
  return out as T;
}

// A column whose NAME looks like a credential on any KERNEL table must be
// classified above, or it's an egress gap. The analogue of verifyWritePolicyTotality.
const SECRET_NAME_RE = /^(token|secret|password|private_key|public_key|credential|credential_id|api_key)$/i;
export function findUnclassifiedSensitiveColumns(tableColumns: Record<string, string[]>): string[] {
  const gaps: string[] = [];
  for (const [table, cols] of Object.entries(tableColumns)) {
    if (!isKernelPattern(table)) continue;
    const classified = new Set((SENSITIVE_COLUMNS[table] ?? []).map((c) => c.column));
    for (const col of cols) if (SECRET_NAME_RE.test(col) && !classified.has(col)) gaps.push(`${table}.${col}`);
  }
  return gaps;
}

/** True if patch must be rejected for this pattern (any consent-gated pattern —
 *  patch skips the kernel validation hooks and the confirmation round-trip). */
export function patchRejected(pattern: string): boolean {
  return consentPolicy(pattern) != null;
}

/** Whether an escalating create/update/unarchive needs the confirmation
 *  round-trip, given the data being written (for on_expose visibility checks).
 *  patch_only patterns never round-trip; patch is handled by patchRejected. */
export function consentRoundTripRequired(
  pattern: string,
  operation: string | undefined,
  data: { visibility?: unknown } | null | undefined,
): boolean {
  const policy = consentPolicy(pattern);
  if (!policy) return false;
  if (policy.condition === "patch_only") return false;
  if (operation !== "create" && operation !== "update" && operation !== "unarchive") return false;
  if (policy.condition === "on_expose") {
    // unarchive restores the entry's stored visibility, which isn't in the
    // supplied data ({id} only) — we can't tell if it re-exposes the file, so
    // require the round-trip rather than assume private. create/update carry the
    // authoritative visibility, so gate on it.
    if (operation === "unarchive") return true;
    const vis = data?.visibility;
    return vis === "public" || vis === "unlisted";
  }
  return true; // always
}
