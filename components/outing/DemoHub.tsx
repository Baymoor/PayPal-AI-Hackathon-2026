"use client";
import { Cog, FlaskConical, LayoutDashboard, Play, RotateCcw, ShieldCheck, Store, Timer, UserRound, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CleanupState, OperationKind, OperationStatus, OutingStatus } from "@/lib/domain/types";
import {
  DEMO_SCENARIO_DEADLINE_SECONDS,
  DEMO_SCENARIO_KINDS,
  clampScenarioSeconds,
  isDemoScenarioKind,
  type DemoScenarioKind,
} from "@/lib/demo/constants";
import { Avatar } from "@/components/ui/Avatar";
import { ModeBadge, Pill, StatusBadge, type StatusKind } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { formatRemaining, useRemainingMs } from "@/components/ui/Countdown";
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
  cancelReasons?: string[];
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

/** POST /api/demo/scenario and GET/POST status shapes (lib/demo/scenarios.ts). */
interface ScenarioPersona {
  participantId: string;
  displayName: string;
  role: "ORGANIZER" | "INVITEE";
  payerType: "PAYER" | "SPONSORED";
  note: string;
}
interface ScenarioCreated {
  outingId: string;
  kind: DemoScenarioKind;
  title: string;
  deadlineAt: string;
  serverNow: string;
  personas: ScenarioPersona[];
  tickAvailable: boolean;
}
type OperationCounts = Record<OperationKind, Partial<Record<OperationStatus, number>>>;
interface ScenarioStatus {
  outingId: string;
  status: OutingStatus;
  cleanup: CleanupState;
  cancelReasons: string[];
  deadlineAt: string | null;
  serverNow: string;
  operations: OperationCounts;
  headline: string;
  tickAvailable?: boolean;
}
interface TickResponse {
  ok: boolean;
  jobsRun: number;
  operationsRun: number;
  sweptOutings: number;
  errors: string[];
  serverNow: string;
  outing: ScenarioStatus | null;
}
/** The scenario this browser started (kept in localStorage so it survives "Open as …" round trips). */
interface ActiveScenario {
  outingId: string;
  kind: DemoScenarioKind;
  title: string;
  deadlineAt: string;
  personas: ScenarioPersona[];
}

const EMPTY: DemoState = { outingId: null, budgetOutingId: null, outings: [] };
const SCENARIO_STORAGE_KEY = "outings.demo.scenario.v1";
const SCENARIO_POLL_MS = 5_000;
const DEADLINE_CHOICES = [60, 90, 120, 300];

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
      return "Cancelling";
    case "COMPENSATING":
      return "Not confirmed · recovering";
    case "CANCELLED":
      if (o.cancelReasons?.includes("CAPTURE_FAILED")) {
        return o.cleanup === "COMPLETE" ? "Not confirmed · refunded" : o.cleanup === "NEEDS_ATTENTION" ? "Not confirmed · needs attention" : "Not confirmed · refund pending";
      }
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

/* ------------------------------- Scenarios --------------------------------- */

const SCENARIOS: Record<DemoScenarioKind, { title: string; what: string; fixture: string; next: string }> = {
  "settle-soon": {
    title: "The last payer commits in time",
    what: "Four of five payers already hold $20. Open as Noor and authorize before the deadline. At the deadline the server captures 5 × $20 and the booking is confirmed; Maya pays $0.",
    fixture: "Fixture holds and captures from the payment simulator, not real PayPal.",
    next: "Open as Noor and authorize $20 before the deadline. When it has passed, process due work.",
  },
  holdout: {
    title: "A required guest holds out",
    what: "Four of five payers hold $20, but Noor never commits. At the deadline the server cancels the booking and releases every hold. Nobody is charged.",
    fixture: "Fixture holds from the payment simulator, not real PayPal.",
    next: "Leave Noor alone. When the deadline has passed, process due work.",
  },
  "capture-failure": {
    title: "A capture fails mid-settlement",
    what: "All five payers hold $20. The simulator declines Jules's capture, so the server stops, releases the remaining holds and refunds the shares it already captured. The booking is never confirmed.",
    fixture: "Injected fixture failures: one declined capture, and one refund whose response is lost and reconciled on the next pass. No real money.",
    next: "When the deadline has passed, process due work. Process again a few seconds later: the lost refund response is reconciled and the clean-up completes.",
  },
};

function describeSeconds(s: number): string {
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

function readSavedScenario(): ActiveScenario | null {
  try {
    const raw = window.localStorage.getItem(SCENARIO_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<ActiveScenario>;
    if (typeof s.outingId !== "string" || !isDemoScenarioKind(s.kind) || typeof s.title !== "string" || typeof s.deadlineAt !== "string" || !Array.isArray(s.personas)) {
      return null;
    }
    return { outingId: s.outingId, kind: s.kind, title: s.title, deadlineAt: s.deadlineAt, personas: s.personas };
  } catch {
    return null;
  }
}

function saveScenario(s: ActiveScenario | null): void {
  try {
    if (s) window.localStorage.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(s));
    else window.localStorage.removeItem(SCENARIO_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: the panel just won't survive navigation.
  }
}

/** Nothing more will happen to this outing on its own. */
function isSettled(s: ScenarioStatus | null): boolean {
  if (!s) return false;
  if (s.status === "CONFIRMED") return true;
  return s.status === "CANCELLED" && (s.cleanup === "COMPLETE" || s.cleanup === "NONE" || s.cleanup === "NEEDS_ATTENTION");
}

function scenarioBadge(s: ScenarioStatus): { kind: StatusKind | null; label: string } {
  switch (s.status) {
    case "COLLECTING":
      return { kind: null, label: "Collecting commitments" };
    case "SETTLING":
      return { kind: "authorized", label: "Settling" };
    case "CONFIRMED":
      return { kind: "captured", label: "Confirmed" };
    case "COMPENSATING":
      return { kind: "void-pending", label: "Not confirmed · recovering" };
    case "CANCELLING":
    case "CANCELLED": {
      const failed = s.cancelReasons.includes("CAPTURE_FAILED");
      if (s.cleanup === "NEEDS_ATTENTION") return { kind: "danger", label: failed ? "Not confirmed · needs attention" : "Cancelled · needs attention" };
      if (failed) return s.cleanup === "COMPLETE" ? { kind: "refunded", label: "Not confirmed · refunded" } : { kind: "void-pending", label: "Not confirmed · refund pending" };
      return s.cleanup === "COMPLETE" || s.cleanup === "NONE"
        ? { kind: "released", label: "Cancelled · holds released" }
        : { kind: "void-pending", label: "Cancelled · hold release pending" };
    }
    default:
      return { kind: null, label: s.status };
  }
}

const OP_WORDS: Record<OperationKind, { label: string; words: Partial<Record<OperationStatus, string>> }> = {
  CAPTURE: { label: "Captures", words: { SUCCEEDED: "captured", FAILED: "failed", SKIPPED: "skipped", PENDING: "queued", IN_FLIGHT: "in flight", UNKNOWN: "being reconciled" } },
  REFUND: { label: "Refunds", words: { SUCCEEDED: "refunded", UNKNOWN: "awaiting reconciliation", PENDING: "queued", IN_FLIGHT: "in flight", FAILED: "failed" } },
  VOID: { label: "Holds released", words: { SUCCEEDED: "released", PENDING: "queued", IN_FLIGHT: "in flight", UNKNOWN: "being reconciled", FAILED: "failed", SKIPPED: "not needed" } },
};
const OP_ORDER: OperationStatus[] = ["SUCCEEDED", "FAILED", "SKIPPED", "UNKNOWN", "IN_FLIGHT", "PENDING"];

function operationLines(ops: OperationCounts): { label: string; text: string }[] {
  return (["CAPTURE", "VOID", "REFUND"] as const).flatMap((kind) => {
    const counts = ops[kind] ?? {};
    const parts = OP_ORDER.filter((st) => (counts[st] ?? 0) > 0).map((st) => `${counts[st]} ${OP_WORDS[kind].words[st] ?? st.toLowerCase()}`);
    return parts.length ? [{ label: OP_WORDS[kind].label, text: parts.join(" · ") }] : [];
  });
}

function tickSummary(r: TickResponse): string {
  const did = r.jobsRun + r.operationsRun + r.sweptOutings;
  const work =
    did === 0
      ? "Worker pass done: nothing was due yet."
      : `Worker pass done: ${r.jobsRun} job${r.jobsRun === 1 ? "" : "s"} and ${r.operationsRun} payment operation${r.operationsRun === 1 ? "" : "s"} processed.`;
  return r.errors.length ? `${work} ${r.errors.length} item${r.errors.length === 1 ? "" : "s"} will be retried.` : work;
}

/** "Closes in 1m 05s" against the SERVER clock (offset = serverNow - clientNow when we last heard from it). */
function ScenarioCountdown({ deadlineAt, offsetMs, id }: { deadlineAt: string; offsetMs: number; id: string }) {
  const remaining = useRemainingMs(deadlineAt, offsetMs);
  const passed = remaining !== null && remaining <= 0;
  return (
    <p id={id} role="timer" aria-live="off" className="inline-flex items-center gap-1.5 font-semibold tabular-nums">
      <Timer className="size-4" aria-hidden />
      {remaining === null ? "…" : passed ? "Deadline passed" : `Closes in ${formatRemaining(remaining)}`}
    </p>
  );
}

export function DemoHub({ initialDeadlineSeconds }: { initialDeadlineSeconds?: number } = {}) {
  const router = useRouter();
  const [state, setState] = useState<DemoState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [modes, setModes] = useState<Modes | null>(null);
  const [disabled, setDisabled] = useState<string | null>(null);
  const { pending, error, run } = useAction();

  const [seconds, setSeconds] = useState(() => clampScenarioSeconds(initialDeadlineSeconds ?? DEMO_SCENARIO_DEADLINE_SECONDS.default));
  const [scenario, setScenario] = useState<ActiveScenario | null>(null);
  const [scenarioStatus, setScenarioStatus] = useState<ScenarioStatus | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [tickResult, setTickResult] = useState<TickResponse | null>(null);
  const [tickBlocked, setTickBlocked] = useState<string | null>(null);
  const scenarioHeading = useRef<HTMLHeadingElement>(null);
  const focusScenario = useRef(false);
  const deadlineSelectId = useId();
  const countdownId = useId();
  const choices = [...new Set([...DEADLINE_CHOICES, seconds])].sort((a, b) => a - b);

  const adoptServerClock = useCallback((serverNowIso: string) => {
    const serverNow = Date.parse(serverNowIso);
    if (Number.isFinite(serverNow)) setOffsetMs(serverNow - Date.now());
  }, []);

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
    // Bring back the scenario this browser started, if its outing still exists (a reset deletes it).
    const saved = readSavedScenario();
    if (saved) {
      request<ScenarioStatus>(`/api/demo/scenario?outingId=${encodeURIComponent(saved.outingId)}`)
        .then((s) => {
          if (!alive) return;
          setScenario(saved);
          setScenarioStatus(s);
          adoptServerClock(s.serverNow);
          if (s.tickAvailable === false) setTickBlocked("On this deployment the background worker processes due work on its own.");
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) saveScenario(null);
        });
    }
    return () => {
      alive = false;
    };
  }, [adoptServerClock]);

  const scenarioId = scenario?.outingId ?? null;
  const settled = isSettled(scenarioStatus);

  // Keep the scenario's status fresh (the background worker may settle it without this page).
  useEffect(() => {
    if (!scenarioId || settled) return;
    let alive = true;
    const t = setInterval(() => {
      request<ScenarioStatus>(`/api/demo/scenario?outingId=${encodeURIComponent(scenarioId)}`)
        .then((s) => {
          if (!alive) return;
          setScenarioStatus(s);
          adoptServerClock(s.serverNow);
        })
        .catch(() => {});
    }, SCENARIO_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [scenarioId, settled, adoptServerClock]);

  // Move focus to the new scenario panel once it renders (keyboard and screen reader users land on it).
  useEffect(() => {
    if (scenarioId && focusScenario.current) {
      focusScenario.current = false;
      scenarioHeading.current?.focus();
    }
  }, [scenarioId]);

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

  async function switchTo(outingId: string, participantId: string) {
    const ok = await run("persona:" + participantId, async () => {
      await request("/api/demo/persona", { method: "POST", json: { participantId } });
      return true;
    });
    if (ok) router.push(`/o/${outingId}`);
  }

  async function merchant(path = "/merchant", key = "merchant") {
    const ok = await run(key, async () => {
      await request("/api/merchant/demo-login", { method: "POST" });
      return true;
    });
    if (ok) router.push(path);
  }

  async function startScenario(kind: DemoScenarioKind) {
    await run("scenario:" + kind, async () => {
      const r = await request<ScenarioCreated>("/api/demo/scenario", { method: "POST", json: { kind, deadlineSeconds: seconds } });
      const next: ActiveScenario = { outingId: r.outingId, kind: r.kind, title: r.title, deadlineAt: r.deadlineAt, personas: r.personas };
      adoptServerClock(r.serverNow);
      saveScenario(next);
      focusScenario.current = true;
      setScenario(next);
      setScenarioStatus({
        outingId: r.outingId,
        status: "COLLECTING",
        cleanup: "NONE",
        cancelReasons: [],
        deadlineAt: r.deadlineAt,
        serverNow: r.serverNow,
        operations: { CAPTURE: {}, VOID: {}, REFUND: {} },
        headline: "Collecting: nothing is settled before the deadline.",
      });
      setTickResult(null);
      setTickBlocked(r.tickAvailable ? null : "On this deployment the background worker processes due work on its own.");
      void request<ScenarioStatus>(`/api/demo/scenario?outingId=${encodeURIComponent(r.outingId)}`)
        .then(setScenarioStatus)
        .catch(() => {});
    });
  }

  async function processDueWork() {
    if (!scenario) return;
    await run("tick", async () => {
      try {
        const r = await request<TickResponse>("/api/demo/tick", { method: "POST", json: { outingId: scenario.outingId } });
        adoptServerClock(r.serverNow);
        setTickResult(r);
        if (r.outing) setScenarioStatus(r.outing);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) {
          setTickBlocked(e.message);
          return;
        }
        throw e;
      }
    });
  }

  function clearScenario() {
    saveScenario(null);
    setScenario(null);
    setScenarioStatus(null);
    setTickResult(null);
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
            onClick={() => switchTo(o.outingId, p.participantId)}
          >
            Open
          </Button>
        </li>
      ))}
    </ul>
  );

  const badge = scenarioStatus ? scenarioBadge(scenarioStatus) : null;
  const lines = scenarioStatus ? operationLines(scenarioStatus.operations) : [];

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

      <Card as="section" aria-labelledby="scenarios-h" className="space-y-4">
        <div className="flex items-center gap-3">
          <Timer className="size-5 text-coral-700" aria-hidden />
          <h2 id="scenarios-h" className="text-h3">
            Watch a deadline settle
          </h2>
        </div>
        <p className="text-ink-muted">
          Each scenario creates a fresh demo outing at The Sound Room ($100 private karaoke room, Maya&apos;s share covered) whose commitment deadline is minutes
          away, so you can watch the server settle it instead of waiting hours.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge kind="fixture" />
          <span className="text-small text-ink-muted">Scenario payments always use the simulator, even when PayPal sandbox keys are set.</span>
        </div>
        <div>
          <label htmlFor={deadlineSelectId} className="mb-1.5 block text-small font-semibold">
            Deadline after you start
          </label>
          <select
            id={deadlineSelectId}
            value={seconds}
            disabled={pending !== null}
            onChange={(e) => setSeconds(clampScenarioSeconds(e.target.value))}
            className="min-h-[48px] w-full rounded-chip border border-line-strong bg-white px-3 sm:w-auto"
          >
            {choices.map((s) => (
              <option key={s} value={s}>
                {describeSeconds(s)}
              </option>
            ))}
          </select>
        </div>
        <ul className="space-y-3">
          {DEMO_SCENARIO_KINDS.map((kind) => {
            const c = SCENARIOS[kind];
            return (
              <li key={kind} className="space-y-2 rounded-chip border border-line p-4">
                <h3 id={`scn-${kind}-title`} className="font-display text-[20px] font-semibold leading-7">
                  {c.title}
                </h3>
                <p>{c.what}</p>
                <p className="flex items-start gap-2 text-small text-ink-muted">
                  <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {c.fixture}
                </p>
                <Button
                  id={`scn-${kind}-start`}
                  aria-labelledby={`scn-${kind}-start scn-${kind}-title`}
                  variant="secondary"
                  className="!min-h-[44px] !px-4 !text-[15px]"
                  loading={pending === "scenario:" + kind}
                  loadingLabel="Creating…"
                  disabled={pending !== null && pending !== "scenario:" + kind}
                  onClick={() => startScenario(kind)}
                >
                  <Play className="size-4" aria-hidden />
                  Start (closes in {describeSeconds(seconds)})
                </Button>
              </li>
            );
          })}
        </ul>

        {scenario && (
          <section aria-labelledby="scenario-active-h" className="space-y-4 rounded-card border-2 border-coral-600 bg-blush-50 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <p className="text-caption font-semibold uppercase tracking-[0.14em] text-ink-muted">Active scenario</p>
                <h3 id="scenario-active-h" ref={scenarioHeading} tabIndex={-1} className="font-display text-[20px] font-semibold leading-7">
                  {scenario.title}
                </h3>
              </div>
              <Button variant="link" className="!min-h-[44px] text-small" onClick={clearScenario} aria-label="Dismiss this scenario panel">
                <X className="size-4" aria-hidden />
                Dismiss
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <ScenarioCountdown deadlineAt={scenario.deadlineAt} offsetMs={offsetMs} id={countdownId} />
              {badge && (badge.kind ? <StatusBadge kind={badge.kind} label={badge.label} /> : <Pill tone="neutral">{badge.label}</Pill>)}
            </div>

            <div aria-live="polite" className="space-y-2">
              {scenarioStatus && <p>{scenarioStatus.headline}</p>}
              {lines.length > 0 && (
                <dl className="grid gap-1 text-small sm:grid-cols-[max-content_1fr] sm:gap-x-4">
                  {lines.map((l) => (
                    <div key={l.label} className="contents">
                      <dt className="font-semibold">{l.label}</dt>
                      <dd className="text-ink-muted">{l.text}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>

            <p className="text-small">
              <span className="font-semibold">Next: </span>
              {SCENARIOS[scenario.kind].next}
            </p>

            <ul className="space-y-2" aria-label="People in this scenario">
              {scenario.personas.map((p, i) => (
                <li key={p.participantId} className="flex flex-col gap-3 rounded-chip border border-line bg-surface p-3">
                  <div className="flex items-start gap-3">
                    <Avatar name={p.displayName} index={i} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{p.displayName}</p>
                      <p className="text-small text-ink-muted">{p.note}</p>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    className="!min-h-[44px] !px-4 !text-[15px] self-start sm:ml-[52px]"
                    loading={pending === "persona:" + p.participantId}
                    loadingLabel="Opening…"
                    onClick={() => switchTo(scenario.outingId, p.participantId)}
                  >
                    Open as {p.displayName}
                  </Button>
                </li>
              ))}
            </ul>

            <div className="space-y-2 rounded-chip border border-line bg-surface p-4">
              <div className="flex items-center gap-2">
                <Cog className="size-4 text-coral-700" aria-hidden />
                <h4 className="font-semibold">Run the worker now</h4>
              </div>
              <p className="text-small text-ink-muted">
                Runs one pass of the settlement worker, exactly like the scheduler does. It only processes work that is already due: the server never settles before
                the deadline, whoever presses this.
              </p>
              {tickBlocked ? (
                <StatusBanner tone="info">{tickBlocked} Settlement happens within seconds of the deadline; this page updates on its own.</StatusBanner>
              ) : (
                <Button
                  variant="primary"
                  className="!min-h-[48px] !text-[16px]"
                  loading={pending === "tick"}
                  loadingLabel="Processing…"
                  disabled={pending !== null && pending !== "tick"}
                  aria-describedby={countdownId}
                  onClick={processDueWork}
                >
                  Process due work now
                </Button>
              )}
              <div aria-live="polite">{tickResult && <p className="text-small font-semibold">{tickSummary(tickResult)}</p>}</div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                variant="secondary"
                className="!min-h-[44px] w-full !px-4 !text-[15px] sm:w-auto"
                loading={pending === "merchant:scenario"}
                loadingLabel="Opening…"
                onClick={() => merchant(`/merchant/outings/${scenario.outingId}`, "merchant:scenario")}
              >
                <Store className="size-4" aria-hidden />
                Open merchant drill-down
              </Button>
            </div>
            {settled && (
              <p className="text-small text-ink-muted">This outing is settled. Start another scenario above to run it again; earlier runs stay listed below.</p>
            )}
          </section>
        )}
      </Card>

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
          <p className="text-ink-muted">
            Synthetic history: confirmed bookings, cancellations with released holds, and a failed capture being refunded. Scenario runs you started appear here too.
          </p>
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
                      onClick={() => switchTo(o.outingId, p.participantId)}
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
        <Button variant="secondary" loading={pending === "merchant"} loadingLabel="Opening…" onClick={() => merchant()}>
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
