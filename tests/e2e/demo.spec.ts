/**
 * /demo: reset the seeded FIXTURE outings, switch personas, and check every seeded stage renders
 * (budget poker, collecting, confirmed, cancelled with released holds, failed capture being refunded).
 */
import { expect, test, type Page } from "@playwright/test";
import { MOBILE } from "./helpers";

test.use({ ...MOBILE });

async function openAs(page: Page, outingTitle: string, person: string): Promise<void> {
  await page.goto("/demo");
  await page.getByRole("button", { name: `Open ${outingTitle} as ${person}`, exact: true }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/Simulated payments/).first()).toBeVisible();
}

test("demo hub: reset, persona switching and every seeded stage", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByText("Demo outings run on the payment simulator.")).toBeVisible();
  const reset = page.waitForResponse((r) => r.url().endsWith("/api/demo/reset") && r.status() === 200);
  await page.getByRole("button", { name: "Reset demo data" }).click();
  await reset;
  await expect(page.getByRole("button", { name: "Reset demo data" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Maya's birthday karaoke" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "More sample outings" })).toBeVisible();

  await test.step("collecting: Noor still has to commit; Ben already did", async () => {
    await openAs(page, "Maya's birthday karaoke", "Noor");
    await expect(page.getByRole("heading", { name: "You're invited." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review & authorize $20" })).toBeVisible();
    await expect(page.getByText("4 of 5 payers committed").first()).toBeVisible();
    await openAs(page, "Maya's birthday karaoke", "Ben");
    await expect(page.getByRole("heading", { name: "Your $20 hold is in place." })).toBeVisible();
    await openAs(page, "Maya's birthday karaoke", "Maya");
    await expect(page.getByText("You’re in")).toBeVisible();
  });

  await test.step("budget poker: organizer can reveal, a guest can vote", async () => {
    await openAs(page, "Friday game night", "Chloe");
    await expect(page.getByRole("heading", { name: "Budget poker", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reveal", exact: true })).toBeEnabled();
    await openAs(page, "Friday game night", "Gus");
    await expect(page.getByRole("button", { name: /Submit my/ })).toBeVisible();
    await expect(page.getByText("4 of 6 voted")).toBeVisible();
  });

  await test.step("history: confirmed, cancelled, refund pending", async () => {
    await openAs(page, "Sam's farewell karaoke (sample)", "Tom");
    await expect(page.getByRole("heading", { name: "You’re going." })).toBeVisible();
    // 3 payers sharing $100: $33.34 / $33.33 / $33.33, never above the $33.34 cap.
    await expect(page.locator("dl > div").filter({ hasText: "Your final share" })).toContainText(/\$33\.3[34]/);

    await openAs(page, "Jonas's 30th (sample)", "Jonas");
    await expect(page.getByText("Your share was covered, so you pay $0.")).toBeVisible();

    await openAs(page, "Office escape room (sample)", "Kai");
    await expect(page.getByRole("heading", { name: "Outing cancelled." })).toBeVisible();
    await expect(page.getByText(/No booking payment was collected/)).toBeVisible();

    await openAs(page, "Launch party karaoke (sample)", "Leo");
    await expect(page.getByRole("heading", { name: "Booking not confirmed." })).toBeVisible();
    await expect(page.getByText("A payment failed; completed payments are being refunded.")).toBeVisible();

    await openAs(page, "Escape room with the climbing crew (sample)", "Elias");
    await expect(page.getByRole("button", { name: "Review & authorize $30" })).toBeVisible();
  });
});
