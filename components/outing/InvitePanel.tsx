"use client";
import { Check, Copy, Link2, TriangleAlert, UserPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { TextAreaField } from "@/components/ui/Field";
import { StatusBanner } from "@/components/ui/StatusBanner";
import type { InviteLink, OutingActions } from "./api";
import { ActionErrorBanner, useAction } from "./useAction";

function absolute(link: string): string {
  if (/^https?:\/\//.test(link)) return link;
  if (typeof window !== "undefined") return window.location.origin + (link.startsWith("/") ? link : "/" + link);
  return link;
}

function CopyButton({ text, name }: { text: string; name: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <>
      <Button
        variant="secondary"
        className="!min-h-[44px] !px-4 !text-[15px]"
        aria-label={`Copy invitation link for ${name}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("failed");
          }
          setTimeout(() => setState("idle"), 2500);
        }}
      >
        {state === "copied" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        {state === "copied" ? "Copied" : state === "failed" ? "Select & copy" : "Copy"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? `Link for ${name} copied` : ""}
      </span>
    </>
  );
}

/** Organizer: add invitees. Returned one-time links stay only in this component's memory. */
export function InvitePanel({ actions, hint }: { actions: OutingActions; hint?: string }) {
  const [names, setNames] = useState("");
  const [links, setLinks] = useState<InviteLink[]>([]);
  const { pending, error, run } = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const list = names
      .split(/[\n,]/)
      .map((n) => n.trim())
      .filter(Boolean);
    if (list.length === 0) return;
    const res = await run("invite", async () => {
      const invites = await actions.addInvitees(list);
      await actions.refresh();
      return invites;
    });
    if (res) {
      setLinks((prev) => [...prev, ...res]);
      setNames("");
    }
  }

  return (
    <Card as="section" aria-labelledby="invite-h" className="space-y-4">
      <div className="flex items-center gap-2">
        <UserPlus className="size-5 text-coral-700" aria-hidden />
        <h2 id="invite-h" className="text-h3">
          Invite people
        </h2>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <TextAreaField
          label="Names, one per line or separated by commas"
          hint={hint ?? "We create a private link for each person. You send it to them yourself."}
          value={names}
          onChange={(e) => setNames(e.target.value)}
          className="[&_textarea]:min-h-[96px]"
          placeholder={"Ben\nPriya\nSam"}
        />
        <ActionErrorBanner error={error} />
        <Button type="submit" variant="secondary" block loading={pending === "invite"} loadingLabel="Creating links…" disabled={!names.trim()}>
          Create invitation links
        </Button>
      </form>
      {links.length > 0 && (
        <div className="space-y-3">
          <StatusBanner tone="warning" title="Copy these links now">
            Each link is shown only once. Anyone with a link can join as that person, so send it privately.
          </StatusBanner>
          <ul className="space-y-3">
            {links.map((l) => {
              const url = absolute(l.link);
              return (
                <li key={l.participantId} className="rounded-chip border border-line bg-blush-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="flex items-center gap-2 font-semibold">
                      <Link2 className="size-4 text-coral-700" aria-hidden />
                      {l.displayName}
                    </p>
                    <CopyButton text={url} name={l.displayName} />
                  </div>
                  <p className="mt-2 break-all rounded-md bg-white px-3 py-2 text-small text-ink-muted select-all">{url}</p>
                </li>
              );
            })}
          </ul>
          <p className="flex items-start gap-2 text-small text-ink-muted">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Lost a link? It can&apos;t be shown again — ask for a new invitation.
          </p>
        </div>
      )}
    </Card>
  );
}
