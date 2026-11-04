"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, fetchHealth, merchantDemoLogin, merchantLogin } from "./api";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    fetchHealth().then((h) => setDemo(Boolean(h.demoFixturesEnabled))).catch(() => setDemo(false));
  }, []);

  async function go(kind: "password" | "demo") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "password") await merchantLogin(password);
      else await merchantDemoLogin();
      router.push("/merchant");
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? "That password was not accepted." : e instanceof Error ? e.message : "Sign-in failed.");
      setBusy(null);
    }
  }

  return (
    <div className="m-login">
      <div className="m-card">
        <h1 className="m-h1" style={{ fontSize: 32, lineHeight: "38px" }}>Merchant sign in</h1>
        <p className="m-sub">See group bookings for The Sound Room as they move from holds to captures and refunds.</p>
        <form onSubmit={(e) => { e.preventDefault(); void go("password"); }}>
          <div className="m-field">
            <label htmlFor="m-pw">Dashboard password</label>
            <input id="m-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={error ? "m-err" : undefined} required />
          </div>
          {error && <p id="m-err" className="m-error" role="alert">{error}</p>}
          <button className="m-btn m-btn-primary" type="submit" disabled={busy !== null || !password} style={{ width: "100%" }}>
            {busy === "password" ? "Signing in..." : "Sign in"}
          </button>
        </form>
        {demo && (
          <>
            <div className="m-divider">or</div>
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
