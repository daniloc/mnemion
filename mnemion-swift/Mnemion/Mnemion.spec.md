# Mnemion app

The SwiftUI surfaces: review first, inbox capture that connects at write, goals, projects and tasks, every value they write chosen from the hive's declarations.

## invariants
- views pick never spell: No view or app model spells a status or energy value, names an entry by id or slug, sizes a sheet outside the one platform-aware modifier, or reloads outside the store's coalesced loaders.
  over: every Swift source under Mnemion and MnemionKit/Sources, scanned for each write form the app uses (a literal in a dictionary, a .string literal, a default, an initial state, a literal list), for entry ids and slugs, for .frame(minWidth, and for a bare reload task
  via: ConventionTests
  because: Each rule the second blind review found was a value a view had spelled for itself; the hive's facets and the charter are their only home.
  kinds: none
