# MnemionKit

The platform-neutral client core: auth, the hive client, and the project, review and inbox vocabularies, each read off the hive's index and registry rather than assumed.

## invariants
- declared statuses: Whether an entry is closed, and what a tap on its checkmark writes, come only from the status facet's declared options and closed values; with no declaration nothing is closed and nothing is written.
  over: isClosed and toggledStatus over a schema that declares closed values, one that declares none, and no schema; the decoding of resolution and closed on a facet; the first open option a new task starts in; the charter's review_exempt parsed into entry references
  via: DeclarationTests
  because: Two hard-coded closed sets, one in the worker and one here, drifted within a day; the hive's declaration is the only home that cannot.
  kinds: none
- one write per intent: A task is born with its belongs-to link in one write, a review entry with its commits-to and reflects-on links in one write, a note with no project at all, and a move of a task is one atomic batch, so no client write can leave a required relation lapsed.
  over: createTask, recordReview for a start and an end hook, capture, makeTask from a note, move, prime and search, each against a stubbed hive that records the requests sent
  via: StubClientTests
  because: A task written in two requests can exist without its project between them, and the engine's required-relation rule only holds when the link rides the create.
  kinds: none
- review decoding: The derived review the worker serves decodes with its hooks, work, alignment and message, and the six hooks pair start with end and name the pattern their commitments go to.
  over: the Review model from the worker's JSON and ReviewHook's counterparts and commitsTo
  via: ReviewDecodingTests
  because: The Review screen renders the worker's derivation; a field it drops silently is a rule it re-decides.
  kinds: none
