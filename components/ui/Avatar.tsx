import { Check } from "lucide-react";
import { cn } from "./cn";

const TINTS = ["#F9E3DC", "#DDEBE0", "#E6E0F3", "#F3E7CE", "#DCE8F4", "#F3DCE8"];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Initials only. `check` shows a small voted/committed badge. Never shows amounts. */
export function Avatar({
  name,
  index = 0,
  check,
  size = 48,
  className,
}: {
  name: string;
  index?: number;
  check?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full font-bold text-ink", className)}
      style={{ width: size, height: size, background: TINTS[index % TINTS.length], fontSize: size * 0.34 }}
      title={name}
    >
      <span aria-hidden>{initials(name)}</span>
      {check && (
        <span className="absolute -bottom-0.5 -right-0.5 inline-flex size-[18px] items-center justify-center rounded-full bg-coral-600 text-white ring-2 ring-cream">
          <Check className="size-3" strokeWidth={3} aria-hidden />
        </span>
      )}
    </span>
  );
}
