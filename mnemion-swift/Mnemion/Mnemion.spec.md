# Mnemion app

The SwiftUI surfaces: review first, inbox capture that connects at write, goals, projects and tasks, every value they write chosen from the hive's declarations.

## invariants
- views pick never spell: No view or app model spells a status or energy value, names an entry by id or slug, sizes a sheet outside the one platform-aware modifier, or reloads outside the store's coalesced loaders.
  over: every Swift source under Mnemion, MnemionShare and MnemionKit/Sources, scanned for each write form the app uses (a literal in a dictionary, a .string literal, a status query filter, a default, an initial state, a literal list), for entry ids and slugs, for .frame(minWidth, and for a bare reload task; two declared exceptions: MnemionKit/Inbox.swift holds the inbox doctrine's own vocabulary (status, source), which this client declared with the pattern and which triage must tell apart, and a kernel pattern's status (_members) is the worker's
  via: ConventionTests
  because: Each rule the second blind review found was a value a view had spelled for itself; the hive's facets and the charter are their only home.
  kinds: none
- views lay out with the platform: A view chooses its layout from the size class or ViewThatFits, never from a width it measured; lists are List, forms are Form, row moves are swipeActions and contextMenu, and details beside the work are an inspector.
  over: every Swift source under Mnemion/Views, scanned for width measurement (onGeometryChange, GeometryReader), for content framed to the whole width of its own scroll view (containerRelativeFrame(.horizontal); a count:span: share of a sideways scroller is the paging primitive), and for hand-built rows (DividedRows, RowHover, PageColumns, Page); every page has moved, so each scan finds nothing
  via: ConventionTests
  because: On the iPhone Duo every page built on a measured width kept its old layout after a rotation, cut off on both sides; a fold changes the size the same way. The system's own primitives re-lay out on every size change and bring the row behavior the hand-built pages lacked.
  kinds: none

