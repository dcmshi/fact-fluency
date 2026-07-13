import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { Box, CellState, DashboardView, DayTrend, ProgressGrid, TrickyFact } from '@shared';
import { api, qk } from '../api';
import { OP_HEX, OP_SYMBOL } from '../ops';
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
  const { t } = useTranslation();
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
      setExportError(t('progress.exportError'));
    }
  }

  return (
    <div className="screen">
      <header className="hub-header">
        <button className="btn ghost" onClick={() => navigate('/')}>
          {t('common.back')}
        </button>
        <div className="brand" style={{ fontSize: '1.1rem' }}>
          {dash ? t('progress.titleNamed', { name: dash.displayName }) : t('progress.title')}
        </div>
      </header>

      <div className="stack" style={{ maxWidth: 720 }}>
        {loadFailed && (
          <div className="card" role="alert" style={{ textAlign: 'center' }}>
            <p className="muted">{t('progress.loadError')}</p>
            <button
              className="btn ghost"
              onClick={() => {
                if (dashError) void refetchDash();
                if (viewError) void refetchView();
              }}
            >
              {t('common.tryAgain')}
            </button>
          </div>
        )}

        {dash ? (
          <Dashboard dash={dash} profileId={profileId} />
        ) : (
          !dashError && <DashboardSkeleton />
        )}

        {!view && !viewError && <GridSkeleton />}
        {view?.grids.length === 0 && <p className="muted">{t('progress.noSets')}</p>}
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
            <span className="legend-label">{t('progress.legendLess')}</span>
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
            <span className="legend-label">{t('progress.legendMastered')}</span>
          </div>
        )}

        <div className="export-row">
          <span className="muted">{t('progress.exportLabel')}</span>
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
  const { t } = useTranslation();
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
          label={t('progress.statMastered')}
          value={`${summary.mastered}`}
          sub={t('progress.ofFacts', { count: summary.totalFacts })}
          accent="var(--add)"
        />
        <StatCard
          label={t('progress.statStreak')}
          value={`🔥 ${dash.streak}`}
          sub={t('progress.inARow')}
        />
        <StatCard
          label={t('progress.statAccuracy')}
          value={summary.attempts ? `${Math.round(summary.accuracy * 100)}%` : '—'}
          sub={t('progress.lastDaysSub', { count: dash.windowDays })}
          accent="var(--mul)"
        />
        <StatCard
          label={t('progress.statSpeed')}
          value={typicalMs != null ? `${(typicalMs / 1000).toFixed(1)}s` : '—'}
          sub={t('progress.perAnswer')}
          accent="var(--div)"
        />
      </div>

      {dash.speed && dash.speed.fasterPct >= 0.05 && (
        <div className="speed-note">
          <span aria-hidden="true">⚡</span> {t('progress.speedPrefix')}{' '}
          <strong>
            {t('progress.speedFaster', { pct: Math.round(dash.speed.fasterPct * 100) })}
          </strong>{' '}
          {t('progress.speedRest', { name: dash.displayName })}
        </div>
      )}

      {weekly.attempts > 0 && (
        <div className="weekly-recap">
          <strong>{t('progress.thisWeek')}</strong> {weekly.sessions}{' '}
          {weekly.sessions === 1 ? t('progress.session') : t('progress.sessions')} ·{' '}
          {weekly.attempts} {t('progress.answers')}
          {weekly.accuracy != null && (
            <>
              {' '}
              · {Math.round(weekly.accuracy * 100)}% {t('progress.right')}
            </>
          )}
          {weekly.accuracyDelta != null && (
            <span className={weekly.accuracyDelta >= 0 ? 'delta-up' : 'delta-down'}>
              {' '}
              ({weekly.accuracyDelta >= 0 ? '+' : ''}
              {Math.round(weekly.accuracyDelta * 100)}% {t('progress.vsLastWeek')})
            </span>
          )}
          {weekly.mastered > 0 && (
            <>
              {' '}
              · {weekly.mastered} {t('progress.masteredWord')}
            </>
          )}
        </div>
      )}

      {suggestion && (
        <div className="suggestion">
          <span className="suggestion-spark" aria-hidden="true">
            ✨
          </span>
          <div>
            <strong>{t('progress.readyForMore')}</strong> {suggestion.reason}{' '}
            <button
              className="btn ghost enable-now"
              disabled={enableMut.isPending}
              onClick={() => enableMut.mutate()}
            >
              {enableMut.isPending ? t('progress.enabling') : t('progress.enableNow')}
            </button>
            {enableMut.isError && <span className="muted"> {t('progress.enableError')}</span>}
          </div>
        </div>
      )}

      {trickiest.length > 0 && (
        <div className="trickiest">
          <h3>{t('progress.trickiestTitle')}</h3>
          <div className="trickiest-chips">
            {trickiest.map((tf) => (
              <span
                key={`${tf.operation}-${tf.operandA}-${tf.operandB}`}
                className="trickiest-chip"
                style={{ borderColor: OP_HEX[tf.operation] }}
                title={t('progress.trickiestTip', {
                  pct: Math.round(tf.accuracy * 100),
                  sec: (tf.medianMs / 1000).toFixed(1),
                })}
              >
                {tf.operandA} {OP_SYMBOL[tf.operation]} {tf.operandB}
                <span className="trickiest-acc"> {Math.round(tf.accuracy * 100)}%</span>
              </span>
            ))}
          </div>
          <WorksheetButton kidName={dash.displayName} facts={trickiest} />
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
  const { t } = useTranslation();
  const maxMs = Math.max(1, ...trends.map((d) => d.medianMs ?? 0));

  // Tap/hover/SR caption for one day's bar.
  const tip = (d: DayTrend): string => {
    if (d.attempts === 0) return t('progress.tipNoPractice', { day: d.day });
    const acc = `${Math.round(d.accuracy * 100)}% (${d.correct}/${d.attempts})`;
    const speed =
      d.medianMs != null ? `, ${(d.medianMs / 1000).toFixed(1)}s ${t('progress.typical')}` : '';
    return `${d.day}: ${acc}${speed}`;
  };

  return (
    <div className="trend">
      <div className="trend-head">
        <h3>{t('progress.lastDaysTitle', { count: windowDays })}</h3>
        <span className="muted">
          {active === 0
            ? t('progress.noPracticeYet')
            : active === 1
              ? t('progress.activeDayOne', { count: active })
              : t('progress.activeDayOther', { count: active })}
        </span>
      </div>

      {/* Each day is tappable/SR-readable — the hover title alone is invisible
          on touch (the primary device), keyboard, and screen readers. */}
      <div className="trend-bars">
        {trends.map((d) => (
          <button
            type="button"
            className="trend-col"
            key={d.day}
            title={tip(d)}
            aria-label={tip(d)}
            onClick={() => onPick?.(tip(d))}
          >
            <div className="trend-track">
              <div
                className="trend-bar"
                style={{
                  height: d.attempts ? `${Math.max(6, d.accuracy * 100)}%` : '0',
                  background: accuracyColor(d),
                }}
              />
            </div>
          </button>
        ))}
      </div>
      <div className="trend-axis">
        <span>{t('progress.axisAccuracy', { count: windowDays })}</span>
        <span>{t('progress.today')}</span>
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
              .map((d, i) =>
                d.medianMs != null
                  ? `${(i / (trends.length - 1)) * 100},${26 - (d.medianMs / maxMs) * 24}`
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
      {active > 0 && <div className="trend-axis trend-axis-spark">{t('progress.axisSpeed')}</div>}
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
  const { t, i18n } = useTranslation();
  const [printing, setPrinting] = useState(false);

  function print() {
    setPrinting(true);
    // Let the sheet render before opening the dialog; clean up after.
    requestAnimationFrame(() => {
      window.print();
      setPrinting(false);
    });
  }

  const today = new Date().toLocaleDateString(i18n.language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <>
      <button className="btn ghost print-cert" onClick={print}>
        <span aria-hidden="true">🖨️</span> {t('progress.printCert')}
      </button>
      {printing && (
        <div className="certificate-sheet">
          <div className="certificate">
            <div className="certificate-star" aria-hidden="true">
              ⭐
            </div>
            <h1>{t('progress.certTitle')}</h1>
            <p className="certificate-name">{kidName || t('progress.certNameFallback')}</p>
            <p>
              {t('progress.certLine1')}{' '}
              <strong>
                {t('progress.certEveryFact', { op: t(`ops.${operation}`).toLowerCase() })}
              </strong>
            </p>
            <p className="certificate-date">{today}</p>
            <p className="certificate-brand">✦ Fact Fluency</p>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Print-friendly practice sheet of the kid's trickiest facts — off-screen
 * practice a parent can hand over (COMPETITORS.md — the printable-reports gap).
 * Same print pattern as the mastery certificate: the sheet renders only while
 * printing is armed, and the page's @media print hides everything else.
 */
function WorksheetButton({ kidName, facts }: { kidName: string; facts: TrickyFact[] }) {
  const { t, i18n } = useTranslation();
  const [printing, setPrinting] = useState(false);
  function print() {
    setPrinting(true);
    requestAnimationFrame(() => {
      window.print();
      setPrinting(false);
    });
  }
  const today = new Date().toLocaleDateString(i18n.language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return (
    <>
      <button className="btn ghost print-cert" onClick={print}>
        <span aria-hidden="true">🖨️</span> {t('progress.printSheet')}
      </button>
      {printing && (
        <div className="worksheet-sheet">
          <div className="worksheet">
            <h1>{t('progress.sheetTitle')}</h1>
            <p className="worksheet-sub">
              {t('progress.sheetSub', {
                name: kidName || t('progress.sheetNameFallback'),
                date: today,
              })}
            </p>
            <div className="worksheet-grid">
              {facts.map((f) => (
                <div
                  key={`${f.operation}-${f.operandA}-${f.operandB}`}
                  className="worksheet-problem"
                >
                  {f.operandA} {OP_SYMBOL[f.operation]} {f.operandB} = ______
                </div>
              ))}
            </div>
            <p className="worksheet-key">
              {t('progress.answerKey')}{' '}
              {facts
                .map((f) => `${f.operandA}${OP_SYMBOL[f.operation]}${f.operandB}=${f.answer}`)
                .join('   ')}
            </p>
            <p className="worksheet-brand">✦ Fact Fluency</p>
          </div>
        </div>
      )}
    </>
  );
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
  const { t } = useTranslation();
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
          {t(`ops.${grid.operation}`)}
        </h2>
        <span className="grid-count">
          {mastered} / {grid.cells.length} {t('progress.masteredWord')}
          {threshold != null && (
            <span className="grid-fastbar">
              {' '}
              · {t('progress.fastUnder', { sec: (threshold / 1000).toFixed(1) })}
            </span>
          )}
        </span>
      </div>
      {fullyMastered && <CertificateButton kidName={kidName} operation={grid.operation} />}
      <div className="fact-grid">
        {grid.cells.map((c) => {
          const label = `${c.operandA} ${OP_SYMBOL[grid.operation]} ${c.operandB} = ${c.answer} · ${t(`progress.state.${c.state}`)}`;
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
