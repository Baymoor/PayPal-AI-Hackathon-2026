import { CalendarDays, CircleCheck, Coins, Tag, Users } from "lucide-react";
import { LinkButton } from "@/components/ui/Button";
import { SandboxBadge } from "@/components/ui/Badge";
import { HeroArt } from "@/components/ui/Illustrations";
import { SiteFooter, SiteHeader } from "@/components/ui/SiteChrome";
import { Underlined } from "@/components/ui/Swoosh";
import { ProgressBar } from "@/components/ui/ProgressBar";

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
        <div className="grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
          <div className="space-y-6">
            <h1 className="text-[44px] leading-[48px] sm:text-[56px] sm:leading-[60px]">
              Make plans.
              <br />
              Make them <Underlined>happen.</Underlined>
            </h1>
            <p className="text-lead text-ink">Agree on a budget. Commit your share. Go together.</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <LinkButton href="/new" arrow className="sm:w-auto">
                Create an outing
              </LinkButton>
              <LinkButton href="/demo" variant="secondary">
                Try the demo
              </LinkButton>
            </div>

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

        <section id="how" aria-labelledby="how-h" className="mt-14 scroll-mt-6 border-t border-line pt-10">
          <h2 id="how-h" className="sr-only">
            How it works
          </h2>
          <ol className="grid gap-6 md:grid-cols-3">
            {STEPS.map(({ n, Icon, title, text }) => (
              <li key={n} className="flex items-start gap-4">
                <span
                  aria-hidden
                  className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-blush font-bold text-coral-800"
                >
                  {n}
                </span>
                <div>
                  <p className="flex items-center gap-2 font-display text-h3">
                    <Icon className="size-6" aria-hidden />
                    {title}
                  </p>
                  <p className="mt-1 text-ink-muted">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
