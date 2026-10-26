// review.ts — the derived review: what needs attention now, computed at read
// time from stored entries, links and the calendar.
//
// Nothing here is stored. "Overdue" is a deadline before today; "stalled" is an
// open entry untouched for longer than its pattern's half-life; an alignment gap
// is an end of a chained relation's step with no link; and a review hook is due
// when no review entry of that kind exists for the current period — the same
// days-since derivation `_maintenance_passes` uses. Per data-is-destiny: store
// truth once, derive its consequences.
//
// @why The projects doctrine asks for a weekly review and the tasks doctrine
// asks agents to check open tasks, and neither happened: a rule held by memory
// is a block-list. One derived surface — mnemion://review, /api/review, the MCP
// briefing and the prime response — is the chokepoint every reader crosses.
//
// Vocabulary is read off the hive, never assumed: a work pattern is any user
// pattern with a `deadline` datetime facet and a `status` select facet; the
// reviews pattern is the user pattern whose `kind` select offers the hook names
// and that carries a `period` datetime facet; alignment follows the chained
// (derived) relations the registry declares.

import { uri } from "../../shared/core/constants";
import { quoteIdent } from "../../shared/core/sql";
import { getMemoryPolicy, parseDbDate } from "./prime";
import { deriveLabel } from "./labels";
import { activeRelations, entriesLacking } from "./relations";

export interface ReviewContext {
  db: any;
  /** Injected by tests; defaults to the wall clock. */
  now?: Date;
}

/** The six hooks, in the order a day, a week and a month unfold. */
export const HOOKS = ["day-start", "day-end", "week-start", "week-end", "month-start", "month-end"] as const;
export type HookKind = (typeof HOOKS)[number];

const DEFAULT_STALL_DAYS = 30;
const DEFAULT_DAY_END_HOUR = 17;
/** The month-end hook opens this many days before the month turns. */
const MONTH_END_DAYS = 3;
const LIST_CAP = 50;
const DAY = 86_400_000;

export interface EntryBrief {
  pattern: string;
  id: number;
  label: string;
  uri: string;
  status?: string;
  deadline?: string | null;
  updated_at?: string;
}

export interface WorkReview {
  pattern: string;
  open: number;
  undated: number;
  stall_days: number;
  /** False when the status select declares no `closed` values: then nothing
   *  counts as closed and every entry is open, until the owner declares them. */
  closed_declared: boolean;
  /** Full counts; the lists below are capped at LIST_CAP. */
  totals: { overdue: number; due_today: number; due_this_week: number; stalled: number };
  overdue: EntryBrief[];
  due_today: EntryBrief[];
  due_this_week: EntryBrief[];
  stalled: EntryBrief[];
}

export interface AlignmentGap {
  /** The chained relation whose step has the gap (e.g. addresses). */
  chain: string;
  /** The stored step relation (e.g. serves). */
  relation: string;
  end: "source" | "target";
  pattern: string;
  /** Full count; `entries` is capped at LIST_CAP. */
  total: number;
  entries: EntryBrief[];
}

export interface HookStatus {
  kind: HookKind;
  /** The current period's key: a date for day hooks, the Monday for week hooks, the first for month hooks. */
  period: string;
  /** True when the hook's window is open and no review of this kind covers the period. */
  due: boolean;
  last: { id: number; period: string } | null;
}

export interface Review {
  as_of: string;
  timezone: string;
  hooks: {
    pattern: string | null;
    due: HookKind[];
    status: HookStatus[];
    /** When no reviews pattern exists: the pattern and relations to declare, in order. */
    declare?: { pattern: Record<string, unknown>; relations: Record<string, unknown>[] };
  };
  work: WorkReview[];
  alignment: AlignmentGap[];
  /** One line for briefings; null when nothing needs attention. */
  message: string | null;
}

// === Calendar ===

interface LocalClock {
  date: string;
  hour: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  year: number;
  month: number;
  day: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function pad(n: number): string { return String(n).padStart(2, "0"); }
function iso(y: number, m: number, d: number): string { return `${y}-${pad(m)}-${pad(d)}`; }

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The wall clock in the hive's timezone. An unknown zone falls back to UTC. */
export function localClock(now: Date, timeZone: string): { clock: LocalClock; timezone: string } {
  const options: Intl.DateTimeFormatOptions = {
    hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short",
  };
  let parts: Intl.DateTimeFormatPart[];
  let zone = timeZone;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, ...options }).formatToParts(now);
  } catch {
    zone = "UTC";
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).formatToParts(now);
  }
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour")) % 24;
  const weekday = WEEKDAYS[get("weekday")] ?? 1;
  return { clock: { date: iso(year, month, day), hour, weekday, year, month, day }, timezone: zone };
}

function charterValue(db: any, key: string): string | null {
  try {
    const r = db.exec(`SELECT "value" FROM "_charter" WHERE "key" = ? AND archived_at IS NULL`, key).toArray() as any[];
    return r[0]?.value != null ? String(r[0].value) : null;
  } catch {
    return null;
  }
}

// === Pattern discovery ===

interface FacetRow { name: string; type: string; options: string | null; required: number; closed?: string | null; resolution?: string | null }

function userPatterns(db: any): string[] {
  try {
    return (db.exec(
      "SELECT name FROM _objects WHERE archived_at IS NULL AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
    ).toArray() as { name: string }[]).map((r) => r.name);
  } catch {
    return [];
  }
}

function facetsOf(db: any, pattern: string): FacetRow[] {
  try {
    return db.exec("SELECT name, type, options, required, closed, resolution FROM _fields WHERE object_name = ? ORDER BY id", pattern).toArray() as FacetRow[];
  } catch {
    return [];
  }
}

function optionsOf(f: FacetRow | undefined): string[] {
  if (!f?.options) return [];
  try {
    const parsed = JSON.parse(f.options);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** A work pattern carries a `deadline` datetime and a `status` select. */
function isWorkPattern(facets: FacetRow[]): boolean {
  return facets.some((f) => f.name === "deadline" && f.type === "datetime")
    && facets.some((f) => f.name === "status" && f.type === "select");
}

/** The reviews pattern: a `kind` select offering the hook names, plus a `period` datetime. */
function isReviewsPattern(facets: FacetRow[]): boolean {
  const kind = facets.find((f) => f.name === "kind" && f.type === "select");
  if (!kind) return false;
  const options = new Set(optionsOf(kind));
  return HOOKS.every((h) => options.has(h)) && facets.some((f) => f.name === "period" && f.type === "datetime");
}

/** Everything a hive needs before hooks can be recorded: the pattern, and the
 *  two relations the review entries link with. Apply in order, each a
 *  propose_change + apply_change. */
export function reviewsDeclaration(): { pattern: Record<string, unknown>; relations: Record<string, unknown>[] } {
  return {
    pattern: reviewsPatternSpec(),
    relations: [
      {
        type: "declare_relation", name: "commits-to", inverse: "committed-in",
        description: "The source review records that the human chose the target work item as a commitment for the review's period: the primary outcome of a day, or the projects that get attention this week. Use it only from a review entry; membership is belongs-to, and a mere mention in a reflection is references. Example: reviews/1 commits-to tasks/41.",
        source: ["reviews"], target: ["*"], cardinality: "many", behaviors: [],
      },
      {
        type: "declare_relation", name: "reflects-on", inverse: "reflected-in",
        description: "The source review (a day-end, week-end or month-end entry) answers the target review (the matching start entry): did the intention happen, what intervened, what changed. One reflection per start review; a reflection that merely cites an older review uses references. Example: reviews/2 reflects-on reviews/1.",
        source: ["reviews"], target: ["reviews"], cardinality: "one", behaviors: ["acyclic"],
      },
    ],
  };
}

/** The change an owner applies to declare a reviews pattern. */
export function reviewsPatternSpec(): Record<string, unknown> {
  return {
    type: "create_pattern",
    pattern_name: "reviews",
    pattern_description: "Periodic reviews, one entry per hook firing: the intention set at the start of a day, week or month and the reflection recorded at its end. Whether a hook is due is derived from the latest entry of each kind, never stored.",
    doctrine: "Create one entry when a review hook runs with the human: kind names the hook, period is the day (YYYY-MM-DD), the week's Monday, or the month's first day. Start hooks record an intention; end hooks record a reflection and link reflects-on the matching start entry. Link the work the human committed to with commits-to. Never create a review speculatively; the human's answers are the entry.",
    facets: [
      { name: "kind", type: "select", required: true, options: [...HOOKS] },
      { name: "period", type: "datetime", required: true, resolution: "day" },
      { name: "intention", type: "text" },
      { name: "reflection", type: "text" },
      { name: "energy", type: "select", options: ["low", "medium", "high"] },
    ],
  };
}

// === Briefs ===

/** The calendar day of a stored datetime, in the hive's timezone. A date-only
 *  value is already a day; a timestamp (stored as UTC ISO) is read in `timezone`,
 *  so a deadline of 8 pm Los Angeles is due on that Los Angeles day. */
export function localDay(value: unknown, timezone: string): string | null {
  if (value == null) return null;
  const s = String(value);
  if (!s.includes("T")) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s.slice(0, 10);
  return localClock(new Date(t), timezone).clock.date;
}

function brief(pattern: string, row: Record<string, unknown>, facets: FacetRow[], timezone: string): EntryBrief {
  const b: EntryBrief = {
    pattern,
    id: row.id as number,
    label: deriveLabel(row, facets).slice(0, 120),
    uri: uri(`entry/${pattern}/${row.id}`),
  };
  if (typeof row.status === "string") b.status = row.status;
  if ("deadline" in row) b.deadline = localDay(row.deadline, timezone);
  if (typeof row.updated_at === "string") b.updated_at = row.updated_at;
  return b;
}

/** Entries the owner exempts from alignment gaps, by charter key `review_exempt`
 *  ("projects/8, goals/2"): stored truth for the exceptions a doctrine names,
 *  such as the catch-all project that serves no goal by design. */
function exemptRefs(db: any): Set<string> {
  const raw = charterValue(db, "review_exempt") ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** The pattern's declared terminal statuses (`_fields.closed` on its status
 *  select), or null when it declares none. There is no fallback set: an
 *  undeclared pattern closes nothing (fail closed), and the review says so. */
function closedStatuses(facets: FacetRow[]): Set<string> | null {
  const status = facets.find((f) => f.name === "status" && f.type === "select");
  if (!status?.closed) return null;
  try {
    const parsed = JSON.parse(status.closed);
    return Array.isArray(parsed) ? new Set(parsed.map((s) => String(s).toLowerCase())) : null;
  } catch {
    return null;
  }
}

function isOpen(row: Record<string, unknown>, closed: ReadonlySet<string> | null): boolean {
  if (!closed) return true;
  const s = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  return !closed.has(s);
}

// === Work: overdue, due, stalled ===

function reviewWork(db: any, pattern: string, facets: FacetRow[], today: string, weekEnd: string, now: Date, timezone: string): WorkReview {
  const policy = getMemoryPolicy(db, pattern);
  const stallDays = policy.half_life_days ?? DEFAULT_STALL_DAYS;
  let rows: Record<string, unknown>[] = [];
  try {
    rows = db.exec(`SELECT * FROM ${quoteIdent(pattern)} WHERE archived_at IS NULL`).toArray() as Record<string, unknown>[];
  } catch { /* table may be mid-rebuild */ }

  const closed = closedStatuses(facets);
  const open = rows.filter((row) => isOpen(row, closed));
  const out: WorkReview = {
    pattern, open: open.length, undated: 0, stall_days: stallDays, closed_declared: closed != null,
    totals: { overdue: 0, due_today: 0, due_this_week: 0, stalled: 0 },
    overdue: [], due_today: [], due_this_week: [], stalled: [],
  };
  for (const row of open) {
    const b = brief(pattern, row, facets, timezone);
    const d = b.deadline ?? null;
    if (d == null) out.undated++;
    else if (d < today) out.overdue.push(b);
    else if (d === today) out.due_today.push(b);
    else if (d <= weekEnd) out.due_this_week.push(b);
    // Stalled: open and untouched, and not already listed as due this week or
    // overdue, so nothing is counted twice.
    if (d == null || d > weekEnd) {
      const touched = parseDbDate(row.updated_at as string | undefined);
      if (touched != null && (now.getTime() - touched) / DAY >= stallDays) out.stalled.push(b);
    }
  }
  const byDeadline = (a: EntryBrief, b: EntryBrief) => (a.deadline ?? "").localeCompare(b.deadline ?? "");
  out.overdue.sort(byDeadline);
  out.due_this_week.sort(byDeadline);
  out.stalled.sort((a, b) => (a.updated_at ?? "").localeCompare(b.updated_at ?? ""));
  for (const k of ["overdue", "due_today", "due_this_week", "stalled"] as const) {
    out.totals[k] = out[k].length;
    out[k] = out[k].slice(0, LIST_CAP);
  }
  return out;
}

// === Alignment: the ends of a chain's steps that hold no link ===

function reviewAlignment(db: any, facetCache: Map<string, FacetRow[]>, timezone: string): AlignmentGap[] {
  const rels = activeRelations(db);
  const byName = new Map(rels.map((r) => [r.name, r]));
  const gaps: AlignmentGap[] = [];
  const seen = new Set<string>();
  const exempt = exemptRefs(db);
  const facets = (p: string) => {
    if (!facetCache.has(p)) facetCache.set(p, facetsOf(db, p));
    return facetCache.get(p)!;
  };
  for (const chain of rels.filter((r) => r.derived && r.chain)) {
    for (const stepName of chain.chain!) {
      const step = byName.get(stepName);
      if (!step || step.derived) continue;
      const ends: ("source" | "target")[] = step.required ? ["target"] : ["source", "target"];
      for (const end of ends) {
        for (const pattern of step[end]) {
          if (pattern === "*" || pattern.startsWith("_")) continue;
          const key = `${step.name}:${end}:${pattern}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // A closed entry (status done, retired, dropped…) needs no alignment;
          // the doctrine says set status rather than archive, so honour it here.
          const closed = closedStatuses(facets(pattern));
          const rows = entriesLacking(db, pattern, end, step.name)
            .filter((row) => isOpen(row, closed))
            .filter((row) => !exempt.has(`${pattern}/${row.id}`));
          if (rows.length === 0) continue;
          gaps.push({
            chain: chain.name, relation: step.name, end, pattern, total: rows.length,
            entries: rows.slice(0, LIST_CAP).map((row) => brief(pattern, row, facets(pattern), timezone)),
          });
        }
      }
    }
  }
  return gaps;
}

// === Hooks ===

function reviewHooks(db: any, pattern: string | null, clock: LocalClock, dayEndHour: number, timezone: string): HookStatus[] {
  const day = clock.date;
  const monday = addDays(day, -(clock.weekday - 1));
  const monthStart = iso(clock.year, clock.month, 1);
  const afterDayEnd = clock.hour >= dayEndHour;
  const period: Record<HookKind, string> = {
    "day-start": day, "day-end": day,
    "week-start": monday, "week-end": monday,
    "month-start": monthStart, "month-end": monthStart,
  };
  const open: Record<HookKind, boolean> = {
    "day-start": true,
    "day-end": afterDayEnd,
    "week-start": true,
    "week-end": clock.weekday > 5 || (clock.weekday === 5 && afterDayEnd),
    "month-start": true,
    "month-end": clock.day > daysInMonth(clock.year, clock.month) - MONTH_END_DAYS,
  };
  return HOOKS.map((kind) => {
    let last: HookStatus["last"] = null;
    if (pattern) {
      try {
        const r = db.exec(
          `SELECT id, period FROM ${quoteIdent(pattern)} WHERE archived_at IS NULL AND kind = ? ORDER BY period DESC, id DESC LIMIT 1`,
          kind,
        ).toArray() as any[];
        if (r[0]) last = { id: r[0].id as number, period: localDay(r[0].period, timezone) ?? "" };
      } catch { /* pattern mid-rebuild */ }
    }
    const covered = last != null && last.period === period[kind];
    return { kind, period: period[kind], due: pattern != null && open[kind] && !covered, last };
  });
}

// === The review ===

function describe(review: Omit<Review, "message">): string | null {
  const parts: string[] = [];
  if (review.hooks.due.length > 0) {
    const due = review.hooks.due;
    const list = due.length > 1 ? `${due.slice(0, -1).join(", ")} and ${due[due.length - 1]}` : due[0];
    parts.push(`${list} review${due.length > 1 ? "s" : ""} due`);
  }
  const totals = { overdue: 0, due_today: 0, due_this_week: 0, stalled: 0 };
  for (const w of review.work) {
    totals.overdue += w.totals.overdue;
    totals.due_today += w.totals.due_today;
    totals.due_this_week += w.totals.due_this_week;
    totals.stalled += w.totals.stalled;
  }
  const work: string[] = [];
  if (totals.overdue) work.push(`${totals.overdue} overdue`);
  if (totals.due_today) work.push(`${totals.due_today} due today`);
  if (totals.due_this_week) work.push(`${totals.due_this_week} due this week`);
  if (totals.stalled) work.push(`${totals.stalled} stalled`);
  if (work.length) parts.push(work.join(", "));
  for (const g of review.alignment) {
    parts.push(g.end === "source"
      ? `${g.total} ${g.pattern} without ${g.relation}`
      : `${g.total} ${g.pattern} without inbound ${g.relation}`);
  }
  for (const w of review.work) {
    if (!w.closed_declared) parts.push(`${w.pattern}.status declares no closed values, so every entry counts as open (set_options with closed)`);
  }
  if (parts.length === 0) return null;
  return `Review: ${parts.join("; ")}.`;
}

export function computeReview(ctx: ReviewContext): Review {
  const now = ctx.now ?? new Date();
  const { clock, timezone } = localClock(now, charterValue(ctx.db, "timezone") ?? "UTC");
  const endHourRaw = charterValue(ctx.db, "review_day_end_hour");
  const endHour = endHourRaw == null || endHourRaw.trim() === "" ? NaN : Number(endHourRaw);
  const dayEndHour = Number.isInteger(endHour) && endHour >= 0 && endHour <= 23 ? endHour : DEFAULT_DAY_END_HOUR;
  const weekEnd = addDays(clock.date, 7 - clock.weekday);

  const facetCache = new Map<string, FacetRow[]>();
  let reviewsPattern: string | null = null;
  const work: WorkReview[] = [];
  for (const pattern of userPatterns(ctx.db)) {
    const facets = facetsOf(ctx.db, pattern);
    facetCache.set(pattern, facets);
    if (reviewsPattern == null && isReviewsPattern(facets)) reviewsPattern = pattern;
    if (isWorkPattern(facets)) work.push(reviewWork(ctx.db, pattern, facets, clock.date, weekEnd, now, timezone));
  }

  const status = reviewHooks(ctx.db, reviewsPattern, clock, dayEndHour, timezone);
  const partial: Omit<Review, "message"> = {
    as_of: clock.date,
    timezone,
    hooks: {
      pattern: reviewsPattern,
      due: status.filter((h) => h.due).map((h) => h.kind),
      status,
      ...(reviewsPattern == null ? { declare: reviewsDeclaration() } : {}),
    },
    work,
    alignment: reviewAlignment(ctx.db, facetCache, timezone),
  };
  return { ...partial, message: describe(partial) };
}

export function getReview(ctx: ReviewContext): string {
  return JSON.stringify(computeReview(ctx), null, 2);
}

/** The short form that rides briefings: the one-line message and the due hooks. */
export function reviewSummary(ctx: ReviewContext): { message: string; due_hooks: HookKind[]; uri: string } | null {
  const r = computeReview(ctx);
  if (!r.message) return null;
  return { message: r.message, due_hooks: r.hooks.due, uri: uri("review") };
}
