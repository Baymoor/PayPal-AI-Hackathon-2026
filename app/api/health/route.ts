/** GET /api/health -> public mode summary + database ping. No secrets. */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { publicModeSummary } from "@/lib/env";
import { json } from "@/lib/http";

export async function GET(): Promise<Response> {
  let db: "ok" | "unavailable" = "ok";
  try {
    await getDb().execute(sql`select 1`);
  } catch {
    db = "unavailable";
  }
  let modes: ReturnType<typeof publicModeSummary> | null = null;
  try {
    modes = publicModeSummary();
  } catch {
    modes = null;
  }
  const ok = db === "ok" && modes !== null;
  return json({ ok, db, ...(modes ?? {}) }, { status: ok ? 200 : 503 });
}
