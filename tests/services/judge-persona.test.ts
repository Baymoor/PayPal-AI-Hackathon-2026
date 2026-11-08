/**
 * Judge mode: POST /api/demo/persona through the real route handler.
 * - Allowed: seeded fixture outings (as before) and, in demo mode, any participant of an outing the
 *   browser already holds a session for (non-fixture outing).
 * - Refused with one identical 404: other outing, unknown id, no session, demo mode off.
 * - Cross-origin: 403. Every switch leaves an audit event with ids only.
 * - A PayPal return after a switch never authorizes another participant's attempt.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { body, cookiePair, createWithInvitees, openCanonical, params, participantCookieFor, request, setupServiceTests, testConfig } from "./helpers";
import { auditEvents, paymentAttempts } from "@/lib/db/schema";
import { resetConfigForTests } from "@/lib/env";
import { readParticipantSession } from "@/lib/auth/session";
import { seedDemo } from "@/lib/demo/seed";
import { FixtureProvider } from "@/lib/payments/fixture";
import * as svc from "@/lib/services/outings";
import { startPayment } from "@/lib/services/payments";
import type { OutingView } from "@/lib/contracts/views";
import * as personaRoute from "@/app/api/demo/persona/route";
import * as outingRoute from "@/app/api/outings/[id]/route";
import { GET as paypalReturnRoute } from "@/app/api/payments/paypal/return/route";

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  const { aiState: state } = await import("./fake-ai");
  return { ...actual, getOutingsAi: () => state.current };
});

const getDb = setupServiceTests();

const switchTo = (participantId: string, cookie?: string, headers?: Record<string, string>) =>
  personaRoute.POST(request("/api/demo/persona", { body: { participantId }, cookie, headers }));

const viewWith = async (outingId: string, cookie: string): Promise<OutingView> =>
  body<OutingView>(await outingRoute.GET(request(`/api/outings/${outingId}`, { cookie }), params({ id: outingId })));

const cookieOf = (res: Response): string => cookiePair(res.headers.get("set-cookie")!);

describe("POST /api/demo/persona in judge mode", () => {
  it("lets a participant of a real outing act as anyone else in that outing, keeping other sessions", async () => {
    const db = getDb();
    const f = await createWithInvitees(db, ["Ben", "Freya"]);
    const elsewhere = await createWithInvitees(db, ["Zed"]);
    const asAlex = participantCookieFor({ [f.outingId]: f.ids.Alex, [elsewhere.outingId]: elsewhere.ids.Zed });

    const res = await switchTo(f.ids.Ben, asAlex);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ ok: true, outingId: f.outingId, participantId: f.ids.Ben, redirect: `/o/${f.outingId}` });
    const cookie = cookieOf(res);
    expect((await viewWith(f.outingId, cookie)).viewer.displayName).toBe("Ben");

    // Sessions for other outings survive the switch.
    const session = readParticipantSession(request("/", { cookie }));
    expect(session.outings[elsewhere.outingId]).toBe(elsewhere.ids.Zed);

    // Invitees can switch too, including back to the organizer.
    const back = await switchTo(f.ids.Alex, cookie);
    expect(back.status).toBe(200);
    expect((await viewWith(f.outingId, cookieOf(back))).viewer.isOrganizer).toBe(true);

    const audits = await db.query.auditEvents.findMany({ where: eq(auditEvents.type, "DEMO_PERSONA_SWITCHED") });
    expect(audits.map((a) => a.data)).toEqual([
      { fromParticipantId: f.ids.Alex, toParticipantId: f.ids.Ben },
      { fromParticipantId: f.ids.Ben, toParticipantId: f.ids.Alex },
    ]);
    expect(audits[0].actor).toBe(`PARTICIPANT:${f.ids.Alex}`);
    expect(JSON.stringify(audits)).not.toContain("Ben");
  });

  it("the view says demo mode is on, and off when fixtures are disabled", async () => {
    const db = getDb();
    const f = await createWithInvitees(db, ["Ben"]);
    const asAlex = participantCookieFor({ [f.outingId]: f.ids.Alex });
    expect((await viewWith(f.outingId, asAlex)).outing.demoMode).toBe(true);
    resetConfigForTests(testConfig({ DEMO_FIXTURES_ENABLED: "false" }));
    expect((await viewWith(f.outingId, asAlex)).outing.demoMode).toBe(false);
  });

  it("still works for seeded fixture outings without any session, and records the switch", async () => {
    const db = getDb();
    const state = await seedDemo(db, { now: new Date() });
    const ben = state.personas.find((p) => p.displayName === "Ben")!;
    const res = await switchTo(ben.participantId);
    expect(res.status).toBe(200);
    expect((await viewWith(state.outingId!, cookieOf(res))).viewer.displayName).toBe("Ben");
    const audit = await db.query.auditEvents.findFirst({ where: eq(auditEvents.type, "DEMO_PERSONA_SWITCHED") });
    expect(audit).toMatchObject({ actor: "SYSTEM", outingId: state.outingId, data: { fromParticipantId: null, toParticipantId: ben.participantId } });
  });

  it("refuses with one identical 404: other outing, unknown id, no session, demo mode off", async () => {
    const db = getDb();
    const mine = await createWithInvitees(db, ["Ben"]);
    const theirs = await createWithInvitees(db, ["Cleo"]);
    const asAlex = participantCookieFor({ [mine.outingId]: mine.ids.Alex });
    // A signed session naming a participant that is not in the outing (e.g. deleted) counts as no session.
    const forged = participantCookieFor({ [theirs.outingId]: mine.ids.Ben });

    const refusals = [
      await switchTo(theirs.ids.Cleo, asAlex),
      await switchTo(crypto.randomUUID(), asAlex),
      await switchTo(mine.ids.Ben),
      await switchTo(theirs.ids.Cleo, forged),
    ];
    resetConfigForTests(testConfig({ DEMO_FIXTURES_ENABLED: "false" }));
    refusals.push(await switchTo(mine.ids.Ben, asAlex));

    const bodies = await Promise.all(refusals.map((r) => r.text()));
    for (const [i, r] of refusals.entries()) {
      expect(r.status, `refusal ${i}`).toBe(404);
      expect(r.headers.get("set-cookie"), `refusal ${i}`).toBeNull();
      expect(bodies[i], `refusal ${i}`).toBe(bodies[0]);
    }
    expect(await db.query.auditEvents.findMany({ where: eq(auditEvents.type, "DEMO_PERSONA_SWITCHED") })).toHaveLength(0);
  });

  it("rejects cross-origin requests with 403", async () => {
    const db = getDb();
    const f = await createWithInvitees(db, ["Ben"]);
    const asAlex = participantCookieFor({ [f.outingId]: f.ids.Alex });
    const res = await switchTo(f.ids.Ben, asAlex, { origin: "https://evil.example", host: "localhost:3000" });
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("a PayPal-style return after switching personas never authorizes the previous persona's attempt", async () => {
    const db = getDb();
    const now = new Date();
    const f = await openCanonical(db, now);
    await svc.consent(db, { outingId: f.outingId, participantId: f.ids.Alex }, { termsHash: f.opened.termsHash }, now);
    const started = await startPayment(db, { outingId: f.outingId, participantId: f.ids.Alex, now, reviewedTermsHash: f.opened.termsHash });
    const attempt = (await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, started.paymentAttemptId) }))!;
    await new FixtureProvider({ db }).approveOrder(attempt.providerOrderId!); // the buyer approved "at the provider"
    const returnPath = `/api/payments/paypal/return?attempt=${attempt.id}&token=${attempt.providerOrderId}`;

    // Alex starts approving, then the browser switches to Ben before PayPal redirects back.
    const asAlex = participantCookieFor({ [f.outingId]: f.ids.Alex });
    const asBen = cookieOf(await switchTo(f.ids.Ben, asAlex));
    const asBenReturn = await paypalReturnRoute(request(returnPath, { cookie: asBen }));
    expect(asBenReturn.status).toBe(303);
    expect(asBenReturn.headers.get("location")).toBe(`/o/${f.outingId}?payment=failed&reason=not_found`);
    expect((await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attempt.id) }))!.status).toBe("APPROVAL_PENDING");
    expect((await viewWith(f.outingId, asBen)).roster.payersAuthorized).toBe(0);

    // Back as Alex the same return completes for Alex only.
    const backAsAlex = cookieOf(await switchTo(f.ids.Alex, asBen));
    const ownerReturn = await paypalReturnRoute(request(returnPath, { cookie: backAsAlex }));
    expect(ownerReturn.headers.get("location")).toBe(`/o/${f.outingId}?payment=authorized`);
    const authorized = (await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attempt.id) }))!;
    expect(authorized).toMatchObject({ status: "AUTHORIZED", participantId: f.ids.Alex });
  });
});
