import { type FC } from 'react';
import { resolveFormat, type FormatId } from '../../shared/core/format-palette';

// Renders one facet value per its resolved format (view override ?? facet
// intrinsic ?? type default). The renderer registry is typed Record<FormatId,…>
// so the compiler enforces that every format in the palette has a renderer —
// the same totality trick the view palette uses for layouts.

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

const TextValue: FC<{ value: string }> = ({ value }) => <>{value}</>;

const LinkValue: FC<{ value: string }> = ({ value }) => {
  const href = /^(https?:|mailto:)/.test(value) ? value : `https://${value}`;
  // stopPropagation so following the link doesn't also trigger the row/card's
  // open-detail click.
  return (
    <a className="fv-link" href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
      {value}
    </a>
  );
};

const TagsValue: FC<{ value: string }> = ({ value }) => (
  <span className="fv-tags">
    {value.split(',').map((t) => t.trim()).filter(Boolean).map((t) => (
      <span className="fv-tag" key={t}>{t}</span>
    ))}
  </span>
);

const DateValue: FC<{ value: string }> = ({ value }) => (
  <span className="fv-date" title={value}>{relDate(value)}</span>
);

const BoolValue: FC<{ value: string }> = ({ value }) => {
  const truthy = !['', '0', 'false', 'no', 'null', 'off'].includes(String(value).trim().toLowerCase());
  return <span className={`fv-bool ${truthy ? 'on' : 'off'}`}>{truthy ? '✓' : '✗'}</span>;
};

const FORMAT_COMPONENTS: Record<FormatId, FC<{ value: string }>> = {
  text: TextValue,
  link: LinkValue,
  tags: TagsValue,
  date: DateValue,
  boolean: BoolValue,
};

export function FacetValue({ value, type, facetFormat, viewFormat }: {
  value: string;
  type?: string;
  facetFormat?: string | null;
  viewFormat?: string | null;
}) {
  if (value === '' || value == null) return null;
  const Renderer = FORMAT_COMPONENTS[resolveFormat(viewFormat, facetFormat, type)];
  return <Renderer value={value} />;
}
