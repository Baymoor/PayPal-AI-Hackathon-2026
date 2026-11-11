import { expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { MerchantOutingDetail, OutingView } from "../../lib/contracts/views";
import { E2E_ENV } from "./env";

/** Participant screens are phones; organizer/merchant screens are desktops. Both retina for screenshots. */
export const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 } as const;
export const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } as const;

export const CANONICAL_BRIEF =
  "A karaoke night for Maya's birthday. Six of us, Friday evening. We want a private room and to cover Maya's share.";

/** Refreshes docs/screenshots/<name>.png only when E2E_SCREENSHOTS=1 (real app state, never dev-preview fixtures). */
export async function shot(page: Page, name: string, opts: { fullPage?: boolean; keepScroll?: boolean } = {}): Promise<void> {
  if (process.env.E2E_SCREENSHOTS !== "1") return;
  const fullPage = opts.fullPage ?? true;
  await page.evaluate(async (top) => {
    await document.fonts.ready;
    if (top) window.scrollTo(0, 0);
  }, !fullPage && !opts.keepScroll);
  await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage, animations: "disabled", caret: "hide" });
}

/** An element's box in page coordinates (not viewport coordinates), so it can clip a full-page screenshot. */
async function pageBox(target: Locator): Promise<{ left: number; top: number; right: number; bottom: number }> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left + window.scrollX, top: r.top + window.scrollY, right: r.right + window.scrollX, bottom: r.bottom + window.scrollY };
  });
}

/**
 * Like `shot`, but only the area that covers the given elements, with a little breathing room. For the README,
 * where a whole long page would bury the one thing the picture is there to show.
 */
export async function shotAround(page: Page, name: string, targets: readonly Locator[], padding = 24): Promise<void> {
  if (process.env.E2E_SCREENSHOTS !== "1") return;
  await page.evaluate(() => document.fonts.ready);
  const boxes = await Promise.all(targets.map(pageBox));
  const left = Math.max(0, Math.min(...boxes.map((b) => b.left)) - padding);
  const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) - padding);
  const right = Math.max(...boxes.map((b) => b.right)) + padding;
  const bottom = Math.max(...boxes.map((b) => b.bottom)) + padding;
  await page.screenshot({
    path: `docs/screenshots/${name}.png`,
    fullPage: true,
    clip: { x: left, y: top, width: right - left, height: bottom - top },
    animations: "disabled",
    caret: "hide",
  });
}

export async function newPage(browser: Browser, device: typeof MOBILE | typeof DESKTOP): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...device });
  const page = await context.newPage();
  return { context, page };
}

/** GET the viewer's own OutingView with the page's cookies (same JSON the UI renders). */
export async function viewOf(page: Page, outingId: string): Promise<OutingView> {
  const res = await page.request.get(`/api/outings/${outingId}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as OutingView;
}

export async function merchantDetail(page: Page, outingId: string): Promise<MerchantOutingDetail> {
  const res = await page.request.get(`/api/merchant/outings/${outingId}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as MerchantOutingDetail;
}

/** One scheduler tick, exactly what a cron service does: POST /api/cron/tick with the bearer secret. */
export async function cronTick(request: APIRequestContext): Promise<void> {
  const res = await request.post("/api/cron/tick", { headers: { authorization: `Bearer ${E2E_ENV.CRON_SECRET}` } });
  expect(res.status(), `cron tick: ${await res.text()}`).toBe(200);
}

/** Ticks the worker until `done()` holds (the deadline itself is enforced by the server clock, not by us). */
export async function tickUntil(request: APIRequestContext, done: () => Promise<boolean>, timeoutMs = 4 * 60_000): Promise<void> {
  await expect
    .poll(
      async () => {
        await cronTick(request);
        return done();
      },
      { timeout: timeoutMs, intervals: [2_000] },
    )
    .toBe(true);
}

/** "YYYY-MM-DDTHH:mm" wall time of `d` in `timeZone` (the value a datetime-local input takes). */
export function localInput(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** A commitment deadline `minSeconds`+ from `serverNow`, on a whole minute (datetime-local has minute precision). */
export function deadlineFrom(serverNowIso: string, minSeconds: number): Date {
  return new Date(Math.ceil((Date.parse(serverNowIso) + minSeconds * 1000) / 60_000) * 60_000);
}

/** The first whole local `hour`:00 in `timeZone` strictly after `after` (demo catalogue slots start on the hour). */
export function nextLocalHour(after: Date, hour: number, timeZone: string): Date {
  const start = Math.ceil(after.getTime() / 3_600_000) * 3_600_000;
  for (let i = 0; i < 72; i++) {
    const t = new Date(start + i * 3_600_000);
    if (localInput(t, timeZone).endsWith(`T${String(hour).padStart(2, "0")}:00`)) return t;
  }
  throw new Error(`no ${hour}:00 in ${timeZone} within 3 days`);
}

/** Opens a one-time invitation link in a fresh browser context (sets that person's session cookie). */
export async function openInvitation(browser: Browser, link: string): Promise<{ context: BrowserContext; page: Page }> {
  const { context, page } = await newPage(browser, MOBILE);
  await page.goto(link);
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  return { context, page };
}

/** Merchant dashboard demo sign-in (only offered when DEMO_FIXTURES_ENABLED). */
export async function merchantSignIn(page: Page): Promise<void> {
  await page.goto("/merchant");
  await expect(page).toHaveURL(/\/merchant\/login/);
  await page.getByRole("button", { name: "Open demo merchant dashboard" }).click();
  await expect(page).toHaveURL(/\/merchant$/);
  await expect(page.getByRole("heading", { name: "Bookings", level: 1 })).toBeVisible();
}
