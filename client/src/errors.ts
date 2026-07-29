import type { TFunction } from 'i18next';

/**
 * Map an API error `code` to a translated, human-friendly message. The same
 * code can mean different things per surface (e.g. `email_taken` reads
 * differently on the account form vs. the guest-upgrade form), so each form
 * gets its own resolver rather than one shared map. Unknown codes fall back to
 * the surface's generic "couldn't save" message.
 */
export function editErrorText(t: TFunction, code: string): string {
  switch (code) {
    case 'invalid_display_name':
      return t('errors.invalidName');
    case 'invalid_avatar':
      return t('errors.invalidAvatar');
    case 'invalid_settings':
      return t('errors.invalidSettings');
    default:
      return t('errors.save');
  }
}

export function accountErrorText(t: TFunction, code: string): string {
  switch (code) {
    case 'invalid_email':
      return t('errors.invalidEmail');
    case 'weak_password':
      return t('errors.weakPassword');
    case 'email_taken':
      return t('errors.emailInUse');
    case 'invalid_timezone':
      return t('errors.invalidTimezone');
    case 'password_required':
      return t('errors.passwordRequired');
    case 'invalid_credentials':
      return t('errors.wrongPassword');
    default:
      return t('errors.save');
  }
}

export function upgradeErrorText(t: TFunction, code: string): string {
  switch (code) {
    case 'invalid_email':
      return t('errors.invalidEmail');
    case 'weak_password':
      return t('errors.weakPassword');
    case 'email_taken':
      return t('errors.emailTakenUpgrade');
    case 'not_a_guest':
      return t('errors.notAGuest');
    default:
      return t('errors.save');
  }
}
