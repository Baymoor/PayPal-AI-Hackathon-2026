/**
 * Integration-test database helper. Each test file calls `useTestDb()` to get
 * a migrated, empty database at TEST_DATABASE_URL (default outings_test).
 * Parallel agents/CI jobs should each point TEST_DATABASE_URL at their own DB.
 */
import { afterAll, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "@/lib/db/client";

const TABLES = [
  "ai_runs",
  "audit_events",
  "jobs",
  "webhook_events",
  "payment_operations",
  "settlement_snapshots",
  "payment_attempts",
  "consents",
  "budget_votes",
  "participants",
  "quote_versions",
  "outings",
  "offerings",
  "merchants",
];

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL || "postgres://outings:outings@localhost:5432/outings_test";
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}

/** Registers lifecycle hooks; returns a getter for the db. */
export function useTestDb(opts: { truncateEach?: boolean } = {}): () => Db {
  let handle: ReturnType<typeof createDb> | null = null;
  beforeAll(async () => {
    handle = createDb(testDatabaseUrl());
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
    await truncateAll(handle.db);
  });
  if (opts.truncateEach ?? true) {
    beforeEach(async () => {
      if (handle) await truncateAll(handle.db);
    });
  }
  afterAll(async () => {
    await handle?.pool.end();
  });
  return () => {
    if (!handle) throw new Error("test db not initialised");
    return handle.db;
  };
}
