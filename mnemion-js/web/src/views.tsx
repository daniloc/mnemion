import { memo, useRef, useState, useEffect, type FC } from 'react';
import * as Select from '@radix-ui/react-select';
import * as Dialog from '@radix-ui/react-dialog';
import { store, useEntry, usePatternEntries, type Entry } from './store';
import type { ViewTypeId } from '../../shared/core/view-palette';
import { resolveFormat } from '../../shared/core/format-palette';
import { FacetValue } from './FacetValue';
import { Chart } from './Chart';

export interface Facet { name: string; type: string; options?: string[]; format?: string; links?: string; }
export interface ViewSpec { pattern: string; name: string; view_type: string; config: string | null; }
// Config keys across all view types (see VIEW_PALETTE). `columns` is facet names
// for table, arbitrary column values for board. `formats` is the universal
// per-facet value-render override (facet name → format id).
export interface ViewConfig {
  group_by?: string; title?: string; columns?: string[]; fields?: string[];
  subtitle?: string; secondary?: string; meta?: string; sort?: string;
  metric?: string; agg?: string;
  mark?: string; x?: string; y?: string; series?: string; stack?: boolean; caption?: string;
  formats?: Record<string, string>;
  hide?: string[];
}
// Every view component takes the same props; `view` is optional so the stack can
// also serve as the no-view fallback.
export interface ViewProps { pattern: string; facets: Facet[]; view?: ViewSpec | null; }

const KERNEL_COLS = new Set(['id', 'version', 'created_at', 'updated_at', 'archived_at', 'created_by', 'updated_by']);

export function parseConfig(v?: ViewSpec | null): ViewConfig {
  if (!v?.config) return {};
  try { return JSON.parse(v.config) as ViewConfig; } catch { return {}; }
}

// Facet name → section heading: "why_it_works" → "Why it works". Documents read
// as prose, so a section gets a humanized heading, not a raw mono field tag.
function humanize(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// A column renders/sorts as a number when its resolved format is `number`
// (integer/number facets get it by default; any facet can opt in via format).
function isNumericCol(facets: Facet[], cfg: ViewConfig, name: string): boolean {
  const f = facets.find((x) => x.name === name);
  return resolveFormat(cfg.formats?.[name], f?.format, f?.type, !!f?.links) === 'number';
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
  const hide = new Set(cfg.hide ?? []);
  return (
    <>
      <Dialog.Title className="dialog-title">{(titleFacet && valueOf(entry, titleFacet)) || `${pattern} #${id}`}</Dialog.Title>
      <div className="dialog-fields">
        {facets.filter((f) => !KERNEL_COLS.has(f.name) && f.name !== titleFacet && !hide.has(f.name) && valueOf(entry, f.name)).map((f) => (
          <div className="field inline" key={f.name}>
            <div className="field-name">{f.name}</div>
            <div className="field-value"><FacetValue value={valueOf(entry, f.name)} type={f.type} facetFormat={f.format} viewFormat={cfg.formats?.[f.name]} pattern={pattern} id={id} facet={f.name} options={f.options} linksTo={f.links} /></div>
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
  const hide = new Set(cfg.hide ?? []);
  const declared = cfg.columns?.length ? cfg.columns.filter((c) => facets.some((f) => f.name === c)) : userFacets.map((f) => f.name);
  const cols = (titleFacet ? [titleFacet, ...declared.filter((c) => c !== titleFacet)] : declared).filter((c) => !hide.has(c));
  // sort: "facet" ascending, "-facet" descending; numeric facets compare as
  // numbers, not lexically (so 132368 outranks 99).
  const sortKey = cfg.sort?.replace(/^-/, '');
  const sortDesc = cfg.sort?.startsWith('-') ?? false;
  const sortNum = sortKey ? isNumericCol(facets, cfg, sortKey) : false;
  const rows = sortKey
    ? [...entries].sort((a, b) => {
        const av = valueOf(a, sortKey), bv = valueOf(b, sortKey);
        const cmp = sortNum ? (Number(av) || 0) - (Number(bv) || 0) : av.localeCompare(bv);
        return sortDesc ? -cmp : cmp;
      })
    : entries;
  if (entries.length === 0) return <div className="status">No entries yet.</div>;
  return (
    <>
      <div className="table-wrap">
        <table className="dtable">
          <thead>
            <tr>
              <th className="dt-id">#</th>
              {cols.map((c) => <th key={c} className={isNumericCol(facets, cfg, c) ? 'dt-num' : undefined}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <TableRow key={e.id} pattern={pattern} id={e.id} cols={cols} facets={facets} cfg={cfg} onOpen={() => setOpenId(e.id)} />
            ))}
          </tbody>
        </table>
      </div>
      <DetailDialog pattern={pattern} id={openId} facets={facets} cfg={cfg} onClose={() => setOpenId(null)} />
    </>
  );
}

const TableRow = memo(function TableRow({ pattern, id, cols, facets, cfg, onOpen }: { pattern: string; id: number; cols: string[]; facets: Facet[]; cfg: ViewConfig; onOpen: () => void }) {
  const entry = useEntry(pattern, id);
  const renders = useRenderCount();
  if (!entry) return null;
  return (
    <tr className="dt-row" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <td className="dt-id">#{id}<span className="redraws" title="renders of this row">r{renders}</span></td>
      {cols.map((c, i) => {
        const f = facets.find((x) => x.name === c);
        const cls = [i === 0 ? 'dt-lead' : '', isNumericCol(facets, cfg, c) ? 'dt-num' : ''].filter(Boolean).join(' ') || undefined;
        return (
          <td key={c} className={cls}>
            <FacetValue value={valueOf(entry, c)} type={f?.type} facetFormat={f?.format} viewFormat={cfg.formats?.[c]} pattern={pattern} id={id} facet={c} options={f?.options} linksTo={f?.links} />
          </td>
        );
      })}
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
      return { name: f.name, value, lead, long: value.length > 88 || value.includes('\n'), type: f.type, format: f.format, options: f.options, links: f.links };
    });
  return (
    <article className="block" style={{ ['--i' as any]: i }}>
      <div className="block-fields">
        {fields.map((f) => (
          <div className={`field${f.lead ? ' lead' : f.long ? ' long' : ' inline'}`} key={f.name}>
            <div className="field-name">{f.name}</div>
            <div className="field-value"><FacetValue value={f.value} type={f.type} facetFormat={f.format} pattern={pattern} id={id} facet={f.name} options={f.options} linksTo={f.links} /></div>
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

// === Cards (responsive grid; the default) ===
export function CardsView({ pattern, facets, view }: ViewProps) {
  const entries = usePatternEntries(pattern);
  const [openId, setOpenId] = useState<number | null>(null);
  const cfg = parseConfig(view);
  if (entries.length === 0) return <div className="status">No entries yet.</div>;
  return (
    <>
      <div className="cards-grid">
        {entries.map((e) => (
          <GridCard key={e.id} pattern={pattern} id={e.id} facets={facets} cfg={cfg} onOpen={() => setOpenId(e.id)} />
        ))}
      </div>
      <DetailDialog pattern={pattern} id={openId} facets={facets} cfg={cfg} onClose={() => setOpenId(null)} />
    </>
  );
}

const GridCard = memo(function GridCard({ pattern, id, facets, cfg, onOpen }: { pattern: string; id: number; facets: Facet[]; cfg: ViewConfig; onOpen: () => void }) {
  const entry = useEntry(pattern, id);
  const renders = useRenderCount();
  if (!entry) return null;
  const titleFacet = cfg.title ?? facets.find((f) => f.type === 'text')?.name;
  const title = titleFacet ? valueOf(entry, titleFacet) : `#${id}`;
  const subtitle = cfg.subtitle ? valueOf(entry, cfg.subtitle) : '';
  const hide = new Set(cfg.hide ?? []);
  const fieldNames = cfg.fields?.length
    ? cfg.fields
    : facets.filter((f) => !KERNEL_COLS.has(f.name) && f.name !== titleFacet && f.name !== cfg.subtitle).map((f) => f.name);
  const shown = fieldNames.filter((n) => !hide.has(n) && valueOf(entry, n));
  return (
    <article className="card gcard" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <div className="card-title">{title || `#${id}`}</div>
      {subtitle && <div className="gcard-sub">{subtitle}</div>}
      {shown.slice(0, 4).map((n) => {
        const f = facets.find((x) => x.name === n);
        return (
          <div className="card-field" key={n}>
            <span className="card-field-name">{n}</span>
            <span className="card-field-value"><FacetValue value={valueOf(entry, n)} type={f?.type} facetFormat={f?.format} viewFormat={cfg.formats?.[n]} pattern={pattern} id={id} facet={n} options={f?.options} linksTo={f?.links} /></span>
          </div>
        );
      })}
      <footer className="card-foot">
        <span className="card-id">#{id}</span>
        <span className="redraws" title="renders of this card">r{renders}</span>
      </footer>
    </article>
  );
});

// === List (compact one-line rows) ===
export function ListView({ pattern, facets, view }: ViewProps) {
  const entries = usePatternEntries(pattern);
  const [openId, setOpenId] = useState<number | null>(null);
  const cfg = parseConfig(view);
  if (entries.length === 0) return <div className="status">No entries yet.</div>;
  return (
    <>
      <div className="list">
        {entries.map((e) => (
          <ListRow key={e.id} pattern={pattern} id={e.id} facets={facets} cfg={cfg} onOpen={() => setOpenId(e.id)} />
        ))}
      </div>
      <DetailDialog pattern={pattern} id={openId} facets={facets} cfg={cfg} onClose={() => setOpenId(null)} />
    </>
  );
}

const ListRow = memo(function ListRow({ pattern, id, facets, cfg, onOpen }: { pattern: string; id: number; facets: Facet[]; cfg: ViewConfig; onOpen: () => void }) {
  const entry = useEntry(pattern, id);
  const renders = useRenderCount();
  if (!entry) return null;
  const titleFacet = cfg.title ?? facets.find((f) => f.type === 'text')?.name;
  const primary = titleFacet ? valueOf(entry, titleFacet) : `#${id}`;
  const secFacet = cfg.secondary ? facets.find((f) => f.name === cfg.secondary) : undefined;
  const metaFacet = cfg.meta ? facets.find((f) => f.name === cfg.meta) : undefined;
  const secondary = cfg.secondary ? valueOf(entry, cfg.secondary) : '';
  const meta = cfg.meta ? valueOf(entry, cfg.meta) : '';
  return (
    <div className="list-row" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <span className="lr-primary">{primary || `#${id}`}</span>
      {secondary && <span className="lr-secondary"><FacetValue value={secondary} type={secFacet?.type} facetFormat={secFacet?.format} viewFormat={cfg.formats?.[cfg.secondary!]} pattern={pattern} id={id} facet={cfg.secondary} options={secFacet?.options} linksTo={secFacet?.links} /></span>}
      <span className="lr-tail">
        {meta && <span className="lr-meta"><FacetValue value={meta} type={metaFacet?.type} facetFormat={metaFacet?.format} viewFormat={cfg.formats?.[cfg.meta!]} pattern={pattern} id={id} facet={cfg.meta} options={metaFacet?.options} linksTo={metaFacet?.links} /></span>}
        <span className="redraws" title="renders of this row">r{renders}</span>
      </span>
    </div>
  );
});

// === Entry history (revision timeline from the audit log) ===
interface Rev { at: string; operation: string; actor: string | null; changes: { facet: string; from: unknown; to: unknown }[]; }

function EntryHistory({ pattern, id, title, open, onClose }: { pattern: string; id: number; title: string; open: boolean; onClose: () => void }) {
  const [revs, setRevs] = useState<Rev[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setRevs(null);
    fetch(`/api/history/${pattern}/${id}`).then((r) => r.json()).then((d) => setRevs(d.revisions || [])).catch(() => setRevs([]));
  }, [open, pattern, id]);
  const label = (op: string) => (op === 'INSERT' ? 'created' : op === 'DELETE' ? 'archived' : 'edited');
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title className="dialog-title">History · {title}</Dialog.Title>
          {revs === null ? <div className="status">loading…</div> : revs.length === 0 ? <div className="status">No history recorded.</div> : (
            <ol className="hist">
              {revs.map((rev, i) => (
                <li className="hist-rev" key={i}>
                  <div className="hist-head">
                    <span className={`hist-op ${rev.operation.toLowerCase()}`}>{label(rev.operation)}</span>
                    <span className="hist-at">{rev.at}</span>
                    {rev.actor && <span className="hist-actor">{rev.actor}</span>}
                  </div>
                  {rev.changes.length > 0 && (
                    <div className="hist-changes">
                      {rev.changes.map((c) => (
                        <div className="hist-change" key={c.facet}>
                          <div className="hist-facet">{humanize(c.facet)}</div>
                          <div className="hist-val">{String(c.to ?? '')}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          <footer className="dialog-foot">
            <span className="id">{revs ? `${revs.length} revision${revs.length === 1 ? '' : 's'}` : ''}</span>
            <Dialog.Close className="dialog-close">close</Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// === Peek (read-only popup of a referenced entry; opened via reference click) ===
export function PeekDialog({ pattern, id, facets, onClose }: { pattern: string; id: number; facets: Facet[]; onClose: () => void }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  useEffect(() => {
    setEntry(null);
    fetch(`/api/query/${pattern}?filter=${encodeURIComponent('id=' + id)}&limit=1`)
      .then((r) => r.json()).then((d) => setEntry((d.entries || [])[0] ?? null)).catch(() => setEntry(null));
  }, [pattern, id]);
  const titleFacet = facets.find((f) => f.type === 'text')?.name;
  const title = entry && titleFacet ? valueOf(entry, titleFacet) : `${pattern} #${id}`;
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          {!entry ? <div className="status">loading…</div> : (
            <div className="dialog-fields">
              {facets.filter((f) => !KERNEL_COLS.has(f.name) && f.name !== titleFacet && valueOf(entry, f.name)).map((f) => (
                <div className="field inline" key={f.name}>
                  <div className="field-name">{f.name}</div>
                  <div className="field-value"><FacetValue value={valueOf(entry, f.name)} type={f.type} facetFormat={f.format} pattern={pattern} id={id} facet={f.name} options={f.options} linksTo={f.links} /></div>
                </div>
              ))}
            </div>
          )}
          <footer className="dialog-foot"><span className="id">{pattern} #{id}</span><Dialog.Close className="dialog-close">close</Dialog.Close></footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// === Entry card (one entry's facets, inline — used by the page `entry` block) ===
export function EntryCard({ pattern, id, facets }: { pattern: string; id: number; facets: Facet[] }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  useEffect(() => {
    setEntry(null);
    fetch(`/api/query/${pattern}?filter=${encodeURIComponent('id=' + id)}&limit=1`)
      .then((r) => r.json()).then((d) => setEntry((d.entries || [])[0] ?? null)).catch(() => setEntry(null));
  }, [pattern, id]);
  const titleFacet = facets.find((f) => f.type === 'text')?.name;
  if (!entry) return <div className="status">loading…</div>;
  return (
    <div className="entry-card">
      {titleFacet && <div className="entry-card-title">{valueOf(entry, titleFacet) || `${pattern} #${id}`}</div>}
      <div className="dialog-fields">
        {facets.filter((f) => !KERNEL_COLS.has(f.name) && f.name !== titleFacet && valueOf(entry, f.name)).map((f) => (
          <div className="field inline" key={f.name}>
            <div className="field-name">{f.name}</div>
            <div className="field-value"><FacetValue value={valueOf(entry, f.name)} type={f.type} facetFormat={f.format} pattern={pattern} id={id} facet={f.name} options={f.options} linksTo={f.links} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// === Document (long-form reading; each entry a document) ===
export function DocumentView({ pattern, facets, view }: ViewProps) {
  const entries = usePatternEntries(pattern);
  if (entries.length === 0) return <div className="status">No entries yet.</div>;
  const cfg = parseConfig(view);
  return (
    <div className="doc">
      {entries.map((e) => (
        <DocBlock key={e.id} pattern={pattern} id={e.id} facets={facets} cfg={cfg} />
      ))}
    </div>
  );
}

const DocBlock = memo(function DocBlock({ pattern, id, facets, cfg }: { pattern: string; id: number; facets: Facet[]; cfg: ViewConfig }) {
  const entry = useEntry(pattern, id);
  const renders = useRenderCount();
  const [histOpen, setHistOpen] = useState(false);
  if (!entry) return null;
  const titleFacet = cfg.title ?? facets.find((f) => f.type === 'text')?.name;
  const leadFacet = cfg.lead;
  const title = (titleFacet && valueOf(entry, titleFacet)) || `#${id}`;
  const hide = new Set(cfg.hide ?? []);
  const facetOf = (n: string) => facets.find((f) => f.name === n);
  const sectionNames = (cfg.sections?.length ? cfg.sections : facets.filter((f) => !KERNEL_COLS.has(f.name)).map((f) => f.name))
    .filter((n) => n !== titleFacet && n !== leadFacet && !hide.has(n) && facetOf(n) && valueOf(entry, n));
  const render = (n: string) => {
    const f = facetOf(n);
    return <FacetValue value={valueOf(entry, n)} type={f?.type} facetFormat={f?.format} viewFormat={cfg.formats?.[n]} pattern={pattern} id={id} facet={n} options={f?.options} linksTo={f?.links} />;
  };
  return (
    <article className="doc-block">
      <h2 className="doc-title">{title}</h2>
      {leadFacet && valueOf(entry, leadFacet) && <div className="doc-lead">{render(leadFacet)}</div>}
      {sectionNames.map((n) => (
        <section className="doc-section" key={n}>
          <h3 className="doc-section-head">{humanize(n)}</h3>
          <div className="doc-section-body">{render(n)}</div>
        </section>
      ))}
      <footer className="doc-meta">
        <span className="id">#{id}</span>
        {entry.created_by ? <span>{String(entry.created_by)}</span> : null}
        <button className="hist-btn" onClick={() => setHistOpen(true)}>history</button>
        <span className="redraws" title="renders of this document">r{renders}</span>
      </footer>
      <EntryHistory pattern={pattern} id={id} title={title} open={histOpen} onClose={() => setHistOpen(false)} />
    </article>
  );
});

// === Chart (declarative aggregate chart, rendered via Recharts) ===
// x/group_by → the category axis; y/metric → the measure; type → bar|line|area.
export function ChartView({ pattern, view }: ViewProps) {
  const entries = usePatternEntries(pattern); // subscribe → re-aggregate when the data changes (live)
  const cfg = parseConfig(view);
  const x = cfg.x || cfg.group_by;
  const y = cfg.y || cfg.metric;
  const series = cfg.series;
  const agg = cfg.agg || (y ? 'sum' : 'count');
  const mark = cfg.mark || 'bar';
  const round = mark === 'pie' || mark === 'donut';
  const [data, setData] = useState<Record<string, unknown>[] | null>(null);
  useEffect(() => {
    if (!x) { setData([]); return; }
    let live = true;
    const done = (rows: Record<string, unknown>[]) => { if (live) setData(rows); };
    const fail = () => { if (live) setData([]); };
    const aggregate = JSON.stringify([{ fn: agg, ...(y ? { facet: y } : {}), as: 'value' }]);
    if (mark === 'scatter') {
      // raw points: x,y per entry, no aggregation
      const facets = [x, y].filter(Boolean).join(',');
      fetch(`/api/query/${pattern}?facets=${encodeURIComponent(facets)}&limit=500`)
        .then((r) => r.json())
        .then((d) => done((d.entries || []).map((e: Record<string, unknown>) => ({ [x]: e[x], value: y ? e[y] : 0 })))).catch(fail);
    } else if (series && !round) {
      // multi-series: aggregate over x AND series → long rows, pivoted in Chart.
      const gb = encodeURIComponent(`${x},${series}`);
      fetch(`/api/query/${pattern}?group_by=${gb}&aggregate=${encodeURIComponent(aggregate)}&sort=${encodeURIComponent(x)}&limit=500`)
        .then((r) => r.json()).then((d) => done(d.rows || [])).catch(fail);
    } else {
      // single series / pie / donut: one row per x. line/area read left→right; bar & slices rank biggest-first.
      const sort = (mark === 'line' || mark === 'area') ? x : '-value';
      fetch(`/api/query/${pattern}?group_by=${encodeURIComponent(x)}&aggregate=${encodeURIComponent(aggregate)}&sort=${encodeURIComponent(sort)}&limit=200`)
        .then((r) => r.json()).then((d) => done(d.rows || [])).catch(fail);
    }
    return () => { live = false; };
  }, [pattern, x, y, series, agg, mark, round, entries]);
  if (!x) return <div className="status">This chart needs an x facet (x or group_by).</div>;
  if (data === null) return <div className="status">loading…</div>;
  if (data.length === 0) return <div className="status">No data to chart.</div>;
  return <Chart spec={{ mark, x, y, series, stack: cfg.stack, agg, title: cfg.title, caption: cfg.caption }} data={data} />;
}

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
  cards: CardsView,
  board: BoardView,
  table: TableView,
  list: ListView,
  document: DocumentView,
  chart: ChartView,
};
