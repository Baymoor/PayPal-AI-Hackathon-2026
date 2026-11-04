/**
 * PayPal webhook intake.
 *
 * Rules
 * - Never process an unverified delivery. Without PAYPAL_WEBHOOK_ID the
 *   endpoint rejects everything (verification is impossible).
 * - Deduplicate by provider event id (`webhook_events` unique) → duplicates
 *   are a 200 no-op.
 * - Payloads are stored redacted (no payer name / email / address / phone).
 * - A webhook never changes money state by itself: it maps the event to a
 *   payment attempt, checks currency / amount consistency, and enqueues a
 *   RECONCILE_PAYMENT job that re-reads provider state.
 */
import { eq, or } from "drizzle-orm";
import { paymentAttempts, webhookEvents, type PaymentAttempt } from "../db/schema";
import type { Db } from "../db/client";
import { config } from "../env";
import { decimalStringToMinor } from "../domain/money";
import { enqueueJob } from "../jobs/queue";
import { recordAudit } from "../audit";
import type { ProviderResolver } from "../settlement/types";

export interface WebhookInput {
  headers: Headers;
  rawBody: string;
}

export interface WebhookOutcome {
  status: number;
  body: {
    ok: boolean;
    code:
      | "NOT_CONFIGURED"
      | "VERIFICATION_FAILED"
      | "INVALID_BODY"
      | "DUPLICATE"
      | "IGNORED_EVENT"
      | "NO_MATCHING_ATTEMPT"
      | "RECONCILE_ENQUEUED";
    eventId?: string;
    eventType?: string;
    paymentAttemptId?: string;
    note?: string;
  };
}

const HANDLED_PREFIXES = ["PAYMENT.AUTHORIZATION.", "PAYMENT.CAPTURE.", "CHECKOUT.ORDER."];
const PII_KEYS = new Set(["payer", "payer_info", "name", "email_address", "email", "address", "phone", "phone_number", "shipping", "given_name", "surname", "full_name"]);

/** Drop buyer PII wherever it appears in the event. Keys are compared case-insensitively. */
export function redactWebhookPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactWebhookPayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(k.toLowerCase())) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redactWebhookPayload(v);
    }
    return out;
  }
  return value;
}

interface ParsedEvent {
  id: string;
  eventType: string;
  resourceType: string | null;
  resource: Record<string, unknown>;
  resourceId: string | null;
  customId: string | null;
  orderId: string | null;
  authorizationId: string | null;
  amountMinor: number | null;
  currency: string | null;
  raw: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseEvent(rawBody: string): ParsedEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const event = asRecord(raw);
  if (!event) return null;
  const id = asString(event.id);
  const eventType = asString(event.event_type);
  if (!id || !eventType) return null;
  const resource = asRecord(event.resource) ?? {};
  const amount = asRecord(resource.amount);
  let amountMinor: number | null = null;
  const currency = amount ? asString(amount.currency_code) : null;
  if (amount && typeof amount.value === "string") {
    try {
      amountMinor = currency === "USD" ? decimalStringToMinor(amount.value, "USD") : null;
    } catch {
      amountMinor = null;
    }
  }
  const related = asRecord(asRecord(resource.supplementary_data)?.related_ids);
  return {
    id,
    eventType,
    resourceType: asString(event.resource_type),
    resource,
    resourceId: asString(resource.id),
    customId: asString(resource.custom_id),
    orderId: related ? asString(related.order_id) : null,
    authorizationId: related ? asString(related.authorization_id) : null,
    amountMinor,
    currency,
    raw,
  };
}

async function findAttempt(db: Db, ev: ParsedEvent): Promise<PaymentAttempt | null> {
  const conditions = [];
  if (ev.eventType.startsWith("PAYMENT.AUTHORIZATION.") && ev.resourceId) conditions.push(eq(paymentAttempts.authorizationId, ev.resourceId));
  if (ev.eventType.startsWith("PAYMENT.CAPTURE.") && ev.resourceId) conditions.push(eq(paymentAttempts.captureId, ev.resourceId));
  if (ev.eventType.startsWith("CHECKOUT.ORDER.") && ev.resourceId) conditions.push(eq(paymentAttempts.providerOrderId, ev.resourceId));
  if (ev.authorizationId) conditions.push(eq(paymentAttempts.authorizationId, ev.authorizationId));
  if (ev.orderId) conditions.push(eq(paymentAttempts.providerOrderId, ev.orderId));
  if (ev.customId && /^[0-9a-f-]{36}$/i.test(ev.customId)) conditions.push(eq(paymentAttempts.id, ev.customId));
  if (conditions.length === 0) return null;
  const rows = await db
    .select()
    .from(paymentAttempts)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions))
    .limit(2);
  if (rows.length === 1) return rows[0]!;
  if (rows.length > 1) {
    // Ambiguous match: prefer the one whose id equals custom_id, else refuse to guess.
    return rows.find((r) => r.id === ev.customId) ?? null;
  }
  return null;
}

export async function handlePaypalWebhook(db: Db, resolveProvider: ProviderResolver, input: WebhookInput): Promise<WebhookOutcome> {
  const c = config();
  if (!c.paypal?.webhookId) {
    return { status: 503, body: { ok: false, code: "NOT_CONFIGURED", note: "PAYPAL_WEBHOOK_ID is not configured; deliveries are rejected" } };
  }
  const provider = resolveProvider("PAYPAL");
  const verification = await provider.verifyWebhook({ headers: input.headers, rawBody: input.rawBody });
  if (!verification.ok || !verification.verified) {
    await recordAudit(db, { outingId: null, actor: "WEBHOOK", type: "WEBHOOK_REJECTED", data: { reason: verification.ok ? "signature" : verification.code } });
    return { status: 401, body: { ok: false, code: "VERIFICATION_FAILED" } };
  }

  const ev = parseEvent(input.rawBody);
  if (!ev) return { status: 400, body: { ok: false, code: "INVALID_BODY" } };

  const inserted = await db
    .insert(webhookEvents)
    .values({
      provider: "PAYPAL",
      providerEventId: ev.id,
      eventType: ev.eventType,
      resourceId: ev.resourceId,
      verified: true,
      payload: redactWebhookPayload(ev.raw) as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: webhookEvents.providerEventId })
    .returning({ id: webhookEvents.id });
  const stored = inserted[0];
  if (!stored) return { status: 200, body: { ok: true, code: "DUPLICATE", eventId: ev.id, eventType: ev.eventType } };

  const finish = async (processingError: string | null) => {
    await db.update(webhookEvents).set({ processedAt: new Date(), processingError }).where(eq(webhookEvents.id, stored.id));
  };

  if (!HANDLED_PREFIXES.some((p) => ev.eventType.startsWith(p))) {
    await finish(null);
    return { status: 200, body: { ok: true, code: "IGNORED_EVENT", eventId: ev.id, eventType: ev.eventType } };
  }

  const attempt = await findAttempt(db, ev);
  if (!attempt) {
    await finish("no matching payment attempt");
    await recordAudit(db, { outingId: null, actor: "WEBHOOK", type: "WEBHOOK_UNMATCHED", data: { eventId: ev.id, eventType: ev.eventType, resourceId: ev.resourceId } });
    return { status: 200, body: { ok: true, code: "NO_MATCHING_ATTEMPT", eventId: ev.id, eventType: ev.eventType } };
  }

  // Consistency checks are informational: reconciliation reads the truth from the provider.
  const notes: string[] = [];
  if (ev.currency && ev.currency !== attempt.currency) notes.push(`currency ${ev.currency} != ${attempt.currency}`);
  if (ev.amountMinor !== null) {
    if (ev.eventType.startsWith("PAYMENT.AUTHORIZATION.") && ev.amountMinor !== attempt.requestedMinor) notes.push(`authorization amount ${ev.amountMinor} != requested ${attempt.requestedMinor}`);
    if (ev.eventType.startsWith("PAYMENT.CAPTURE.") && ev.amountMinor > attempt.authorizedMinor) notes.push(`capture amount ${ev.amountMinor} > authorized ${attempt.authorizedMinor}`);
  }

  await enqueueJob(db, {
    kind: "RECONCILE_PAYMENT",
    outingId: attempt.outingId,
    runAt: new Date(),
    dedupeKey: `reconcile:${attempt.id}`,
    payload: { paymentAttemptId: attempt.id, source: "WEBHOOK", eventType: ev.eventType, eventId: ev.id },
    onConflict: "requeue",
  });
  await recordAudit(db, {
    outingId: attempt.outingId,
    actor: "WEBHOOK",
    type: "WEBHOOK_RECEIVED",
    data: { eventId: ev.id, eventType: ev.eventType, paymentAttemptId: attempt.id, resourceId: ev.resourceId, notes },
  });
  await finish(notes.length > 0 ? notes.join("; ") : null);
  return {
    status: 200,
    body: { ok: true, code: "RECONCILE_ENQUEUED", eventId: ev.id, eventType: ev.eventType, paymentAttemptId: attempt.id, note: notes.length > 0 ? notes.join("; ") : undefined },
  };
}
