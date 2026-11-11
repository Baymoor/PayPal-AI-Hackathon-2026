/**
 * The canonical demo, end to end in real browsers (one context per person):
 * brief -> private budget poker -> aggregate-only reveal -> $100 karaoke room, Maya sponsored ->
 * five payers authorize $20 each via the FIXTURE approval page -> Maya accepts -> every page is closed ->
 * the server deadline settles the booking -> everyone sees CONFIRMED with a $20 final share -> merchant dashboard.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  CANONICAL_BRIEF,
  DESKTOP,
  MOBILE,
  deadlineFrom,
  localInput,
  merchantDetail,
  merchantSignIn,
  newPage,
  openInvitation,
  shot,
  tickUntil,
  viewOf,
} from "./helpers";

const INVITEES = ["Ben", "Freya", "Jules", "Noor", "Maya"] as const;
type Name = "Alex" | (typeof INVITEES)[number];
const VOTES: Partial<Record<Name, string>> = { Alex: "$100", Ben: "$100", Freya: "$75", Jules: "$150", Noor: "$100" };
const PAYERS: Name[] = ["Alex", "Ben", "Freya", "Jules", "Noor"];

test("karaoke for Maya: plan, vote privately, commit, settle at the deadline, merchant sees it", async ({ browser, request }) => {
  test.setTimeout(6 * 60_000);
  const contexts: BrowserContext[] = [];
  const pages = {} as Record<Name, Page>;
  let outingId = "";
  const links = {} as Record<(typeof INVITEES)[number], string>;

  // Organizer plans on a phone, then switches to a desktop-sized window for the organizer tools.
  const org = await newPage(browser, MOBILE);
  contexts.push(org.context);
  pages.Alex = org.page;
  const alex = org.page;

  await test.step("(a) organizer writes the brief and sees what the (sample) AI understood", async () => {
    await alex.goto("/new");
    await alex.getByLabel("Your name").fill("Alex");
    await alex.getByLabel("Your plan").fill(CANONICAL_BRIEF);
    await expect(alex.getByLabel("Your plan")).toHaveValue(CANONICAL_BRIEF);
    await alex.getByRole("button", { name: "Find an outing" }).click();
    await expect(alex).toHaveURL(/\/o\/[0-9a-f-]{36}$/, { timeout: 20_000 });
    outingId = alex.url().split("/o/")[1]!;

    const understood = alex.locator("section", { has: alex.getByRole("heading", { name: "Here's what I understood" }) });
    await expect(understood).toBeVisible();
    await expect(understood.getByText("Sample AI text (no model call)")).toBeVisible();
    await expect(understood).toContainText("Maya");
    await expect(alex.getByText(/Simulated payments/).first()).toBeVisible();
    const v = await viewOf(alex, outingId);
    expect(v.outing.status).toBe("DRAFT");
    expect(v.brief.source).toBe("FIXTURE");
    expect(v.brief.extraction?.guestOfHonour.name).toBe("Maya");
    await shot(alex, "brief");
  });

  await test.step("(a) start budget poker and create one-time invitation links", async () => {
    await alex.getByRole("button", { name: "Start budget poker" }).click();
    await expect(alex.getByRole("heading", { name: "Budget poker", level: 1 })).toBeVisible();
    await alex.getByLabel("Names, one per line or separated by commas").fill(INVITEES.join("\n"));
    await alex.getByRole("button", { name: "Create invitation links" }).click();
    await expect(alex.getByText("Copy these links now")).toBeVisible();
    for (const name of INVITEES) {
      const item = alex.locator("li", { has: alex.getByRole("button", { name: `Copy invitation link for ${name}` }) });
      links[name] = (await item.locator("p.select-all").innerText()).trim();
      expect(links[name]).toMatch(/^http:\/\/localhost:\d+\/i\/[A-Za-z0-9_-]{20,}$/);
    }
  });

  await test.step("(b) everyone opens their own link; five people vote privately", async () => {
    for (const name of INVITEES) {
      const p = await openInvitation(browser, links[name]);
      contexts.push(p.context);
      pages[name] = p.page;
      await expect(p.page.getByRole("heading", { name: "Budget poker", level: 1 })).toBeVisible();
    }
    for (const name of PAYERS) {
      const page = pages[name];
      if (name === "Alex") await page.reload();
      const amount = VOTES[name]!;
      await page.locator("label").filter({ hasText: new RegExp(`^\\${amount}$`) }).click();
      await page.getByRole("button", { name: `Submit my ${amount} vote` }).click();
      await expect(page.getByRole("button", { name: `Your ${amount} vote is saved` })).toBeDisabled();
    }
    await pages.Ben.reload();
    await expect(pages.Ben.getByText("5 of 6 voted")).toBeVisible();
    await shot(pages.Ben, "budget-poker");
  });

  await test.step("(b) votes stay private before the reveal (API-enforced, not CSS)", async () => {
    const maya = pages.Maya;
    await maya.reload();
    await expect(maya.getByText("5 of 6 voted")).toBeVisible();
    const v = await viewOf(maya, outingId);
    expect(v.budget.myVoteMinor).toBeNull();
    expect(v.budget.aggregate).toBeNull();
    expect(v.budget.votedCount).toBe(5);
    // People carry only "has voted", never an amount.
    for (const person of v.roster.people) expect(Object.keys(person).filter((k) => /amount|vote(?!d)/i.test(k))).toEqual([]);
    const ben = await viewOf(pages.Ben, outingId);
    expect(ben.budget.myVoteMinor).toBe(10_000); // only your own vote
    // Only the organizer can reveal.
    const forbidden = await maya.request.post(`/api/outings/${outingId}/budget/reveal`, { headers: { origin: new URL(maya.url()).origin } });
    expect(forbidden.status()).toBe(403);
  });

  await test.step("(b) organizer reveals: aggregate only", async () => {
    await alex.setViewportSize(DESKTOP.viewport);
    await alex.reload();
    await alex.getByRole("button", { name: "Reveal", exact: true }).click();
    await expect(alex.getByRole("heading", { name: "Here’s where the group landed" })).toBeVisible();
    await expect(alex.getByRole("img", { name: /\$100: 3 votes/ })).toBeVisible();
    await expect(alex.getByText("Sample AI text (no model call)").first()).toBeVisible();
    await shot(alex, "reveal", { fullPage: false });

    const maya = pages.Maya;
    await maya.reload();
    await expect(maya.getByRole("heading", { name: "Here’s where the group landed" })).toBeVisible();
    await expect(maya.getByRole("button", { name: /Agree on/ })).toHaveCount(0);
    const v = await viewOf(maya, outingId);
    expect(v.budget.revealed).toBe(true);
    expect(v.budget.aggregate?.buckets).toEqual(
      expect.arrayContaining([
        { amountMinor: 7_500, count: 1 },
        { amountMinor: 10_000, count: 3 },
        { amountMinor: 15_000, count: 1 },
      ]),
    );
    expect(v.budget.myVoteMinor).toBeNull();
    const names = v.roster.people.map((p) => p.displayName);
    expect(JSON.stringify(v.budget)).not.toMatch(new RegExp(names.join("|")));
  });

  await test.step("(b) agree on $100, pick the karaoke room, sponsor Maya", async () => {
    await alex.getByRole("button", { name: "Agree on $100 budget" }).click();
    await expect(alex.getByRole("heading", { name: "Pick a place and a price" })).toBeVisible();
    const room = alex.locator("label").filter({ hasText: "Private karaoke room" });
    await expect(room).toContainText("$100 fixed total · up to 10 people");
    await expect(alex.locator("label").filter({ hasText: "Karaoke party suite" })).toBeVisible();
    await room.click();
    await expect(room.getByText("Selected", { exact: true })).toBeVisible();

    // The brief named Maya as guest of honour, so she is preselected.
    await expect(alex.getByLabel("Guest of honour")).toHaveValue(/.+/);
    await expect(alex.getByLabel("Guest of honour").locator("option:checked")).toHaveText("Maya");
    await alex.getByRole("switch", { name: "Cover Maya's share" }).click();
    await expect(alex.getByText("On. Maya pays $0.")).toBeVisible();
    const split = alex.locator("section", { has: alex.getByRole("heading", { name: "Split preview" }) });
    await expect(split).toContainText("Each person paying$20");
    await expect(split).toContainText("Maya pays$0");
    await expect(alex.getByLabel("Minimum payers")).toHaveValue("5");
    await expect(alex.getByText(/^Each payer authorizes up to \$20 by /)).toBeVisible();
    await shot(alex, "sponsor");
  });

  await test.step("(b) open commitments with a deadline ~80 s away (server clock)", async () => {
    const v = await viewOf(alex, outingId);
    const deadline = deadlineFrom(v.outing.serverNow, 80);
    await alex.getByLabel("Commit by").fill(localInput(deadline, v.outing.displayTimezone));
    // Keep the suggested activity time (next Friday evening, from the brief).
    await alex.getByRole("button", { name: "Open commitments" }).click();
    await expect(alex.getByRole("heading", { name: "Commit your share." })).toBeVisible();
    const opened = await viewOf(alex, outingId);
    expect(opened.outing.status).toBe("COLLECTING");
    expect(opened.quote?.capMinor).toBe(2_000);
    expect(opened.quote?.sponsoredNames).toEqual(["Maya"]);
    expect(opened.outing.deadlineAt).toBe(deadline.toISOString());
  });

  await test.step("(c) each payer reviews terms, consents, approves on the FIXTURE page, returns authorized", async () => {
    for (const [i, name] of PAYERS.entries()) {
      const page = pages[name];
      await page.goto(`/o/${outingId}`);
      if (name === "Noor") {
        await expect(page.getByText("4 of 5 payers committed").first()).toBeVisible();
        await shot(page, "invitation");
      }
      await page.getByRole("button", { name: "Review & authorize $20" }).click();
      const terms = page.locator("section", { has: page.getByRole("heading", { name: "Review your terms" }) });
      await expect(terms).toContainText("The Sound Room");
      await expect(terms).toContainText("Maya");
      await expect(terms).toContainText("Equal split");
      await expect(terms).toContainText("Your maximum$20");
      await page.getByRole("checkbox", { name: /I agree to authorize up to \$20/ }).check();
      await page.getByRole("button", { name: "Authorize up to $20 (simulated)" }).click();

      await expect(page).toHaveURL(/\/pay\/fixture\?attempt=/);
      await expect(page.getByText("Simulated approval page")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Authorize up to $20.00" })).toBeVisible();
      await page.getByRole("button", { name: "Approve simulated hold" }).click();

      await expect(page).toHaveURL(new RegExp(`/o/${outingId}\\?payment=authorized$`));
      await expect(page.getByText("Authorization received")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Your $20 hold is in place." })).toBeVisible();
      await expect(page.getByText(`${i + 1} of 5 payers committed`)).toBeVisible();
      const me = await viewOf(page, outingId);
      expect(me.me.payment).toMatchObject({ status: "AUTHORIZED", provider: "FIXTURE", authorizedMinor: 2_000, capturedMinor: 0 });
      if (name === "Noor") await shot(page, "waiting");
    }
  });

  await test.step("(c) Maya, the sponsored guest, accepts attendance (pays $0)", async () => {
    const maya = pages.Maya;
    await maya.goto(`/o/${outingId}`);
    await expect(maya.getByText("You pay")).toBeVisible();
    await maya.getByRole("button", { name: "I'll be there" }).click();
    await expect(maya.getByText("You’re in")).toBeVisible();
    expect((await viewOf(maya, outingId)).viewer.attendance).toBe("ACCEPTED");
  });

  await test.step("(d) all pages closed; the deadline job settles the booking", async () => {
    for (const c of contexts) await c.close();
    // Nothing can settle early: still COLLECTING right now.
    const { context, page } = await newPage(browser, MOBILE);
    await page.goto(links.Ben);
    expect((await viewOf(page, outingId)).outing.status).toBe("COLLECTING");
    await tickUntil(request, async () => (await viewOf(page, outingId)).outing.status === "CONFIRMED");
    await context.close();
  });

  await test.step("(d) reopening shows CONFIRMED with each payer's final $20 share", async () => {
    for (const name of INVITEES) {
      const { context, page } = await openInvitation(browser, links[name]);
      await expect(page.getByRole("heading", { name: "You’re going." })).toBeVisible();
      await expect(page.getByText("Booking confirmed")).toBeVisible();
      const v = await viewOf(page, outingId);
      expect(v.outing.status).toBe("CONFIRMED");
      expect(v.settlement).toMatchObject({ decision: "SETTLE", payerCount: 5, totalMinor: 10_000 });
      if (name === "Maya") {
        expect(v.me.finalShareMinor).toBe(0);
        expect(v.me.payment).toBeNull();
        await expect(page.getByText("Your share was covered, so you pay $0.")).toBeVisible();
      } else {
        expect(v.me.finalShareMinor).toBe(2_000);
        expect(v.me.payment).toMatchObject({ status: "CAPTURED", capturedMinor: 2_000, authorizedMinor: 2_000 });
        expect(v.me.payment!.capturedMinor).toBeLessThanOrEqual(v.me.payment!.authorizedMinor);
        await expect(page.locator("dl > div").filter({ hasText: "Your final share" })).toContainText("$20");
        if (name === "Ben") await shot(page, "confirmed");
      }
      await context.close();
    }
  });

  await test.step("(d) merchant dashboard shows captured totals and the drill-down", async () => {
    const { context, page } = await newPage(browser, DESKTOP);
    await merchantSignIn(page);
    await expect(page.getByText("Simulated · not real PayPal").first()).toBeVisible();
    // FIXTURE-paid outings are never presented as real PayPal sandbox money.
    // The segment's accessible name carries a count for screen readers, e.g. "Simulated (7 outings)".
    await expect(page.getByRole("button", { name: /^Simulated \(/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("From confirmed bookings").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Maya's birthday karaoke").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
    // AG Studio renders charts asynchronously; wait until no widget is still loading.
    await expect(page.locator("#studio-frame").getByText("Loading...").filter({ visible: true })).toHaveCount(0, { timeout: 30_000 });
    await shot(page, "merchant-dashboard");

    // Natural-language query becomes read-only filters (FIXTURE parser here, and labelled as such).
    await page.getByRole("button", { name: "Try the example" }).click();
    await expect(page.getByText("Sample AI text (no model call)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear filter" })).toBeVisible();
    await expect(page.getByText("Escape room with the climbing crew (sample)").first()).toBeVisible();

    const d = await merchantDetail(page, outingId);
    expect(d.booking).toMatchObject({ status: "CONFIRMED", capturedTotalMinor: 10_000, allocatedTotalMinor: 10_000, authorizedTotalMinor: 0, provider: "FIXTURE" });
    expect(d.operations.filter((o) => o.kind === "CAPTURE" && o.status === "SUCCEEDED")).toHaveLength(5);

    await page.goto(`/merchant/outings/${outingId}`);
    await expect(page.getByRole("heading", { name: "Maya's birthday karaoke" })).toBeVisible();
    await expect(page.getByText("Simulated · not real PayPal").first()).toBeVisible();
    await expect(page.getByText("Captured", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("$100.00").first()).toBeVisible();
    await expect(page.locator(".ag-row", { hasText: "Succeeded" })).toHaveCount(5);
    await shot(page, "merchant-drilldown", { fullPage: false });
    await page.getByRole("heading", { name: "Participants" }).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot(page, "merchant-drilldown-payments", { fullPage: false, keepScroll: true });
    await context.close();
  });
});
