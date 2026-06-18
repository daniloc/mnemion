// The SERVER renderer for a chart spec: pure SVG string, no DOM, no deps. Same
// spec as the in-hive Recharts renderer (mark/x/y) — this one produces static SVG
// for published pages and OG cards. bar | line | area.

export interface Datum { label: string; value: number }
export interface ChartSvgOpts { width?: number; height?: number; accent?: string; bare?: boolean }

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
  const m = { top: 14, right: 18, bottom: 28, left: 52 };
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
      + `<text x="${m.left - 8}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end" fill="${ink3}" font-size="11" style="${font}">${compactNum(t)}</text>`;
  }).join("");

  const xLabels = data.map((d, i) => `<text x="${cx(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" fill="${ink3}" font-size="11" style="${font}">${esc(d.label)}</text>`).join("");

  let series = "";
  if (mark === "line" || mark === "area") {
    const pts = data.map((d, i) => `${cx(i).toFixed(1)},${y(d.value).toFixed(1)}`);
    const path = "M" + pts.join(" L");
    if (mark === "area") series += `<path d="${path} L${cx(n - 1).toFixed(1)},${baseline.toFixed(1)} L${cx(0).toFixed(1)},${baseline.toFixed(1)} Z" fill="${accent}" fill-opacity="0.12"/>`;
    series += `<path d="${path}" fill="none" stroke="${accent}" stroke-width="2.5"/>`;
    series += data.map((d, i) => `<circle cx="${cx(i).toFixed(1)}" cy="${y(d.value).toFixed(1)}" r="3" fill="${accent}"/>`).join("");
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

// A standalone OG card: title + the chart, at social dimensions (1200×630).
export function chartOgSvg(title: string, mark: string, data: Datum[]): string {
  const W = 1200, H = 630;
  const t = esc(title).slice(0, 90);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect width="${W}" height="${H}" fill="#f1efe8"/>`
    + `<text x="60" y="100" fill="#1b1a16" font-size="46" font-weight="650" font-family="'Hanken Grotesk',system-ui,sans-serif">${t}</text>`
    + `<g transform="translate(60,150)">${chartToSvg(mark, data, { width: W - 120, height: H - 250 })}</g>`
    + `<text x="60" y="${H - 36}" fill="#8b867b" font-size="22" font-family="'Spline Sans Mono',ui-monospace,monospace">mnemion</text>`
    + `</svg>`;
}
