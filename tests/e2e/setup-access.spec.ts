/**
 * /setup is the owner's diagnostics page: it lists which settings exist and has buttons that call the
 * real PayPal and Anthropic APIs. The one-click demo sign-in needs no credentials, so it must not open
 * it. Demo visitors get a plain explanation instead of an error page; the dashboard password opens it.
 */
import { expect, test } from "@playwright/test";
import { E2E_ENV } from "./env";
import { DESKTOP, merchantSignIn } from "./helpers";

test.use({ ...DESKTOP });

test("setup: the demo sign-in is turned away kindly, the dashboard password opens it", async ({ page }) => {
  await test.step("demo sign-in: no Setup link, a friendly notice, and the API refuses", async () => {
    await merchantSignIn(page);
    await expect(page.getByRole("link", { name: "Setup" })).toHaveCount(0);

    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Setup is for the site owner" })).toBeVisible();
    await expect(page.getByText("Environment variables")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Test / })).toHaveCount(0);

    for (const check of ["paypal", "anthropic"]) {
      const res = await page.request.post(`/api/merchant/setup/${check}`, { data: {} });
      expect(res.status(), check).toBe(403);
    }
  });

  await test.step("dashboard password: the Setup link appears and the page opens", async () => {
    await page.getByRole("link", { name: "Sign in with the password" }).click();
    await expect(page).toHaveURL(/\/merchant\/login/);
    await page.getByLabel("Dashboard password").fill(E2E_ENV.MERCHANT_DASHBOARD_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/merchant$/);

    await page.getByRole("link", { name: "Setup" }).click();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("heading", { name: "Setup", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Test PayPal sandbox OAuth" })).toBeVisible();
  });
});
