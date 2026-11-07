/**
 * Recognises "a backing service could not be reached just now" failures: a
 * database restart, a hosted Postgres closing idle sockets, a cold start, a
 * network blip. These are transient outages, not bugs, so the honest answer to
 * the user is "try again shortly" (503 + Retry-After), not a generic 500.
 */

/** Node socket-level failures. They carry no hint of which service failed. */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/** Postgres SQLSTATEs meaning "cannot serve you right now", as opposed to "your query is wrong". */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (server starting up)
  "53300", // too_many_connections
]);

/** SQLSTATE class 08 = connection exception (08000, 08003, 08006, ...). */
const CONNECTION_EXCEPTION_SQLSTATE_CLASS = "08";

/**
 * Messages node-postgres and pg-pool use when a connection is lost or never
 * established (pg/lib/client.js, pg-pool/index.js). They carry no `code`.
 */
const PG_CONNECTION_LOST_MESSAGES: readonly string[] = [
  "Connection terminated",
  "timeout exceeded when trying to connect",
  "is not queryable",
];

/** Drizzle and fetch wrap driver errors in `cause`; a few levels is plenty and guards against cycles. */
const MAX_CAUSE_DEPTH = 5;

export function isTransientConnectionError(err: unknown): boolean {
  return collectErrorChain(err).some(isConnectionFailure);
}

/** The error itself plus everything reachable through `cause` and AggregateError `errors`. */
function collectErrorChain(root: unknown): Error[] {
  const chain: Error[] = [];
  let frontier: unknown[] = [root];
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && frontier.length > 0; depth++) {
    const next: unknown[] = [];
    for (const candidate of frontier) {
      if (!(candidate instanceof Error)) continue;
      chain.push(candidate);
      if (candidate.cause !== undefined) next.push(candidate.cause);
      // Node reports a refused dual-stack connect (IPv4 + IPv6) as an AggregateError.
      if (candidate instanceof AggregateError) next.push(...candidate.errors);
    }
    frontier = next;
  }
  return chain;
}

function isConnectionFailure(err: Error): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && isUnavailableCode(code)) return true;
  return PG_CONNECTION_LOST_MESSAGES.some((fragment) => err.message.includes(fragment));
}

function isUnavailableCode(code: string): boolean {
  if (NETWORK_ERROR_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code)) return true;
  return code.length === 5 && code.startsWith(CONNECTION_EXCEPTION_SQLSTATE_CLASS);
}
