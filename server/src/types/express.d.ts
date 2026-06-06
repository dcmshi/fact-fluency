import type { Profile } from '@shared';

/** Augment Express's Request with the authenticated account id (set by the
 *  auth middleware after resolving the session cookie) and, on profile-scoped
 *  routes, the owned profile loaded by `loadOwnedProfile`. */
declare global {
  namespace Express {
    interface Request {
      accountId?: string;
      profile?: Profile;
    }
  }
}

export {};
