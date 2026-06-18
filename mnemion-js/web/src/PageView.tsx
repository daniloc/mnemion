import { useState, useEffect } from 'react';
import { ChartView, type ViewSpec } from './views';

// Renders a page (a _pages entry): a grid of blocks, each a declarative reference
// to data interpreted against a fixed renderer set — never code. Slice 1 covers
// the self-fetching blocks (heading/text/metric/chart); embeds (view/entry/list)
// land next.

export interface Page { name: string; path: string; title?: string; blocks?: string }
interface Block { type: string; width?: string; [k: string]: unknown }

function parseBlocks(page: Page): Block[] {
  if (!page.blocks) return [];
  try { const b = JSON.parse(page.blocks); return Array.isArray(b) ? b : []; } catch { return []; }
}

export function PageView({ page }: { page: Page }) {
  const blocks = parseBlocks(page);
  if (blocks.length === 0) return <div className="status">This page has no blocks yet.</div>;
  return (
    <div className="page-grid">
      {blocks.map((b, i) => (
        <div className={`page-block w-${b.width || 'full'}`} key={i}>
          <BlockRenderer block={b} />
        </div>
      ))}
    </div>
  );
}

function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading': return <h2 className="block-heading">{String(block.text ?? '')}</h2>;
    case 'text': return <p className="block-text">{String(block.text ?? '')}</p>;
    case 'metric': return <MetricBlock block={block} />;
    case 'chart': return <ChartBlock block={block} />;
    default: return <div className="block-todo">embedded “{block.type}” block — coming next</div>;
  }
}

const nf = new Intl.NumberFormat();

function MetricBlock({ block }: { block: Block }) {
  const pattern = String(block.pattern || '');
  const metric = block.metric ? String(block.metric) : undefined;
  const agg = String(block.agg || (metric ? 'sum' : 'count'));
  const [val, setVal] = useState<number | null>(null);
  useEffect(() => {
    if (!pattern) return;
    const aggregate = JSON.stringify([{ fn: agg, ...(metric ? { facet: metric } : {}), as: 'value' }]);
    let live = true;
    fetch(`/api/query/${pattern}?aggregate=${encodeURIComponent(aggregate)}`)
      .then((r) => r.json()).then((d) => { if (live) setVal(Number((d.rows || [])[0]?.value ?? 0)); })
      .catch(() => { if (live) setVal(null); });
    return () => { live = false; };
  }, [pattern, metric, agg]);
  return (
    <div className="metric">
      <div className="metric-num">{val === null ? '—' : nf.format(val)}</div>
      <div className="metric-label">{String(block.label || `${agg}${metric ? ' ' + metric : ''} · ${pattern}`)}</div>
    </div>
  );
}

function ChartBlock({ block }: { block: Block }) {
  const pattern = String(block.pattern || '');
  const view: ViewSpec = {
    pattern, name: 'block', view_type: 'chart',
    config: JSON.stringify({ group_by: block.group_by, metric: block.metric, agg: block.agg }),
  };
  return (
    <div className="block-card">
      <ChartView pattern={pattern} facets={[]} view={view} />
    </div>
  );
}
