# @why proposals — Mnemion onboarding

Bootstrapped design rationale for the 8 files with the most symbols in
`.coherence/onboard-jobs.json` (excluding `__tests__` and `*fetch-mock*`).
Each proposal captures intent the git history reveals but the code alone does
not. Source files were NOT modified — these are proposals only.

Selection (by symbol count, descending): `src/hive.ts` (≈82), `src/kernel.ts`
(≈28), `src/credentials.ts` (15), `src/routes/auth.ts` (15), `src/prime.ts`
(14), `src/policy.ts` (11), `src/router.ts` (11), and an 8-symbol three-way tie
(`src/git.ts`, `src/extract.ts`, `src/routes/io.ts`) resolved in job-list order
to `src/git.ts`.

---

## src/hive.ts

**Proposed @why:**
> HiveDO is the single Durable Object that owns the SQLite store; every agent
> write funnels through its `mutate`/`batchMutate`/`processInput`/`consumeUpload`
> chokepoints precisely so the kernel-write boundary can be enforced in one place
> rather than re-derived per call site. The hardcoded `patternName === "_x"`
> lifecycle branches (R2 deletion, task dispatch, upload-token mint) are a
> consciously-retained imperative seam: lifting them into the policy registry was
> judged a larger refactor with no security payoff, and they fail loudly in tests
> on rename.

**Supporting commits:** `878d298` (rewires hive's upload-consume / conflict-check
/ prime-log to read through `policy.ts`), `b5bdf1b` (re-validates
`isValidWriteTarget` at the `processInput` write chokepoint; design-note callout
of the remaining `_x` branches as a deliberate seam).

**Confidence:** high

---

## src/kernel.ts

**Proposed @why:**
> Declarative pre-mutation hooks that validate/transform kernel-pattern data
> before the generic INSERT/UPDATE/ARCHIVE path runs, kept here so each kernel
> table's special behavior lives in one visible place. `IMMUTABLE` /
> `IMMUTABLE_AFTER_CREATE` and the register-scope `memberActive` guard exist as
> defense-in-depth against specific attacks: an agent self-approving an invite
> (`approved_at` immutable), tampering a token's target after mint, or escalating
> an invite into owner-takeover. "Which patterns the system writes" and "which
> are valid ingress/upload targets" are intentionally NOT defined here — they are
> derived from `policy.ts` so the boundary cannot drift between layers.

**Supporting commits:** `3ee1b19` (register-create hook rejects member "owner"
and requires an active roster member — owner-takeover fix), `15927e1`
(`approved_at` made immutable so an agent can't self-approve an invite),
`878d298` (kernel ingress/upload/publication targets rewired to derive from
`policy.ts`), `b5bdf1b` (`_inputs.target_pattern` immutable-after-create).

**Confidence:** high

---

## src/credentials.ts

**Proposed @why:**
> Auth primitives (passkeys + access/register/auth tokens) isolated as pure
> db-accessor functions so credential concerns stay separate from the cognitive
> substrate. The multi-row passkey model (one credential per member, NULL =
> bootstrap owner) exists because a single hive is shared by several people who
> each authenticate as themselves. `resolveRegisterToken` deliberately
> re-validates scope/owner/roster at setup/consume time — independent of how the
> token's fields were set — because an adversarial review showed mint-time checks
> alone could be bypassed by a post-create constraints update, turning an invite
> into an owner-takeover; a malformed (member-less) token must be unusable rather
> than defaulting to the owner sentinel.

**Supporting commits:** `ca2edcf` (Phase 1: multi-member identity, multi-passkey,
member-keyed tokens), `3ee1b19` (setup/consume-time re-validation closing the
owner-takeover, malformed-token hardening), `15927e1` (`approveRegisterToken`
stamps `approved_at`; tokens minted inert and gated on out-of-band passkey
approval).

**Confidence:** high

---

## src/routes/auth.ts

**Proposed @why:**
> The browser-facing auth surface (login/setup/invite/passkey + session
> revocation). The `/invite/{token}` flow requires an existing active member to
> approve by passkey out-of-band before the `/setup` link is revealed — this
> replaced an agent-satisfiable mutate round-trip specifically because an injected
> agent could otherwise mint an invite and exfiltrate the URL. The secret-only
> login page is a deliberate bootstrap fallback for when no passkey is yet
> registered.

**Supporting commits:** `15927e1` (passkey-approval gate for invites; agent
exfiltration motivation), `ca2edcf` (Phase 1 invite/setup flow, suspended/
archived members refused at auth), `77fbeda` (Phase 2 actor threading through
the session cookie).

**Confidence:** high

---

## src/prime.ts

**Proposed @why:**
> The auto-associative recall layer (partial cue → full constellation via
> embeddings + Vectorize nearest-neighbors + one-hop link follow). Which kernel
> patterns participate in recall is NOT a local hand-maintained set: `primeIncluded`
> derives from the `policy.ts` registry, because the former invisible
> `KERNEL_INCLUDE` set had no totality check and a renamed pattern would silently
> drop out of recall. `_documents` is included so uploaded document contents
> surface in recall once extracted.

**Supporting commits:** `b5bdf1b` (lifts `KERNEL_INCLUDE` into the registry as
`primeInclude`/`primeIncluded` with totality coverage; the renamed-pattern
silent-dropout motivation), `878d298` (prime recall filter rewired to derive
from `policy.ts`), `4fe8a6b` (`_documents` joins recall so extracted text is
recalled).

**Confidence:** high

---

## src/policy.ts

**Proposed @why:**
> The single source of truth for "which patterns can agents write, through which
> path, and what gate fires." It exists because that question was previously
> answered hole-by-hole across three layers plus eleven scattered `startsWith("_")`
> checks, and every missed cell was a security hole (set_sharing ungated, the
> patch-bypass, ingress/upload targeting kernel patterns, register-token
> takeover). Unclassified kernel patterns fail CLOSED (System → denied) so a newly
> added kernel pattern can never silently default to agent-writable; the module is
> a dependency-free leaf so every enforcement layer can derive from it without
> cycles, and write-class is computed at read time (never persisted) to avoid
> denormalizing the constant.

**Supporting commits:** `878d298` (introduces `KERNEL_WRITE_POLICY` and all
derivations; documents the five clustered findings and fail-closed design),
`b5bdf1b` (adds `primeInclude`/`auditExempt` behavioral flags to the registry
with totality enforcement).

**Confidence:** high

---

## src/router.ts

**Proposed @why:**
> The worker's HTTP routing + session machinery. The auth helpers here are
> security-load-bearing: `timingSafeEqual` is constant-time specifically to close
> a timing-attack finding on master-secret / setup-token / session-signature
> checks (replacing `===`), and session cookies carry a random sid plus a
> KV-stored epoch so `revokeAllSessions` can invalidate every session without
> rotating `MNEMION_SECRET`. The session cookie also encodes the actor
> backward-compatibly (legacy 4-part cookies still validate as owner) to avoid
> forcing a re-login on deploy.

**Supporting commits:** `f4be80c` (`timingSafeEqual` for all secret/token/
signature checks; XSS/open-redirect sanitization on the login return target),
`335af34` (M5 sid+epoch session revocation via `POST /sessions/revoke` without
rotating the secret), `77fbeda` (backward-compatible actor encoding in the
session cookie).

**Confidence:** high

---

## src/git.ts

**Proposed @why:** _history mechanical — no why._

The file's entire history is a single bulk commit (`a38bcd5` "Mnemion") with no
descriptive body and no subsequent changes touching it. There is no recoverable
design rationale, invariant, or security decision in the history beyond initial
authorship; any "why" would be inferred from the code itself, which is out of
scope for this history-driven pass.

**Confidence:** n/a (no proposal)

> Note: `src/git.ts` won the 8-symbol tie by job-list order. If a history-bearing
> file is preferred for the 8th slot, the next ties `src/extract.ts` (commit
> `4fe8a6b`: inline text vs async PDF extraction off the response path because the
> route ctx has no `waitUntil` — the DO does; 100k cap to stay under the 1 MB
> entry limit) and `src/routes/io.ts` (`4491ade`: documents degrade gracefully to
> 503/404 when R2 is unbound, since R2 is off by default and a binding to a
> missing bucket fails deploy) both carry high-confidence rationale.
