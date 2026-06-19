import type { ReactElement } from 'react';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area, ScatterChart, Scatter, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { seriesColor, pivotSeries, compactNum, isRound, isContinuous, isStackable } from '../../shared/core/chart-spec';

// A chart is a declarative spec → a renderer. This is the in-hive (client)
// renderer, Recharts styled to the notebook aesthetic: one accent (or the shared
// categorical palette for multiple series/slices), no chartjunk, a title that
// carries the argument. The SAME spec + palette drive the server/OG SVG renderer
// (shared/core/chart-svg.ts) — the spec is the contract, the renderer is swappable.

export { CHART_MARKS } from '../../shared/core/chart-spec';
export interface ChartSpec {
  mark?: string; x?: string; y?: string; series?: string; stack?: boolean; agg?: string;
  title?: string; caption?: string;
}
type Row = Record<string, unknown>;

// Concrete colors (SVG presentation attrs don't reliably resolve CSS var()).
// Mirrors notebook.css; keep in sync.
// Chrome colors (ink/line) only — series fills come from the shared palette
// (seriesColor) so a 1-series and 2-series chart of the same data start identical.
const C = { ink: '#1b1a16', ink3: '#8b867b', line: '#dcd8cd' } as const;
const MONO = "'Spline Sans Mono', ui-monospace, monospace";
// Axis ticks use the shared compactNum so labels match the server SVG exactly.
const compact = (v: unknown) => compactNum(Number(v));
const full = (v: unknown) => new Intl.NumberFormat('en').format(Number(v));

function Tip({ active, payload, label }: { active?: boolean; payload?: { name?: string; value: number; color?: string }[]; label?: unknown }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart2-tip">
      <div className="chart2-tip-x">{String(label)}</div>
      {payload.map((p, i) => (
        <div className="chart2-tip-v" key={i}>
          {p.name && payload.length > 1 && <span style={{ color: p.color }}>{p.name}: </span>}
          {full(p.value)}
        </div>
      ))}
    </div>
  );
}

const legendStyle = { fontFamily: MONO, fontSize: 11, color: C.ink3 } as const;

export function Chart({ spec, data }: { spec: ChartSpec; data: Row[] }) {
  const x = spec.x || 'x';
  const mark = spec.mark || 'bar';
  const figure = (chart: ReactElement, h = 300) => (
    <figure className="chart2">
      {spec.title && <figcaption className="chart2-title">{spec.title}</figcaption>}
      <div className="chart2-canvas">
        <ResponsiveContainer width="100%" height={h}>{chart}</ResponsiveContainer>
      </div>
      {spec.caption && <figcaption className="chart2-caption">{spec.caption}</figcaption>}
    </figure>
  );

  // === Pie / donut — parts of a whole, no axes ===
  if (isRound(mark)) {
    const slices = data.map((d) => ({ name: String(d[x] ?? ''), value: Number(d.value) || 0 })).filter((d) => d.value > 0);
    return figure(
      <PieChart>
        <Tooltip content={<Tip />} />
        <Legend wrapperStyle={legendStyle} iconType="circle" />
        <Pie data={slices} dataKey="value" nameKey="name" innerRadius={mark === 'donut' ? '55%' : 0} outerRadius="80%" paddingAngle={1} isAnimationActive={false} stroke={C.line} strokeWidth={1}>
          {slices.map((s, i) => <Cell key={s.name} fill={seriesColor(i)} />)}
        </Pie>
      </PieChart>, 320,
    );
  }

  const axis = { stroke: C.ink3, tick: { fill: C.ink3, fontSize: 11, fontFamily: MONO } as const, tickLine: false } as const;
  const margin = { top: 8, right: 14, bottom: 4, left: 2 };
  const grid = <CartesianGrid stroke={C.line} vertical={false} />;
  const ya = <YAxis {...axis} axisLine={false} tickFormatter={compact} width={42} />;
  const tip = <Tooltip cursor={{ fill: 'rgba(27,26,22,0.04)' }} content={<Tip />} />;

  // line/area/scatter plot over a continuous axis; when x parses as numbers, use a
  // numeric x-axis so values space to scale (e.g. years), not equally.
  const continuous = isContinuous(mark);
  const sampleRows = data;
  const xNumeric = continuous && sampleRows.length > 0 && sampleRows.every((d) => isFinite(Number(d[x])));
  const numAxis = xNumeric ? { type: 'number' as const, domain: ['dataMin', 'dataMax'] as [string, string] } : {};
  const xa = <XAxis dataKey={x} {...numAxis} {...axis} axisLine={{ stroke: C.line }} />;

  // === Multi-series — pivot long rows [{x, series, value}] → wide + keys ===
  if (spec.series && (mark === 'bar' || mark === 'line' || mark === 'area')) {
    const { rows, keys } = pivotSeries(data, x, spec.series);
    const wide = xNumeric ? rows.map((r) => ({ ...r, [x]: Number(r[x]) })) : rows;
    // `stack` only applies to stackable marks (bar/area) — a stack:true on a line
    // is ignored, matching the server renderer.
    const stacked = isStackable(mark) && spec.stack;
    const legend = <Legend wrapperStyle={legendStyle} iconType="circle" />;
    if (mark === 'bar') {
      return figure(
        <BarChart data={wide} margin={margin}>{grid}{xa}{ya}{tip}{legend}
          {keys.map((k, i) => <Bar key={k} dataKey={k} stackId={stacked ? 's' : undefined} fill={seriesColor(i)} radius={stacked ? 0 : [2, 2, 0, 0]} maxBarSize={64} isAnimationActive={false} />)}
        </BarChart>);
    }
    if (mark === 'area') {
      return figure(
        <AreaChart data={wide} margin={margin}>{grid}{xa}{ya}{tip}{legend}
          {keys.map((k, i) => <Area key={k} dataKey={k} stackId={stacked ? 's' : undefined} stroke={seriesColor(i)} strokeWidth={2} fill={seriesColor(i)} fillOpacity={stacked ? 0.5 : 0.15} isAnimationActive={false} />)}
        </AreaChart>);
    }
    return figure(
      <LineChart data={wide} margin={margin}>{grid}{xa}{ya}{tip}{legend}
        {keys.map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={seriesColor(i)} strokeWidth={2.5} dot={{ r: 2.5, fill: seriesColor(i), strokeWidth: 0 }} activeDot={{ r: 4.5 }} isAnimationActive={false} />)}
      </LineChart>);
  }

  // === Single series === (first palette color, so 1-series and 2-series agree)
  const c0 = seriesColor(0);
  const rows = xNumeric ? data.map((d) => ({ ...d, [x]: Number(d[x]) })) : data;
  let chart: ReactElement;
  if (mark === 'scatter') {
    chart = (
      <ScatterChart margin={margin}>{grid}{xa}
        <YAxis dataKey="value" type="number" {...axis} axisLine={false} tickFormatter={compact} width={42} />
        {tip}
        <Scatter data={rows} dataKey="value" fill={c0} fillOpacity={0.65} isAnimationActive={false} />
      </ScatterChart>
    );
  } else if (mark === 'line') {
    chart = (
      <LineChart data={rows} margin={margin}>{grid}{xa}{ya}{tip}
        <Line type="monotone" dataKey="value" stroke={c0} strokeWidth={2.5} dot={{ r: 3, fill: c0, strokeWidth: 0 }} activeDot={{ r: 4.5 }} isAnimationActive={false} />
      </LineChart>
    );
  } else if (mark === 'area') {
    chart = (
      <AreaChart data={rows} margin={margin}>{grid}{xa}{ya}{tip}
        <Area type="monotone" dataKey="value" stroke={c0} strokeWidth={2} fill={c0} fillOpacity={0.12} isAnimationActive={false} />
      </AreaChart>
    );
  } else {
    chart = (
      <BarChart data={rows} margin={margin}>{grid}{xa}{ya}{tip}
        <Bar dataKey="value" fill={c0} radius={[3, 3, 0, 0]} maxBarSize={56} isAnimationActive={false} />
      </BarChart>
    );
  }
  return figure(chart);
}
