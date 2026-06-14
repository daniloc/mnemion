# Shared Hive

## Two people, one memory

Mnemion today is built for one human and their agents. A hive is the whole store, keyed to a single owner. But the product premise — *persistent, evolving shared memory* — wants company. A couple planning a life, two founders running a company, a parent and an adult child holding family logistics: the natural unit of memory is often more than one person.

This document describes how to let **two (or N) people share a single hive**, with distinct identities, per-person revocation, and authorship attribution — without turning Mnemion into a multi-tenant SaaS it was never meant to be.

---

## The insight

The data side is already done.

HiveDO holds *all* of a user's data in one Durable Object, keyed by `idFromName("user:owner")`. Sharing a hive does **not** mean merging two stores or building tenancy. It means letting two distinct people authenticate into the *same* HiveDO.

The entire problem reduces to one conflation baked into the current code:

> `userId` currently means both **"which hive"** and **"who am I."** They are the same string — `"owner"` — in three places.

- `src/index.ts` — `resolveExternalToken()` returns `{ props: { userId: "owner" } }`
- `src/router.ts` — HTTP dispatch keys `idFromName("user:owner")`
- `src/routes/auth.ts` — `completeOAuth()` hardcodes `userId: "owner"` in props

Dual-login is, at its core, splitting **hive identity** (which store) from **actor identity** (which person):

```
today:    person ──► userId="owner" ──► hive "user:owner"
                        (identity IS the location)

target:   person A ──► actor="danilo"  ─┐
          person B ──► actor="partner" ─┴► hive "hive:<stable-id>"
                        (identity)          (location)
```

Keep the hive key stable and independent of who logs in. Let the actor vary. Everything else hangs off that.

---

## What this is, and what it is not

**It is:** one shared hive that several trusted people authenticate into, each as themselves, with attribution and individual revocation. Sovereign per deploy, exactly as today.

**It is not** multi-tenancy. We are not running N isolated hives on one Worker, not building org/role hierarchies, not adding billing seats. Mnemion's whole premise is a *shared* memory; HiveDO already centralizes the data. Building toward tenant isolation would fight the architecture and the product. The members of a shared hive trust each other — this is a household or a small team, not a public platform.

This boundary matters for every decision below. When in doubt, choose the option that serves "a few trusted people in one room" over the one that serves "strangers needing walls."

---

## The credential spectrum

There's a real spectrum here, worth naming so we build the right tier deliberately.

**Tier 0 — shared credential (already possible today).** The master secret is just a string; both people can use it. Access tokens are already pluralizable — `mutate _access_tokens create` twice, hand one to each person, both resolve to `user:owner`. This *is* dual-login in the thinnest sense. What you lose: no idea who did what, and revoking one person is impossible short of the global session epoch (which logs out everyone). This is the "you could already do this" baseline — not the feature.

**Tier 1 — distinct members of one hive (this document).** Each person has their own identity, all routing to the same hive, with per-person revocation and authorship attribution. This is what makes a shared hive *feel* like a shared space rather than a shared password.

We build Tier 1.

---

## Design

### 1. Separate hive identity from actor identity

The keystone. Introduce a stable hive key independent of who authenticates. Because Mnemion is single-hive-per-deploy, this is a constant — call it `HIVE_ID` (e.g. `"hive:primary"`), defined alongside the other product identity constants in `src/constants.ts`.

Three call sites change from `idFromName("user:owner")` to `idFromName(HIVE_ID)`:

- `src/index.ts` — `resolveExternalToken()`
- `src/router.ts` — HTTP route dispatch
- `src/routes/auth.ts` — (indirectly, via props)

And `props` grows a second field. Today:

```ts
props: { userId: "owner" }
```

Target:

```ts
props: { hiveId: HIVE_ID, actor: "<member-label>" }
```

`SessionDO.getHive()` (`src/session.ts`) reads `props.hiveId` to locate the store; the mutate path reads `props.actor` to attribute writes. The two concerns never touch the same field again.

> **Migration note.** The existing single-owner hive lives at `idFromName("user:owner")`. Switching the constant to `"hive:primary"` would point every deploy at a *fresh, empty* Durable Object. The constant must therefore be `"user:owner"` for existing deploys, OR we do a one-time data migration. Simplest: keep `HIVE_ID = "user:owner"` as the literal value — the *name* changes (it's now "the hive," not "the owner"), the *string* does not. This is a rename for clarity, not a re-key. New deploys and existing deploys both land on the same DO.

### 2. Members: the roster

Add a `_members` kernel pattern — the source of truth for who belongs to this hive. It fits the existing kernel-pattern machinery in `src/schema.ts` and `src/kernel.ts`.

```
_members
├── id              (kernel)
├── label           (text, required)   — stable handle, e.g. "danilo", "partner"
├── display_name    (text)             — human name for UI / attribution display
├── role            (text)             — reserved; defaults "member" (see note)
├── status          (text, required)   — "active" | "suspended" (default "active")
├── created_at      (kernel)
├── updated_at      (kernel)
├── archived_at     (kernel)
```

`label` is the join key everything else references (passkeys, tokens, attribution). It is immutable once set (add to `IMMUTABLE_FIELDS` in `src/kernel.ts`).

> **On `role`:** include the column, but do **not** build role-based authorization in Tier 1. Members of a shared hive are co-equal by default — that's the trust model. `role` is a forward seam for a possible later "viewer vs. editor" distinction, nothing more. Resist the urge to gate writes on it now; it would be invariant surface with no current consumer ("store truth once, derive its consequences" — don't store policy nobody reads).

Bootstrapping: the first member is seeded during setup (the existing passkey-registration flow), labeled from the owner. A second member is added by an existing member through a consent-gated invite (see §6).

### 3. Multiple passkeys, one per member

This is the one concrete schema blocker. `_passkeys` is hard-capped at a single row:

```sql
id INTEGER PRIMARY KEY CHECK (id = 1)        -- src/schema.ts
```
```ts
db.exec("DELETE FROM _passkeys");            -- src/credentials.ts, wipes on re-register
```

Changes in `src/schema.ts` and `src/credentials.ts`:

- Relax the PK to a normal `INTEGER PRIMARY KEY AUTOINCREMENT`.
- Add a `member` column (FK-by-convention to `_members.label`).
- Drop the `DELETE`-before-`INSERT` in `storePasskey()` — append instead.
- `getPasskey()` → `getPasskeys()`; authentication already looks up *by credential_id*, so the verification path barely changes — it just stops assuming the row it finds is row 1, and reads `member` off the matched row to populate the resolved actor.
- WebAuthn's hardcoded `userName: "owner"` (`src/passkey.ts`) becomes the member's `label`, and `userDisplayName` the member's `display_name`.

The master secret stays exactly as it is: shared root of trust plus headless fallback. For a small set of trusted people that is appropriate — it's the bootstrap and the break-glass, not the daily credential. (A secret-authenticated action attributes to a sentinel actor; see §5.)

### 4. Resolve the actor from the credential

The actor is determined by *how you authenticated*, then carried in props for the life of the session.

- **Passkey path** (`src/routes/auth.ts`, `completeOAuth()`): the matched `_passkeys` row carries `member`. Return `{ hiveId, actor: member }` instead of the hardcoded `"owner"`.
- **OAuth / access-token path** (`src/index.ts`, `resolveExternalToken()`): add an optional `member` column to `_access_tokens` (already pluralizable — this just labels each token with who holds it). Resolve `actor` from the token's `member`; tokens with no member (legacy, headless) resolve to the sentinel actor.
- **Master-secret path:** resolves to the sentinel actor (`"system"` or `"owner"`), preserving today's behavior for headless agents.

`_access_tokens` gains one column:

```
_access_tokens
├── ... (existing columns)
├── member          (text)   — which member holds this token; null = unattributed/headless
```

### 5. Attribution — the part that earns the feature

This is what makes a shared hive *mean* something. "Partner added this last week," "you and I both wrote down the same plumber" — attribution is the difference between a shared password and a shared mind. It is also the hardest seam, so it is described honestly.

**Why it isn't free.** The audit triggers (`src/schema.ts`, `ensureAuditTriggers`) fire at the **SQL level**. The SessionDO → HiveDO RPC boundary is opaque to them: a trigger sees the row being written, never the session that initiated it. So `_mutation_log` cannot attribute writes on its own, no matter what we do to it.

**The approach: attribution-on-the-entry.** Add `created_by` and `updated_by` as kernel columns, set explicitly in the mutate path (`executeMutate` in `src/data.ts`), with `actor` threaded through `DataContext`.

- `DataContext` gains an `actor` field, populated from `props.actor` when HiveDO builds the context (`dataCtx()` in `src/hive.ts`).
- `executeMutate` writes `created_by` on `create`, `updated_by` on `update`/`patch`/`archive`.
- Because they are real columns, the existing audit triggers capture them in `new_data` for free, and `query`/`search`/`prime` can surface them.
- `deriveLabel` (`src/labels.ts`) and the publication/egress renderers can optionally show "— added by {display_name}".

Why on-the-entry rather than only in the audit log: attribution is read-time value, and it should ride along wherever entries are read — prime results, query results, the Svelte viewers. Putting it only in `_mutation_log` would bury it where the product never looks. This honors *data is destiny*: store the actor once as a column, **derive** every "who" display from it (resolve `label` → `display_name` at read time; never denormalize the display name into the entry).

> **Cost, stated plainly.** This touches the kernel column set, which means it touches DDL for every pattern, the migration path, and the mutate engine. It is the largest single piece of this work. It is also the piece most worth doing — and the cleanest reason to do the keystone (§1–4) *first* as a shippable increment, with attribution as a deliberate second pass.

### 6. Invitation and per-member revocation

**Invitation.** A new member is added by an existing member, consent-gated through the same machinery that gates federation-host additions (`_pending_consent`, the confirmation round-trip in the MCP `mutate` layer). The flow:

1. The inviting agent **names the member at invite time** — it creates the `_members` row (`status: active`) with both `label` (the immutable handle) and `display_name` (the human name) set up front. The invitee's identity therefore exists, fully named, *before* they ever touch the setup URL.
2. The agent mints a single-use, passkey-setup-scoped (`register`) access token bound to that member's `label`. The mint hook refuses `owner` and any non-active-roster member.
3. **A current member approves the invite in person.** The token is minted *inert*: an existing member must open `/invite/{token}` and authenticate with their passkey (master-secret fallback for the bootstrap case) to set `approved_at`. This is the real human-consent gate — the MCP `mutate` round-trip is *agent-satisfiable* (re-issuing the identical call clears it), so for the high-blast-radius act of admitting a person it is replaced by an out-of-band passkey approval that an agent acting on injected content cannot perform. `approved_at` is IMMUTABLE on the mutate path and set only by the approval endpoint.
4. The invitee opens the now-approved setup URL and registers their own passkey, which is stored against the pre-existing `member` label.

This is a deliberate choice: naming is the inviter's act, not the invitee's. The person being invited never has to pick or type a handle — they receive a URL that already knows who they are, and registration just attaches a credential to an identity that's already named and visible in the roster. (Attribution in §5 reads `display_name` straight off this row, so writes are correctly named from the invitee's very first mutation.) The agent never holds a usable invite: it mints an inert token and surfaces the `/invite/{token}` approval URL for a human, and only an approved token activates `/setup`.

Because `label` is immutable (§2) but `display_name` is not, an inviter who fat-fingers the handle must re-invite, but a corrected human name is a plain `mutate` on the `_members` row.

**Revocation.** Today revocation is the global session epoch (`src/router.ts`) — all-or-nothing. With members plus per-token/per-passkey `member` labels, granular revocation falls out almost for free:

- Suspend a member: set `_members.status = "suspended"`. Resolution (§4) refuses to mint props for a suspended actor.
- Revoke a member's credentials: archive their `_access_tokens` rows and delete their `_passkeys` rows by `member`.
- The global session epoch remains as the panic button (revoke *everyone* at once).

---

## Honest scoping and known sharp edges

- **Consent is hive-global.** `_pending_consent` is keyed by operation hash, not by member. For two trusted partners this is fine, but it means one member's pending federation-consent round-trip is visible to (and confirmable by) the other. Acceptable under the trust model; document it, don't fix it.
- **Conflict detection becomes a feature, not a bug.** The write-time KNN overlap check (`mutate`) already runs hive-wide. With two authors, it will naturally surface "you both wrote down the same thing" as a `possible_overlap` advisory. This is a *desirable* emergent property of sharing — lean into it.
- **Decay and prime are shared.** `_entry_access_log` records prime hits hive-wide; a recall by either member counts as rehearsal for both. Correct for shared memory — the memory is one organism, not two.
- **No per-member views or privacy *within* the hive.** Everything in a shared hive is visible to every member. If a member wants private memory, that's a separate (their own) hive, federated in via the existing federation mechanism. Do not build intra-hive privacy walls — that's the tenancy we explicitly rejected.
- **Browser session cookies remain global.** They gate routes and don't currently encode an actor. Threading the actor into the signed cookie payload is a natural extension (the cookie already carries `ts.sid.epoch.sig`; add the member) — needed so the Svelte viewers attribute web writes. Worth doing in the attribution pass (§5), not before.

---

## Implementation phasing

**Phase 1 — keystone (shippable on its own). ✅ IMPLEMENTED.** §1–4, §6. Split `hiveId`/`actor`, add `_members`, multi-passkey, actor resolution, invite + per-member revocation. After this, two people log in as themselves and can be individually revoked. Writes are not yet attributed (every actor can write; the system just doesn't *record* which one). Landed across `src/constants.ts`, `src/index.ts`, `src/session.ts`, `src/routes/auth.ts`, `src/credentials.ts`, `src/passkey.ts`, `src/hive.ts`, `src/schema.ts`, `src/kernel.ts`, with tests in `src/__tests__/hive.test.ts`.

**Phase 2 — attribution.** §5 and the cookie actor. Add `created_by`/`updated_by` kernel columns, thread `actor` through `DataContext`/`executeMutate`, surface attribution in labels/viewers/publications. Larger, DDL-touching, deliberately separate.

Each phase is independently valuable and independently testable. Ship Phase 1, live on it, then decide if Phase 2's attribution earns its cost (it almost certainly does for any real two-person use, but proving that on a working Phase 1 beats speculating).

---

## Touched surface (reference)

| Concern | File | Change |
| --- | --- | --- |
| Hive/actor constant | `src/constants.ts` | add `HIVE_ID` |
| Token → actor | `src/index.ts` | `resolveExternalToken` returns `{hiveId, actor}` |
| HTTP dispatch key | `src/router.ts` | key on `HIVE_ID`; (Phase 2) actor in cookie |
| Session → hive | `src/session.ts` | `getHive()` reads `props.hiveId`; expose `props.actor` |
| Passkey → actor | `src/routes/auth.ts` | `completeOAuth` resolves member from credential |
| Members + columns | `src/schema.ts` | `_members` pattern; `_access_tokens.member`; (Phase 2) `created_by`/`updated_by` kernel cols |
| Multi-passkey | `src/credentials.ts` | drop singleton; `getPasskeys`; `member` column |
| WebAuthn naming | `src/passkey.ts` | per-member `userName`/`userDisplayName` |
| Immutables | `src/kernel.ts` | `_members.label` immutable |
| Attribution write | `src/data.ts` | (Phase 2) `executeMutate` sets actor columns |
| Context | `src/hive.ts` | (Phase 2) `dataCtx()` carries `actor` |
| Display | `src/labels.ts` | (Phase 2) optional "added by" derivation |
