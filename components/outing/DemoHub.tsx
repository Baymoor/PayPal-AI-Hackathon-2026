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

interface Persona {
  participantId: string;
  displayName: string;
  role?: string;
  description?: string;
  payerType?: string;
}
interface DemoState {
  outingId: string | null;
  personas: Persona[];
}

/** Defensive about the response shape: backend documents only "returns personas". */
function readState(raw: unknown): DemoState {
  const o = (raw ?? {}) as Record<string, unknown>;
  const outing = (o.outing ?? {}) as Record<string, unknown>;
  const outingId = (o.outingId ?? o.id ?? outing.id ?? null) as string | null;
  const list = (o.personas ?? o.participants ?? []) as Array<Record<string, unknown>>;
  const personas = Array.isArray(list)
    ? list
        .map((p) => ({
          participantId: String(p.participantId ?? p.id ?? ""),
          displayName: String(p.displayName ?? p.name ?? "Guest"),
          role: p.role ? String(p.role) : undefined,
          description: p.description ? String(p.description) : p.label ? String(p.label) : undefined,
          payerType: p.payerType ? String(p.payerType) : undefined,
        }))
        .filter((p) => p.participantId)
    : [];
  return { outingId, personas };
}

const STORE = "outings.demo";

export function DemoHub() {
  const router = useRouter();
  const [state, setState] = useState<DemoState>({ outingId: null, personas: [] });
  const [disabled, setDisabled] = useState<string | null>(null);
  const { pending, error, run } = useAction();

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORE);
      if (saved) setState(JSON.parse(saved) as DemoState);
    } catch {
      /* storage can be unavailable */
    }
    // Optional listing endpoint; not part of the documented API yet, so failure is silent.
    request("/api/demo/personas")
      .then((r) => {
        const s = readState(r);
        if (s.personas.length) setState(s);
      })
      .catch(() => {});
  }, []);

  function remember(s: DemoState) {
    setState(s);
    try {
      sessionStorage.setItem(STORE, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  }

  async function reset() {
    setDisabled(null);
    await run("reset", async () => {
      try {
        const r = await request("/api/demo/reset", { method: "POST" });
        remember(readState(r));
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
          setDisabled("Demo fixtures are turned off on this deployment, so there is nothing to reset.");
          return;
        }
        throw e;
      }
    });
  }

  async function switchTo(p: Persona) {
    const ok = await run("persona:" + p.participantId, async () => {
      await request("/api/demo/persona", { method: "POST", json: { participantId: p.participantId } });
      return true;
    });
    if (ok && state.outingId) router.push(`/o/${state.outingId}`);
  }

  async function merchant() {
    const ok = await run("merchant", async () => {
      await request("/api/merchant/demo-login", { method: "POST" });
      return true;
    });
    if (ok) router.push("/merchant");
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Pill>Sandbox demo</Pill>
        <h1 className="text-[36px] leading-10 sm:text-h1 sm:leading-[3rem]">Try the demo</h1>
        <p className="text-lead">Reset to a fresh karaoke outing, then step into anyone&apos;s shoes to see each screen.</p>
      </div>

      <Card tone="blush" className="space-y-3">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-coral-700" aria-hidden />
          <div className="space-y-2">
            <h2 className="text-h3">What is real here?</h2>
            <p>
              No real money ever moves. When PayPal sandbox keys are configured, authorizations happen on PayPal&apos;s sandbox with test accounts.
              Without keys the app uses a simulator, and every screen says so.
            </p>
            <div className="flex flex-wrap gap-2">
              <ModeBadge kind="payment" mode="PAYPAL_SANDBOX" />
              <ModeBadge kind="payment" mode="FIXTURE" />
              <ModeBadge kind="ai" mode="FIXTURE" />
            </div>
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
        <p className="text-ink-muted">Wipes demo data and seeds a fresh outing with a small cast of friends.</p>
        <Button loading={pending === "reset"} loadingLabel="Resetting…" onClick={reset} variant="secondary">
          Reset demo data
        </Button>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center gap-3">
          <UserRound className="size-5 text-coral-700" aria-hidden />
          <h2 className="text-h3">2. Pick who you are</h2>
        </div>
        {state.personas.length === 0 ? (
          <p className="text-ink-muted">Reset the demo to load the cast.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {state.personas.map((p, i) => (
              <li key={p.participantId} className="flex items-center gap-3 rounded-chip border border-line p-3">
                <Avatar name={p.displayName} index={i} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{p.displayName}</p>
                  <p className="text-small text-ink-muted">
                    {[p.role === "ORGANIZER" ? "Organizer" : p.role === "INVITEE" ? "Guest" : p.role, p.description].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  className="!min-h-[44px] !px-4 !text-[15px]"
                  disabled={!state.outingId}
                  loading={pending === "persona:" + p.participantId}
                  loadingLabel="Opening…"
                  aria-label={`Open as ${p.displayName}`}
                  onClick={() => switchTo(p)}
                >
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

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
