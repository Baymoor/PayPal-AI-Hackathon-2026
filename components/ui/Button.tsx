"use client";
import Link from "next/link";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "link" | "danger";

const base =
  "inline-flex items-center justify-center gap-2 font-semibold select-none transition-colors disabled:cursor-not-allowed";

function variantClass(variant: Variant, block: boolean): string {
  switch (variant) {
    case "primary":
      return cn(
        base,
        "min-h-[52px] rounded-pill px-6 text-[17px] bg-coral-600 text-white hover:bg-[#A93322] active:bg-[#932B1C]",
        "disabled:bg-[#E8C2BA] disabled:text-ink-muted",
        block && "w-full min-h-[56px] sm:min-h-[52px]",
      );
    case "secondary":
      return cn(
        base,
        "min-h-[52px] rounded-pill px-6 text-[16px] border-[1.5px] border-ink text-ink bg-transparent hover:bg-blush-50",
        "disabled:border-line-strong disabled:text-ink-muted",
        block && "w-full",
      );
    case "danger":
      return cn(
        base,
        "min-h-[48px] rounded-pill px-5 text-[15px] border-[1.5px] border-danger text-danger bg-transparent hover:bg-danger-bg",
        "disabled:opacity-60",
        block && "w-full",
      );
    case "link":
      return cn(
        "inline-flex items-center gap-1 min-h-[44px] px-1 font-semibold text-coral-700 underline underline-offset-4 hover:text-coral-800 disabled:text-ink-muted disabled:no-underline",
      );
  }
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  block?: boolean;
  loading?: boolean;
  /** Label shown (with spinner) while loading, e.g. "Authorizing…". */
  loadingLabel?: string;
  arrow?: boolean;
  /** Visible reason a disabled button is disabled (rendered under the button). */
  disabledReason?: string;
}

export function Button({
  variant = "primary",
  block,
  loading,
  loadingLabel,
  arrow,
  disabledReason,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const reasonId = disabledReason ? `${rest.id ?? "btn"}-reason` : undefined;
  return (
    <>
      <button
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        aria-describedby={reasonId}
        className={cn(variantClass(variant, !!block), className)}
        {...rest}
      >
        {loading ? (
          <>
            <LoaderCircle className="spin size-5" aria-hidden />
            <span>{loadingLabel ?? children}</span>
          </>
        ) : (
          <>
            {children}
            {arrow && <ArrowRight className="size-5" aria-hidden />}
          </>
        )}
      </button>
      {disabledReason && disabled && (
        <p id={reasonId} className="mt-2 text-small text-ink-muted text-center">
          {disabledReason}
        </p>
      )}
    </>
  );
}

export function LinkButton({
  href,
  variant = "primary",
  block,
  arrow,
  className,
  children,
  ...rest
}: {
  href: string;
  variant?: Variant;
  block?: boolean;
  arrow?: boolean;
  className?: string;
  children: React.ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <Link href={href} className={cn(variantClass(variant, !!block), className)} {...rest}>
      {children}
      {arrow && <ArrowRight className="size-5" aria-hidden />}
    </Link>
  );
}
