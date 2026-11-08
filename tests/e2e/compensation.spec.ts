/**
 * Partial-failure compensation, driven entirely from the /demo "A capture fails mid-settlement" scenario:
 * a fresh FIXTURE outing where all five payers hold $20, the simulator declines Jules's capture, and the
 * first response to Ben's refund is lost (simulated timeout).
 *
 * After the server deadline, "Process due work now" runs one worker pass (POST /api/demo/tick, the same
 * runWorkerTick as the scheduler): Alex, Ben and Freya are captured, Jules is declined, the outing goes
 * COMPENSATING -> CANCELLED (never CONFIRMED), the remaining holds are voided and the completed captures
 * refunded. Ben's refund stays pending (REFUND_PENDING) until the next pass reconciles it from the provider
 * state; then the clean-up is COMPLETE. Participants see the recovery copy; the merchant sees the refunds.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { DESKTOP, merchantDetail, viewOf } from "./helpers";

test.use({ ...DESKTOP });

const DEADLINE_SECONDS = 70;

interface ScenarioJson {
  outingId: string;
  title: string;
  deadlineAt: string;
  serverNow: string;
  personas: { participantId: string; displayName: string; note: string }[];
}
interface StatusJson {
  status: string;
  cleanup: string;
  cancelReasons: string[];
}
interface TickJson {
  ok: boolean;
  outing: StatusJson | null;
}

/** The "Active scenario" panel on /demo (restored from localStorage after navigating away). */
function panelOf(page: Page, title: string): Locator {
  return page.getByRole("region", { name: title });
}

/** Presses "Process due work now" and returns the tick response. */
async function processDueWork(panel: Locator): Promise<TickJson> {
  const page = panel.page();
  const response = page.waitForResponse((r) => r.url().endsWith("/api/demo/tick") && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Process due work now" }).click();
  const r = await response;
  expect(r.status(), await r.text()).toBe(200);
  await expect(panel.getByText(/^Worker pass done/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Process due work now" })).toBeEnabled();
  return (await r.json()) as TickJson;
}

async function openAs(panel: Locator, outingId: string, name: string): Promise<Page> {
  const page = panel.page();
  await panel.getByRole("button", { name: `Open as ${name}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${outingId}$`));
  await expect(page.getByText(/Simulated payments/).first()).toBeVisible();
  return page;
}

test("a capture fails mid-settlement: never confirmed, holds released, captured shares refunded", async ({ page }) => {
  test.setTimeout(4 * 60_000);

  await page.goto(`/demo?deadlineSeconds=${DEADLINE_SECONDS}`);
  await expect(page.getByText("Demo outings run on the payment simulator.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Watch a deadline settle" })).toBeVisible();

  const created = page.waitForResponse((r) => r.url().endsWith("/api/demo/scenario") && r.request().method() === "POST");
  await page.getByRole("button", { name: /^Start \(closes in 70 s\) A capture fails mid-settlement$/ }).click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  const s = (await res.json()) as ScenarioJson;
  expect(Date.parse(s.deadlineAt) - Date.parse(s.serverNow)).toBeLessThanOrEqual(DEADLINE_SECONDS * 1000);

  let panel = panelOf(page, s.title);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: s.title })).toBeFocused();
  await expect(panel.getByRole("timer")).toContainText(/^Closes in /);
  await expect(panel.getByText("Collecting commitments", { exact: true })).toBeVisible();
  await expect(panel.getByText(/capture is declined by the simulator \(injected failure\)/)).toBeVisible();

  await test.step("before the deadline, processing due work settles nothing", async () => {
    const tick = await processDueWork(panel);
    expect(tick.outing?.status).toBe("COLLECTING");
    await expect(panel.getByText(/Nothing is settled before the deadline\./)).toBeVisible();
  });

  await test.step("Ben holds $20, not charged yet", async () => {
    const ben = await openAs(panel, s.outingId, "Ben");
    await expect(ben.getByRole("heading", { name: "Your $20 hold is in place." })).toBeVisible();
  });

  await test.step("after the deadline one worker pass compensates: CANCELLED, refund pending", async () => {
    await page.goto("/demo");
    panel = panelOf(page, s.title);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("timer")).toHaveText("Deadline passed", { timeout: (DEADLINE_SECONDS + 30) * 1000 });

    let tick: TickJson | null = null;
    await expect
      .poll(
        async () => {
          tick = await processDueWork(panel);
          return tick.outing?.status;
        },
        { timeout: 30_000, intervals: [2_000] },
      )
      .not.toBe("COLLECTING");
    expect(tick!.outing).toMatchObject({ status: "CANCELLED", cleanup: "REFUND_PENDING" });
    expect(tick!.outing!.cancelReasons).toContain("CAPTURE_FAILED");
    await expect(panel.getByText("Not confirmed · refund pending")).toBeVisible();
    await expect(panel.getByText("3 captured · 1 failed · 1 skipped")).toBeVisible();
    await expect(panel.getByText("2 refunded · 1 awaiting reconciliation")).toBeVisible();
  });

  await test.step("Ben sees the recovery copy while his refund is pending", async () => {
    const ben = await openAs(panel, s.outingId, "Ben");
    await expect(ben.getByRole("heading", { name: "Booking not confirmed." })).toBeVisible();
    await expect(ben.getByText("A payment failed; completed payments are being refunded.")).toBeVisible();
    await expect(ben.getByText("Refund pending").first()).toBeVisible();
    const v = await viewOf(ben, s.outingId);
    expect(v.outing).toMatchObject({ status: "CANCELLED", cleanup: "REFUND_PENDING" });
    expect(v.me.payment).toMatchObject({ provider: "FIXTURE", capturedMinor: 2_000 });
    // Ben's own attempt may already read REFUNDED: the payment service's safety-net reconcile job for his hold
    // (queued 60 s after the authorization) can run in the same pass and read the applied refund back from the
    // provider. The refund OPERATION stays unresolved until its retry, so the outing's clean-up is still pending.
    expect(["REFUND_PENDING", "REFUNDED"]).toContain(v.me.payment!.status);
  });

  await test.step("the next pass reconciles the lost refund response: clean-up complete", async () => {
    await page.goto("/demo");
    panel = panelOf(page, s.title);
    await expect(panel).toBeVisible();
    // The refund retry is due after the engine's backoff (a few seconds).
    await expect
      .poll(async () => (await processDueWork(panel)).outing?.cleanup, { timeout: 60_000, intervals: [3_000] })
      .toBe("COMPLETE");
    await expect(panel.getByText("Not confirmed · refunded")).toBeVisible();
    await expect(panel.getByText("3 refunded", { exact: true })).toBeVisible();
    await expect(panel.getByText("2 released", { exact: true })).toBeVisible();
  });

  await test.step("Ben sees the refunded state; Jules's declined hold was released", async () => {
    const ben = await openAs(panel, s.outingId, "Ben");
    await expect(ben.getByRole("heading", { name: "Booking not confirmed." })).toBeVisible();
    await expect(ben.getByRole("status").filter({ hasText: /^Refunded/ })).toBeVisible();
    await expect(ben.getByText("A payment failed, so the completed fixture payments were refunded. No real money moved.")).toBeVisible();
    await expect(ben.getByText("Refunded $20", { exact: true })).toBeVisible();
    const v = await viewOf(ben, s.outingId);
    expect(v.outing).toMatchObject({ status: "CANCELLED", cleanup: "COMPLETE" });
    expect(v.me.payment).toMatchObject({ status: "REFUNDED", capturedMinor: 2_000, refundedMinor: 2_000 });

    await page.goto("/demo");
    panel = panelOf(page, s.title);
    const jules = await openAs(panel, s.outingId, "Jules");
    await expect(jules.getByRole("heading", { name: "Booking not confirmed." })).toBeVisible();
    expect((await viewOf(jules, s.outingId)).me.payment).toMatchObject({ status: "VOIDED", capturedMinor: 0, refundedMinor: 0 });
  });

  await test.step("the merchant drill-down shows the refunded operations", async () => {
    await page.goto("/demo");
    panel = panelOf(page, s.title);
    await panel.getByRole("button", { name: "Open merchant drill-down" }).click();
    await expect(page).toHaveURL(new RegExp(`/merchant/outings/${s.outingId}$`));
    await expect(page.getByRole("heading", { name: s.title, level: 1 })).toBeVisible();
    await expect(page.getByText("Recovery: Complete")).toBeVisible();

    const d = await merchantDetail(page, s.outingId);
    expect(d.booking).toMatchObject({ status: "CANCELLED", recoveryStatus: "COMPLETE", capturedTotalMinor: 6_000, refundedTotalMinor: 6_000, isFixture: true });
    const count = (kind: string, status: string) => d.operations.filter((o) => o.kind === kind && o.status === status).length;
    expect([count("CAPTURE", "SUCCEEDED"), count("CAPTURE", "FAILED"), count("CAPTURE", "SKIPPED")]).toEqual([3, 1, 1]);
    expect(count("REFUND", "SUCCEEDED")).toBe(3);
    expect(count("VOID", "SUCCEEDED")).toBe(2);

    const ops = page.getByRole("region", { name: "Payment operations" });
    await expect(ops.locator(".ag-row").filter({ hasText: "Refund" }).filter({ hasText: "Succeeded" })).toHaveCount(3);
    await expect(ops.locator(".ag-row").filter({ hasText: "Release hold" }).filter({ hasText: "Succeeded" })).toHaveCount(2);
  });
});
