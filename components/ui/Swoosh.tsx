import { cn } from "./cn";

/** Hand-drawn coral swoosh. Decorative; place inside a `relative inline-block` wrapper. */
export function Swoosh({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 200 14"
      preserveAspectRatio="none"
      // Sized and placed in em so it hugs the baseline at any heading size and never reaches the next line.
      className={cn("pointer-events-none absolute left-0 right-0 bottom-[0.02em] h-[0.16em] w-full", className)}
    >
      <path d="M3 9 C 40 2, 90 12, 130 6 S 185 4, 197 7" fill="none" stroke="#E8604C" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function Underlined({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative inline-block">
      {children}
      <Swoosh />
    </span>
  );
}
