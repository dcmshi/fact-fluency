import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactSet } from '@shared';
import { api } from '../../api';
import { profile } from '../../test/fixtures';
import { renderWithProviders } from '../../test/harness';
import { FactSetsModal } from './FactSetsModal';

const catalog: FactSet[] = [
  {
    id: 'add-0-5',
    operation: 'add',
    label: 'Addition 0–5',
    rangeSpec: { aMin: 0, aMax: 5, bMin: 0, bMax: 5 },
  },
  {
    id: 'add-0-10',
    operation: 'add',
    label: 'Addition 0–10',
    rangeSpec: { aMin: 0, aMax: 10, bMin: 0, bMax: 10 },
  },
];

/** A promise the test resolves by hand, to hold the query in its pending state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const save = () => screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('FactSetsModal', () => {
  /**
   * `enabled` starts as an empty Set and is only filled when the query lands, so
   * a Save that is reachable while loading writes "no sets enabled" to the kid's
   * profile — and their next session dies with no_enabled_sets.
   */
  it('disables Save until the catalog has loaded', async () => {
    const pending = deferred<{ catalog: FactSet[]; enabledIds: string[] }>();
    vi.spyOn(api, 'getFactSets').mockReturnValue(pending.promise);
    const setFactSets = vi.spyOn(api, 'setFactSets');

    renderWithProviders(<FactSetsModal profile={profile} onClose={() => {}} />);

    expect(screen.getByText(/loading/i)).toBeTruthy();
    expect(save().disabled).toBe(true);

    pending.resolve({ catalog, enabledIds: ['add-0-5'] });
    await waitFor(() => expect(save().disabled).toBe(false));
    expect(setFactSets).not.toHaveBeenCalled();
  });

  it('saves the sets that are enabled once loaded', async () => {
    vi.spyOn(api, 'getFactSets').mockResolvedValue({ catalog, enabledIds: ['add-0-5'] });
    const setFactSets = vi.spyOn(api, 'setFactSets').mockResolvedValue({ enabledIds: [] });
    const onClose = vi.fn();

    renderWithProviders(<FactSetsModal profile={profile} onClose={onClose} />);
    await waitFor(() => expect(save().disabled).toBe(false));

    save().click();

    await waitFor(() => expect(setFactSets).toHaveBeenCalledWith('p1', ['add-0-5']));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
