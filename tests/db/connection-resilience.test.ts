/**
 * The database going away must degrade gracefully: a dropped idle connection
 * must not crash the process, and a request that cannot reach Postgres must
 * answer 503 "try again shortly" instead of hanging or returning a bare 500.
 */
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@/lib/db/client";
import { handle, json } from "@/lib/http";
import { isTransientConnectionError } from "@/lib/transient-errors";
import { testDatabaseUrl } from "../helpers/db";

/** Port 1 on loopback refuses connections immediately: a stand-in for "database down". */
const UNREACHABLE_DATABASE_URL = "postgres://outings:outings@127.0.0.1:1/outings";

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("database connection resilience (integration)", () => {
  it("survives the server dropping an idle pooled connection, then reconnects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = createDb(testDatabaseUrl());
    const admin = createDb(testDatabaseUrl());
    try {
      const client = await app.pool.connect();
      const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      client.release(); // back in the pool, idle

      // What a Postgres restart or a hosted provider reaping idle sockets looks like.
      await admin.pool.query("select pg_terminate_backend($1)", [rows[0].pid]);

      // Without the pool 'error' listener this event is an uncaught exception and Vitest fails the run.
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("database connection dropped")), { timeout: 5_000 });
      const result = await app.db.execute(sql`select 1 as ok`);
      expect(result.rows[0]).toEqual({ ok: 1 });
    } finally {
      warn.mockRestore();
      await app.pool.end();
      await admin.pool.end();
    }
  });

  it("answers 503 with a retry hint when the database cannot be reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unreachable = createDb(UNREACHABLE_DATABASE_URL);
    try {
      const route = handle(async () => {
        await unreachable.db.execute(sql`select 1`);
        return json({ ok: true });
      });

      const res = await route();

      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("30");
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("TEMPORARILY_UNAVAILABLE");
      expect(body.error.message).toMatch(/try again in about 30 seconds/);
    } finally {
      warn.mockRestore();
      await unreachable.pool.end();
    }
  });
});

describe("isTransientConnectionError (classification heuristic)", () => {
  it.each([
    ["pg-pool connect timeout", new Error("timeout exceeded when trying to connect")],
    ["server closed the connection", new Error("Connection terminated unexpectedly")],
    ["query on a broken client", new Error("Client has encountered a connection error and is not queryable")],
    ["refused, wrapped by the ORM", new Error("Failed query: select 1", { cause: withCode("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED") })],
    ["refused on IPv4 and IPv6", new AggregateError([withCode("v6", "ECONNREFUSED"), withCode("v4", "ECONNREFUSED")], "connect failed")],
    ["Postgres still starting up", withCode("the database system is starting up", "57P03")],
    ["SQLSTATE class 08", withCode("connection failure", "08006")],
    ["too many connections", withCode("sorry, too many clients already", "53300")],
  ])("treats %s as transient", (_label, err) => {
    expect(isTransientConnectionError(err)).toBe(true);
  });

  it.each([
    ["unique violation (a real bug or race, not an outage)", withCode("duplicate key value", "23505")],
    ["plain application error", new Error("boom")],
    ["non-error thrown value", "Connection terminated"],
    ["null", null],
  ])("does not treat %s as transient", (_label, err) => {
    expect(isTransientConnectionError(err)).toBe(false);
  });

  it("terminates on a self-referencing cause chain", () => {
    const loop = new Error("loop");
    (loop as { cause?: unknown }).cause = loop;
    expect(isTransientConnectionError(loop)).toBe(false);
  });
});
