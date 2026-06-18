import { useState, useEffect } from 'react';
import { ChartView, StackView, EntryCard, COMPONENTS, type Facet, type ViewSpec } from './views';
import { isViewType } from '../../shared/core/view-palette';
import { store } from './store';

// Renders a page (a _pages entry): a grid of blocks, each a declarative reference
// to data interpreted against a fixed renderer set — never code. Self-fetching
// blocks (heading/text/metric/chart) and embeds (view/entry/list) compose any
// pattern or entry into a dashboard.

export interface Page { name: string; path: string; title?: string; blocks?: string }
interface PatternMeta { name: string; facets: Facet[] }
interface Block { type: string; width?: string; [k: string]: unknown }

function parseBlocks(page: Page): Block[] {
  if (!page.blocks) return [];
  try { const b = JSON.parse(page.blocks); return Array.isArray(b) ? b : []; } catch { return []; }
}

export function PageView({ page, patterns, views }: { page: Page; patterns: PatternMeta[]; views: ViewSpec[] }) {
  const blocks = parseBlocks(page);
  if (blocks.length === 0) return <div className="status">This page has no blocks yet.</div>;
  return (
    <div className="page-grid">
      {blocks.map((b, i) => (
        <div className={`page-block w-${b.width || 'full'}`} key={i}>
          <BlockRenderer block={b} patterns={patterns} views={views} />
        </div>
      ))}
    </div>
  );
}

function BlockRenderer({ block, patterns, views }: { block: Block; patterns: PatternMeta[]; views: ViewSpec[] }) {
  switch (block.type) {
    case 'heading': return <h2 className="block-heading">{String(block.text ?? '')}</h2>;
    case 'text': return <p className="block-text">{String(block.text ?? '')}</p>;
    case 'metric': return <MetricBlock block={block} />;
    case 'chart': return <ChartBlock block={block} />;
    case 'view': return <ViewBlock block={block} patterns={patterns} views={views} />;
    case 'entry': return <EntryBlock block={block} patterns={patterns} />;
    case 'list': return <ListBlock block={block} patterns={patterns} />;
    default: return <div className="block-todo">unknown block: {block.type}</div>;
  }
}

const nf = new Intl.NumberFormat();
const facetsOf = (patterns: PatternMeta[], name: string): Facet[] => patterns.find((p) => p.name === name)?.facets ?? [];

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
  // pass every chart key (mark/x/y/agg/title/caption…) through as the view config.
  const { type: _t, width: _w, pattern: _p, ...cfg } = block;
  const view: ViewSpec = { pattern, name: 'block', view_type: 'chart', config: JSON.stringify(cfg) };
  return <div className="block-card"><ChartView pattern={pattern} facets={[]} view={view} /></div>;
}

// Embed a pattern rendered as one of its views. Loads the pattern's entries into
// the shared store (so the embedded view — and its live updates — just work).
function ViewBlock({ block, patterns, views }: { block: Block; patterns: PatternMeta[]; views: ViewSpec[] }) {
  const pattern = String(block.pattern || '');
  const facets = facetsOf(patterns, pattern);
  useEffect(() => {
    let live = true;
    fetch(`/api/query/${pattern}`).then((r) => r.json()).then((d) => { if (live) store.load(pattern, d.entries || []); }).catch(() => {});
    return () => { live = false; };
  }, [pattern]);
  // Explicit view_type+config on the block, else the pattern's own default view.
  let view: ViewSpec;
  if (block.view_type) {
    const { type: _t, width: _w, pattern: _p, view_type: _vt, ...cfg } = block;
    view = { pattern, name: 'block', view_type: String(block.view_type), config: JSON.stringify(cfg) };
  } else {
    view = views.find((v) => v.pattern === pattern && v.name === 'default')
      ?? views.find((v) => v.pattern === pattern)
      ?? { pattern, name: 'block', view_type: 'cards', config: '{}' };
  }
  const Comp = isViewType(view.view_type) ? COMPONENTS[view.view_type] : StackView;
  return <div className="block-embed"><Comp pattern={pattern} facets={facets} view={view} /></div>;
}

function EntryBlock({ block, patterns }: { block: Block; patterns: PatternMeta[] }) {
  const pattern = String(block.pattern || '');
  const id = Number(block.id);
  return <div className="block-card"><EntryCard pattern={pattern} id={id} facets={facetsOf(patterns, pattern)} /></div>;
}

// A filtered slice — self-contained (own fetch, not the shared store, so it can't
// clash with a `view` block on the same pattern). Rows open the entry on click.
function ListBlock({ block, patterns }: { block: Block; patterns: PatternMeta[] }) {
  const pattern = String(block.pattern || '');
  const facets = facetsOf(patterns, pattern);
  const filter = block.filter ? String(block.filter) : '';
  const limit = Number(block.limit) || 10;
  const [entries, setEntries] = useState<Record<string, unknown>[] | null>(null);
  useEffect(() => {
    const f = filter ? `&filter=${encodeURIComponent(filter)}` : '';
    let live = true;
    fetch(`/api/query/${pattern}?limit=${limit}${f}`).then((r) => r.json()).then((d) => { if (live) setEntries(d.entries || []); }).catch(() => { if (live) setEntries([]); });
    return () => { live = false; };
  }, [pattern, filter, limit]);
  const titleFacet = facets.find((f) => f.type === 'text')?.name;
  if (!entries) return <div className="block-card status">loading…</div>;
  if (entries.length === 0) return <div className="block-card status">Nothing matches.</div>;
  return (
    <div className="block-card">
      <ul className="block-list">
        {entries.map((e) => {
          const id = Number(e.id);
          return (
            <li key={id} className="block-list-row" onClick={() => window.dispatchEvent(new CustomEvent('mnemion:open-entry', { detail: { pattern, id } }))}>
              {titleFacet ? String(e[titleFacet] ?? `#${id}`) : `#${id}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
