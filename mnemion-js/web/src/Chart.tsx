import { ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

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
  const axis = { stroke: C.ink3, tick: { fill: C.ink3, fontSize: 11, fontFamily: MONO } as const, tickLine: false } as const;
  const margin = { top: 8, right: 14, bottom: 4, left: 2 };
  const grid = <CartesianGrid stroke={C.line} vertical={false} />;
  const xa = <XAxis dataKey={x} {...axis} axisLine={{ stroke: C.line }} />;
  const ya = <YAxis {...axis} axisLine={false} tickFormatter={compact} width={42} />;
  const tip = <Tooltip cursor={{ fill: 'rgba(27,26,22,0.04)' }} content={<Tip />} />;

  let chart;
  if (mark === 'line') {
    chart = (
      <LineChart data={data} margin={margin}>{grid}{xa}{ya}{tip}
        <Line type="monotone" dataKey="value" stroke={C.accent} strokeWidth={2.5} dot={{ r: 3, fill: C.accent, strokeWidth: 0 }} activeDot={{ r: 4.5 }} isAnimationActive={false} />
      </LineChart>
    );
  } else if (mark === 'area') {
    chart = (
      <AreaChart data={data} margin={margin}>{grid}{xa}{ya}{tip}
        <Area type="monotone" dataKey="value" stroke={C.accent} strokeWidth={2} fill={C.accent} fillOpacity={0.12} isAnimationActive={false} />
      </AreaChart>
    );
  } else {
    chart = (
      <BarChart data={data} margin={margin}>{grid}{xa}{ya}{tip}
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
