// The SERVER renderer for a chart spec: pure SVG string, no DOM, no deps. Same
// spec as the in-hive Recharts renderer (mark/x/y) — this one produces static SVG
// for published pages and OG cards. bar | line | area.

export interface Datum { label: string; value: number }
export interface ChartSvgOpts { width?: number; height?: number; accent?: string; bare?: boolean; labelSize?: number }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function compactNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "K";
  return String(Math.round(n));
}

export function chartToSvg(mark: string, data: Datum[], opts: ChartSvgOpts = {}): string {
  const W = opts.width ?? 720, H = opts.height ?? 340;
  const accent = opts.accent ?? "#cf4a1a", ink3 = "#8b867b", grid = "#dcd8cd";
  // Margins + label size scale together, so the chart reads at both an in-hive
  // size (~720) and a big OG card (~1100) without tiny labels.
  const ls = opts.labelSize ?? 11;
  const m = { top: Math.round(ls * 1.3), right: Math.round(ls * 1.7), bottom: Math.round(ls * 2.6), left: Math.round(ls * 4.7) };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
  const max = Math.max(1, ...data.map((d) => d.value));
  const baseline = m.top + ph;
  const y = (v: number) => m.top + ph - (v / max) * ph;
  const n = Math.max(1, data.length);
  const band = pw / n;
  const cx = (i: number) => m.left + band * (i + 0.5);
  const font = "font-family:'Spline Sans Mono',ui-monospace,monospace";

  const gridSvg = [0, max / 2, max].map((t) => {
    const yy = y(t).toFixed(1);
    return `<line x1="${m.left}" y1="${yy}" x2="${m.left + pw}" y2="${yy}" stroke="${grid}"/>`
      + `<text x="${m.left - 8}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end" fill="${ink3}" font-size="${ls}" style="${font}">${compactNum(t)}</text>`;
  }).join("");

  const xLabels = data.map((d, i) => `<text x="${cx(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" fill="${ink3}" font-size="${ls}" style="${font}">${esc(d.label)}</text>`).join("");

  const sw = Math.max(2, ls * 0.23).toFixed(1);
  const dot = Math.max(2.5, ls * 0.28).toFixed(1);
  let series = "";
  if (mark === "line" || mark === "area") {
    const pts = data.map((d, i) => `${cx(i).toFixed(1)},${y(d.value).toFixed(1)}`);
    const path = "M" + pts.join(" L");
    if (mark === "area") series += `<path d="${path} L${cx(n - 1).toFixed(1)},${baseline.toFixed(1)} L${cx(0).toFixed(1)},${baseline.toFixed(1)} Z" fill="${accent}" fill-opacity="0.12"/>`;
    series += `<path d="${path}" fill="none" stroke="${accent}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/>`;
    series += data.map((d, i) => `<circle cx="${cx(i).toFixed(1)}" cy="${y(d.value).toFixed(1)}" r="${dot}" fill="${accent}"/>`).join("");
  } else {
    const pad = band * 0.22;
    const bw = Math.min(band - 2 * pad, 56);
    series = data.map((d, i) => {
      const yy = y(d.value);
      return `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, baseline - yy).toFixed(1)}" rx="3" fill="${accent}"/>`;
    }).join("");
  }

  const inner = `${gridSvg}${series}${xLabels}`;
  if (opts.bare) return inner; // caller wraps in its own <svg>
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
export function chartOgSvg(title: string, mark: string, data: Datum[]): string {
  const W = 1200, H = 630, pad = 64, footer = 64;
  const lines = wrapText(title, 28).slice(0, 2);
  const ts = lines.length > 1 ? 48 : 56;
  const lead = ts * 1.08;
  const top = pad + ts * 0.82;
  const titleSvg = lines.map((ln, i) =>
    `<text x="${pad}" y="${(top + i * lead).toFixed(0)}" fill="#1b1a16" font-size="${ts}" font-weight="700" font-family="'Hanken Grotesk',system-ui,-apple-system,sans-serif">${esc(ln)}</text>`
  ).join("");
  const chartTop = Math.round(top + (lines.length - 1) * lead + 40);
  const cw = W - pad * 2, ch = H - chartTop - footer;
  const chart = chartToSvg(mark, data, { width: cw, height: ch, bare: true, labelSize: 19 });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect width="${W}" height="${H}" fill="#f1efe8"/>`
    + titleSvg
    + `<g transform="translate(${pad},${chartTop})">${chart}</g>`
    + `<text x="${pad}" y="${H - 28}" fill="#8b867b" font-size="22" font-family="'Spline Sans Mono',ui-monospace,monospace">mnemion</text>`
    + `</svg>`;
}
