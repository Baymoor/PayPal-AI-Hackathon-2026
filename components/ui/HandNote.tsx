import { cn } from "./cn";

/**
 * A short margin note in the display italic with a hand-drawn coral arrow, pointing at a picture of the UI.
 * Decorative: it only repeats what the page already says in text, so it is hidden from assistive tech.
 * `arrow` says which way the arrow points; place the note with `className` (it is absolutely positioned).
 */
export function HandNote({ children, arrow, className }: { children: React.ReactNode; arrow: "right" | "left"; className?: string }) {
  return (
    <p aria-hidden className={cn("pointer-events-none absolute font-display text-[21px]/[27px] font-medium italic text-coral-700", className)}>
      {children}
      <svg
        viewBox="0 0 130 60"
        focusable="false"
        className={cn("mt-1 block h-[52px] w-[112px] fill-none stroke-coral", arrow === "left" && "-scale-x-100")}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 6 C 20 44, 70 52, 122 40" />
        <path d="M106 30 L123 40 L108 52" />
      </svg>
    </p>
  );
}

/** A pill "sticker" laid over a picture of the UI, slightly rotated by the caller. Decorative. */
export function Sticker({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-10 whitespace-nowrap rounded-pill bg-surface px-4 py-2 text-[16px] font-bold text-ink shadow-[0_6px_16px_rgb(20_33_61/0.16)]",
        className,
      )}
    >
      {children}
    </span>
  );
}
