import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle has the same query API as the db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

const DEFAULT_URL = "postgres://outings:outings@localhost:5432/outings";

/**
 * Fail a connection attempt after this long instead of waiting forever. Long
 * enough for a scale-to-zero hosted Postgres to wake up; short enough that a
 * request answers "try again shortly" (503) rather than hanging.
 */
const CONNECT_TIMEOUT_MS = 10_000;

declare global {
  var __outingsPool: Pool | undefined;
  var __outingsDb: Db | undefined;
}

export function databaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_URL;
}

/** Every pool in the app (web, worker, scripts, tests) is built here so it gets the same safety net. */
function createPool(connectionString: string, max: number): Pool {
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // An idle pooled connection can be closed by the server at any time (restart,
  // hosted Postgres reaping idle sockets). pg reports that as an 'error' event on
  // the pool, outside any awaited call, so no try/catch ever sees it. Node treats
  // an 'error' event with no listener as a crash. pg has already discarded the
  // broken client, and the next query opens a fresh one, so logging is enough.
  pool.on("error", logDroppedIdleConnection);
  return pool;
}

function logDroppedIdleConnection(err: Error): void {
  console.warn(`[outings] database connection dropped; the pool will reconnect on next use (${err.message})`);
}

/** Process-wide pool (survives Next.js dev hot reloads). */
export function getPool(): Pool {
  if (!globalThis.__outingsPool) {
    globalThis.__outingsPool = createPool(databaseUrl(), Number(process.env.DATABASE_POOL_MAX || 10));
  }
  return globalThis.__outingsPool;
}

export function getDb(): Db {
  if (!globalThis.__outingsDb) {
    globalThis.__outingsDb = drizzle(getPool(), { schema });
  }
  return globalThis.__outingsDb;
}

/** For tests/scripts: create an isolated db bound to a specific URL. */
export function createDb(url: string): { db: Db; pool: Pool } {
  const pool = createPool(url, 5);
  return { db: drizzle(pool, { schema }), pool };
}

export async function closeDb(): Promise<void> {
  if (globalThis.__outingsPool) {
    await globalThis.__outingsPool.end();
    globalThis.__outingsPool = undefined;
    globalThis.__outingsDb = undefined;
  }
}

export { schema };
