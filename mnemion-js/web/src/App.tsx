import { useEffect, useState } from 'react';

interface Pattern {
  name: string;
  entry_count: number;
  latest_activity?: string | null;
}

// Vertical slice (per the accord): the narrowest path that proves the whole new
// stack works together — Vite-built React, served by the worker as a static
// asset, fetching the existing /api JSON, rendering real hive data. Ugly on
// purpose; the notebook design gets ported once this is proven end-to-end.
export default function App() {
  const [patterns, setPatterns] = useState<Pattern[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/index')
      .then((r) => {
        // Auth.SESSION redirects to /login when logged out; a followed redirect
        // lands on HTML, so bounce to login rather than try to parse it.
        if (r.redirected || r.status === 401) {
          location.href = '/login';
          return null;
        }
        return r.json();
      })
      .then((d) => d && setPatterns(d.patterns ?? []))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', padding: 32, color: '#1b1a16' }}>
      <h1 style={{ fontSize: 18 }}>mnemion — react vertical slice</h1>
      {error && <pre style={{ color: '#cf4a1a' }}>{error}</pre>}
      {!patterns && !error && <p>loading…</p>}
      {patterns && (
        <>
          <p style={{ color: '#8b867b' }}>{patterns.length} patterns · served by the worker as a static asset</p>
          <ul style={{ lineHeight: 1.8 }}>
            {patterns.map((p) => (
              <li key={p.name}>
                {p.name} · {p.entry_count}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
