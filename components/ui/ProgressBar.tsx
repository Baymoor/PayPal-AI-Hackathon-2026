import { cn } from "./cn";

export function ProgressBar({
  value,
  max,
  label,
  className,
  id,
}: {
  value: number;
  max: number;
  /** Visible text label, e.g. "4 of 5 payers committed". */
  label: string;
  className?: string;
  id?: string;
}) {
  const safeMax = Math.max(max, 1);
  const pct = Math.min(100, Math.max(0, (value / safeMax) * 100));
  const labelId = `${id ?? "pb"}-label`;
  return (
    <div className={className}>
      <p id={labelId} className="mb-2 text-body font-medium">
        {label}
      </p>
      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={Math.min(value, safeMax)}
        aria-valuetext={label}
        className="h-2.5 w-full overflow-hidden rounded-pill bg-track"
      >
        <div className="h-full rounded-pill bg-coral-600 transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
