import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { JudgeSessionLink } from "@/components/judge/JudgeSessionLink";
import { SandboxBadge } from "./Badge";
import { cn } from "./cn";

/**
 * A link from the guest side to the merchant side. It opens in a new tab so a visitor can keep the
 * outing in one tab and the merchant dashboard in the other; the arrow and the hidden text say so.
 */
export function MerchantSideLink({
  className,
  iconClassName,
  children,
}: {
  className?: string;
  /** e.g. "hidden sm:inline" where the arrow would not fit. */
  iconClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href="/merchant" target="_blank" rel="noopener noreferrer" className={cn("gap-1", className)}>
      {children}
      <ArrowUpRight className={cn("size-4 shrink-0", iconClassName)} aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </Link>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn("inline-flex min-h-[44px] items-center font-display text-[28px] leading-none font-semibold tracking-tight", className)}
      aria-label="Outings home"
    >
      Outings
      <svg aria-hidden viewBox="0 0 24 24" className="ml-1 -mt-3 size-5 text-coral" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M5 14 L9 12 M7 7 L11 9 M12 4 L12 9" />
      </svg>
    </Link>
  );
}

export function SiteHeader({
  right,
  back,
  nav,
}: {
  right?: React.ReactNode;
  back?: { href: string; label: string };
  nav?: boolean;
}) {
  return (
    <header className="border-b border-line/70">
      <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-x-3 px-5 py-2 sm:px-6 md:flex-nowrap">
        <div className="flex items-center gap-2">
          {back && (
            <Link
              href={back.href}
              aria-label={back.label}
              className="-ml-2 inline-flex size-11 items-center justify-center rounded-full hover:bg-blush-50"
            >
              <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
          )}
          <Logo />
        </div>
        {nav && (
          <nav aria-label="Main" className="order-last flex w-full items-center gap-x-6 overflow-x-auto md:order-none md:w-auto md:gap-8">
            <Link href="/how-it-works" className="inline-flex min-h-[44px] items-center whitespace-nowrap font-medium hover:text-coral-700">
              How it works
            </Link>
            <Link href="/demo" className="inline-flex min-h-[44px] items-center whitespace-nowrap font-medium hover:text-coral-700">
              Try the demo
            </Link>
            <MerchantSideLink
              className="inline-flex min-h-[44px] items-center whitespace-nowrap font-medium hover:text-coral-700"
              iconClassName="hidden sm:inline"
            >
              {/* The full label and the arrow would be cut off in the phone nav; the footer and buttons say "Merchant dashboard". */}
              <span className="sm:hidden">Merchants</span>
              <span className="hidden sm:inline">Merchant dashboard</span>
            </MerchantSideLink>
          </nav>
        )}
        <div className="flex items-center gap-3">
          {right}
          <SandboxBadge />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const link = "inline-flex min-h-[44px] items-center font-semibold text-coral-700 underline underline-offset-4 hover:text-coral-800";
  return (
    <footer className="mt-auto px-5 pb-8 pt-10 sm:px-6">
      <nav aria-label="Footer" className="mx-auto mb-3 flex max-w-[1180px] flex-wrap justify-center gap-x-6 text-small">
        <Link href="/how-it-works" className={link}>
          How it works
        </Link>
        <Link href="/demo" className={link}>
          Try the demo
        </Link>
        <MerchantSideLink className={link}>Merchant dashboard</MerchantSideLink>
        {/* Only on deployments with a judge gate (JUDGE_PASSWORD set); otherwise it renders nothing. */}
        <JudgeSessionLink />
      </nav>
      <div className="mx-auto flex max-w-[1180px] items-center gap-4 text-small text-ink-muted">
        <span aria-hidden className="h-px flex-1 bg-line-strong" />
        <p className="max-w-xl text-center">
          Independent hackathon project. No real money moves.
        </p>
        <span aria-hidden className="h-px flex-1 bg-line-strong" />
      </div>
    </footer>
  );
}
