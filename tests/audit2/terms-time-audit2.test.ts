/**
 * Second independent audit: consent/terms integrity, capacity with a
 * sponsored guest, and deadline/time handling (server time only, UTC at
 * rest, Europe/Copenhagen for display).
 */
import { describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { actorOf, createWithInvitees, insertAuthorizedAttempt, openCanonical, setupServiceTests, MIN } from "../services/helpers";
import * as svc from "@/lib/services/outings";
import { buildOutingView } from "@/lib/services/views";
import { listBookingRows } from "@/lib/services/merchant";
import { zonedParts } from "@/lib/services/catalogue";
import { outings, participants, paymentAttempts, paymentOperations, quoteVersions, settlementSnapshots } from "@/lib/db/schema";
import type { CommitmentTerms } from "@/lib/domain/policy";
import { ServiceError } from "@/lib/http";

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const { aiState: state } = await import("../services/fake-ai");
  return { ...actual, getOutingsAi: () => state.current };
});

const getDb = setupServiceTests();

async function expectCode(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
  expect((err as ServiceError).status).toBe(status);
}

const CPH = "Europe/Copenhagen";

describe("capacity and sponsorship", () => {
  it("a sponsored guest pays nothing but still takes a seat: capacity counts attendees, not payers", async () => {
    const db = getDb();
    const now = new Date();
    const f = await createWithInvitees(db, ["Ben", "Freya", "Jules", "Noor", "Maya"], now); // 6 attendees
    const org = actorOf(f);
    await svc.startBudget(db, org, now);
    await svc.agreeBudget(db, org, { amountMinor: 12_000 }, now);
    await svc.selectOffering(db, org, { offeringId: f.offerings["escape-room"].id }, now); // capacity 6
    await svc.patchParticipant(db, org, f.ids.Maya, { payerType: "SPONSORED" }, now);

    const v = await buildOutingView(db, { outingId: f.outingId, participantId: f.organizerId, now });
    expect(v.roster).toMatchObject({ capacity: 6, attendeeCount: 6, invitedPayers: 5, sponsoredCount: 1 });
    expect(v.estimates).toEqual({ capMinor: null, projectedPayers: 5, estimatedShareMinor: 2_400 });

    // Sam would pay, but the room is full because the sponsored guest is an attendee.
    await expectCode(svc.addInvitees(db, org, { names: ["Sam"] }, now), "CAPACITY_EXCEEDED", 409);
    // The karaoke room fits 10: Sam joins there, after which the 6-seat escape room can no longer be selected.
    await svc.selectOffering(db, org, { offeringId: f.offerings["private-karaoke-room"].id }, now);
    await svc.addInvitees(db, org, { names: ["Sam"] }, now);
    await expectCode(svc.selectOffering(db, org, { offeringId: f.offerings["escape-room"].id }), "CAPACITY_EXCEEDED", 409);
  });
});

describe("payers who join while collecting", () => {
  it("lower the estimate only: cap, terms hash and stable order stay, and nothing is captured before the deadline", async () => {
    const db = getDb();
    const now = new Date();
    const f = await openCanonical(db, now); // $100, minPayers 5 -> cap $20, Maya sponsored
    const org = actorOf(f);
    const quoteId = f.opened.quoteId;
    const t1 = new Date(now.getTime() + MIN);
    const rosterBefore = await db.query.participants.findMany({ where: eq(participants.outingId, f.outingId), orderBy: [asc(participants.sortKey)] });
    expect(rosterBefore.map((p) => p.sortKey)).toEqual([1, 2, 3, 4, 5, 6]);

    for (const name of ["Alex", "Ben", "Freya", "Jules", "Noor"]) {
      await svc.consent(db, actorOf(f, name), { termsHash: f.opened.termsHash }, t1);
      await insertAuthorizedAttempt(db, { outingId: f.outingId, participantId: f.ids[name], quoteId, amountMinor: 2_000, authorizedAt: t1 });
    }
    await svc.respond(db, actorOf(f, "Maya"), { response: "ACCEPT" }, t1);

    const ben1 = await buildOutingView(db, { outingId: f.outingId, participantId: f.ids.Ben, now: t1 });
    expect(ben1.estimates).toEqual({ capMinor: 2_000, projectedPayers: 5, estimatedShareMinor: 2_000 });
    expect(ben1.roster.payersAuthorized).toBe(5);

    // An optional payer joins during collection.
    const t2 = new Date(now.getTime() + 2 * MIN);
    const { invites } = await svc.addInvitees(db, org, { names: ["Sam"] }, t2);
    const sam = { outingId: f.outingId, participantId: invites[0].participantId };
    await svc.consent(db, sam, { termsHash: f.opened.termsHash }, t2);
    await insertAuthorizedAttempt(db, { outingId: f.outingId, participantId: sam.participantId, quoteId, amountMinor: 2_000, authorizedAt: t2 });

    const ben2 = await buildOutingView(db, { outingId: f.outingId, participantId: f.ids.Ben, now: new Date(now.getTime() + 3 * MIN) });
    expect(ben2.estimates).toEqual({ capMinor: 2_000, projectedPayers: 6, estimatedShareMinor: 1_667 });
    expect(ben2.me.payment).toMatchObject({ status: "AUTHORIZED", authorizedMinor: 2_000, capturedMinor: 0 });
    expect(ben2.me.consent).toMatchObject({ capMinor: 2_000, termsHash: f.opened.termsHash, current: true });
    expect(ben2.me.finalShareMinor).toBeNull();

    // Terms, cap and the immutable order are untouched; the newcomer is optional and appended last.
    const quote = (await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, quoteId) }))!;
    expect(quote).toMatchObject({ status: "ACTIVE", capMinor: 2_000, minPayers: 5, termsHash: f.opened.termsHash });
    const terms = quote.terms as CommitmentTerms;
    expect(terms.requiredParticipantIds).not.toContain(sam.participantId);
    const rosterAfter = await db.query.participants.findMany({ where: eq(participants.outingId, f.outingId), orderBy: [asc(participants.sortKey)] });
    expect(rosterAfter.slice(0, 6).map((p) => [p.id, p.sortKey])).toEqual(rosterBefore.map((p) => [p.id, p.sortKey]));
    expect(rosterAfter[6]).toMatchObject({ id: sam.participantId, sortKey: 7, required: false, payerType: "PAYER", attendance: "ACCEPTED" });
    // ...and can never be promoted to required (or sponsored) while collecting.
    await expectCode(svc.patchParticipant(db, org, sam.participantId, { required: true }, t2), "INVALID_STATE", 409);
    await expectCode(svc.patchParticipant(db, org, sam.participantId, { payerType: "SPONSORED" }, t2), "INVALID_STATE", 409);

    // No settlement, no capture, no operation before the deadline.
    const outing = (await db.query.outings.findFirst({ where: eq(outings.id, f.outingId) }))!;
    expect(outing.status).toBe("COLLECTING");
    expect(outing.frozenAt).toBeNull();
    expect(await db.query.settlementSnapshots.findMany({ where: eq(settlementSnapshots.outingId, f.outingId) })).toHaveLength(0);
    expect(await db.query.paymentOperations.findMany({ where: eq(paymentOperations.outingId, f.outingId) })).toHaveLength(0);
    const attempts = await db.query.paymentAttempts.findMany({ where: eq(paymentAttempts.outingId, f.outingId) });
    expect(attempts).toHaveLength(6);
    expect(attempts.every((a) => a.status === "AUTHORIZED" && a.authorizedMinor === 2_000 && a.capturedMinor === 0)).toBe(true);
  });
});

describe("deadline and time handling", () => {
  it("rejects naive local times, stores UTC, displays Europe/Copenhagen across the DST switch, and closes exactly at the deadline", async () => {
    const db = getDb();
    // Copenhagen switches to CEST on 2027-03-28 at 01:00 UTC.
    const now = new Date("2027-03-27T12:00:00Z");
    const f = await createWithInvitees(db, ["Ben", "Freya", "Jules"], now);
    const org = actorOf(f);
    await svc.startBudget(db, org, now);
    await svc.agreeBudget(db, org, { amountMinor: 10_000 }, now);
    await svc.selectOffering(db, org, { offeringId: f.offerings["private-karaoke-room"].id }, now);

    // A wall-clock time without an offset is ambiguous and is refused by the input contract.
    expect(svc.OpenCollectionInput.safeParse({ activityAt: "2027-03-28T19:00:00", deadlineAt: "2027-03-28T04:00:00", minPayers: 4 }).success).toBe(false);
    const input = svc.OpenCollectionInput.parse({ activityAt: "2027-03-28T19:00:00+02:00", deadlineAt: "2027-03-28T04:00:00+02:00", minPayers: 4 });
    const opened = await svc.openCollection(db, org, { activityAt: new Date(input.activityAt), deadlineAt: new Date(input.deadlineAt), minPayers: 4 }, now);

    const outing = (await db.query.outings.findFirst({ where: eq(outings.id, f.outingId) }))!;
    expect(outing.deadlineAt!.toISOString()).toBe("2027-03-28T02:00:00.000Z");
    expect(outing.activityAt!.toISOString()).toBe("2027-03-28T17:00:00.000Z");
    expect(zonedParts(outing.deadlineAt!, CPH)).toMatchObject({ month: 3, day: 28, hour: 4, minute: 0 });
    expect(zonedParts(outing.activityAt!, CPH)).toMatchObject({ month: 3, day: 28, hour: 19, minute: 0 });
    const quote = (await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, opened.quoteId) }))!;
    expect((quote.terms as CommitmentTerms).deadlineAt).toBe("2027-03-28T02:00:00.000Z");
    expect(quote.deadlineAt.getTime()).toBe(outing.deadlineAt!.getTime());

    const view = await buildOutingView(db, { outingId: f.outingId, participantId: f.ids.Ben, now });
    expect(view.outing).toMatchObject({ deadlineAt: "2027-03-28T02:00:00.000Z", displayTimezone: CPH, serverNow: now.toISOString() });
    expect(view.quote?.deadlineAt).toBe("2027-03-28T02:00:00.000Z");

    // Boundary: the last millisecond before the deadline is accepted, the deadline instant itself is not.
    const deadline = outing.deadlineAt!.getTime();
    await svc.consent(db, actorOf(f, "Ben"), { termsHash: opened.termsHash }, new Date(deadline - 1));
    await expectCode(svc.consent(db, actorOf(f, "Freya"), { termsHash: opened.termsHash }, new Date(deadline)), "DEADLINE_PASSED", 409);
    await expectCode(svc.respond(db, actorOf(f, "Jules"), { response: "DECLINE" }, new Date(deadline)), "DEADLINE_PASSED", 409);
    await expectCode(svc.addInvitees(db, org, { names: ["Sam"] }, new Date(deadline)), "DEADLINE_PASSED", 409);
    const atDeadline = await buildOutingView(db, { outingId: f.outingId, participantId: f.ids.Freya, now: new Date(deadline) });
    expect(atDeadline.me.can).toMatchObject({ consent: false, authorize: false, withdraw: false, decline: false });

    // The merchant's "closes today" uses the merchant's local calendar date, not the UTC date.
    const row = async (at: string) => (await listBookingRows(db, f.merchantId, new Date(at))).find((r) => r.outingId === f.outingId)!;
    expect((await row("2027-03-27T23:30:00Z")).closesToday).toBe(true); // 00:30 CET on the 28th locally, still the 27th in UTC
    expect((await row("2027-03-27T22:30:00Z")).closesToday).toBe(false); // 23:30 CET on the 27th
    expect((await row("2027-03-28T02:00:00Z")).closesToday).toBe(false); // deadline reached: no longer "closing"
  });
});
