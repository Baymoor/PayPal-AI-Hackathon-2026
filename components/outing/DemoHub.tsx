"use client";
import { FlaskConical, LayoutDashboard, RotateCcw, ShieldCheck, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { ModeBadge, Pill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { ApiError, request } from "./api";
import { ActionErrorBanner, useAction } from "./useAction";

/** Shapes returned by GET /api/demo/personas and POST /api/demo/reset (lib/demo/seed.ts DemoState). */
interface Persona {
  participantId: string;
  displayName: string;
  role: "ORGANIZER" | "INVITEE";
  payerType: "PAYER" | "SPONSORED";
  hint: string;
}
interface DemoOuting {
  outingId: string;
  title: string;
  status: string;
  cleanup: string;
  personas: Persona[];
}
interface DemoState {
  outingId: string | null;
  budgetOutingId: string | null;
  outings: DemoOuting[];
}
interface Modes {
  paymentMode: "PAYPAL_SANDBOX" | "FIXTURE" | "DISABLED";
  aiMode: "ANTHROPIC" | "FIXTURE" | "DISABLED";
}

const EMPTY: DemoState = { outingId: null, budgetOutingId: null, outings: [] };

function readState(raw: unknown): DemoState {
  const o = (raw ?? {}) as Partial<DemoState>;
  return {
    outingId: typeof o.outingId === "string" ? o.outingId : null,
    budgetOutingId: typeof o.budgetOutingId === "string" ? o.budgetOutingId : null,
    outings: Array.isArray(o.outings) ? o.outings.filter((x) => x && typeof x.outingId === "string") : [],
  };
}

/** Plain-language stage of a seeded outing (status + money clean-up), never colour alone. */
function stageLabel(o: DemoOuting): string {
  switch (o.status) {
    case "DRAFT":
      return "Brief";
    case "BUDGETING":
      return "Budget poker";
    case "PROPOSED":
      return "Choosing a quote";
    case "COLLECTING":
      return "Collecting commitments";
    case "SETTLING":
      return "Settling";
    case "CONFIRMED":
      return "Confirmed · shares collected";
    case "CANCELLING":
    case "COMPENSATING":
      return "Cancelling";
    case "CANCELLED":
      return o.cleanup === "REFUND_PENDING"
        ? "Not confirmed · refund pending"
        : o.cleanup === "VOID_PENDING"
          ? "Cancelled · hold release pending"
          : o.cleanup === "NEEDS_ATTENTION"
            ? "Cancelled · needs attention"
            : "Cancelled · holds released";
    default:
      return o.status;
  }
}

export function DemoHub() {
  const router = useRouter();
  const [state, setState] = useState<DemoState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [modes, setModes] = useState<Modes | null>(null);
  const [disabled, setDisabled] = useState<string | null>(null);
  const { pending, error, run } = useAction();

  useEffect(() => {
    let alive = true;
    request("/api/demo/personas")
      .then((r) => alive && setState(readState(r)))
      .catch((e: unknown) => {
        if (alive && e instanceof ApiError && e.status === 404) setDisabled("Demo fixtures are turned off on this deployment.");
      })
      .finally(() => alive && setLoaded(true));
    request<Modes>("/api/health")
      .then((h) => alive && setModes({ paymentMode: h.paymentMode, aiMode: h.aiMode }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function reset() {
    setDisabled(null);
    await run("reset", async () => {
      try {
        setState(readState(await request("/api/demo/reset", { method: "POST" })));
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
          setDisabled("Demo fixtures are turned off on this deployment, so there is nothing to reset.");
          return;
        }
        throw e;
      }
    });
  }

  async function switchTo(outingId: string, p: Persona) {
    const ok = await run("persona:" + p.participantId, async () => {
      await request("/api/demo/persona", { method: "POST", json: { participantId: p.participantId } });
      return true;
    });
    if (ok) router.push(`/o/${outingId}`);
  }

  async function merchant() {
    const ok = await run("merchant", async () => {
      await request("/api/merchant/demo-login", { method: "POST" });
      return true;
    });
    if (ok) router.push("/merchant");
  }

  const main = state.outings.find((o) => o.outingId === state.outingId);
  const budget = state.outings.find((o) => o.outingId === state.budgetOutingId);
  const others = state.outings.filter((o) => o !== main && o !== budget);

  const personaList = (o: DemoOuting) => (
    <ul className="grid gap-3 sm:grid-cols-2">
      {o.personas.map((p, i) => (
        <li key={p.participantId} className="flex items-center gap-3 rounded-chip border border-line p-3">
          <Avatar name={p.displayName} index={i} />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{p.displayName}</p>
            <p className="text-small text-ink-muted">{p.hint}</p>
          </div>
          <Button
            variant="secondary"
            className="!min-h-[44px] !px-4 !text-[15px]"
            loading={pending === "persona:" + p.participantId}
            loadingLabel="Opening…"
            aria-label={`Open ${o.title} as ${p.displayName}`}
            onClick={() => switchTo(o.outingId, p)}
          >
            Open
          </Button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Pill>Demo · no real money</Pill>
        <h1 className="text-[36px] leading-10 sm:text-h1 sm:leading-[3rem]">Try the demo</h1>
        <p className="text-lead">Reset to fresh demo outings, then step into anyone&apos;s shoes to see each screen.</p>
      </div>

      <Card tone="blush" className="space-y-3">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-coral-700" aria-hidden />
          <div className="space-y-2">
            <h2 className="text-h3">What is real here?</h2>
            <p>
              No real money ever moves. When PayPal sandbox keys are configured, authorizations happen on PayPal&apos;s sandbox with test accounts.
              Without keys the app uses a simulator, and every screen says so. Seeded outings marked &ldquo;synthetic&rdquo; are demo data.
            </p>
            {modes && (
              <div className="flex flex-wrap items-center gap-2" aria-label="This deployment">
                <span className="text-small font-semibold">This deployment:</span>
                <ModeBadge kind="payment" mode={modes.paymentMode} />
                <ModeBadge kind="ai" mode={modes.aiMode} />
              </div>
            )}
          </div>
        </div>
      </Card>

      <ActionErrorBanner error={error} />
      {disabled && <StatusBanner tone="warning">{disabled}</StatusBanner>}

      <Card className="space-y-4">
        <div className="flex items-center gap-3">
          <RotateCcw className="size-5 text-coral-700" aria-hidden />
          <h2 className="text-h3">1. Reset the demo</h2>
        </div>
        <p className="text-ink-muted">Replaces the demo outings with a fresh set. Outings you created yourself are not touched.</p>
        <Button loading={pending === "reset"} loadingLabel="Resetting…" onClick={reset} variant="secondary">
          Reset demo data
        </Button>
      </Card>

      <Card as="section" aria-labelledby="who-h" className="space-y-4">
        <div className="flex items-center gap-3">
          <UserRound className="size-5 text-coral-700" aria-hidden />
          <h2 id="who-h" className="text-h3">
            2. Pick who you are
          </h2>
        </div>
        {!loaded ? (
          <p className="text-ink-muted">Loading the cast…</p>
        ) : state.outings.length === 0 ? (
          <p className="text-ink-muted">Reset the demo to load the cast.</p>
        ) : (
          <div className="space-y-6">
            {main && (
              <section aria-label={main.title} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-[20px] font-semibold">{main.title}</h3>
                  <Pill tone="neutral">{stageLabel(main)}</Pill>
                </div>
                {personaList(main)}
              </section>
            )}
            {budget && (
              <section aria-label={budget.title} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-[20px] font-semibold">{budget.title}</h3>
                  <Pill tone="neutral">{stageLabel(budget)}</Pill>
                </div>
                {personaList(budget)}
              </section>
            )}
          </div>
        )}
      </Card>

      {others.length > 0 && (
        <Card as="section" aria-labelledby="stages-h" className="space-y-4">
          <h2 id="stages-h" className="text-h3">
            3. Every other outcome
          </h2>
          <p className="text-ink-muted">Synthetic history: confirmed bookings, cancellations with released holds, and a failed capture being refunded.</p>
          <ul className="space-y-4">
            {others.map((o) => (
              <li key={o.outingId} className="space-y-2 rounded-chip border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{o.title}</p>
                  <Pill tone="neutral">{stageLabel(o)}</Pill>
                </div>
                <div className="flex flex-wrap gap-2">
                  {o.personas.map((p) => (
                    <Button
                      key={p.participantId}
                      variant="secondary"
                      className="!min-h-[40px] !px-3 !text-[14px]"
                      loading={pending === "persona:" + p.participantId}
                      loadingLabel="Opening…"
                      aria-label={`Open ${o.title} as ${p.displayName}`}
                      title={p.hint}
                      onClick={() => switchTo(o.outingId, p)}
                    >
                      {p.displayName}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="space-y-3">
        <div className="flex items-center gap-3">
          <LayoutDashboard className="size-5 text-coral-700" aria-hidden />
          <h2 className="text-h3">The merchant&apos;s view</h2>
        </div>
        <p className="text-ink-muted">See bookings, holds and captures the way the venue does.</p>
        <Button variant="secondary" loading={pending === "merchant"} loadingLabel="Opening…" onClick={merchant}>
          Open merchant dashboard
        </Button>
      </Card>
      <p className="flex items-center gap-2 text-small text-ink-muted">
        <FlaskConical className="size-4" aria-hidden />
        Independent hackathon project. Not affiliated with PayPal.
      </p>
    </div>
  );
}
