import type { Metadata } from "next";
import {
  ArrowDown,
  Ban,
  Bot,
  CalendarClock,
  CircleCheck,
  FlaskConical,
  ListChecks,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { SplitCalculator } from "@/components/home/SplitCalculator";
import { LinkButton } from "@/components/ui/Button";
import { Card, Eyebrow } from "@/components/ui/Card";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";
import { StatusBadge } from "@/components/ui/Badge";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "How Outings splits a group booking: the five steps, an interactive penny-exact split calculator, and exactly what happens at the deadline.",
};

const STEPS = [
  {
    name: "Brief",
    copy: "Describe the plan in your own words. Suggestions are not bookings or payment approvals.",
  },
  {
    name: "Budget",
    copy: "Suggest a total budget. This does not authorize a payment. Your vote stays private until reveal.",
  },
  {
    name: "Invite",
    copy: "We create a private link for each person. You send it to them yourself.",
  },
  {
    name: "Commit",
    copy: "Authorize up to $20. Your final share may be lower. We collect it only if the agreed group booking is confirmed.",
  },
  {
    name: "Deadline",
    copy: "At the deadline we book it, or release every hold.",
  },
] as const;

/** Section title and lead. No numbered eyebrow: the on-page nav already orders the sections. */
function SectionHead({ id, title, children }: { id: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="mb-6 max-w-2xl space-y-2">
      <h2 id={id} className="text-[28px] leading-9 sm:text-h2">
        {title}
      </h2>
      {children && <p className="text-lead text-ink-muted">{children}</p>}
    </header>
  );
}

function Outcome({
  tone,
  Icon,
  title,
  when,
  steps,
  end,
}: {
  tone: "ok" | "cancel" | "fail";
  Icon: typeof CircleCheck;
  title: string;
  when: string;
  steps: string[];
  end: React.ReactNode;
}) {
  const edge = { ok: "border-t-captured", cancel: "border-t-cancelled", fail: "border-t-void-pending" }[tone];
  return (
    <li className={`flex flex-col rounded-card border border-line border-t-4 bg-surface p-5 ${edge}`}>
      <h3 className="flex items-center gap-2 text-h3">
        <Icon className="size-6 shrink-0" aria-hidden />
        {title}
      </h3>
      <p className="mt-2 text-small font-semibold text-ink-muted">{when}</p>
      <ol className="mt-3 flex-1 space-y-2.5">
        {steps.map((s, i) => (
          <li key={s} className="flex gap-3">
            <span aria-hidden className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-blush text-[13px] font-bold text-coral-800">
              {i + 1}
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <div className="mt-4 border-t border-line pt-3">{end}</div>
    </li>
  );
}

export default function HowItWorksPage() {
  return (
    <>
      <SiteHeader back={{ href: "/", label: "Back to home" }} />
      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-8 pt-8 sm:px-6 sm:pt-12">
        <div className="max-w-3xl space-y-5">
          <Eyebrow>How it works</Eyebrow>
          <h1 className="text-[40px] leading-[44px] sm:text-[56px] sm:leading-[60px]">
            Nobody fronts the money. Nobody pays alone.
          </h1>
          <p className="text-lead">
            Everyone authorizes only their own maximum. At the deadline we either collect each person&apos;s exact share, penny for penny, or release every hold.
          </p>
          <nav aria-label="On this page" className="flex flex-wrap gap-x-5 gap-y-1 text-small font-semibold">
            {[
              ["#steps", "Five steps"],
              ["#calculator", "Split calculator"],
              ["#deadline", "At the deadline"],
              ["#ai", "What AI does"],
              ["#honesty", "What is simulated"],
            ].map(([href, label]) => (
              <a key={href} href={href} className="inline-flex min-h-[44px] items-center text-coral-700 underline underline-offset-4 hover:text-coral-800">
                {label}
              </a>
            ))}
          </nav>
        </div>

        {/* (a) Steps */}
        <section id="steps" aria-labelledby="steps-h" className="mt-12 scroll-mt-6 border-t border-line pt-10">
          <SectionHead id="steps-h" title="Brief, budget, invite, commit, deadline" />
          <ol className="grid gap-6 md:grid-cols-5 md:gap-5">
            {STEPS.map(({ name, copy }, i) => (
              <li key={name} className="flex gap-4 md:flex-col md:gap-2">
                <span
                  aria-hidden
                  className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink text-[14px] font-bold"
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="font-display text-h3">{name}</h3>
                  <p className="mt-1 text-small text-ink-muted md:text-[15px]">{copy}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-ink-muted">
            A vote, a proposal or an AI summary is never permission to charge anyone. Only your own authorization, for terms you have seen, is.
          </p>
        </section>

        {/* (b) Calculator */}
        <section id="calculator" aria-labelledby="calculator-h" className="mt-14 scroll-mt-6 border-t border-line pt-10">
          <SectionHead id="calculator-h" title="The split calculator">
            This runs the same pure functions the server settles with: <code className="rounded bg-blush-50 px-1.5 py-0.5 text-[0.9em]">equalSplit</code>,{" "}
            <code className="rounded bg-blush-50 px-1.5 py-0.5 text-[0.9em]">perPayerCap</code> and{" "}
            <code className="rounded bg-blush-50 px-1.5 py-0.5 text-[0.9em]">estimatedShare</code>. Try $100 for 3 people.
          </SectionHead>
          <SplitCalculator />
        </section>

        {/* (c) Deadline */}
        <section id="deadline" aria-labelledby="deadline-h" className="mt-14 scroll-mt-6 border-t border-line pt-10">
          <SectionHead id="deadline-h" title="What happens at the deadline">
            A server-side job freezes the roster and picks exactly one of three paths. Late approvals are voided, never admitted. If anything cannot be verified, we fail closed and cancel.
          </SectionHead>

          <div className="flex flex-col items-center gap-2">
            <Card tone="navy" className="w-full max-w-md text-center">
              <p className="flex items-center justify-center gap-2 font-display text-h3">
                <CalendarClock className="size-6" aria-hidden />
                Deadline passes
              </p>
              <p className="mt-1 text-small text-[#C9D1E3]">Roster frozen · every required person must have accepted and authorized</p>
            </Card>
            <ArrowDown className="size-6 text-ink-muted" aria-hidden />
          </div>
          <ul className="grid gap-4 lg:grid-cols-3" aria-label="The three outcomes">
            <Outcome
              tone="ok"
              Icon={CircleCheck}
              title="Settle"
              when="Everyone required is in."
              steps={[
                "Each payer's exact share is captured, one after another.",
                "Never more than the maximum they authorized.",
                "The unused part of each hold is released.",
              ]}
              end={
                <p className="flex flex-wrap items-center gap-2">
                  <StatusBadge kind="captured" /> <span className="text-small text-ink-muted">Booking confirmed</span>
                </p>
              }
            />
            <Outcome
              tone="cancel"
              Icon={X}
              title="Cancel"
              when="Someone required is missing."
              steps={[
                "Even if the minimum number of payers was reached, a required holdout cancels.",
                "No booking payment is collected.",
                "We ask PayPal to release every existing hold.",
              ]}
              end={
                <p className="flex flex-wrap items-center gap-2">
                  <StatusBadge kind="void-pending" /> <span aria-hidden>→</span> <StatusBadge kind="released" />
                  <span className="basis-full text-small text-ink-muted">We say &ldquo;pending&rdquo; until PayPal confirms the release.</span>
                </p>
              }
            />
            <Outcome
              tone="fail"
              Icon={Undo2}
              title="Partial failure"
              when="A capture fails part-way through."
              steps={[
                "PayPal has no atomic group capture, so we stop right there.",
                "The remaining holds are voided.",
                "Payments already captured are refunded.",
              ]}
              end={
                <p className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-pill bg-void-pending-bg px-3 py-1 text-[13px] font-bold text-void-pending">Refund pending</span>
                  <span aria-hidden>→</span> <StatusBadge kind="refunded" />
                  <span className="basis-full text-small text-ink-muted">&ldquo;Booking not confirmed.&rdquo; We show a refund as done only once it is.</span>
                </p>
              }
            />
          </ul>
        </section>

        {/* (d) AI */}
        <section id="ai" aria-labelledby="ai-h" className="mt-14 scroll-mt-6 border-t border-line pt-10">
          <SectionHead id="ai-h" title="What AI does, and doesn't do">
            AI helps people agree. It never touches the money.
          </SectionHead>
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="space-y-3">
              <h3 className="flex items-center gap-2 text-h3">
                <Bot className="size-6 text-coral-700" aria-hidden />
                AI does
              </h3>
              <ul className="space-y-2.5">
                {[
                  "Reads your brief and pulls out the activity, dates, group size and budget unit.",
                  "Matches it to a small, merchant-owned catalogue of real quotes.",
                  "Summarizes the anonymous vote spread after the reveal.",
                  "Explains the deterministic result in plain words.",
                ].map((t) => (
                  <li key={t} className="flex gap-3">
                    <CircleCheck className="mt-0.5 size-5 shrink-0 text-captured" aria-hidden />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="space-y-3">
              <h3 className="flex items-center gap-2 text-h3">
                <Ban className="size-6 text-coral-700" aria-hidden />
                AI does not
              </h3>
              <ul className="space-y-2.5">
                {[
                  "Authorize, capture, void or refund a payment. Ever.",
                  "Set or change a price, or invent inventory. Output is validated against the catalogue.",
                  "See anyone's private vote before the reveal.",
                  "Treat pasted chats as instructions. They are data.",
                  "Decide who pays what. The split is plain integer arithmetic.",
                ].map((t) => (
                  <li key={t} className="flex gap-3">
                    <X className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </section>

        {/* (e) Honesty */}
        <section id="honesty" aria-labelledby="honesty-h" className="mt-14 scroll-mt-6 border-t border-line pt-10">
          <SectionHead id="honesty-h" title="What is simulated">
            This is an independent hackathon project. No real money moves. Every simulated piece is labelled on screen.
          </SectionHead>
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="space-y-2">
              <p className="flex items-center gap-2 font-display text-h3">
                <ListChecks className="size-6 text-captured" aria-hidden />
                Real code, both modes
              </p>
              <p className="text-ink-muted">The deadline job, penny-exact splitting, consent bound to exact terms, caps and access control run identically with or without PayPal keys.</p>
            </Card>
            <Card className="space-y-2">
              <p className="flex items-center gap-2 font-display text-h3">
                <ShieldCheck className="size-6 text-authorized" aria-hidden />
                PayPal sandbox
              </p>
              <p className="text-ink-muted">With sandbox keys, approvals happen on PayPal&apos;s sandbox with test accounts. Payments go to one sandbox merchant, never to the organizer.</p>
            </Card>
            <Card className="space-y-3 border-dashed !border-fixture bg-fixture-bg/40">
              <p className="flex items-center gap-2 font-display text-h3">
                <FlaskConical className="size-6 text-fixture" aria-hidden />
                Fixtures, labelled
              </p>
              <p>Without keys a simulator stands in for PayPal and a deterministic parser stands in for the model. Seeded outings are marked synthetic.</p>
              <div className="flex flex-wrap gap-2">
                <StatusBadge kind="fixture" />
                <StatusBadge kind="fixture" label="Fixture AI (no model call)" />
              </div>
            </Card>
          </div>
          <p className="mt-4 max-w-2xl text-ink-muted">
            Not claimed: we do not say a hold disappears instantly or that a refund is complete when it has only been requested. What has and has not yet been verified against the live PayPal sandbox is listed in the repository&apos;s judge guide.
          </p>
        </section>

        <section aria-labelledby="cta" className="mt-14 rounded-card-lg bg-blush-50 p-6 text-center sm:p-10">
          <h2 id="cta" className="text-[28px] leading-9 sm:text-h2">
            See it with real screens
          </h2>
          <p className="mx-auto mt-2 max-w-md text-ink-muted">Step into anyone&apos;s shoes in the demo, or open the merchant view.</p>
          <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
            <LinkButton href="/demo" arrow>
              Try the demo
            </LinkButton>
            <LinkButton href="/merchant" variant="secondary">
              Merchant dashboard
            </LinkButton>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
