# Hive

The single per-user Durable Object that owns all SQLite data and funnels every agent write through one kernel-enforced chokepoint.

## invariants
- kernel write boundary: Every agent write to a kernel pattern follows its declared write policy.
  protects: applyKernelRules in entities/Hive/kernel.ts
  chokepoint: mutateOne in entities/Hive/data.ts
  over: every kernel pattern in KERNEL_TABLES
  via: write-policy totality
  because: An unclassified pattern must fail closed instead of becoming agent writable.
  crossing: agent-mcp -> storage
  kinds: storage
  checklist: scoped-reads dismissed: this policy governs writes; kernel read access is a separate capability boundary
  checklist: encrypted-storage dismissed: write classification does not encrypt the row
  checklist: key-rotation-compatibility dismissed: write classes do not manage keys
  checklist: input-validation dismissed: field validation follows write admission in the kernel
  checklist: revision-preservation dismissed: the write class does not define revision history
  checklist: commit-ordered-effects dismissed: this policy admits writes before commit; effects have their own registry
  checklist: durable-dispatch-intent dismissed: write admission does not queue work
  checklist: declared-target-coverage declared as kernel write boundary
  checklist: completion-evidence dismissed: the policy is checked synchronously before mutation
- kernel read+write capability: An untrusted data context cannot read or write a kernel pattern.
  protects: entities/Hive/data.ts
  chokepoint: entities/Hive/hive.ts
  over: every kernel read and write through a DataContext
  via: context-capability totality
  because: Served reads and ingress writes must not gain owner capabilities by choosing a flag at the call site.
  crossing: served-untrusted -> storage
  kinds: read, storage
  checklist: scoped-reads dismissed: this requirement separates kernel and served access; row-level scope belongs to servedQuery
  checklist: encrypted-storage dismissed: the trust flag authorizes access; it does not encrypt stored values
  checklist: key-rotation-compatibility dismissed: this boundary has no encryption key or rotation stage
  checklist: redaction dismissed: egress-sensitivity totality governs outward representations
  checklist: input-validation dismissed: DataContext trust controls kernel access, not field schemas
  checklist: revision-preservation dismissed: this boundary does not publish version-addressed revisions
  checklist: commit-ordered-effects dismissed: this boundary controls access before a write, not effect ordering after commit
  checklist: durable-dispatch-intent dismissed: this boundary does not enqueue deferred work
  checklist: declared-target-coverage dismissed: this rule is over kernel-pattern access, not a dispatch target set
  checklist: completion-evidence dismissed: the operation is synchronous access control, with no background completion claim
- egress-sensitivity totality: Every sensitive column is classified for outward sealing.
  protects: FEATURE_SENSITIVE_COLUMNS in entities/features/security.ts
  chokepoint: entities/Hive/policy.ts
  over: every sensitive column in every kernel and feature pattern
  via: egress-sensitivity totality
  because: A new feature must not silently omit its secret or redacted columns from egress protection.
  crossing: storage -> public-egress
  entrances: none
  kinds: credential, output
  checklist: capability-authorization dismissed: this rule classifies columns; route and data capabilities authorize callers
  checklist: revalidated-permission dismissed: sealing is applied to each egress result, independently of the caller's permission
  checklist: destination-confinement dismissed: this rule controls fields in output, not the destination
  checklist: message-authenticity dismissed: the classified output is a local response, not a signed peer message
  checklist: encrypted-storage dismissed: sensitive fields are sealed on egress; this rule does not encrypt storage
  checklist: key-rotation-compatibility dismissed: the classification contains no rotating key
  checklist: redaction declared as egress-sensitivity totality
  checklist: separation-of-duties dismissed: classification does not grant or divide actor privileges
  checklist: commit-ordered-effects dismissed: egress sealing does not schedule a post-commit effect
  checklist: circuit-breaker-policy dismissed: sealing makes no remote call
  checklist: declared-target-coverage declared as egress-sensitivity totality
- boot sensitive-column oracle: The boot check for unclassified secret-shaped columns reads every kernel-like table it can and reports every table it cannot, so no refused table silences it; only the declared platform tables are exempt.
  over: every _-prefixed table at boot, with a real _cf_METADATA present, a planted unclassified column, and a non-platform table whose PRAGMA is refused; the platform allow-list PLATFORM_RESERVED_TABLES (exactly _cf_METADATA); and the _cf_ prefix across KERNEL_TABLES, boot DDL, _objects and user pattern names
  via: boot sensitive-column oracle
  because: A check that fails silent is worse than none; one platform table refusing PRAGMA once a PITR bookmark existed silenced the whole oracle in production, so an unclassified secret column could ship unseen.
  kinds: credential
  checklist: capability-authorization dismissed: the oracle classifies columns at boot; callers are authorized elsewhere
  checklist: revalidated-permission dismissed: no permission is checked or cached by the oracle
  checklist: message-authenticity dismissed: the oracle reads local schema, not a peer message
  checklist: encrypted-storage dismissed: the oracle reports classification gaps; it does not encrypt storage
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: separation-of-duties dismissed: the oracle grants no actor privileges
- pattern-effects totality: Every effect-bearing pattern has a composed post-mutate effect.
  over: every effect-bearing pattern in the composed feature set
  via: pattern-effects totality
  because: Adding a pattern must not silently skip re-embedding or cache invalidation.
  kinds: state
  checklist: revalidated-permission dismissed: the registry names effects after an admitted mutation; authorization is upstream
  checklist: separation-of-duties dismissed: the effect map does not grant actor roles
  checklist: legal-state-succession dismissed: pattern effects are callbacks, not a state-machine transition rule
  checklist: supersession-safety dismissed: this rule does not replace an in-flight job with a newer one
  checklist: worker-fencing dismissed: the effect registry runs inside one Hive instance, without a leased worker
  checklist: commit-ordered-effects dismissed: this rule checks effect coverage; mutation ordering must be checked separately
  checklist: resumption-coverage dismissed: the registry does not persist a resumable job
- facet kernel-column collision: A user facet cannot collide with a reserved kernel column.
  over: every kernel column and user-overridable exception
  via: facet-kernel-collision totality
  because: A collision breaks DDL, while over-reserving version rejects a valid user facet.
  kinds: storage
  checklist: scoped-reads dismissed: this rule validates schema names, not read permissions
  checklist: encrypted-storage dismissed: column-name validation does not encrypt row values
  checklist: key-rotation-compatibility dismissed: no key participates in schema naming
  checklist: input-validation declared as facet kernel-column collision
  checklist: revision-preservation dismissed: the rule does not alter existing revisions
  checklist: commit-ordered-effects dismissed: facet names are checked before a schema change is applied
  checklist: durable-dispatch-intent dismissed: schema validation does not enqueue work
  checklist: declared-target-coverage declared as facet kernel-column collision
  checklist: completion-evidence dismissed: validation returns synchronously
- data-is-destiny no-hybrid: A pattern retaining child rows does not store an aggregate of those rows.
  over: all pattern facets and child references
  via: data-is-destiny no-hybrid totality
  because: A stored aggregate alongside its source rows drifts when either write path changes.
  kinds: storage
  checklist: scoped-reads dismissed: this rule detects redundant stored aggregates, not read scope
  checklist: encrypted-storage dismissed: it concerns data modeling, not encryption
  checklist: key-rotation-compatibility dismissed: the schema check uses no key
  checklist: input-validation dismissed: the detector checks the composed schema, not a request payload
  checklist: revision-preservation dismissed: it prohibits a redundant column; it does not preserve versions
  checklist: commit-ordered-effects dismissed: the check runs against schema shape, not mutation effects
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage declared as data-is-destiny no-hybrid
  checklist: completion-evidence dismissed: the check reads the live schema synchronously
- credential-mint gating: Creating a credential with broad scope requires consent.
  protects: consentRoundTripRequired in entities/Hive/policy.ts
  chokepoint: entities/Hive/mutate-gate.ts
  over: all patterns with secret columns and their create policies
  via: credential-mint gating totality
  because: A patch-only policy once let an agent mint a broad owner bearer without a round trip.
  crossing: agent-mcp -> owner-trusted
  entrances: none
  kinds: credential
  checklist: capability-authorization declared as credential-mint gating
  checklist: revalidated-permission dismissed: this rule decides whether a create needs a consent round trip; consent execution is a separate gate
  checklist: message-authenticity dismissed: the credential is created locally, without an authenticated peer message
  checklist: encrypted-storage dismissed: mint admission does not store the bearer; born-hashed secrets governs storage
  checklist: key-rotation-compatibility dismissed: the rule classifies new grants, not rotation of existing grants
  checklist: separation-of-duties dismissed: this rule requires owner consent but does not define actor roles
- born-hashed secrets: A secret column stores only a digest of its minted bearer.
  protects: secretColumn in entities/Hive/policy.ts
  chokepoint: entities/Hive/hive.ts
  over: all secret columns and create paths
  via: born-hashed-secret totality
  because: A stored bearer would remain usable after any owner read or export.
  crossing: storage -> public-egress
  entrances: none
  kinds: credential, storage
  checklist: scoped-reads dismissed: digest-only storage is independent of which owner read retrieves it
  checklist: capability-authorization dismissed: mint admission is covered by credential-mint gating
  checklist: revalidated-permission dismissed: the digest is made at creation, not at a later permission check
  checklist: message-authenticity dismissed: bearer creation does not exchange a signed peer message
  checklist: encrypted-storage dismissed: one-way hashing is the stored form; there is no decryption step
  checklist: key-rotation-compatibility dismissed: this rule covers newly minted bearers, not rotation of an existing digest
  checklist: input-validation declared as born-hashed secrets
  checklist: revision-preservation dismissed: credential rows do not publish version-addressed revisions
  checklist: separation-of-duties dismissed: the minted bearer has its own scope; this rule governs persistence only
  checklist: commit-ordered-effects dismissed: hashing happens before the secret row commits
  checklist: durable-dispatch-intent dismissed: minting and hashing are synchronous
  checklist: declared-target-coverage declared as born-hashed secrets
  checklist: completion-evidence dismissed: the mutation returns after the digest is stored
- immutable-field enforcement: Kernel immutable fields cannot be changed after creation.
  over: all fields declared immutable by the composed kernel hooks
  via: IMMUTABLE-registry totality
  because: An agent must not self-approve an invite, replay a token, or repoint a credential after validation.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage, credential
  checklist: scoped-reads dismissed: this rule blocks writes to protected fields, not reads
  checklist: capability-authorization dismissed: the caller is authorized before immutable field validation
  checklist: revalidated-permission dismissed: immutability is unconditional after creation, regardless of later grants
  checklist: message-authenticity dismissed: these are local row mutations, not signed peer messages
  checklist: encrypted-storage dismissed: immutable field checks do not encrypt stored values
  checklist: key-rotation-compatibility dismissed: the protected fields are frozen; key rotation is outside this rule
  checklist: input-validation declared as immutable-field enforcement
  checklist: revision-preservation dismissed: this rule rejects field changes rather than preserving revisions
  checklist: separation-of-duties dismissed: it rejects every actor's change to a frozen field
  checklist: commit-ordered-effects dismissed: rejection occurs before a mutation commits
  checklist: durable-dispatch-intent dismissed: no deferred job is created by the check
  checklist: declared-target-coverage declared as immutable-field enforcement
  checklist: completion-evidence dismissed: rejection is synchronous
- token-scope-grammar: A pattern-wide token scope is classified as broad.
  over: all token resource kinds and scope prefix depths
  via: broad-token scope-grammar totality
  because: A read:entry:<pattern> prefix grants standing access and must require consent.
  crossing: agent-mcp -> owner-trusted
  entrances: none
  kinds: credential
  checklist: capability-authorization declared as token-scope-grammar
  checklist: revalidated-permission dismissed: this classifier runs when a token is minted; scopeMatches checks use separately
  checklist: message-authenticity dismissed: the scope string is local authorization data, not a peer message
  checklist: encrypted-storage dismissed: token scope classification does not persist a secret
  checklist: key-rotation-compatibility dismissed: the grammar does not rotate existing credentials
  checklist: separation-of-duties dismissed: the grammar decides broad versus narrow grants, not actor roles
- SSRF block-host coverage: Federation refuses non-public target hosts in every supported address encoding.
  over: all blocked IPv4, IPv6, metadata, and local hostname classes
  via: SSRF block-host totality
  because: A missed encoding can reopen a path to cloud metadata or another private host.
  crossing: owner-trusted -> federated
  entrances: none
  kinds: identity
  checklist: capability-authorization dismissed: this rule validates a network destination, not a caller's grant
  checklist: canonical-encoding declared as SSRF block-host coverage
  checklist: identity-continuity dismissed: host classification is repeated for each target; no long-lived identity is assumed
- sql-identifier quoting: Untrusted SQL identifiers are validated and quoted before interpolation.
  protects: IDENTIFIER_RE in shared/core/constants.ts
  chokepoint: quoteIdent in shared/core/sql.ts
  over: all identifier grammar cases and data-engine identifier interpolation
  via: quoteIdent — grammar
  because: A raw identifier can inject SQL when validation and quoting are separate steps.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: encoding, storage
  checklist: scoped-reads dismissed: quoting determines SQL syntax, not row visibility
  checklist: encrypted-storage dismissed: identifier quoting does not encrypt stored values
  checklist: key-rotation-compatibility dismissed: this boundary uses no key
  checklist: input-validation declared as sql-identifier quoting
  checklist: semantic-preservation declared as sql-identifier quoting
  checklist: canonical-encoding declared as sql-identifier quoting
  checklist: revision-preservation dismissed: this boundary does not manage revisions
  checklist: commit-ordered-effects dismissed: identifier validation runs before SQL execution
  checklist: durable-dispatch-intent dismissed: quoting does not enqueue work
  checklist: declared-target-coverage declared as sql-identifier quoting
  checklist: completion-evidence dismissed: validation is synchronous
- instance-identity host: Generated capability URLs use the configured worker host over an inbound Host header.
  over: all configured and observed host combinations
  via: instance-identity host resolution
  because: A spoofed inbound Host must not poison a URL returned to the owner.
  crossing: public-egress -> owner-trusted
  entrances: none
  kinds: identity
  checklist: capability-authorization dismissed: this rule selects a URL host after the capability has been granted
  checklist: canonical-encoding dismissed: it selects a configured host; URL encoding is applied by the URL builder
  checklist: identity-continuity declared as instance-identity host
- relation declaration totality: Every active link carries a label that names exactly one active relation, and its endpoints satisfy that relation's source, target and cardinality.
  over: every active _links row against every active _relations row (names and inverses unique, no unlabeled link, endpoint rows present), after admitted and refused link writes and after the legacy-label migration on its first boot, including order-independent generated inverses, the inverse rewrite before the sweep, and the one DDL-nullable kernel facet (_links.label) with no schema drift
  via: relation declaration totality
  because: A free-text label let the edge vocabulary drift and let a link join any two patterns; an undeclared label must be refused, not stored.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: this rule governs link and relation writes, not read scope
  checklist: encrypted-storage dismissed: relation rows and link labels are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates in relations or links
  checklist: input-validation declared as relation declaration totality
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage declared as relation declaration totality
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- link immutability: A link's endpoints and relation never change after create, and unarchiving a link re-validates it against the current registry.
  over: update, patch and unarchive of every _links row across label, source and target, and every unarchive precondition: retired relation, inactive endpoint, cycle, cardinality and duplicate
  via: link immutability
  because: Validation ran only on create, so update, patch and unarchive could repoint or revive a link past every check.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: this rule governs link and relation writes, not read scope
  checklist: encrypted-storage dismissed: relation rows and link labels are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates in relations or links
  checklist: input-validation declared as link immutability
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: the rule is over the fields of one link, not a registry of targets
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- behavior by declaration: A relation behavior takes effect because a relation declares it, and no worker source outside the relations module filters links on a label literal.
  over: every worker source file outside entities/Hive/relations.ts (no literal equal to a kernel relation name or inverse except declared seed-data files; no label comparison, quoted or not, in a file that queries _links, schema-qualified or not; no reference to KERNEL_RELATIONS or BEHAVIOR_PALETTE), and every supersession reader (getEntry, resolve, the stale view, publications, prime) driven by a hive-declared relation
  via: behavior by declaration
  because: Supersession meant five copies of label = 'supersedes', the guard-at-every-call-site pattern that fails open at the next copy.
  kinds: storage
  checklist: scoped-reads dismissed: the supersession readers are owner reads; this rule fixes where behavior is looked up, not which rows a reader may see
  checklist: encrypted-storage dismissed: relation rows and link labels are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates in relations or links
  checklist: input-validation dismissed: this rule locates behavior lookups; payload validation is the chokepoint's
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage declared as behavior by declaration
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- acyclicity: No write creates a cycle across a relation that declares the acyclic behavior, and cycles already present in pre-registry data are reported at boot, never auto-repaired.
  over: every acyclic relation, kernel default or hive-declared, across direct writes, inverse writes, self-links, unarchives and walks through dormant links, plus pre-registry cycles (2-cycles, self-loops, and cycles the inverse rewrite creates) reported by the boot warning
  via: acyclicity
  because: A cycle in depends-on, derived-from or supersedes makes the chain unanswerable: nothing is first, and supersession demotes both ends; legacy cycles are owner-ratified maintenance, so boot reports them instead of deleting links.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: this rule governs link and relation writes, not read scope
  checklist: encrypted-storage dismissed: relation rows and link labels are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates in relations or links
  checklist: input-validation declared as acyclicity
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: the rule is over one relation's edges, not a registry of targets
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- linked targets survive GC: No garbage-collection pass removes a row or table that is the target of an active link from outside it, and every archived pattern held past its drop horizon is reported in the stale view for the owner to ratify.
  over: every GC pass that removes rows or tables: the _web_cache GC over linked and unlinked rows past their TTL and grace window, and the 30-day archived-pattern drop over patterns targeted from outside (including mutually-linked archived patterns), linked only internally, under the horizon, and whose inbound link was archived, on repeated boots; and the stale view's held_patterns over the same cases
  via: linked targets survive GC
  because: A cited snapshot deleted under its link leaves the citation dangling; the protection is derived from the link so no pinned flag can drift from it.
  kinds: storage
  checklist: scoped-reads dismissed: GC is a boot-time sweep, not a read path
  checklist: encrypted-storage dismissed: relation rows and link labels are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates in relations or links
  checklist: input-validation dismissed: GC admits no input; the rule is over which rows a pass may delete
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: the rule names each GC pass that removes rows or tables; any future GC, including documents, must honor it
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- palette totality: Every behavior in the relation behavior palette has an enforcement test.
  over: every key of BEHAVIOR_PALETTE in entities/Hive/relations.ts
  via: palette totality
  because: A behavior declared before the engine performs it is a lie in the schema that agents would rely on.
  kinds: storage
  checklist: scoped-reads dismissed: the rule is over test coverage of behaviors, not reads
  checklist: encrypted-storage dismissed: relation rows and link labels are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates in relations or links
  checklist: input-validation dismissed: the rule is over the palette's coverage, not a payload
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage declared as palette totality
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- relation vocabulary evolution: Relations are declared, amended and retired only through validated change types, each previewed and logged, and never so that existing active links violate the result.
  over: declare_relation, amend_relation and retire_relation across every validation rule including explicit nulls, kernel defaults, legacy relations, violators that exist at propose or appear before apply, and the same payloads sent through the MCP propose_change tool, plus legacy debt (placeholder description and generated inverse, paid separately, derived not stored)
  via: relation vocabulary evolution
  because: Refusing an undeclared label is fair only when declaring one is possible, and an amend or retire must not strand links already written.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: this rule governs link and relation writes, not read scope
  checklist: encrypted-storage dismissed: relation rows and link labels are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates in relations or links
  checklist: input-validation declared as relation vocabulary evolution
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: each change type acts on one relation and its own links
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- link endpoint integrity: The boot sweep archives a link only when an endpoint is gone (its pattern or entry row no longer exists) or is a kernel pattern no relation admits, never because an endpoint is archived.
  over: active _links rows whose pattern was dropped, whose entry row is gone, or whose kernel endpoint is inadmissible, against dormant links to archived entries and archived patterns across repeated boots and unarchive
  via: integrity sweep
  because: Every cold start is a boot, and archive is reversible; sweeping links to archived endpoints made an entry's links survive or vanish depending on eviction timing, so the sweep removes only what is gone and stays deterministic.
  kinds: storage
  checklist: scoped-reads dismissed: the sweep is a boot-time repair, not a read path
  checklist: encrypted-storage dismissed: relation rows and link labels are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates in relations or links
  checklist: input-validation dismissed: the sweep repairs stored rows; write-time validation is relation declaration totality
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: the sweep is over one table's rows, not a registry of targets
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- unlink precision: Unlink archives exactly the one link it names, and refuses instead of guessing when its pair or relation is ambiguous, absent or malformed.
  over: unlink by canonical label, by inverse label and without a label, on pairs carrying one or several relations, with absent labels and malformed source or target shorthands
  via: unlink
  because: Once one pair can carry several relations, archiving the first matching link would silently remove the wrong relation.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: this rule governs link writes, not read scope
  checklist: encrypted-storage dismissed: relation rows and link labels are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates in relations or links
  checklist: input-validation declared as unlink precision
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: the rule is over one pair's links, not a registry of targets
  checklist: completion-evidence dismissed: the check is synchronous with the write
- migration restore point: The first boot that runs the relations migration records exactly one restore_point history row whose bookmark was captured before any migration step touched data, and reverting it hands exactly that bookmark to the existing restore path.
  over: a pre-migration hive booted through the HiveDO constructor with the bookmark available and unavailable, repeated boots, the order of the capture against every migration effect (relations table creation, pair-index drop, relations writes, link rewrites), and revert of the recorded row; and every entry of MIGRATION_RESTORE_POINTS (v17 first run on a fresh or pre-registry hive, v18 first run on a Phase 1-shaped _relations), each covered by a named test the structural check enforces
  via: restore point
  because: Deploying Phase 1 rewrites links and drops an index; without a bookmark taken before that boot there is no exact way to undo the deploy.
  kinds: storage
  checklist: scoped-reads dismissed: the rule records a restore point at boot; it is not a read path
  checklist: encrypted-storage dismissed: a PITR bookmark is an opaque position, not confidential data
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation dismissed: boot admits no input
  checklist: revision-preservation declared as migration restore point
  checklist: commit-ordered-effects declared as migration restore point
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: one migration, one restore point
  checklist: completion-evidence dismissed: the row is written synchronously during boot
- required relations: Every active entry of a required relation's source pattern holds at least one active link of it: creates must carry it inline, the last link cannot be removed except by a move in one batch, and declaring or amending to required is refused while any entry lacks it.
  over: creates with and without _relate, unlink and archive of the last link, one-batch moves, cardinality-many removals, archived and unarchived source entries, declare and amend previews with violators, explicit-list sources only, and the boot report over pre-existing data; required refused while any source pattern is archived, and unarchive_pattern of a source pattern previewing entries that lack the link
  via: required relations
  because: Compositional identity (a task belongs to exactly one project) is only true if no write path can leave a task without its project.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: this rule governs link and entry writes, not read scope
  checklist: encrypted-storage dismissed: relation rows, links and facet values here are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation declared as required relations
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: the rule is over one relation's source entries, not a registry of targets
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- containment: A container with active members cannot be archived, as an entry or by archive_pattern, unless the same batch archives or moves them, and recall follows containment upward only.
  over: archive of containers under kernel part-of and hive containment relations, archived members, non-containment relations, batches in any order that archive or move members or leave one stranded, archive_pattern previews and apply re-checks with members in other patterns (same-pattern and archived members exempt), resolve of a container, and prime from member and from container; unarchiving a member under an archived container entry or pattern (alone refused, together in a batch allowed), unarchive_pattern of a member pattern (preview, apply re-check), and amend_relation adding containment over existing archived containers with active members
  via: containment
  because: An archived container with live members strands a required relation's target, and fanning out from a container to all its members floods recall.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: recall direction shapes prime's expansion, not which rows a reader may see
  checklist: encrypted-storage dismissed: relation rows, links and facet values here are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation dismissed: the rule is over archive operations and recall direction, not payload shape
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: the rule is over one relation's members, not a registry of targets
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- atomic relation writes: An entry created with _relate is stored together with all its links through the link chokepoint, or not at all.
  over: _relate on single and batch creates, names and inverses, one or many targets, every link refusal (undeclared, missing, inadmissible, cardinality, malformed, duplicate, derived), updates, and the RPC, /api/mutate and MCP surfaces; and the /ws announcement of the links it creates, single and batch
  via: inline _relate
  because: A create-then-link sequence leaves an entry without the link it requires whenever the second write fails.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: this rule governs link and entry writes, not read scope
  checklist: encrypted-storage dismissed: relation rows, links and facet values here are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation declared as atomic relation writes
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage declared as atomic relation writes
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- batch link shortcuts: Inside a batch, the link and unlink shortcuts expand exactly as they do in a single mutate, and any refusal rolls the whole batch back.
  over: link and unlink items with and without an operation, mixed with entry writes, a refused link anywhere in the batch, and the MCP batch surface; and the batch consent gate judging items after shortcut expansion
  via: link shortcuts in batches
  because: A move (archive one link, create another) is only safe as one atomic batch, and today a batch rejects the link shortcut outright.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: this rule governs link and entry writes, not read scope
  checklist: encrypted-storage dismissed: relation rows, links and facet values here are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation dismissed: each item crosses the same link chokepoint as a single write
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: the rule is over one batch's items, not a registry of targets
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- derived relations are never stored: A chained relation is computed at read time from its stored steps and no _links row ever carries its name.
  over: chain declarations (unknown, non-composing, single or derived steps, and stored-relation fields), writes by name, inverse and _relate, resolve in both directions through active entries with deduplication, and retirement of a step a chain uses
  via: derived relations
  because: A stored copy of a composition drifts from the links it composes, the drift data-is-destiny forbids.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: this rule governs link and entry writes, not read scope
  checklist: encrypted-storage dismissed: relation rows, links and facet values here are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation declared as derived relations are never stored
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage declared as derived relations are never stored
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- drop_facet: A user-pattern facet is dropped only through the drop_facet change type, which previews the values lost and every reference to the facet, refuses while any reference remains or the facet is a reference facet, removes the column and its metadata together, keeps the pattern writable, and stays revertible.
  over: drop_facet over user facets with values, kernel patterns, kernel columns, missing facets and patterns, a pattern's only facet, reference facets, references from memory-policy exclusive_facets, _views configs, _publications filters and templates and _clipboards rules (listed at propose, re-checked at apply), later writes to the pattern, and revert of the logged change; references from _inputs (body_facet and facet_mapping keys) and active unconsumed upload tokens' target_facet, under preview.facet_references; and revert restoring the state before the drop; upload-token liveness compared as dates whatever form expires_at is stored in
  via: drop_facet
  because: Retiring text-facet stand-ins for relations must not lose data silently or leave _fields describing a column that no longer exists.
  kinds: storage
  checklist: scoped-reads dismissed: schema evolution, not a read path
  checklist: encrypted-storage dismissed: relation rows, links and facet values here are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation declared as drop_facet
  checklist: revision-preservation declared as drop_facet
  checklist: commit-ordered-effects dismissed: the drop commits in one change application; revert uses the stored PITR bookmark
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: one facet of one pattern
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- canonical datetime: A datetime facet in any pattern class stores ISO 8601: YYYY-MM-DD for date-only input, a full UTC timestamp otherwise; relative phrases are refused, text facets stay advisory, and existing values change only when that facet is written.
  over: dataset and knowledge patterns, date-only and timed inputs in several written forms, offsets, relative phrases, knowledge text facets, creates, updates and batch creates, and pre-existing non-canonical rows across boot and unrelated updates; the upload path (mint refuses a datetime target; a facet that became datetime canonicalizes or refuses at consume); partial, ambiguous and impossible dates (year, year-month, month-year, Feb 30, month 13, April 31, non-dates) refused in every class and on the upload path, writing nothing
  via: canonical datetime
  because: Strings stored as typed sort and compare inconsistently, so overdue and staleness cannot be derived from them.
  kinds: storage
  checklist: scoped-reads dismissed: the coercion shapes stored values, not read scope
  checklist: encrypted-storage dismissed: relation rows, links and facet values here are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation declared as canonical datetime
  checklist: revision-preservation dismissed: links and relations are not version-addressed publications; _schema_history is the audit record
  checklist: commit-ordered-effects dismissed: the check runs before the write commits and issues no external effect
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: one facet type's coercion
  checklist: completion-evidence dismissed: the check is synchronous with the write or boot pass
- change bookmarks: The PITR bookmark stored with a schema-history row is captured before the change applies, so reverting it restores the state before the change.
  over: applyChange for set_doctrine, declare_relation and drop_facet, the order of the bookmark capture against each change's first data effect, and revert of the recorded row
  via: change bookmarks
  because: A bookmark captured after the change makes revert restore the changed state, so every revert silently undid nothing.
  kinds: storage
  checklist: scoped-reads dismissed: the rule orders a capture inside a change application, not a read path
  checklist: encrypted-storage dismissed: a bookmark is an opaque position, not confidential data
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation dismissed: the rule concerns ordering, not a payload
  checklist: revision-preservation declared as change bookmarks
  checklist: commit-ordered-effects declared as change bookmarks
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: one capture per applied change
  checklist: completion-evidence dismissed: the capture and the history row are written synchronously with the change
- reference facets retired: No pattern gains a reference facet, and no reader treats references_object as a connection: entries connect only through declared relations and links.
  over: create_pattern and add_facet with links, getSchema, the index, export metadata, followLinks, archive_pattern impact, and findStoredDerivedAggregates (now read from containment relations, declared or by active links) against stale references_object rows
  via: reference facets retired
  because: Two edge stores drift: a foreign-key column and a _links row can say different things about the same connection, and readers that consult both disagree.
  crossing: agent-mcp -> storage
  entrances: none
  kinds: storage
  checklist: scoped-reads dismissed: the rule removes a connection path from reads; it does not change who may read
  checklist: encrypted-storage dismissed: facet values and links here are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation declared as reference facets retired
  checklist: revision-preservation dismissed: no published revision is involved
  checklist: commit-ordered-effects dismissed: refusals happen at propose, before any change commits
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: the rule is over the readers of one metadata column
  checklist: completion-evidence dismissed: the check is synchronous with the change or boot pass
- reference facet migration: At boot each existing reference facet becomes a legacy relation with one link per non-null value, its table is rebuilt without the column, and a restore point is recorded before any of it runs.
  over: reference facets with values, nulls, archived sources and targets, several facets in one pass (one pointing at a table also rebuilt), kebab-case names and their fallbacks (collisions, names a kebab rule rejects), mandatory facets migrating optional with the recorded `was mandatory` debt and its clearing by an explicit required decision, stored reference formats, repeated boots, hives without reference facets, the restore-point ordering, and the dev seed
  via: reference facet migration
  because: A boot that rewrites tables can't be undone without a bookmark taken first, and a half-migrated facet leaves two edge stores disagreeing.
  kinds: storage
  checklist: scoped-reads dismissed: schema evolution and boot migration, not a read path
  checklist: encrypted-storage dismissed: facet values and links here are not confidential at rest
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: input-validation dismissed: the migration reads stored schema, not a request payload
  checklist: revision-preservation declared as reference facet migration
  checklist: commit-ordered-effects declared as reference facet migration
  checklist: durable-dispatch-intent dismissed: no deferred dispatch is involved
  checklist: declared-target-coverage dismissed: one migration over the reference facets present at boot
  checklist: completion-evidence dismissed: the check is synchronous with the change or boot pass
