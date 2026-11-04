/**
 * Playwright global setup: migrate the e2e database and reset it to the demo seed
 * (DESTRUCTIVE: `npm run demo:reset` truncates every app table of E2E_ENV.DATABASE_URL).
 */
import { execFileSync } from "node:child_process";
import { E2E_ENV } from "./env";

export default function globalSetup(): void {
  const env = { ...process.env, ...E2E_ENV };
  const run = (script: string, ...args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", script, ...args], { env, stdio: ["ignore", "ignore", "inherit"], cwd: process.cwd() });
  run("scripts/migrate.ts");
  run("scripts/seed.ts", "--reset");
}
