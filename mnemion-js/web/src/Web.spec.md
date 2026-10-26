# Web

The React owner interface for reading, editing, and visualizing a hive.

## invariants
- create relation fields: The create form offers exactly one target field per required, stored relation the pattern is a source of, and its values become exactly the Phase 2 _relate payload.
  over: createRelationFields over required, optional, derived, other-source and target-only relations, and buildRelatePayload over single, multiple, empty and duplicate values, round-tripped through a real create
  via: create relation fields
  because: A create form that omits a required relation produces a refused write; one that offers optional or derived relations invites links the engine rejects.
  kinds: encoding
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: semantic-preservation declared as create relation fields
  checklist: canonical-encoding declared as create relation fields
- entry relations view: An entry's relations render grouped by reader-side relation and direction, outgoing first, with derived chains flagged, from resolve's linked items alone.
  over: entryRelationsView over outgoing, incoming and derived items, empty and absent input, and resolve's real output
  via: entry relations view
  because: Rendering connections from reference facets showed only one direction and one mechanism; the relation registry is now the only source.
  kinds: encoding
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: semantic-preservation declared as entry relations view
  checklist: canonical-encoding dismissed: the grouping is for display, not an identity or key
- reference format retired: The format palette has no reference format, and no resolution path or facet-format change yields it.
  over: FORMAT_IDS, isFormat, resolveFormat with the former foreign-key flag and with stale view or facet values, validateFormatsMap, and set_facet_format
  via: reference format retired
  because: A reference format with no reference facets behind it would render nothing navigable.
  kinds: encoding
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: semantic-preservation dismissed: retiring a format changes presentation, not a computation
  checklist: canonical-encoding dismissed: format ids are not an encoded identity
- alignment view: The alignment view lists exactly the active source entries of the serves relation that hold no active serves link to an active target, and exactly the active targets no active source serves, and it is absent when the hive declares no stored serves relation with explicit ends.
  over: alignmentRelation over stored, derived, wildcard-ended, renamed and absent relations, and alignmentView over linked, unlinked, other-label, archived-source and archived-target cases, round-tripped through the hive's real query output
  via: alignment view
  because: The relations design keeps serves optional and relies on the weekly review to surface unaligned projects and goals no work feeds; a view that counted dormant links or another relation would hide exactly those.
  kinds: encoding
  checklist: key-rotation-compatibility dismissed: no key participates
  checklist: semantic-preservation declared as alignment view
  checklist: canonical-encoding dismissed: the view is for display, not an identity or key
