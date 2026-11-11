/**
 * Every budget-poker string that depends on what a vote means.
 *
 * PER_PERSON is every new outing: "what would you personally pay?". TOTAL is
 * an outing created before per-person voting, which voted on one amount for
 * the whole group and keeps that wording, so an amount is never shown under
 * the wrong label.
 */
import type { CandidateBudgetView } from "@/lib/contracts/views";
import { formatMoney } from "@/lib/domain/money";
import type { BudgetUnit } from "@/lib/domain/types";

export interface BudgetCopy {
  /** Card prompt before budget poker starts. */
  startPrompt: string;
  /** The question on the vote screen. */
  question: string;
  voteLegend: string;
  customLabel: string;
  /** A plausible amount in dollars for the custom field's placeholder and error hint. */
  customExample: string;
  chartTitle: string;
  /** Start of the chart's text alternative; the amounts follow. */
  chartAltLead: string;
  revealFootnote: string;
  proposedLabel: string;
  agreedLabel: string;
  agreeLegend: string;
  agreeButton: (amountMinor: number) => string;
  /** What invitees read once the organizer has agreed a budget. */
  agreedSentence: (amountMinor: number) => string;
}

const PER_PERSON: BudgetCopy = {
  startPrompt: "What would each of you personally pay?",
  question: "What would you personally pay for this outing?",
  voteLegend: "What you would personally pay",
  customLabel: "Your amount (USD)",
  customExample: "20",
  chartTitle: "What people would pay, per person (number of votes)",
  chartAltLead: "What people would pay per person, by amount: ",
  revealFootnote: "Amounts only. No names.",
  proposedLabel: "Proposed budget per person",
  agreedLabel: "Agreed budget per person",
  agreeLegend: "Agreed budget per person",
  agreeButton: (amountMinor) => `Agree on ${formatMoney(amountMinor)} per person`,
  agreedSentence: (amountMinor) => `The group agreed on about ${formatMoney(amountMinor)} per person.`,
};

const TOTAL: BudgetCopy = {
  startPrompt: "What total budget feels comfortable?",
  question: "Suggest a total budget.",
  voteLegend: "Your total budget suggestion",
  customLabel: "Custom total (USD)",
  customExample: "120",
  chartTitle: "Budget suggestions (number of votes)",
  chartAltLead: "Budget suggestions by amount: ",
  revealFootnote: "Totals only. No names.",
  proposedLabel: "Proposed group budget",
  agreedLabel: "Agreed group budget",
  agreeLegend: "Agreed total budget",
  agreeButton: (amountMinor) => `Agree on ${formatMoney(amountMinor)} budget`,
  agreedSentence: (amountMinor) => `The group agreed on a ${formatMoney(amountMinor)} starting budget.`,
};

export function budgetCopy(unit: BudgetUnit): BudgetCopy {
  return unit === "PER_PERSON" ? PER_PERSON : TOTAL;
}

/** "$20 each with 5 paying", plus how it compares when it is above what the group agreed per person. */
export function shareLine(budget: CandidateBudgetView, agreedMinor: number): string {
  const share = `${formatMoney(budget.costMinor)} each with ${budget.payers} paying`;
  return budget.within ? share : `${share}, above the agreed ${formatMoney(agreedMinor)}`;
}

/** Shown under "Each payer authorizes up to ..." when that hold is more than each person said they would pay. */
export function holdAboveBudgetLine(agreedMinor: number): string {
  return `That is above the ${formatMoney(agreedMinor)} per person the group agreed. More minimum payers lower it.`;
}
