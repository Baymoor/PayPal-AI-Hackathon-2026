/**
 * FIXTURE approval page — stands in for PayPal's buyer approval screen when
 * the app runs in labelled demo mode. Never presented as PayPal.
 * Server-rendered; the amount comes from the stored payment attempt (the
 * consented cap), never from the URL. Only the attempt's own participant can
 * see it. Approve / Cancel post to /api/payments/fixture/approve, which
 * redirects to /o/<id>?payment=…
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { FlaskConical } from "lucide-react";
import { getDb } from "@/lib/db/client";
import { outings, paymentAttempts, quoteVersions } from "@/lib/db/schema";
import { config } from "@/lib/env";
import { PARTICIPANT_COOKIE, participantSessionFromCookieValue } from "@/lib/auth/session";
import { assertCurrency, formatMoney } from "@/lib/domain/money";
import { FIXTURE_PROVIDER_LABEL } from "@/lib/payments/fixture";

export const metadata: Metadata = {
  title: "Simulated approval (fixture)",
  robots: { index: false, follow: false },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatInstant(d: Date | null, timeZone: string): string | null {
  if (!d) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(d);
  } catch {
    return d.toISOString();
  }
}

export default async function FixtureApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const attemptId = typeof sp.attempt === "string" ? sp.attempt : "";
  if (!config().demoFixturesEnabled || !UUID_RE.test(id) || !UUID_RE.test(attemptId)) notFound();

  const store = await cookies();
  const session = participantSessionFromCookieValue(store.get(PARTICIPANT_COOKIE)?.value);
  const participantId = session.outings[id];

  const db = getDb();
  const attempt = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
  if (!attempt || attempt.outingId !== id || attempt.provider !== "FIXTURE" || !participantId || attempt.participantId !== participantId) {
    notFound();
  }
  const outing = await db.query.outings.findFirst({ where: eq(outings.id, id) });
  const quote = await db.query.quoteVersions.findFirst({ where: eq(quoteVersions.id, attempt.quoteId) });
  if (!outing || !quote) notFound();

  const currency = assertCurrency(attempt.currency);
  const amount = formatMoney(attempt.requestedMinor, currency, { alwaysShowCents: true });
  const terms = (quote.terms ?? {}) as { offeringName?: string; merchantName?: string };
  const deadline = formatInstant(outing.deadlineAt, outing.displayTimezone);
  const open = attempt.status === "APPROVAL_PENDING";

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10">
      <div
        role="note"
        className="fixture-stripes rounded-2xl border-2 border-dashed border-fixture bg-fixture-bg p-4 text-fixture"
      >
        <p className="flex items-center gap-2 text-lead font-semibold">
          <FlaskConical aria-hidden="true" className="h-5 w-5 shrink-0" />
          FIXTURE — simulated approval, not PayPal
        </p>
        <p className="mt-1 text-small">
          {FIXTURE_PROVIDER_LABEL}. This page stands in for PayPal&apos;s approval screen in demo mode. No PayPal account is
          involved and no real or sandbox money moves.
        </p>
      </div>

      <section className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <p className="text-small text-ink-muted">{outing.title}</p>
        <h1 className="mt-1 text-h3">Authorize up to {amount}</h1>
        <p className="mt-3 text-body">
          Your final share may be lower. It is collected only if the agreed group booking is confirmed.
        </p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
          {terms.offeringName ? (
            <>
              <dt className="text-ink-muted">Booking</dt>
              <dd>{terms.offeringName}</dd>
            </>
          ) : null}
          {terms.merchantName ? (
            <>
              <dt className="text-ink-muted">Merchant</dt>
              <dd>{terms.merchantName}</dd>
            </>
          ) : null}
          <dt className="text-ink-muted">Maximum hold</dt>
          <dd>{amount}</dd>
          {deadline ? (
            <>
              <dt className="text-ink-muted">Commitment deadline</dt>
              <dd>{deadline}</dd>
            </>
          ) : null}
        </dl>

        {open ? (
          <div className="mt-6 flex flex-wrap gap-3">
            <form method="post" action="/api/payments/fixture/approve">
              <input type="hidden" name="attemptId" value={attempt.id} />
              <input type="hidden" name="outcome" value="APPROVE" />
              <button type="submit" className="rounded-full bg-coral-600 px-5 py-2.5 font-semibold text-white hover:bg-coral-700">
                Approve simulated hold
              </button>
            </form>
            <form method="post" action="/api/payments/fixture/approve">
              <input type="hidden" name="attemptId" value={attempt.id} />
              <input type="hidden" name="outcome" value="CANCEL" />
              <button type="submit" className="rounded-full border border-line-strong bg-surface px-5 py-2.5 font-semibold text-ink">
                Cancel
              </button>
            </form>
          </div>
        ) : (
          <p className="mt-6 rounded-xl bg-cancelled-bg p-3 text-small text-cancelled">
            This simulated approval is no longer open (status: {attempt.status.toLowerCase().replace(/_/g, " ")}).
          </p>
        )}
      </section>

      <a href={`/o/${id}`} className="text-small text-coral-700 underline">
        Back to the outing
      </a>
    </main>
  );
}
