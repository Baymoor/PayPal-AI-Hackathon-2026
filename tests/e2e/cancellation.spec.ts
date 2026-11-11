/**
 * ALL_REQUIRED cancellation: three of four required people authorize, Oskar never commits.
 * The deadline job cancels the outing and voids every hold; participants see the cancellation and
 * hold-release copy; money clean-up reaches COMPLETE; the merchant sees released holds, no captures.
 *
 * Setup (brief -> budget -> quote -> holds) goes through the same HTTP API the UI uses, from each
 * person's own browser context (their own session cookie); the outcome is checked in the browser.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { DESKTOP, MOBILE, deadlineFrom, merchantDetail, merchantSignIn, newPage, nextLocalHour, shot, tickUntil, viewOf } from "./helpers";

async function api<T = unknown>(page: Page, method: "GET" | "POST", path: string, data?: unknown): Promise<T> {
  const origin = new URL(page.url() === "about:blank" ? "http://localhost" : page.url()).origin;
  const res =
    method === "GET" ? await page.request.get(path) : await page.request.post(path, { data: data ?? {}, headers: { origin } });
  const text = await res.text();
  expect(res.ok(), `${method} ${path} -> ${res.status()} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}

test("a required guest never commits: deadline cancels, holds are voided, clean-up completes", async ({ browser, request }) => {
  test.setTimeout(5 * 60_000);
  const contexts: BrowserContext[] = [];
  const open = async (device: typeof MOBILE | typeof DESKTOP) => {
    const p = await newPage(browser, device);
    contexts.push(p.context);
    await p.page.goto("/");
    return p.page;
  };

  const priya = await open(DESKTOP);
  const { outingId } = await api<{ outingId: string }>(priya, "POST", "/api/outings", {
    organizerName: "Priya",
    brief: "Escape room for four of us on Saturday evening, about $120 in total.",
  });
  await api(priya, "POST", `/api/outings/${outingId}/start-budget`);
  const { invites } = await api<{ invites: { displayName: string; link: string }[] }>(priya, "POST", `/api/outings/${outingId}/invitees`, {
    names: ["Sam", "Lea", "Oskar"],
  });
  const people: Record<string, Page> = { Priya: priya };
  for (const inv of invites) {
    const page = await open(MOBILE);
    await page.goto(inv.link);
    await expect(page).toHaveURL(new RegExp(`/o/${outingId}$`));
    people[inv.displayName] = page;
  }
  // Per-person votes; $30 each is agreed.
  for (const [name, amountMinor] of [["Priya", 3_000], ["Sam", 3_000], ["Lea", 2_500], ["Oskar", 4_000]] as const) {
    await api(people[name]!, "POST", `/api/outings/${outingId}/budget/vote`, { amountMinor });
  }
  await api(priya, "POST", `/api/outings/${outingId}/budget/reveal`);
  await api(priya, "POST", `/api/outings/${outingId}/budget/agree`, { amountMinor: 3_000 });
  const proposed = await viewOf(priya, outingId);
  const escape = proposed.proposal!.candidates.find((c) => c.name.startsWith("Escape room"))!;
  await api(priya, "POST", `/api/outings/${outingId}/select`, { offeringId: escape.offeringId });
  const deadline = deadlineFrom(proposed.outing.serverNow, 75);
  const activity = nextLocalHour(new Date(deadline.getTime() + 3_600_000), 18, proposed.outing.displayTimezone);
  await api(priya, "POST", `/api/outings/${outingId}/open`, { activityAt: activity.toISOString(), deadlineAt: deadline.toISOString(), minPayers: 4 });

  await test.step("three of four required people authorize their $30 maximum", async () => {
    for (const name of ["Priya", "Sam", "Lea"]) {
      const page = people[name]!;
      await page.goto(`/o/${outingId}`);
      await page.getByRole("button", { name: "Review & authorize $30" }).click();
      await page.getByRole("checkbox", { name: /I agree to authorize up to \$30/ }).check();
      await page.getByRole("button", { name: "Authorize up to $30 (simulated)" }).click();
      await expect(page.getByText("Simulated approval page")).toBeVisible();
      await page.getByRole("button", { name: "Approve simulated hold" }).click();
      await expect(page.getByRole("heading", { name: "Your $30 hold is in place." })).toBeVisible();
    }
    const oskar = people.Oskar!;
    await oskar.goto(`/o/${outingId}`);
    await expect(oskar.getByRole("heading", { name: "You're invited." })).toBeVisible();
    await expect(oskar.getByText("3 of 4 payers committed").first()).toBeVisible();
    // ...and Oskar never commits.
  });

  await test.step("after the server deadline the outing is cancelled and every hold voided", async () => {
    for (const c of contexts) await c.close();
    const { context, page } = await newPage(browser, MOBILE);
    await page.goto(invites.find((i) => i.displayName === "Sam")!.link);
    await tickUntil(request, async () => {
      const v = await viewOf(page, outingId);
      return v.outing.status === "CANCELLED" && v.outing.cleanup === "COMPLETE";
    });
    const v = await viewOf(page, outingId);
    expect(v.outing.cancelReasons).toContain("REQUIRED_MISSING");
    expect(v.settlement?.decision).toBe("CANCEL");
    expect(v.me.payment).toMatchObject({ status: "VOIDED", capturedMinor: 0, provider: "FIXTURE" });

    await page.reload();
    await expect(page.getByRole("heading", { name: "Outing cancelled." })).toBeVisible();
    await expect(page.getByText(/No booking payment was collected\. Every simulated hold has been released/)).toBeVisible();
    await expect(page.getByText("A required guest didn’t commit before the deadline.")).toBeVisible();
    await expect(page.getByText("Hold released", { exact: true })).toBeVisible();
    await shot(page, "cancelled");
    await context.close();

    const oskar = await newPage(browser, MOBILE);
    await oskar.page.goto(invites.find((i) => i.displayName === "Oskar")!.link);
    await expect(oskar.page.getByRole("heading", { name: "Outing cancelled." })).toBeVisible();
    expect((await viewOf(oskar.page, outingId)).me.payment).toBeNull();
    await oskar.context.close();
  });

  await test.step("merchant sees released holds and no captured money", async () => {
    const { context, page } = await newPage(browser, DESKTOP);
    await merchantSignIn(page);
    const d = await merchantDetail(page, outingId);
    expect(d.booking).toMatchObject({ status: "CANCELLED", recoveryStatus: "COMPLETE", capturedTotalMinor: 0, authorizedTotalMinor: 0 });
    expect(d.operations.filter((o) => o.kind === "VOID" && o.status === "SUCCEEDED")).toHaveLength(3);
    expect(d.operations.filter((o) => o.kind === "CAPTURE")).toHaveLength(0);
    await page.goto(`/merchant/outings/${outingId}`);
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".ag-row", { hasText: "Release hold" })).toHaveCount(3);
    await context.close();
  });
});

test("organizer cancels while collecting: the server cancels and releases the hold", async ({ browser, request }) => {
  const priya = await newPage(browser, DESKTOP);
  await priya.page.goto("/");
  const { outingId } = await api<{ outingId: string }>(priya.page, "POST", "/api/outings", {
    organizerName: "Priya",
    brief: "Karaoke for three of us on Friday evening, private room, $100 total.",
  });
  await api(priya.page, "POST", `/api/outings/${outingId}/start-budget`);
  const { invites } = await api<{ invites: { displayName: string; link: string }[] }>(priya.page, "POST", `/api/outings/${outingId}/invitees`, {
    names: ["Sam", "Lea"],
  });
  const sam = await newPage(browser, MOBILE);
  const lea = await newPage(browser, MOBILE);
  await sam.page.goto(invites[0]!.link);
  await lea.page.goto(invites[1]!.link);
  for (const p of [priya.page, sam.page, lea.page]) await api(p, "POST", `/api/outings/${outingId}/budget/vote`, { amountMinor: 3_500 });
  await api(priya.page, "POST", `/api/outings/${outingId}/budget/reveal`);
  await api(priya.page, "POST", `/api/outings/${outingId}/budget/agree`, { amountMinor: 3_500 });
  const v = await viewOf(priya.page, outingId);
  const room = v.proposal!.candidates.find((c) => c.name === "Private karaoke room")!;
  await api(priya.page, "POST", `/api/outings/${outingId}/select`, { offeringId: room.offeringId });
  const deadline = deadlineFrom(v.outing.serverNow, 30 * 60);
  const activity = nextLocalHour(new Date(deadline.getTime() + 3_600_000), 19, v.outing.displayTimezone);
  await api(priya.page, "POST", `/api/outings/${outingId}/open`, { activityAt: activity.toISOString(), deadlineAt: deadline.toISOString(), minPayers: 3 });

  // Sam authorizes his $33.34 maximum (3 payers: $33.34 / $33.33 / $33.33).
  await sam.page.goto(`/o/${outingId}`);
  await sam.page.getByRole("button", { name: "Review & authorize $33.34" }).click();
  await sam.page.getByRole("checkbox", { name: /I agree to authorize up to \$33\.34/ }).check();
  await sam.page.getByRole("button", { name: "Authorize up to $33.34 (simulated)" }).click();
  await sam.page.getByRole("button", { name: "Approve simulated hold" }).click();
  await expect(sam.page.getByText("Authorization received")).toBeVisible();

  await priya.page.goto(`/o/${outingId}`);
  await priya.page.getByRole("button", { name: "Cancel this outing" }).click();
  await priya.page.getByRole("button", { name: "Yes, cancel the outing" }).click();
  await expect(priya.page.getByText("Cancellation requested")).toBeVisible();

  await tickUntil(request, async () => {
    const s = await viewOf(sam.page, outingId);
    return s.outing.status === "CANCELLED" && s.outing.cleanup === "COMPLETE";
  });
  await sam.page.goto(`/o/${outingId}`);
  await expect(sam.page.getByRole("heading", { name: "Outing cancelled." })).toBeVisible();
  await expect(sam.page.getByText("The organizer cancelled the outing.")).toBeVisible();
  await expect(sam.page.getByText("Hold released", { exact: true })).toBeVisible();
  expect((await viewOf(sam.page, outingId)).me.payment).toMatchObject({ status: "VOIDED", capturedMinor: 0 });
  // The organizer's page picks the result up by polling, without a reload.
  await expect(priya.page.getByRole("heading", { name: "Outing cancelled." })).toBeVisible({ timeout: 20_000 });
  for (const p of [priya, sam, lea]) await p.context.close();
});
