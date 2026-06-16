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
  _short_term_fragments: { class: WriteClass.Open },
  _maintenance_passes: { class: WriteClass.Open },
  _canvases: { class: WriteClass.Open },
  // Promotion from _short_term_fragments is the intended writer, but direct
  // agent writes have never been denied — kept Open to preserve that behavior.
  _long_term_fragments: { class: WriteClass.Open },

  // --- System-only: never agent-writable (caches + audit logs) ---
  // Planting a _web_cache row would make resolve() serve attacker-chosen content
  // as a trusted cache hit; the logs are append-only point-in-time records.
  _web_cache: { class: WriteClass.System },
  _fragment_access_log: { class: WriteClass.System },
  _entry_access_log: { class: WriteClass.System },
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
    const vis = data?.visibility;
    return vis === "public" || vis === "unlisted";
  }
  return true; // always
}
