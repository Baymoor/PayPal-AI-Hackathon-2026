/**
 * PayPal SANDBOX smoke test for the Outings payment adapter.
 *
 * Run by the project owner on their own machine with real SANDBOX credentials
 * (this repo's CI/agent containers cannot reach api-m.sandbox.paypal.com):
 *
 *   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… npx tsx scripts/paypal-smoke.ts [--mock-decline] [--approval-timeout=600] [--only=capture,void,refund]
 *
 * (Values are also read from .env.local if present.) For each flow the script
 * prints a sandbox approval link: open it, log in as a sandbox PERSONAL buyer
 * and approve. Landing on example.com afterwards is expected.
 *
 * Flows (all through lib/payments/paypal.ts, i.e. the real adapter):
 *   capture: AUTHORIZE $20 -> approve -> authorize -> capture $10 final_capture
 *            -> replay capture (same PayPal-Request-Id) -> GET authorization
 *            (records what happened to the $10 remainder) -> void remainder if still open
 *   void:    AUTHORIZE $20 -> approve -> authorize -> [--mock-decline: capture with
 *            PayPal-Mock-Response INSTRUMENT_DECLINED] -> void -> GET -> capture-after-void
 *   refund:  AUTHORIZE $20 -> approve -> authorize -> capture $20 -> refund $20 -> GET refund
 *
 * Writes REDACTED evidence (ids truncated; no emails, names, tokens or links)
 * to docs/evidence/paypal-sandbox-<timestamp>.json.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PaypalProvider, PAYPAL_SANDBOX_API_BASE } from "../lib/payments/paypal";
import type { ProviderResult } from "../lib/payments/provider";

/* --------------------------------- args ---------------------------------- */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const MOCK_DECLINE = flag("mock-decline");
const APPROVAL_TIMEOUT_MS = Number(opt("approval-timeout") ?? 600) * 1000;
const ONLY = new Set((opt("only") ?? "capture,void,refund").split(",").map((s) => s.trim()));
const RETURN_URL = opt("return-url") ?? "https://example.com/outings-paypal-smoke/return";
const CANCEL_URL = opt("cancel-url") ?? "https://example.com/outings-paypal-smoke/cancel";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* ignore malformed env files */
    }
  }
}

const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app) are required. Nothing was run.");
  process.exit(2);
}

const paypal = new PaypalProvider({
  clientId,
  clientSecret,
  apiBase: PAYPAL_SANDBOX_API_BASE,
  merchantId: process.env.PAYPAL_MERCHANT_ID?.trim() || undefined,
});

/* ------------------------------- evidence -------------------------------- */

const redact = (id: string | undefined | null): string | null => (id ? (id.length > 8 ? `${id.slice(0, 3)}…${id.slice(-4)}` : "…") : null);

interface Step {
  step: string;
  at: string;
  ok: boolean;
  expectation?: string;
  met?: boolean;
  kind?: string;
  code?: string;
  httpStatus?: number;
  debugId?: string;
  data?: Record<string, unknown>;
}
interface Flow {
  name: string;
  steps: Step[];
}

const evidence = {
  tool: "scripts/paypal-smoke.ts",
  environment: "PayPal REST sandbox",
  apiBase: PAYPAL_SANDBOX_API_BASE,
  runAt: new Date().toISOString(),
  mockDecline: MOCK_DECLINE,
  redaction: "ids truncated to first 3 / last 4 chars; no buyer emails, names, tokens, secrets or approval links are stored",
  flows: [] as Flow[],
  findings: {} as Record<string, unknown>,
};

function record<T>(flow: Flow, step: string, r: ProviderResult<T>, data: Record<string, unknown> = {}, expectation?: { text: string; met: boolean }): void {
  const s: Step = { step, at: new Date().toISOString(), ok: r.ok, data };
  if (!r.ok) Object.assign(s, { kind: r.kind, code: r.code, httpStatus: r.httpStatus, debugId: r.debugId });
  if (expectation) Object.assign(s, { expectation: expectation.text, met: expectation.met });
  flow.steps.push(s);
  const mark = expectation ? (expectation.met ? "PASS" : "FAIL") : r.ok ? "ok" : "ERR";
  console.log(`  [${mark}] ${step}${r.ok ? "" : ` -> ${r.kind} ${r.code}${r.debugId ? ` (debug_id ${r.debugId})` : ""}`}`);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/* -------------------------------- helpers -------------------------------- */

/** Create a $amount AUTHORIZE order, wait for buyer approval, authorize. Returns ids or null. */
async function approvedAuthorization(flow: Flow, amountMinor: number): Promise<{ orderId: string; authorizationId: string } | null> {
  const attemptId = randomUUID();
  const created = await paypal.createAuthorizeOrder({
    requestId: `smoke-order-${attemptId}`,
    paymentAttemptId: attemptId,
    amountMinor,
    currency: "USD",
    description: `Outings sandbox smoke test (${flow.name})`,
    returnUrl: RETURN_URL,
    cancelUrl: CANCEL_URL,
  });
  record(flow, "create AUTHORIZE order", created, created.ok ? { orderRef: redact(created.orderId), providerStatus: created.providerStatus, hasApproveLink: !!created.approveUrl } : {});
  if (!created.ok || !created.approveUrl) return null;

  console.log(`\n  >>> Approve as a sandbox PERSONAL buyer: ${created.approveUrl}\n`);
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  let status = "";
  while (Date.now() < deadline) {
    const o = await paypal.getOrder(created.orderId);
    if (o.ok) {
      status = o.order.providerStatus;
      if (status === "APPROVED") break;
    }
    await sleep(5000);
  }
  flow.steps.push({ step: "buyer approval", at: new Date().toISOString(), ok: status === "APPROVED", data: { orderStatus: status || "UNREADABLE" } });
  if (status !== "APPROVED") {
    console.log(`  [FAIL] order not approved within ${APPROVAL_TIMEOUT_MS / 1000}s (status ${status || "?"})`);
    return null;
  }

  const auth = await paypal.authorizeOrder({ orderId: created.orderId, requestId: `smoke-authorize-${attemptId}` });
  record(
    flow,
    "authorize order",
    auth,
    auth.ok
      ? {
          authorizationRef: redact(auth.authorization.authorizationId),
          status: auth.authorization.providerStatus,
          amountMinor: auth.authorization.amountMinor,
          customIdMatches: auth.authorization.customId === attemptId,
          createTime: auth.authorization.createTime.toISOString(),
          expirationTime: auth.authorization.expirationTime?.toISOString() ?? null,
          validityDays: auth.authorization.expirationTime
            ? Math.round((auth.authorization.expirationTime.getTime() - auth.authorization.createTime.getTime()) / 86_400_000)
            : null,
        }
      : {},
    { text: `authorization CREATED for exactly ${amountMinor} minor units`, met: auth.ok && auth.authorization.status === "CREATED" && auth.authorization.amountMinor === amountMinor },
  );
  return auth.ok ? { orderId: created.orderId, authorizationId: auth.authorization.authorizationId } : null;
}

/* --------------------------------- flows --------------------------------- */

async function captureFlow(): Promise<void> {
  const flow: Flow = { name: "under-capture: authorize $20, capture $10 with final_capture", steps: [] };
  evidence.flows.push(flow);
  console.log(`\n== ${flow.name}`);
  const ids = await approvedAuthorization(flow, 2000);
  if (!ids) return;
  const reqId = `smoke-capture-${randomUUID()}`;
  const cap = await paypal.captureAuthorization({ authorizationId: ids.authorizationId, amountMinor: 1000, currency: "USD", requestId: reqId });
  record(
    flow,
    "capture $10 (final_capture=true)",
    cap,
    cap.ok ? { captureRef: redact(cap.capture.captureId), status: cap.capture.providerStatus, amountMinor: cap.capture.amountMinor, finalCapture: cap.capture.finalCapture } : {},
    { text: "capture of 1000 COMPLETED (or PENDING)", met: cap.ok && cap.capture.amountMinor === 1000 && ["COMPLETED", "PENDING"].includes(cap.capture.status) },
  );
  evidence.findings.underCaptureSupported = cap.ok && cap.capture.amountMinor === 1000;

  const replay = await paypal.captureAuthorization({ authorizationId: ids.authorizationId, amountMinor: 1000, currency: "USD", requestId: reqId });
  record(flow, "replay capture with the same PayPal-Request-Id", replay, replay.ok ? { sameCapture: cap.ok && replay.capture.captureId === cap.capture.captureId } : {}, {
    text: "idempotent replay returns the same capture",
    met: cap.ok && replay.ok && replay.capture.captureId === cap.capture.captureId,
  });
  evidence.findings.captureReplayIdempotent = cap.ok && replay.ok && replay.capture.captureId === cap.capture.captureId;

  const after = await paypal.getAuthorization(ids.authorizationId);
  record(flow, "GET authorization after final partial capture", after, after.ok ? { status: after.authorization.providerStatus } : {});
  evidence.findings.authorizationStatusAfterFinalPartialCapture = after.ok ? after.authorization.providerStatus : "UNREADABLE";

  if (after.ok && after.authorization.status === "PARTIALLY_CAPTURED") {
    const v = await paypal.voidAuthorization({ authorizationId: ids.authorizationId, requestId: `smoke-void-remainder-${randomUUID()}` });
    record(flow, "explicit void of the uncaptured remainder", v, v.ok ? { providerStatus: v.providerStatus } : {});
    evidence.findings.remainderNeededExplicitVoid = true;
    evidence.findings.remainderVoidResult = v.ok ? v.providerStatus : `${v.kind}:${v.code}`;
  } else {
    evidence.findings.remainderNeededExplicitVoid = false;
  }
}

async function voidFlow(): Promise<void> {
  const flow: Flow = { name: "void: authorize $20, then void", steps: [] };
  evidence.flows.push(flow);
  console.log(`\n== ${flow.name}`);
  const ids = await approvedAuthorization(flow, 2000);
  if (!ids) return;

  if (MOCK_DECLINE) {
    const declined = await paypal
      .withMockApplicationCode("INSTRUMENT_DECLINED")
      .captureAuthorization({ authorizationId: ids.authorizationId, amountMinor: 1000, currency: "USD", requestId: `smoke-mock-capture-${randomUUID()}` });
    record(flow, "capture with PayPal-Mock-Response INSTRUMENT_DECLINED", declined, {}, {
      text: "adapter maps the mocked decline to DECLINED/INSTRUMENT_DECLINED",
      met: !declined.ok && declined.kind === "DECLINED" && declined.code === "INSTRUMENT_DECLINED",
    });
    evidence.findings.mockDeclineHonoured = !declined.ok && declined.code === "INSTRUMENT_DECLINED";
  }

  const v = await paypal.voidAuthorization({ authorizationId: ids.authorizationId, requestId: `smoke-void-${randomUUID()}` });
  record(flow, "void authorization", v, v.ok ? { providerStatus: v.providerStatus } : {}, { text: "void succeeds", met: v.ok });
  const after = await paypal.getAuthorization(ids.authorizationId);
  record(flow, "GET authorization after void", after, after.ok ? { status: after.authorization.providerStatus } : {}, {
    text: "status VOIDED",
    met: after.ok && after.authorization.status === "VOIDED",
  });
  const cap = await paypal.captureAuthorization({ authorizationId: ids.authorizationId, amountMinor: 1000, currency: "USD", requestId: `smoke-capture-after-void-${randomUUID()}` });
  record(flow, "capture after void (must fail)", cap, {}, { text: "capture after void is refused", met: !cap.ok && cap.kind !== "UNKNOWN" });
  evidence.findings.captureAfterVoidIssue = cap.ok ? "UNEXPECTED_SUCCESS" : cap.code;
}

async function refundFlow(): Promise<void> {
  const flow: Flow = { name: "refund: authorize $20, capture $20, refund $20", steps: [] };
  evidence.flows.push(flow);
  console.log(`\n== ${flow.name}`);
  const ids = await approvedAuthorization(flow, 2000);
  if (!ids) return;
  const cap = await paypal.captureAuthorization({ authorizationId: ids.authorizationId, amountMinor: 2000, currency: "USD", requestId: `smoke-capture-${randomUUID()}` });
  record(flow, "capture $20", cap, cap.ok ? { captureRef: redact(cap.capture.captureId), status: cap.capture.providerStatus } : {}, {
    text: "capture COMPLETED",
    met: cap.ok && cap.capture.status === "COMPLETED",
  });
  if (!cap.ok) return;
  const ref = await paypal.refundCapture({ captureId: cap.capture.captureId, amountMinor: 2000, currency: "USD", requestId: `smoke-refund-${randomUUID()}` });
  record(flow, "refund $20", ref, ref.ok ? { refundRef: redact(ref.refund.refundId), status: ref.refund.providerStatus, amountMinor: ref.refund.amountMinor } : {}, {
    text: "refund COMPLETED or PENDING for 2000",
    met: ref.ok && ref.refund.amountMinor === 2000 && ["COMPLETED", "PENDING"].includes(ref.refund.status),
  });
  if (!ref.ok) return;
  const read = await paypal.getRefund(ref.refund.refundId);
  record(flow, "GET refund", read, read.ok ? { status: read.refund.providerStatus } : {});
  evidence.findings.refundStatus = read.ok ? read.refund.providerStatus : "UNREADABLE";
}

/* --------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  console.log("Outings PayPal SANDBOX smoke test (no real money).");
  if (ONLY.has("capture")) await captureFlow();
  if (ONLY.has("void")) await voidFlow();
  if (ONLY.has("refund")) await refundFlow();

  const failed = evidence.flows.flatMap((f) => f.steps.filter((s) => s.met === false || (s.met === undefined && !s.ok)).map((s) => `${f.name} / ${s.step}`));
  evidence.findings.failedSteps = failed;
  const dir = path.join(process.cwd(), "docs", "evidence");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `paypal-sandbox-${evidence.runAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nEvidence (redacted) written to ${path.relative(process.cwd(), file)}`);
  if (failed.length) {
    console.log(`\n${failed.length} step(s) did not meet expectations:\n - ${failed.join("\n - ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("smoke test crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
