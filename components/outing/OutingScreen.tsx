"use client";
import { Fragment } from "react";
import type { OutingView } from "@/lib/contracts/views";
import type { OutingActions } from "./api";
import { BriefStage } from "./BriefStage";
import { BudgetStage } from "./BudgetStage";
import { CommitStage, type PaymentFlag } from "./CommitStage";
import { JudgeBar } from "./JudgeBar";
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
  paymentReason,
  notice,
}: {
  view: OutingView;
  actions: OutingActions;
  clockOffsetMs: number;
  paymentFlag?: PaymentFlag;
  /** Lower-cased error code from a failed payment redirect; explained only if it's a known code. */
  paymentReason?: string;
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
  else
    body = (
      <CommitStage view={view} actions={actions} clockOffsetMs={clockOffsetMs} paymentFlag={paymentFlag} paymentReason={paymentReason} />
    );

  return (
    <PageFrame wide={wide} back={{ href: "/", label: "Back to home" }}>
      {view.outing.demoMode && (
        <div className="mb-4">
          <JudgeBar view={view} onSwitched={actions.refresh} />
        </div>
      )}
      {notice && <div className="mb-4">{notice}</div>}
      {/* Keyed by viewer: a persona switch must not carry one person's local form state (e.g. a picked vote tile) to the next. */}
      <Fragment key={view.viewer.participantId}>{body}</Fragment>
    </PageFrame>
  );
}
