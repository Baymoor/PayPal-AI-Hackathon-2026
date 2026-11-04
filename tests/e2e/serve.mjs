/**
 * Web server for the e2e suite (playwright.config.ts `webServer.command`):
 * builds the production app into NEXT_DIST_DIR (skip with E2E_SKIP_BUILD=1 when a build exists),
 * then runs `next start` on E2E_PORT. `next build` rewrites tsconfig.json to add the custom dist dir's
 * type paths; we restore the committed file afterwards so the working tree stays clean.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const dist = process.env.NEXT_DIST_DIR || ".next-e2e";
const port = process.env.E2E_PORT || "3400";
const nextBin = "node_modules/next/dist/bin/next";

if (process.env.E2E_SKIP_BUILD !== "1" || !existsSync(`${dist}/BUILD_ID`)) {
  const tsconfig = readFileSync("tsconfig.json", "utf8");
  try {
    const r = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit", env: process.env });
    if (r.status !== 0) process.exit(r.status ?? 1);
  } finally {
    writeFileSync("tsconfig.json", tsconfig);
  }
}

const server = spawn(process.execPath, [nextBin, "start", "-p", port], { stdio: "inherit", env: process.env });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
server.on("exit", (code) => process.exit(code ?? 0));
