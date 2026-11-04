import { cn } from "./cn";

export function MoneyRows({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dl className={cn("divide-y divide-line", className)}>{children}</dl>;
}

export function MoneyRow({
  label,
  value,
  sub,
  emphasis,
  valueClassName,
  badge,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  emphasis?: boolean;
  valueClassName?: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3.5 first:pt-0 last:pb-0">
      <dt className={cn("text-body", emphasis ? "font-bold" : "text-ink")}>
        {label}
        {sub && <span className="block text-small font-normal text-ink-muted">{sub}</span>}
      </dt>
      <dd
        className={cn(
          "text-right tabular-nums [&_span]:font-sans",
          emphasis ? "font-display text-[26px] leading-8 font-semibold" : "font-display text-[20px] leading-7 font-semibold",
          valueClassName,
        )}
      >
        {value}
        {badge && <span className="mt-1 block">{badge}</span>}
      </dd>
    </div>
  );
}
