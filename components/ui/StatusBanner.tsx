import { CircleCheck, Info, TriangleAlert, Clock } from "lucide-react";
import { cn } from "./cn";

type Tone = "info" | "warning" | "danger" | "success" | "pending";

const tones: Record<Tone, { cls: string; Icon: typeof Info }> = {
  info: { cls: "bg-cancelled-bg text-[#2D3748]", Icon: Info },
  warning: { cls: "bg-amber-bg text-amber-ink border border-amber-line", Icon: TriangleAlert },
  pending: { cls: "bg-void-pending-bg text-void-pending", Icon: Clock },
  danger: { cls: "bg-danger-bg text-[#6E1A12]", Icon: TriangleAlert },
  success: { cls: "bg-captured-bg text-captured", Icon: CircleCheck },
};

export function StatusBanner({
  tone = "info",
  title,
  children,
  action,
  className,
  live = true,
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  live?: boolean;
}) {
  const { cls, Icon } = tones[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      aria-live={live ? (tone === "danger" ? "assertive" : "polite") : undefined}
      className={cn("flex items-start gap-3 rounded-[18px] p-4", cls, className)}
    >
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-[15px] leading-6">
        {title && <p className="font-bold">{title}</p>}
        {children && <div className={title ? "mt-0.5" : undefined}>{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}
