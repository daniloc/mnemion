import { type FC } from 'react';
import * as Select from '@radix-ui/react-select';
import { resolveFormat, type FormatId } from '../../shared/core/format-palette';
import { store, usePatternEntries } from './store';

// Renders one facet value per its resolved format (view override ?? facet
// intrinsic ?? type default). Most formats are read-only displays; `select` is
// interactive — a dropdown that writes the change back. The renderer registry is
// typed Record<FormatId,…> so the compiler enforces a renderer per palette format.
//
// Interactive renderers need write context (pattern/id/facet); read-only ones
// ignore it. All renderers share FormatProps so the registry stays total.
export interface FormatProps {
  value: string;
  pattern?: string;
  id?: number;
  facet?: string;
  options?: string[]; // declared facet options (select-typed facets), if any
}

function relDate(v: string): string {
  const s = String(v);
  const d = new Date(s.replace(' ', 'T') + (/[Z+]/.test(s) ? '' : 'Z'));
  if (isNaN(d.getTime())) return s;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 0) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function writeFacet(pattern: string, id: number, facet: string, value: string) {
  await fetch(`/api/mutate/${pattern}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'update', data: { id, [facet]: value } }),
  });
}

const TextValue: FC<FormatProps> = ({ value }) => <>{value}</>;

const LinkValue: FC<FormatProps> = ({ value }) => {
  const href = /^(https?:|mailto:)/.test(value) ? value : `https://${value}`;
  return (
    <a className="fv-link" href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
      {value}
    </a>
  );
};

const TagsValue: FC<FormatProps> = ({ value }) => (
  <span className="fv-tags">
    {value.split(',').map((t) => t.trim()).filter(Boolean).map((t) => (
      <span className="fv-tag" key={t}>{t}</span>
    ))}
  </span>
);

const DateValue: FC<FormatProps> = ({ value }) => <span className="fv-date" title={value}>{relDate(value)}</span>;

const BoolValue: FC<FormatProps> = ({ value }) => {
  const truthy = !['', '0', 'false', 'no', 'null', 'off'].includes(String(value).trim().toLowerCase());
  return <span className={`fv-bool ${truthy ? 'on' : 'off'}`}>{truthy ? '✓' : '✗'}</span>;
};

// Interactive: an inline dropdown that changes the value (optimistic patch +
// mutate, the live socket echoes it back). Options = declared facet options
// unioned with the values already in use, so a plain text facet (e.g. status)
// becomes a chooser with no schema change.
const SelectValue: FC<FormatProps> = ({ value, pattern, id, facet, options }) => {
  const entries = usePatternEntries(pattern ?? '');
  if (!pattern || id == null || !facet) return <>{value}</>; // no write context → plain
  const opts = new Set(options ?? []);
  for (const e of entries) { const v = e[facet]; if (v != null && v !== '') opts.add(String(v)); }
  if (value) opts.add(value);
  const onChange = (v: string) => { store.patchEntry(pattern, id, { [facet]: v }); void writeFacet(pattern, id, facet, v); };
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className="fv-select" aria-label={facet} onClick={(e) => e.stopPropagation()}>
        <Select.Value placeholder="—" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="status-menu" position="popper" sideOffset={4}>
          <Select.Viewport>
            {[...opts].map((o) => (
              <Select.Item className="status-item" value={o} key={o}><Select.ItemText>{o}</Select.ItemText></Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
};

const FORMAT_COMPONENTS: Record<FormatId, FC<FormatProps>> = {
  text: TextValue,
  link: LinkValue,
  tags: TagsValue,
  date: DateValue,
  boolean: BoolValue,
  select: SelectValue,
};

export function FacetValue({ value, type, facetFormat, viewFormat, pattern, id, facet, options }: FormatProps & {
  type?: string;
  facetFormat?: string | null;
  viewFormat?: string | null;
}) {
  const fmt = resolveFormat(viewFormat, facetFormat, type);
  if ((value === '' || value == null) && fmt !== 'select') return null;
  const Renderer = FORMAT_COMPONENTS[fmt];
  return <Renderer value={value} pattern={pattern} id={id} facet={facet} options={options} />;
}
