# Mnemion app

The SwiftUI surfaces: review first, inbox capture that connects at write, goals, projects and tasks, every value they write chosen from the hive's declarations.

## invariants
- views pick never spell: No view or app model spells a status or energy value, names an entry by id or slug, sizes a sheet outside the one platform-aware modifier, or reloads outside the store's coalesced loaders.
  over: every Swift source under Mnemion, MnemionShare and MnemionKit/Sources, scanned for each write form the app uses (a literal in a dictionary, a .string literal, a status query filter, a default, an initial state, a literal list), for entry ids and slugs, for .frame(minWidth, and for a bare reload task; two declared exceptions: MnemionKit/Inbox.swift holds the inbox doctrine's own vocabulary (status, source), which this client declared with the pattern and which triage must tell apart, and a kernel pattern's status (_members) is the worker's
  via: ConventionTests
  because: Each rule the second blind review found was a value a view had spelled for itself; the hive's facets and the charter are their only home.
  kinds: none
