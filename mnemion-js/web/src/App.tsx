import { useEffect, useRef, useState } from 'react';
import './notebook.css';
import { store } from './store';
import { COMPONENTS, StackView, type Facet, type ViewSpec } from './views';
import { isViewType } from '../../shared/core/view-palette';

interface Pattern {
  name: string;
  description: string;
  facets: Facet[];
  entry_count: number;
  latest_activity?: string | null;
}

function parseDate(val: unknown): Date | null {
  if (!val) return null;
  const s = String(val);
  const d = new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'));
  return isNaN(d.getTime()) ? null : d;
}
function relativeTime(val: unknown): string {
  const d = parseDate(val);
  if (!d) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function App() {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [charter, setCharter] = useState<Record<string, string>>({});
  const [guidance, setGuidance] = useState('');
  const [views, setViews] = useState<ViewSpec[]>([]);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<Pattern | null>(null);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const selRef = useRef<Pattern | null>(null);
  selRef.current = selected;

  function pushHash(name?: string) {
    history.replaceState(null, '', name ? `#${name}` : location.pathname);
  }

  async function selectPattern(p: Pattern) {
    setSelected(p);
    setMenuOpen(false);
    pushHash(p.name);
    setLoading(true);
    try {
      const res = await fetch(`/api/query/${p.name}`);
      const data = await res.json();
      store.load(p.name, data.entries || []);
    } catch { store.load(p.name, []); }
    setLoading(false);
  }
  const selectRef = useRef(selectPattern);
  selectRef.current = selectPattern;

  function goCover() { setSelected(null); setMenuOpen(false); pushHash(); }

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout>;
    let closed = false;

    async function loadIndex(): Promise<Pattern[]> {
      const res = await fetch('/api/index');
      if (res.redirected || res.status === 401) { location.href = '/login'; return []; }
      const idx = await res.json();
      setPatterns(idx.patterns || []);
      setCharter(idx.charter || {});
      setGuidance(idx.guidance || '');
      setViews(idx.views || []);
      return idx.patterns || [];
    }

    function connect() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type !== 'changed') return;
          const changed: string[] = msg.patterns || [];
          // UI structure changed — the agent reworked a view spec (_views) or the
          // schema/a facet's format (_schema). Re-fetch the specs and re-render the
          // open pattern IN PLACE: no reload. This is the live hyperdesk — the user
          // watches their agent rework the UI. We also refresh `selected` so facet
          // changes (e.g. set_facet_format) flow into the view's facets prop.
          if (changed.includes('_schema') || changed.includes('_views')) {
            const ps = await loadIndex();
            const sel = selRef.current;
            if (sel) { const fresh = ps.find((p) => p.name === sel.name); if (fresh) setSelected(fresh); }
            return;
          }
          // Surgical: patch exactly the changed entry in the store → only its card redraws.
          if (msg.delta && store.has(msg.delta.pattern)) store.applyDelta(msg.delta);
          // Keep sidebar counts/recency fresh (cheap); refetch entries only if we
          // can't patch (coarse change to the open pattern, e.g. a batch).
          loadIndex();
          const sel = selRef.current;
          if (!msg.delta && sel && changed.includes(sel.name)) {
            const res = await fetch(`/api/query/${sel.name}`);
            store.load(sel.name, (await res.json()).entries || []);
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => { ws = null; if (!closed) reconnect = setTimeout(connect, 3000); };
      ws.onerror = () => ws?.close();
    }

    loadIndex().then((ps) => {
      setReady(true);
      const name = location.hash.slice(1);
      if (name) { const m = ps.find((p) => p.name === name); if (m) selectRef.current(m); }
    });
    connect();
    return () => { closed = true; clearTimeout(reconnect); ws?.close(); };
  }, []);

  const userPatterns = patterns.filter((p) => !p.name.startsWith('_'));
  const kernelPatterns = patterns.filter((p) => p.name.startsWith('_'));
  const charterEntries = Object.entries(charter).filter(([, v]) => v && String(v).trim());
  const selectedView = selected ? views.find((v) => v.pattern === selected.name) : undefined;
  // Dispatch through the component palette, keyed by view_type. An unknown type
  // (legacy/invalid row) falls back to the stack with a visible note rather than
  // silently pretending — the registry, not a hidden ternary, is the contract.
  const vt = selectedView?.view_type;
  const View = vt && isViewType(vt) ? COMPONENTS[vt] : null;
  const unknownView = !!selectedView && !View;
  const wide = vt === 'board' || vt === 'table';

  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      <header className="topbar">
        <button className="menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="patterns"><span /><span /><span /></button>
        <button className="wordmark mobile-word" onClick={goCover}>mnemion</button>
        <span className="topbar-current">{selected?.name ?? ''}</span>
      </header>

      <aside className="sidebar">
        <button className="wordmark" onClick={goCover}>mnemion<span className="wordmark-sub">a notebook</span></button>
        <nav className="patterns">
          {userPatterns.map((p) => (
            <button key={p.name} className={`pat${selected?.name === p.name ? ' active' : ''}`} onClick={() => selectPattern(p)}>
              <span className="pat-name">{p.name}</span>
              <span className="pat-meta">
                <span className="pat-count">{p.entry_count}</span>
                {p.latest_activity && <span className="pat-time">{relativeTime(p.latest_activity)}</span>}
              </span>
            </button>
          ))}
        </nav>
        {kernelPatterns.length > 0 && (
          <>
            <div className="group-label">system</div>
            <nav className="patterns kernel">
              {kernelPatterns.map((p) => (
                <button key={p.name} className={`pat pat-sys${selected?.name === p.name ? ' active' : ''}`} onClick={() => selectPattern(p)}>
                  <span className="pat-name">{p.name}</span>
                  <span className="pat-count">{p.entry_count}</span>
                </button>
              ))}
            </nav>
          </>
        )}
      </aside>

      <button className="scrim" aria-label="close menu" onClick={() => setMenuOpen(false)} />

      <main className={`main${wide ? ' main-wide' : ''}`}>
        {!selected ? (
          <section className="cover">
            <div className="cover-mark">mnemion</div>
            {guidance && <p className="cover-lede">{guidance}</p>}
            <div className="cover-charter">
              {charterEntries.map(([key, value]) => (
                <div className="charter-row" key={key}>
                  <div className="charter-key">{key.replace(/_/g, ' ')}</div>
                  <p className="charter-val">{value}</p>
                </div>
              ))}
            </div>
            {ready && charterEntries.length === 0 && <p className="cover-empty">Select a pattern to begin.</p>}
          </section>
        ) : (
          <section className="pattern-view">
            <header className="pattern-head">
              <h1>{selected.name}</h1>
              <div className="pattern-sub">
                <span className="ct">
                  {selected.entry_count} {selected.entry_count === 1 ? 'entry' : 'entries'}
                  {selectedView ? ` · ${selectedView.view_type}` : ''}
                </span>
                {selected.description && <span className="desc">{selected.description}</span>}
              </div>
            </header>
            {loading ? (
              <div className="status">loading…</div>
            ) : View ? (
              <View pattern={selected.name} facets={selected.facets} view={selectedView} />
            ) : (
              <>
                {unknownView && <div className="status note">view_type “{vt}” isn’t available — showing the default stack.</div>}
                <StackView pattern={selected.name} facets={selected.facets} />
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
