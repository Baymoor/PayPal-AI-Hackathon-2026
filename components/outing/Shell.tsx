import { FlaskConical, Lock } from "lucide-react";
import type { OutingView } from "@/lib/contracts/views";
import { Stepper } from "@/components/ui/Stepper";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";

export function stepIndex(stage: OutingView["outing"]["stage"]): number {
  return { BRIEF: 0, BUDGET: 1, INVITE: 2, COMMIT: 3, RESULT: 4 }[stage];
}

type PaymentMode = OutingView["outing"]["paymentMode"];

/** The modes of THIS outing in one plain line, e.g. "Simulated payments and AI · no real money". */
export function modeLine(paymentMode: PaymentMode, aiSimulated: boolean, aiReal: boolean): string {
  const ai = aiSimulated ? "simulated AI" : aiReal ? "Claude" : null;
  if (paymentMode === "FIXTURE") return aiSimulated ? "Simulated payments and AI · no real money" : `Simulated payments${ai ? ` · ${ai}` : ""} · no real money`;
  if (paymentMode === "PAYPAL_SANDBOX") return `PayPal sandbox payments${ai ? ` · ${ai}` : ""} · no real money`;
  return `Payments off${ai ? ` · ${ai}` : ""}`;
}

/**
 * Always-visible honesty line: payment and AI modes of THIS outing. Deliberately quiet (one muted line, not
 * a pill): the dashed Fixture pill is kept for the places money is shown, the AI badge for AI-written blocks.
 */
export function ModeRow({ view }: { view: OutingView }) {
  const { paymentMode, aiMode } = view.outing;
  const aiSimulated = aiMode === "FIXTURE" || view.brief.source === "FIXTURE";
  const simulated = paymentMode !== "PAYPAL_SANDBOX" || aiSimulated;
  const Icon = simulated ? FlaskConical : Lock;
  return (
    <p className="flex items-center justify-center gap-1.5 text-[13px] leading-5 text-ink-muted">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {modeLine(paymentMode, aiSimulated, aiMode === "ANTHROPIC")}
    </p>
  );
}

export function PageFrame({
  children,
  wide,
  back,
}: {
  children: React.ReactNode;
  wide?: boolean;
  back?: { href: string; label: string };
}) {
  return (
    <>
      <SiteHeader back={back} />
      <main id="main" className={`mx-auto w-full flex-1 px-5 py-6 sm:px-6 sm:py-10 ${wide ? "max-w-[1180px]" : "max-w-[560px]"}`}>
        {children}
      </main>
      <SiteFooter />
    </>
  );
}

export function ScreenHeader({
  view,
  title,
  lead,
  center = true,
  titleNode,
}: {
  view: OutingView;
  title?: string;
  lead?: React.ReactNode;
  center?: boolean;
  titleNode?: React.ReactNode;
}) {
  return (
    <div className={`space-y-4 ${center ? "text-center" : ""}`}>
      <Stepper current={stepIndex(view.outing.stage)} />
      <ModeRow view={view} />
      <h1 className="text-[36px] leading-10 sm:text-h1 sm:leading-[3rem]">{titleNode ?? title}</h1>
      {lead && <div className="text-lead text-ink">{lead}</div>}
    </div>
  );
}
