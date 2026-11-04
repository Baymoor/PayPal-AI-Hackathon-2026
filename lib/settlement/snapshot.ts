/**
 * Shape of the immutable `settlement_snapshots.roster` JSON and helpers to
 * read it back. The snapshot is the only source of truth for what may be
 * captured from whom once the roster is frozen.
 */
import type { PayerAllocation, SettlementDecision } from "../domain/policy";
import type { AttendanceState, ParticipantRole, PayerType } from "../domain/types";
import type { SettlementSnapshot } from "../db/schema";
import type { MerchantAvailability } from "./availability";

export type SettlementTrigger = "DEADLINE" | "ORGANIZER_CANCELLED" | "REQUIRED_DECLINED";

export interface RosterParticipantRecord {
  id: string;
  sortKey: number;
  role: ParticipantRole;
  payerType: PayerType;
  required: boolean;
  attendance: AttendanceState;
}

export interface PlannedCapture {
  paymentAttemptId: string;
  participantId: string;
  sequence: number;
  amountMinor: number;
  capMinor: number;
  authorizedMinor: number;
}

export interface SettlementRoster {
  version: 1;
  trigger: SettlementTrigger;
  early: boolean;
  decision: SettlementDecision;
  /** Top-level mirror of decision.allocations (empty for CANCEL) so other readers need not know the union. */
  allocations?: PayerAllocation[];
  deadlineAt: string;
  frozenAt: string;
  evaluatedAt: string;
  quote: { id: string; termsHash: string; totalMinor: number; currency: string; capMinor: number; minPayers: number; capacity: number };
  merchantAvailability: MerchantAvailability;
  participants: RosterParticipantRecord[];
  /** Exactly what was planned, in execution order. */
  planned: { captures: PlannedCapture[]; voids: string[]; failedApprovals: string[] };
  /** Attempts whose provider state could not be re-read before the decision (fail closed). */
  reconcileNotes: string[];
}

export function readRoster(snapshot: Pick<SettlementSnapshot, "roster">): SettlementRoster {
  const roster = snapshot.roster as Partial<SettlementRoster> | null;
  if (!roster || roster.version !== 1 || !roster.decision || !roster.planned) {
    throw new Error("settlement snapshot roster is malformed");
  }
  return roster as SettlementRoster;
}

/** The planned capture for an attempt, or null when the attempt must never be captured. */
export function plannedCaptureFor(roster: SettlementRoster, paymentAttemptId: string): PlannedCapture | null {
  if (roster.decision.kind !== "SETTLE") return null;
  return roster.planned.captures.find((c) => c.paymentAttemptId === paymentAttemptId) ?? null;
}
