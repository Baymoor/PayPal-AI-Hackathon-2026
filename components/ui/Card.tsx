import { cn } from "./cn";

type Tone = "white" | "blush" | "navy" | "amber";

const tones: Record<Tone, string> = {
  white: "bg-surface border border-line text-ink",
  blush: "bg-blush-50 border border-line text-ink",
  navy: "bg-ink text-cream border border-ink on-dark",
  amber: "bg-amber-bg border border-amber-line text-amber-ink",
};

export function Card({
  tone = "white",
  className,
  as: Tag = "div",
  children,
  ...rest
}: {
  tone?: Tone;
  className?: string;
  as?: "div" | "section" | "article" | "aside";
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={cn("rounded-card p-5 sm:p-6", tones[tone], className)} {...rest}>
      {children}
    </Tag>
  );
}

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-caption font-semibold uppercase tracking-[0.14em] text-ink-muted", className)}>{children}</p>
  );
}

export function IconTile({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-11 shrink-0 items-center justify-center rounded-chip bg-blush text-coral-800", className)}
    >
      {children}
    </span>
  );
}
