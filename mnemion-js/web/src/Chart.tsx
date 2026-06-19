import { ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

// A chart is a declarative spec → a renderer. This is the in-hive (client)
// renderer, Recharts styled to the notebook aesthetic: one accent, no chartjunk,
// a title that carries the argument. The SAME spec drives any future server/OG
// renderer — the spec is the contract, the renderer is swappable.

export const CHART_MARKS = ['bar', 'line', 'area'] as const;
export interface ChartSpec {
  mark?: string; x?: string; y?: string; series?: string; agg?: string;
  title?: string; caption?: string;
}
type Row = Record<string, unknown>;

// Concrete colors (SVG presentation attrs don't reliably resolve CSS var()).
// Mirrors notebook.css; keep in sync.
const C = { accent: '#cf4a1a', ink: '#1b1a16', ink3: '#8b867b', line: '#dcd8cd' };
const MONO = "'Spline Sans Mono', ui-monospace, monospace";
const compact = (v: unknown) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(v));
const full = (v: unknown) => new Intl.NumberFormat('en').format(Number(v));

function Tip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: unknown }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart2-tip">
      <div className="chart2-tip-x">{String(label)}</div>
      <div className="chart2-tip-v">{full(payload[0].value)}</div>
    </div>
  );
}

export function Chart({ spec, data }: { spec: ChartSpec; data: Row[] }) {
  const x = spec.x || 'x';
  const mark = spec.mark || 'bar';
  // line/area/scatter plot over a continuous axis; when x parses as numbers, use a
  // numeric x-axis so values space to scale (e.g. years), not equally.
  const continuous = mark === 'line' || mark === 'area' || mark === 'scatter';
  const xNumeric = continuous && data.length > 0 && data.every((d) => isFinite(Number((d as Record<string, unknown>)[x])));
  const rows = xNumeric ? data.map((d) => ({ ...d, [x]: Number((d as Record<string, unknown>)[x]) })) : data;
  const axis = { stroke: C.ink3, tick: { fill: C.ink3, fontSize: 11, fontFamily: MONO } as const, tickLine: false } as const;
  const margin = { top: 8, right: 14, bottom: 4, left: 2 };
  const grid = <CartesianGrid stroke={C.line} vertical={false} />;
  const xa = <XAxis dataKey={x} {...(xNumeric ? { type: 'number' as const, domain: ['dataMin', 'dataMax'] as [string, string] } : {})} {...axis} axisLine={{ stroke: C.line }} />;
  const ya = <YAxis {...axis} axisLine={false} tickFormatter={compact} width={42} />;
  const tip = <Tooltip cursor={{ fill: 'rgba(27,26,22,0.04)' }} content={<Tip />} />;

  let chart;
  if (mark === 'scatter') {
    chart = (
      <ScatterChart margin={margin}>{grid}{xa}
        <YAxis dataKey="value" type="number" {...axis} axisLine={false} tickFormatter={compact} width={42} />
        {tip}
        <Scatter data={rows} dataKey="value" fill={C.accent} fillOpacity={0.65} isAnimationActive={false} />
      </ScatterChart>
    );
  } else if (mark === 'line') {
    chart = (
      <LineChart data={rows} margin={margin}>{grid}{xa}{ya}{tip}
        <Line type="monotone" dataKey="value" stroke={C.accent} strokeWidth={2.5} dot={{ r: 3, fill: C.accent, strokeWidth: 0 }} activeDot={{ r: 4.5 }} isAnimationActive={false} />
      </LineChart>
    );
  } else if (mark === 'area') {
    chart = (
      <AreaChart data={rows} margin={margin}>{grid}{xa}{ya}{tip}
        <Area type="monotone" dataKey="value" stroke={C.accent} strokeWidth={2} fill={C.accent} fillOpacity={0.12} isAnimationActive={false} />
      </AreaChart>
    );
  } else {
    chart = (
      <BarChart data={rows} margin={margin}>{grid}{xa}{ya}{tip}
        <Bar dataKey="value" fill={C.accent} radius={[3, 3, 0, 0]} maxBarSize={56} isAnimationActive={false} />
      </BarChart>
    );
  }

  return (
    <figure className="chart2">
      {spec.title && <figcaption className="chart2-title">{spec.title}</figcaption>}
      <div className="chart2-canvas">
        <ResponsiveContainer width="100%" height={300}>{chart}</ResponsiveContainer>
      </div>
      {spec.caption && <figcaption className="chart2-caption">{spec.caption}</figcaption>}
    </figure>
  );
}
