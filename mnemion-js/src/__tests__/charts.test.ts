import { describe, it, expect } from "vitest";
import {
  pivotSeries, seriesColor, isChartMark, CHART_MARKS, compactNum,
  resolveChart, chartQuery, groupKey, aggSpec, isRound, isContinuous, isStackable, SERIES_NONE,
} from "../../shared/core/chart-spec";
import { renderChartSvg, chartOgSvg, type ChartPayload } from "../../shared/core/chart-svg";

// The chart palette is pure (no DO/env): unit-test the pivot + both renderers
// directly. The renderers must produce well-formed SVG for every mark, single-
// and multi-series, without throwing.

describe("chart-spec", () => {
  it("knows the mark set incl. pie/donut", () => {
    expect([...CHART_MARKS]).toEqual(["bar", "line", "area", "scatter", "pie", "donut"]);
    expect(isChartMark("donut")).toBe(true);
    expect(isChartMark("treemap")).toBe(false);
  });
  it("cycles series colors deterministically", () => {
    expect(seriesColor(0)).toBe(seriesColor(10)); // 10 colors → wraps
    expect(seriesColor(0)).not.toBe(seriesColor(1));
  });
  it("formats compact numbers", () => {
    expect(compactNum(132368)).toBe("132K");
    expect(compactNum(950)).toBe("950");
  });

  it("pivots long rows into per-series columns, 0-filling gaps, preserving x order", () => {
    const long = [
      { year: "2017", platform: "twitter", value: 30 },
      { year: "2025", platform: "bluesky", value: 8 },
      { year: "2025", platform: "threads", value: 6 },
      // 2025 has no twitter row → must 0-fill so stacks/lines don't tear
    ];
    const { rows, keys } = pivotSeries(long, "year", "platform");
    expect(keys).toEqual(["twitter", "bluesky", "threads"]); // first-seen order
    expect(rows.map((r) => r.year)).toEqual(["2017", "2025"]); // x order preserved
    expect(rows[1]).toMatchObject({ year: "2025", bluesky: 8, threads: 6, twitter: 0 });
  });
});

const single: ChartPayload = { multi: false, data: [
  { label: "2022", value: 132368 }, { label: "2023", value: 14800 }, { label: "2025", value: 18000 },
] };
const multi: ChartPayload = { multi: true, data: {
  xKey: "year",
  keys: ["twitter", "bluesky", "threads"],
  rows: [
    { year: "2022", twitter: 132368, bluesky: 0, threads: 0 },
    { year: "2025", twitter: 3200, bluesky: 8700, threads: 6100 },
    { year: "2026", twitter: 0, bluesky: 1800, threads: 2400 },
  ],
} };

describe("renderChartSvg", () => {
  for (const mark of ["bar", "line", "area", "scatter"]) {
    it(`renders a single-series ${mark}`, () => {
      const svg = renderChartSvg(mark, single);
      expect(svg).toMatch(/^<svg /);
      expect(svg).toContain("</svg>");
    });
  }
  for (const mark of ["bar", "line", "area"]) {
    it(`renders a grouped multi-series ${mark} with a legend`, () => {
      const svg = renderChartSvg(mark, multi);
      expect(svg).toMatch(/^<svg /);
      // legend swatch for each series color
      expect(svg).toContain(seriesColor(0));
      expect(svg).toContain(seriesColor(2));
      expect(svg).toContain("threads"); // legend label
    });
    it(`renders a stacked ${mark === "line" ? "area" : mark}`, () => {
      const svg = renderChartSvg(mark === "line" ? "area" : mark, multi, { stack: true });
      expect(svg).toMatch(/^<svg /);
    });
  }
  for (const mark of ["pie", "donut"]) {
    it(`renders a ${mark} with slices + percent labels`, () => {
      const svg = renderChartSvg(mark, single);
      expect(svg).toContain("<path"); // arcs
      expect(svg).toContain("%"); // percent labels on big slices
    });
    it(`collapses a multi-series payload into ${mark} slices`, () => {
      const svg = renderChartSvg(mark, multi);
      expect(svg).toMatch(/^<svg /);
      expect(svg).toContain("<path");
    });
  }
  it("does not throw on empty data", () => {
    expect(() => renderChartSvg("bar", { multi: false, data: [] })).not.toThrow();
    expect(() => renderChartSvg("pie", { multi: true, data: { xKey: "x", keys: [], rows: [] } })).not.toThrow();
  });
});

describe("chartOgSvg", () => {
  it("renders a 1200x630 card for a single-series chart", () => {
    const svg = chartOgSvg("Engagement by year", "line", single);
    expect(svg).toContain('width="1200" height="630"');
    expect(svg).toContain("Engagement"); // wrapped title
  });
  it("renders a 1200x630 card for a stacked multi-series chart", () => {
    const svg = chartOgSvg("I didn't leave Twitter — my audience did", "area", multi, true);
    expect(svg).toContain('width="1200" height="630"');
    expect(svg).toContain(seriesColor(1));
  });
});

// === regression guards for the review fixes ===

describe("renderChartSvg — totality (every mark renders)", () => {
  // The self-enforcing guard: a mark in CHART_MARKS that no renderer handles would
  // silently fall to a bar. Assert every mark produces a real <svg>, never throws.
  for (const mark of CHART_MARKS) {
    it(`${mark} renders without falling through`, () => {
      const svg = renderChartSvg(mark, single);
      expect(svg).toMatch(/^<svg /);
      expect(svg).toContain("</svg>");
    });
  }
});

describe("stacking actually changes the y-domain", () => {
  // Two series of 10 each on one x: grouped y-max is the max single cell (10);
  // stacked y-max is the per-x SUM (20). The axis labels prove which happened.
  const p: ChartPayload = { multi: true, data: {
    xKey: "x", keys: ["a", "b"], rows: [{ x: "one", a: 10, b: 10 }],
  } };
  it("grouped bar tops out at the max single value, not the sum", () => {
    const svg = renderChartSvg("bar", p); // not stacked
    expect(svg).toContain(">10</text>"); // y-axis max gridline = 10
    expect(svg).not.toContain(">20</text>");
  });
  it("stacked bar tops out at the per-x sum", () => {
    const svg = renderChartSvg("bar", p, { stack: true });
    expect(svg).toContain(">20</text>"); // y-axis max gridline = 20 (10+10)
  });
  it("stacked area tops out at the per-x sum", () => {
    const svg = renderChartSvg("area", p, { stack: true });
    expect(svg).toContain(">20</text>");
  });
});

describe("non-stacked multi-series area is filled (matches the client)", () => {
  it("fills the bands instead of drawing bare lines", () => {
    const svg = renderChartSvg("area", multi); // stack defaults to false
    expect(svg).toContain("fill-opacity"); // a fill is present, not fill=none only
  });
});

describe("pie/donut single dominant slice renders a real shape (not a blank arc)", () => {
  const one: ChartPayload = { multi: false, data: [{ label: "only", value: 100 }] };
  it("pie draws a full circle for a 100% slice", () => {
    const svg = renderChartSvg("pie", one);
    expect(svg).toContain("<circle"); // not a degenerate zero-length arc
    expect(svg).toContain("100%");
  });
  it("donut draws a ring for a 100% slice", () => {
    const svg = renderChartSvg("donut", one);
    expect(svg).toContain("<circle");
  });
});

describe("pivotSeries buckets a NULL/empty series instead of dropping the value", () => {
  it("names empty series SERIES_NONE and keeps its value", () => {
    // post-aggregation, each (x, series) pair is unique; an unset series facet
    // arrives as "" or null and must bucket under SERIES_NONE, never be dropped.
    const long = [
      { year: "2024", platform: "", value: 50 },                       // empty
      { year: "2025", platform: null as unknown as string, value: 20 }, // null
    ];
    const { rows, keys } = pivotSeries(long, "year", "platform");
    expect(keys).toEqual([SERIES_NONE]);
    expect(rows).toEqual([{ year: "2024", [SERIES_NONE]: 50 }, { year: "2025", [SERIES_NONE]: 20 }]);
  });
});

describe("foundation: resolveChart / chartQuery / groupKey", () => {
  it("resolves x|group_by, y|metric aliases and defaults", () => {
    expect(resolveChart({ group_by: "year", metric: "faves" })).toMatchObject({ mark: "bar", x: "year", y: "faves", agg: "sum" });
    expect(resolveChart({ x: "year" })).toMatchObject({ agg: "count" }); // no y → count
  });
  it("splits a :unit bucket: full field for GROUP BY, bare for read/sort", () => {
    expect(groupKey("created_at:month")).toBe("created_at");
    const rc = resolveChart({ mark: "line", x: "created_at:month", y: "n" });
    expect(rc.groupBy).toBe("created_at:month"); // GROUP BY keeps the unit
    expect(rc.x).toBe("created_at"); // sort/read use the bare alias
    const q = chartQuery(rc);
    expect(q.group_by).toBe("created_at:month");
    expect(q.sort).toBe("created_at"); // bare — the bucket-bug fix
  });
  it("series query groups by x AND series (full), sorts by bare x", () => {
    const q = chartQuery(resolveChart({ mark: "area", x: "year", series: "platform", y: "n", stack: true }));
    expect(q.kind).toBe("series");
    expect(q.group_by).toBe("year,platform");
    expect(q.sort).toBe("year");
  });
  it("ranks bar/slice aggregates by -value, line/area by x", () => {
    expect(chartQuery(resolveChart({ mark: "bar", x: "y" })).sort).toBe("-value");
    expect(chartQuery(resolveChart({ mark: "pie", x: "y" })).sort).toBe("-value");
    expect(chartQuery(resolveChart({ mark: "line", x: "y" })).sort).toBe("y");
  });
  it("aggSpec builds the wire shape; mark-category helpers agree with the sets", () => {
    expect(aggSpec("sum", "faves")).toBe('[{"fn":"sum","facet":"faves","as":"value"}]');
    expect(aggSpec("count", undefined)).toBe('[{"fn":"count","as":"value"}]');
    expect(isRound("donut") && isContinuous("line") && isStackable("area")).toBe(true);
    expect(isStackable("line") || isRound("bar")).toBe(false);
  });
});
