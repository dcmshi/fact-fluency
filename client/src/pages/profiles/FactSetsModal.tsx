import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FactSet, Operation, Profile } from '@shared';
import { api, qk } from '../../api';
import { Modal } from '../../components/Modal';
import { OP_SYMBOL } from '../../ops';

export function FactSetsModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState<Set<string>>(new Set());

  const { data } = useQuery({
    queryKey: qk.factSets(profile.id),
    queryFn: () => api.getFactSets(profile.id),
  });
  const catalog = data?.catalog ?? null;
  useEffect(() => {
    if (data) setEnabled(new Set(data.enabledIds));
  }, [data]);

  function toggle(id: string) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const [error, setError] = useState<string | null>(null);
  const saveMut = useMutation({
    mutationFn: () => api.setFactSets(profile.id, [...enabled]),
    onSuccess: () => {
      // Enabled sets change the progress grid + dashboard mastery — refresh both.
      void queryClient.invalidateQueries({ queryKey: qk.factSets(profile.id) });
      void queryClient.invalidateQueries({ queryKey: qk.progress(profile.id) });
      void queryClient.invalidateQueries({ queryKey: qk.dashboard(profile.id) });
      onClose();
    },
    onError: () => setError(t('errors.save')),
  });
  const busy = saveMut.isPending;

  function save() {
    setError(null);
    saveMut.mutate();
  }

  const grouped = (catalog ?? []).reduce<Record<string, FactSet[]>>((acc, s) => {
    (acc[s.operation] ??= []).push(s);
    return acc;
  }, {});

  return (
    <Modal
      onClose={onClose}
      title={t('modals.factsTitle', { avatar: profile.avatar, name: profile.displayName })}
    >
      {!catalog && <p className="muted">{t('common.loading')}</p>}
      {error && <div className="error-banner">{error}</div>}
      {Object.entries(grouped).map(([op, sets]) => (
        <div key={op} className="set-group">
          <div className="set-group-title">
            {t(`ops.${op as Operation}`)}{' '}
            <span className="op-sym" aria-hidden="true">
              {OP_SYMBOL[op as keyof typeof OP_SYMBOL]}
            </span>
          </div>
          <div className="set-options">
            {sets.map((s) => (
              <button
                key={s.id}
                className={`set-pill ${op} ${enabled.has(s.id) ? 'on' : ''}`}
                onClick={() => toggle(s.id)}
                aria-pressed={enabled.has(s.id)}
                aria-label={s.label}
              >
                {s.label.replace(/^[A-Za-z]+ /, '')}
              </button>
            ))}
          </div>
          {/* Standards alignment for whatever's enabled — a parent/teacher signal. */}
          {sets
            .filter((s) => enabled.has(s.id) && s.standards)
            .map((s) => (
              <div key={`std-${s.id}`} className="set-standards">
                <strong>{s.label.replace(/^[A-Za-z]+ /, '')}</strong> · {s.standards}
              </div>
            ))}
        </div>
      ))}
      <button className="btn sun full" disabled={busy} onClick={save}>
        {busy ? t('common.saving') : t('common.save')}
      </button>
    </Modal>
  );
}
