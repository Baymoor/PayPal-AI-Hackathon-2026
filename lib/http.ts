/** HTTP helpers shared by route handlers. */
import { ZodError, type ZodType } from "zod";
import { MoneyError } from "./domain/money";
import { PolicyError } from "./domain/policy";
import { IllegalTransitionError } from "./domain/state-machine";
import { isTransientConnectionError } from "./transient-errors";

/** How long we ask clients to wait before retrying after a transient outage. */
const TRANSIENT_RETRY_AFTER_SECONDS = 30;

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const unauthorized = (msg = "Sign in with your invitation link first") => new ServiceError("UNAUTHORIZED", 401, msg);
export const forbidden = (msg = "You do not have access to this") => new ServiceError("FORBIDDEN", 403, msg);
export const notFound = (msg = "Not found") => new ServiceError("NOT_FOUND", 404, msg);
export const conflict = (code: string, msg: string) => new ServiceError(code, 409, msg);
export const badRequest = (code: string, msg: string) => new ServiceError(code, 400, msg);

export function json(data: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(init.headers ?? {}) },
  });
}

/** Convert any thrown error into a safe JSON error response (no stack traces / secrets). */
export function errorResponse(err: unknown): Response {
  if (err instanceof ServiceError) {
    const headers: Record<string, string> = err.status === 429 ? { "retry-after": String(err.retryAfterSeconds ?? 30) } : {};
    return json({ error: { code: err.code, message: err.message } }, { status: err.status, headers });
  }
  if (err instanceof PolicyError) return json({ error: { code: err.code, message: err.message } }, { status: 422 });
  if (err instanceof MoneyError) return json({ error: { code: "INVALID_MONEY", message: err.message } }, { status: 422 });
  if (err instanceof IllegalTransitionError) return json({ error: { code: "INVALID_STATE", message: err.message } }, { status: 409 });
  if (err instanceof ZodError) return json({ error: { code: "INVALID_INPUT", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } }, { status: 400 });
  if (isTransientConnectionError(err)) return temporarilyUnavailableResponse(err);
  console.error("[outings] unhandled error", err instanceof Error ? err.message : err);
  return json({ error: { code: "INTERNAL", message: "Something went wrong. Nothing was charged by this request." } }, { status: 500 });
}

/**
 * A backing service (usually the database) was briefly unreachable. Say what
 * happened in plain words and when to retry; the request changed nothing.
 */
function temporarilyUnavailableResponse(err: unknown): Response {
  console.warn("[outings] request failed: a backing service was unreachable", err instanceof Error ? err.message : err);
  return json(
    {
      error: {
        code: "TEMPORARILY_UNAVAILABLE",
        message: `Outings couldn't reach one of its own services for a moment, so this request didn't go through and nothing changed. This is usually brief; please try again in about ${TRANSIENT_RETRY_AFTER_SECONDS} seconds.`,
      },
    },
    { status: 503, headers: { "retry-after": String(TRANSIENT_RETRY_AFTER_SECONDS) } },
  );
}

/** Wrap a route handler so thrown errors become JSON responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 64_000) throw badRequest("BODY_TOO_LARGE", "Request body too large");
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    throw badRequest("INVALID_JSON", "Request body must be JSON");
  }
  return schema.parse(body);
}

/** Basic same-origin check for state-changing cookie-authenticated requests (CSRF defence in depth). */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients / same-origin navigations without Origin
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (host && new URL(origin).host !== host) throw forbidden("Cross-origin request rejected");
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    throw forbidden("Cross-origin request rejected");
  }
}
