import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RewardItem } from '@shared';
import { api } from '../../api';
import { profile } from '../../test/fixtures';
import { renderWithProviders } from '../../test/harness';
import { RewardsModal } from './RewardsModal';

const catalog: RewardItem[] = [
  { id: 'muncher-fox', kind: 'muncher', value: 'fox', cost: 20, label: 'Fox' },
  { id: 'theme-midnight', kind: 'theme', value: 'midnight', cost: 80, label: 'Midnight' },
];

const rewards = {
  coins: 40,
  owned: ['muncher-fox'],
  catalog,
  equippedAvatar: '🦊',
  equippedTheme: 'classic',
  equippedMuncher: 'cat',
  equippedEffect: 'confetti',
};

const open = () => renderWithProviders(<RewardsModal profile={profile} onClose={() => {}} />);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RewardsModal', () => {
  it('lists the catalog once loaded', async () => {
    vi.spyOn(api, 'rewards').mockResolvedValue(rewards);
    open();
    expect(await screen.findByTitle(/fox/i)).toBeTruthy();
  });

  /**
   * A failed fetch used to leave five sections of shimmer tiles up for good —
   * indistinguishable from still loading, with nothing to say so and nothing to
   * retry. Profiles and Progress both already handled isError.
   */
  it('offers a retry when the shop will not load', async () => {
    const fetchRewards = vi.spyOn(api, 'rewards').mockRejectedValue(new Error('offline'));
    open();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn.t load/i);
    expect(document.querySelectorAll('.reward-skel')).toHaveLength(0);

    fetchRewards.mockResolvedValue(rewards);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await screen.findByTitle(/fox/i)).toBeTruthy();
    expect(fetchRewards).toHaveBeenCalledTimes(2);
  });
});
