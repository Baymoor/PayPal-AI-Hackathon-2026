/**
 * Regression: the merchant dashboard re-fetches its bookings every 30 s. That refresh has to update the
 * running AG Studio in place. It used to rebuild Studio whenever any row value differed (and the
 * minutes-to-deadline field differs every minute), which wiped the assistant's chat mid-answer, because
 * the conversation lives inside the Studio instance.
 *
 * The assistant itself needs a model key, so this test watches the cause instead: the Studio element
 * must survive a refresh that brings changed rows, and it must show the new data.
 */
import { expect, test } from "@playwright/test";
import type { MerchantBookingRow } from "../../lib/contracts/views";
import { DESKTOP, merchantSignIn } from "./helpers";

test.use({ ...DESKTOP });

const RENAMED = "Renamed by the refresh";

test("merchant dashboard: a refresh with changed rows updates AG Studio in place", async ({ page }) => {
  await merchantSignIn(page);
  const frame = page.locator("#studio-frame");
  await expect(frame.getByText("From confirmed bookings").first()).toBeVisible({ timeout: 30_000 });
  await expect(frame.getByText("Loading...").filter({ visible: true })).toHaveCount(0, { timeout: 30_000 });

  // Tag the live Studio wrapper. A rebuilt Studio is a new element, without the tag.
  await frame.locator("> div").first().evaluate((el) => el.setAttribute("data-e2e-studio", "first"));

  // The next fetch answers as the server would a minute later, plus one booking that really changed.
  await page.route("**/api/merchant/bookings", async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as MerchantBookingRow[];
    const later = rows.map((r, i) => ({
      ...r,
      closesInMinutes: r.closesInMinutes === null ? null : r.closesInMinutes - 1,
      title: i === 0 ? RENAMED : r.title,
    }));
    await route.fulfill({ response, json: later });
  });
  const refreshed = page.waitForResponse((r) => r.url().endsWith("/api/merchant/bookings") && r.status() === 200);
  await page.getByRole("button", { name: "Refresh bookings" }).click();
  await refreshed;

  await expect(frame.getByText(RENAMED).first()).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator('> div[data-e2e-studio="first"]')).toHaveCount(1);
});
