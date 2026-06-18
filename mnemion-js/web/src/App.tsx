import { useEffect, useRef, useState, type CSSProperties } from 'react';
import './notebook.css';

interface Facet { name: string; type: string; }
interface Pattern {
  name: string;
  description: string;
  facets: Facet[];
  entry_count: number;
  latest_activity?: string | null;
}
type Entry = Record<string, unknown>;

const KERNEL_COLS = new Set(['id', 'version', 'created_at', 'updated_at', 'archived_at', 'created_by', 'updated_by']);

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
function fullTime(val: unknown): string {
  const d = parseDate(val);
  if (!d) return String(val ?? '');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    + ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export default function App() {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [charter, setCharter] = useState<Record<string, string>>({});
  const [guidance, setGuidance] = useState('');
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<Pattern | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // refs so the long-lived WebSocket handler reads current state without re-subscribing
  const selRef = useRef<Pattern | null>(null);
  selRef.current = selected;

  function pushHash(name?: string) {
    history.replaceState(null, '', name ? `#${name}` : location.pathname);
  }

  async function selectPattern(p: Pattern) {
    setSelected(p);
    setEntries([]);
    setMenuOpen(false);
    pushHash(p.name);
    setLoading(true);
    try {
      const res = await fetch(`/api/query/${p.name}`);
      const data = await res.json();
      setEntries(data.entries || []);
    } catch {
      setEntries([]);
    }
    setLoading(false);
  }
  const selectRef = useRef(selectPattern);
  selectRef.current = selectPattern;

  function goCover() {
    setSelected(null);
    setEntries([]);
    setMenuOpen(false);
    pushHash();
  }

  // Load the index (the SPA has no SSR props), restore deep-link, connect live updates.
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
          if (changed.includes('_schema')) { location.reload(); return; }
          const fresh = await loadIndex();
          const sel = selRef.current;
          if (sel && changed.includes(sel.name)) {
            const f = fresh.find((p) => p.name === sel.name);
            if (f) selectRef.current(f);
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

  function fields(entry: Entry) {
    if (!selected) return [];
    const out: { name: string; value: string; lead: boolean; long: boolean }[] = [];
    let leadTaken = false;
    for (const f of selected.facets) {
      if (KERNEL_COLS.has(f.name)) continue;
      const raw = entry[f.name];
      if (raw === null || raw === undefined || raw === '') continue;
      const value = f.type === 'datetime' ? fullTime(raw) : f.type === 'boolean' ? (raw ? 'yes' : 'no') : String(raw);
      const long = value.length > 88 || value.includes('\n');
      const lead = !leadTaken && f.type === 'text';
      if (lead) leadTaken = true;
      out.push({ name: f.name, value, lead, long });
    }
    return out;
  }

  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      <header className="topbar">
        <button className="menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="patterns">
          <span /><span /><span />
        </button>
        <button className="wordmark mobile-word" onClick={goCover}>mnemion</button>
        <span className="topbar-current">{selected?.name ?? ''}</span>
      </header>

      <aside className="sidebar">
        <button className="wordmark" onClick={goCover}>
          mnemion<span className="wordmark-sub">a notebook</span>
        </button>
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

      <main className="main">
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
                <span className="ct">{selected.entry_count} {selected.entry_count === 1 ? 'entry' : 'entries'}</span>
                {selected.description && <span className="desc">{selected.description}</span>}
              </div>
            </header>
            {loading ? (
              <div className="status">loading…</div>
            ) : entries.length === 0 ? (
              <div className="status">No entries yet.</div>
            ) : (
              <div className="stack">
                {entries.map((entry, i) => (
                  <article className="block" key={String(entry.id)} style={{ '--i': Math.min(i, 12) } as CSSProperties}>
                    <div className="block-fields">
                      {fields(entry).map((f, j) => (
                        <div key={j} className={`field${f.lead ? ' lead' : f.long ? ' long' : ' inline'}`}>
                          <div className="field-name">{f.name}</div>
                          <div className="field-value">{f.value}</div>
                        </div>
                      ))}
                    </div>
                    <footer className="block-meta">
                      <span className="id">#{String(entry.id)}</span>
                      {entry.updated_at ? <span title={fullTime(entry.updated_at)}>{relativeTime(entry.updated_at)}</span> : null}
                      {entry.created_by ? <span className="author">{String(entry.created_by)}</span> : null}
                    </footer>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
