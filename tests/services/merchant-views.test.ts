import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { actorOf, createWithInvitees, insertAuthorizedAttempt, MIN, openCanonical, setupServiceTests } from "./helpers";
import * as svc from "@/lib/services/outings";
import { buildOutingView, redactRef, stageFor } from "@/lib/services/views";
import { getOutingDetail, listBookingRows, retryOperation } from "@/lib/services/merchant";
import { seedDemo, DEMO_MAIN_TITLE } from "@/lib/demo/seed";
import { jobs, merchants, outings, paymentAttempts, paymentOperations } from "@/lib/db/schema";
import { ServiceError } from "@/lib/http";
import { operationsJobKey } from "@/lib/jobs/queue";

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const { aiState: state } = await import("./fake-ai");
  return { ...actual, getOutingsAi: () => state.current };
});

const getDb = setupServiceTests();

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof ServiceError) return e.code;
    throw e;
  }
}

describe("OutingView", () => {
  it("maps stages and redacts refs", () => {
    expect(stageFor("DRAFT")).toBe("BRIEF");
    expect(stageFor("BUDGETING")).toBe("BUDGET");
    expect(stageFor("PROPOSED")).toBe("INVITE");
    expect(stageFor("COLLECTING")).toBe("COMMIT");
    for (const s of ["SETTLING", "CONFIRMED", "CANCELLING", "COMPENSATING", "CANCELLED"] as const) expect(stageFor(s)).toBe("RESULT");
    expect(redactRef("FXAUTH-ABCDEF124F2A")).toBe("…4F2A");
    expect(redactRef(null)).toBeNull();
  });

  it("shows commitments, estimates and permissions computed from server state", async () => {
    const db = getDb();
    const now = new Date();
    const f = await openCanonical(db, now);
    const t = new Date(now.getTime() + MIN);
    for (const name of ["Alex", "Ben", "Freya", "Jules"]) {
      await svc.consent(db, actorOf(f, name), { termsHash: f.opened.termsHash }, t);
      await insertAuthorizedAttempt(db, { outingId: f.outingId, participantId: f.ids[name], quoteId: f.opened.quoteId, amountMinor: 2_000, authorizedAt: t });
    }
    // A late authorization (flagged by the payments WP) never counts as committed.
    await svc.consent(db, actorOf(f, "Noor"), { termsHash: f.opened.termsHash }, t);
    const lateAttempt = await insertAuthorizedAttempt(db, { outingId: f.outingId, participantId: f.ids.Noor, quoteId: f.opened.quoteId, amountMinor: 2_000, authorizedAt: t });
    await db.update(paymentAttempts).set({ late: true, status: "VOID_PENDING" }).where(eq(paymentAttempts.id, lateAttempt.id));
    await svc.respond(db, actorOf(f, "Maya"), { response: "ACCEPT" }, t);

    const noor = await buildOutingView(db, { outingId: f.outingId, participantId: f.ids.Noor, now: t });
    expect(noor.outing.stage).toBe("COMMIT");
    expect(noor.outing.serverNow).toBe(t.toISOString());
    expect(noor.roster.payersAuthorized).toBe(4);
    expect(noor.roster.invitedPayers).toBe(5);
    expect(noor.roster.sponsoredCount).toBe(1);
    expect(noor.roster.requiredInvited).toBe(6);
    expect(noor.roster.requiredAccepted).toBe(5); // 4 payers + sponsored Maya
    expect(noor.estimates).toEqual({ capMinor: 2_000, projectedPayers: 5, estimatedShareMinor: 2_000 });
    expect(noor.roster.people.find((p) => p.displayName === "Noor")?.committed).toBe(false);
    expect(noor.me.consent?.current).toBe(true);
    expect(noor.me.payment).toMatchObject({ late: true, status: "VOID_PENDING" });
    expect(noor.me.can).toMatchObject({ consent: false, authorize: false, withdraw: true, vote: false, accept: false, decline: false });
    expect(noor.organizer).toBeNull();
    expect(noor.quote).toMatchObject({ totalMinor: 10_000, capMinor: 2_000, minPayers: 5, sponsoredNames: ["Maya"], requiredCount: 6, availabilitySource: "FIXTURE" });
    expect(noor.roster.people.find((p) => p.displayName === "Maya")).toMatchObject({ payerType: "SPONSORED", committed: true });
    // Non-organizers only see the selected offering, never the AI candidate list.
    expect(noor.proposal?.candidates).toHaveLength(1);
    expect(noor.proposal?.candidates[0].priceMinor).toBe(10_000);

    const ben = await buildOutingView(db, { outingId: f.outingId, participantId: f.ids.Ben, now: t });
    expect(ben.me.payment?.authorizationRef).toMatch(/^…[0-9A-F]{4}$/);
    expect(ben.me.payment?.providerLabel).toBe("Fixture — not real PayPal");
    expect(ben.me.consent?.current).toBe(true);
    expect(ben.me.can).toMatchObject({ consent: false, authorize: false, withdraw: true, decline: false });
    expect(JSON.stringify(ben)).not.toMatch(/FXAUTH-[0-9A-F]{8}/);

    const alex = await buildOutingView(db, { outingId: f.outingId, participantId: f.organizerId, now: t });
    expect(alex.organizer?.can).toMatchObject({ cancel: true, addInvitees: true, editRoster: false, openCollection: false });

    // After the deadline nobody can commit.
    const late = await buildOutingView(db, { outingId: f.outingId, participantId: f.ids.Noor, now: new Date(f.deadlineAt.getTime() + MIN) });
    expect(late.me.can).toMatchObject({ consent: false, authorize: false, withdraw: false });
    expect(late.estimates.projectedPayers).toBe(4);
    expect(late.estimates.estimatedShareMinor).toBe(2_000);
  });

  it("shows a pre-quote estimate with a sponsored guest ($100 / 5 payers = $20)", async () => {
    const db = getDb();
    const now = new Date();
    const g = await createWithInvitees(db, ["Ben", "Freya", "Jules", "Noor", "Maya"], now);
    const org = actorOf(g);
    await svc.startBudget(db, org, now);
    await svc.agreeBudget(db, org, { amountMinor: 10_000 }, now);
    await svc.selectOffering(db, org, { offeringId: g.offerings["private-karaoke-room"].id }, now);
    await svc.patchParticipant(db, org, g.ids.Maya, { payerType: "SPONSORED" }, now);
    const v = await buildOutingView(db, { outingId: g.outingId, participantId: g.organizerId, now });
    expect(v.outing.stage).toBe("INVITE");
    expect(v.estimates).toEqual({ capMinor: null, projectedPayers: 5, estimatedShareMinor: 2_000 });
    expect(v.organizer?.can).toMatchObject({ openCollection: true, selectOffering: true, editRoster: true, agreeBudget: false, propose: true });
    expect(v.proposal?.candidates.length).toBeGreaterThan(1);
    expect(v.proposal?.selectedOfferingId).toBe(g.offerings["private-karaoke-room"].id);
  });
});

describe("merchant read models", () => {
  it("separates authorized holds from allocated, captured and refunded money", async () => {
    const db = getDb();
    const now = new Date();
    const state = await seedDemo(db, { now });
    const merchant = (await db.query.merchants.findFirst({ where: eq(merchants.id, state.merchant!.id) }))!;
    const rows = await listBookingRows(db, merchant.id, now);
    expect(rows).toHaveLength(6); // the BUDGETING demo outing has no quote yet
    expect(rows.every((r) => r.isFixture && r.provider === "FIXTURE")).toBe(true);
    const by = (prefix: string) => rows.find((r) => r.title.startsWith(prefix))!;

    const main = by(DEMO_MAIN_TITLE);
    expect(main).toMatchObject({
      status: "COLLECTING",
      payersAuthorized: 4,
      minPayers: 5,
      requiredInvited: 6,
      requiredAccepted: 5,
      missingRequired: 1,
      authorizedTotalMinor: 8_000,
      allocatedTotalMinor: 0,
      capturedTotalMinor: 0,
      refundedTotalMinor: 0,
      totalMinor: 10_000,
      capMinor: 2_000,
      capacity: 10,
    });
    expect(main.closesInMinutes).toBeGreaterThan(100);

    const sam = by("Sam's farewell");
    expect(sam).toMatchObject({ status: "CONFIRMED", authorizedTotalMinor: 0, allocatedTotalMinor: 10_000, capturedTotalMinor: 10_000, refundedTotalMinor: 0, recoveryStatus: "NONE" }); // confirmed: nothing to clean up (same as the engine)
    const jonas = by("Jonas's 30th");
    expect(jonas).toMatchObject({ status: "CONFIRMED", capturedTotalMinor: 10_000, attendees: 6, payersAuthorized: 5 });

    const office = by("Office escape room");
    expect(office).toMatchObject({ status: "CANCELLED", recoveryStatus: "COMPLETE", authorizedTotalMinor: 0, capturedTotalMinor: 0, voidPendingCount: 0 });

    const launch = by("Launch party");
    expect(launch).toMatchObject({
      status: "CANCELLED",
      recoveryStatus: "REFUND_PENDING",
      allocatedTotalMinor: 18_000,
      capturedTotalMinor: 6_000,
      refundedTotalMinor: 3_000,
      authorizedTotalMinor: 0,
      refundPendingCount: 1,
    });

    const today = by("Escape room with the climbing crew");
    expect(today).toMatchObject({ status: "COLLECTING", missingRequired: 1, payersAuthorized: 3, authorizedTotalMinor: 9_000 });
    expect(today.closesInMinutes).toBeGreaterThanOrEqual(1);

    // Detail: allocations from the snapshot (penny split 3334/3333/3333), timeline, retryable ops.
    const samDetail = await getOutingDetail(db, merchant.id, sam.outingId, now);
    expect(samDetail.participants.map((p) => p.allocationMinor)).toEqual([3_334, 3_333, 3_333]);
    expect(samDetail.participants.map((p) => p.authorizedMinor)).toEqual([3_334, 3_334, 3_334]);
    expect(samDetail.timeline.length).toBeGreaterThan(3);
    const launchDetail = await getOutingDetail(db, merchant.id, launch.outingId, now);
    const retryable = launchDetail.operations.filter((o) => o.canRetry);
    // The declined capture is a definitive (terminal) failure; only the UNKNOWN refund is retryable.
    expect(retryable.map((o) => `${o.kind}:${o.status}`)).toEqual(["REFUND:UNKNOWN"]);
    expect(launchDetail.operations.some((o) => o.kind === "CAPTURE" && o.status === "FAILED" && !o.canRetry)).toBe(true);
  });

  it("retries only existing FAILED/UNKNOWN operations of the merchant's own outings", async () => {
    const db = getDb();
    const now = new Date();
    const state = await seedDemo(db, { now });
    const merchantId = state.merchant!.id;
    const [other] = await db.insert(merchants).values({ slug: "other-venue", name: "Other venue" }).returning();
    const launch = (await listBookingRows(db, merchantId, now)).find((r) => r.title.startsWith("Launch party"))!;
    const ops = await db.query.paymentOperations.findMany({ where: eq(paymentOperations.outingId, launch.outingId) });
    const unknown = ops.find((o) => o.status === "UNKNOWN")!;
    const succeeded = ops.find((o) => o.status === "SUCCEEDED")!;
    const terminalFailure = ops.find((o) => o.status === "FAILED")!;
    const before = await db.query.paymentOperations.findMany();

    expect(await codeOf(retryOperation(db, other.id, unknown.id, now))).toBe("NOT_FOUND");
    expect(await codeOf(retryOperation(db, merchantId, succeeded.id, now))).toBe("NOT_RETRYABLE");
    expect(await codeOf(retryOperation(db, merchantId, terminalFailure.id, now))).toBe("NOT_RETRYABLE");
    expect(await codeOf(retryOperation(db, merchantId, crypto.randomUUID(), now))).toBe("NOT_FOUND");
    expect(await codeOf(retryOperation(db, merchantId, "1", now))).toBe("NOT_FOUND");

    const res = await retryOperation(db, merchantId, unknown.id, now);
    expect(res.operationId).toBe(unknown.id);
    const after = (await db.query.paymentOperations.findFirst({ where: eq(paymentOperations.id, unknown.id) }))!;
    expect(after.requestId).toBe(unknown.requestId);
    expect(after.status).toBe("UNKNOWN");
    expect(after.attempts).toBe(0); // exhausted attempts were reset
    expect(after.nextAttemptAt.getTime()).toBe(now.getTime());
    expect(await db.query.paymentOperations.findMany()).toHaveLength(before.length);
    const job = await db.query.jobs.findFirst({ where: eq(jobs.dedupeKey, operationsJobKey(launch.outingId)) });
    expect(job).toMatchObject({ kind: "PROCESS_OPERATIONS", status: "QUEUED" });

    // Scoping: another merchant sees nothing.
    expect(await listBookingRows(db, other.id, now)).toEqual([]);
    expect(await codeOf(getOutingDetail(db, other.id, launch.outingId, now))).toBe("NOT_FOUND");
  });

  it("re-seeding replaces only fixture outings", async () => {
    const db = getDb();
    const now = new Date();
    await seedDemo(db, { now });
    const real = await openCanonical(db, now);
    await seedDemo(db, { now });
    const all = await db.query.outings.findMany();
    expect(all.filter((o) => o.isFixture)).toHaveLength(7);
    expect(all.some((o) => o.id === real.outingId)).toBe(true);
    expect(await db.query.outings.findFirst({ where: eq(outings.id, real.outingId) })).toBeTruthy();
  });
});
