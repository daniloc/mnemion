import { memo, useRef } from 'react';
import * as Select from '@radix-ui/react-select';
import { useEntry, usePatternEntries, type Entry } from './store';

export interface Facet { name: string; type: string; options?: string[]; }
export interface ViewSpec { pattern: string; name: string; view_type: string; config: string | null; }
export interface ViewConfig { group_by?: string; title?: string; columns?: string[]; fields?: string[]; }

const KERNEL_COLS = new Set(['id', 'version', 'created_at', 'updated_at', 'archived_at', 'created_by', 'updated_by']);

export function parseConfig(v?: ViewSpec | null): ViewConfig {
  if (!v?.config) return {};
  try { return JSON.parse(v.config) as ViewConfig; } catch { return {}; }
}

function valueOf(entry: Entry, facet: Facet): string {
  const raw = entry[facet.name];
  if (raw === null || raw === undefined || raw === '') return '';
  return String(raw);
}

async function patchFacet(pattern: string, id: number, facet: string, value: string) {
  // The write echoes back over the live socket as a granular delta — the same
  // surgical path an agent's MCP change takes. No optimistic update needed.
  await fetch(`/api/mutate/${pattern}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'update', data: { id, [facet]: value } }),
  });
}

// --- a tiny dev affordance: how many times THIS card has rendered. Proves the
// surgical update — flip one entry and only its counter ticks. ---
function useRenderCount(): number {
  const n = useRef(0);
  n.current += 1;
  return n.current;
}

// === Board ===
export function BoardView({ pattern, facets, view }: { pattern: string; facets: Facet[]; view: ViewSpec }) {
  const entries = usePatternEntries(pattern);
  const cfg = parseConfig(view);
  const groupBy = cfg.group_by;
  if (!groupBy) return <StackView pattern={pattern} facets={facets} />;

  const seen = new Set<string>();
  for (const e of entries) seen.add(String(e[groupBy] ?? ''));
  const columns = cfg.columns?.length
    ? cfg.columns.concat([...seen].filter((s) => !cfg.columns!.includes(s)))
    : [...seen].sort();

  const byCol = new Map<string, number[]>();
  for (const col of columns) byCol.set(col, []);
  for (const e of entries) {
    const col = String(e[groupBy] ?? '');
    (byCol.get(col) ?? byCol.set(col, []).get(col)!).push(e.id);
  }

  return (
    <div className="board">
      {columns.map((col) => (
        <div className="board-col" key={col || '—'}>
          <div className="board-col-head">
            <span className="board-col-name">{col || 'none'}</span>
            <span className="board-col-count">{byCol.get(col)?.length ?? 0}</span>
          </div>
          <div className="board-col-body">
            {(byCol.get(col) ?? []).map((id) => (
              <BoardCard key={id} pattern={pattern} id={id} facets={facets} cfg={cfg} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const BoardCard = memo(function BoardCard({ pattern, id, facets, cfg }: { pattern: string; id: number; facets: Facet[]; cfg: ViewConfig }) {
  const entry = useEntry(pattern, id);
  const renders = useRenderCount();
  if (!entry) return null;
  const titleFacet = cfg.title ?? facets.find((f) => f.type === 'text')?.name;
  const title = titleFacet ? valueOf(entry, { name: titleFacet, type: 'text' }) : `#${id}`;
  const groupFacet = facets.find((f) => f.name === cfg.group_by);
  const others = facets.filter((f) => !KERNEL_COLS.has(f.name) && f.name !== titleFacet && f.name !== cfg.group_by && valueOf(entry, f));

  return (
    <article className="card">
      <div className="card-title">{title || `#${id}`}</div>
      {others.slice(0, 3).map((f) => (
        <div className="card-field" key={f.name}>
          <span className="card-field-name">{f.name}</span>
          <span className="card-field-value">{valueOf(entry, f)}</span>
        </div>
      ))}
      <footer className="card-foot">
        {cfg.group_by && (
          <StatusSelect
            value={String(entry[cfg.group_by] ?? '')}
            options={groupFacet?.options ?? (cfg.columns ?? [])}
            onChange={(v) => patchFacet(pattern, id, cfg.group_by!, v)}
          />
        )}
        <span className="card-id">#{id}</span>
        <span className="redraws" title="renders of this card (surgical update proof)">r{renders}</span>
      </footer>
    </article>
  );
});

// === default Stack (notebook blocks) ===
export function StackView({ pattern, facets }: { pattern: string; facets: Facet[] }) {
  const entries = usePatternEntries(pattern);
  if (entries.length === 0) return <div className="status">No entries yet.</div>;
  return (
    <div className="stack">
      {entries.map((e, i) => (
        <StackBlock key={e.id} pattern={pattern} id={e.id} facets={facets} i={Math.min(i, 12)} />
      ))}
    </div>
  );
}

const StackBlock = memo(function StackBlock({ pattern, id, facets, i }: { pattern: string; id: number; facets: Facet[]; i: number }) {
  const entry = useEntry(pattern, id);
  const renders = useRenderCount();
  if (!entry) return null;
  let leadTaken = false;
  const fields = facets
    .filter((f) => !KERNEL_COLS.has(f.name) && valueOf(entry, f))
    .map((f) => {
      const value = valueOf(entry, f);
      const lead = !leadTaken && f.type === 'text';
      if (lead) leadTaken = true;
      return { name: f.name, value, lead, long: value.length > 88 || value.includes('\n') };
    });
  return (
    <article className="block" style={{ ['--i' as any]: i }}>
      <div className="block-fields">
        {fields.map((f) => (
          <div className={`field${f.lead ? ' lead' : f.long ? ' long' : ' inline'}`} key={f.name}>
            <div className="field-name">{f.name}</div>
            <div className="field-value">{f.value}</div>
          </div>
        ))}
      </div>
      <footer className="block-meta">
        <span className="id">#{id}</span>
        {entry.created_by ? <span className="author">{String(entry.created_by)}</span> : null}
        <span className="redraws" title="renders of this block">r{renders}</span>
      </footer>
    </article>
  );
});

// === Radix Select — the first primitive of the component palette ===
function StatusSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const opts = options.length ? options : [value].filter(Boolean);
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className="status-pill" aria-label="status">
        <Select.Value placeholder="—" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="status-menu" position="popper" sideOffset={4}>
          <Select.Viewport>
            {opts.map((o) => (
              <Select.Item className="status-item" value={o} key={o}>
                <Select.ItemText>{o}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
