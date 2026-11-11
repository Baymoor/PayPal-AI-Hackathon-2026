import { Suspense } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { InvitationPreview } from "@/components/home/InvitationPreview";
import { LinkButton } from "@/components/ui/Button";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";
import { Underlined } from "@/components/ui/Swoosh";
import { PaymentSigninNotice } from "@/components/ui/PaymentSigninNotice";

/** Each step gets its own flat tint from the palette, so the three read as a set of cards, not a paragraph. */
const STEPS = [
  { n: 1, tint: "bg-captured-bg", title: "Plan together", text: "Everyone says in private what they'd personally pay. Only the spread is revealed." },
  { n: 2, tint: "bg-amber-bg", title: "Commit your share", text: "Approve a hold for your maximum share. A hold is not a charge." },
  { n: 3, tint: "bg-authorized-bg", title: "Get confirmed", text: "At the deadline we book it and collect each exact share, or release every hold." },
] as const;

const container = "mx-auto w-full max-w-[1180px] px-5 sm:px-6";
const textLink = "inline-flex min-h-[44px] items-center gap-1 font-semibold text-coral-700 underline underline-offset-4 hover:text-coral-800";

export default function Home() {
  return (
    <>
      <SiteHeader nav />
      <main id="main" className="flex-1 pb-6">
        {/* Hero on a full-width block of flat colour. */}
        <div className="bg-blush">
          <div className={`${container} pb-12 pt-8 sm:pb-16 sm:pt-14`}>
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
              </div>
              <InvitationPreview />
            </div>
          </div>
        </div>

        <div className={container}>
          {/* The pitch in one comparison, directly under the hero. */}
          <section aria-labelledby="ps-h" className="pt-12 sm:pt-16">
            <h2 id="ps-h" className="text-[28px] leading-9 sm:text-h2">
              The same $100 karaoke room, two ways
            </h2>
            <div className="mt-6 grid gap-5 md:grid-cols-2">
              <div className="space-y-2 rounded-card-lg border border-line bg-surface p-6">
                <p className="text-small font-bold text-ink-muted">Today</p>
                <p className="text-lead">One friend pays $100 up front, then chases four people in the group chat. Some pay late, some never.</p>
              </div>
              <div className="space-y-2 rounded-card-lg border-2 border-coral-600 bg-blush-50 p-6">
                <p className="text-small font-bold text-coral-700">With Outings</p>
                <p className="text-lead">
                  Five people each approve a hold of up to <strong>$20</strong>, straight to the venue. Nobody is charged before the deadline. Then each pays their exact share, or every hold is released.
                </p>
              </div>
            </div>
          </section>

          <section id="how" aria-labelledby="how-h" className="mt-14 scroll-mt-6 sm:mt-16">
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
              <h2 id="how-h" className="text-[28px] leading-9 sm:text-h2">
                How it works
              </h2>
              <Link href="/how-it-works" className={textLink}>
                Try the split calculator
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </div>
            <ol className="mt-6 grid gap-5 md:grid-cols-3">
              {STEPS.map(({ n, tint, title, text }) => (
                <li key={n} className={`space-y-3 rounded-card-lg p-6 ${tint}`}>
                  <span
                    aria-hidden
                    className="inline-flex size-10 items-center justify-center rounded-full bg-coral-600 font-display text-[20px] font-semibold text-white"
                  >
                    {n}
                  </span>
                  <h3 className="font-display text-h3">{title}</h3>
                  <p>{text}</p>
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
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
