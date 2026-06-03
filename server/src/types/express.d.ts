/** Augment Express's Request with the authenticated account id (set by the
 *  auth middleware after resolving the session cookie). */
declare global {
  namespace Express {
    interface Request {
      accountId?: string;
    }
  }
}

export {};
