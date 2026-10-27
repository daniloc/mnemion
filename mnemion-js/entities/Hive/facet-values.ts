// facet-values.ts — what a facet's value IS, as one coercion every write path
// uses. A leaf: it reads no database and imports nothing of the hive, so the
// write chokepoint (data.ts, reached only through hive.ts) and the schema
// engine (evolution.ts, which seeds a default on every create) coerce a value
// the same way without either reaching into the other.
//
// Each validator coerces to the canonical stored form or reports why it can't.
// This is shape-checking, not truth-adjudication: it never blocks a memory on
// semantic grounds, so it sits beside the never-blocks doctrine.

export type Coerce = { ok: true; value: unknown } | { ok: false; error: string };

// A finite number from a number, or from a NON-EMPTY numeric string — never via
// Number("")/Number("  ")/Number([]) which all coerce to 0 and would silently write 0
// for an empty/blank/array value (corrupting sums and defeating required-field checks).
const toFiniteNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export const FACET_VALIDATORS: Record<string, (v: unknown) => Coerce> = {
  text: (v) => ({ ok: true, value: typeof v === "string" ? v : String(v) }),
  number: (v) => {
    const n = toFiniteNumber(v);
    return n !== null ? { ok: true, value: n } : { ok: false, error: `expected a number, got ${JSON.stringify(v)}` };
  },
  integer: (v) => {
    const n = toFiniteNumber(v);
    return n !== null && Number.isInteger(n) ? { ok: true, value: n } : { ok: false, error: `expected an integer, got ${JSON.stringify(v)}` };
  },
  boolean: (v) => {
    if (typeof v === "boolean") return { ok: true, value: v ? 1 : 0 };
    if (v === 1 || v === 0) return { ok: true, value: v };
    if (v === "true" || v === "1") return { ok: true, value: 1 };
    if (v === "false" || v === "0") return { ok: true, value: 0 };
    return { ok: false, error: `expected a boolean, got ${JSON.stringify(v)}` };
  },
  // Canonical ISO 8601 so SQL comparison and ordering are always right: a
  // date-only input (no time of day, whatever its written form) is stored as
  // YYYY-MM-DD; anything else parseable as a full UTC timestamp. Only an
  // unambiguous calendar day or a full timestamp is a date (owner ruling,
  // df-79a5e65f): periods ("2026", "2026-03", "March 2026"), impossible days
  // ("2026-02-30", which Date.parse would roll into March) and relative phrases
  // are refused — resolving a period to a day is the writer's job.
  datetime: (v) => {
    if (typeof v !== "string" && typeof v !== "number") return { ok: false, error: `expected a full date (a calendar day or a timestamp)` };
    const s = typeof v === "string" ? v.trim() : v;
    if (typeof s === "string") {
      if (PERIOD_RES.some((re) => re.test(s)))
        return { ok: false, error: `expected a full date (a calendar day like 2026-03-07, or a full timestamp), got ${JSON.stringify(v)} — that is a period; resolving it to a day is the writer's job` };
      const stated = statedDay(s);
      if (stated && !isRealDay(stated.y, stated.m, stated.d))
        return { ok: false, error: `expected a full date that exists on the calendar, got ${JSON.stringify(v)} — there is no such day` };
    }
    const t = typeof s === "number" ? s : Date.parse(s);
    if (Number.isNaN(t)) return { ok: false, error: `expected a full date (a calendar day like 2026-03-07, or a full ISO 8601 timestamp), got ${JSON.stringify(v)}` };
    return { ok: true, value: canonicalDatetime(s, t) };
  },
  select: (v) => ({ ok: true, value: v }), // option membership is checked separately
};

/** What a write path knows about the facet it writes: its type, and for a
 *  datetime its declared resolution. */
export interface FacetShape { type: string; resolution?: string }

/** Coerce one value to a facet's canonical stored form, or say why it can't
 *  be — the single coercion every write path uses (mutate and clipboard
 *  submissions here; the upload path in hive.consumeUpload). Types without a
 *  validator pass through unchanged. A datetime facet declared `resolution:
 *  "day"` holds calendar days only: a canonical value with a time of day is
 *  refused here, inside the one coercion, so no caller can forget the rule and
 *  no reader ever has an instant to convert. */
export function coerceFacetValue(facet: FacetShape, value: unknown): Coerce {
  const coerce = FACET_VALIDATORS[facet.type];
  const r: Coerce = coerce ? coerce(value) : { ok: true, value };
  if (!r.ok || facet.type !== "datetime" || facet.resolution !== "day") return r;
  if (typeof r.value === "string" && !r.value.includes("T")) return r;
  return { ok: false, error: `this facet holds calendar days (resolution: day); give YYYY-MM-DD, not a time of day (${JSON.stringify(r.value)})` };
}

/** A year, or a year and month — periods, not days. */
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_NAME = `(?:${MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join("|")})\\.?`;
const PERIOD_RES = [
  /^\d{4}$/,                                    // 2026
  /^\d{4}[-/.]\d{1,2}$/,                        // 2026-03, 2026/03
  /^\d{1,2}[-/.]\d{4}$/,                        // 03/2026
  new RegExp(`^${MONTH_NAME},?\\s+\\d{4}$`, "i"),   // March 2026
  new RegExp(`^\\d{4}\\s+${MONTH_NAME}$`, "i"),     // 2026 March
];

/** The year, month and day the writer STATED, when the form states one — so an
 *  impossible day is refused instead of silently rolled over by Date.parse. */
function statedDay(s: string): { y: number; m: number; d: number } | null {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(new RegExp(`^(${MONTH_NAME})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"));
  if (m) return { y: +m[3], m: monthIndex(m[1]), d: +m[2] };
  m = s.match(new RegExp(`^(\\d{1,2})\\s+(${MONTH_NAME}),?\\s+(\\d{4})`, "i"));
  if (m) return { y: +m[3], m: monthIndex(m[2]), d: +m[1] };
  return null;
}

function monthIndex(name: string): number {
  const k = name.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(k)) + 1;
}

function isRealDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return m >= 1 && m <= 12 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY_RE = /\d{1,2}:\d{2}|T\d/;

function canonicalDatetime(v: string | number, t: number): string {
  if (typeof v === "number" || TIME_OF_DAY_RE.test(v)) return new Date(t).toISOString();
  if (ISO_DATE_RE.test(v.trim())) return new Date(t).toISOString().slice(0, 10); // parsed as UTC midnight
  // Other date-only forms ("March 7, 2026") parse as LOCAL midnight: read the local date.
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
