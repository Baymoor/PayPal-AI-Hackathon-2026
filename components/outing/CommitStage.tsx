"use client";
import { CalendarDays, Check, Clock, MapPin, UserX, Users } from "lucide-react";
import { useState } from "react";
import { describePaymentFailureReason } from "@/components/errors/friendlyError";
import type { OutingView } from "@/lib/contracts/views";
import { formatMoney } from "@/lib/domain/money";
import { Avatar } from "@/components/ui/Avatar";
import { ModeBadge, Pill, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Countdown } from "@/components/ui/Countdown";
import { InvitationHero } from "@/components/ui/Illustrations";
import { MoneyRow, MoneyRows } from "@/components/ui/MoneyRow";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { Underlined } from "@/components/ui/Swoosh";
import type { OutingActions } from "./api";
import { formatDeadline, formatWhen, formatWhenFull } from "./format";
import { InvitePanel } from "./InvitePanel";
import { ModeRow, ScreenHeader } from "./Shell";
import { ActionErrorBanner, useAction } from "./useAction";

/** Is the viewer's hold (or, before paying, this outing's payments) a FIXTURE simulation rather than PayPal? */
export function fixtureHold(view: OutingView): boolean {
  return view.me.payment ? view.me.payment.provider === "FIXTURE" : view.outing.paymentMode !== "PAYPAL_SANDBOX";
}

export type PaymentFlag = "authorized" | "late" | "pending" | "failed" | "cancelled" | string | undefined;

/** `reason` is the lower-cased error code a failed payment redirect carries (`?payment=failed&reason=…`). */
function PaymentFlagBanner({ flag, reason, view }: { flag: PaymentFlag; reason?: string; view: OutingView }) {
  const cap = view.estimates.capMinor ?? view.quote?.capMinor ?? null;
  if (!flag) return null;
  // The ?payment= flag is a one-off redirect hint and stays in the URL; only show it while it still matches
  // the server's view (e.g. never "Authorization received" after the payer withdrew).
  const status = view.me.payment?.status;
  const active = view.viewer.attendance !== "WITHDRAWN" && view.viewer.attendance !== "DECLINED";
  if (flag === "authorized" && !(active && (status === "AUTHORIZED" || status === "CAPTURE_PENDING"))) return null;
  if (flag === "pending" && !(active && (status === "APPROVAL_PENDING" || status === "UNKNOWN" || status === "CREATED"))) return null;
  if ((flag === "failed" || flag === "cancelled" || flag === "canceled") && status === "AUTHORIZED") return null;
  if (flag === "authorized")
    return (
      <StatusBanner tone="success" title="Authorization received">
        {cap !== null ? `Your ${formatMoney(cap)} hold is in place. ` : ""}Nothing has been charged yet.
      </StatusBanner>
    );
  if (flag === "late")
    return (
      <StatusBanner tone="danger" title="That arrived after the deadline">
        Late authorizations are not accepted. Any hold will be released — you have not been charged.
      </StatusBanner>
    );
  if (flag === "pending")
    return (
      <StatusBanner tone="pending" title={fixtureHold(view) ? "Still confirming the simulated approval" : "Still confirming with PayPal"}>
        We haven&apos;t verified your authorization yet. This page updates on its own — you don&apos;t need to pay again.
      </StatusBanner>
    );
  if (flag === "failed") {
    const why = describePaymentFailureReason(reason);
    return (
      <StatusBanner tone="danger" title="Authorization didn’t go through">
        {why && (
          <p>
            {why.title}. {why.explanation}
          </p>
        )}
        <p className={why ? "mt-1" : undefined}>
          {why?.nextStep ?? "You can review and try again while commitments are open."}
        </p>
        <p className="mt-1 font-semibold">You have not been charged.</p>
      </StatusBanner>
    );
  }
  if (flag === "cancelled" || flag === "canceled")
    return (
      <StatusBanner tone="info" title="You left before authorizing">
        You have not been charged. Nothing happens until you authorize.
      </StatusBanner>
    );
  return null;
}

function RosterList({ view }: { view: OutingView }) {
  return (
    <Card as="section" aria-labelledby="who-h" className="space-y-3">
      <h2 id="who-h" className="text-h3">
        Who&apos;s in
      </h2>
      <ul className="divide-y divide-line">
        {view.roster.people.map((p, i) => {
          const declined = p.attendance === "DECLINED" || p.attendance === "WITHDRAWN";
          return (
            <li key={p.participantId} className="flex items-center gap-3 py-2.5">
              <Avatar name={p.displayName} index={i} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {p.displayName}
                  {p.participantId === view.viewer.participantId && <span className="font-normal text-ink-muted"> (you)</span>}
                </p>
                <p className="text-small text-ink-muted">
                  {p.payerType === "SPONSORED" ? "Guest · covered" : p.role === "ORGANIZER" ? "Organizer" : "Guest"} ·{" "}
                  {p.required ? "required" : "optional"}
                </p>
              </div>
              {declined ? (
                <span className="inline-flex items-center gap-1 text-small font-semibold text-cancelled">
                  <UserX className="size-4" aria-hidden /> {p.attendance === "WITHDRAWN" ? "Withdrew" : "Declined"}
                </span>
              ) : p.committed ? (
                <span className="inline-flex items-center gap-1 text-small font-semibold text-captured">
                  <Check className="size-4" aria-hidden /> {p.payerType === "SPONSORED" ? "Accepted" : "Committed"}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-small font-semibold text-ink-muted">
                  <Clock className="size-4" aria-hidden /> Not yet
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function TermsReview({ view, actions, onClose }: { view: OutingView; actions: OutingActions; onClose: () => void }) {
  const q = view.quote!;
  const tz = view.outing.displayTimezone;
  const cap = view.estimates.capMinor ?? q.capMinor;
  const [checked, setChecked] = useState(false);
  const { pending, error, run } = useAction();
  const hasConsent = !!view.me.consent?.current;
  const fixture = view.outing.paymentMode === "FIXTURE";
  const busy = pending === "authorize";

  return (
    <Card as="section" aria-labelledby="terms-h" className="space-y-5 pop-in">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="terms-h" className="text-h3">
          Review your terms
        </h2>
        <ModeBadge kind="payment" mode={view.outing.paymentMode} />
      </div>
      <MoneyRows>
        <MoneyRow label="Fixed total" value={formatMoney(q.totalMinor)} sub={q.pricingModel === "FIXED_TOTAL" ? "Shared between everyone paying" : "Price grows with attendees"} />
        <MoneyRow label="Merchant" value={<span className="font-sans text-[16px]">{q.merchantName}</span>} sub={`${q.offeringName} · ${q.location}`} />
        <MoneyRow label="Date" value={<span className="font-sans text-[16px]">{formatWhenFull(q.activityAt, tz)}</span>} />
        <MoneyRow label="Commit by" value={<span className="font-sans text-[16px]">{formatWhenFull(q.deadlineAt, tz)}</span>} />
        <MoneyRow
          label="Sponsored guest"
          value={<span className="font-sans text-[16px]">{q.sponsoredNames.length ? q.sponsoredNames.join(", ") : "None"}</span>}
          sub={q.sponsoredNames.length ? "Pays $0; everyone else shares the total" : undefined}
        />
        <MoneyRow
          label="Sharing rule"
          value={<span className="font-sans text-[16px]">Equal split</span>}
          sub="Equal shares can differ by one cent"
        />
        <MoneyRow label="Your maximum" value={formatMoney(cap)} emphasis />
      </MoneyRows>
      <div className="rounded-[18px] border border-amber-line bg-amber-bg p-4 text-amber-ink">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-1 size-6 shrink-0 accent-[#C8402D]"
          />
          <span>
            I agree to authorize up to <strong>{formatMoney(cap)}</strong> for this plan. My final share may be lower, and it is only collected if
            the agreed group booking is confirmed.
          </span>
        </label>
      </div>
      <ActionErrorBanner error={error} />
      <div className="space-y-3">
        <Button
          block
          loading={busy}
          loadingLabel="Authorizing…"
          disabled={!checked}
          disabledReason="Tick the box above to continue."
          onClick={() =>
            run("authorize", async () => {
              try {
                if (!hasConsent) await actions.consent(q.termsHash);
                const url = await actions.pay();
                // Leave the page for PayPal (or the fixture approval page). Keep the button busy.
                window.location.assign(url);
                await new Promise(() => {});
              } catch (e) {
                if ((e as { code?: string }).code === "TERMS_CHANGED") {
                  setChecked(false);
                  await actions.refresh();
                }
                throw e;
              }
            })
          }
        >
          {fixture ? `Authorize up to ${formatMoney(cap)} (fixture)` : `Authorize up to ${formatMoney(cap)} with PayPal`}
        </Button>
        <Button variant="link" onClick={onClose} disabled={busy} className="w-full justify-center">
          Back
        </Button>
      </div>
      <p className="text-small text-ink-muted">
        {fixture
          ? "Fixture — not real PayPal. You'll see a simulated approval page. No money moves."
          : "You'll approve this on PayPal's sandbox page. No real money is used."}
      </p>
    </Card>
  );
}

function WaitingPanel({ view, actions, clockOffsetMs }: { view: OutingView; actions: OutingActions; clockOffsetMs: number }) {
  const pay = view.me.payment!;
  const { pending, error, run } = useAction();
  const [confirm, setConfirm] = useState(false);
  const est = view.estimates.estimatedShareMinor;
  const r = view.roster;
  return (
    <div className="space-y-6">
      <div className="space-y-4 text-center">
        <p className="font-display text-[22px] leading-7">{view.outing.title}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <StatusBadge kind="authorized" />
          <Pill tone="neutral">Not charged yet</Pill>
        </div>
        <h1 className="text-[32px] leading-9 sm:text-[36px] sm:leading-10">
          {formatMoney(pay.authorizedMinor)} authorized · {est !== null ? `estimated final share ${formatMoney(est)}` : "final share to be set at the deadline"} · not
          charged yet.
        </h1>
      </div>
      <Card>
        <MoneyRows>
          <MoneyRow label="Authorized up to" value={formatMoney(pay.authorizedMinor)} sub="A hold on your payment method" />
          {est !== null && <MoneyRow label="Estimated final share" value={formatMoney(est)} sub="Drops as more people commit" />}
          <MoneyRow label="Charged so far" value={formatMoney(pay.capturedMinor)} />
        </MoneyRows>
      </Card>
      <Card className="space-y-4">
        <ProgressBar id="waiting" value={r.payersAuthorized} max={r.invitedPayers} label={`${r.payersAuthorized} of ${r.invitedPayers} payers committed`} />
        <p className="flex items-center justify-between gap-2 text-small text-ink-muted">
          <span>Commit by {formatDeadline(view.outing.deadlineAt, view.outing.displayTimezone)}</span>
          <Countdown targetIso={view.outing.deadlineAt} offsetMs={clockOffsetMs} />
        </p>
        <p className="text-small text-ink-muted">
          {pay.providerLabel}
          {pay.authorizationRef ? ` · ref ${pay.authorizationRef}` : ""}
        </p>
      </Card>
      <p className="text-center text-ink-muted">We collect your share only if the agreed group booking is confirmed.</p>
      <ActionErrorBanner error={error} />
      {view.me.can.withdraw && (
        <div className="text-center">
          {!confirm ? (
            <Button variant="link" onClick={() => setConfirm(true)}>
              Withdraw my authorization
            </Button>
          ) : (
            <Card tone="blush" className="space-y-3 text-left">
              <p className="font-semibold">Withdraw and release your hold?</p>
              <p className="text-small text-ink-muted">
                {view.viewer.required
                  ? "You're a required guest, so withdrawing cancels the outing for everyone. "
                  : "You'll no longer be part of this booking. "}
                {fixtureHold(view)
                  ? "Your simulated hold is released (fixture — no real money is involved)."
                  : "Your hold is released by PayPal — it can take a few days to disappear from your account."}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="danger"
                  loading={pending === "withdraw"}
                  loadingLabel="Withdrawing…"
                  onClick={() => run("withdraw", async () => { await actions.withdraw(); await actions.refresh(); })}
                >
                  Yes, withdraw
                </Button>
                <Button variant="secondary" onClick={() => setConfirm(false)} disabled={pending === "withdraw"}>
                  Keep my commitment
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

export function CommitStage({
  view,
  actions,
  clockOffsetMs,
  paymentFlag,
  paymentReason,
}: {
  view: OutingView;
  actions: OutingActions;
  clockOffsetMs: number;
  paymentFlag?: PaymentFlag;
  paymentReason?: string;
}) {
  const { pending, error, run } = useAction();
  const [reviewing, setReviewing] = useState(false);
  const [declineConfirm, setDeclineConfirm] = useState(false);
  const q = view.quote;
  const tz = view.outing.displayTimezone;
  const pay = view.me.payment;
  const sponsoredViewer = view.viewer.payerType === "SPONSORED";
  const cap = view.estimates.capMinor ?? q?.capMinor ?? null;
  const est = view.estimates.estimatedShareMinor;
  const r = view.roster;
  const hasAuth = !!pay && ["AUTHORIZED", "CAPTURE_PENDING", "CAPTURED"].includes(pay.status);
  const gone = view.viewer.attendance === "DECLINED" || view.viewer.attendance === "WITHDRAWN";

  if (!q) {
    return (
      <div className="space-y-6">
        <ScreenHeader view={view} title="Commitments are opening" />
        <StatusBanner tone="info">The organizer is finishing the quote. Refresh in a moment.</StatusBanner>
      </div>
    );
  }

  if (hasAuth && !reviewing) {
    return (
      <div className="space-y-6">
        <ModeRow view={view} />
        <PaymentFlagBanner flag={paymentFlag} reason={paymentReason} view={view} />
        <WaitingPanel view={view} actions={actions} clockOffsetMs={clockOffsetMs} />
        {view.organizer?.can.cancel && <OrganizerTools view={view} actions={actions} />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="-mx-5 -mt-6 sm:mx-0 sm:mt-0 sm:overflow-hidden sm:rounded-card-lg">
        <InvitationHero className="h-[150px] sm:h-[180px]" />
      </div>
      <div className="space-y-3 text-center">
        <ModeRow view={view} />
        <h1 className="text-[44px] leading-[48px]">
          {view.viewer.isOrganizer ? (
            <>
              Commit your <Underlined>share.</Underlined>
            </>
          ) : (
            <>
              You&apos;re <Underlined>invited.</Underlined>
            </>
          )}
        </h1>
        <p className="font-display text-[26px] leading-8">{view.outing.title}</p>
        <ul className="flex flex-col items-center justify-center gap-2 text-body sm:flex-row sm:gap-5">
          <li className="flex items-center gap-2">
            <CalendarDays className="size-5 text-coral-700" aria-hidden />
            {formatWhen(q.activityAt, tz)}
          </li>
          <li className="flex items-center gap-2">
            <MapPin className="size-5 text-coral-700" aria-hidden />
            {q.merchantName}
          </li>
          <li className="flex items-center gap-2">
            <Users className="size-5 text-coral-700" aria-hidden />
            {q.pricingModel === "FIXED_TOTAL" ? `Private room up to ${q.capacity}` : `Up to ${q.capacity} people`}
          </li>
        </ul>
      </div>

      <PaymentFlagBanner flag={paymentFlag} reason={paymentReason} view={view} />

      <Card>
        <MoneyRows>
          <MoneyRow
            label={q.pricingModel === "FIXED_TOTAL" ? "Fixed room total" : "Total (grows with attendees)"}
            value={formatMoney(q.totalMinor)}
            sub={
              <>
                {r.attendeeCount} attendees · {r.invitedPayers} paying
                {q.sponsoredNames.length > 0 && (
                  <span className="block font-medium text-ink">
                    {q.sponsoredNames.map((n) => n.split(" ")[0]).join(", ")}&apos;s share is covered
                  </span>
                )}
              </>
            }
          />
          {!sponsoredViewer && cap !== null && <MoneyRow label="Your maximum" value={formatMoney(cap)} />}
          {!sponsoredViewer && est !== null && <MoneyRow label="Estimated share" value={formatMoney(est)} emphasis />}
          {sponsoredViewer && <MoneyRow label="You pay" value="$0" emphasis />}
        </MoneyRows>
      </Card>

      <div className="space-y-4 text-center">
        <p className="inline-flex flex-wrap items-center justify-center gap-2 rounded-pill bg-blush px-5 py-2 font-bold text-coral-800">
          <Clock className="size-5" aria-hidden />
          Commit by {formatDeadline(q.deadlineAt, tz)}
        </p>
        <p className="text-small text-ink-muted">
          <Countdown targetIso={view.outing.deadlineAt} offsetMs={clockOffsetMs} />
        </p>
        <ProgressBar
          id="commit"
          className="text-left"
          value={r.payersAuthorized}
          max={r.invitedPayers}
          label={`${r.payersAuthorized} of ${r.invitedPayers} payers committed`}
        />
      </div>

      <ActionErrorBanner error={error} />

      {gone ? (
        <StatusBanner tone="info" title={view.viewer.attendance === "WITHDRAWN" ? "You withdrew" : "You declined"}>
          You won&apos;t be charged. If this was a mistake, ask the organizer.
        </StatusBanner>
      ) : sponsoredViewer ? (
        view.viewer.attendance === "ACCEPTED" ? (
          <StatusBanner tone="success" title="You’re in">
            Your share is covered. You pay $0 and don&apos;t need to do anything else.
          </StatusBanner>
        ) : (
          <div className="space-y-3">
            <p className="text-center">Your share is covered. Just let everyone know if you can make it.</p>
            <Button
              block
              loading={pending === "accept"}
              loadingLabel="Saving…"
              disabled={!view.me.can.accept}
              onClick={() => run("accept", async () => { await actions.respond("ACCEPT"); await actions.refresh(); })}
            >
              Accept — I&apos;ll be there
            </Button>
          </div>
        )
      ) : reviewing ? (
        <TermsReview view={view} actions={actions} onClose={() => setReviewing(false)} />
      ) : view.me.can.consent || view.me.can.authorize ? (
        <div className="space-y-3">
          <Button block onClick={() => setReviewing(true)} aria-expanded={false}>
            Review &amp; authorize {cap !== null ? formatMoney(cap) : ""}
          </Button>
          <p className="text-center text-small text-ink-muted">
            Authorize up to {cap !== null ? formatMoney(cap) : "your maximum"}. Your final share may be lower. We collect it only if the agreed group
            booking is confirmed.
          </p>
        </div>
      ) : (
        <StatusBanner tone="info">
          {view.outing.status === "COLLECTING" ? "You can’t commit right now." : "Commitments are closed."}
        </StatusBanner>
      )}

      {!gone && (view.me.can.decline || view.me.can.withdraw) && !reviewing && !hasAuth && (
        <div className="text-center">
          {!declineConfirm ? (
            <Button variant="link" onClick={() => setDeclineConfirm(true)}>
              Decline invitation
            </Button>
          ) : (
            <Card tone="blush" className="space-y-3 text-left">
              <p className="font-semibold">Decline this invitation?</p>
              {view.viewer.required && (
                <p className="text-small text-ink-muted">You&apos;re a required guest, so declining cancels the outing for everyone.</p>
              )}
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="danger"
                  loading={pending === "decline"}
                  loadingLabel="Declining…"
                  onClick={() => run("decline", async () => { await actions.respond("DECLINE"); await actions.refresh(); })}
                >
                  Yes, decline
                </Button>
                <Button variant="secondary" onClick={() => setDeclineConfirm(false)}>
                  Keep my place
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      <RosterList view={view} />
      {view.organizer?.can.addInvitees && (
        <InvitePanel actions={actions} hint="Guests added now are optional — they never block the booking." />
      )}
      {view.organizer?.can.cancel && <OrganizerTools view={view} actions={actions} />}
      <div aria-hidden className="relative my-2 text-center text-small text-ink-muted">
        <span className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
        <span className="relative bg-cream px-3">{view.outing.paymentMode === "PAYPAL_SANDBOX" ? "PayPal sandbox demo" : "Demo · no real money"}</span>
      </div>
    </div>
  );
}

function OrganizerTools({ view, actions }: { view: OutingView; actions: OutingActions }) {
  const [confirm, setConfirm] = useState(false);
  const [requested, setRequested] = useState(false);
  const { pending, error, run } = useAction();
  if (!view.organizer?.can.cancel) return null;
  return (
    <Card tone="blush" className="space-y-3">
      <h2 className="text-h3">Organizer tools</h2>
      <ActionErrorBanner error={error} />
      {requested ? (
        // The cancellation is queued for the server's settlement job (it also releases holds); until it runs the
        // outing still shows as open, so say what is happening instead of looking like nothing happened.
        <StatusBanner tone="pending" title="Cancellation requested">
          The server is cancelling this outing and releasing every hold. This page updates on its own.
        </StatusBanner>
      ) : !confirm ? (
        <Button variant="danger" onClick={() => setConfirm(true)}>
          Cancel this outing
        </Button>
      ) : (
        <div className="space-y-3">
          <p>
            Cancelling ends the plan for everyone. No booking payment is collected, and existing payment holds are released
            {fixtureHold(view) ? " (fixture holds — no real money is involved)." : " by PayPal — which can take a few days to show."}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" loading={pending === "cancel"} loadingLabel="Cancelling…" onClick={() => run("cancel", async () => { await actions.cancel(); setRequested(true); await actions.refresh(); })}>
              Yes, cancel the outing
            </Button>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
