import { Check, Clock, FlaskConical, Lock, TriangleAlert, Undo2, X, Bot, Sparkles } from "lucide-react";
import { cn } from "./cn";

export type StatusKind =
  | "authorized"
  | "captured"
  | "void-pending"
  | "refunded"
  | "cancelled"
  | "released"
  | "fixture"
  | "danger";

const STATUS: Record<StatusKind, { cls: string; label: string; Icon: typeof Lock }> = {
  authorized: { cls: "bg-authorized-bg text-authorized", label: "Authorized", Icon: Lock },
  captured: { cls: "bg-captured-bg text-captured", label: "Captured", Icon: Check },
  "void-pending": { cls: "bg-void-pending-bg text-void-pending", label: "Hold release pending", Icon: Clock },
  refunded: { cls: "bg-refunded-bg text-refunded", label: "Refunded", Icon: Undo2 },
  cancelled: { cls: "bg-cancelled-bg text-cancelled", label: "Cancelled", Icon: X },
  released: { cls: "bg-cancelled-bg text-cancelled", label: "Hold released", Icon: Check },
  fixture: { cls: "bg-fixture-bg text-fixture border border-dashed border-fixture", label: "Fixture — not real PayPal", Icon: FlaskConical },
  danger: { cls: "bg-danger-bg text-danger", label: "Needs attention", Icon: TriangleAlert },
};

const pill = "inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-[13px] font-bold leading-5 whitespace-nowrap";

/** Status = icon + text, never colour alone. */
export function StatusBadge({ kind, label, className }: { kind: StatusKind; label?: string; className?: string }) {
  const { cls, label: dflt, Icon } = STATUS[kind];
  return (
    <span className={cn(pill, cls, className)}>
      <Icon className="size-3.5" aria-hidden />
      {label ?? dflt}
    </span>
  );
}

export function Pill({
  children,
  tone = "blush",
  className,
}: {
  children: React.ReactNode;
  tone?: "blush" | "neutral" | "ink";
  className?: string;
}) {
  const tones = {
    blush: "bg-blush text-coral-800",
    neutral: "bg-cancelled-bg text-cancelled",
    ink: "bg-ink text-cream",
  };
  return <span className={cn(pill, tones[tone], className)}>{children}</span>;
}

/** Site-wide demo marker. Mode-neutral on purpose: the page's ModeBadge says whether payments are PayPal sandbox or FIXTURE. */
export function SandboxBadge({ className }: { className?: string }) {
  return <Pill className={className}>Demo · no real money</Pill>;
}

/** Fixture / sandbox labels derived from outing modes. Always shown, never hidden. */
export function ModeBadge({
  kind,
  mode,
}: {
  kind: "payment" | "ai";
  mode: "PAYPAL_SANDBOX" | "FIXTURE" | "DISABLED" | "ANTHROPIC";
}) {
  if (kind === "payment") {
    if (mode === "FIXTURE") return <StatusBadge kind="fixture" />;
    if (mode === "PAYPAL_SANDBOX")
      return (
        <Pill tone="neutral">
          <Lock className="size-3.5" aria-hidden />
          PayPal sandbox
        </Pill>
      );
    return (
      <Pill tone="neutral">
        <X className="size-3.5" aria-hidden />
        Payments off
      </Pill>
    );
  }
  if (mode === "FIXTURE")
    return (
      <span className={cn(pill, STATUS.fixture.cls)}>
        <FlaskConical className="size-3.5" aria-hidden />
        Fixture AI (no model call)
      </span>
    );
  if (mode === "ANTHROPIC")
    return (
      <Pill tone="neutral">
        <Sparkles className="size-3.5" aria-hidden />
        AI-generated
      </Pill>
    );
  return (
    <Pill tone="neutral">
      <Bot className="size-3.5" aria-hidden />
      AI off
    </Pill>
  );
}

/** Provenance for one AI-written block. */
export function AiSourceBadge({ source }: { source: "ANTHROPIC" | "FIXTURE" | null }) {
  if (!source) return null;
  return <ModeBadge kind="ai" mode={source} />;
}
