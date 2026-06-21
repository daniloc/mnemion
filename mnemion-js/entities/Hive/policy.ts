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
// can all derive from it without cycles. The ONE import it does carry — the
// feature-security barrel (entities/features/security.ts) — is itself pure DATA +
// TYPES (each feature's */security.ts imports only `import type` from here), so the
// leaf property holds: no enforcement-layer code, no runtime cycle. (It deliberately
// does NOT import a feature manifest.ts; those carry code.)
//
// @why That question was previously answered hole-by-hole across three layers
// plus eleven scattered startsWith("_") checks, and every missed cell was a
// security hole (set_sharing ungated, the patch-bypass, ingress/upload
// targeting kernel patterns, register-token takeover). Unclassified kernel
// patterns fail CLOSED (System → denied) so a new kernel pattern can never
// silently default to agent-writable; the module is a dependency-free leaf so
// every enforcement layer derives from it without cycles; write-class is
// computed at read time, never persisted, to avoid denormalizing the constant.

import { FEATURE_WRITE_POLICY, FEATURE_SENSITIVE_COLUMNS, FEATURE_DECLARED_SENSITIVE } from "../features/security";

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
//  - always:         every escalating create/update/unarchive needs confirmation.
//  - on_expose:      only when the write exposes content over HTTP (visibility
//                    non-private) — creating a private document is benign.
//  - on_broad_token: only when minting a BROAD/portable token — full `*` access or a
//                    whole-class read/write key (the kind an injected agent could mint
//                    and EXFILTRATE as a standing credential). Narrow target-bound
//                    (upload/document) and inert-until-approval (register) scopes are
//                    benign and skip the round-trip. Predicate: isBroadTokenScope.
//  - patch_only:     never round-tripped, but patch is still rejected. FORBIDDEN for a
//                    credential-minting pattern (one with a `secret` column): create —
//                    not patch — is the dangerous op there. findUngatedCredentialMints
//                    enforces that as a totality oracle.
type ConsentCondition = "always" | "on_expose" | "on_broad_token" | "patch_only";

export interface ConsentPolicy {
  condition: ConsentCondition;
  /** Shown to the agent on the first (unconfirmed) call. */
  message: string;
}

export interface KernelPolicy {
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
// enumerated — across this CORE map and the per-feature contributions composed in
// below — and the boot-time totality check asserts the COMPOSED map against
// KERNEL_TABLES.
//
// CORE_KERNEL_WRITE_POLICY holds the infra/core patterns. A FEATURE owns its own
// pattern's write class in its dir (entities/features/<name>/security.ts), composed
// back into the EXPORTED effective KERNEL_WRITE_POLICY below. policy.ts stays a
// dependency-free leaf because it imports only the pure-data feature-security barrel
// (which imports only data + types), never a feature manifest (which carries code).

const CORE_KERNEL_WRITE_POLICY: Record<string, KernelPolicy> = {
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
  // _documents → owned by the documents feature
  //   (entities/features/documents/security.ts), composed in below.
  _access_tokens: {
    class: WriteClass.Consent,
    consent: {
      // Minting a BROAD token (full `*` access, or a whole-class read/write key)
      // hands out a portable bearer credential — an injected agent could mint one
      // and exfiltrate it for standing remote access (a `*` token even redeems as
      // an owner login). So a broad mint round-trips, like every other standing
      // grant (_members/_federation_hosts/_shared). Narrow target-bound (upload/
      // document, constraints frozen, single-use) and inert (register, gated by the
      // /invite passkey approval) scopes stay benign — those are the frequent legit
      // flows. patch is still rejected (Consent class) so it can't set the
      // system-managed approved_at/consumed_at columns.
      condition: "on_broad_token",
      message:
        "Minting this token grants portable, standing access to the hive (a `*` token is a full owner credential; a bare `read`/`write` token reads or writes a whole class). Only proceed if the human asked to create this credential. Call mutate again with the same arguments to proceed.",
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
  // _pages → owned by the pages feature
  //   (entities/features/pages/security.ts), composed in below.
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

// The EFFECTIVE registry every derivation reads: CORE infra rows + each feature's
// own write class, composed from the pure-data feature-security barrel. A feature
// pattern with no row here still fails CLOSED (writeClass → System/denied), and the
// boot-time totality check (verifyWritePolicyTotality) asserts THIS composed map
// covers every KERNEL_TABLES pattern — so a feature that forgets its policy is
// denied AND flagged, never silently agent-writable. A feature that shadows a CORE
// pattern is a bug: `mergeDisjoint` throws at module load (the barrel already throws
// on feature↔feature collisions), so a feature can never silently override the write
// class of an infra pattern like _members — fail LOUD, not via the admission test.
function mergeDisjoint<T>(core: Record<string, T>, feature: Record<string, T>, what: string): Record<string, T> {
  for (const k of Object.keys(feature))
    if (k in core) throw new Error(`feature ${what} collision: "${k}" is a CORE kernel pattern and cannot be redeclared by a feature`);
  return { ...core, ...feature };
}

export const KERNEL_WRITE_POLICY: Record<string, KernelPolicy> =
  mergeDisjoint(CORE_KERNEL_WRITE_POLICY, FEATURE_WRITE_POLICY, "write-policy");

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
// new secret column protects every egress at once. Two oracles fail loud on a gap:
// `verifyEgressTotality` (the DECLARED-domain totality — every column a feature
// declares survives into the composed registry) and `findUnclassifiedSensitiveColumns`
// (the complementary name heuristic — a secret-NAMED column with no policy at all).
export type SensitivityKind = "secret" | "redact";
export interface SensitiveColumn { column: string; kind: SensitivityKind }

const CORE_SENSITIVE_COLUMNS: Record<string, SensitiveColumn[]> = {
  _access_tokens: [{ column: "token", kind: "secret" }],
  _passkeys: [{ column: "public_key", kind: "redact" }, { column: "credential_id", kind: "redact" }],
  // _documents.r2_key → owned by the documents feature
  //   (entities/features/documents/security.ts), composed in below.
};

// The EFFECTIVE sensitivity registry: CORE columns + each feature's own. Every
// egress (seal/sealAll, the audit trigger, export) and the egress totality oracle
// (findUnclassifiedSensitiveColumns) read THIS composed map, so a feature's
// redacted/secret columns inherit every egress + the loud-fail oracle unchanged.
export const SENSITIVE_COLUMNS: Record<string, SensitiveColumn[]> =
  mergeDisjoint(CORE_SENSITIVE_COLUMNS, FEATURE_SENSITIVE_COLUMNS, "sensitive-columns");

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

/** seal a list of rows — the sanctioned form for any served path emitting many
 *  rows, so no caller hand-rolls `.map(seal)` and forgets the pattern arg. */
export function sealAll(pattern: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => seal(pattern, r));
}

// A column whose NAME looks like a credential on any KERNEL table must be
// classified above, or it's an egress gap. This is a NAME HEURISTIC, NOT a totality
// oracle: it only catches columns whose name MATCHES SECRET_NAME_RE (the
// conventional credential shapes, incl. any `*_key` / `*_secret` suffix). It cannot
// see a sensitive column with an innocuous name (e.g. documents' `r2_key` only
// matches because of the `_key` suffix; a column named `handle` would slip past), so
// a reviewer still classifies the unobvious. The DECLARED-domain totality — every
// column a feature actually declared survives into the composed registry — is
// verifyEgressTotality below; this heuristic is the complementary "did you forget to
// classify a secret-NAMED column at all" check.
const SECRET_NAME_RE = /^(token|secret|password|credential|credential_id|recovery_code|totp_secret|[a-z0-9]*_(key|secret))$/i;
export function findUnclassifiedSensitiveColumns(tableColumns: Record<string, string[]>): string[] {
  const gaps: string[] = [];
  for (const [table, cols] of Object.entries(tableColumns)) {
    if (!isKernelPattern(table)) continue;
    const classified = new Set((SENSITIVE_COLUMNS[table] ?? []).map((c) => c.column));
    for (const col of cols) if (SECRET_NAME_RE.test(col) && !classified.has(col)) gaps.push(`${table}.${col}`);
  }
  return gaps;
}

// EGRESS TOTALITY over the DECLARED domain — the read/serialization dual of
// verifyWritePolicyTotality. Where the write check walks the live KERNEL_TABLES,
// this walks the live FEATURE_SECURITY registry (via FEATURE_DECLARED_SENSITIVE):
// every sensitive column ANY feature declares MUST survive into the composed,
// effective SENSITIVE_COLUMNS. This catches the exact bug the old two-hand-list
// barrel allowed — a feature's `sensitiveColumns` silently dropped from the
// composition (so it inherited no `seal`/audit/export redaction) while its write
// policy still wired. A gap here means a declared redact/secret column would leak.
// Code-vs-code (FEATURE_SECURITY vs the composed SENSITIVE_COLUMNS) — no DB needed.
export function verifyEgressTotality(): string[] {
  const gaps: string[] = [];
  for (const { pattern, column } of FEATURE_DECLARED_SENSITIVE) {
    const present = (SENSITIVE_COLUMNS[pattern] ?? []).some((c) => c.column === column);
    if (!present) gaps.push(`${pattern}.${column} declared sensitive by a feature but absent from the composed SENSITIVE_COLUMNS (egress unprotected)`);
  }
  if (gaps.length > 0) {
    console.warn(`[mnemion] egress-sensitivity gaps detected (${gaps.length}):\n  ${gaps.join("\n  ")}`);
  }
  return gaps;
}

// CREDENTIAL-MINT GATING TOTALITY — the consent dual of egress totality, derived
// from SENSITIVE_COLUMNS × KERNEL_WRITE_POLICY (no new declaration). A pattern with
// a `secret` column mints a born-hashed BEARER on every create — i.e. creating a
// row hands out a portable, exfiltratable credential. So its create MUST be gated:
// either System (never agent-writable) or Consent with a create-gating condition.
// The `patch_only` condition is PROVABLY WRONG for a credential-minter — it declares
// create benign while create is the dangerous op — and an Open class is worse (an
// injected agent mints freely). This is the exact bug that shipped `_access_tokens`
// as patch_only: an agent could mint + exfiltrate a broad/`*` bearer with no human
// round-trip. Fail-closed: a secret-minting pattern whose create isn't gated fails
// the build, so the misclassification is unexpressible.
export function findUngatedCredentialMints(): string[] {
  const gaps: string[] = [];
  for (const [pattern, cols] of Object.entries(SENSITIVE_COLUMNS)) {
    if (!cols.some((c) => c.kind === "secret")) continue; // mints a bearer iff a secret column
    const policy = KERNEL_WRITE_POLICY[pattern];
    const createGated =
      policy?.class === WriteClass.System ||
      (policy?.class === WriteClass.Consent && policy.consent?.condition !== "patch_only");
    if (!createGated)
      gaps.push(`${pattern} mints a secret (a portable credential) but its create is not consent-gated (class=${policy?.class ?? "User"}, condition=${policy?.consent?.condition ?? "none"}) — set Consent with a create-gating condition (always/on_broad_token), or System`);
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
  data: { visibility?: unknown; scope?: unknown } | null | undefined,
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
  if (policy.condition === "on_broad_token") {
    // unarchive carries no scope ({id} only) — can't tell, so gate (fail-closed).
    if (operation === "unarchive") return true;
    // absent/non-string scope defaults to "*" (the broadest) → round-trip.
    return isBroadTokenScope(typeof data?.scope === "string" ? data.scope : "*");
  }
  return true; // always
}

/** A token scope is BROAD if minting it hands out a portable credential that grants
 *  a whole CLASS of resources (via the scopeMatches prefix rule) or full access —
 *  the kind an injected agent could mint and exfiltrate. Narrow target-bound and
 *  inert-until-approval scopes are benign (the frequent legit flows). Unknown shapes
 *  fail CLOSED (broad). Used by the on_broad_token consent condition. */
export function isBroadTokenScope(scope: string): boolean {
  // benign: single-use & target-bound (constraints frozen IMMUTABLE_AFTER_CREATE)
  if (/^(upload|document)(:|$)/.test(scope)) return false;
  // benign: minted inert, gated by the /invite passkey approval
  if (scope === "register") return false;

  // A read/write scope is NARROW only when it names a single LEAF resource —
  // because scopeMatches grants a token EVERY required scope that prefixes from
  // it at a `:` boundary, so a scope that stops ABOVE a leaf is a portable master
  // key to the whole subtree beneath it. The served resource grammar (the
  // required-scope strings in shared/Routing/routes/io.ts) is:
  //
  //   read:entry:<pattern>:<id>   (4)  one shared entry           → LEAF / narrow
  //   read:output:<path>          (3)  one output                 → LEAF / narrow
  //   read:publication:<path>     (3)  one publication            → LEAF / narrow
  //   read:document:<id>          (3)  one document               → LEAF / narrow
  //   write:input:<path>          (3)  one ingress endpoint       → LEAF / narrow
  //
  //   read:entry:<pattern>        (3)  EVERY id in a pattern       → CLASS / broad
  //   read:entry                  (2)  every entry everywhere      → CLASS / broad
  //   read, write                 (1)  the whole class            → CLASS / broad
  //   *                                everything                  → broad
  //
  // The naive `parts.length >= 3` cutoff treated `read:entry:<pattern>` (a
  // pattern-WIDE class key, 3 parts) as a single-resource grant — minting it
  // skipped the round-trip yet handed out a master key to every entry in the
  // pattern. So classification is by RESOURCE KIND, not raw length: `entry`
  // addresses a leaf with TWO trailing segments (pattern + id), everything else
  // with ONE. We require the scope to reach the leaf depth for its kind.
  const parts = scope.split(":");
  const [root, kind] = parts;
  if (root === "read" || root === "write") {
    // Leaf depth = root + kind + the kind's address segments. `entry` needs a
    // pattern AND an id (4); output/publication/document/input name one leaf (3).
    // A future read:<kind>:<class> whose 3rd segment is itself a CLASS (like
    // entry's pattern) rather than a leaf id belongs on this list, NOT the 3-part
    // default — otherwise it would be misclassified narrow, the exact bug here.
    const leafDepth = kind === "entry" ? 4 : 3;
    if (parts.length >= leafDepth) return false; // reaches a single leaf → narrow
  }
  return true; // *, bare read/write, read:entry, read:entry:<pattern>, marketplace, unknown → broad
}
