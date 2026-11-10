"use client";
import { CircleCheck, Hourglass } from "lucide-react";
import type { OutingView } from "@/lib/contracts/views";
import { formatMoney } from "@/lib/domain/money";
import { StatusBadge, type StatusKind } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { MoneyRow, MoneyRows } from "@/components/ui/MoneyRow";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { LinkButton } from "@/components/ui/Button";
import { formatShortDate } from "./format";
import { ModeRow, stepIndex } from "./Shell";
import { fixtureHold } from "./CommitStage";
import { Stepper } from "@/components/ui/Stepper";

const REASONS: Record<string, string> = {
  REQUIRED_MISSING: "A required guest didn’t commit before the deadline.",
  REQUIRED_DECLINED: "A required guest declined or withdrew.",
  BELOW_MIN_PAYERS: "Too few people committed, so shares would have been above everyone’s maximum.",
  NO_PAYERS: "Nobody committed a payment.",
  CAP_EXCEEDED: "A share would have been above someone’s agreed maximum.",
  CAPACITY_EXCEEDED: "More people committed than the venue can host.",
  QUOTE_EXPIRED: "The merchant’s quote expired.",
  MERCHANT_UNAVAILABLE: "The merchant could no longer offer this slot.",
  UNVERIFIABLE: "We couldn’t verify every authorization, so we stopped to keep everyone safe.",
  ORGANIZER_CANCELLED: "The organizer cancelled the outing.",
  CAPTURE_FAILED: "A payment failed while collecting shares.",
};

function paymentBadge(view: OutingView): { kind: StatusKind; label?: string } | null {
  const p = view.me.payment;
  if (!p) return null;
  switch (p.status) {
    case "CAPTURED":
      return { kind: "captured" };
    case "CAPTURE_PENDING":
      return { kind: "authorized", label: "Collecting your share" };
    case "AUTHORIZED":
      return { kind: "authorized" };
    case "VOID_PENDING":
      return { kind: "void-pending" };
    case "VOIDED":
      return { kind: "released" };
    case "REFUND_PENDING":
      return { kind: "void-pending", label: "Refund pending" };
    case "REFUNDED":
      return { kind: "refunded", label: `Refunded ${formatMoney(p.refundedMinor)}` };
    case "FAILED":
    case "UNKNOWN":
      return { kind: "danger" };
    default:
      return null;
  }
}

export function ResultStage({ view }: { view: OutingView }) {
  const { outing, me, quote } = view;
  const status = outing.status;
  const pay = me.payment;
  const tz = outing.displayTimezone;
  const badge = paymentBadge(view);
  const fixture = fixtureHold(view);
  const reasons = outing.cancelReasons.map((r) => REASONS[r]).filter(Boolean);
  const recovery =
    status === "COMPENSATING" ||
    outing.cleanup === "REFUND_PENDING" ||
    outing.cancelReasons.includes("CAPTURE_FAILED") ||
    (pay?.refundedMinor ?? 0) > 0 ||
    pay?.status === "REFUND_PENDING" ||
    pay?.status === "REFUNDED";

  let heading: string;
  let banner: React.ReactNode;

  if (status === "CONFIRMED") {
    heading = "You’re going.";
    banner = (
      <StatusBanner tone="success" title="Booking confirmed">
        {view.viewer.payerType === "SPONSORED"
          ? "Your share was covered, so you pay $0."
          : pay?.status === "CAPTURED"
            ? "Your final share has been collected."
            : "The group booking is confirmed. We’re collecting final shares now."}
      </StatusBanner>
    );
  } else if (status === "SETTLING") {
    heading = "Deadline reached.";
    banner = (
      <StatusBanner tone="pending" title="Confirming the booking">
        The commitment window has closed. We&apos;re checking every authorization before anything is collected. This page updates on its own.
      </StatusBanner>
    );
  } else if (recovery) {
    // The headline already says "Booking not confirmed."; the banner starts at what happened.
    heading = "Booking not confirmed.";
    const done = outing.cleanup === "COMPLETE";
    banner = (
      <StatusBanner tone={done ? "info" : outing.cleanup === "NEEDS_ATTENTION" ? "danger" : "pending"} title={done ? "Refunded" : "Refund pending"}>
        {done
          ? fixture
            ? "A payment failed, so the completed simulated payments were refunded. No real money moved."
            : "A payment failed, so the completed payments were refunded. Your bank may take a few days to show it."
          : outing.cleanup === "NEEDS_ATTENTION"
            ? "A payment failed, and a refund needs manual attention. Contact the organizer or merchant."
            : "A payment failed; completed payments are being refunded."}
      </StatusBanner>
    );
  } else {
    // The reason goes in the banner (no separate one-bullet card), and the headline isn't repeated.
    heading = "Outing cancelled.";
    const c = outing.cleanup;
    const why = reasons.length > 0 ? `${reasons.join(" ")} ` : "";
    banner = (
      <StatusBanner tone={c === "NEEDS_ATTENTION" ? "danger" : c === "COMPLETE" || c === "NONE" ? "info" : "pending"} title={c === "COMPLETE" ? "Holds released" : c === "VOID_PENDING" || status === "CANCELLING" ? "Hold release pending" : "Cancelled"}>
        {why}
        {c === "COMPLETE"
          ? fixture
            ? "No booking payment was collected. Every simulated hold has been released. No real money."
            : "No booking payment was collected. PayPal confirmed every hold was released; your bank may take a few days to show it."
          : c === "NONE"
            ? "No booking payment was collected."
            : c === "NEEDS_ATTENTION"
              ? "No booking payment was collected. A hold release needs manual attention; contact the organizer."
              : "No booking payment was collected; we're releasing every hold."}
      </StatusBanner>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4 text-center">
        <Stepper
          current={stepIndex("RESULT")}
          doneLabel={status === "CONFIRMED" ? "Confirmed" : status === "SETTLING" ? "Settling" : recovery ? "Not confirmed" : "Cancelled"}
        />
        <ModeRow view={view} />
        <h1 className="text-[36px] leading-10 sm:text-h1 sm:leading-[3rem]">{heading}</h1>
        <p className="font-display text-[22px]">{outing.title}</p>
      </div>
      {banner}
      {(pay || quote) && (
        <Card className="space-y-4">
          <MoneyRows>
            {quote && <MoneyRow label="Fixed total" value={formatMoney(quote.totalMinor)} sub={`${quote.merchantName} · ${formatShortDate(quote.activityAt, tz)}`} />}
            {pay && <MoneyRow label="Your maximum" value={formatMoney(pay.authorizedMinor)} />}
            {status === "CONFIRMED" && me.finalShareMinor !== null && (
              <MoneyRow
                label="Your final share"
                value={formatMoney(me.finalShareMinor)}
                sub="Never above your maximum"
                emphasis
              />
            )}
            {pay && (status === "CONFIRMED" || pay.capturedMinor > 0) && (
              <MoneyRow label="Captured" value={formatMoney(pay.capturedMinor)} />
            )}
            {pay && pay.refundedMinor > 0 && <MoneyRow label="Refunded" value={formatMoney(pay.refundedMinor)} />}
            {badge && (
              <MoneyRow
                label="Payment status"
                value={<StatusBadge kind={badge.kind} label={badge.label} />}
                sub={pay ? fixture ? <StatusBadge kind="fixture" className="mt-1" /> : pay.providerLabel : undefined}
              />
            )}
          </MoneyRows>
          {status === "CONFIRMED" && pay?.status === "CAPTURED" && (
            <p className="flex items-start gap-2 text-small text-ink-muted">
              <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              {fixture
                ? pay.capturedMinor < pay.authorizedMinor
                  ? `Simulated payment. ${formatMoney(pay.capturedMinor)} captured, the remaining ${formatMoney(pay.authorizedMinor - pay.capturedMinor)} of the hold released.`
                  : `Simulated payment. ${formatMoney(pay.capturedMinor)} captured from your hold.`
                : "Any unused part of your hold is released by PayPal. It can take a few days to disappear from your account."}
            </p>
          )}
          {(status === "CANCELLED" || status === "CANCELLING") && pay && (pay.status === "VOID_PENDING" || pay.status === "AUTHORIZED") && (
            <p className="flex items-start gap-2 text-small text-ink-muted">
              <Hourglass className="mt-0.5 size-4 shrink-0" aria-hidden />
              {fixture
                ? "Simulated hold, being released. No real money."
                : "PayPal is releasing your hold; it can take a few days to show. You have not been charged."}
            </p>
          )}
        </Card>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <LinkButton href="/new" variant="secondary">
          Plan another outing
        </LinkButton>
      </div>
    </div>
  );
}
