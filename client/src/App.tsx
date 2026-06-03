import { useEffect, useState } from 'react';
import type { FactSet } from '@shared';

/**
 * Scaffold landing page: confirms the API is reachable and renders the seeded
 * fact-set catalog. The real profile picker / session player replace this.
 */
export function App() {
  const [sets, setSets] = useState<FactSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/catalog')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { sets: FactSet[] }) => setSets(data.sets))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="app">
      <h1>Fact Fluency</h1>
      <p className="tagline">Spaced-repetition math fact practice — scaffold</p>

      <section>
        <h2>Fact set catalog</h2>
        {error && <p className="error">Could not reach the API: {error}</p>}
        {!sets && !error && <p>Loading…</p>}
        {sets && (
          <ul className="catalog">
            {sets.map((s) => (
              <li key={s.id}>
                <span className={`op op-${s.operation}`}>{s.operation}</span>
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
