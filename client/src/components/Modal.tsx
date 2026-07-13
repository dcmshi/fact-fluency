import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './Modal.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog shell: focus moves into the dialog on open (respecting a
 * child's autoFocus), Tab is trapped inside, Esc closes, and focus returns to
 * the trigger on close. Backdrop click closes; clicks inside don't.
 */
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Capture the trigger on first render — before any child autoFocus runs in
  // commit — so we restore focus to it (not an unmounted field) on close.
  const [previouslyFocused] = useState<HTMLElement | null>(
    () => document.activeElement as HTMLElement | null,
  );

  // a11y: move focus into the dialog on open, trap Tab within it, close on Esc,
  // and restore focus to the trigger on close. Runs once (close lives in a ref).
  useEffect(() => {
    const node = ref.current;
    const items = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    // Respect a child's autoFocus (e.g. the name field); only pull focus in if
    // it isn't already inside the dialog.
    if (node && !node.contains(document.activeElement)) (items()[0] ?? node).focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = items();
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    node?.addEventListener('keydown', onKey);
    return () => {
      node?.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [previouslyFocused]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal card stack"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
