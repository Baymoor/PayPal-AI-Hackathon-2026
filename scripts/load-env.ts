/**
 * Load `.env.local`, then `.env`, into process.env for the tsx scripts (migrate, seed, worker).
 * Next.js loads these files for the web app, but plain Node/tsx does not. Variables already set in
 * the environment win, then `.env.local`, then `.env` (the same precedence as Next.js).
 * Import this first, before anything that reads process.env.
 */
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    console.warn(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
