"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextAreaField, TextField } from "@/components/ui/Field";
import { Stepper } from "@/components/ui/Stepper";
import { describeError } from "@/components/errors/friendlyError";
import { outingApi } from "./api";
import { BriefStarters } from "./BriefStarters";
import { ActionErrorBanner, type ActionError } from "./useAction";

export const SAMPLE_BRIEF =
  "A karaoke night for Maya's birthday. Six of us, Friday evening. We want a private room and to cover Maya's share.";

/**
 * One focused column. What the plan was understood as is shown on the next screen, once there is something
 * to show; an empty "filled in from your plan" card before typing only added noise.
 */
export function NewOutingForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [touched, setTouched] = useState(false);

  const nameErr = touched && !name.trim() ? "Add your name so friends know who invited them." : undefined;
  const briefErr = touched && brief.trim().length < 10 ? "Tell us a little more: what, who and roughly when." : undefined;

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
      setError(describeError(err, "create"));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[640px] space-y-8">
      <Stepper current={0} />
      <form onSubmit={submit} className="space-y-5" noValidate>
        <h1 className="text-[36px] leading-10 sm:text-h1 sm:leading-[3rem]">
          What are we planning?
        </h1>
        <p className="text-lead text-ink">
          Describe it in your own words, group-chat style. We pull out the activity, the date, who&apos;s coming and anyone you want to treat.
        </p>
        <TextField
          label="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="given-name"
          maxLength={60}
          placeholder="Alex"
          error={nameErr}
        />
        <BriefStarters currentBrief={brief} onPick={(starter) => setBrief(starter.brief)} />
        <TextAreaField
          label="Your plan"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          maxLength={2000}
          placeholder={SAMPLE_BRIEF}
          error={briefErr}
          hint="Who, what, roughly when. Mention anyone you want to treat."
        />
        <ActionErrorBanner error={error} />
        <Button type="submit" block arrow loading={busy} loadingLabel="Finding an outing…">
          Find an outing
        </Button>
        <p className="text-small text-ink-muted">Suggestions are not bookings or payment approvals.</p>
      </form>
    </div>
  );
}
