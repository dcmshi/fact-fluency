import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Box, CellState, ProgressGrid, ProgressView } from '@shared';
import { api } from '../api';
import { OP_HEX, OP_LABEL, OP_SYMBOL } from '../ops';
import './ProgressPage.css';

/** Mastery shade: pale for unseen, deepening to the solid op color at box 5. */
function cellColor(op: keyof typeof OP_HEX, box: Box | null, state: CellState): string {
  if (state === 'unseen' || box === null) return '#f1e7d5';
  const alpha = [0.22, 0.36, 0.5, 0.64, 0.8, 1][box] ?? 0.22;
  const hex = OP_HEX[op];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function ProgressPage() {
  const { profileId = '' } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<ProgressView | null>(null);

  useEffect(() => {
    api.progress(profileId).then(setView);
  }, [profileId]);

  return (
    <div className="screen">
      <header className="hub-header">
        <button className="btn ghost" onClick={() => navigate('/')}>
          ← Back
        </button>
        <div className="brand" style={{ fontSize: '1.1rem' }}>
          Progress
        </div>
      </header>

      <div className="stack" style={{ maxWidth: 720 }}>
        {!view && <p className="muted">Loading…</p>}
        {view?.grids.length === 0 && (
          <p className="muted">No fact sets enabled yet — pick some from the profiles screen.</p>
        )}
        {view?.grids.map((grid) => (
          <OperationGrid key={grid.operation} grid={grid} />
        ))}

        {view && view.grids.length > 0 && (
          <div className="legend">
            <span className="legend-label">Less practiced</span>
            <div className="legend-swatches">
              {[null, 0, 1, 2, 3, 4, 5].map((b, i) => (
                <span
                  key={i}
                  className="legend-swatch"
                  style={{ background: cellColor('mul', b as Box | null, b === null ? 'unseen' : 'review') }}
                />
              ))}
            </div>
            <span className="legend-label">Mastered</span>
          </div>
        )}
      </div>
    </div>
  );
}

function OperationGrid({ grid }: { grid: ProgressGrid }) {
  const mastered = grid.cells.filter((c) => c.state === 'mastered').length;
  return (
    <section className="grid-card card rise">
      <div className="grid-head">
        <h2>
          <span className="op-sym" style={{ color: OP_HEX[grid.operation] }}>
            {OP_SYMBOL[grid.operation]}
          </span>{' '}
          {OP_LABEL[grid.operation]}
        </h2>
        <span className="grid-count">
          {mastered} / {grid.cells.length} mastered
        </span>
      </div>
      <div className="fact-grid">
        {grid.cells.map((c) => (
          <div
            key={`${c.operandA}-${c.operandB}`}
            className="fact-cell"
            style={{ background: cellColor(grid.operation, c.box, c.state) }}
            title={`${c.operandA} ${OP_SYMBOL[grid.operation]} ${c.operandB} = ${c.answer} · ${c.state}`}
          >
            <span className="fact-cell-text">
              {c.operandA}
              {OP_SYMBOL[grid.operation]}
              {c.operandB}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
