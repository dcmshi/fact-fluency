import type { ProfileSettings } from '@shared';

/**
 * Per-profile session settings: the defaults every new profile starts with and
 * the inclusive bounds an edit must stay within (DESIGN.md §4.4, §8). Single
 * source — the profiles router validates against these, the auth router seeds
 * guest profiles from them, and /catalog serves the bounds so the client's
 * settings form never drifts from the server's validation.
 */
export const DEFAULT_SETTINGS: ProfileSettings = {
  sessionCards: 20,
  sessionSeconds: 180,
  newPerSession: 3,
  comparisons: true,
  easyReadFont: false,
  highContrast: false,
  calmMode: false,
};

/** Bounds cover the numeric knobs only — `comparisons` is a boolean toggle. */
export type NumericSettingKey = 'sessionCards' | 'sessionSeconds' | 'newPerSession';
export type SettingBounds = Record<NumericSettingKey, [min: number, max: number]>;

export const SETTING_BOUNDS: SettingBounds = {
  sessionCards: [5, 50],
  sessionSeconds: [30, 600],
  newPerSession: [0, 10],
};
