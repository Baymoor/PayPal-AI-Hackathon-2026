"use client";
import { Eye, Lock, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { OutingView } from "@/lib/contracts/views";
import { formatMoney } from "@/lib/domain/money";
import { Avatar } from "@/components/ui/Avatar";
import { AiSourceBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { VoteGrid } from "@/components/ui/VoteTile";
import type { OutingActions } from "./api";
import { InvitePanel } from "./InvitePanel";
import { RevealPanel } from "./RevealPanel";
import { ScreenHeader } from "./Shell";
import { ActionErrorBanner, useAction } from "./useAction";

export function BudgetStage({ view, actions }: { view: OutingView; actions: OutingActions }) {
  const { budget, roster } = view;
  const money = (n: number) => formatMoney(n);
  const { pending, error, run } = useAction();
  const [choice, setChoice] = useState<number | null>(budget.myVoteMinor);
  const org = view.organizer?.can;

  if (budget.revealed) {
    return (
      <div className="space-y-6">
        <ScreenHeader view={view} title="Here’s where the group landed" lead="Budget agreement does not authorize payment." />
        <RevealPanel view={view} actions={actions} />
      </div>
    );
  }

  const changed = choice !== null && choice !== budget.myVoteMinor;
  const label =
    choice === null
      ? "Submit my vote"
      : budget.myVoteMinor === null
        ? `Submit my ${money(choice)} vote`
        : changed
          ? `Change my vote to ${money(choice)}`
          : `Your ${money(choice)} vote is saved`;
  const voters = roster.people;

  return (
    <div className="space-y-6">
      <ScreenHeader
        view={view}
        title="Budget poker"
        lead={
          <>
            <p className="font-medium">Suggest a total budget.</p>
            <p>This does not authorize a payment.</p>
          </>
        }
      />

      {view.me.can.vote ? (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (choice === null) return;
            run("vote", async () => {
              await actions.vote(choice);
              await actions.refresh();
            });
          }}
        >
          <VoteGrid legend="Your total budget suggestion" options={budget.options} value={choice} onChange={setChoice} />
          <p className="flex items-center justify-center gap-2 text-center text-body">
            <Lock className="size-5" aria-hidden />
            Your vote stays private until reveal
          </p>
          <ActionErrorBanner error={error} />
          <Button
            type="submit"
            block
            loading={pending === "vote"}
            loadingLabel="Saving…"
            disabled={choice === null || (!changed && budget.myVoteMinor !== null)}
            disabledReason={choice === null ? "Pick an amount to submit your vote." : budget.myVoteMinor !== null ? "Your vote is saved. Pick another amount to change it." : undefined}
          >
            {label}
          </Button>
          {budget.myVoteMinor !== null && (
            <p aria-live="polite" className="text-center text-small text-ink-muted">
              You voted {money(budget.myVoteMinor)}. Only you can see this until reveal.
            </p>
          )}
        </form>
      ) : (
        <StatusBanner tone="info">You can&apos;t vote right now.</StatusBanner>
      )}

      <section aria-labelledby="voters" className="space-y-3">
        <h2 id="voters" className="sr-only">
          Who has voted
        </h2>
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
          <ul className="flex flex-wrap items-center justify-center gap-2">
            {voters.map((p, i) => (
              <li key={p.participantId}>
                <Avatar name={p.displayName} index={i} check={p.hasVoted} size={44} />
                <span className="sr-only">
                  {p.displayName} {p.hasVoted ? "has voted" : "has not voted yet"}
                </span>
              </li>
            ))}
          </ul>
          <span aria-hidden className="hidden h-10 w-px bg-line-strong sm:block" />
          <p className="font-semibold" aria-live="polite">
            {budget.votedCount} of {budget.invitedCount} voted
          </p>
        </div>
      </section>

      {org?.addInvitees && <InvitePanel actions={actions} />}

      {view.viewer.isOrganizer && org && (
        <Card tone="blush" className="space-y-3">
          <h2 className="text-h3">Reveal the group&apos;s budget</h2>
          <p className="text-ink-muted">
            Reveal shows only how many people chose each amount — never who chose what. It needs at least 3 votes.
          </p>
          <Button
            block
            variant="secondary"
            loading={pending === "reveal"}
            loadingLabel="Revealing…"
            disabled={!(org.reveal && budget.canReveal)}
            disabledReason={`Reveal unlocks at 3 votes (${budget.votedCount} so far).`}
            onClick={() => run("reveal", async () => { await actions.reveal(); await actions.refresh(); })}
          >
            <Eye className="size-5" aria-hidden />
            Reveal
          </Button>
          {budget.round > 1 && (
            <p className="flex items-center gap-1.5 text-small text-ink-muted">
              <RefreshCw className="size-4" aria-hidden /> Round {budget.round}
            </p>
          )}
        </Card>
      )}
      <p className="text-center text-small text-ink-muted">A budget vote is not a payment or booking.</p>
      {budget.aiSummary && <AiSourceBadge source={budget.aiSummary.source} />}
    </div>
  );
}
