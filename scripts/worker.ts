/**
 * Background worker: runs `runWorkerTick` in a loop.
 *
 *   npm run worker                 every 5000 ms
 *   npm run worker -- --interval 2000
 *   npm run worker:once            one tick, then exit
 */
import { hostname } from "node:os";
import { closeDb, getDb } from "../lib/db/client";
import { getPaymentProvider } from "../lib/payments";
import { runWorkerTick } from "../lib/jobs/runner";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

const once = process.argv.includes("--once");
const intervalMs = Math.max(500, Number(arg("--interval") ?? 5000) || 5000);
const workerId = `worker:${hostname()}:${process.pid}`;

let stopping = false;
let ticking: Promise<void> | null = null;

async function tick(): Promise<void> {
  const started = Date.now();
  try {
    const r = await runWorkerTick(getDb(), getPaymentProvider, { workerId });
    const ms = Date.now() - started;
    const summary = `jobs=${r.jobsRun} ops=${r.operationsRun} swept=${r.sweptOutings} errors=${r.errors.length} (${ms} ms)`;
    if (r.jobsRun || r.operationsRun || r.sweptOutings || r.errors.length) console.log(`[worker] ${new Date().toISOString()} ${summary}`);
    for (const e of r.errors) console.error(`[worker]   ${e}`);
  } catch (err) {
    console.error(`[worker] tick failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  console.log(`[worker] ${workerId} starting (${once ? "single tick" : `every ${intervalMs} ms`})`);
  if (once) {
    await tick();
    await closeDb();
    return;
  }
  while (!stopping) {
    ticking = tick();
    await ticking;
    ticking = null;
    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await closeDb();
  console.log("[worker] stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(`[worker] ${signal} received; finishing current tick…`);
    // If no tick is running, the loop exits on its next check; otherwise it finishes first.
    if (!ticking) setTimeout(() => void closeDb().finally(() => process.exit(0)), 50);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
