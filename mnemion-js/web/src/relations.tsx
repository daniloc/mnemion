import { type FC, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  createRelationFields, buildRelatePayload, entryRelationsView,
  type RelationItem, type RelationGroup,
} from '../../shared/core/relation-view';
import type { Facet } from './views';

// Relation surfaces (Phase 3, P3-E): thin renderers of the pure shapes in
// shared/core/relation-view.ts. Which pickers a create form shows and how an
// entry's relations group are both read off the registry — no per-pattern code.

const KERNEL_COLS = new Set(['id', 'version', 'created_at', 'updated_at', 'archived_at', 'created_by', 'updated_by']);

// === Entry labels (an entry chip shows its derived label, fetched + cached) ===

const labelCache = new Map<string, string>();
function useEntryLabel(pattern: string, id: number): string {
  const key = `${pattern}/${id}`;
  const [label, setLabel] = useState<string>(() => labelCache.get(key) ?? '');
  useEffect(() => {
    if (labelCache.has(key)) { setLabel(labelCache.get(key)!); return; }
    let live = true;
    fetch(`/api/label/${encodeURIComponent(pattern)}/${id}`)
      .then((r) => r.json())
      .then((d) => { const l = d.label || `#${id}`; labelCache.set(key, l); if (live) setLabel(l); })
      .catch(() => { if (live) setLabel(`#${id}`); });
    return () => { live = false; };
  }, [pattern, id, key]);
  return label;
}

/** A navigable entry chip: opens the entry as a peek wherever it is rendered. */
export const EntryChip: FC<{ pattern: string; id: number }> = ({ pattern, id }) => {
  const label = useEntryLabel(pattern, id);
  const open = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('mnemion:open-entry', { detail: { pattern, id } }));
  };
  return (
    <button className="fv-ref" onClick={open} title={`open ${pattern} #${id}`}>
      <span className="rel-chip-pattern">{pattern}</span> {label || `#${id}`}<span className="fv-ref-arrow">↗</span>
    </button>
  );
};

// === An entry's relations (detail and peek views) ===

/** One section per relation group: the relation as read from this entry, an
 *  arrow for its direction, a "derived" badge, and a chip per connected entry. */
export function RelationsSection({ pattern, id }: { pattern: string; id: number }) {
  const [groups, setGroups] = useState<RelationGroup[] | null>(null);
  useEffect(() => {
    let live = true;
    setGroups(null);
    fetch('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: `mnemion://entry/${pattern}/${id}` }) })
      .then((r) => r.json())
      .then((d) => { if (live) setGroups(entryRelationsView(d.linked)); })
      .catch(() => { if (live) setGroups([]); });
    return () => { live = false; };
  }, [pattern, id]);
  if (!groups?.length) return null;
  return (
    <div className="relations">
      <div className="relations-head">relations</div>
      {groups.map((g) => (
        <div className="field inline rel-group" key={`${g.direction}|${g.relation}|${g.derived}`}>
          <div className="field-name">
            <span className="rel-dir" title={g.direction === 'out' ? 'this entry → them' : 'them → this entry'}>{g.direction === 'out' ? '→' : '←'}</span> {g.relation.replace(/-/g, ' ')}
            {g.derived && <span className="rel-derived" title="computed from a chain of relations, never stored">derived</span>}
          </div>
          <div className="field-value rel-items">
            {g.items.map((it) => <EntryChip key={`${it.pattern}/${it.id}`} pattern={it.pattern} id={it.id} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

// === Create form ===

/** Candidate targets for one picker: the active entries of its target patterns. */
function useCandidates(patterns: string[]): { ref: string; pattern: string; id: number }[] {
  const [list, setList] = useState<{ ref: string; pattern: string; id: number }[]>([]);
  const key = patterns.join(',');
  useEffect(() => {
    let live = true;
    Promise.all(patterns.map((p) =>
      fetch(`/api/query/${encodeURIComponent(p)}?limit=200`).then((r) => r.json())
        .then((d) => ((d.entries || []) as { id: number }[]).map((e) => ({ ref: `${p}/${e.id}`, pattern: p, id: e.id })))
        .catch(() => [])))
      .then((all) => { if (live) setList(all.flat()); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

const CandidateOption: FC<{ pattern: string; id: number; multiPattern: boolean }> = ({ pattern, id, multiPattern }) => {
  const label = useEntryLabel(pattern, id);
  return <option value={`${pattern}/${id}`}>{multiPattern ? `${pattern} · ` : ''}{label || `#${id}`}</option>;
};

/** One target picker: a single-select for cardinality one, a multi-select for many. */
function RelationPicker({ relation, label, targets, cardinality, value, onChange }: {
  relation: string; label: string; targets: string[]; cardinality: 'one' | 'many';
  value: string | string[]; onChange: (v: string | string[]) => void;
}) {
  const candidates = useCandidates(targets);
  const multiPattern = targets.length > 1;
  return (
    <label className="form-row">
      <span className="field-name">{label} <span className="form-req" title="required relation">*</span></span>
      {cardinality === 'one' ? (
        <select className="form-input" name={relation} value={value as string} required
          onChange={(e) => onChange(e.target.value)}>
          <option value="">choose {targets.join(' or ')}…</option>
          {candidates.map((c) => <CandidateOption key={c.ref} pattern={c.pattern} id={c.id} multiPattern={multiPattern} />)}
        </select>
      ) : (
        <select className="form-input" name={relation} multiple required value={value as string[]}
          onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
          {candidates.map((c) => <CandidateOption key={c.ref} pattern={c.pattern} id={c.id} multiPattern={multiPattern} />)}
        </select>
      )}
    </label>
  );
}

/** "New entry" for a pattern: one input per facet, plus one target picker per
 *  required relation the pattern is a source of (createRelationFields); posts the
 *  entry and its links as one write (`_relate`, buildRelatePayload). */
export function CreateEntryDialog({ pattern, facets, relations, onClose, onCreated }: {
  pattern: string; facets: Facet[]; relations: RelationItem[]; onClose: () => void; onCreated: () => void;
}) {
  const fields = createRelationFields(pattern, relations);
  const inputs = facets.filter((f) => !KERNEL_COLS.has(f.name));
  const [values, setValues] = useState<Record<string, string>>({});
  const [rels, setRels] = useState<Record<string, string | string[]>>(() =>
    Object.fromEntries(fields.map((f) => [f.relation, f.cardinality === 'one' ? '' : []])));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    setBusy(true); setError('');
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (v !== '') data[k] = v;
    const relate = buildRelatePayload(rels);
    if (Object.keys(relate).length) data._relate = relate;
    try {
      const res = await fetch(`/api/mutate/${encodeURIComponent(pattern)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'create', data }),
      });
      const out = await res.json();
      if (out.error) { setError(out.message || 'refused'); setBusy(false); return; }
      onCreated();
      onClose();
    } catch (err) { setError(String(err)); setBusy(false); }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title className="dialog-title">new {pattern} entry</Dialog.Title>
          <form className="create-form" onSubmit={submit}>
            {inputs.map((f) => (
              <label className="form-row" key={f.name}>
                <span className="field-name">{f.name}</span>
                {f.options?.length ? (
                  <select className="form-input" value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                    <option value="">—</option>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input className="form-input" value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                    placeholder={f.type === 'datetime' ? 'YYYY-MM-DD' : f.type} />
                )}
              </label>
            ))}
            {fields.map((f) => (
              <RelationPicker key={f.relation} relation={f.relation} label={f.label} targets={f.target_patterns}
                cardinality={f.cardinality} value={rels[f.relation]} onChange={(v) => setRels({ ...rels, [f.relation]: v })} />
            ))}
            {error && <div className="status note form-error">{error}</div>}
            <footer className="dialog-foot">
              <button className="dialog-close" type="submit" disabled={busy}>{busy ? 'creating…' : 'create'}</button>
              <Dialog.Close className="dialog-close" type="button">cancel</Dialog.Close>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
