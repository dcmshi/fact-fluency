/**
 * Kid/parent-friendly strings for API error codes. One base map for the auth
 * codes every form shares; screens spread in their own context-specific
 * overrides (e.g. what "email taken" should suggest doing *here*).
 */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_email: 'That email doesn’t look right.',
  weak_password: 'Password needs at least 8 characters.',
  email_taken: 'That email is already in use.',
};

export const EDIT_ERROR_MESSAGES: Record<string, string> = {
  invalid_display_name: 'Please enter a name.',
  invalid_avatar: 'Pick a buddy.',
  invalid_settings: 'Those settings are out of range.',
};

export const FALLBACK_MESSAGE = 'Couldn’t save — try again.';
