import type { OutingView } from "@/lib/contracts/views";
import { ModeBadge } from "@/components/ui/Badge";
import { Stepper } from "@/components/ui/Stepper";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";

export function stepIndex(stage: OutingView["outing"]["stage"]): number {
  return { BRIEF: 0, BUDGET: 1, INVITE: 2, COMMIT: 3, RESULT: 4 }[stage];
}

/** Always-visible honesty row: payment and AI modes of THIS outing. */
export function ModeRow({ view }: { view: OutingView }) {
  const { paymentMode, aiMode } = view.outing;
  return (
    <div className="flex flex-wrap items-center justify-center gap-2" aria-label="Demo modes">
      <ModeBadge kind="payment" mode={paymentMode} />
      {(aiMode === "FIXTURE" || view.brief.source === "FIXTURE") && <ModeBadge kind="ai" mode="FIXTURE" />}
    </div>
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
      <Stepper current={stepIndex(view.outing.stage)} context={view.outing.title.toUpperCase()} />
      <ModeRow view={view} />
      <h1 className="text-[36px] leading-10 sm:text-h1 sm:leading-[3rem]">{titleNode ?? title}</h1>
      {lead && <div className="text-lead text-ink">{lead}</div>}
    </div>
  );
}
