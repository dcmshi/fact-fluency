import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { Box, CellState, DashboardView, DayTrend, ProgressGrid } from '@shared';
import { api, qk } from '../api';
import { OP_HEX, OP_LABEL, OP_SYMBOL } from '../ops';
import './ProgressPage.css';

/** Mastery shade: pale for unseen, deepening to the solid op color at box 5. */
function cellColor(op: keyof typeof OP_HEX, box: Box | null, state: CellState): string {
  if (state === 'unseen' || box === null) return '#f1e7d5';
  // Review deepens gently (0.2 → 0.66); mastered jumps to a full, solid fill so
  // it reads as clearly "done" rather than one shade darker than box 4. The
  // mastered cell also gets an inset ring in CSS (.fact-cell.mastered).
  const alpha = [0.2, 0.31, 0.42, 0.53, 0.66, 1][box] ?? 0.2;
  const hex = OP_HEX[op];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function ProgressPage() {
  const { profileId = '' } = useParams();
  const navigate = useNavigate();
  const {
    data: dash,
    isError: dashError,
    refetch: refetchDash,
  } = useQuery({
    queryKey: qk.dashboard(profileId),
    queryFn: () => api.dashboard(profileId),
  });
  const {
    data: view,
    isError: viewError,
    refetch: refetchView,
  } = useQuery({
    queryKey: qk.progress(profileId),
    queryFn: () => api.progress(profileId),
  });
  const loadFailed = dashError || viewError;
  const [exportError, setExportError] = useState<string | null>(null);

  // Fetch the export with credentials so a server error shows a message instead
  // of the browser downloading the error JSON as a file (which a naked
  // <a download> would do).
  async function download(format: 'csv' | 'json') {
    setExportError(null);
    try {
      const res = await fetch(`/api/profiles/${profileId}/export?format=${format}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match?.[1] ?? `fact-fluency-export.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Couldn’t export — try again.');
    }
  }

  return (
    <div className="screen">
      <header className="hub-header">
        <button className="btn ghost" onClick={() => navigate('/')}>
          ← Back
        </button>
        <div className="brand" style={{ fontSize: '1.1rem' }}>
          {dash ? `${dash.displayName}’s progress` : 'Progress'}
        </div>
      </header>

      <div className="stack" style={{ maxWidth: 720 }}>
        {loadFailed && (
          <div className="card" role="alert" style={{ textAlign: 'center' }}>
            <p className="muted">Couldn’t load progress.</p>
            <button
              className="btn ghost"
              onClick={() => {
                if (dashError) void refetchDash();
                if (viewError) void refetchView();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {dash ? (
          <Dashboard dash={dash} profileId={profileId} />
        ) : (
          !dashError && <DashboardSkeleton />
        )}

        {!view && !viewError && <GridSkeleton />}
        {view?.grids.length === 0 && (
          <p className="muted">No fact sets enabled yet — pick some from the profiles screen.</p>
        )}
        {view?.grids.map((grid) => (
          <OperationGrid
            key={grid.operation}
            grid={grid}
            kidName={dash?.displayName ?? ''}
            threshold={dash?.thresholds[grid.operation]}
          />
        ))}

        {view && view.grids.length > 0 && (
          <div className="legend">
            <span className="legend-label">Less practiced</span>
            <div className="legend-swatches">
              {[null, 0, 1, 2, 3, 4, 5].map((b, i) => (
                <span
                  key={i}
                  className={`legend-swatch${b === 5 ? ' mastered' : ''}`}
                  style={{
                    background: cellColor('mul', b as Box | null, b === null ? 'unseen' : 'review'),
                  }}
                />
              ))}
            </div>
            <span className="legend-label">Mastered</span>
          </div>
        )}

        <div className="export-row">
          <span className="muted">Export this profile’s data:</span>
          <button className="btn ghost" onClick={() => download('csv')}>
            CSV
          </button>
          <button className="btn ghost" onClick={() => download('json')}>
            JSON
          </button>
        </div>
        {exportError && (
          <div className="error-banner" style={{ textAlign: 'center' }}>
            {exportError}
          </div>
        )}
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <section className="dash card" aria-hidden="true">
      <div className="dash-cards">
        {[0, 1, 2, 3].map((i) => (
          <div className="skeleton" key={i} style={{ height: 78 }} />
        ))}
      </div>
      <div className="skeleton" style={{ height: 84, marginTop: '1.1rem' }} />
    </section>
  );
}

function GridSkeleton() {
  return (
    <section className="grid-card card" aria-hidden="true">
      <div className="skeleton" style={{ width: '40%', height: 20, marginBottom: '1rem' }} />
      <div className="skeleton" style={{ height: 180 }} />
    </section>
  );
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function Dashboard({ dash, profileId }: { dash: DashboardView; profileId: string }) {
  const { summary, trends, suggestion, weekly, trickiest } = dash;
  const typicalMs = median(trends.map((t) => t.medianMs).filter((m): m is number => m != null));
  // Tap-to-inspect caption for the trend chart (tooltips are hover-only).
  const [detail, setDetail] = useState<string | null>(null);

  // One-tap "Enable now" on the suggestion — no detour through the Facts modal.
  const queryClient = useQueryClient();
  const enableMut = useMutation({
    mutationFn: async () => {
      if (!suggestion) return;
      const { enabledIds } = await api.getFactSets(profileId);
      await api.setFactSets(profileId, [...new Set([...enabledIds, suggestion.setId])]);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.factSets(profileId) });
      void queryClient.invalidateQueries({ queryKey: qk.progress(profileId) });
      void queryClient.invalidateQueries({ queryKey: qk.dashboard(profileId) });
    },
  });

  return (
    <section className="dash card rise">
      <div className="dash-cards">
        <StatCard
          label="Mastered"
          value={`${summary.mastered}`}
          sub={`of ${summary.totalFacts} facts`}
          accent="var(--add)"
        />
        <StatCard label="Day streak" value={`🔥 ${dash.streak}`} sub="in a row" />
        <StatCard
          label="Accuracy"
          value={summary.attempts ? `${Math.round(summary.accuracy * 100)}%` : '—'}
          sub={`last ${dash.windowDays} days`}
          accent="var(--mul)"
        />
        <StatCard
          label="Typical speed"
          value={typicalMs != null ? `${(typicalMs / 1000).toFixed(1)}s` : '—'}
          sub="per answer"
          accent="var(--div)"
        />
      </div>

      {dash.speed && dash.speed.fasterPct >= 0.05 && (
        <div className="speed-note">
          <span aria-hidden="true">⚡</span> Answering{' '}
          <strong>{Math.round(dash.speed.fasterPct * 100)}% faster</strong> than earlier this window
          — the fast bar adapts as {dash.displayName} speeds up.
        </div>
      )}

      {weekly.attempts > 0 && (
        <div className="weekly-recap">
          <strong>This week:</strong> {weekly.sessions}{' '}
          {weekly.sessions === 1 ? 'session' : 'sessions'} · {weekly.attempts} answers
          {weekly.accuracy != null && <> · {Math.round(weekly.accuracy * 100)}% right</>}
          {weekly.accuracyDelta != null && (
            <span className={weekly.accuracyDelta >= 0 ? 'delta-up' : 'delta-down'}>
              {' '}
              ({weekly.accuracyDelta >= 0 ? '+' : ''}
              {Math.round(weekly.accuracyDelta * 100)}% vs last week)
            </span>
          )}
          {weekly.mastered > 0 && <> · {weekly.mastered} mastered</>}
        </div>
      )}

      {suggestion && (
        <div className="suggestion">
          <span className="suggestion-spark" aria-hidden="true">
            ✨
          </span>
          <div>
            <strong>Ready for more!</strong> {suggestion.reason}{' '}
            <button
              className="btn ghost enable-now"
              disabled={enableMut.isPending}
              onClick={() => enableMut.mutate()}
            >
              {enableMut.isPending ? 'Enabling…' : 'Enable now'}
            </button>
            {enableMut.isError && <span className="muted"> Couldn’t enable — try again.</span>}
          </div>
        </div>
      )}

      {trickiest.length > 0 && (
        <div className="trickiest">
          <h3>Trickiest facts right now</h3>
          <div className="trickiest-chips">
            {trickiest.map((t) => (
              <span
                key={`${t.operation}-${t.operandA}-${t.operandB}`}
                className="trickiest-chip"
                style={{ borderColor: OP_HEX[t.operation] }}
                title={`${Math.round(t.accuracy * 100)}% right · ${(t.medianMs / 1000).toFixed(1)}s typical`}
              >
                {t.operandA} {OP_SYMBOL[t.operation]} {t.operandB}
                <span className="trickiest-acc"> {Math.round(t.accuracy * 100)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <TrendChart
        trends={trends}
        windowDays={dash.windowDays}
        active={summary.daysActive}
        onPick={setDetail}
      />
      {detail && (
        <p className="chart-detail" role="status">
          {detail}
        </p>
      )}
    </section>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-card-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-sub">{sub}</div>
    </div>
  );
}

/** Bar color by accuracy band — green strong, amber middling, coral weak. */
function accuracyColor(t: DayTrend): string {
  if (t.attempts === 0) return 'transparent';
  if (t.accuracy >= 0.8) return 'var(--add)';
  if (t.accuracy >= 0.6) return 'var(--sun)';
  return 'var(--sub)';
}

function TrendChart({
  trends,
  windowDays,
  active,
  onPick,
}: {
  trends: DayTrend[];
  windowDays: number;
  active: number;
  onPick?: (text: string) => void;
}) {
  const maxMs = Math.max(1, ...trends.map((t) => t.medianMs ?? 0));

  return (
    <div className="trend">
      <div className="trend-head">
        <h3>Last {windowDays} days</h3>
        <span className="muted">
          {active === 0 ? 'No practice yet' : `${active} active ${active === 1 ? 'day' : 'days'}`}
        </span>
      </div>

      {/* Each day is tappable/SR-readable — the hover title alone is invisible
          on touch (the primary device), keyboard, and screen readers. */}
      <div className="trend-bars">
        {trends.map((t) => (
          <button
            type="button"
            className="trend-col"
            key={t.day}
            title={tooltip(t)}
            aria-label={tooltip(t)}
            onClick={() => onPick?.(tooltip(t))}
          >
            <div className="trend-track">
              <div
                className="trend-bar"
                style={{
                  height: t.attempts ? `${Math.max(6, t.accuracy * 100)}%` : '0',
                  background: accuracyColor(t),
                }}
              />
            </div>
          </button>
        ))}
      </div>
      <div className="trend-axis">
        <span>Accuracy per day · {windowDays} days ago</span>
        <span>today</span>
      </div>

      {/* Speed sparkline — median answer time on active days (lower is faster). */}
      {active > 0 && (
        <svg
          className="trend-spark"
          viewBox="0 0 100 28"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline
            points={trends
              .map((t, i) =>
                t.medianMs != null
                  ? `${(i / (trends.length - 1)) * 100},${26 - (t.medianMs / maxMs) * 24}`
                  : null,
              )
              .filter(Boolean)
              .join(' ')}
            fill="none"
            stroke="var(--div)"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
      {active > 0 && (
        <div className="trend-axis trend-axis-spark">Answer speed (lower is faster)</div>
      )}
    </div>
  );
}

/**
 * Fridge-door output: a print-friendly certificate for a fully-mastered
 * operation. The printable node exists only while printing is armed; print CSS
 * hides everything else (`.certificate-sheet` + @media print in the page CSS).
 */
function CertificateButton({
  kidName,
  operation,
}: {
  kidName: string;
  operation: ProgressGrid['operation'];
}) {
  const [printing, setPrinting] = useState(false);

  function print() {
    setPrinting(true);
    // Let the sheet render before opening the dialog; clean up after.
    requestAnimationFrame(() => {
      window.print();
      setPrinting(false);
    });
  }

  const today = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <>
      <button className="btn ghost print-cert" onClick={print}>
        <span aria-hidden="true">🖨️</span> Print certificate
      </button>
      {printing && (
        <div className="certificate-sheet">
          <div className="certificate">
            <div className="certificate-star" aria-hidden="true">
              ⭐
            </div>
            <h1>Certificate of Mastery</h1>
            <p className="certificate-name">{kidName || 'Super mathematician'}</p>
            <p>
              mastered <strong>every {OP_LABEL[operation].toLowerCase()} fact</strong>
            </p>
            <p className="certificate-date">{today}</p>
            <p className="certificate-brand">✦ Fact Fluency</p>
          </div>
        </div>
      )}
    </>
  );
}

function tooltip(t: DayTrend): string {
  if (t.attempts === 0) return `${t.day}: no practice`;
  const acc = `${Math.round(t.accuracy * 100)}% (${t.correct}/${t.attempts})`;
  const speed = t.medianMs != null ? `, ${(t.medianMs / 1000).toFixed(1)}s typical` : '';
  return `${t.day}: ${acc}${speed}`;
}

function OperationGrid({
  grid,
  kidName,
  threshold,
}: {
  grid: ProgressGrid;
  kidName: string;
  threshold?: number;
}) {
  const mastered = grid.cells.filter((c) => c.state === 'mastered').length;
  const fullyMastered = grid.cells.length > 0 && mastered === grid.cells.length;
  // Tap-to-inspect: the hover title is invisible on touch/keyboard/SR, so a
  // tapped cell writes its details into a caption line (and each cell carries
  // an aria-label for screen-reader browse mode). Cells stay out of the Tab
  // order — ~170 tab stops per grid would bury every other control.
  const [detail, setDetail] = useState<string | null>(null);
  return (
    <section className="grid-card card rise">
      <div className="grid-head">
        <h2>
          <span className="op-sym" style={{ color: OP_HEX[grid.operation] }} aria-hidden="true">
            {OP_SYMBOL[grid.operation]}
          </span>{' '}
          {OP_LABEL[grid.operation]}
        </h2>
        <span className="grid-count">
          {mastered} / {grid.cells.length} mastered
          {threshold != null && (
            <span className="grid-fastbar"> · fast under {(threshold / 1000).toFixed(1)}s</span>
          )}
        </span>
      </div>
      {fullyMastered && <CertificateButton kidName={kidName} operation={grid.operation} />}
      <div className="fact-grid">
        {grid.cells.map((c) => {
          const label = `${c.operandA} ${OP_SYMBOL[grid.operation]} ${c.operandB} = ${c.answer} · ${c.state}`;
          return (
            <button
              type="button"
              key={`${c.operandA}-${c.operandB}`}
              className={`fact-cell${c.state === 'mastered' ? ' mastered' : ''}`}
              style={{ background: cellColor(grid.operation, c.box, c.state) }}
              title={label}
              aria-label={label}
              tabIndex={-1}
              onClick={() => setDetail(label)}
            >
              <span className="fact-cell-text">
                {c.operandA}
                {OP_SYMBOL[grid.operation]}
                {c.operandB}
              </span>
            </button>
          );
        })}
      </div>
      {detail && (
        <p className="chart-detail" role="status">
          {detail}
        </p>
      )}
    </section>
  );
}
