/**
 * A service-level error carrying the HTTP status the route layer should
 * return. Thrown by any service module (sessions, rewards, progress,
 * dashboard, export) and mapped to a JSON response by `handle()`
 * (api/handle.ts). Formerly `SessionError` — renamed once every service, not
 * just sessions, used it.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
