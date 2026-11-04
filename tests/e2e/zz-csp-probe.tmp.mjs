import { chromium } from "@playwright/test";
const B = "http://localhost:3400";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const issues = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) issues.push(`console.${m.type()} ${page.url()} ${m.text()}`); });
page.on("pageerror", (e) => issues.push(`pageerror ${page.url()} ${e.message}`));
await page.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => { (window.__v ??= []).push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile || ""}`); });
});
const viol = async (label) => { const v = await page.evaluate(() => window.__v || []).catch(() => ["(eval fail)"]); console.log(label, "violations:", v.length, v.join(" | ")); };
async function visit(path, label = path) {
  const r = await page.goto(B + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const csp = r.headers()["content-security-policy"];
  console.log(label, r.status(), csp ? "csp-ok" : "NO CSP");
  await viol(label);
}
await visit("/"); await visit("/how-it-works"); await visit("/demo"); await visit("/new"); await visit("/merchant/login"); await visit("/setup");
const p = await (await fetch(B + "/api/demo/personas")).json();
await page.goto(p.personas[1].link, { waitUntil: "networkidle" }); await page.waitForTimeout(1500); console.log("participant", page.url()); await viol("participant");
const id = p.outingId;
const noor = p.personas.find((x) => x.displayName === "Noor");
await page.goto(noor.link, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
await viol("noor hub");
const btn = page.getByRole("button", { name: /Review & authorize/ });
if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(1500);
  const consent = page.getByRole("checkbox"); for (let i = 0; i < await consent.count(); i++) await consent.nth(i).check().catch(() => {});
  const go = page.getByRole("button", { name: /Continue to|Authorize|Approve|PayPal/i }); console.log("go buttons", await go.count());
  if (await go.count()) await go.last().click().catch((e) => console.log("click err", e.message));
  await page.waitForTimeout(3000); console.log("after authorize url", page.url()); await viol("after authorize"); }

await page.goto(B + "/merchant/login"); await page.getByRole("button", { name: "Open demo merchant dashboard" }).click(); await page.waitForURL(/\/merchant$/);
await page.waitForTimeout(6000); await viol("merchant");
await page.screenshot({ path: "/tmp/claude-0/-home-user-PayPal-AI-Hackathon-2026/cab8f0b0-0b5e-515a-91e8-7b10f49795bf/scratchpad/merchant.png" });
console.log("charts/canvas/svg count", await page.locator("canvas, svg").count());
for (const t of ["Money", "Bookings"]) { const l = page.getByRole("link", { name: t, exact: true }).or(page.getByRole("tab", { name: t, exact: true })).or(page.getByRole("button", { name: t, exact: true })); if (await l.count()) { await l.first().click(); await page.waitForTimeout(3000); await viol("merchant " + t); } else console.log("no nav", t); }
await visit(`/merchant/outings/${id}`); await page.waitForTimeout(3000); await viol("merchant outing");
console.log("ISSUES", issues.length); issues.forEach((i) => console.log(i));
await browser.close();
