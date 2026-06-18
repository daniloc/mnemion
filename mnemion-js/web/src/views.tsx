import { memo, useRef, useState, type FC } from 'react';
import * as Select from '@radix-ui/react-select';
import * as Dialog from '@radix-ui/react-dialog';
import { store, useEntry, usePatternEntries, type Entry } from './store';
import type { ViewTypeId } from '../../shared/core/view-palette';

export interface Facet { name: string; type: string; options?: string[]; }
export interface ViewSpec { pattern: string; name: string; view_type: string; config: string | null; }
// Config keys across all view types (see VIEW_PALETTE). `columns` is facet names
// for table, arbitrary column values for board.
export interface ViewConfig {
  group_by?: string; title?: string; columns?: string[]; fields?: string[];
  subtitle?: string; secondary?: string; meta?: string; sort?: string;
}
// Every view component takes the same props; `view` is optional so the stack can
// also serve as the no-view fallback.
export interface ViewProps { pattern: string; facets: Facet[]; view?: ViewSpec | null; }

const KERNEL_COLS = new Set(['id', 'version', 'created_at', 'updated_at', 'archived_at', 'created_by', 'updated_by']);

export function parseConfig(v?: ViewSpec | null): ViewConfig {
  if (!v?.config) return {};
  try { return JSON.parse(v.config) as ViewConfig; } catch { return {}; }
}

function valueOf(entry: Entry, name: string): string {
  const raw = entry[name];
  if (raw === null || raw === undefined || raw === '') return '';
  return String(raw);
}

async function patchFacet(pattern: string, id: number, facet: string, value: string) {
  await fetch(`/api/mutate/${pattern}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'update', data: { id, [facet]: value } }),
  });
}

/** Move a card to a column: optimistic (instant) + the write echoes back over the
 *  live socket as a granular delta, which confirms it. */
function move(pattern: string, id: number, groupBy: string, col: string) {
  store.patchEntry(pattern, id, { [groupBy]: col });
  patchFacet(pattern, id, groupBy, col);
}

function useRenderCount(): number {
  const n = useRef(0);
  n.current += 1;
  return n.current;
}

// === Board ===
export function BoardView({ pattern, facets, view }: ViewProps) {
  const entries = usePatternEntries(pattern);
  const [openId, setOpenId] = useState<number | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
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
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col)!.push(e.id);
  }

  return (
    <>
      <div className="board">
        {columns.map((col) => (
          <div
            className={`board-col${dropCol === col ? ' drop' : ''}`}
            key={col || '—'}
            onDragOver={(e) => { e.preventDefault(); if (dropCol !== col) setDropCol(col); }}
            onDragLeave={() => setDropCol((c) => (c === col ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              setDropCol(null);
              const id = Number(e.dataTransfer.getData('text/plain'));
              if (id) move(pattern, id, groupBy, col);
            }}
          >
            <div className="board-col-head">
              <span className="board-col-name">{col || 'none'}</span>
              <span className="board-col-count">{byCol.get(col)?.length ?? 0}</span>
            </div>
            <div className="board-col-body">
              {(byCol.get(col) ?? []).map((id) => (
                <BoardCard key={id} pattern={pattern} id={id} facets={facets} cfg={cfg} onOpen={() => setOpenId(id)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <DetailDialog pattern={pattern} id={openId} facets={facets} cfg={cfg} onClose={() => setOpenId(null)} />
    </>
  );
}

const BoardCard = memo(function BoardCard({ pattern, id, facets, cfg, onOpen }: { pattern: string; id: number; facets: Facet[]; cfg: ViewConfig; onOpen: () => void }) {
  const entry = useEntry(pattern, id);
  const renders = useRenderCount();
  if (!entry) return null;
  const titleFacet = cfg.title ?? facets.find((f) => f.type === 'text')?.name;
  const title = titleFacet ? valueOf(entry, titleFacet) : `#${id}`;
  const groupFacet = facets.find((f) => f.name === cfg.group_by);
  const others = facets.filter((f) => !KERNEL_COLS.has(f.name) && f.name !== titleFacet && f.name !== cfg.group_by && valueOf(entry, f.name));

  return (
    <article
      className="card"
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(id)); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
    >
      <div className="card-title">{title || `#${id}`}</div>
      {others.slice(0, 3).map((f) => (
        <div className="card-field" key={f.name}>
          <span className="card-field-name">{f.name}</span>
          <span className="card-field-value">{valueOf(entry, f.name)}</span>
        </div>
      ))}
      <footer className="card-foot" onClick={(e) => e.stopPropagation()}>
        {cfg.group_by && (
          <StatusSelect
            value={String(entry[cfg.group_by] ?? '')}
            options={groupFacet?.options ?? (cfg.columns ?? [])}
            onChange={(v) => move(pattern, id, cfg.group_by!, v)}
          />
        )}
        <span className="card-id">#{id}</span>
        <span className="redraws" title="renders of this card (surgical update proof)">r{renders}</span>
      </footer>
    </article>
  );
});

// === Detail dialog (click a card to open) ===
function DetailDialog({ pattern, id, facets, cfg, onClose }: { pattern: string; id: number | null; facets: Facet[]; cfg: ViewConfig; onClose: () => void }) {
  return (
    <Dialog.Root open={id != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          {id != null && <DetailBody pattern={pattern} id={id} facets={facets} cfg={cfg} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DetailBody({ pattern, id, facets, cfg }: { pattern: string; id: number; facets: Facet[]; cfg: ViewConfig }) {
  const entry = useEntry(pattern, id);
  if (!entry) return null;
  const titleFacet = cfg.title ?? facets.find((f) => f.type === 'text')?.name;
  return (
    <>
      <Dialog.Title className="dialog-title">{(titleFacet && valueOf(entry, titleFacet)) || `${pattern} #${id}`}</Dialog.Title>
      <div className="dialog-fields">
        {facets.filter((f) => !KERNEL_COLS.has(f.name) && valueOf(entry, f.name)).map((f) => (
          <div className="field inline" key={f.name}>
            <div className="field-name">{f.name}</div>
            <div className="field-value">{valueOf(entry, f.name)}</div>
          </div>
        ))}
      </div>
      <footer className="dialog-foot">
        <span className="id">#{id}</span>
        {entry.updated_at ? <span>{valueOf(entry, 'updated_at')}</span> : null}
        <Dialog.Close className="dialog-close">close</Dialog.Close>
      </footer>
    </>
  );
}

// === Table (dense rows × facet columns) ===
export function TableView({ pattern, facets, view }: ViewProps) {
  const entries = usePatternEntries(pattern);
  const [openId, setOpenId] = useState<number | null>(null);
  const cfg = parseConfig(view);
  const userFacets = facets.filter((f) => !KERNEL_COLS.has(f.name));
  const titleFacet = cfg.title ?? userFacets.find((f) => f.type === 'text')?.name;
  // Columns: configured facet names (kept only if real), else all user facets,
  // with the title facet pulled to the front.
  const declared = cfg.columns?.length ? cfg.columns.filter((c) => facets.some((f) => f.name === c)) : userFacets.map((f) => f.name);
  const cols = titleFacet ? [titleFacet, ...declared.filter((c) => c !== titleFacet)] : declared;
  const rows = cfg.sort
    ? [...entries].sort((a, b) => valueOf(a, cfg.sort!).localeCompare(valueOf(b, cfg.sort!)))
    : entries;
  if (entries.length === 0) return <div className="status">No entries yet.</div>;
  return (
    <>
      <div className="table-wrap">
        <table className="dtable">
          <thead>
            <tr>
              <th className="dt-id">#</th>
              {cols.map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <TableRow key={e.id} pattern={pattern} id={e.id} cols={cols} onOpen={() => setOpenId(e.id)} />
            ))}
          </tbody>
        </table>
      </div>
      <DetailDialog pattern={pattern} id={openId} facets={facets} cfg={cfg} onClose={() => setOpenId(null)} />
    </>
  );
}

const TableRow = memo(function TableRow({ pattern, id, cols, onOpen }: { pattern: string; id: number; cols: string[]; onOpen: () => void }) {
  const entry = useEntry(pattern, id);
  const renders = useRenderCount();
  if (!entry) return null;
  return (
    <tr className="dt-row" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <td className="dt-id">#{id}<span className="redraws" title="renders of this row">r{renders}</span></td>
      {cols.map((c, i) => (
        <td key={c} className={i === 0 ? 'dt-lead' : undefined}>{valueOf(entry, c)}</td>
      ))}
    </tr>
  );
});

// === default Stack (notebook blocks) ===
export function StackView({ pattern, facets }: ViewProps) {
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
    .filter((f) => !KERNEL_COLS.has(f.name) && valueOf(entry, f.name))
    .map((f) => {
      const value = valueOf(entry, f.name);
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

// === Radix Select — the status control ===
function StatusSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const opts = options.length ? options : [value].filter(Boolean);
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className="status-pill" aria-label="status" onClick={(e) => e.stopPropagation()}>
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

// === The component palette ===
//
// One entry per view_type, keyed by the same ids as VIEW_PALETTE (the SSOT in
// shared/core/view-palette.ts). Typing this as Record<ViewTypeId, …> makes the
// compiler the totality check: add a view type to the palette and this won't
// compile until it has a component; remove one and the stray key won't compile.
// (cards/list are the interim stack until their real components land.)
export const COMPONENTS: Record<ViewTypeId, FC<ViewProps>> = {
  cards: StackView,
  board: BoardView,
  table: TableView,
  list: StackView,
};
