"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { FriendlyError } from "@/components/errors/friendlyError";
import { DEMO_MERCHANT_SLUG, DEMO_VENUE_NAMES, DEMO_VENUE_SLUGS, isDemoVenueSlug, type DemoVenueSlug } from "@/lib/demo/constants";
import { fetchHealth, merchantDemoLogin, merchantLogin } from "./api";
import { describeMerchantError, MerchantErrorText } from "./MerchantError";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "demo" | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [demo, setDemo] = useState(false);
  const [venue, setVenue] = useState<DemoVenueSlug>(DEMO_MERCHANT_SLUG);

  useEffect(() => {
    fetchHealth().then((h) => setDemo(Boolean(h.demoFixturesEnabled))).catch(() => setDemo(false));
  }, []);

  async function go(kind: "password" | "demo") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "password") await merchantLogin(password);
      else await merchantDemoLogin(venue);
      router.push("/merchant");
      router.refresh();
    } catch (e) {
      const friendly = describeMerchantError(e);
      // When the demo button is on screen, it's the obvious way in, so point there instead.
      setError(demo && friendly.code === "LOGIN_DISABLED" ? { ...friendly, nextStep: "Use Open demo merchant dashboard below instead." } : friendly);
      setBusy(null);
    }
  }

  return (
    <div className="m-login">
      <div className="m-card">
        <h1 className="m-h1" style={{ fontSize: 32, lineHeight: "38px" }}>Merchant sign in</h1>
        <p className="m-sub">See your venue&apos;s group bookings as they move from holds to captures and refunds.</p>
        <form onSubmit={(e) => { e.preventDefault(); void go("password"); }}>
          <div className="m-field">
            <label htmlFor="m-pw">Dashboard password</label>
            <input id="m-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={error ? "m-err" : undefined} required />
          </div>
          {error && <p id="m-err" className="m-error" role="alert"><MerchantErrorText error={error} /></p>}
          <button className="m-btn m-btn-primary" type="submit" disabled={busy !== null || !password} style={{ width: "100%" }}>
            {busy === "password" ? "Signing in..." : "Sign in"}
          </button>
        </form>
        {demo && (
          <>
            <div className="m-divider">or</div>
            <div className="m-field">
              <label htmlFor="m-venue">Demo venue</label>
              <select
                id="m-venue"
                value={venue}
                onChange={(e) => {
                  if (isDemoVenueSlug(e.target.value)) setVenue(e.target.value);
                }}
              >
                {DEMO_VENUE_SLUGS.map((slug) => (
                  <option key={slug} value={slug}>{DEMO_VENUE_NAMES[slug]}</option>
                ))}
              </select>
            </div>
            <button className="m-btn" type="button" onClick={() => void go("demo")} disabled={busy !== null} style={{ width: "100%" }}>
              {busy === "demo" ? "Opening..." : "Open demo merchant dashboard"}
            </button>
            <p className="m-footnote">Demo mode: includes clearly labelled synthetic fixture bookings. Not real PayPal data.</p>
          </>
        )}
      </div>
    </div>
  );
}
