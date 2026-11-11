import type { Metadata } from "next";
import {
  ArrowDown,
  ArrowUpRight,
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
    "How Outings splits a group booking: the five steps, a calculator to try, and exactly what happens at the deadline.",
};

const STEPS = [
  {
    name: "Brief",
    copy: "Say what you want to do, in your own words. We suggest places that fit. Nothing is booked yet.",
  },
  {
    name: "Budget",
    copy: "Everyone privately says what they'd personally pay. The group sees how the votes spread, never who said what. A vote is not a payment.",
  },
  {
    name: "Invite",
    copy: "You get a private link for each friend. Send it to them however you like.",
  },
  {
    name: "Commit",
    copy: "You approve a hold for your maximum share. A hold is not a charge. You pay your exact share only if the booking happens, and never more than your maximum.",
  },
  {
    name: "Deadline",
    copy: "Nobody is charged before the deadline. Then we either book it and collect each exact share, or release every hold.",
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
            Everyone approves a hold for their own maximum, and nothing more. At the deadline we either collect each person&apos;s exact share, to the cent, or release every hold.
          </p>
          <nav aria-label="On this page" className="flex flex-wrap gap-x-5 gap-y-1 text-small font-semibold">
            {[
              ["#steps", "Five steps"],
              ["#calculator", "Try the calculator"],
              ["#deadline", "At the deadline"],
              ["#ai", "What AI does"],
              ["#honesty", "Is this real money?"],
            ].map(([href, label]) => (
              <a key={href} href={href} className="inline-flex min-h-[44px] items-center text-coral-700 underline underline-offset-4 hover:text-coral-800">
                {label}
              </a>
            ))}
          </nav>
        </div>

        {/* (a) Steps */}
        <section id="steps" aria-labelledby="steps-h" className="mt-12 scroll-mt-6 border-t border-line pt-10">
          <SectionHead id="steps-h" title="Five steps from idea to booking" />
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
            Nothing you vote on or read here lets anyone charge you. Only your own approval does, for terms you have seen.
          </p>
        </section>

        {/* (b) Calculator */}
        <section id="calculator" aria-labelledby="calculator-h" className="mt-14 scroll-mt-6 border-t border-line pt-10">
          <SectionHead id="calculator-h" title="Try it: split a booking">
            Change the numbers and watch the shares move. It is the same arithmetic a real outing uses. Try $100 for 3 people.
          </SectionHead>
          <SplitCalculator />
        </section>

        {/* (c) Deadline */}
        <section id="deadline" aria-labelledby="deadline-h" className="mt-14 scroll-mt-6 border-t border-line pt-10">
          <SectionHead id="deadline-h" title="What happens at the deadline">
            When the deadline passes, the guest list is locked and exactly one of three things happens. Anyone who approves late is not added, and their hold is released. If we can&apos;t confirm something, we cancel rather than guess.
          </SectionHead>

          <div className="flex flex-col items-center gap-2">
            <Card tone="navy" className="w-full max-w-md text-center">
              <p className="flex items-center justify-center gap-2 font-display text-h3">
                <CalendarClock className="size-6" aria-hidden />
                Deadline passes
              </p>
              <p className="mt-1 text-small text-[#C9D1E3]">Guest list locked · everyone who is required must have said yes and approved their hold</p>
            </Card>
            <ArrowDown className="size-6 text-ink-muted" aria-hidden />
          </div>
          <ul className="grid gap-4 lg:grid-cols-3" aria-label="The three outcomes">
            <Outcome
              tone="ok"
              Icon={CircleCheck}
              title="It's booked"
              when="Everyone required is in."
              steps={[
                "Each person's exact share is collected, one after another.",
                "Never more than the maximum they approved.",
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
              title="It's called off"
              when="Someone required is missing."
              steps={[
                "If one required person has not committed, the booking is cancelled, even if enough others have.",
                "Nobody is charged.",
                "We ask PayPal to release every hold.",
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
              title="A payment fails"
              when="One person's payment fails part-way through."
              steps={[
                "PayPal collects payments one at a time, so we stop at the first one that fails.",
                "The remaining holds are released.",
                "Payments already collected are refunded.",
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
                  "Reads your plan and picks out the activity, the date, the group size and the budget.",
                  "Matches it to real options and prices from the venues' own lists.",
                  "Sums up how the group voted, without names.",
                  "Explains the result in plain words.",
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
                  "Approve, collect, release or refund a payment. Ever.",
                  "Set or change a price, or make up a venue. Everything it suggests is checked against the venues' lists.",
                  "See anyone's private vote before the reveal.",
                  "Follow instructions hidden in a pasted chat. It only reads the chat.",
                  "Decide who pays what. The split is simple arithmetic, to the cent.",
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
          <SectionHead id="honesty-h" title="Is this real money? No.">
            This is an independent hackathon project. No real money moves. Every simulated piece is labelled on screen.
          </SectionHead>
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="space-y-2">
              <p className="flex items-center gap-2 font-display text-h3">
                <ListChecks className="size-6 text-captured" aria-hidden />
                Always real
              </p>
              <p className="text-ink-muted">The rules work for real everywhere on this site: the deadline, the split to the cent, your maximum, and who can see what.</p>
            </Card>
            <Card className="space-y-2">
              <p className="flex items-center gap-2 font-display text-h3">
                <ShieldCheck className="size-6 text-authorized" aria-hidden />
                PayPal&apos;s test system
              </p>
              <p className="text-ink-muted">When this site is connected to PayPal&apos;s sandbox (its official test system), approvals happen there, with test accounts and test money. Payments go to the venue, never to the organizer.</p>
            </Card>
            <Card className="space-y-3 border-dashed !border-fixture bg-fixture-bg/40">
              <p className="flex items-center gap-2 font-display text-h3">
                <FlaskConical className="size-6 text-fixture" aria-hidden />
                Simulated, and labelled
              </p>
              <p>The ready-made demo outings use a stand-in for PayPal. Where no AI model is connected, you get sample AI text. You will always see a label like these:</p>
              <div className="flex flex-wrap gap-2">
                <StatusBadge kind="fixture" />
                <StatusBadge kind="fixture" label="Fixture AI (no model call)" />
              </div>
            </Card>
          </div>
          <p className="mt-4 max-w-2xl text-ink-muted">
            We never say a hold is gone or a refund is done before PayPal confirms it. What has been tested against PayPal&apos;s sandbox so far is listed in the project&apos;s judge guide.
          </p>
        </section>

        <section aria-labelledby="cta" className="mt-14 rounded-card-lg bg-blush-50 p-6 text-center sm:p-10">
          <h2 id="cta" className="text-[28px] leading-9 sm:text-h2">
            Now try it yourself
          </h2>
          <p className="mx-auto mt-2 max-w-md text-ink-muted">Step into any guest&apos;s shoes in the demo, or open the venue&apos;s view in a second tab.</p>
          <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
            <LinkButton href="/demo" arrow>
              Try the demo
            </LinkButton>
            <LinkButton href="/merchant" variant="secondary" target="_blank" rel="noopener noreferrer">
              Merchant dashboard
              <ArrowUpRight className="size-5" aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </LinkButton>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
