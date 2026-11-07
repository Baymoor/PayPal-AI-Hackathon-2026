/**
 * The one error type both HTTP clients (consumer `components/outing/api.ts`, merchant
 * `components/merchant/api.ts`) throw, so friendlyError.ts can explain any failure by its code.
 */
export class ApiError extends Error {
  constructor(
    /** The server's stable `error.code`, or one the client invents (NETWORK, NETWORK_READ, HTTP_<status>). */
    readonly code: string,
    readonly status: number,
    message: string,
    /** From the Retry-After header (429 / 503), so error copy can say how long to wait. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Retry-After in seconds; the HTTP-date form is ignored (our server only sends seconds). */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** Builds the error for a non-2xx response from its (possibly missing) `{ error: { code, message } }` body. */
export function apiErrorFromResponse(res: Response, body: unknown): ApiError {
  const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
  return new ApiError(
    err?.code ?? (res.status === 401 ? "UNAUTHORIZED" : res.status === 404 ? "NOT_FOUND" : "HTTP_" + res.status),
    res.status,
    err?.message ?? `Request failed (${res.status})`,
    parseRetryAfter(res.headers.get("retry-after")),
  );
}

/** fetch() itself failed. A dropped write may still have reached the server, so its outcome is unknown; a dropped read changed nothing. */
export function networkError(method: string | undefined): ApiError {
  const isRead = (method ?? "GET").toUpperCase() === "GET";
  return new ApiError(isRead ? "NETWORK_READ" : "NETWORK", 0, "We couldn't reach the server. Check your connection and try again.");
}
