# Relations

## Edges without a schema

Mnemion treats structure as schema. A pattern is declared and has a doctrine. A
facet is declared with a type. Both change only through propose/apply, and every
change is logged. The connections between entries get none of this.

A `_links` row has a source, a target, and a `label` that is free text and
optional. Nothing declares which labels exist, what they mean, which patterns
they may join, or what the reverse direction is called. The hive has drifted
the way you'd expect, as measured on 2026-10-17:

- **Three mechanisms model the same thing.**
  - `_links` rows.
  - Reference facets: `links: {pattern, facet}` on a facet becomes a SQL
    `REFERENCES` column.
  - Text facets that hold relations as strings: `tasks.goal_ids`,
    `project-tasks.project`, and the `links` facet on `project-tasks`,
    `strategy` and `design-philosophies`. Some of those strings still use the
    retired `mnemion://records/…` URI form.
- **The text copies have drifted from the real links.**
  - `project-tasks/9`, `strategy/8` and all four `design-philosophies` rows name
    connections that no `_links` row carries.
  - Tasks 13, 14 and 21–29 hold goals only in `goal_ids`.
- **Only one link per pair is allowed, whatever its label.** The unique index
  `_links_pair_active` covers (source, target) and ignores the label. A task
  cannot both `depends-on` and `references` the same entry. The edge store
  models "these two are connected", with the label as an annotation.
- **The meaning of supersession is a string literal.** `label = 'supersedes'`
  appears in five queries: `hive.ts:278`, `hive.ts:953`, `prime.ts:340`,
  `reports.ts:337` and `served.ts:259`. That is the "remember the guard at every
  call site" pattern the doctrine exists to remove.
- **Validation runs only on create.** The `_links` ON_CREATE hook checks
  endpoint existence and refuses kernel patterns. There is no ON_WRITE hook and
  no immutability rule, so `update`, `patch` and `unarchive` can change the
  source, target or label without any check.
- **Reads drop direction.** `followLinks` merges incoming and outgoing links
  into one list of targets, so a reader can't tell whether "A blocks B" or
  "B blocks A".
- **There is one dangling link.** Link 55 joins `pub-test/3` to `pub-test/2`,
  but `pub-test` is not a pattern in this hive any more.

## The insight

Relations are schema. They should be declared, evolved and enforced exactly the
way patterns and facets are:

- one declarative home;
- one chokepoint that every write passes through;
- a totality check that fails loudly.

The data model for typed edges is solved; RDF properties, property graphs and
Datomic's ref attributes all agree. Mnemion's actual problem is different: the
schema author is usually an agent, writing mid-conversation, on any surface. The
main failure is vocabulary drift (`belongs-to` vs `part-of` vs `in-project`). So
the registry has to be visible where agents orient, refuse what it doesn't know,
and point to the nearest relation it does know.

This design takes what the solved models agree on: name, inverse, domain, range,
cardinality, a small behavior palette, and property chains. It leaves out
ontology reasoning and graph databases. At this scale, SQLite recursive queries
cover every derivation the product needs.

## Decisions (owner, 2026-10-17)

1. **Declared labels with kernel defaults. Undeclared labels are refused.**
   Every relation carries a detailed description. Behavior is declarable.
2. **Compositional identity.**
   - A task belongs to exactly one project.
   - A project serves one or more goals. That isn't enforced at write time: a
     project with no goal is derived as *unaligned* and surfaces for review.
   - A task's goals are not stored. They are composed from its project's goals,
     so one task can address several goals.
3. **Migrate reference facets into `_links`.** There will be one edge store.
4. **One task pattern.** `tasks` and `project-tasks` merge in this spike. A
   catch-all project holds tasks that have no natural project.
5. **`_documents` and `_web_cache` can be link targets,** and a link protects
   its target from garbage collection (§4a).

## Design

### 1. The registry: `_relations`

`_relations` is a new kernel pattern, and it is the one declarative home for
edge vocabulary. Its write class is System: it is written only through the
evolution change types in §6, never through `mutate`, the same as pattern and
facet definitions.

| Field | Meaning |
|---|---|
| `name` | The handle stored in `_links.label`. Kebab-case, unique among active relations, immutable. |
| `inverse` | The name read from the target's side. For `belongs-to` it is `contains`. Writes may use the inverse; the engine swaps the endpoints and stores only the canonical direction. |
| `description` | **Required and detailed.** It says what the relation asserts, when to use it rather than its nearest neighbour, and gives one example written in canonical direction. The quality bar is enforced at declaration (§6). |
| `source`, `target` | Lists of allowed patterns, or `*` for any user pattern. Kernel patterns are refused, except that `_documents` and `_web_cache` are valid **targets** (§4a). |
| `cardinality` | `one` or `many`: the most active links of this relation one source entry may hold. |
| `required` | Every active entry of a listed source pattern must hold at least one. Only allowed when `source` is an explicit list. |
| `behaviors` | A subset of the palette in §2. |
| `chain` | For a derived relation (§3): an ordered list of relation names. A derived relation has no stored rows. |
| `kernel` | True for the seeded defaults. Their name, semantics and behaviors are owned by code and refreshed at boot, the way `_system_docs` defaults are. |

### 2. Behaviors: declarable, from a fixed palette

You declare which behaviors a relation has. The engine implements each
behavior once, at a chokepoint, with a test proving it is enforced. Agents never
author code here. This is the same principle as view specs: declarative data
read against a fixed set of components.

**Palette v1:**

| Behavior | What the engine does | Where |
|---|---|---|
| `supersession` | The target has been replaced by the source. Prime multiplies the target's score by 0.3. Resolve and the stale view annotate it with `superseded_by`. Publications exclude it unless opted in. | The five literal sites listed above become one `relationsWith("supersession")` lookup in the relations module. |
| `acyclic` | A link that would close a cycle across this relation is refused. | The link write chokepoint, using a recursive CTE. |
| `containment` | The source is part of the target. Archiving a target that still has active members is refused unless the same batch moves or archives them. This keeps a `required` relation from pointing at an archived target. **Recall goes upward only:** prime follows the relation from member to container, but doesn't fan out from a container to its members. `resolve` still lists the members, labelled with the inverse name. | The mutate engine's archive path, for patterns that are containment targets; `followLinks` for recall direction. |

**Candidates for v2.** Each waits until its derivation exists, because
declaring a behavior the engine doesn't perform is a lie in the schema.

- `blocking`: the source is derived as *blocked* while its target is still
  open. This needs each pattern to declare which statuses count as finished,
  which belongs to the commitment-model work that comes next.
- `quiet`: prime's one-hop expansion skips this relation entirely. Container
  fan-out is already handled by `containment` (upward-only recall), so this
  is for other relations that turn out noisy.
- `rollup`: progress and counts derived up a containment chain.

### 3. Derived relations: composition

A relation can be declared as a chain of others, like an OWL property chain:

```
addresses := belongs-to ∘ serves      (project-tasks → goals)
```

A derived relation follows "store truth once, derive its consequences":

- it is computed at read time and never stored;
- writing it is refused, and the error names the stored relations to write;
- `resolve` returns it with `derived: true`.

Compositional identity is exactly this mechanism. A task's goals are its
project's goals. A task addresses several goals because its project serves
several goals. The task never repeats that.

### 4. Enforcement: one chokepoint

All checks live in a pure `entities/Hive/relations.ts` module that receives its
context, as `data.ts` and `evolution.ts` do. The mutate engine calls it from a
fixed set of points.

**On a link write** (the `_links` ON_CREATE hook, plus a new ON_WRITE hook):

1. The label must name an active relation. If it names an inverse, the endpoints
   are swapped. If it names nothing, the write is refused, and the refusal lists
   the relations declared for that (source pattern, target pattern) pair and how
   to declare a new one. This follows the clipboard violations model.
2. The endpoints must satisfy the relation's source and target patterns, and
   must exist and be active.
3. Cardinality `one` refuses a second active link from the same source.
4. The `acyclic` behavior refuses a link that would close a cycle.
5. **Links become immutable after create.** `source_*`, `target_*` and `label`
   join `IMMUTABLE`. Moving a link means archiving it and creating a new one,
   in one batch. Unarchiving re-runs steps 1–4. This closes the gap where
   `update` and `unarchive` bypassed every check.

**On an entry write:**

- **Create.** If the pattern is the source of a `required` relation, the
  create must carry that link inline (§5). Otherwise it is refused, and the
  error names the relation and the target pattern it expects.
- **Unlink.** Removing the last link of a `required` relation is refused. The
  error says to move the link instead.
- **Archive.** The `containment` behavior applies (§2).

**The unique index** becomes (source, target, label) over active links. One
pair can then carry several different relations, but not the same relation
twice.

### 4a. Documents and web cache as targets; a link protects from GC

Owner decision, 2026-10-17: `_documents` and `_web_cache` can be link
**targets**. They are where most cited material lives. A relation's `target`
may name them, and `*` covers them alongside every user pattern. No other
kernel pattern may be a target; credentials, the roster and config tables
stay refused.

**A link protects its target from garbage collection.** The `_web_cache` GC
(`schema.ts` GC block) skips any row that is the target of an active link,
the same way it skips pinned rows. The protection is **derived**, not stored:
the GC query excludes link targets directly, with no `pinned` flag to keep in
sync. Archiving the link makes the row collectable again under the normal
rules. A link does not freeze the snapshot; re-fetch behaviour is unchanged,
and `resolve(retain: true)` is still how a snapshot is frozen.

`_documents` has no GC today; a document goes away only when it is archived
explicitly. Any future document GC must honour the same rule.

Invariant: **linked targets survive GC.** No GC pass removes a row that is the
target of an active link. A test seeds a linked cache row past its TTL and its
grace window, runs GC, and asserts the row survives.

### 5. Writing relations atomically

Compositional identity makes a lone create impossible: a task needs its project
in the same write. There are two mechanisms.

- **Inline on create.** A reserved `_relate` key in the create data. Facet
  names must start with a letter, so it cannot collide with a facet.

  ```
  mutate(project-tasks, create, {
    title: "Ship capture",
    status: "open",
    _relate: { "belongs-to": "projects/1", "derived-from": "inbox/42" }
  })
  ```

  The engine strips `_relate`, inserts the row, then inserts and validates the
  links in the same transaction. The response returns the links with the entry.
- **Batches that speak links.** `batchMutate` expands the `link` and `unlink`
  shortcuts the way `mutate()` does, and inline `_relate` works on batch
  creates. Today `pattern: "link"` fails inside a batch with "Pattern does not
  exist".

### 6. Reading and evolving

**Reading:**

- `resolve` reports each linked entry with its `direction` (out or in) and the
  relation name as read from the reader's side: outgoing `belongs-to`, incoming
  `contains`. Derived relations are flagged.
- The index gains `relations: [...]`.
- A new resource, `mnemion://relations`, lists the vocabulary.
- `mnemion://schema/{pattern}` lists the relations where the pattern is a source
  or a target.
- Prime's orientation names the declared relations, so agents meet the
  vocabulary before they write.

**Evolution** gains three change types in `CHANGE_TYPES`, each with the usual
validate, preview and apply, and each logged to `_schema_history`:

- **`declare_relation`.**
  - Validates the name, inverse, patterns, behaviors and chain.
  - Requires a description of at least about 120 characters that does not
    merely restate the name.
  - The preview lists existing entries that would violate a `required` flag.
    Apply is refused while any remain, so backfill comes first, or the relation
    is declared non-required and flipped once the data is clean.
- **`amend_relation`.** Changes the description, inverse, behaviors,
  cardinality or `required`. The same preview runs against current data. The
  name is immutable.
- **`retire_relation`.** Refused while active links use the relation. The
  preview names them.

A fourth change type, **`drop_facet`**, is needed to retire the text-facet
stand-ins. It does not exist today.

### 7. Retiring reference facets

The live hive has **zero** reference facets, so for this hive retiring them is
purely a code change. Forks may have them, and the dev seed has one
(`tasks.goal_id`), so the design still needs a migration path.

**The code change:**

- `create_pattern` and `add_facet` stop accepting `links`. The error points to
  `declare_relation`.
- Remove the reference-facet branch of `followLinks`.
- Remove `facet.links` from the index, `getSchema` and export metadata.
- Remove the reference-facet branch of `referenceImpact`.
- The web app's `reference` format becomes relation rendering.
  `/api/label/:pattern/:id` stays; it is how relations get readable names.

**`findStoredDerivedAggregates`** is re-pointed from `references_object` to
`containment` relations. This also closes the gap noted at `schema.ts:1222`,
where the check ignored `_links` children.

**Fork migration.** A core migration handles hives that do have reference
facets:

1. For each reference facet, declare a relation named after the facet, with
   cardinality `one` and a generated description marked for owner review.
2. Copy each non-null value into a `_links` row.
3. Rebuild the table without the column. SQLite refuses `DROP COLUMN` on a
   column used in a foreign-key constraint, so a plain drop won't work.

### 8. The merged task pattern

Owner decisions, 2026-10-17:

- the survivor is **`tasks`**;
- `dropped` joins the status vocabulary;
- **deadlines are absolute dates.**

A relative deadline ("this week") loses its anchor the moment it's stored. The
hive can't tell "this week" written in March from "this week" written today, so
it can't say how stale a task is. Relative phrasing is resolved to a date **at
write time, against the moment of writing**. Overdue and staleness are then
derived at read time from the date and the clock, never stored.

| Facet | Type | Notes |
|---|---|---|
| `title` | text, required | |
| `context` | text | Enough to pick the task up cold. `notes` from the old `tasks` pattern is appended here. |
| `status` | select, required, default `open` | `open`, `in-progress`, `done`, `dropped` |
| `deadline` | datetime | An absolute date. A period resolves to its **last day**: the latest acceptable date. |
| `belongs-to` → project | relation, one, required | Replaces the `project` text facet. |
| `addresses` → goals | derived | `belongs-to ∘ serves`; replaces `goal_ids`. |

Dropped: `project`, `links`, `goal_ids`, `done` (folded into `status`) and
`notes` (folded into `context`).

**Engine fix: datetime facets store a canonical value.** Today the `datetime`
coercion in `data.ts:190` accepts anything `Date.parse` understands and stores
the caller's string unchanged, so "March 7, 2026" and "2026-03-07" both land as
typed and sort inconsistently. The coercion should store ISO 8601: `YYYY-MM-DD`
for a date-only input, a full timestamp otherwise. That way comparison and
ordering in SQL are always correct. Relative phrases still fail validation, as
they do today. Resolving them is the writer's job (the agent or the client),
because only the writer knows the moment of writing.

**Moving `project-tasks` into `tasks`:**

- The 15 entries are re-created in `tasks` and get new ids. Their links (15
  `belongs-to`, 10 `references`, 1 `depends-on`, 1 `supersedes`, and 3 inbound
  from `strategy`) are re-pointed in the same migration.
- `project-tasks` is then archived, not deleted, and the migration records an
  old→new id map.
- Some entries mention `project-tasks/N` as plain text, including the iOS
  task's own context. Those strings go stale; the id map is how to translate
  them.
- The Swift client's `Portfolio.projectTasks` constant becomes `tasks`.

## Kernel defaults

These are seeded with `kernel: true`, `source: *` and `target: *`. They are
pattern-agnostic, so every hive has a sound vocabulary from the start.

| Relation | Inverse | Behaviors | Asserts |
|---|---|---|---|
| `supersedes` | `superseded-by` | supersession, acyclic | The source replaces the target as current truth. The target is kept and demoted, never hidden. |
| `references` | `referenced-by` | — | The source cites or draws on the target. This is the honest generic link: it asserts nothing structural. |
| `depends-on` | `required-by` | acyclic | The source can't be completed before the target. It gains `blocking` when lifecycles are declared. |
| `derived-from` | `source-of` | acyclic | The source was made from the target. This is provenance: an idea triaged into a task, or a draft distilled into an axiom. |
| `part-of` | `has-part` | containment, acyclic | Generic hierarchy for hives without a domain-specific containment relation. |

## This hive's declarations

| Relation | Source → target | Cardinality | Required | Behaviors | Live links |
|---|---|---|---|---|---|
| `belongs-to` (inverse `contains`) | tasks → projects | one | yes | containment | 15 (from project-tasks) |
| `serves` (inverse `served-by`) | projects → goals | many | no (a project with no goal is derived as *unaligned*) | — | 1, plus 20 tasks→goals to migrate |
| `addresses` (inverse `addressed-by`) | tasks → goals | derived | — | chain: belongs-to ∘ serves | — |
| `refines` | agent-development-axioms → same | many | no | acyclic | 2 |
| `applies` | llm-tractability → same | many | no | — | 2 |
| `corollary-of` | frame-primitives → same | many | no | acyclic | 5 |
| `bridges-to` | frame-primitives → same | many | no | — | 1 |
| `diagnostic-application-of` | frame-primitives → same | many | no | — | 1 |
| `ethos-grounds` | axioms → frame-primitives | many | no | — | 1 |

The six lineage relations come from the apparatus patterns and are kept as
distinct relations (decided 2026-10-17). In an analytical apparatus, the kind
of a connection is the content. Each is limited to the patterns that use it.

## Migration

### Phase 1: registry and chokepoint (code)

- `_relations` kernel table, write policy System, a `policy.test.ts` row, and
  the kernel defaults seeded idempotently in the style of the owner `_members`
  seed.
- **Legacy labels.** A core migration declares every label already in use as a
  hive relation:
  - source and target patterns are inferred from usage;
  - no behaviors, except that `supersedes` resolves to the kernel default;
  - the description is a placeholder flagged `legacy`.

  The hive stays writable from the first deploy. A boot oracle warns for every
  legacy description until it is amended, which keeps the debt visible.
- The relations module, the link ON_CREATE and ON_WRITE checks, link
  immutability, the rebuilt unique index, and replacing the five supersession
  literals.
- The integrity sweep archives active links with a missing endpoint (link 55).
- `resolve` gains direction and the inverse names. The index gains
  `relations`, and `mnemion://relations` lists the vocabulary.
- The `declare_relation`, `amend_relation` and `retire_relation` change types.
  They are needed now: refusing an undeclared label is only fair if declaring
  one is possible, and amending is how legacy descriptions get paid down.
- `_documents` and `_web_cache` as link targets, and GC protection for linked
  targets (§4a).
- **Palette in Phase 1: `supersession` and `acyclic` only.** `part-of` is
  seeded with `acyclic` and gains `containment` in Phase 2, so no behavior is
  declared before the engine performs it.

### Phase 2: composition and atomic writes (code)

- `required` relations and the `containment` behavior, including upward-only
  recall in prime. `part-of` gains `containment`.
- Inline `_relate` on create.
- Link shortcuts inside batches.
- Derived relations in `resolve`.
- The `drop_facet` change type.
- The merged `tasks` shape (§8), including canonical datetime storage.

### Phase 3: retire reference facets (code)

- Everything in §7, plus moving the dev seed to relations.
- Rewrite the reference-facet tests:
  - `hive.test.ts`: "supports foreign key links", "rejects links to
    non-existent patterns", and "linked facet validation";
  - `formats.test.ts`: the reference-format case;
  - `data-is-destiny.test.ts`: the reference-facet fixture.

### Phase 4: this hive's data (agent-run, owner-ratified)

1. **Declare the hive relations** in the table above. I'll draft the
   descriptions; you ratify them at apply.
2. **Turn text facets into links** with `references`, unless you choose
   otherwise:
   - `design-philosophies`: 1→2, 1→3, 2→1, 5→1, 6→1;
   - `strategy/8` → `frame-primitives/12` and `/15`. Its third reference,
     `_short_term_fragments/24`, is a kernel pattern and is dropped;
   - `project-tasks/9` → `project-tasks/8`.

   Then `drop_facet` the three `links` facets and `project-tasks.project`. Every
   project-task already has a `belongs-to` link, so the project is derivable.
3. **Convert deadlines to dates.** Each phrase is resolved against the entry's
   `created_at`, and a period resolves to its last day. Most results are
   already in the past, which is exactly the staleness that relative text was
   hiding.

   | Task | Was | Anchor | Becomes |
   |---|---|---|---|
   | 1 | mid-March 2026 | | 2026-03-15 |
   | 2, 9 | April 8, 2026 / before AI Engineer Europe (April 8–10) | | 2026-04-08 |
   | 3 | this week | 2026-03-09 (Mon) | 2026-03-15 |
   | 4 | end of May 2026 | | 2026-05-31 |
   | 5 | "weeks" | 2026-03-09 | 2026-04-06 (four weeks; ratified) |
   | 6 | 2026 H2 | | 2026-12-31 |
   | 7 | 12–18 months | 2026-03-09 | 2027-09-09 (the upper bound; ratified) |
   | 8 | ~mid 2028 | | 2028-06-30 |
   | 10, 11, 13, 14 | Q2 2026 | | 2026-06-30 |
   | 12 | this week | 2026-03-14 (Sat) | 2026-03-15 |
   | 21, 22 | 2026 Q3 | | 2026-09-30 |
   | 23, 24 | 2026 Q4 | | 2026-12-31 |
   | 25, 26, 27 | 2027 Q1 | | 2027-03-31 |
   | 28 | 2027 Q2 | | 2027-06-30 |
   | 29 | quarterly, ongoing | | null. This is a recurrence, not a deadline, and belongs to the commitment model (ratified). |

4. **Give every task a project.** All 29 entries need one, done ones
   included, because `required` applies to every active entry. Tasks with no
   natural project go into the catch-all project.
   - Each new project serves the union of its members' `goal_ids`.
   - The 20 direct tasks→goals `serves` links are then archived.
   - `goal_ids` is dropped.

   Grouping ratified by the owner on 2026-10-17:

   | Project | Serves goals | Tasks |
   |---|---|---|
   | Talks & public writing | 13, 10, 9 | 1, 2, 5, 9, 20 |
   | Advisory practice | 9, 10 | 6 |
   | Agent Accords | 10, 11, 13 | 10, 11 |
   | Mnemion (existing) | 11 | 13, 14, 15 |
   | Reading program | 10, 11, 13 | 16–19, 21–28 |
   | Relocation | 9, 13 | 4, 29 |
   | Financial runway | 9 | 7, 8 |
   | Catch-all | — | 3, 12 |

5. **Move `project-tasks` into `tasks`** (§8), then archive `project-tasks`.
6. **Flip `required` on** for `belongs-to` once the preview shows no
   violators. `serves` stays optional; the *unaligned* view covers it.

### Clients

- **Web:** the app shows nothing about links today. Relation rendering ships
  with Phase 3.
- **Swift:** `Portfolio` already walks `belongs-to`. It switches to `resolve`
  with direction, and new tasks use inline `_relate`. That removes today's
  non-atomic create-then-link.

## Invariants (for `Hive.spec.md`)

Each starts as a requirement. It becomes an invariant once its test has passed
and a staged break has made the test fail.

- **relation declaration totality.** Every active link's label names an active
  relation, and its endpoints satisfy that relation's source, target and
  cardinality.
- **link immutability.** A link's endpoints and relation never change after
  create. Unarchiving re-validates.
- **behavior by declaration.** No query outside the relations module filters on
  a label literal. This is a structural check, and it is the one that catches
  the next `'supersedes'`.
- **required relations.** Every active entry of a pattern with a required
  relation holds one, checked at boot and by a test.
- **acyclicity.** No cycle exists across an `acyclic` relation.
- **derived relations are never stored.** No `_links` row carries a chained
  relation's name.
- **linked targets survive GC.** No GC pass removes a row that is the target of
  an active link (§4a).
- **palette totality.** Every behavior in the palette has an enforcement test.
  A behavior added without one fails the suite.

## Open questions

1. ~~The `tasks` → project grouping.~~ **Ratified 2026-10-17** as drafted in Phase 4, with tasks 3 and 12 in the catch-all project.
2. ~~Keep or fold the six lineage relations?~~ **Decided 2026-10-17:** keep all
   six, each limited to the patterns that use it. `refines` and `corollary-of`
   are acyclic. I draft the descriptions; the owner ratifies them at apply.
3. ~~Merge `tasks` and `project-tasks` now or later?~~ **Decided 2026-10-17:**
   merge now; there's no reason to maintain two. Tasks with no natural project
   go into a catch-all ("void") project. The merged shape is the next question.
4. ~~Can `_documents` and `_web_cache` be link targets?~~ **Decided
   2026-10-17:** yes, and a link protects its target from GC (§4a).
5. ~~Is `serves` required at project create?~~ **Decided 2026-10-17:** no. A
   project with no goal is derived as *unaligned* and surfaces in the weekly
   review. The catch-all project is the expected exception; any other unaligned
   project is a question for the owner. `belongs-to` stays required.
6. ~~Pull `quiet` into v1?~~ **Decided 2026-10-17:** no. `containment` implies
   upward-only recall in prime (member → container, never container → all
   members); `resolve` still lists members. `quiet` stays a v2 candidate.

## Touched surface (reference)

| Area | Location |
|---|---|
| `_links` DDL and indexes | `entities/Hive/schema.ts:305-331` |
| Link hook | `entities/Hive/kernel.ts:290-330`; shortcuts at `499-508` |
| Unlink | `entities/Hive/data.ts:971-1000` |
| Write policy | `entities/Hive/policy.ts:163` (`_links` Open) |
| Supersession literals | `hive.ts:278, 953`, `prime.ts:340`, `reports.ts:337`, `served.ts:259` |
| `followLinks` | `entities/Hive/prime.ts:389-467` |
| Export links | `hive.ts:1350`, `shared/Routing/routes/io.ts:535` |
| Archive impact | `entities/Hive/evolution.ts:509-545` |
| Reference facets | `evolution.ts:57-120`, `schema.ts:589`, `reports.ts:92`, `hive.ts:222-241, 1327`, `web/src/views.tsx`, `web/src/FacetValue.tsx:76-101`, `shared/core/format-palette.ts:30-68` |
| Batch | `hive.ts:572-628`; `session.ts:647-693` |
| Change types | `evolution.ts:130-471`; `session.ts:389-418`; `tools.ts:104` |
| Kernel seeding | `schema.ts:1060-1075` (model); boot oracles at `1100-1116` |
| Agent docs | `src/system-docs/schema-evolution.md:48-55`, `memory-maintenance.md:11-49`, `http-io.md:61-101`, `conventions.md:17`; `tools.ts:22-105`; `session.ts:75-81`; `lexicon.json` |
| Tests to revise or extend | `memory.test.ts` (supersession), `publications.test.ts:231`, `integrity-fixes.test.ts:66`, `hive.test.ts:141-162, 1461`, `formats.test.ts:44`, `data-is-destiny.test.ts:47` |

## Interface (Phase 1)

This appendix pins every shape the Phase 1 acceptance tests
(`mnemion-js/src/__tests__/relations.test.ts`) assume. The implementer builds to
it; a later auditor checks against it. Where the design above is silent, the
choice is listed under "Choices made by the test author".

### A. The `_relations` kernel pattern

Write class **System** (`policy.test.ts` expects `_relations: WriteClass.System`):
`mutate` create and update are refused with the usual "managed by the system"
message. Owner `query` reads it. Kernel columns (`id`, `version`, `created_at`,
`updated_at`, `archived_at`, `created_by`, `updated_by`) as on every pattern.

| Column | SQLite type | Value |
|---|---|---|
| `name` | TEXT NOT NULL | The handle stored in `_links.label`. Unique among active rows. |
| `inverse` | TEXT NOT NULL | Unique across every active `name` and `inverse`. |
| `description` | TEXT NOT NULL | |
| `source` | TEXT NOT NULL | JSON array of pattern names, or `["*"]`. |
| `target` | TEXT NOT NULL | JSON array of pattern names, or `["*"]`. |
| `cardinality` | TEXT NOT NULL | `"one"` or `"many"`; default `"many"`. |
| `required` | INTEGER NOT NULL DEFAULT 0 | Phase 2. Always 0 in Phase 1. |
| `behaviors` | TEXT NOT NULL DEFAULT `'[]'` | JSON array, a subset of the palette. |
| `chain` | TEXT | Phase 2. NULL in Phase 1. |
| `kernel` | INTEGER NOT NULL DEFAULT 0 | 1 for the seeded defaults. |
| `legacy` | INTEGER NOT NULL DEFAULT 0 | 1 for a relation the legacy migration declared, until its description is amended. |

A retired relation is an archived row (`archived_at` set). Its name may be
declared again.

The five kernel defaults are seeded with `kernel = 1`, `legacy = 0`,
`source = target = ["*"]`, `cardinality = "many"`, a description of at least
120 characters, and the inverse and behaviors in the Kernel defaults table,
except that `part-of` carries `["acyclic"]` only. Boot refreshes their inverse,
behaviors and description from code, and seeding is idempotent.

`*` as a source means any user pattern. `*` as a target means any user pattern,
`_documents` or `_web_cache`. No other kernel pattern is admitted on either end,
and no kernel pattern is admitted as a source; that refusal's message contains
`kernel pattern`.

### B. Relation change types

All three go through `proposeChange` then `applyChange`, and each is logged to
`_schema_history` with `change_type` equal to its type.

```jsonc
// declare_relation
{ "type": "declare_relation",
  "name": "cites",                 // kebab-case: /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
  "inverse": "cited-by",           // required
  "description": "…",              // >= 120 chars, more than the name restated
  "source": ["notes"],             // pattern names, or ["*"]
  "target": ["papers"],            // pattern names, "_documents", "_web_cache", or ["*"]
  "cardinality": "many",           // optional; "one" | "many"; default "many"
  "behaviors": ["acyclic"] }       // optional; subset of BEHAVIOR_PALETTE; default []

// amend_relation: name identifies the relation; every other field is optional
{ "type": "amend_relation", "name": "cites",
  "description": "…", "inverse": "…", "behaviors": [], "cardinality": "one" }

// retire_relation
{ "type": "retire_relation", "name": "cites" }
```

`declare_relation` refuses at propose, with an error message naming the
offending part, when:

- the name is not kebab-case or starts with `_`;
- the name is already an active name or inverse;
- the inverse is missing, equals the name, or is already an active name or
  inverse;
- the description is under 120 characters, or is the name (or inverse)
  restated: removing every occurrence of them and the whitespace and
  punctuation leaves no substantive text;
- a listed pattern does not exist, a listed source is a kernel pattern, or a
  listed target is a kernel pattern other than `_documents` or `_web_cache`;
- a behavior is outside the palette; `containment` (and a `required: true` or a
  `chain` field) is refused with a message containing `not yet supported`;
- cardinality is not `one` or `many`.

`amend_relation` refuses at propose when the relation does not exist or is a
kernel default; when the payload carries `new_name` (the name is immutable);
and on any field that fails the `declare_relation` rule for that field.
Amending a relation's `description` sets `legacy` to 0.

**Violations.** When an `amend_relation` (to cardinality `one`, or adding
`acyclic`) or a `retire_relation` meets active links that would violate the
result, propose still succeeds and returns them in `preview.violations`:

```jsonc
{ "violations": [ { "source": "notes/1", "target": "papers/2" /*, link id, label, reason as the implementer likes */ } ] }
```

`applyChange` re-checks against current data and returns `{ error: true, … }`
while any violation remains, leaving the relation unchanged. A violator written
between propose and apply also blocks the apply. For a retire, every active link
using the relation is a violation. Kernel defaults cannot be amended or
retired: propose refuses.

### C. The link write chokepoint

Both the `link` shortcut and raw `_links` create cross it. A refusal is
`{ error: true, message }` authored by the engine: never `internal: true`, and
never the raw text of a SQLite UNIQUE constraint.

**Undeclared or missing label:**

```jsonc
{ "error": true,
  "message": "… names each available relation … declare_relation …",
  "available_relations": ["supersedes", "references", "depends-on", "derived-from", "part-of", "cites"] }
```

`available_relations` lists the canonical names of the active relations whose
source admits the source entry's pattern and whose target admits the target
entry's pattern. The message names each of them and contains `declare_relation`.
A missing, `null` or empty label gets the same shape.

**Inverse writes.** A label equal to an active relation's inverse is stored as
that relation's name, with source and target swapped. Every later check
(patterns, cardinality, acyclicity, uniqueness) judges the canonical row.

**Uniqueness.** Over active links, (source, target, label) is unique. The old
pair-only index `_links_pair_active` is gone, and an upgraded hive that still
carries it loses it at boot.

**Immutability.** `source_pattern`, `source_id`, `target_pattern`, `target_id`
and `label` cannot be changed by `update` or `patch`, and neither can the `source`
and `target` shorthands on update. The refusal message contains `immutable`.
These fields go in `IMMUTABLE_AFTER_CREATE`, not `IMMUTABLE`: in this codebase
`IMMUTABLE` refuses the field on create too. Unarchiving a link re-runs every
create check against current data: active relation, active endpoints, patterns,
cardinality, acyclicity and uniqueness.

### D. Resolve direction

`getEntry` and `resolve(mnemion://entry/…)` return `linked` items with two added
fields:

```jsonc
{ "pattern": "notes", "id": 2, "uri": "…", "entry": { … },
  "direction": "out",            // "out": the reader is the source; "in": the reader is the target
  "relation": "depends-on" }     // the name for "out", the inverse for "in"
```

There is one linked item per active link. A pair carrying two relations yields
two items. The existing `label` field may stay; it carries the canonical name.

### E. Index and `mnemion://relations`

`getIndex()` gains a top-level `relations` array, and
`resolve("mnemion://relations")` returns `{ "relations": [...] }`. Both list the
active relations as:

```jsonc
{ "name": "cites", "inverse": "cited-by", "description": "…",
  "source": ["notes"], "target": ["papers"],  // parsed arrays, not JSON text
  "cardinality": "many", "behaviors": [],     // parsed array
  "kernel": false, "legacy": false }          // booleans
```

Retired relations are absent from both.

### F. Legacy labels and the boot warning

On boot, for each distinct label on active links that names no active relation:

- `NULL` or empty labels are rewritten to `references`;
- every other label is declared verbatim, even when it is not kebab-case.
  `source` and `target` are the distinct source and target patterns of its
  active links, `behaviors` is `[]`, `cardinality` is `many`, `kernel` is 0 and
  `legacy` is 1. The description is a non-empty placeholder. The inverse is
  implementation-chosen, non-empty, and unique across every name and inverse
  (for example `<name>-inverse`).

`supersedes` and the other kernel names already resolve to kernel defaults, so
they are never declared again. Labels found only on archived links are not
declared. The integrity sweep runs first, so no relation names a pattern that
does not exist. The migration is idempotent.

The boot warning is observable as a `console.warn` during `initializeSchema`,
directly or through `logWarn`. Its text contains `legacy` and the name of every
relation with `legacy = 1`. It does not name a relation whose description has
been amended. The warning is built from a pure findings function in
`relations.ts`, in the style of `findUnclassifiedSensitiveColumns`.

### G. Integrity sweep and GC

At boot, an active link is archived when its source or target pattern does not
exist, its entry row does not exist, or its entry is archived. One exception: a
link whose target is an archived `_web_cache` row stays, because that row is a
superseded snapshot the link protects (§4a).

The `_web_cache` GC skips any row that is the target of an active link. This is
derived in the GC query; there is no stored flag.

### H. `entities/Hive/relations.ts`

The module exports `BEHAVIOR_PALETTE`, a table (an object, not an array) keyed
by behavior name. In Phase 1 its keys are exactly `supersession` and `acyclic`.
It is the only worker source file allowed to filter `_links` on a label literal,
or to compare a label to a relation name in code.

`PrimeContext` stays `{ env, db, patternExists }`. Supersession lookups read
`_relations` through the `db` it is handed.

### Choices made by the test author

1. **Archived `_web_cache` targets survive the integrity sweep** (G). The brief
   says the sweep archives links to archived endpoints. The GC deletes only
   archived cache rows, so without this exception the §4a protection would
   last a single boot.
2. **Unlabeled legacy links become `references`** (F). Relation declaration
   totality requires every active link to name a relation, and `references`
   is the link that asserts nothing structural.
3. **Violations are previewed, then refused at apply** (B), the same shape for
   amend and retire as the doc gives for `required`. Apply re-checks.
4. **Kernel endpoint refusals say `kernel pattern`.** The existing
   `integrity-fixes.test.ts` case links to `_members/1` with an undeclared
   label and expects `/kernel pattern/`. To keep it green, the kernel-endpoint
   check runs before label resolution.
5. **JSON-array TEXT** for `source`, `target` and `behaviors`. This matches
   `_fields.options` and `memory_policy`. The read surfaces (E) return parsed
   arrays.
6. **`*` is stored as `["*"]`**, not as a bare string.
7. **`available_relations`** is the structured field on the
   undeclared-label refusal, mirroring the clipboard `violations` model. Its
   contents are canonical names only.
8. **One linked item per link** in resolve (D), so a second relation on the
   same pair is visible.
9. **`relation`** is the new reader-side field name. `label` keeps the
   canonical name for compatibility.
10. **Legacy cardinality is `many`** and legacy labels are declared verbatim,
    so the hive stays writable on the first deploy.
11. **Amend refuses `new_name`** to make "the name is immutable" testable.
    Source and target are not amendable in Phase 1, though no test pins that.
