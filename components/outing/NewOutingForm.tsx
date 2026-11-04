"use client";
import { Activity, CalendarDays, Gift, Users, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, IconTile } from "@/components/ui/Card";
import { TextAreaField, TextField } from "@/components/ui/Field";
import { Stepper } from "@/components/ui/Stepper";
import { Underlined } from "@/components/ui/Swoosh";
import { ApiError, outingApi } from "./api";
import { ActionErrorBanner } from "./useAction";

export const SAMPLE_BRIEF =
  "A karaoke night for Maya's birthday. Six of us, Friday evening. We want a private room and to cover Maya's share.";

const PREVIEW = [
  { Icon: Activity, label: "Activity" },
  { Icon: CalendarDays, label: "Date window" },
  { Icon: Users, label: "Attendees" },
  { Icon: Gift, label: "Guest of honour" },
  { Icon: Wallet, label: "Budget", value: "Not set yet" },
];

export function NewOutingForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [touched, setTouched] = useState(false);

  const nameErr = touched && !name.trim() ? "Add your name so friends know who invited them." : undefined;
  const briefErr = touched && brief.trim().length < 10 ? "Tell us a little more — what, who and roughly when." : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!name.trim() || brief.trim().length < 10) return;
    setBusy(true);
    setError(null);
    try {
      const { outingId } = await outingApi.create(name.trim(), brief.trim());
      router.push(`/o/${outingId}`);
    } catch (err) {
      const e2 = err instanceof ApiError ? err : null;
      setError({
        code: e2?.code ?? "UNKNOWN",
        message:
          e2?.status === 429
            ? "Too many requests just now. Wait a minute and try again."
            : (e2?.message ?? "Something went wrong. Nothing was charged by this request."),
      });
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <Stepper current={0} />
      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
        <form onSubmit={submit} className="space-y-5" noValidate>
          <h1 className="text-[36px] leading-10 sm:text-h1 sm:leading-[3rem]">
            What are we <Underlined>planning?</Underlined>
          </h1>
          <p className="text-lead text-ink-muted">Describe the plan in your own words. Group-chat style is fine.</p>
          <TextField
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="given-name"
            maxLength={60}
            placeholder="Alex"
            error={nameErr}
          />
          <TextAreaField
            label="Your plan"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            maxLength={2000}
            placeholder={SAMPLE_BRIEF}
            error={briefErr}
            hint="Who, what, roughly when. Mention anyone you want to treat."
          />
          <div>
            <Button variant="link" onClick={() => setBrief(SAMPLE_BRIEF)}>
              Use the sample brief
            </Button>
          </div>
          <ActionErrorBanner error={error} />
          <Button type="submit" block arrow loading={busy} loadingLabel="Finding an outing…">
            Find an outing
          </Button>
          <p className="text-small text-ink-muted">Suggestions are not bookings or payment approvals.</p>
        </form>

        <Card as="aside" aria-labelledby="preview-h" className="h-fit space-y-4 lg:mt-14">
          <h2 id="preview-h" className="text-h3">
            Here&apos;s what I understood
          </h2>
          <ul className="divide-y divide-line">
            {PREVIEW.map(({ Icon, label, value }) => (
              <li key={label} className="flex items-center gap-3 py-3 first:pt-0">
                <IconTile>
                  <Icon className="size-5" />
                </IconTile>
                <span className="font-semibold">{label}</span>
                <span className="ml-auto text-ink-muted">{value ?? "Filled in from your plan"}</span>
              </li>
            ))}
          </ul>
          <p className="rounded-[18px] border border-amber-line bg-amber-bg p-4 text-amber-ink">
            Next you&apos;ll suggest a total budget privately. Nobody is asked to pay anything yet.
          </p>
        </Card>
      </div>
    </div>
  );
}
