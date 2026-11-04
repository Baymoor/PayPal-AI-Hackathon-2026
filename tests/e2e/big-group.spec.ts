/**
 * "Ten friends share the room" (big-group) scenario, driven from /demo: a fresh FIXTURE outing where nine
 * payers already hold $20 of the $100 fixed-total room. Kai commits live (the tenth payer), so the estimate
 * drops from $20 to $10; at the server deadline each payer is charged exactly $10 from their $20 hold
 * (under-capture with final_capture, the remainder released).
 */
import { expect, test, type Page } from "@playwright/test";
import { MOBILE, viewOf } from "./helpers";

test.use({ ...MOBILE });

const DEADLINE_SECONDS = 70;

interface ScenarioJson {
  outingId: string;
  title: string;
  deadlineAt: string;
  serverNow: string;
}

test("big group: ten payers, $10 each captured from $20 holds", async ({ page }) => {
  test.setTimeout(4 * 60_000);

  await page.goto(`/demo?deadlineSeconds=${DEADLINE_SECONDS}`);
  await expect(page.getByRole("heading", { name: "Watch a deadline settle" })).toBeVisible();
  await expect(page.getByText(/Ten friends share the \$100 room\. Everyone authorized up to \$20/)).toBeVisible();

  const created = page.waitForResponse((r) => r.url().endsWith("/api/demo/scenario") && r.request().method() === "POST");
  await page.getByRole("button", { name: /^Start \(closes in 70 s\) Ten friends share the room$/ }).click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  const s = (await res.json()) as ScenarioJson;
  expect(Date.parse(s.deadlineAt) - Date.parse(s.serverNow)).toBeLessThanOrEqual(DEADLINE_SECONDS * 1000);

  const panel = page.getByRole("region", { name: s.title });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Collecting commitments", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Collecting: 9 of 10 payers hold their maximum/)).toBeVisible();

  await test.step("Kai reviews and authorizes $20; the estimate is $10", async () => {
    await panel.getByRole("button", { name: "Open as Kai", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${s.outingId}$`));
    await expect(page.getByText("Fixture — not real PayPal").first()).toBeVisible();
    await expect(page.getByText("9 of 10 payers committed").first()).toBeVisible();
    await page.getByRole("button", { name: "Review & authorize $20" }).click();
    await page.getByRole("checkbox", { name: /I agree to authorize up to \$20/ }).check();
    await page.getByRole("button", { name: "Authorize up to $20 (fixture)" }).click();
    await expect(page).toHaveURL(/\/pay\/fixture\?attempt=/);
    await page.getByRole("button", { name: "Approve simulated hold" }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${s.outingId}\\?payment=authorized$`));
    await expect(page.getByRole("heading", { name: "$20 authorized · estimated final share $10 · not charged yet." })).toBeVisible();
    await expect(page.getByText("estimated final share $10").first()).toBeVisible();
  });

  await test.step("after the deadline, processing due work confirms with a $10 share", async () => {
    await page.goto("/demo");
    const live = page.getByRole("region", { name: s.title });
    await expect(live).toBeVisible();
    await expect(live.getByRole("timer")).toHaveText("Deadline passed", { timeout: (DEADLINE_SECONDS + 30) * 1000 });
    await expect
      .poll(
        async () => {
          const tick = page.waitForResponse((r) => r.url().endsWith("/api/demo/tick") && r.request().method() === "POST");
          await live.getByRole("button", { name: "Process due work now" }).click();
          const r = await tick;
          expect(r.status(), await r.text()).toBe(200);
          return ((await r.json()) as { outing: { status: string } | null }).outing?.status;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe("CONFIRMED");

    await live.getByRole("button", { name: "Open as Kai", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${s.outingId}$`));
    await expectKaiCharged(page, s.outingId);
  });
});

async function expectKaiCharged(page: Page, outingId: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "You’re going." })).toBeVisible();
  const row = (label: string) => page.locator("dl > div").filter({ hasText: new RegExp(`^${label}`) });
  await expect(row("Your maximum")).toContainText("$20");
  await expect(row("Your final share")).toContainText("$10");
  await expect(row("Captured")).toContainText("$10");
  const v = await viewOf(page, outingId);
  expect(v.me.payment).toMatchObject({ status: "CAPTURED", provider: "FIXTURE", authorizedMinor: 2_000, capturedMinor: 1_000 });
  expect(v.me.payment!.capturedMinor).toBeLessThanOrEqual(v.me.payment!.authorizedMinor);
}
