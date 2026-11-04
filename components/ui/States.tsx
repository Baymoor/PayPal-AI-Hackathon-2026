import { TriangleAlert } from "lucide-react";
import { cn } from "./cn";
import { Card, IconTile } from "./Card";
import { Button } from "./Button";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton", className)} />;
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-4">
      <span className="sr-only">Loading your outing…</span>
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-12 w-3/4" />
      <Skeleton className="h-5 w-2/3" />
      <div className="grid grid-cols-3 gap-3 pt-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-tile" />
        ))}
      </div>
      <Skeleton className="h-14 rounded-pill" />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  headingLevel = 2,
}: {
  headingLevel?: 1 | 2;
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-3 py-10 text-center">
      <IconTile className="size-14">{icon}</IconTile>
      {headingLevel === 1 ? <h1 className="text-h2">{title}</h1> : <h2 className="text-h3">{title}</h2>}
      {children && <p className="max-w-sm text-ink-muted">{children}</p>}
      {action}
    </Card>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  safe,
  onRetry,
  retryLabel = "Try again",
  children,
}: {
  title?: string;
  message: string;
  /** What is safe, e.g. "You have not been charged." */
  safe?: string;
  onRetry?: () => void;
  retryLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div role="alert" className="rounded-card border border-danger/20 bg-danger-bg p-5 text-[#6E1A12]">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-6 shrink-0" aria-hidden />
        <div className="flex-1">
          <h2 className="font-display text-h3">{title}</h2>
          <p className="mt-1">{message}</p>
          {safe && <p className="mt-1 font-semibold">{safe}</p>}
          {children}
          {onRetry && (
            <div className="mt-4">
              <Button variant="secondary" onClick={onRetry}>
                {retryLabel}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
