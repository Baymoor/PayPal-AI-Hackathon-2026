import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle has the same query API as the db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

const DEFAULT_URL = "postgres://outings:outings@localhost:5432/outings";

declare global {
  // eslint-disable-next-line no-var
  var __outingsPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __outingsDb: Db | undefined;
}

export function databaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_URL;
}

/** Process-wide pool (survives Next.js dev hot reloads). */
export function getPool(): Pool {
  if (!globalThis.__outingsPool) {
    globalThis.__outingsPool = new Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.DATABASE_POOL_MAX || 10),
    });
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
  const pool = new Pool({ connectionString: url, max: 5 });
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
