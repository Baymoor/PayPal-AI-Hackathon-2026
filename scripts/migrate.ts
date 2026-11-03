/** Apply SQL migrations in ./drizzle to DATABASE_URL. Usage: npm run db:migrate */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, databaseUrl } from "../lib/db/client";

async function main() {
  const url = process.argv[2] || databaseUrl();
  const { db, pool } = createDb(url);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log(`Migrations applied to ${url.replace(/\/\/[^@]*@/, "//***@")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
