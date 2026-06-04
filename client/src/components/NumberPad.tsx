import './NumberPad.css';

interface Props {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  disabled?: boolean;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Chunky tactile number pad. Explicit submit (no auto-submit), per §4.7. */
export function NumberPad({ onDigit, onBackspace, onSubmit, canSubmit, disabled }: Props) {
  return (
    <div className="pad" aria-hidden={disabled}>
      {KEYS.map((k) => (
        <button key={k} className="pad-key" disabled={disabled} onClick={() => onDigit(k)}>
          {k}
        </button>
      ))}
      <button className="pad-key pad-fn" disabled={disabled} onClick={onBackspace} aria-label="Delete">
        ⌫
      </button>
      <button className="pad-key" disabled={disabled} onClick={() => onDigit('0')}>
        0
      </button>
      <button
        className="pad-key pad-go"
        disabled={disabled || !canSubmit}
        onClick={onSubmit}
        aria-label="Enter"
      >
        ↵
      </button>
    </div>
  );
}
