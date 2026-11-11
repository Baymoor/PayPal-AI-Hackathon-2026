/**
 * Judge sign-in, against the second e2e server (same build, JUDGE_PASSWORD set, see tests/e2e/env.ts).
 * With the gate on, /new and outing creation are for signed-in judges; the demo stays open to everyone.
 */
import { expect, test } from "@playwright/test";
import { E2E_JUDGE, E2E_JUDGE_BASE_URL } from "./env";
import { CANONICAL_BRIEF, DESKTOP } from "./helpers";

test.use({ ...DESKTOP, baseURL: E2E_JUDGE_BASE_URL });

test("judge sign-in: /new asks for it, a wrong password is refused, the right one opens /new, sign-out closes it again", async ({ page }) => {
  await test.step("anonymous visitors: /new goes to the sign-in page, creating an outing is refused, the demo stays open", async () => {
    await page.goto("/new");
    await expect(page).toHaveURL(/\/judge\/login\?next=%2Fnew$/);
    await expect(page.getByRole("heading", { name: "Judge sign-in", level: 1 })).toBeVisible();
    await expect(page.getByText("Judges sign in to create real outings with PayPal sandbox and Claude. The demo on /demo needs no sign-in.")).toBeVisible();

    const refused = await page.request.post("/api/outings", { data: { organizerName: "Alex", brief: CANONICAL_BRIEF } });
    expect(refused.status()).toBe(401);
    expect((await refused.json()).error.code).toBe("JUDGE_LOGIN_REQUIRED");

    expect((await page.request.get("/demo")).status()).toBe(200);
  });

  await test.step("a wrong password shows one generic error and stays on the page", async () => {
    await page.getByLabel("Username").fill(E2E_JUDGE.username);
    await page.getByLabel("Password").fill("not-the-judge-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Wrong username or password" })).toBeVisible();
    await expect(page).toHaveURL(/\/judge\/login/);
  });

  await test.step("the right password lands on /new, and the footer says so", async () => {
    await page.getByLabel("Password").fill(E2E_JUDGE.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByRole("contentinfo").getByText("Signed in as judge")).toBeVisible();

    // The sign-in page has nothing left to ask a judge: it goes straight on.
    await page.goto("/judge/login?next=/how-it-works");
    await expect(page).toHaveURL(/\/how-it-works$/);
  });

  await test.step("a hostile next parameter never leaves the site", async () => {
    await page.goto("/judge/login?next=https://evil.example/");
    await expect(page).toHaveURL(/\/new$/);
    await page.goto("/judge/login?next=//evil.example");
    await expect(page).toHaveURL(/\/new$/);
  });

  await test.step("sign-out: /new closes at once, and the footer offers the sign-in link again", async () => {
    await page.getByRole("contentinfo").getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/judge\/login\?next=%2Fnew$/);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Judge sign-in" })).toBeVisible();
    await expect(page.getByRole("contentinfo").getByText("Signed in as judge")).toHaveCount(0);
    const refused = await page.request.post("/api/outings", { data: { organizerName: "Alex", brief: CANONICAL_BRIEF } });
    expect(refused.status()).toBe(401);
  });
});
