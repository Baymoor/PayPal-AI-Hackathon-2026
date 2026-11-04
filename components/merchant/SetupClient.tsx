"use client";

import { useState } from "react";
import { runSetupCheck } from "./api";

interface Summary {
  paymentMode: string;
  aiMode: string;
  aiModel: string | null;
  demoFixturesEnabled: boolean;
  agStudioLicensed: boolean;
  webhookVerification: boolean;
  sessionSecretIsEphemeral: boolean;
  trustedProxyHops: number;
}

const yn = (b: boolean) => (b ? "Yes" : "No");

function CheckCard({ id, title, intro, button, which, render }: { id: string; title: string; intro: string; button: string; which: "paypal" | "anthropic"; render?: (r: Record<string, unknown>) => React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await runSetupCheck(which));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "Check failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="m-card" aria-labelledby={`${id}-h`}>
      <h2 className="m-h2" id={`${id}-h`}>{title}</h2>
      <p className="m-sub">{intro}</p>
      <p style={{ marginTop: 12 }}>
        <button type="button" className="m-btn m-btn-primary" onClick={run} disabled={busy} aria-describedby={`${id}-out`}>
          {busy ? "Checking…" : button}
        </button>
      </p>
      <div id={`${id}-out`} role="status" aria-live="polite">
        {error && <div className="m-setup-result" data-ok="false">{error}</div>}
        {result && (
          <div className="m-setup-result" data-ok={String(result.ok === true)}>
            <strong>{result.ok === true ? "OK" : "Not OK"}</strong>
            {typeof result.label === "string" && <> · <span className="m-badge" data-tone="fixture">{result.label}</span></>}
            <p style={{ margin: "6px 0 0" }}>{String(result.message ?? "")}</p>
            <dl style={{ margin: "8px 0 0", display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px" }}>
              {(["status", "httpStatus", "code", "model", "latencyMs", "debugId"] as const)
                .filter((k) => result[k] != null)
                .map((k) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt style={{ color: "var(--m-ink-muted)" }}>{k === "latencyMs" ? "latency" : k === "debugId" ? "debug_id" : k}</dt>
                    <dd style={{ margin: 0 }}>{String(result[k])}{k === "latencyMs" ? " ms" : ""}</dd>
                  </div>
                ))}
            </dl>
            {render?.(result)}
          </div>
        )}
      </div>
    </section>
  );
}

export function SetupClient({ summary, vars, cronUrl, webhookUrl }: { summary: Summary; vars: { name: string; note: string; state: string }[]; cronUrl: string; webhookUrl: string }) {
  const modeRows: [string, string][] = [
    ["Payment mode", summary.paymentMode],
    ["AI mode", summary.aiMode + (summary.aiModel ? ` (${summary.aiModel})` : "")],
    ["Demo fixtures enabled", yn(summary.demoFixturesEnabled)],
    ["AG Studio licensed", yn(summary.agStudioLicensed)],
    ["PayPal webhook verification configured", yn(summary.webhookVerification)],
    ["TRUSTED_PROXY_HOPS", String(summary.trustedProxyHops)],
    ["Session secret is ephemeral", summary.sessionSecretIsEphemeral ? "Yes (sessions reset on restart)" : "No"],
  ];
  return (
    <div className="m-page">
      <div className="m-title-row">
        <div>
          <h1 className="m-h1">Setup</h1>
          <p className="m-sub">Owner diagnostics for this deployment. Shows which settings exist, never their values.</p>
        </div>
      </div>

      <div className="m-setup-grid">
        <section className="m-card" aria-labelledby="modes-h">
          <h2 className="m-h2" id="modes-h">Current modes</h2>
          <ul className="m-setup-list">
            {modeRows.map(([k, v]) => (
              <li key={k}><span>{k}</span><strong>{v}</strong></li>
            ))}
          </ul>
        </section>

        <section className="m-card" aria-labelledby="env-h">
          <h2 className="m-h2" id="env-h">Environment variables</h2>
          <ul className="m-setup-list">
            {vars.map((v) => (
              <li key={v.name}>
                <span><code>{v.name}</code> <span style={{ color: "var(--m-ink-muted)" }}>· {v.note}</span></span>
                <span className="m-badge" data-tone={v.state === "set" ? "captured" : undefined}>{v.state === "set" ? "set" : "not set"}</span>
              </li>
            ))}
          </ul>
        </section>

        <CheckCard
          id="pp"
          title="PayPal sandbox"
          intro="Requests a fresh OAuth token from api-m.sandbox.paypal.com. Only the result is shown, never the token."
          button="Test PayPal sandbox OAuth"
          which="paypal"
        />
        <CheckCard
          id="ai"
          title="Anthropic"
          intro="One small real extractBrief call. Only runs when OUTINGS_ANTHROPIC_API_KEY is set; fixture mode is labelled."
          button="Test Anthropic"
          which="anthropic"
          render={(r) =>
            Array.isArray(r.summary) ? (
              <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {(r.summary as { icon: string; text: string }[]).map((s, i) => (
                  <li key={i}>{s.text}</li>
                ))}
              </ul>
            ) : null
          }
        />

        <section className="m-card" aria-labelledby="urls-h">
          <h2 className="m-h2" id="urls-h">Scheduler and webhook</h2>
          <p className="m-sub">Scheduler (every minute) calls:</p>
          <p><code className="m-setup-code">POST {cronUrl}</code></p>
          <p><code className="m-setup-code">Authorization: Bearer $CRON_SECRET</code></p>
          <p className="m-sub" style={{ marginTop: 12 }}>PayPal webhook URL to configure (then set PAYPAL_WEBHOOK_ID):</p>
          <p><code className="m-setup-code">{webhookUrl}</code></p>
        </section>

        <section className="m-card" aria-labelledby="todo-h">
          <h2 className="m-h2" id="todo-h">Next tasks</h2>
          <p className="m-sub">From docs/HANDOFF_TO_CODEX.md section 6.</p>
          <ol style={{ paddingLeft: 20, display: "grid", gap: 8 }}>
            <li><strong>Prove PayPal sandbox.</strong> Create the sandbox app and two Personal buyers, set the credentials, then run <code>npx tsx scripts/paypal-smoke.ts</code> (add <code>--mock-decline</code> for the decline path). Commit the redacted evidence.</li>
            <li><strong>Prove real Claude.</strong> Set the key, run <code>npx tsx scripts/ai-smoke.ts</code>, commit the evidence, create one outing at /new.</li>
            <li><strong>Deploy.</strong> Postgres, web, scheduler on the cron URL above, HTTPS APP_BASE_URL, PayPal webhook, AG Studio trial key.</li>
            <li><strong>Submission.</strong> Record the demo video, fill the Devpost TODOs, make the repo public (deadline 11 Nov).</li>
            <li><strong>Hardening.</strong> Shared rate limiter for multi-instance hosting; set TRUSTED_PROXY_HOPS behind a load balancer.</li>
          </ol>
        </section>
      </div>
    </div>
  );
}
