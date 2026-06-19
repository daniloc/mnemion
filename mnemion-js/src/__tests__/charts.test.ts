import { describe, it, expect } from "vitest";
import { pivotSeries, seriesColor, isChartMark, CHART_MARKS, compactNum } from "../../shared/core/chart-spec";
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
