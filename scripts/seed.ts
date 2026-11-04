/**
 * Seed the demo merchant, catalogue and clearly-labelled FIXTURE outings.
 *
 *   npm run db:seed       upsert catalogue, replace FIXTURE outings (real outings untouched)
 *   npm run demo:reset    DESTRUCTIVE: truncate every app table first, then seed
 *
 * Set SESSION_SECRET to the same value as the web app if you want the printed
 * persona links to work (the /demo page can always switch personas without them).
 */
import "./load-env";
import { createDb, databaseUrl } from "../lib/db/client";
import { seedDemo, truncateAppTables } from "../lib/demo/seed";

async function main() {
  const reset = process.argv.includes("--reset");
  const url = databaseUrl();
  const { db, pool } = createDb(url);
  try {
    if (reset) {
      await truncateAppTables(db);
      console.log("Truncated all app tables.");
    }
    const state = await seedDemo(db, { now: new Date() });
    console.log(`Seeded ${state.merchant?.name ?? "merchant"} into ${url.replace(/\/\/[^@]*@/, "//***@")}`);
    console.log(`FIXTURE outings (${state.outings.length}):`);
    for (const o of state.outings) console.log(`  ${o.status.padEnd(10)} ${o.cleanup.padEnd(14)} ${o.title}  /o/${o.outingId}`);
    const show = (label: string, outingId: string | null, personas: typeof state.personas) => {
      if (!outingId) return;
      console.log(`\n${label} (/o/${outingId}):`);
      for (const p of personas) console.log(`  ${p.displayName.padEnd(8)} ${p.hint.padEnd(32)} ${p.link ?? "(use /demo to switch persona)"}`);
    };
    show("Main demo personas", state.outingId, state.personas);
    show("Budget poker personas", state.budgetOutingId, state.budgetPersonas);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
