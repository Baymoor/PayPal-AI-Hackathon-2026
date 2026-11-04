/** GET /api/demo/personas (demo only): personas of the seeded FIXTURE demo outings. */
import { getDb } from "@/lib/db/client";
import { config } from "@/lib/env";
import { handle, json, notFound } from "@/lib/http";
import { listDemoState } from "@/lib/demo/seed";

export const GET = handle(async () => {
  if (!config().demoFixturesEnabled) throw notFound();
  return json(await listDemoState(getDb()));
});
