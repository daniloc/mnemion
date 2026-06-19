// The SERVER renderer for a chart spec: pure SVG string, no DOM, no deps. Same
// spec + palette as the in-hive Recharts renderer (web/src/Chart.tsx, both derive
// from chart-spec.ts) — this one produces static SVG for published pages and OG
// cards. Marks: bar | line | area | scatter | pie | donut, single- or multi-series
// (grouped/stacked), with a legend.

import { seriesColor, compactNum, ROUND_MARKS, isContinuous, isStackable } from "./chart-spec";
import { escapeXml } from "./escape";
export { compactNum } from "./chart-spec";

export interface Datum { label: string; value: number }
// Multi-series payload: wide rows (one per x) with one numeric column per series
// key, already pivoted (chart-spec.pivotSeries) and sorted by x.
export interface SeriesData { xKey: string; rows: Record<string, unknown>[]; keys: string[] }
export type ChartPayload =
  | { multi: false; data: Datum[] }
  | { multi: true; data: SeriesData };

export interface ChartSvgOpts { width?: number; height?: number; accent?: string; bare?: boolean; labelSize?: number; stack?: boolean }

const INK3 = "#8b867b", GRID = "#dcd8cd", PAPER = "#f1efe8";
const MONO = "font-family:'Spline Sans Mono',ui-monospace,monospace";

// === Unified entry: dispatch a payload to the right mark renderer ============
// `mark` selects the shape; `payload.multi` selects single vs grouped/stacked.
export function renderChartSvg(mark: string, payload: ChartPayload, opts: ChartSvgOpts = {}): string {
  if (ROUND_MARKS.has(mark)) {
    const data = payload.multi ? collapseToData(payload.data) : payload.data;
    return pieToSvg(data, mark === "donut", opts);
  }
  if (payload.multi && payload.data.keys.length > 0) return seriesToSvg(mark, payload.data, opts);
  return chartToSvg(mark, payload.multi ? collapseToData(payload.data) : payload.data, opts);
}

// A multi-series payload asked to render as pie/donut → sum each x across series.
function collapseToData(s: SeriesData): Datum[] {
  return s.rows.map((r) => ({
    label: String(r[s.xKey] ?? ""),
    value: s.keys.reduce((sum, k) => sum + (Number(r[k]) || 0), 0),
  }));
}

// === Single-series: bar | line | area | scatter ==============================
function chartToSvg(mark: string, data: Datum[], opts: ChartSvgOpts = {}): string {
  const W = opts.width ?? 720, H = opts.height ?? 340;
  const accent = opts.accent ?? "#cf4a1a";
  const ls = opts.labelSize ?? 11;
  const m = { top: Math.round(ls * 1.3), right: Math.round(ls * 1.7), bottom: Math.round(ls * 2.6), left: Math.round(ls * 4.7) };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
  const max = Math.max(1, ...data.map((d) => d.value));
  const baseline = m.top + ph;
  const y = (v: number) => m.top + ph - (v / max) * ph;
  const n = Math.max(1, data.length);
  const band = pw / n;
  const sw = Math.max(2, ls * 0.23).toFixed(1);
  const dot = Math.max(2.5, ls * 0.28).toFixed(1);

  // x positioning (shared with seriesToSvg): linear when x is numeric and the mark
  // is continuous (line/area/scatter); categorical band otherwise.
  const xs = data.map((d) => Number(d.label));
  const linearX = n > 1 && isContinuous(mark) && xs.every((v) => isFinite(v));
  const xPos = xScale(data.map((d) => d.label), isContinuous(mark), n, m.left, pw);

  const gridSvg = yGrid(max, m.left, pw, y, ls);

  const xLabels = (mark === "scatter" && linearX)
    ? [0, n - 1].map((i) => `<text x="${xPos(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" fill="${INK3}" font-size="${ls}" style="${MONO}">${compactNum(xs[i])}</text>`).join("")
    : data.map((d, i) => `<text x="${xPos(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" fill="${INK3}" font-size="${ls}" style="${MONO}">${escapeXml(d.label)}</text>`).join("");

  let series = "";
  if (mark === "scatter") {
    series = data.map((d, i) => `<circle cx="${xPos(i).toFixed(1)}" cy="${y(d.value).toFixed(1)}" r="${dot}" fill="${accent}" fill-opacity="0.65"/>`).join("");
  } else if (mark === "line" || mark === "area") {
    const pts = data.map((d, i) => `${xPos(i).toFixed(1)},${y(d.value).toFixed(1)}`);
    const path = "M" + pts.join(" L");
    if (mark === "area") series += `<path d="${path} L${xPos(n - 1).toFixed(1)},${baseline.toFixed(1)} L${xPos(0).toFixed(1)},${baseline.toFixed(1)} Z" fill="${accent}" fill-opacity="0.12"/>`;
    series += `<path d="${path}" fill="none" stroke="${accent}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>`;
    series += data.map((d, i) => `<circle cx="${xPos(i).toFixed(1)}" cy="${y(d.value).toFixed(1)}" r="${dot}" fill="${accent}"/>`).join("");
  } else {
    const pad = band * 0.22;
    const bw = Math.min(band - 2 * pad, 56);
    series = data.map((d, i) => {
      const yy = y(d.value);
      return `<rect x="${(xPos(i) - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, baseline - yy).toFixed(1)}" rx="3" fill="${accent}"/>`;
    }).join("");
  }

  const inner = `${gridSvg}${series}${xLabels}`;
  if (opts.bare) return inner;
  return wrapSvg(W, H, inner);
}

// === Multi-series: grouped/stacked bar, multi-line, stacked area =============
function seriesToSvg(mark: string, s: SeriesData, opts: ChartSvgOpts): string {
  const W = opts.width ?? 720, H = opts.height ?? 340;
  const ls = opts.labelSize ?? 11;
  const keys = s.keys;
  // legend lays out at the actual plot width (W minus horizontal margins) — the
  // same width legendHeight() reserves rows for, so they can't disagree.
  const legendW = W - Math.round(ls * 1.7) - Math.round(ls * 4.7);
  const legendH = legendHeight(keys.length, legendW, ls);
  const m = { top: Math.round(ls * 1.3), right: Math.round(ls * 1.7), bottom: Math.round(ls * 2.6) + legendH, left: Math.round(ls * 4.7) };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
  const n = Math.max(1, s.rows.length);
  const band = pw / n;
  const baseline = m.top + ph;
  const stack = !!opts.stack && isStackable(mark);
  const valAt = (r: Record<string, unknown>, k: string) => Number(r[k]) || 0;

  // y-max: stacked → per-x totals; grouped/line → max single cell.
  const max = Math.max(1, ...s.rows.map((r) => stack
    ? keys.reduce((sum, k) => sum + valAt(r, k), 0)
    : Math.max(...keys.map((k) => valAt(r, k)))));
  const y = (v: number) => m.top + ph - (v / max) * ph;
  const gridSvg = yGrid(max, m.left, pw, y, ls);

  // x positioning (shared with chartToSvg): continuous (line/area) over a numeric
  // x → linear spacing; else band centers.
  const center = xScale(s.rows.map((r) => String(r[s.xKey] ?? "")), isContinuous(mark), n, m.left, pw);

  const xLabels = s.rows.map((r, i) => `<text x="${center(i).toFixed(1)}" y="${m.top + ph + ls * 1.7}" text-anchor="middle" fill="${INK3}" font-size="${ls}" style="${MONO}">${escapeXml(String(r[s.xKey] ?? ""))}</text>`).join("");

  let series = "";
  if (mark === "bar") {
    const groupPad = band * 0.18;
    const inner = band - 2 * groupPad;
    if (stack) {
      const bw = Math.min(inner, 56);
      series = s.rows.map((r, i) => {
        let acc = 0;
        return keys.map((k, ki) => {
          const v = valAt(r, k); const y0 = y(acc); acc += v; const y1 = y(acc);
          return `<rect x="${(center(i) - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, y0 - y1).toFixed(1)}" fill="${seriesColor(ki)}"/>`;
        }).join("");
      }).join("");
    } else {
      const bw = Math.max(2, inner / keys.length);
      series = s.rows.map((r, i) => keys.map((k, ki) => {
        const v = valAt(r, k); const yy = y(v);
        const x0 = center(i) - inner / 2 + ki * bw;
        return `<rect x="${x0.toFixed(1)}" y="${yy.toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${Math.max(0, baseline - yy).toFixed(1)}" rx="2" fill="${seriesColor(ki)}"/>`;
      }).join("")).join("");
    }
  } else if (mark === "area" && stack) {
    // stacked bands, bottom-up: each layer's top is the running cumulative line.
    let lower = s.rows.map(() => 0);
    series = keys.map((k, ki) => {
      const upper = s.rows.map((r, i) => lower[i] + valAt(r, k));
      const top = upper.map((v, i) => `${center(i).toFixed(1)},${y(v).toFixed(1)}`);
      const bot = lower.map((v, i) => `${center(i).toFixed(1)},${y(v).toFixed(1)}`).reverse();
      const path = `M${top.join(" L")} L${bot.join(" L")} Z`;
      lower = upper;
      return `<path d="${path}" fill="${seriesColor(ki)}" fill-opacity="0.5"/>`;
    }).join("");
  } else if (mark === "area") {
    // non-stacked area: each series filled as a translucent band to baseline +
    // its stroked top edge + dots — matching the client (web/src/Chart.tsx).
    const sw = Math.max(2, ls * 0.22).toFixed(1);
    const dot = Math.max(2, ls * 0.24).toFixed(1);
    series = keys.map((k, ki) => {
      const col = seriesColor(ki);
      const pts = s.rows.map((r, i) => `${center(i).toFixed(1)},${y(valAt(r, k)).toFixed(1)}`);
      const line = "M" + pts.join(" L");
      const fill = `<path d="${line} L${center(n - 1).toFixed(1)},${baseline.toFixed(1)} L${center(0).toFixed(1)},${baseline.toFixed(1)} Z" fill="${col}" fill-opacity="0.15"/>`;
      const stroke = `<path d="${line}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>`;
      const dots = s.rows.map((r, i) => `<circle cx="${center(i).toFixed(1)}" cy="${y(valAt(r, k)).toFixed(1)}" r="${dot}" fill="${col}"/>`).join("");
      return `${fill}${stroke}${dots}`;
    }).join("");
  } else {
    // multi-line: overlaid stroked lines, one per series.
    const sw = Math.max(2, ls * 0.22).toFixed(1);
    const dot = Math.max(2, ls * 0.24).toFixed(1);
    series = keys.map((k, ki) => {
      const col = seriesColor(ki);
      const pts = s.rows.map((r, i) => `${center(i).toFixed(1)},${y(valAt(r, k)).toFixed(1)}`);
      const dots = s.rows.map((r, i) => `<circle cx="${center(i).toFixed(1)}" cy="${y(valAt(r, k)).toFixed(1)}" r="${dot}" fill="${col}"/>`).join("");
      return `<path d="M${pts.join(" L")}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    }).join("");
  }

  const legend = legendSvg(keys, m.left, H - legendH + Math.round(ls * 0.4), legendW, ls);
  const inner = `${gridSvg}${series}${xLabels}${legend}`;
  if (opts.bare) return inner;
  return wrapSvg(W, H, inner);
}

// === Pie / donut =============================================================
function pieToSvg(data: Datum[], donut: boolean, opts: ChartSvgOpts): string {
  const W = opts.width ?? 720, H = opts.height ?? 340;
  const ls = opts.labelSize ?? 11;
  const slices = data.filter((d) => d.value > 0);
  const total = slices.reduce((s, d) => s + d.value, 0) || 1;
  const legendW = W - Math.round(ls * 3);
  const legendH = legendHeight(slices.length, legendW, ls);
  const top = Math.round(ls * 0.8);
  const avail = H - top - legendH;
  const r = Math.max(10, Math.min(avail, W) / 2 - Math.round(ls * 0.6));
  const cx = W / 2, cy = top + avail / 2;
  const ri = donut ? r * 0.58 : 0;

  let a0 = 0;
  const arcs = slices.map((d, i) => {
    const a1 = a0 + (d.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number) => `${(cx + rad * Math.sin(ang)).toFixed(1)},${(cy - rad * Math.cos(ang)).toFixed(1)}`;
    const col = seriesColor(i);
    const frac = d.value / total;
    let shape: string;
    if (frac >= 0.999) {
      // a single surviving slice fills the whole circle: the arc's start and end
      // points coincide, so SVG drops the zero-length arc and renders nothing.
      // Render the real shape instead — a full circle (pie) or a punched annulus
      // (donut: outer disc with the inner radius cut out via a paper-filled disc).
      shape = donut
        ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${col}"/>`
          + `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${ri.toFixed(1)}" fill="${PAPER}"/>`
        : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${col}"/>`;
    } else {
      let path: string;
      if (donut) {
        path = `M${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, ri)} A${ri} ${ri} 0 ${large} 0 ${p(a0, ri)} Z`;
      } else {
        path = `M${cx.toFixed(1)},${cy.toFixed(1)} L${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} Z`;
      }
      shape = `<path d="${path}" fill="${col}"/>`;
    }
    // percent label on slices worth showing (a full-circle slice reads 100%)
    let label = "";
    if (frac >= 0.06) {
      const mid = (a0 + a1) / 2; const lr = donut ? (r + ri) / 2 : r * 0.62;
      label = `<text x="${(cx + lr * Math.sin(mid)).toFixed(1)}" y="${(cy - lr * Math.cos(mid) + ls * 0.35).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="${(ls * 0.95).toFixed(1)}" style="${MONO}">${Math.round(frac * 100)}%</text>`;
    }
    a0 = a1;
    return `${shape}${label}`;
  }).join("");

  const legend = legendSvg(slices.map((d) => d.label), Math.round(ls * 1.5), H - legendH + Math.round(ls * 0.4), legendW, ls);
  const inner = `${arcs}${legend}`;
  if (opts.bare) return inner;
  return wrapSvg(W, H, inner);
}

// === Shared bits =============================================================
// x positioning, shared by single- and multi-series: a linear scale when x parses
// as numbers and the mark plots over a continuous axis (line/area/scatter) — so
// years space to scale, not equally; a categorical band otherwise (bars,
// non-numeric x). Returns the position function `(i) => x-pixel`.
function xScale(labels: (string | number)[], continuous: boolean, n: number, left: number, pw: number): (i: number) => number {
  const band = pw / n;
  const xs = labels.map((l) => Number(l));
  const linearX = n > 1 && continuous && xs.every((v) => isFinite(v));
  if (!linearX) return (i: number) => left + band * (i + 0.5);
  const xmin = Math.min(...xs), xspan = (Math.max(...xs) - xmin) || 1;
  return (i: number) => left + ((xs[i] - xmin) / xspan) * pw;
}

function yGrid(max: number, left: number, pw: number, y: (v: number) => number, ls: number): string {
  return [0, max / 2, max].map((t) => {
    const yy = y(t).toFixed(1);
    return `<line x1="${left}" y1="${yy}" x2="${left + pw}" y2="${yy}" stroke="${GRID}"/>`
      + `<text x="${left - 8}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end" fill="${INK3}" font-size="${ls}" style="${MONO}">${compactNum(t)}</text>`;
  }).join("");
}

// Legend: wrapped rows of swatch + label. Height is estimated the same way in
// legendHeight() so the chart reserves exactly the room the legend needs.
function legendItemsPerRow(W: number, ls: number): number {
  return Math.max(1, Math.floor(W / (ls * 9)));
}
function legendHeight(count: number, W: number, ls: number): number {
  if (count <= 1) return 0;
  const rows = Math.ceil(count / legendItemsPerRow(W, ls));
  return Math.round(rows * ls * 1.7 + ls * 0.6);
}
function legendSvg(labels: string[], x0: number, y0: number, W: number, ls: number): string {
  if (labels.length <= 1) return "";
  const per = legendItemsPerRow(W, ls);
  const colW = W / per;
  const sw = Math.round(ls * 0.85);
  return labels.map((lab, i) => {
    const col = i % per, row = Math.floor(i / per);
    const x = x0 + col * colW, y = y0 + row * Math.round(ls * 1.7);
    const txt = lab.length > 14 ? lab.slice(0, 13) + "…" : lab;
    return `<rect x="${x.toFixed(1)}" y="${(y - sw + 1).toFixed(1)}" width="${sw}" height="${sw}" rx="2" fill="${seriesColor(i)}"/>`
      + `<text x="${(x + sw + 5).toFixed(1)}" y="${(y + 1).toFixed(1)}" fill="${INK3}" font-size="${ls}" style="${MONO}">${escapeXml(txt)}</text>`;
  }).join("");
}

function wrapSvg(W: number, H: number, inner: string): string {
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img">${inner}</svg>`;
}

// Word-wrap a string to lines of at most `maxChars` (greedy, by word).
function wrapText(s: string, maxChars: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/)) {
    const next = cur ? cur + " " + w : w;
    if (next.length > maxChars && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// A standalone OG card: wrapped title + the chart, at social dimensions
// (1200×630). The chart is rendered at the card's exact pixel size (with larger
// labels) and placed with a plain translate — no nested-svg scaling, which not
// every SVG renderer handles the same way.
export function chartOgSvg(title: string, mark: string, payload: ChartPayload, stack = false): string {
  const W = 1200, H = 630, pad = 64, footer = 64;
  const lines = wrapText(title, 28).slice(0, 2);
  const ts = lines.length > 1 ? 48 : 56;
  const lead = ts * 1.08;
  const top = pad + ts * 0.82;
  const titleSvg = lines.map((ln, i) =>
    `<text x="${pad}" y="${(top + i * lead).toFixed(0)}" fill="#1b1a16" font-size="${ts}" font-weight="700" font-family="'Hanken Grotesk',system-ui,-apple-system,sans-serif">${escapeXml(ln)}</text>`
  ).join("");
  const chartTop = Math.round(top + (lines.length - 1) * lead + 40);
  const cw = W - pad * 2, ch = H - chartTop - footer;
  const chart = renderChartSvg(mark, payload, { width: cw, height: ch, bare: true, labelSize: 19, stack });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect width="${W}" height="${H}" fill="${PAPER}"/>`
    + titleSvg
    + `<g transform="translate(${pad},${chartTop})">${chart}</g>`
    + `<text x="${pad}" y="${H - 28}" fill="${INK3}" font-size="22" font-family="'Spline Sans Mono',ui-monospace,monospace">mnemion</text>`
    + `</svg>`;
}
