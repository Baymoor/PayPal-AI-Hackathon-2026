import { Suspense } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { InvitationPreview } from "@/components/home/InvitationPreview";
import { LinkButton } from "@/components/ui/Button";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";
import { Underlined } from "@/components/ui/Swoosh";
import { PaymentSigninNotice } from "@/components/ui/PaymentSigninNotice";

const STEPS = [
  { n: 1, title: "Plan together", text: "Everyone suggests a total budget in private. Only the spread is revealed." },
  { n: 2, title: "Commit your share", text: "Approve a hold for your maximum share. A hold is not a charge." },
  { n: 3, title: "Get confirmed", text: "At the deadline we book it and collect each exact share, or release every hold." },
];

const textLink = "inline-flex min-h-[44px] items-center gap-1 font-semibold text-coral-700 underline underline-offset-4 hover:text-coral-800";

export default function Home() {
  return (
    <>
      <SiteHeader nav />
      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-6 pt-8 sm:px-6 sm:pt-14">
        {/* Client-only query read; Suspense keeps the landing page statically rendered. */}
        <Suspense fallback={null}>
          <PaymentSigninNotice />
        </Suspense>
        <div className="grid items-center gap-12 lg:grid-cols-[1.25fr_1fr] lg:gap-16">
          <div className="space-y-6">
            <h1 className="text-[44px]/[52px] sm:text-hero">
              Book it <Underlined>together.</Underlined>
              <br />
              Pay only if it happens.
            </h1>
            <p className="max-w-xl text-lead text-ink">
              Everyone approves a hold for their own maximum. At the deadline each person pays their exact share, or every hold is released.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <LinkButton href="/new" arrow className="sm:w-auto">
                Create an outing
              </LinkButton>
              <LinkButton href="/demo" variant="secondary">
                Try the demo
              </LinkButton>
            </div>

            {/* The pitch in one comparison, directly under the calls to action. */}
            <section aria-labelledby="ps-h" className="border-t border-line-strong pt-6">
              <h2 id="ps-h" className="text-h3">
                The same $100 karaoke room, two ways
              </h2>
              <div className="mt-4 grid gap-6 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-small font-bold text-ink-muted">Today</p>
                  <p>One friend pays $100 up front, then chases four people in the group chat. Some pay late, some never.</p>
                </div>
                <div className="space-y-1">
                  <p className="text-small font-bold text-coral-700">With Outings</p>
                  <p>
                    Five people each approve a hold of up to <strong>$20</strong>, straight to the venue. Nobody is charged before the deadline. Then each pays their exact share, or every hold is released.
                  </p>
                </div>
              </div>
            </section>
          </div>
          <InvitationPreview />
        </div>

        <section id="how" aria-labelledby="how-h" className="mt-16 scroll-mt-6 border-t border-line pt-10">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
            <h2 id="how-h" className="text-[28px] leading-9 sm:text-h2">
              How it works
            </h2>
            <Link href="/how-it-works" className={textLink}>
              Try the split calculator
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <ol className="mt-6 grid gap-8 md:grid-cols-3">
            {STEPS.map(({ n, title, text }) => (
              <li key={n} className="space-y-2">
                <span
                  aria-hidden
                  className="inline-flex size-[30px] items-center justify-center rounded-full border-[1.5px] border-ink text-[14px] font-bold"
                >
                  {n}
                </span>
                <h3 className="font-display text-h3">{title}</h3>
                <p className="text-ink-muted">{text}</p>
              </li>
            ))}
          </ol>
          <p className="mt-6">
            <Link href="/merchant" target="_blank" rel="noopener noreferrer" className={textLink}>
              Venues see every booking on the merchant dashboard
              <ArrowUpRight className="size-4" aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </Link>
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
