"use client";
import type { OutingView } from "@/lib/contracts/views";
import type { OutingActions } from "./api";
import { BriefStage } from "./BriefStage";
import { BudgetStage } from "./BudgetStage";
import { CommitStage, type PaymentFlag } from "./CommitStage";
import { ProposalStage } from "./ProposalStage";
import { ResultStage } from "./ResultStage";
import { PageFrame } from "./Shell";

const RESULT_STATUSES = new Set(["SETTLING", "CONFIRMED", "CANCELLING", "COMPENSATING", "CANCELLED"]);

/** Pure presentation of one OutingView. Used by the live page and by /dev/preview. */
export function OutingScreen({
  view,
  actions,
  clockOffsetMs,
  paymentFlag,
  notice,
}: {
  view: OutingView;
  actions: OutingActions;
  clockOffsetMs: number;
  paymentFlag?: PaymentFlag;
  notice?: React.ReactNode;
}) {
  const stage = view.outing.stage;
  const isResult = stage === "RESULT" || RESULT_STATUSES.has(view.outing.status);
  const wide = !isResult && ((stage === "BUDGET" && view.budget.revealed) || (stage === "INVITE" && view.viewer.isOrganizer));

  let body: React.ReactNode;
  if (isResult) body = <ResultStage view={view} />;
  else if (stage === "BRIEF") body = <BriefStage view={view} actions={actions} />;
  else if (stage === "BUDGET") body = <BudgetStage view={view} actions={actions} />;
  else if (stage === "INVITE") body = <ProposalStage view={view} actions={actions} />;
  else body = <CommitStage view={view} actions={actions} clockOffsetMs={clockOffsetMs} paymentFlag={paymentFlag} />;

  return (
    <PageFrame wide={wide} back={{ href: "/", label: "Back to home" }}>
      {notice && <div className="mb-4">{notice}</div>}
      {body}
    </PageFrame>
  );
}
