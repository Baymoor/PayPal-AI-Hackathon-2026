import { Beaker, ShieldCheck } from "lucide-react";
import { FIXTURE_PAYMENT_LABEL } from "@/components/ui/Badge";
import type { Tone } from "./labels";

export function Badge({ tone = "neutral", children }: { tone?: Tone | "sandbox"; children: React.ReactNode }) {
  return <span className="m-badge" data-tone={tone}>{children}</span>;
}

/** Row mode: text + icon, never colour alone. */
export function ModeBadge({ fixture }: { fixture: boolean }) {
  return fixture ? (
    <Badge tone="fixture"><Beaker size={12} aria-hidden /> {FIXTURE_PAYMENT_LABEL}</Badge>
  ) : (
    <Badge tone="sandbox"><ShieldCheck size={12} aria-hidden /> Sandbox</Badge>
  );
}
