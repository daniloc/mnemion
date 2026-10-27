---
slug: reviews
title: "Reviews"
---
# Reviews

Reviews run on a cadence, like hooks: a hook fires at the start or end of a day, a week or a month, gathers what the hive can derive, asks the human a few questions, and records the answers as an entry linked to the work it touched. Whether a hook is due is derived, never stored.

## The surface

`{{uri:review}}` (also `GET /api/review`) returns, computed fresh on every read:

- **hooks** — the six kinds (`day-start`, `day-end`, `week-start`, `week-end`, `month-start`, `month-end`), each with its current period key, whether it is due, and the latest review of that kind. A hook is due when its window is open and no review entry of that kind covers the current period. Start hooks open at the start of the period; `day-end` opens at the charter's `review_day_end_hour` (default 17); `week-end` from Friday at that hour; `month-end` in the last three days of the month. The calendar runs in the charter's `timezone` (an IANA name; default UTC).
- **work** — for every pattern with a `deadline` datetime facet and a `status` select facet: open entries that are overdue, due today, due this week, or stalled (untouched longer than the pattern's memory-policy half-life, 30 days without one). Which statuses close an entry is the pattern's own declaration (`closed` on its `status` select, set with the facet or through `set_options`); a pattern that declares none closes nothing, every entry counts as open, and the review's message says so until the owner declares them.
- **alignment** — for every chained (derived) relation, each step's ends that hold no link: the source entries lacking the step (unless the step is required, which the engine already enforces) and the target entries nothing reaches. With `addresses = belongs-to then serves`, that is projects serving no goal, goals nothing serves, and projects with no tasks. Closed entries (status done, dropped, retired, …) are skipped, and so are the entries the charter key `review_exempt` names (`projects/8, goals/2`): the owner's record of exceptions a doctrine allows, such as a catch-all project that serves no goal by design.
- **message** — one line summarizing all of the above, or null when nothing needs attention. The same line rides the MCP session briefing and the `prime` response.

## The reviews pattern

Hooks need one user pattern to record into. The review discovers it: the pattern whose `kind` select offers the six hook names and that has a `period` datetime facet. When none exists, the review's `hooks.declare` carries the changes to propose, in order: `pattern` (the `create_pattern`) and `relations` (`commits-to`, reviews to the work the human chose, many; and `reflects-on`, an end review to its start review, one, acyclic). Apply each with the owner's ratification. Deadlines and periods with a time of day are read on their calendar day in the charter `timezone`.

## Running a hook with the human

1. Read `{{uri:review}}`. If a hook is due, say which, and show what it gathered.
2. Ask the hook's questions. Start hooks: what is the one outcome for this period, which work supports it, what is deliberately deferred. End hooks: did the outcome happen, what intervened, what changed.
3. Record one entry in the reviews pattern: `kind`, `period` (the day as YYYY-MM-DD, the week's Monday, or the month's first day), and `intention` or `reflection` in the human's words. Link the chosen work with `commits-to` in `_relate`; link an end review to its start with `reflects-on`.
4. Act on the gathered lists in the same conversation when the human wants to: reschedule, drop or finish overdue work with `mutate`; give an unaligned project a `serves` link.

Never create a review speculatively, and never answer the questions for the human. A missing review is information: the hook stays due until the human runs it or its period ends; a missed one is not carried into the next.
