/**
 * READ-ONLY check that an outing the app settled in PAYPAL_SANDBOX mode matches
 * what PayPal itself recorded. It reads the outing's PayPal authorizations from
 * the database, GETs each one from the PayPal REST sandbox, and compares the
 * captured amounts. It never creates, captures, voids or refunds anything.
 *
 *   npx tsx scripts/paypal-verify-outing.ts <outingId> [--database-url=postgres://…]
 *
 * Credentials come from the shell or .env.local / .env (PAYPAL_CLIENT_ID,
 * PAYPAL_CLIENT_SECRET); the database from --database-url or DATABASE_URL.
 * Writes REDACTED evidence (ids truncated; people shown as roles, never names)
 * to docs/evidence/paypal-outing-<timestamp>.json. Exits non-zero if any
 * authorization cannot be read or does not match the app's records.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDb } from "../lib/db/client";
import { PaypalProvider, PAYPAL_SANDBOX_API_BASE } from "../lib/payments/paypal";

/* --------------------------------- types --------------------------------- */

interface OutingRow {
  status: string;
  deadline_at: Date;
  decision: string | null;
  total_minor: number | null;
}

interface AttemptRow {
  role: string;
  authorization_id: string;
  status: string;
  authorized_minor: number;
  captured_minor: number;
}

interface PaypalCaptureEvidence {
  captureRef: string;
  status: string;
  amountMinor: number;
  finalCapture: boolean;
}

type PaypalAuthorizationEvidence =
  | { status: string; authorizedMinor: number; captures: PaypalCaptureEvidence[] }
  | { error: { kind: string; code: string } };

interface PayerEvidence {
  role: string;
  authorizationRef: string;
  app: { status: string; authorizedMinor: number; capturedMinor: number };
  paypal: PaypalAuthorizationEvidence;
  appMatchesPaypal: boolean;
}

interface OutingEvidence {
  tool: string;
  environment: string;
  apiBase: string;
  checkedAt: string;
  redaction: string;
  outing: { status: string; deadlineAt: string; decision: string | null; totalMinor: number | null };
  payers: PayerEvidence[];
  findings: { allMatch: boolean; authorizedTotalMinor: number; capturedTotalMinor: number };
}

/* ------------------------------ configuration ----------------------------- */

function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
    } catch {
      /* ignore malformed env files */
    }
  }
}

function parseArgs(argv: string[]): { outingId: string; databaseUrl: string } {
  const outingId = argv.find((a) => !a.startsWith("--"));
  const databaseUrl = argv.find((a) => a.startsWith("--database-url="))?.slice("--database-url=".length) ?? process.env.DATABASE_URL;
  if (!outingId || !databaseUrl) {
    console.error("usage: npx tsx scripts/paypal-verify-outing.ts <outingId> [--database-url=postgres://…]");
    process.exit(2);
  }
  return { outingId, databaseUrl };
}

function sandboxProvider(): PaypalProvider {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app) are required. Nothing was read.");
    process.exit(2);
  }
  return new PaypalProvider({ clientId, clientSecret, apiBase: PAYPAL_SANDBOX_API_BASE });
}

/* --------------------------------- reads ---------------------------------- */

const redact = (id: string): string => `${id.slice(0, 3)}…${id.slice(-4)}`;

async function readOuting(pool: ReturnType<typeof createDb>["pool"], outingId: string): Promise<OutingRow> {
  const { rows } = await pool.query<OutingRow>(
    `select o.status, o.deadline_at, s.decision, s.total_minor
       from outings o left join settlement_snapshots s on s.outing_id = o.id
      where o.id = $1`,
    [outingId],
  );
  if (!rows[0]) throw new Error(`outing ${outingId} not found`);
  return rows[0];
}

/** Roles ("organizer", "invitee 1", …) instead of display names: evidence never carries people's names. */
async function readPaypalAttempts(pool: ReturnType<typeof createDb>["pool"], outingId: string): Promise<AttemptRow[]> {
  const { rows } = await pool.query<AttemptRow>(
    `select case when p.role = 'ORGANIZER' then 'organizer'
                 else 'invitee ' || row_number() over (partition by p.role order by p.created_at) end as role,
            a.authorization_id, a.status, a.authorized_minor, a.captured_minor
       from payment_attempts a join participants p on p.id = a.participant_id
      where a.outing_id = $1 and a.provider = 'PAYPAL' and a.authorization_id is not null
      order by p.created_at`,
    [outingId],
  );
  return rows;
}

/* ------------------------------- comparison ------------------------------- */

async function verifyAttempt(paypal: PaypalProvider, row: AttemptRow): Promise<PayerEvidence> {
  const app = { status: row.status, authorizedMinor: row.authorized_minor, capturedMinor: row.captured_minor };
  const base = { role: row.role, authorizationRef: redact(row.authorization_id), app };
  const res = await paypal.getAuthorization(row.authorization_id);
  if (!res.ok) {
    return { ...base, paypal: { error: { kind: res.kind, code: res.code } }, appMatchesPaypal: false };
  }
  const { authorization } = res;
  const capturedAtPaypal = authorization.captures.filter((c) => c.status === "COMPLETED").reduce((sum, c) => sum + c.amountMinor, 0);
  return {
    ...base,
    paypal: {
      status: authorization.status,
      authorizedMinor: authorization.amountMinor,
      captures: authorization.captures.map((c) => ({
        captureRef: redact(c.captureId),
        status: c.status,
        amountMinor: c.amountMinor,
        finalCapture: c.finalCapture,
      })),
    },
    appMatchesPaypal: capturedAtPaypal === row.captured_minor && authorization.amountMinor === row.authorized_minor,
  };
}

function buildEvidence(outing: OutingRow, payers: PayerEvidence[]): OutingEvidence {
  return {
    tool: "scripts/paypal-verify-outing.ts (read-only)",
    environment: "PayPal REST sandbox",
    apiBase: PAYPAL_SANDBOX_API_BASE,
    checkedAt: new Date().toISOString(),
    redaction: "ids truncated to first 3 / last 4 chars; people shown as roles; no names, emails, tokens or secrets",
    outing: {
      status: outing.status,
      deadlineAt: outing.deadline_at.toISOString(),
      decision: outing.decision,
      totalMinor: outing.total_minor,
    },
    payers,
    findings: {
      allMatch: payers.length > 0 && payers.every((p) => p.appMatchesPaypal),
      authorizedTotalMinor: payers.reduce((sum, p) => sum + p.app.authorizedMinor, 0),
      capturedTotalMinor: payers.reduce((sum, p) => sum + p.app.capturedMinor, 0),
    },
  };
}

function writeEvidence(evidence: OutingEvidence): string {
  const dir = path.join("docs", "evidence");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `paypal-outing-${evidence.checkedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  return file;
}

function describe(p: PayerEvidence): string {
  const paypal = "error" in p.paypal ? `ERROR ${p.paypal.error.kind} ${p.paypal.error.code}` : `${p.paypal.status}, captures ${p.paypal.captures.map((c) => c.amountMinor).join("+") || "none"}`;
  return `  [${p.appMatchesPaypal ? "MATCH" : "MISMATCH"}] ${p.role}: app ${p.app.status} ${p.app.capturedMinor}/${p.app.authorizedMinor} | PayPal ${paypal}`;
}

/* ---------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  loadEnvFiles();
  const { outingId, databaseUrl } = parseArgs(process.argv.slice(2));
  const paypal = sandboxProvider();
  const { pool } = createDb(databaseUrl);
  try {
    const outing = await readOuting(pool, outingId);
    const attempts = await readPaypalAttempts(pool, outingId);
    const payers: PayerEvidence[] = [];
    for (const row of attempts) payers.push(await verifyAttempt(paypal, row));

    const evidence = buildEvidence(outing, payers);
    console.log(`Outing ${outing.status} (${outing.decision ?? "no decision"}), ${payers.length} PayPal authorization(s):`);
    for (const p of payers) console.log(describe(p));
    console.log(`Captured ${evidence.findings.capturedTotalMinor} of ${evidence.findings.authorizedTotalMinor} authorized (minor units).`);
    console.log(`Evidence (redacted) written to ${writeEvidence(evidence)}`);
    if (!evidence.findings.allMatch) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("verification failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
