import { Suspense } from "react";
import { ArrowRight, CalendarDays, CircleCheck, Coins, Store, Tag, Users, UserRoundX } from "lucide-react";
import Link from "next/link";
import { LinkButton } from "@/components/ui/Button";
import { SandboxBadge } from "@/components/ui/Badge";
import { HeroArt } from "@/components/ui/Illustrations";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";
import { Underlined } from "@/components/ui/Swoosh";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { PaymentSigninNotice } from "@/components/ui/PaymentSigninNotice";

const STEPS = [
  { n: 1, Icon: CalendarDays, title: "Plan together", text: "Everyone suggests a total budget in private. Only the spread is revealed." },
  { n: 2, Icon: Coins, title: "Commit your share", text: "Authorize up to your maximum. It's a hold, not a charge." },
  { n: 3, Icon: CircleCheck, title: "Get confirmed", text: "At the deadline we book it, or release every hold." },
];

export default function Home() {
  return (
    <>
      <SiteHeader nav />
      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-6 pt-8 sm:px-6 sm:pt-12">
        {/* Client-only query read; Suspense keeps the landing page statically rendered. */}
        <Suspense fallback={null}>
          <PaymentSigninNotice />
        </Suspense>
        <div className="grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
          <div className="space-y-6">
            <h1 className="text-[44px] leading-[48px] sm:text-[56px] sm:leading-[60px]">
              Make plans.
              <br />
              Make them <Underlined>happen.</Underlined>
            </h1>
            <p className="text-lead text-ink">Agree on a budget. Commit your share. Go together.</p>
            <p className="max-w-xl text-ink-muted">
              No more one friend fronting the bill and chasing everyone. Each person authorizes only their own maximum, and nobody is charged unless the whole agreed group commits.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <LinkButton href="/new" arrow className="sm:w-auto">
                Create an outing
              </LinkButton>
              <LinkButton href="/demo" variant="secondary">
                Try the demo
              </LinkButton>
            </div>
            <p>
              <Link href="/how-it-works" className="inline-flex min-h-[44px] items-center gap-1 font-semibold text-coral-700 underline underline-offset-4 hover:text-coral-800">
                See exactly how the money works
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </p>

            <section aria-labelledby="demo-card" className="max-w-md rounded-card-lg border border-line bg-surface p-5 sm:p-6">
              <SandboxBadge />
              <h2 id="demo-card" className="mt-3 text-[32px] leading-9">
                Friday karaoke
              </h2>
              <ul className="mt-4 space-y-3">
                <li className="flex items-center gap-3">
                  <Users className="size-5 shrink-0" aria-hidden />
                  <ProgressBar id="landing" className="flex-1" value={4} max={5} label="4 of 5 payers committed" />
                </li>
                <li className="flex items-center gap-3">
                  <Tag className="size-5 shrink-0" aria-hidden />
                  <span>$20 estimated share</span>
                </li>
                <li className="flex items-center gap-3">
                  <CalendarDays className="size-5 shrink-0" aria-hidden />
                  <span>Closes tomorrow, 18:00</span>
                </li>
              </ul>
              <p className="mt-4 text-small text-ink-muted">A sample outing, not a real booking.</p>
            </section>
          </div>
          <HeroArt className="aspect-[4/3] w-full lg:aspect-[5/4]" />
        </div>

        <section aria-labelledby="ps-h" className="mt-14 border-t border-line pt-10">
          <h2 id="ps-h" className="max-w-2xl text-[28px] leading-9 sm:text-h2">
            The same $100 karaoke room, two ways
          </h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-card border border-line bg-surface p-5 sm:p-6">
              <p className="flex items-center gap-2 font-display text-h3">
                <UserRoundX className="size-6 text-ink-muted" aria-hidden />
                Today
              </p>
              <p className="mt-2 text-ink-muted">
                One friend pays $100 up front, then chases four people in the group chat. Some pay late, some never.
              </p>
            </div>
            <div className="rounded-card border-2 border-coral-600 bg-blush-50 p-5 sm:p-6">
              <p className="flex items-center gap-2 font-display text-h3">
                <Store className="size-6 text-coral-700" aria-hidden />
                With Outings
              </p>
              <p className="mt-2">
                Five people each authorize up to <strong>$20</strong>, straight to the merchant. At the deadline each pays their exact share, or every hold is released.
              </p>
            </div>
          </div>
        </section>

        <section id="how" aria-labelledby="how-h" className="mt-14 scroll-mt-6 border-t border-line pt-10">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
            <h2 id="how-h" className="text-[28px] leading-9 sm:text-h2">
              How it works
            </h2>
            <Link href="/how-it-works" className="inline-flex min-h-[44px] items-center gap-1 font-semibold text-coral-700 underline underline-offset-4 hover:text-coral-800">
              Try the split calculator
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <ol className="mt-6 grid gap-6 md:grid-cols-3">
            {STEPS.map(({ n, Icon, title, text }) => (
              <li key={n} className="flex items-start gap-4">
                <span
                  aria-hidden
                  className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-blush font-bold text-coral-800"
                >
                  {n}
                </span>
                <div>
                  <h3 className="flex items-center gap-2 font-display text-h3">
                    <Icon className="size-6" aria-hidden />
                    {title}
                  </h3>
                  <p className="mt-1 text-ink-muted">{text}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-8 text-small text-ink-muted">
            A hold is not a charge. Independent hackathon project on PayPal sandbox or clearly labelled simulated payments. Merchants can follow every booking on the{" "}
            <Link href="/merchant" className="font-semibold text-coral-700 underline underline-offset-4 hover:text-coral-800">
              merchant dashboard
            </Link>
            .
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
